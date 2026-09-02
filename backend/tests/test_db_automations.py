"""Tests for `services/db/automations.py` + `services/db/notifications.py` +
`routers/databases.py`'s automation/notification endpoints (Milestone 12, task-38):
automation CRUD, `every_frequency` exclusivity, the shared action-chain executor and its
6 database-automation actions, synchronous `page_added`/`property_edited` firing,
`_tick_automations`, and failure handling.

Runs against the local pgtest harness (localhost:55432) through the transaction-wrapped
`db_conn`/`test_user` fixtures (`tests/conftest.py`), rolled back on teardown -- same
convention as `test_db_templates.py`. NEVER touches `core.config.settings.database_url`
(the real Supabase project). No `datetime.now()` in the scheduler-tick tests -- every
`next_run_at` reference instant is a fixed, hand-written `datetime(...)`.
"""
from __future__ import annotations

import asyncio
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from main import app
from routers.notes import get_user_id
from services.db.automations import (
    ActionConfigError,
    ActionContext,
    ActionNotAllowedError,
    AutomationConfigError,
    DATABASE_AUTOMATION_ACTIONS,
    UnknownActionError,
    UnknownDataSourceError,
    _tick_automations,
    execute_action_chain,
    run_automations_for_trigger,
)
from services.db.connection import get_conn
from services.db.formula import values as fvalues

# Same scope-predicate sweep `test_databases_router.py`/`test_db_templates.py` run over
# their own files -- duplicated here (this codebase's own "helpers duplicated per test
# file" convention) since this task added a batch of genuinely new SQL into
# services/db/automations.py that neither of those sweeps touches.
_SQL_KEYWORDS = ("SELECT", "INSERT", "UPDATE", "DELETE")
_SCOPE_PREDICATE_RE = re.compile(r"user_id\s*=\s*\$\d+")
_AUTOMATIONS_PATH = Path(__file__).parent.parent / "services" / "db" / "automations.py"


# ===========================================================================
# Helpers
# ===========================================================================


@pytest_asyncio.fixture
async def client(db_conn, test_user):
    async def _override_conn():
        yield db_conn

    app.dependency_overrides[get_conn] = _override_conn
    app.dependency_overrides[get_user_id] = lambda: test_user
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as c:
            yield c
    finally:
        app.dependency_overrides.clear()


async def _create_database(client: httpx.AsyncClient, title: str = "My DB") -> dict:
    res = await client.post("/db/databases", json={"title": title})
    assert res.status_code == 201, res.text
    return res.json()


async def _make_data_source(db_conn, user_id, *, name="DS"):
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'T') RETURNING id", user_id
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, $3) RETURNING id",
        db_row["id"], user_id, name,
    )
    return str(ds_row["id"])


async def _insert_property(
    db_conn, user_id, data_source_id, key, name, type_, *, config=None,
):
    await db_conn.execute(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type, config)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        data_source_id, user_id, key, name, type_, config or {},
    )


async def _make_row(db_conn, user_id, data_source_id, *, title="Row", properties=None):
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id", user_id, title
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, $4)",
        note["id"], data_source_id, user_id, properties or {},
    )
    return str(note["id"])


async def _insert_automation(db_conn, user_id, data_source_id, **overrides) -> str:
    fields = {
        "name": "A",
        "is_active": True,
        "last_error": None,
        "trigger_combinator": "any",
        "triggers": [],
        "view_id": None,
        "actions": [],
        "next_run_at": None,
        "position": 0,
    }
    fields.update(overrides)
    row = await db_conn.fetchrow(
        """
        INSERT INTO db_automations
            (data_source_id, user_id, name, is_active, last_error, trigger_combinator,
             triggers, view_id, actions, next_run_at, position)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
        """,
        data_source_id, user_id, fields["name"], fields["is_active"], fields["last_error"],
        fields["trigger_combinator"], fields["triggers"], fields["view_id"], fields["actions"],
        fields["next_run_at"], fields["position"],
    )
    return str(row["id"])


async def _other_user(db_conn) -> str:
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    return other_user


def _extract_sql_statements(path: Path) -> list[str]:
    src = path.read_text()
    blocks = re.findall(r'"""(.*?)"""', src, re.S)
    statements = []
    for b in blocks:
        stripped = b.strip()
        first_word = stripped.split(None, 1)[0].upper() if stripped else ""
        if first_word in _SQL_KEYWORDS:
            statements.append(b)
    return statements


def _assert_has_scope_predicate(stmt: str) -> None:
    first_word = stmt.strip().split(None, 1)[0].upper()
    if first_word == "INSERT":
        assert re.search(r"\buser_id\b", stmt), f"INSERT never mentions user_id:\n{stmt}"
        return
    assert _SCOPE_PREDICATE_RE.search(stmt), f"query missing a real user_id = $N predicate:\n{stmt}"


# The scheduler tick's own due-work SELECT (`_tick_automations`) is a system-wide
# background job with no per-request user_id to scope by -- the identical documented
# exception `test_db_templates.py` carves out for `_tick_templates`.
_UNSCOPED_EXCEPTION = "next_run_at IS NOT NULL AND is_active AND next_run_at <= now()"


def test_every_query_in_automations_service_has_a_user_id_scope_predicate():
    statements = _extract_sql_statements(_AUTOMATIONS_PATH)
    assert len(statements) >= 10, "expected to find automations.py's SQL statements"
    checked = 0
    for stmt in statements:
        if _UNSCOPED_EXCEPTION in stmt:
            continue
        _assert_has_scope_predicate(stmt)
        checked += 1
    assert checked >= 9


NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


def _ctx(db_conn, user_id, ds_id, row_id, **overrides) -> ActionContext:
    fields = dict(
        conn=db_conn, user_id=user_id, trigger_data_source_id=ds_id, trigger_row_id=row_id,
        now=NOW, variables={}, source="automation:test",
    )
    fields.update(overrides)
    return ActionContext(**fields)


# ===========================================================================
# CRUD + tenancy (automations)
# ===========================================================================


async def test_create_list_patch_delete_automation_round_trips(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    res = await client.post(
        f"/db/data-sources/{ds_id}/automations",
        json={"name": "Notify me", "triggers": [{"type": "page_added"}], "actions": []},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["name"] == "Notify me"
    assert body["is_active"] is True
    assert body["data_source_id"] == ds_id
    automation_id = body["id"]

    list_res = await client.get(f"/db/data-sources/{ds_id}/automations")
    assert list_res.status_code == 200
    assert [a["id"] for a in list_res.json()] == [automation_id]

    patch_res = await client.patch(f"/db/automations/{automation_id}", json={"name": "Renamed"})
    assert patch_res.status_code == 200
    assert patch_res.json()["name"] == "Renamed"
    assert patch_res.json()["triggers"] == [{"type": "page_added"}]

    del_res = await client.delete(f"/db/automations/{automation_id}")
    assert del_res.status_code == 204
    assert (await client.patch(f"/db/automations/{automation_id}", json={"name": "x"})).status_code == 404


async def test_create_automation_404s_for_another_users_data_source(client, db_conn):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    res = await client.post(f"/db/data-sources/{ds_id}/automations", json={"name": "T"})
    assert res.status_code == 404


async def test_list_automations_excludes_another_users_automations(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    other_user = await _other_user(db_conn)
    await _insert_automation(db_conn, other_user, ds_id, name="Not mine")

    res = await client.get(f"/db/data-sources/{ds_id}/automations")
    assert res.status_code == 200
    assert res.json() == []


async def test_patch_delete_404_for_another_users_automation(client, db_conn):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    automation_id = await _insert_automation(db_conn, other_user, ds_id)

    assert (await client.patch(f"/db/automations/{automation_id}", json={"name": "x"})).status_code == 404
    assert (await client.delete(f"/db/automations/{automation_id}")).status_code == 404


# ===========================================================================
# CRUD + tenancy (notifications)
# ===========================================================================


async def test_list_and_mark_read_notification_round_trip(client, db_conn, test_user):
    from services.db.notifications import create_notification

    n1 = await create_notification(db_conn, test_user, message="First", source="automation:x")
    n2 = await create_notification(db_conn, test_user, message="Second", source="automation:y")
    # Both inserts share the SAME transaction-start `now()` (Postgres semantics), so
    # `created_at` alone can't order them -- force a real, distinct ordering so this
    # test actually exercises "most recent first" rather than an accidental tie.
    await db_conn.execute(
        "UPDATE db_notifications SET created_at = created_at - interval '1 minute' WHERE id = $1",
        n1.id,
    )

    res = await client.get("/db/notifications")
    assert res.status_code == 200
    ids = [n["id"] for n in res.json()]
    assert ids == [n2.id, n1.id]  # most recent first

    unread_res = await client.get("/db/notifications", params={"unread": "true"})
    assert len(unread_res.json()) == 2

    mark_res = await client.patch(f"/db/notifications/{n1.id}")
    assert mark_res.status_code == 200
    assert mark_res.json()["read_at"] is not None

    unread_after = await client.get("/db/notifications", params={"unread": "true"})
    assert [n["id"] for n in unread_after.json()] == [n2.id]


async def test_mark_read_404s_for_unknown_or_foreign_notification(client, db_conn):
    other_user = await _other_user(db_conn)
    from services.db.notifications import create_notification

    foreign = await create_notification(db_conn, other_user, message="Not yours")
    assert (await client.patch(f"/db/notifications/{foreign.id}")).status_code == 404
    assert (await client.patch(f"/db/notifications/{uuid.uuid4()}")).status_code == 404


async def test_notifications_are_scoped_to_the_caller(client, db_conn):
    other_user = await _other_user(db_conn)
    from services.db.notifications import create_notification

    await create_notification(db_conn, other_user, message="Not yours")
    res = await client.get("/db/notifications")
    assert res.json() == []


# ===========================================================================
# every_frequency exclusivity (decision 3a)
# ===========================================================================


async def test_every_frequency_paired_with_another_trigger_is_a_clean_400(client, db_conn):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(
        f"/db/data-sources/{ds_id}/automations",
        json={
            "name": "Bad",
            "triggers": [
                {"type": "every_frequency", "frequency": "daily", "start_date": "2026-01-01"},
                {"type": "page_added"},
            ],
        },
    )
    assert res.status_code == 400
    assert "every_frequency" in res.text


async def test_lone_every_frequency_trigger_is_fine_and_seeds_next_run_at(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(
        f"/db/data-sources/{ds_id}/automations",
        json={
            "name": "Daily digest",
            "triggers": [
                {
                    "type": "every_frequency", "frequency": "daily", "interval": 1,
                    "start_date": "2026-01-01", "time_of_day": "09:00",
                }
            ],
        },
    )
    assert res.status_code == 201, res.text
    assert res.json()["next_run_at"] is not None


async def test_patch_to_every_frequency_paired_with_another_trigger_is_400(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(
        f"/db/data-sources/{ds_id}/automations", json={"name": "A", "triggers": [{"type": "page_added"}]}
    )
    automation_id = res.json()["id"]
    patch_res = await client.patch(
        f"/db/automations/{automation_id}",
        json={
            "triggers": [
                {"type": "page_added"},
                {"type": "every_frequency", "frequency": "daily", "start_date": "2026-01-01"},
            ]
        },
    )
    assert patch_res.status_code == 400


# ===========================================================================
# execute_action_chain: each action individually
# ===========================================================================


async def test_edit_property_action_writes_the_row(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    row_id = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    result = await execute_action_chain(
        db_conn, ctx,
        [{"type": "edit_property", "property_key": "statusKey", "value": {"type": "status", "status": "done"}}],
        allowed=DATABASE_AUTOMATION_ACTIONS,
    )
    assert result.actions_run == 1

    row = await db_conn.fetchrow("SELECT properties FROM db_row_props WHERE note_id = $1", row_id)
    assert row["properties"]["statusKey"] == {"type": "status", "status": "done"}


async def test_add_page_to_action_creates_a_row_in_the_target_data_source(db_conn, test_user):
    trigger_ds = await _make_data_source(db_conn, test_user, name="Trigger DS")
    target_ds = await _make_data_source(db_conn, test_user, name="Target DS")
    await _insert_property(db_conn, test_user, target_ds, "titleKey", "Name", "title")
    row_id = await _make_row(db_conn, test_user, trigger_ds)

    before = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", target_ds)
    ctx = _ctx(db_conn, test_user, trigger_ds, row_id)
    await execute_action_chain(
        db_conn, ctx,
        [{
            "type": "add_page_to", "data_source_id": target_ds,
            "properties": {"titleKey": {"type": "title", "title": "New page"}},
        }],
        allowed=DATABASE_AUTOMATION_ACTIONS,
    )
    after = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", target_ds)
    assert after == before + 1


async def test_add_page_to_does_not_trigger_the_target_data_sources_own_automations(db_conn, test_user):
    """research §J.6.7: "Database automations can't be triggered by other automations
    ... A database automation creating a page in another database will not trigger a
    database automation." `create_row_core`/`update_row_property_core`'s
    `trigger_automations=False` kwarg (rows.py, passed by every action handler in this
    file) is the guard for exactly this -- without it, two automations that create rows
    in each other's data sources would recurse without bound. This is a genuine
    correctness/safety property with no direct test elsewhere in this file; verify it
    end to end here rather than trusting the kwarg is wired correctly by inspection
    alone."""
    trigger_ds = await _make_data_source(db_conn, test_user, name="Trigger DS")
    target_ds = await _make_data_source(db_conn, test_user, name="Target DS")
    await _insert_property(db_conn, test_user, target_ds, "titleKey", "Name", "title")
    row_id = await _make_row(db_conn, test_user, trigger_ds)

    # A page_added automation on the TARGET data source that would leave an obvious,
    # independently-checkable side effect (a notification) if it ever fired.
    await _insert_automation(
        db_conn, test_user, target_ds,
        name="Should never fire from a nested add_page_to",
        triggers=[{"type": "page_added"}],
        actions=[{"type": "send_notification", "message": "should not exist"}],
    )

    notifications_before = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1", test_user
    )
    ctx = _ctx(db_conn, test_user, trigger_ds, row_id)
    await execute_action_chain(
        db_conn, ctx,
        [{
            "type": "add_page_to", "data_source_id": target_ds,
            "properties": {"titleKey": {"type": "title", "title": "New page"}},
        }],
        allowed=DATABASE_AUTOMATION_ACTIONS,
    )

    # The row itself must still be created -- this test isn't asserting add_page_to
    # silently no-ops, only that it doesn't cascade into the target's own automations.
    row_count = await db_conn.fetchval(
        "SELECT count(*) FROM db_row_props WHERE data_source_id = $1", target_ds
    )
    assert row_count == 1

    notifications_after = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1", test_user
    )
    assert notifications_after == notifications_before


def _preamble_fake_supabase(*, ds_id, row_properties, prop_defs, notes_title="Untitled"):
    """Same helper `test_databases_router.py`'s Fix-4/preamble tests define --
    duplicated per this file's own established per-test-file convention (see
    e.g. this module's own `_ctx` vs. other test files' near-identical
    fixtures)."""
    from unittest.mock import MagicMock

    tables: dict = {}
    db = MagicMock()
    db.table.side_effect = lambda name: tables.setdefault(name, MagicMock())

    notes = tables.setdefault("notes", MagicMock())
    notes.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = {
        "title": notes_title, "content": [],
    }

    row_props = tables.setdefault("db_row_props", MagicMock())
    row_props.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = {
        "properties": row_properties, "data_source_id": ds_id,
    }

    properties = tables.setdefault("db_properties", MagicMock())
    properties.select.return_value.eq.return_value.eq.return_value.order.return_value.execute.return_value.data = (
        prop_defs
    )

    tables.setdefault("note_chunks", MagicMock())
    db.tables = tables
    return db


async def test_add_page_to_triggers_property_preamble_reindex_on_the_new_row(
    db_conn, test_user
):
    """Fix 6 (task-51, M14 final cross-cutting review): `add_page_to`/
    `edit_pages_in` can write into a DIFFERENT data source than the one whose
    automation triggered them -- the triggering row getting indexed elsewhere
    (its own write path) says nothing about the row THESE actions create in
    the target data source, one of 3 real row-write call sites task-50's own
    sweep missed. Exercises the actual cross-data-source subtlety the brief
    calls out specifically: the reindexed row lives in `target_ds`, not
    `trigger_ds`."""
    from unittest.mock import patch

    trigger_ds = await _make_data_source(db_conn, test_user, name="Trigger DS")
    target_ds = await _make_data_source(db_conn, test_user, name="Target DS")
    await _insert_property(db_conn, test_user, target_ds, "titleKey", "Name", "title")
    row_id = await _make_row(db_conn, test_user, trigger_ds)

    fake_db = _preamble_fake_supabase(
        ds_id=target_ds,
        row_properties={"titleKey": {"type": "title", "title": "New page"}},
        prop_defs=[{"key": "titleKey", "name": "Name", "type": "title", "position": 0, "config": {}}],
    )

    ctx = _ctx(db_conn, test_user, trigger_ds, row_id)
    with (
        patch("services.indexer.get_supabase", return_value=fake_db),
        patch("services.indexer.embed_batch", side_effect=lambda texts: [[0.0]] * len(texts)),
        patch("services.indexer.embed", return_value=[0.0]),
        patch("services.indexer.generate_descriptor", return_value="d"),
    ):
        await execute_action_chain(
            db_conn, ctx,
            [{
                "type": "add_page_to", "data_source_id": target_ds,
                "properties": {"titleKey": {"type": "title", "title": "New page"}},
            }],
            allowed=DATABASE_AUTOMATION_ACTIONS,
        )

    new_row = await db_conn.fetchrow(
        "SELECT note_id FROM db_row_props WHERE data_source_id = $1", target_ds
    )
    assert new_row is not None

    insert_call = fake_db.tables["note_chunks"].insert.call_args
    assert insert_call is not None, "note_chunks.insert was never called -- index_note was never invoked"
    rows = insert_call[0][0]
    assert len(rows) == 1
    assert rows[0]["chunk_index"] == 0
    assert rows[0]["chunk_text"] == "Name: New page"
    assert rows[0]["block_id"] == "__property_preamble__"
    assert rows[0]["note_id"] == str(new_row["note_id"])


async def test_edit_pages_in_trigger_row_target_writes_the_trigger_row(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    row_id = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    await execute_action_chain(
        db_conn, ctx,
        [{
            "type": "edit_pages_in", "target": "trigger_row", "data_source_id": ds_id,
            "property_key": "statusKey", "value": {"type": "status", "status": "archived"},
        }],
        allowed=DATABASE_AUTOMATION_ACTIONS,
    )
    row = await db_conn.fetchrow("SELECT properties FROM db_row_props WHERE note_id = $1", row_id)
    assert row["properties"]["statusKey"] == {"type": "status", "status": "archived"}


async def test_edit_pages_in_variable_ref_target_writes_every_row_in_the_variable(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    trigger_row = await _make_row(db_conn, test_user, ds_id)
    row_a = await _make_row(db_conn, test_user, ds_id)
    row_b = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, trigger_row)
    ctx.variables["subitems"] = [fvalues.Page(id=row_a), fvalues.Page(id=row_b)]
    await execute_action_chain(
        db_conn, ctx,
        [{
            "type": "edit_pages_in", "target": {"variable_ref": "subitems"}, "data_source_id": ds_id,
            "property_key": "statusKey", "value": {"type": "status", "status": "complete"},
        }],
        allowed=DATABASE_AUTOMATION_ACTIONS,
    )
    for rid in (row_a, row_b):
        row = await db_conn.fetchrow("SELECT properties FROM db_row_props WHERE note_id = $1", rid)
        assert row["properties"]["statusKey"] == {"type": "status", "status": "complete"}


async def test_edit_pages_in_indexing_does_not_block_the_event_loop(db_conn, test_user):
    """Controller-caught, post-task-51 (M14 final cross-cutting review, Fix 1/Fix 6
    interaction): `_action_edit_pages_in` (`services/db/automations.py`) has a
    `for row_id in row_ids:` loop -- a `variable_ref` target can resolve to many
    rows, exactly like this file's own
    `test_edit_pages_in_variable_ref_target_writes_every_row_in_the_variable` above
    exercises. Task 51's Fix 6 added a `try_index_note` call inside that loop, but
    `try_index_note` -> `index_note` is synchronous and blocking (same function
    Fix 1, in the SAME commit, moved off the event loop for `db_import.py`'s per-row
    loop) -- calling it directly here reintroduces the identical regression, one
    function away in the same fix round: an `edit_pages_in` action touching many
    rows blocks every concurrent HTTP request for its duration (this file's
    automation action chains run on the app's own event loop, same as every other
    async route). Fixed directly by the controller (`asyncio.to_thread`, mirroring
    Fix 1 exactly) after independently verifying task-51's diff; proven with the
    same heartbeat-tick-count technique Fix 1's own test established (see
    `test_db_csv_import.py`'s comment on why a single concurrent request's own
    latency is an unreliable proof)."""
    from unittest.mock import patch

    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    trigger_row = await _make_row(db_conn, test_user, ds_id)
    row_count = 10
    rows = [await _make_row(db_conn, test_user, ds_id) for _ in range(row_count)]

    ctx = _ctx(db_conn, test_user, ds_id, trigger_row)
    ctx.variables["subitems"] = [fvalues.Page(id=r) for r in rows]

    def _slow_fake_index(note_id, user_id) -> bool:
        time.sleep(0.05)
        return True

    TICK_INTERVAL = 0.01
    stop = False
    tick_count = 0

    async def heartbeat():
        nonlocal tick_count
        while not stop:
            await asyncio.sleep(TICK_INTERVAL)
            tick_count += 1

    async def do_action():
        nonlocal stop
        t0 = time.monotonic()
        with patch("services.db.automations.try_index_note", side_effect=_slow_fake_index):
            await execute_action_chain(
                db_conn, ctx,
                [{
                    "type": "edit_pages_in", "target": {"variable_ref": "subitems"}, "data_source_id": ds_id,
                    "property_key": "statusKey", "value": {"type": "status", "status": "complete"},
                }],
                allowed=DATABASE_AUTOMATION_ACTIONS,
            )
        elapsed = time.monotonic() - t0
        stop = True
        return elapsed

    heartbeat_task = asyncio.create_task(heartbeat())
    action_elapsed = await do_action()
    heartbeat_task.cancel()
    try:
        await heartbeat_task
    except asyncio.CancelledError:
        pass

    expected_ticks_if_unblocked = action_elapsed / TICK_INTERVAL
    assert tick_count > expected_ticks_if_unblocked * 0.6, (
        f"heartbeat only ticked {tick_count} times over {action_elapsed:.3f}s "
        f"(expected ~{expected_ticks_if_unblocked:.0f} if the loop stayed free) "
        f"-- the event loop was blocked while edit_pages_in ran"
    )


async def test_send_notification_action_creates_a_notification_row(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, row_id, source="automation:abc")
    await execute_action_chain(
        db_conn, ctx,
        [{"type": "send_notification", "message": "Hello there"}],
        allowed=DATABASE_AUTOMATION_ACTIONS,
    )
    row = await db_conn.fetchrow(
        "SELECT message, source FROM db_notifications WHERE user_id = $1", test_user
    )
    assert row["message"] == "Hello there"
    assert row["source"] == "automation:abc"


async def test_send_webhook_action_posts_the_payload_to_the_url(db_conn, test_user, monkeypatch):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)

    calls = []

    class _FakeResponse:
        def raise_for_status(self):
            pass

    async def _fake_post(self, url, json=None, **kwargs):
        calls.append((url, json))
        return _FakeResponse()

    monkeypatch.setattr(httpx.AsyncClient, "post", _fake_post)

    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    await execute_action_chain(
        db_conn, ctx,
        [{"type": "send_webhook", "url": "https://example.com/hook", "payload": {"a": 1}}],
        allowed=DATABASE_AUTOMATION_ACTIONS,
    )
    assert calls == [("https://example.com/hook", {"a": 1})]


async def test_send_webhook_rejects_a_formula_resolved_url(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    with pytest.raises(ActionConfigError):
        await execute_action_chain(
            db_conn, ctx,
            [{"type": "send_webhook", "url": {"formula": '"https://x"'}}],
            allowed=DATABASE_AUTOMATION_ACTIONS,
        )


async def test_define_variables_feeds_a_later_edit_property_formula(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "noteKey", "Note", "rich_text")
    row_id = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    await execute_action_chain(
        db_conn, ctx,
        [
            {"type": "define_variables", "name": "greeting", "formula": "hello"},
            {
                "type": "edit_property", "property_key": "noteKey",
                "value": {"formula": "greeting"},
            },
        ],
        allowed=DATABASE_AUTOMATION_ACTIONS,
    )
    row = await db_conn.fetchrow("SELECT properties FROM db_row_props WHERE note_id = $1", row_id)
    assert row["properties"]["noteKey"] == {"type": "rich_text", "rich_text": "hello"}


async def test_action_outside_the_allowed_set_400s_cleanly(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    with pytest.raises(ActionNotAllowedError):
        await execute_action_chain(
            db_conn, ctx,
            [{"type": "show_confirmation", "message": "sure?"}],
            allowed=DATABASE_AUTOMATION_ACTIONS,
        )


async def test_unknown_action_type_raises_cleanly(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    with pytest.raises(UnknownActionError):
        await execute_action_chain(
            db_conn, ctx,
            [{"type": "totally_made_up"}],
            allowed=DATABASE_AUTOMATION_ACTIONS | frozenset({"totally_made_up"}),
        )


# ===========================================================================
# page_added trigger fires synchronously through the real create_row endpoint
# ===========================================================================


async def test_page_added_trigger_fires_through_create_row_endpoint(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    automation_id = await _insert_automation(
        db_conn, test_user, ds_id,
        triggers=[{"type": "page_added"}],
        actions=[{"type": "send_notification", "message": "A row was added"}],
    )

    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text

    row = await db_conn.fetchrow(
        "SELECT message, source FROM db_notifications WHERE user_id = $1", test_user
    )
    assert row is not None
    assert row["message"] == "A row was added"
    assert row["source"] == f"automation:{automation_id}"


# ===========================================================================
# property_edited trigger: the 4 conditions
# ===========================================================================


async def _setup_property_edited_automation(client, db_conn, test_user, condition, **trigger_kwargs):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop_res = await client.post(
        f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
    )
    prop_key = prop_res.json()["key"]
    row_res = await client.post(f"/db/data-sources/{ds_id}/rows")
    row_id = row_res.json()["id"]

    trigger = {"type": "property_edited", "property_key": prop_key, "condition": condition}
    trigger.update(trigger_kwargs)
    await _insert_automation(
        db_conn, test_user, ds_id,
        triggers=[trigger],
        actions=[{"type": "send_notification", "message": f"fired:{condition}"}],
    )
    return ds_id, prop_key, row_id


async def _notification_count(db_conn, test_user, message):
    return await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1 AND message = $2",
        test_user, message,
    )


async def test_property_edited_any_change_fires_on_any_write(client, db_conn, test_user):
    ds_id, prop_key, row_id = await _setup_property_edited_automation(client, db_conn, test_user, "any_change")
    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": prop_key, "value": {"type": "status", "status": "done"}},
    )
    assert res.status_code == 200
    assert await _notification_count(db_conn, test_user, "fired:any_change") == 1


async def test_property_edited_set_to_fires_only_on_matching_value(client, db_conn, test_user):
    ds_id, prop_key, row_id = await _setup_property_edited_automation(
        client, db_conn, test_user, "set_to", value={"type": "status", "status": "done"}
    )
    # A write to a DIFFERENT value must NOT fire.
    res1 = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": prop_key, "value": {"type": "status", "status": "in_progress"}},
    )
    assert res1.status_code == 200
    assert await _notification_count(db_conn, test_user, "fired:set_to") == 0

    # A write to the matching value MUST fire.
    res2 = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": prop_key, "value": {"type": "status", "status": "done"}},
    )
    assert res2.status_code == 200
    assert await _notification_count(db_conn, test_user, "fired:set_to") == 1


async def test_property_edited_became_empty_fires_only_on_clear(client, db_conn, test_user):
    ds_id, prop_key, row_id = await _setup_property_edited_automation(client, db_conn, test_user, "became_empty")
    # Setting a value (from empty) must NOT fire "became_empty".
    res1 = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": prop_key, "value": {"type": "status", "status": "done"}},
    )
    assert res1.status_code == 200
    assert await _notification_count(db_conn, test_user, "fired:became_empty") == 0

    # Clearing it must fire.
    res2 = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}", json={"property_key": prop_key, "value": None}
    )
    assert res2.status_code == 200
    assert await _notification_count(db_conn, test_user, "fired:became_empty") == 1


async def test_property_edited_became_non_empty_fires_only_from_empty(client, db_conn, test_user):
    ds_id, prop_key, row_id = await _setup_property_edited_automation(
        client, db_conn, test_user, "became_non_empty"
    )
    # First write (from truly empty, no db_row_props value yet) must fire.
    res1 = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": prop_key, "value": {"type": "status", "status": "done"}},
    )
    assert res1.status_code == 200
    assert await _notification_count(db_conn, test_user, "fired:became_non_empty") == 1

    # A second write (already non-empty -> non-empty) must NOT fire again.
    res2 = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": prop_key, "value": {"type": "status", "status": "in_progress"}},
    )
    assert res2.status_code == 200
    assert await _notification_count(db_conn, test_user, "fired:became_non_empty") == 1


# ===========================================================================
# Scheduler tick: every_frequency
# ===========================================================================


async def test_tick_fires_a_due_every_frequency_automation_and_advances_next_run_at(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    trigger = {
        "type": "every_frequency", "frequency": "daily", "interval": 1,
        "start_date": "2020-01-01", "time_of_day": "00:00",
    }
    automation_id = await _insert_automation(
        db_conn, test_user, ds_id,
        triggers=[trigger],
        actions=[{"type": "send_notification", "message": "daily digest"}],
        next_run_at=past,
    )

    fired = await _tick_automations(db_conn)
    assert fired == 1
    assert await _notification_count(db_conn, test_user, "daily digest") == 1

    new_next_run_at = await db_conn.fetchval(
        "SELECT next_run_at FROM db_automations WHERE id = $1", automation_id
    )
    assert new_next_run_at is not None
    assert new_next_run_at > past


async def test_tick_clears_next_run_at_when_the_next_occurrence_is_past_end_date(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    trigger = {
        "type": "every_frequency", "frequency": "daily", "interval": 1,
        "start_date": "2020-01-01", "time_of_day": "00:00", "end_date": "2020-01-01",
    }
    automation_id = await _insert_automation(
        db_conn, test_user, ds_id, triggers=[trigger], actions=[], next_run_at=past,
    )

    fired = await _tick_automations(db_conn)
    assert fired == 1

    row = await db_conn.fetchrow(
        "SELECT next_run_at, is_active FROM db_automations WHERE id = $1", automation_id
    )
    assert row["next_run_at"] is None
    assert row["is_active"] is True  # decision 3: the automation record itself is untouched


async def test_tick_does_not_touch_an_automation_whose_next_run_at_is_in_the_future(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    future = datetime(2999, 1, 1, tzinfo=timezone.utc)
    trigger = {
        "type": "every_frequency", "frequency": "daily", "interval": 1,
        "start_date": "2020-01-01", "time_of_day": "00:00",
    }
    automation_id = await _insert_automation(
        db_conn, test_user, ds_id, triggers=[trigger], actions=[], next_run_at=future,
    )
    fired = await _tick_automations(db_conn)
    assert fired == 0
    unchanged = await db_conn.fetchval("SELECT next_run_at FROM db_automations WHERE id = $1", automation_id)
    assert unchanged == future


async def test_tick_never_fires_an_inactive_automation(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    trigger = {
        "type": "every_frequency", "frequency": "daily", "interval": 1,
        "start_date": "2020-01-01", "time_of_day": "00:00",
    }
    await _insert_automation(
        db_conn, test_user, ds_id, triggers=[trigger], actions=[], next_run_at=past, is_active=False,
    )
    fired = await _tick_automations(db_conn)
    assert fired == 0


# ===========================================================================
# Failure handling (decision 10)
# ===========================================================================


async def test_action_chain_failure_records_last_error_and_leaves_is_active_untouched(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    automation_id = await _insert_automation(
        db_conn, test_user, ds_id,
        triggers=[{"type": "page_added"}],
        actions=[{"type": "add_page_to", "data_source_id": str(uuid.uuid4()), "properties": {}}],
    )

    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text  # the triggering write itself must still succeed

    row = await db_conn.fetchrow(
        "SELECT last_error, is_active FROM db_automations WHERE id = $1", automation_id
    )
    assert row["last_error"] is not None
    assert "no such data source" in row["last_error"]
    assert row["is_active"] is True


async def test_add_page_to_unknown_data_source_raises_typed_error_directly(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    with pytest.raises(UnknownDataSourceError):
        await execute_action_chain(
            db_conn, ctx,
            [{"type": "add_page_to", "data_source_id": str(uuid.uuid4()), "properties": {}}],
            allowed=DATABASE_AUTOMATION_ACTIONS,
        )


async def test_a_failing_automation_does_not_stop_another_due_automation(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    failing_id = await _insert_automation(
        db_conn, test_user, ds_id,
        triggers=[{"type": "page_added"}],
        actions=[{"type": "add_page_to", "data_source_id": str(uuid.uuid4()), "properties": {}}],
    )
    await _insert_automation(
        db_conn, test_user, ds_id,
        triggers=[{"type": "page_added"}],
        actions=[{"type": "send_notification", "message": "still fired"}],
    )

    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text

    assert await _notification_count(db_conn, test_user, "still fired") == 1
    failing_row = await db_conn.fetchrow(
        "SELECT last_error FROM db_automations WHERE id = $1", failing_id
    )
    assert failing_row["last_error"] is not None


async def test_a_successful_run_clears_a_stale_last_error(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    automation_id = await _insert_automation(
        db_conn, test_user, ds_id,
        triggers=[{"type": "page_added"}],
        actions=[{"type": "send_notification", "message": "ok now"}],
        last_error="a stale error from a previous run",
    )

    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text

    row = await db_conn.fetchrow("SELECT last_error FROM db_automations WHERE id = $1", automation_id)
    assert row["last_error"] is None
