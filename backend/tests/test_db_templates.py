"""Tests for `services/db/templates.py` + `routers/databases.py`'s template
endpoints (Milestone 12, task-37): row template CRUD, `is_default`
uniqueness, `instantiate_template`, `create_row`'s new default-template
auto-apply, `next_occurrence`'s pure date arithmetic, and the scheduler's
`_tick_templates`.

Runs against the local pgtest harness (localhost:55432) through the
transaction-wrapped `db_conn`/`test_user` fixtures (`tests/conftest.py`),
rolled back on teardown — same convention as every other Milestone 2+ test
file in this suite. NEVER touches `core.config.settings.database_url` (the
real Supabase project). No `datetime.now()` anywhere in the `next_occurrence`
table or the scheduler-tick tests — every reference instant is a fixed,
hand-written `datetime(...)`, per task-37-brief.md's explicit instruction.
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
from services.db.connection import get_conn
from services.db.scheduler import _tick_templates
from services.db.templates import (
    DuplicateDefaultTemplateError,
    create_template,
    get_template,
    instantiate_template,
    next_occurrence,
)
from models.database import RowTemplateCreate

# Same scope-predicate sweep `test_databases_router.py` runs over
# routers/databases.py and services/db/views.py -- duplicated here (this
# codebase's own "helpers duplicated per test file" convention, see
# test_db_recompute.py's header comment) since this task moved a batch of
# genuinely new SQL into services/db/templates.py that sweep doesn't touch.
_SQL_KEYWORDS = ("SELECT", "INSERT", "UPDATE", "DELETE")
_SCOPE_PREDICATE_RE = re.compile(r"user_id\s*=\s*\$\d+")
_TEMPLATES_PATH = Path(__file__).parent.parent / "services" / "db" / "templates.py"


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
    db_conn, user_id, data_source_id, key, name, type_,
    *, config=None, result_type=None, is_volatile=False,
):
    await db_conn.execute(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type, config, result_type, is_volatile)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        data_source_id, user_id, key, name, type_, config or {}, result_type, is_volatile,
    )


def _formula_config(expression: str) -> dict:
    return {"expression": expression}


async def _insert_template(db_conn, user_id, data_source_id, **overrides) -> str:
    fields = {
        "name": "T",
        "icon": None,
        "properties": {},
        "content": [],
        "is_default": False,
        "repeat_config": None,
        "next_run_at": None,
        "position": 0,
    }
    fields.update(overrides)
    row = await db_conn.fetchrow(
        """
        INSERT INTO db_row_templates
            (data_source_id, user_id, name, icon, properties, content, is_default,
             repeat_config, next_run_at, position)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id
        """,
        data_source_id, user_id, fields["name"], fields["icon"], fields["properties"],
        fields["content"], fields["is_default"], fields["repeat_config"],
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


def test_every_query_in_templates_service_has_a_user_id_scope_predicate():
    """Not `services/db/scheduler.py`: its one query (`_tick_templates`'s
    due-work SELECT) is a deliberate, documented exception -- a
    system-wide background job with no per-request `user_id` to scope by,
    covered instead by this file's own scheduler-tick tests asserting it
    only ever touches the one due template it's handed."""
    statements = _extract_sql_statements(_TEMPLATES_PATH)
    assert len(statements) >= 8, "expected to find templates.py's SQL statements"
    for stmt in statements:
        _assert_has_scope_predicate(stmt)


# ===========================================================================
# CRUD + tenancy
# ===========================================================================


async def test_create_list_patch_delete_template_round_trips(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    res = await client.post(
        f"/db/data-sources/{ds_id}/templates",
        json={"name": "Bug report", "properties": {}, "content": [{"type": "paragraph"}]},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["name"] == "Bug report"
    assert body["content"] == [{"type": "paragraph"}]
    assert body["is_default"] is False
    assert body["data_source_id"] == ds_id
    template_id = body["id"]

    list_res = await client.get(f"/db/data-sources/{ds_id}/templates")
    assert list_res.status_code == 200
    assert [t["id"] for t in list_res.json()] == [template_id]

    fetched = await get_template(db_conn, test_user, template_id)
    assert fetched is not None
    assert fetched.name == "Bug report"

    patch_res = await client.patch(f"/db/templates/{template_id}", json={"name": "Renamed"})
    assert patch_res.status_code == 200
    assert patch_res.json()["name"] == "Renamed"
    # Partial: content untouched by a name-only patch.
    assert patch_res.json()["content"] == [{"type": "paragraph"}]

    del_res = await client.delete(f"/db/templates/{template_id}")
    assert del_res.status_code == 204
    assert await get_template(db_conn, test_user, template_id) is None


async def test_create_template_404s_for_another_users_data_source(client, db_conn):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    res = await client.post(f"/db/data-sources/{ds_id}/templates", json={"name": "T"})
    assert res.status_code == 404


async def test_list_templates_excludes_another_users_templates(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    other_user = await _other_user(db_conn)
    await _insert_template(db_conn, other_user, ds_id, name="Not mine")

    res = await client.get(f"/db/data-sources/{ds_id}/templates")
    assert res.status_code == 200
    assert res.json() == []


async def test_patch_delete_404_for_another_users_template(client, db_conn):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    template_id = await _insert_template(db_conn, other_user, ds_id)

    patch_res = await client.patch(f"/db/templates/{template_id}", json={"name": "x"})
    assert patch_res.status_code == 404
    del_res = await client.delete(f"/db/templates/{template_id}")
    assert del_res.status_code == 404


async def test_patch_delete_404_for_unknown_template(client):
    unknown = str(uuid.uuid4())
    assert (await client.patch(f"/db/templates/{unknown}", json={"name": "x"})).status_code == 404
    assert (await client.delete(f"/db/templates/{unknown}")).status_code == 404


# ===========================================================================
# is_default uniqueness
# ===========================================================================


async def test_second_default_template_on_same_data_source_is_a_clean_400(client, db_conn):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    first = await client.post(
        f"/db/data-sources/{ds_id}/templates", json={"name": "A", "is_default": True}
    )
    assert first.status_code == 201, first.text

    second = await client.post(
        f"/db/data-sources/{ds_id}/templates", json={"name": "B", "is_default": True}
    )
    assert second.status_code == 400
    assert "default" in second.text.lower()


async def test_second_non_default_template_on_same_data_source_succeeds(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    first = await client.post(f"/db/data-sources/{ds_id}/templates", json={"name": "A"})
    assert first.status_code == 201
    second = await client.post(f"/db/data-sources/{ds_id}/templates", json={"name": "B"})
    assert second.status_code == 201


async def test_patch_to_is_default_true_conflicting_with_existing_default_is_400(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    default_res = await client.post(
        f"/db/data-sources/{ds_id}/templates", json={"name": "A", "is_default": True}
    )
    assert default_res.status_code == 201
    other_res = await client.post(f"/db/data-sources/{ds_id}/templates", json={"name": "B"})
    assert other_res.status_code == 201
    other_id = other_res.json()["id"]

    patch_res = await client.patch(f"/db/templates/{other_id}", json={"is_default": True})
    assert patch_res.status_code == 400


async def test_service_layer_raises_duplicate_default_template_error(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await create_template(db_conn, test_user, ds_id, RowTemplateCreate(name="A", is_default=True))
    with pytest.raises(DuplicateDefaultTemplateError):
        await create_template(db_conn, test_user, ds_id, RowTemplateCreate(name="B", is_default=True))


# ===========================================================================
# instantiate_template
# ===========================================================================


async def test_instantiate_template_merges_properties_and_copies_content_verbatim(
    db_conn, test_user
):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    body = RowTemplateCreate(
        name="Bug",
        properties={"statusKey": {"type": "status", "status": "todo"}},
        content=[{"type": "paragraph", "content": "template body"}],
    )
    template = await create_template(db_conn, test_user, ds_id, body)

    result = await instantiate_template(db_conn, test_user, template.id)
    assert result is not None
    assert result.properties == {"statusKey": {"type": "status", "status": "todo"}}

    note = await db_conn.fetchrow("SELECT content, title FROM notes WHERE id = $1", result.id)
    assert note["content"] == [{"type": "paragraph", "content": "template body"}]
    assert note["title"] == "Untitled"  # decision 4: title NOT set from the template's name


async def test_instantiate_template_drops_a_since_deleted_property_key(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "goneKey", "Gone", "status")
    body = RowTemplateCreate(
        name="T", properties={"goneKey": {"type": "status", "status": "todo"}}
    )
    template = await create_template(db_conn, test_user, ds_id, body)
    # The property is deleted after the template captured it.
    await db_conn.execute("DELETE FROM db_properties WHERE data_source_id = $1", ds_id)

    result = await instantiate_template(db_conn, test_user, template.id)
    assert result is not None
    assert result.properties == {}  # dropped silently, not an error


async def test_instantiate_template_title_property_syncs_notes_title(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "titleKey", "Name", "title")
    body = RowTemplateCreate(
        name="T", properties={"titleKey": {"type": "title", "title": "Captured Title"}}
    )
    template = await create_template(db_conn, test_user, ds_id, body)

    result = await instantiate_template(db_conn, test_user, template.id)
    note = await db_conn.fetchrow("SELECT title FROM notes WHERE id = $1", result.id)
    assert note["title"] == "Captured Title"


async def test_instantiate_template_runs_recompute_and_materialises_a_formula(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "numKey", "Price", "number")
    await _insert_property(
        db_conn, test_user, ds_id, "fKey", "Doubled", "formula",
        config=_formula_config('prop("Price") * 2'), result_type="number",
    )
    body = RowTemplateCreate(
        name="T", properties={"numKey": {"type": "number", "number": 21.0}}
    )
    template = await create_template(db_conn, test_user, ds_id, body)

    result = await instantiate_template(db_conn, test_user, template.id)
    computed = await db_conn.fetchval(
        "SELECT computed FROM db_row_props WHERE note_id = $1", result.id
    )
    assert computed["fKey"] == {"type": "number", "number": 42.0}


async def test_instantiate_template_returns_none_for_unknown_or_foreign_template(db_conn, test_user):
    assert await instantiate_template(db_conn, test_user, str(uuid.uuid4())) is None
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    template_id = await _insert_template(db_conn, other_user, ds_id)
    assert await instantiate_template(db_conn, test_user, template_id) is None


async def test_instantiate_template_router_404s_for_unknown_template(client):
    res = await client.post(f"/db/templates/{uuid.uuid4()}/instantiate")
    assert res.status_code == 404


def _preamble_fake_supabase(*, ds_id, row_properties, prop_defs, notes_title="Untitled"):
    """Same helper `test_databases_router.py`'s Fix-4/preamble tests define --
    duplicated per this file's own established "small per-file duplication"
    convention (see e.g. this file's own `_extract_sql_statements` sweep vs.
    `test_databases_router.py`'s)."""
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


async def test_instantiate_template_router_triggers_property_preamble_reindex(client):
    """Fix 6 (task-51, M14 final cross-cutting review): `POST /db/templates/
    {id}/instantiate` -- explicitly picking a NON-default template from the real
    TableView template picker UI, a separate, standalone endpoint from
    `create_row`'s own default-template branch (already wired since task-50) --
    was one of 3 real row-write call sites missed by that task's own sweep. A
    row created this way was permanently unsearchable by property value until
    someone happened to edit its body text."""
    from unittest.mock import patch

    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Notes", "type": "rich_text"}
        )
    ).json()
    tmpl_res = await client.post(
        f"/db/data-sources/{ds_id}/templates",
        json={
            "name": "Non-default",
            "is_default": False,
            "properties": {prop["key"]: {"type": "rich_text", "rich_text": "from template"}},
        },
    )
    assert tmpl_res.status_code == 201, tmpl_res.text
    template_id = tmpl_res.json()["id"]

    fake_db = _preamble_fake_supabase(
        ds_id=ds_id,
        row_properties={prop["key"]: {"type": "rich_text", "rich_text": "from template"}},
        prop_defs=[{"key": prop["key"], "name": "Notes", "type": "rich_text", "position": 0, "config": {}}],
    )

    with (
        patch("services.indexer.get_supabase", return_value=fake_db),
        patch("services.indexer.embed_batch", side_effect=lambda texts: [[0.0]] * len(texts)),
        patch("services.indexer.embed", return_value=[0.0]),
        patch("services.indexer.generate_descriptor", return_value="d"),
    ):
        res = await client.post(f"/db/templates/{template_id}/instantiate")
    assert res.status_code == 201, res.text
    note_id = res.json()["id"]

    insert_call = fake_db.tables["note_chunks"].insert.call_args
    assert insert_call is not None, "note_chunks.insert was never called -- index_note was never invoked"
    rows = insert_call[0][0]
    assert len(rows) == 1
    assert rows[0]["chunk_index"] == 0
    assert rows[0]["chunk_text"] == "Notes: from template"
    assert rows[0]["block_id"] == "__property_preamble__"
    assert rows[0]["note_id"] == note_id


# ===========================================================================
# create_row: default-template auto-apply (task-37-brief.md decision 3)
# ===========================================================================


async def test_create_row_with_no_default_template_is_unchanged_blank_row(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text
    assert res.json()["properties"] == {}


async def test_create_row_with_a_default_template_carries_its_properties_and_content(
    client, db_conn
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop_key = created["properties"][0]["key"]  # the default "Title" property

    tmpl_res = await client.post(
        f"/db/data-sources/{ds_id}/templates",
        json={
            "name": "Default",
            "is_default": True,
            "properties": {prop_key: {"type": "title", "title": "From template"}},
            "content": [{"type": "paragraph", "content": "seeded"}],
        },
    )
    assert tmpl_res.status_code == 201, tmpl_res.text

    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["properties"] == {prop_key: {"type": "title", "title": "From template"}}

    note = await db_conn.fetchrow("SELECT content, title FROM notes WHERE id = $1", body["id"])
    assert note["content"] == [{"type": "paragraph", "content": "seeded"}]
    assert note["title"] == "From template"


# ===========================================================================
# next_occurrence: pure date arithmetic, fixed reference datetimes only
# ===========================================================================


_UTC = timezone.utc


@pytest.mark.parametrize(
    "repeat_config,after,expected",
    [
        # Daily, interval 1: the very next day at the anchor's time.
        (
            {"frequency": "daily", "interval": 1, "start_date": "2026-01-01", "time_of_day": "09:00"},
            datetime(2026, 1, 5, 9, 0, tzinfo=_UTC),
            datetime(2026, 1, 6, 9, 0, tzinfo=_UTC),
        ),
        # Daily, interval 3: "every 3 days" (research §J.5.3's "Custom" example).
        (
            {"frequency": "daily", "interval": 3, "start_date": "2026-01-01", "time_of_day": "09:00"},
            datetime(2026, 1, 1, 9, 0, tzinfo=_UTC),
            datetime(2026, 1, 4, 9, 0, tzinfo=_UTC),
        ),
        # Weekly, Tue+Thu, roll-forward across a week boundary: after the
        # week's last occurrence (Thursday), the next one is next Tuesday.
        (
            {
                "frequency": "weekly", "interval": 1, "weekdays": [2, 4],
                "start_date": "2026-01-06", "time_of_day": "09:00",  # 2026-01-06 is a Tuesday
            },
            datetime(2026, 1, 8, 9, 0, tzinfo=_UTC),  # that week's Thursday occurrence
            datetime(2026, 1, 13, 9, 0, tzinfo=_UTC),  # following Tuesday
        ),
        # Weekly, interval 2: every OTHER week, skips the interleaving week.
        (
            {
                "frequency": "weekly", "interval": 2, "weekdays": [1],
                "start_date": "2026-01-05", "time_of_day": "09:00",  # Monday
            },
            datetime(2026, 1, 5, 9, 0, tzinfo=_UTC),
            datetime(2026, 1, 19, 9, 0, tzinfo=_UTC),  # 2 weeks later, not 1
        ),
        # Monthly, month-length edge: Jan 31 -> Feb 28 (2026 is not a leap year).
        (
            {"frequency": "monthly", "interval": 1, "start_date": "2026-01-31", "time_of_day": "09:00"},
            datetime(2026, 1, 31, 9, 0, tzinfo=_UTC),
            datetime(2026, 2, 28, 9, 0, tzinfo=_UTC),
        ),
        # Monthly, resumes the 31st once a long-enough month reappears.
        (
            {"frequency": "monthly", "interval": 1, "start_date": "2026-01-31", "time_of_day": "09:00"},
            datetime(2026, 2, 28, 9, 0, tzinfo=_UTC),
            datetime(2026, 3, 31, 9, 0, tzinfo=_UTC),
        ),
        # Monthly, interval 2: "every 2 months" (research §J.5.3's example).
        (
            {"frequency": "monthly", "interval": 2, "start_date": "2026-01-15", "time_of_day": "09:00"},
            datetime(2026, 1, 15, 9, 0, tzinfo=_UTC),
            datetime(2026, 3, 15, 9, 0, tzinfo=_UTC),
        ),
        # Yearly, leap-day anchor rolling into a non-leap year.
        (
            {"frequency": "yearly", "interval": 1, "start_date": "2024-02-29", "time_of_day": "00:00"},
            datetime(2024, 2, 29, 0, 0, tzinfo=_UTC),
            datetime(2025, 2, 28, 0, 0, tzinfo=_UTC),
        ),
        # Seeding: `after` well before the anchor -> the anchor itself.
        (
            {"frequency": "daily", "interval": 1, "start_date": "2026-06-01", "time_of_day": "09:00"},
            datetime(2026, 1, 1, 0, 0, tzinfo=_UTC),
            datetime(2026, 6, 1, 9, 0, tzinfo=_UTC),
        ),
    ],
)
def test_next_occurrence_table(repeat_config, after, expected):
    assert next_occurrence(repeat_config, after) == expected


# ===========================================================================
# Scheduler tick
# ===========================================================================


async def test_tick_creates_a_row_and_advances_next_run_at_for_a_due_template(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    repeat_config = {
        "frequency": "daily", "interval": 1, "start_date": "2020-01-01", "time_of_day": "00:00",
    }
    template_id = await _insert_template(
        db_conn, test_user, ds_id,
        name="Daily standup",
        properties={"statusKey": {"type": "status", "status": "todo"}},
        repeat_config=repeat_config,
        next_run_at=past,
    )

    row_count_before = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", ds_id)
    created = await _tick_templates(db_conn)
    row_count_after = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", ds_id)

    assert created == 1
    assert row_count_after == row_count_before + 1

    new_next_run_at = await db_conn.fetchval(
        "SELECT next_run_at FROM db_row_templates WHERE id = $1", template_id
    )
    assert new_next_run_at == next_occurrence(repeat_config, past)
    assert new_next_run_at > past


async def test_tick_triggers_property_preamble_reindex_for_the_created_row(db_conn, test_user):
    """Fix 6 (task-51, M14 final cross-cutting review): a repeating row-template
    firing on schedule -- no HTTP request involved at all -- was one of 3 real
    row-write call sites task-50's own sweep missed. Without this, a row created
    this way is permanently unsearchable by property value."""
    from unittest.mock import patch

    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "statusKey", "Status", "status")
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    repeat_config = {
        "frequency": "daily", "interval": 1, "start_date": "2020-01-01", "time_of_day": "00:00",
    }
    await _insert_template(
        db_conn, test_user, ds_id,
        name="Daily standup",
        properties={"statusKey": {"type": "status", "status": "todo"}},
        repeat_config=repeat_config,
        next_run_at=past,
    )

    fake_db = _preamble_fake_supabase(
        ds_id=ds_id,
        row_properties={"statusKey": {"type": "status", "status": "todo"}},
        prop_defs=[{"key": "statusKey", "name": "Status", "type": "status", "position": 0, "config": {}}],
    )

    with (
        patch("services.indexer.get_supabase", return_value=fake_db),
        patch("services.indexer.embed_batch", side_effect=lambda texts: [[0.0]] * len(texts)),
        patch("services.indexer.embed", return_value=[0.0]),
        patch("services.indexer.generate_descriptor", return_value="d"),
    ):
        created = await _tick_templates(db_conn)
    assert created == 1

    insert_call = fake_db.tables["note_chunks"].insert.call_args
    assert insert_call is not None, "note_chunks.insert was never called -- index_note was never invoked"
    rows = insert_call[0][0]
    assert len(rows) == 1
    assert rows[0]["chunk_index"] == 0
    assert rows[0]["chunk_text"].startswith("Status:")
    assert rows[0]["block_id"] == "__property_preamble__"


async def test_tick_templates_indexing_does_not_block_the_event_loop(db_conn, test_user):
    """Controller-caught, post-task-51 (M14 final cross-cutting review, Fix 1/Fix 6
    interaction): `_tick_templates` runs on `AsyncIOScheduler`'s own asyncio loop --
    the SAME event loop the rest of the app serves requests on (confirmed by reading
    `scheduler.py`: `AsyncIOScheduler` integrates directly with the running loop, it
    is not a separate thread/process). Task 51's own Fix 6 added a `try_index_note`
    call inside this function's `for row in due:` loop -- but `try_index_note` ->
    `index_note` is a synchronous, blocking function (same one Fix 1, in the SAME
    commit, moved off the event loop for `db_import.py`'s per-row loop). Calling it
    directly here reintroduces the exact regression class Fix 1 closed, one function
    away: a tick with multiple due templates would block every concurrent HTTP
    request for the tick's duration. Fixed directly by the controller (mirroring
    Fix 1's own `asyncio.to_thread` fix exactly) after independently verifying
    task-51's diff; proven here with the same heartbeat-tick-count technique Fix 1's
    own test already established (see `test_db_csv_import.py`'s extensive comment on
    why a single concurrent request's own latency is an unreliable proof)."""
    ds_id = await _make_data_source(db_conn, test_user)
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    repeat_config = {
        "frequency": "daily", "interval": 1, "start_date": "2020-01-01", "time_of_day": "00:00",
    }
    template_count = 10
    for i in range(template_count):
        await _insert_template(
            db_conn, test_user, ds_id,
            name=f"Template {i}", repeat_config=repeat_config, next_run_at=past,
        )

    def _slow_fake_index(note_id, user_id) -> bool:
        time.sleep(0.05)
        return True

    from unittest.mock import patch

    TICK_INTERVAL = 0.01
    stop = False
    tick_count = 0

    async def heartbeat():
        nonlocal tick_count
        while not stop:
            await asyncio.sleep(TICK_INTERVAL)
            tick_count += 1

    async def do_tick():
        nonlocal stop
        t0 = time.monotonic()
        with patch("services.db.scheduler.try_index_note", side_effect=_slow_fake_index):
            created = await _tick_templates(db_conn)
        elapsed = time.monotonic() - t0
        stop = True
        return created, elapsed

    heartbeat_task = asyncio.create_task(heartbeat())
    created, tick_elapsed = await do_tick()
    heartbeat_task.cancel()
    try:
        await heartbeat_task
    except asyncio.CancelledError:
        pass

    assert created == template_count

    expected_ticks_if_unblocked = tick_elapsed / TICK_INTERVAL
    assert tick_count > expected_ticks_if_unblocked * 0.6, (
        f"heartbeat only ticked {tick_count} times over {tick_elapsed:.3f}s "
        f"(expected ~{expected_ticks_if_unblocked:.0f} if the loop stayed free) "
        f"-- the event loop was blocked while _tick_templates ran"
    )


async def test_tick_does_not_touch_a_template_whose_next_run_at_is_in_the_future(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    # A fixed far-future instant, not `datetime.now() + timedelta(...)` --
    # task-37-brief.md is explicit that no scheduler-tick test may depend
    # on the real clock. "Far future" only needs to be later than whenever
    # this suite is ever run; 2999 comfortably clears that bar forever.
    future = datetime(2999, 1, 1, tzinfo=timezone.utc)
    repeat_config = {
        "frequency": "daily", "interval": 1, "start_date": "2020-01-01", "time_of_day": "00:00",
    }
    template_id = await _insert_template(
        db_conn, test_user, ds_id, repeat_config=repeat_config, next_run_at=future
    )

    row_count_before = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", ds_id)
    created = await _tick_templates(db_conn)
    row_count_after = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", ds_id)

    assert created == 0
    assert row_count_after == row_count_before
    unchanged_next_run_at = await db_conn.fetchval(
        "SELECT next_run_at FROM db_row_templates WHERE id = $1", template_id
    )
    assert unchanged_next_run_at == future


async def test_tick_never_touches_a_non_repeating_template(db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    # repeat_config IS NULL (the normal non-repeating case) -- next_run_at
    # should always be NULL too, but the tick must not crash even if it
    # somehow isn't (defensive; the WHERE clause filters on repeat_config
    # IS NOT NULL, not on next_run_at alone).
    past = datetime(2020, 1, 1, tzinfo=timezone.utc)
    await _insert_template(db_conn, test_user, ds_id, repeat_config=None, next_run_at=past)

    row_count_before = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", ds_id)
    created = await _tick_templates(db_conn)
    row_count_after = await db_conn.fetchval("SELECT count(*) FROM db_row_props WHERE data_source_id = $1", ds_id)

    assert created == 0
    assert row_count_after == row_count_before
