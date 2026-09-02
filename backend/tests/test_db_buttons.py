"""Tests for `services/db/buttons.py` + `routers/databases.py`'s two button click
endpoints (Milestone 12, task-39): the widened `BUTTON_ACTIONS`/`BUTTON_BLOCK_ACTIONS`
surfaces on top of task-38's shared action-chain executor, the two-phase
`show_confirmation` flow, `open_page_or_url`/`insert_blocks`'s client-action results, and
decision 4's `trigger_data_source_id: str | None` widening (a button block on a note
that is not a database row).

Runs against the local pgtest harness (localhost:55432) through the transaction-wrapped
`db_conn`/`test_user` fixtures (`tests/conftest.py`), rolled back on teardown -- same
convention as `test_db_automations.py`. NEVER touches `core.config.settings.database_url`
(the real Supabase project).

The `Button` property descriptor itself (operators()/aggregations() empty, is_empty
always True, coerce_write raises) is tested in `test_db_property_registry.py`, folded
into that file's shared per-type sweep -- this codebase's own existing convention for
descriptor tests (mirroring how `relation.py`'s own descriptor has no dedicated test
file either), not a new file here.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from main import app
from routers.notes import get_user_id
from services.db import buttons as buttons_service
from services.db.automations import (
    ActionConfigError,
    ActionContext,
    ActionNotAllowedError,
    execute_action_chain,
)
from services.db.connection import get_conn

# Same scope-predicate sweep test_db_automations.py runs over automations.py --
# duplicated here (this codebase's own "helpers duplicated per test file" convention)
# for the one piece of new SQL buttons.py adds (decision 4's data-source lookup).
_SQL_KEYWORDS = ("SELECT", "INSERT", "UPDATE", "DELETE")
_SCOPE_PREDICATE_RE = re.compile(r"user_id\s*=\s*\$\d+")
_BUTTONS_PATH = Path(__file__).parent.parent / "services" / "db" / "buttons.py"


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


def test_every_query_in_buttons_service_has_a_user_id_scope_predicate():
    statements = _extract_sql_statements(_BUTTONS_PATH)
    assert len(statements) >= 1, "expected to find buttons.py's SQL statement(s)"
    for stmt in statements:
        _assert_has_scope_predicate(stmt)


# ===========================================================================
# Helpers (duplicated from test_db_automations.py's own -- see that file's docstring)
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


async def _make_plain_note(db_conn, user_id, *, title="Plain note"):
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id", user_id, title
    )
    return str(note["id"])


async def _other_user(db_conn) -> str:
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    return other_user


NOW = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


def _ctx(db_conn, user_id, ds_id, row_id, **overrides) -> ActionContext:
    fields = dict(
        conn=db_conn, user_id=user_id, trigger_data_source_id=ds_id, trigger_row_id=row_id,
        now=NOW, source="button:test",
    )
    fields.update(overrides)
    return ActionContext(**fields)


# ===========================================================================
# Button property surface: each of the 8 BUTTON_ACTIONS individually
# ===========================================================================


async def test_button_edit_property_action_writes_the_row(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    row_id = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    result = await buttons_service.run_button_actions(
        db_conn, ctx,
        [{"type": "edit_property", "property_key": "statusKey", "value": {"type": "status", "status": "done"}}],
        allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.actions_run == 1
    row = await db_conn.fetchrow("SELECT properties FROM db_row_props WHERE note_id = $1", row_id)
    assert row["properties"]["statusKey"] == {"type": "status", "status": "done"}


async def test_button_add_page_to_action_creates_a_row(db_conn, test_user):
    trigger_ds = await _make_data_source(db_conn, test_user, name="Trigger DS")
    target_ds = await _make_data_source(db_conn, test_user, name="Target DS")
    await _insert_property(db_conn, test_user, target_ds, "titleKey", "Name", "title")
    row_id = await _make_row(db_conn, test_user, trigger_ds)

    before = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", target_ds)
    ctx = _ctx(db_conn, test_user, trigger_ds, row_id)
    result = await buttons_service.run_button_actions(
        db_conn, ctx,
        [{
            "type": "add_page_to", "data_source_id": target_ds,
            "properties": {"titleKey": {"type": "title", "title": "New page"}},
        }],
        allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.actions_run == 1
    after = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", target_ds)
    assert after == before + 1


async def test_button_add_page_to_triggers_the_target_data_sources_own_automation(db_conn, test_user):
    """Live-check fix (post-Task-42): research §J.6.7 — "Buttons can trigger database
    automations — unlike automations themselves ... A user clicking a button that
    creates a page WILL trigger a database automation." Live-reproduced against the
    running app before this fix: a button's `add_page_to` action created the row but
    the target data source's own `page_added` automation never fired (`ActionContext.
    allow_triggering_automations` didn't exist yet, so the 3 row-writing action
    handlers unconditionally passed `trigger_automations=False`, the correct value for
    an AUTOMATION's own chain but wrong for a BUTTON's). This is the direct opposite
    assertion of `test_db_automations.py`'s
    `test_add_page_to_does_not_trigger_the_target_data_sources_own_automations` (an
    automation must never trigger another; a button must)."""
    trigger_ds = await _make_data_source(db_conn, test_user, name="Trigger DS")
    target_ds = await _make_data_source(db_conn, test_user, name="Target DS")
    await _insert_property(db_conn, test_user, target_ds, "titleKey", "Name", "title")
    row_id = await _make_row(db_conn, test_user, trigger_ds)

    await db_conn.execute(
        """
        INSERT INTO db_automations
            (data_source_id, user_id, name, is_active, trigger_combinator, triggers, actions)
        VALUES ($1, $2, 'fires on button add_page_to', TRUE, 'any', $3, $4)
        """,
        target_ds,
        test_user,
        [{"type": "page_added"}],
        [{"type": "send_notification", "message": "fired by button"}],
    )

    notifications_before = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1", test_user
    )
    ctx = _ctx(db_conn, test_user, trigger_ds, row_id)
    await buttons_service.run_button_actions(
        db_conn, ctx,
        [{
            "type": "add_page_to", "data_source_id": target_ds,
            "properties": {"titleKey": {"type": "title", "title": "New page"}},
        }],
        allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )

    notifications_after = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1", test_user
    )
    assert notifications_after == notifications_before + 1


async def test_button_edit_pages_in_trigger_row_writes_the_trigger_row(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    row_id = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    result = await buttons_service.run_button_actions(
        db_conn, ctx,
        [{
            "type": "edit_pages_in", "target": "trigger_row", "data_source_id": ds_id,
            "property_key": "statusKey", "value": {"type": "status", "status": "archived"},
        }],
        allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.actions_run == 1
    row = await db_conn.fetchrow("SELECT properties FROM db_row_props WHERE note_id = $1", row_id)
    assert row["properties"]["statusKey"] == {"type": "status", "status": "archived"}


async def test_button_send_notification_action_creates_a_notification(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, row_id, source="button:approve")
    result = await buttons_service.run_button_actions(
        db_conn, ctx, [{"type": "send_notification", "message": "clicked"}],
        allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.actions_run == 1
    row = await db_conn.fetchrow("SELECT message, source FROM db_notifications WHERE user_id = $1", test_user)
    assert row["message"] == "clicked"
    assert row["source"] == "button:approve"


async def test_button_send_webhook_action_posts_the_payload(db_conn, test_user, monkeypatch):
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
    result = await buttons_service.run_button_actions(
        db_conn, ctx,
        [{"type": "send_webhook", "url": "https://example.com/hook", "payload": {"a": 1}}],
        allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.actions_run == 1
    assert calls == [("https://example.com/hook", {"a": 1})]


async def test_button_define_variables_feeds_a_later_action(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "noteKey", "Note", "rich_text")
    row_id = await _make_row(db_conn, test_user, ds_id)

    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    result = await buttons_service.run_button_actions(
        db_conn, ctx,
        [
            {"type": "define_variables", "name": "greeting", "formula": "hello"},
            {"type": "edit_property", "property_key": "noteKey", "value": {"formula": "greeting"}},
        ],
        allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.actions_run == 2
    row = await db_conn.fetchrow("SELECT properties FROM db_row_props WHERE note_id = $1", row_id)
    assert row["properties"]["noteKey"] == {"type": "rich_text", "rich_text": "hello"}


async def test_button_show_confirmation_action_is_covered_below():
    # show_confirmation's own two-phase behavior gets a dedicated section below
    # (it can't be tested with a single execute_action_chain call the way the other
    # 7 actions are, since its whole point is a two-request flow) -- this is a marker,
    # not a placeholder, so the "8 actions individually" count is visibly accounted for
    # in this file's structure.
    assert "show_confirmation" in buttons_service.BUTTON_ACTIONS


async def test_button_open_page_or_url_action_is_covered_below():
    assert "open_page_or_url" in buttons_service.BUTTON_ACTIONS


async def test_insert_blocks_action_not_allowed_on_a_button_property(db_conn, test_user):
    # research §J.6.2/§25: a button PROPERTY has no "page" of its own to insert
    # blocks into -- BUTTON_ACTIONS (8) deliberately excludes insert_blocks, unlike
    # BUTTON_BLOCK_ACTIONS (9). Mirrors test_db_automations.py's own
    # "button-only action on a database automation" 400, in reverse.
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    with pytest.raises(ActionNotAllowedError):
        await buttons_service.run_button_actions(
            db_conn, ctx,
            [{"type": "insert_blocks", "blocks": [], "placement": "below_button"}],
            allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
        )


# ===========================================================================
# show_confirmation: the two-phase flow (decision 6)
# ===========================================================================


async def test_show_confirmation_stops_the_chain_until_confirmed_then_runs_it(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    actions = [
        {"type": "show_confirmation", "message": "Sure?"},
        {"type": "send_notification", "message": "ran after confirmation"},
    ]

    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    result = await buttons_service.run_button_actions(
        db_conn, ctx, actions, allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.requires_confirmation is True
    assert result.confirmation_message == "Sure?"
    assert result.actions_run == 0
    assert result.client_actions == []
    count = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1 AND message = $2",
        test_user, "ran after confirmation",
    )
    assert count == 0  # the real side effect of the LATER action did NOT happen

    ctx2 = _ctx(db_conn, test_user, ds_id, row_id)
    result2 = await buttons_service.run_button_actions(
        db_conn, ctx2, actions, allowed=buttons_service.BUTTON_ACTIONS, confirmed=True,
    )
    assert result2.requires_confirmation is False
    assert result2.actions_run == 2
    count2 = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1 AND message = $2",
        test_user, "ran after confirmation",
    )
    assert count2 == 1


async def test_show_confirmation_mid_chain_lets_earlier_actions_run_first(db_conn, test_user):
    # decision 6: "before the REMAINING actions run", not "before ALL actions run" --
    # an action authored BEFORE show_confirmation in the array already ran by the time
    # it's reached and raises.
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    actions = [
        {"type": "send_notification", "message": "ran before confirmation"},
        {"type": "show_confirmation", "message": "Sure?"},
        {"type": "send_notification", "message": "should not run yet"},
    ]
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    result = await buttons_service.run_button_actions(
        db_conn, ctx, actions, allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.requires_confirmation is True
    before_count = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1 AND message = $2",
        test_user, "ran before confirmation",
    )
    assert before_count == 1
    after_count = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1 AND message = $2",
        test_user, "should not run yet",
    )
    assert after_count == 0


# ===========================================================================
# open_page_or_url / insert_blocks: client_actions, literal-only (decision 7)
# ===========================================================================


async def test_open_page_or_url_produces_a_client_action_and_touches_nothing(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    result = await buttons_service.run_button_actions(
        db_conn, ctx,
        [{"type": "open_page_or_url", "target": {"kind": "url", "url": "https://example.com"}}],
        allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
    )
    assert result.actions_run == 1
    assert result.client_actions == [{"type": "open", "kind": "url", "url": "https://example.com"}]


async def test_open_page_or_url_rejects_a_formula_shaped_target(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    with pytest.raises(ActionConfigError):
        await buttons_service.run_button_actions(
            db_conn, ctx,
            [{"type": "open_page_or_url", "target": {"formula": '"https://x"'}}],
            allowed=buttons_service.BUTTON_ACTIONS, confirmed=False,
        )


async def test_insert_blocks_produces_a_client_action_on_a_button_block(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    blocks = [{"type": "paragraph", "content": "hi"}]
    result = await buttons_service.run_button_actions(
        db_conn, ctx,
        [{"type": "insert_blocks", "blocks": blocks, "placement": "below_button"}],
        allowed=buttons_service.BUTTON_BLOCK_ACTIONS, confirmed=False,
    )
    assert result.actions_run == 1
    assert result.client_actions == [
        {"type": "insert_blocks", "blocks": blocks, "placement": "below_button"}
    ]


async def test_insert_blocks_rejects_a_formula_shaped_blocks_value(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    with pytest.raises(ActionConfigError):
        await buttons_service.run_button_actions(
            db_conn, ctx,
            [{"type": "insert_blocks", "blocks": {"formula": "someField"}, "placement": "below_button"}],
            allowed=buttons_service.BUTTON_BLOCK_ACTIONS, confirmed=False,
        )


async def test_insert_blocks_rejects_an_invalid_placement(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)
    ctx = _ctx(db_conn, test_user, ds_id, row_id)
    with pytest.raises(ActionConfigError):
        await buttons_service.run_button_actions(
            db_conn, ctx,
            [{"type": "insert_blocks", "blocks": [], "placement": "somewhere_weird"}],
            allowed=buttons_service.BUTTON_BLOCK_ACTIONS, confirmed=False,
        )


# ===========================================================================
# decision 4: trigger_data_source_id is str | None -- a button block on a note that
# is NOT a database row
# ===========================================================================


async def test_formula_resolution_raises_cleanly_when_trigger_data_source_id_is_none(db_conn, test_user):
    note_id = await _make_plain_note(db_conn, test_user)
    ctx = _ctx(db_conn, test_user, None, note_id)
    with pytest.raises(ActionConfigError):
        await execute_action_chain(
            db_conn, ctx,
            [{"type": "define_variables", "name": "x", "formula": {"formula": "someProp"}}],
            allowed=buttons_service.BUTTON_BLOCK_ACTIONS,
        )


async def test_edit_property_raises_cleanly_when_trigger_data_source_id_is_none(db_conn, test_user):
    note_id = await _make_plain_note(db_conn, test_user)
    ctx = _ctx(db_conn, test_user, None, note_id)
    with pytest.raises(ActionConfigError):
        await execute_action_chain(
            db_conn, ctx,
            [{"type": "edit_property", "property_key": "whatever", "value": {"type": "status", "status": "done"}}],
            allowed=buttons_service.BUTTON_BLOCK_ACTIONS,
        )


async def test_send_notification_still_works_when_trigger_data_source_id_is_none(db_conn, test_user):
    note_id = await _make_plain_note(db_conn, test_user)
    ctx = _ctx(db_conn, test_user, None, note_id, source=f"button:block:{note_id}")
    result = await execute_action_chain(
        db_conn, ctx, [{"type": "send_notification", "message": "from a plain note"}],
        allowed=buttons_service.BUTTON_BLOCK_ACTIONS,
    )
    assert result.actions_run == 1
    row = await db_conn.fetchrow("SELECT message, source FROM db_notifications WHERE user_id = $1", test_user)
    assert row["message"] == "from a plain note"


# ===========================================================================
# The two HTTP endpoints
# ===========================================================================


async def test_click_button_property_runs_its_configured_action_chain(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop_res = await client.post(
        f"/db/data-sources/{ds_id}/properties",
        json={
            "name": "Approve", "type": "button",
            "config": {"actions": [{"type": "send_notification", "message": "clicked"}]},
        },
    )
    assert prop_res.status_code == 201, prop_res.text
    prop_key = prop_res.json()["key"]
    row_res = await client.post(f"/db/data-sources/{ds_id}/rows")
    row_id = row_res.json()["id"]

    res = await client.post(f"/db/data-sources/{ds_id}/rows/{row_id}/buttons/{prop_key}/click", json={})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["actions_run"] == 1
    assert body["requires_confirmation"] is False
    row = await db_conn.fetchrow("SELECT message, source FROM db_notifications WHERE user_id = $1", test_user)
    assert row["message"] == "clicked"
    assert row["source"] == f"button:{prop_key}"


async def test_click_button_property_404s_for_unknown_property(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    row_res = await client.post(f"/db/data-sources/{ds_id}/rows")
    row_id = row_res.json()["id"]
    res = await client.post(f"/db/data-sources/{ds_id}/rows/{row_id}/buttons/doesNotExist/click", json={})
    assert res.status_code == 404


async def test_click_button_property_400s_when_property_is_not_a_button(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop_res = await client.post(
        f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
    )
    prop_key = prop_res.json()["key"]
    row_res = await client.post(f"/db/data-sources/{ds_id}/rows")
    row_id = row_res.json()["id"]
    res = await client.post(f"/db/data-sources/{ds_id}/rows/{row_id}/buttons/{prop_key}/click", json={})
    assert res.status_code == 400


async def test_click_button_property_404s_for_unknown_row(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop_res = await client.post(
        f"/db/data-sources/{ds_id}/properties",
        json={"name": "Approve", "type": "button", "config": {"actions": []}},
    )
    prop_key = prop_res.json()["key"]
    res = await client.post(
        f"/db/data-sources/{ds_id}/rows/{uuid.uuid4()}/buttons/{prop_key}/click", json={}
    )
    assert res.status_code == 404


async def test_click_button_property_insert_blocks_400s(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop_res = await client.post(
        f"/db/data-sources/{ds_id}/properties",
        json={
            "name": "Approve", "type": "button",
            "config": {"actions": [{"type": "insert_blocks", "blocks": [], "placement": "below_button"}]},
        },
    )
    prop_key = prop_res.json()["key"]
    row_res = await client.post(f"/db/data-sources/{ds_id}/rows")
    row_id = row_res.json()["id"]
    res = await client.post(f"/db/data-sources/{ds_id}/rows/{row_id}/buttons/{prop_key}/click", json={})
    assert res.status_code == 400


async def test_click_button_property_two_phase_confirmation_over_http(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop_res = await client.post(
        f"/db/data-sources/{ds_id}/properties",
        json={
            "name": "Delete", "type": "button",
            "config": {
                "actions": [
                    {"type": "show_confirmation", "message": "Really?"},
                    {"type": "send_notification", "message": "deleted"},
                ],
            },
        },
    )
    prop_key = prop_res.json()["key"]
    row_res = await client.post(f"/db/data-sources/{ds_id}/rows")
    row_id = row_res.json()["id"]

    first = await client.post(f"/db/data-sources/{ds_id}/rows/{row_id}/buttons/{prop_key}/click", json={})
    assert first.status_code == 200, first.text
    assert first.json()["requires_confirmation"] is True
    assert first.json()["confirmation_message"] == "Really?"

    second = await client.post(
        f"/db/data-sources/{ds_id}/rows/{row_id}/buttons/{prop_key}/click", json={"confirmed": True}
    )
    assert second.status_code == 200, second.text
    assert second.json()["requires_confirmation"] is False
    assert second.json()["actions_run"] == 2


async def test_click_button_block_on_a_database_row_resolves_data_source(client, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    row_id = await _make_row(db_conn, test_user, ds_id)

    res = await client.post(
        "/db/buttons/block-click",
        json={
            "note_id": row_id,
            "actions": [{
                "type": "edit_property", "property_key": "statusKey",
                "value": {"type": "status", "status": "done"},
            }],
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["actions_run"] == 1
    row = await db_conn.fetchrow("SELECT properties FROM db_row_props WHERE note_id = $1", row_id)
    assert row["properties"]["statusKey"] == {"type": "status", "status": "done"}


async def test_click_button_block_on_a_plain_note_has_no_data_source(client, db_conn, test_user):
    note_id = await _make_plain_note(db_conn, test_user)

    needs_ds = await client.post(
        "/db/buttons/block-click",
        json={
            "note_id": note_id,
            "actions": [{
                "type": "edit_property", "property_key": "whatever",
                "value": {"type": "status", "status": "done"},
            }],
        },
    )
    assert needs_ds.status_code == 400, needs_ds.text  # a clean 400, never a 500

    fine_without_ds = await client.post(
        "/db/buttons/block-click",
        json={"note_id": note_id, "actions": [{"type": "send_notification", "message": "hi"}]},
    )
    assert fine_without_ds.status_code == 200, fine_without_ds.text
    assert fine_without_ds.json()["actions_run"] == 1
    row = await db_conn.fetchrow("SELECT message, source FROM db_notifications WHERE user_id = $1", test_user)
    assert row["message"] == "hi"
    assert row["source"] == f"button:block:{note_id}"


async def test_click_button_block_404s_for_unknown_or_foreign_note(client, db_conn):
    other_user = await _other_user(db_conn)
    foreign_note = await _make_plain_note(db_conn, other_user)
    res = await client.post("/db/buttons/block-click", json={"note_id": foreign_note, "actions": []})
    assert res.status_code == 404

    res2 = await client.post("/db/buttons/block-click", json={"note_id": str(uuid.uuid4()), "actions": []})
    assert res2.status_code == 404


async def test_click_button_block_insert_blocks_allowed_unlike_property(client, db_conn, test_user):
    note_id = await _make_plain_note(db_conn, test_user)
    res = await client.post(
        "/db/buttons/block-click",
        json={
            "note_id": note_id,
            "actions": [{"type": "insert_blocks", "blocks": [{"type": "paragraph"}], "placement": "below_button"}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["actions_run"] == 1
    assert body["client_actions"] == [
        {"type": "insert_blocks", "blocks": [{"type": "paragraph"}], "placement": "below_button"}
    ]
