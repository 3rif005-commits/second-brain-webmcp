"""Tests for routers/databases.py: database/data-source/property/view CRUD
and the built-in "All Notes" virtual source (spec §6).

All tests run against the local pgtest harness (localhost:55432, migrations
001-014 applied — see repo root's `scripts/pgtest/up.sh`/`apply.sh`) through
a single transaction-wrapped `db_conn` that's rolled back on teardown (see
`tests/conftest.py`). `get_conn` and `get_user_id` are swapped for test
doubles via FastAPI's `app.dependency_overrides` — no header/JWT plumbing
needed, and no code path here can reach `core.config.settings.database_url`
(the real Supabase project).
"""
import re
import uuid
from pathlib import Path

import httpx
import pytest_asyncio

from main import app
from routers.databases import ALL_NOTES_ID
from routers.notes import get_user_id
from services.db.connection import get_conn
from services.db.properties.columns import COLUMN_BACKED


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


# ---------------------------------------------------------------------------
# Creating a database
# ---------------------------------------------------------------------------

async def test_create_database_creates_exactly_one_data_source_and_one_default_table_view(
    client, db_conn, test_user
):
    body = await _create_database(client, "Reading List")

    assert body["database"]["title"] == "Reading List"
    assert body["data_source"]["system_kind"] is None
    assert body["data_source"]["is_virtual"] is False
    # A fresh database ships with a default "Title" property (product
    # decision after the review: a database with zero columns is inert) --
    # not an empty list.
    assert len(body["properties"]) == 1
    assert body["properties"][0]["name"] == "Title"
    assert body["properties"][0]["type"] == "title"
    assert re.fullmatch(r"[0-9A-Za-z]{8}", body["properties"][0]["key"])
    assert len(body["views"]) == 1
    assert body["views"][0]["type"] == "table"
    # Regression (task-36): the pre-existing, only-tested path — no
    # `parent_note_id` in the request — must still leave both columns at
    # their defaults now that `create_database` can set them.
    assert body["database"]["is_inline"] is False
    assert body["database"]["parent_note_id"] is None

    database_id = body["database"]["id"]
    ds_count = await db_conn.fetchval(
        "SELECT count(*) FROM db_data_sources WHERE database_id = $1", database_id
    )
    view_count = await db_conn.fetchval(
        "SELECT count(*) FROM db_views WHERE data_source_id = $1", body["data_source"]["id"]
    )
    prop_count = await db_conn.fetchval(
        "SELECT count(*) FROM db_properties WHERE data_source_id = $1", body["data_source"]["id"]
    )
    assert ds_count == 1
    assert view_count == 1
    assert prop_count == 1


async def test_create_database_with_parent_note_id_sets_is_inline(client, db_conn, test_user):
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Host note') RETURNING id", test_user
    )
    res = await client.post(
        "/db/databases", json={"title": "Inline DB", "parent_note_id": str(note["id"])}
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["database"]["is_inline"] is True
    assert body["database"]["parent_note_id"] == str(note["id"])


async def test_create_database_404s_for_another_users_parent_note_id(client, db_conn, test_user):
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    others_note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Not mine') RETURNING id", other_user
    )
    res = await client.post(
        "/db/databases", json={"title": "Inline DB", "parent_note_id": str(others_note["id"])}
    )
    assert res.status_code == 404


async def test_create_database_404s_for_a_trashed_parent_note_id(client, db_conn, test_user):
    trashed = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title, deleted_at) VALUES ($1, 'Trashed', now()) RETURNING id",
        test_user,
    )
    res = await client.post(
        "/db/databases", json={"title": "Inline DB", "parent_note_id": str(trashed["id"])}
    )
    assert res.status_code == 404


async def test_create_database_404s_for_a_syntactically_invalid_parent_note_id(client):
    res = await client.post(
        "/db/databases", json={"title": "Inline DB", "parent_note_id": "not-a-uuid"}
    )
    assert res.status_code == 404


async def test_get_database_round_trips_a_created_database(client):
    created = await _create_database(client)
    res = await client.get(f"/db/databases/{created['database']['id']}")
    assert res.status_code == 200
    body = res.json()
    assert body["database"]["id"] == created["database"]["id"]
    assert body["data_source"]["id"] == created["data_source"]["id"]
    assert body["views"][0]["id"] == created["views"][0]["id"]


async def test_get_database_404s_for_another_users_database(client, db_conn):
    created = await _create_database(client)

    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    app.dependency_overrides[get_user_id] = lambda: other_user
    res = await client.get(f"/db/databases/{created['database']['id']}")
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Property creation: unique keys, duplicate names allowed
# ---------------------------------------------------------------------------

async def test_creating_a_property_mints_a_unique_key(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    res = await client.post(
        f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
    )
    assert res.status_code == 201, res.text
    prop = res.json()
    assert re.fullmatch(r"[0-9A-Za-z]{8}", prop["key"])
    assert prop["storage"] == "jsonb"


async def test_second_property_with_same_name_succeeds_with_a_different_key(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    res1 = await client.post(
        f"/db/data-sources/{ds_id}/properties", json={"name": "Priority", "type": "select"}
    )
    res2 = await client.post(
        f"/db/data-sources/{ds_id}/properties", json={"name": "Priority", "type": "select"}
    )
    assert res1.status_code == 201 and res2.status_code == 201
    key1, key2 = res1.json()["key"], res2.json()["key"]
    assert key1 != key2
    assert res1.json()["name"] == res2.json()["name"] == "Priority"


async def test_property_key_collision_is_retried_not_a_500(client, monkeypatch):
    """A colliding key must not poison the rest of the request's
    transaction — the retry has to actually succeed with a fresh key, not
    just avoid crashing on the first attempt."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    first = await client.post(
        f"/db/data-sources/{ds_id}/properties", json={"name": "A", "type": "rich_text"}
    )
    existing_key = first.json()["key"]

    import routers.databases as databases_module

    keys = iter([existing_key, "freshKy1"])
    monkeypatch.setattr(databases_module, "mint_key", lambda: next(keys))

    res = await client.post(
        f"/db/data-sources/{ds_id}/properties", json={"name": "B", "type": "rich_text"}
    )
    assert res.status_code == 201, res.text
    assert res.json()["key"] == "freshKy1"


async def test_cannot_add_a_property_to_the_all_notes_virtual_source(client):
    res = await client.post(
        f"/db/data-sources/{ALL_NOTES_ID}/properties", json={"name": "X", "type": "text"}
    )
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# Renaming: name changes, key and row JSONB are untouched
# ---------------------------------------------------------------------------

async def test_renaming_a_property_leaves_key_and_row_jsonb_untouched(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    prop_res = await client.post(
        f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
    )
    prop = prop_res.json()
    original_key = prop["key"]

    # A row whose JSONB uses this property's key, to prove the rename never
    # touches db_row_props.
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'N1') RETURNING id", test_user
    )
    original_properties = {original_key: {"type": "status", "status": "in_progress"}}
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
        VALUES ($1, $2, $3, $4)
        """,
        note["id"], ds_id, test_user, original_properties,
    )

    res = await client.patch(f"/db/properties/{prop['id']}", json={"name": "Progress"})
    assert res.status_code == 200, res.text
    renamed = res.json()
    assert renamed["name"] == "Progress"
    assert renamed["key"] == original_key

    row_after = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", note["id"]
    )
    assert row_after["properties"] == original_properties


async def test_rename_404s_for_unknown_property(client):
    res = await client.patch(f"/db/properties/{uuid.uuid4()}", json={"name": "X"})
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Deleting a property sweeps view filter/sorts/config.properties[]
# ---------------------------------------------------------------------------

async def test_deleting_a_property_sweeps_it_from_every_view(client, db_conn):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    view_id = created["views"][0]["id"]

    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()
    key = prop["key"]

    await db_conn.execute(
        """
        UPDATE db_views SET filter = $1, sorts = $2, config = $3 WHERE id = $4
        """,
        {"type": "condition", "property": key, "operator": "is_empty", "value": None},
        [{"property": key, "direction": "asc"}],
        {"properties": [{"property": key, "visible": True}]},
        view_id,
    )

    res = await client.delete(f"/db/properties/{prop['id']}")
    assert res.status_code == 204

    view_row = await db_conn.fetchrow(
        "SELECT filter, sorts, config FROM db_views WHERE id = $1", view_id
    )
    assert view_row["filter"] is None
    assert view_row["sorts"] == []
    assert view_row["config"] == {"properties": []}

    prop_count = await db_conn.fetchval(
        "SELECT count(*) FROM db_properties WHERE id = $1", prop["id"]
    )
    assert prop_count == 0


async def test_delete_404s_for_unknown_property(client):
    res = await client.delete(f"/db/properties/{uuid.uuid4()}")
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# The "All Notes" virtual source
# ---------------------------------------------------------------------------

async def test_all_notes_database_is_synthesized_and_flagged_virtual(client):
    res = await client.get(f"/db/databases/{ALL_NOTES_ID}")
    assert res.status_code == 200
    body = res.json()
    assert body["data_source"]["is_virtual"] is True
    assert body["data_source"]["system_kind"] == "notes"
    assert {p["key"] for p in body["properties"]} == {p.column for p in COLUMN_BACKED.values()}
    assert len(body["views"]) == 1 and body["views"][0]["type"] == "table"


async def test_all_notes_lists_the_users_notes_excludes_others_and_trashed(
    client, db_conn, test_user
):
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )

    mine = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title, mastery_status, topics) "
        "VALUES ($1, 'Mine', 'learning', $2) RETURNING id",
        test_user, ["rust", "async"],
    )
    trashed = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title, deleted_at) VALUES ($1, 'Trashed', now()) RETURNING id",
        test_user,
    )
    others = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Not mine') RETURNING id", other_user
    )

    res = await client.get(f"/db/data-sources/{ALL_NOTES_ID}/rows")
    assert res.status_code == 200
    rows = res.json()["rows"]
    ids = {r["id"] for r in rows}

    assert str(mine["id"]) in ids
    assert str(trashed["id"]) not in ids
    assert str(others["id"]) not in ids

    # Values are spec §3.3's discriminated wrapper, same shape as an
    # ordinary data source's db_row_props.properties entries (task-5
    # review finding 2) — not bare scalars.
    mine_row = next(r for r in rows if r["id"] == str(mine["id"]))
    assert mine_row["properties"]["mastery_status"] == {"type": "status", "status": "learning"}
    assert mine_row["properties"]["topics"] == {
        "type": "multi_select", "multi_select": ["rust", "async"]
    }
    assert mine_row["properties"]["title"] == {"type": "title", "title": "Mine"}


# ---------------------------------------------------------------------------
# Listing rows for an ordinary (non-virtual) data source — task-5 review
# finding 5: this path had zero test coverage, and depends on the jsonb
# codec registered in services/db/connection.py's _init_connection, so it's
# worth actually exercising rather than trusting by inspection.
# ---------------------------------------------------------------------------

async def test_list_rows_for_an_ordinary_data_source_round_trips_jsonb(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()

    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    value = {prop["key"]: {"type": "status", "status": "in_progress"}}
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
        VALUES ($1, $2, $3, $4)
        """,
        note["id"], ds_id, test_user, value,
    )

    res = await client.get(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 200
    rows = res.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["id"] == str(note["id"])
    assert rows[0]["properties"] == value  # round-tripped through the jsonb codec intact


async def test_list_rows_404s_for_an_unknown_data_source(client):
    res = await client.get(f"/db/data-sources/{uuid.uuid4()}/rows")
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# list_rows has a hard cap (task-10 review finding 1) — neither branch had
# any LIMIT, so a user with hundreds/thousands of notes would fetch every
# matching row unconditionally on the one page Milestone 2 ships
# (/brain/db/all-notes). No pagination UI yet (Milestone 3+ scope) — just a
# sane cap on the query. The router's private `_ROWS_LIMIT` constant is
# monkeypatched down to a small number so the test doesn't need to actually
# insert hundreds of rows.
# ---------------------------------------------------------------------------

async def test_list_rows_caps_all_notes_at_the_hard_limit(
    client, db_conn, test_user, monkeypatch
):
    import routers.databases as databases_module

    monkeypatch.setattr(databases_module, "_ROWS_LIMIT", 3, raising=False)

    for i in range(5):
        await db_conn.execute(
            "INSERT INTO notes (user_id, title) VALUES ($1, $2)", test_user, f"Note {i}"
        )

    res = await client.get(f"/db/data-sources/{ALL_NOTES_ID}/rows")
    assert res.status_code == 200
    assert len(res.json()["rows"]) == 3


async def test_list_rows_caps_an_ordinary_data_source_at_the_hard_limit(
    client, db_conn, test_user, monkeypatch
):
    import routers.databases as databases_module

    monkeypatch.setattr(databases_module, "_ROWS_LIMIT", 3, raising=False)

    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    for i in range(5):
        note = await db_conn.fetchrow(
            "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id",
            test_user, f"Row {i}",
        )
        await db_conn.execute(
            "INSERT INTO db_row_props (note_id, data_source_id, user_id) VALUES ($1, $2, $3)",
            note["id"], ds_id, test_user,
        )

    res = await client.get(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 200
    assert len(res.json()["rows"]) == 3


# ---------------------------------------------------------------------------
# Creating a row (fix round 2, review finding 3) — without this, an ordinary
# data source has zero rows, permanently, and the PATCH endpoint below is
# unreachable end-to-end.
# ---------------------------------------------------------------------------

async def test_create_row_creates_a_note_and_a_row_props_in_one_transaction(
    client, db_conn
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["properties"] == {}

    note = await db_conn.fetchrow("SELECT id, title FROM notes WHERE id = $1", body["id"])
    assert note is not None
    assert note["title"] == "Untitled"

    row = await db_conn.fetchrow(
        "SELECT data_source_id, properties FROM db_row_props WHERE note_id = $1", body["id"]
    )
    assert row is not None
    assert str(row["data_source_id"]) == ds_id
    assert row["properties"] == {}


async def test_create_row_appends_stable_position_not_a_tie_at_zero(client, db_conn):
    # Without an explicit position, every created row defaulted to 0 --
    # list_rows's ORDER BY position was then an unbroken tie among them,
    # so rows could visibly reshuffle between GETs once 2+ existed.
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    first = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()
    second = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()
    third = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()

    positions = await db_conn.fetch(
        "SELECT note_id, position FROM db_row_props WHERE data_source_id = $1 ORDER BY position",
        ds_id,
    )
    ordered_ids = [str(r["note_id"]) for r in positions]
    assert ordered_ids == [first["id"], second["id"], third["id"]]
    # Strictly increasing, not all tied at the column default of 0.
    values = [r["position"] for r in positions]
    assert values == sorted(values)
    assert len(set(values)) == 3


async def test_create_row_400s_for_the_all_notes_virtual_source(client):
    res = await client.post(f"/db/data-sources/{ALL_NOTES_ID}/rows")
    assert res.status_code == 400


async def test_create_row_404s_for_unknown_data_source(client):
    res = await client.post(f"/db/data-sources/{uuid.uuid4()}/rows")
    assert res.status_code == 404


async def test_create_row_404s_for_another_users_data_source(client, db_conn):
    # migration 001's on_auth_user_created trigger already inserts a
    # matching `profiles` row for every `auth.users` insert (see the
    # `test_user` fixture's own docstring) -- no separate insert needed.
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'Other') RETURNING id", other_user
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id) VALUES ($1, $2) RETURNING id",
        db_row["id"], other_user,
    )
    res = await client.post(f"/db/data-sources/{ds_row['id']}/rows")
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Writing a row's property value (task-5 review finding 1) — blocking for
# the frontend's own planned test cases ("TableView renders 8 property
# types read-only, then editable"; "optimistic edit rolls back and toasts
# on a 500"), neither buildable without a way to write a cell.
# ---------------------------------------------------------------------------

async def test_update_row_property_writes_a_single_key_and_leaves_others_untouched(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    prop_a = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()
    prop_b = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Notes", "type": "rich_text"}
        )
    ).json()

    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    initial = {
        prop_a["key"]: {"type": "status", "status": "not_started"},
        prop_b["key"]: {"type": "rich_text", "rich_text": "hello"},
    }
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
        VALUES ($1, $2, $3, $4)
        """,
        note["id"], ds_id, test_user, initial,
    )

    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{note['id']}",
        json={"property_key": prop_a["key"], "value": {"type": "status", "status": "done"}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["id"] == str(note["id"])
    assert body["properties"][prop_a["key"]] == {"type": "status", "status": "done"}
    assert body["properties"][prop_b["key"]] == {"type": "rich_text", "rich_text": "hello"}

    row_after = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", note["id"]
    )
    # The other property's value is byte-identical -- the write only ever
    # touches its own key (jsonb_set's third argument is the target path).
    assert row_after["properties"][prop_b["key"]] == initial[prop_b["key"]]
    assert row_after["properties"][prop_a["key"]] == {"type": "status", "status": "done"}


async def test_update_row_property_404s_for_unknown_property(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id) VALUES ($1, $2, $3)",
        note["id"], ds_id, test_user,
    )
    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{note['id']}",
        json={"property_key": "doesNotEx", "value": {"type": "status", "status": "x"}},
    )
    assert res.status_code == 404


async def test_update_row_property_404s_for_an_unknown_row(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()

    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{uuid.uuid4()}",
        json={"property_key": prop["key"], "value": {"type": "status", "status": "x"}},
    )
    assert res.status_code == 404


async def test_update_row_property_404s_for_another_users_row(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) "
        "VALUES ($1, $2, $3, '{}')",
        note["id"], ds_id, test_user,
    )

    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    app.dependency_overrides[get_user_id] = lambda: other_user

    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{note['id']}",
        json={"property_key": prop["key"], "value": {"type": "status", "status": "x"}},
    )
    assert res.status_code == 404


async def test_update_row_property_404s_when_row_belongs_to_a_different_data_source(
    client, db_conn, test_user
):
    created1 = await _create_database(client, "DB1")
    created2 = await _create_database(client, "DB2")
    ds1_id = created1["data_source"]["id"]
    ds2_id = created2["data_source"]["id"]

    # Same name/type on both, so the mixup is caught even when the property
    # *shape* matches -- only the (data_source_id, key) pair actually differs.
    prop2 = (
        await client.post(
            f"/db/data-sources/{ds2_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()

    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) "
        "VALUES ($1, $2, $3, '{}')",
        note["id"], ds1_id, test_user,
    )

    # prop2's key only exists under ds2 -- but the row lives under ds1.
    res = await client.patch(
        f"/db/data-sources/{ds1_id}/rows/{note['id']}",
        json={"property_key": prop2["key"], "value": {"type": "status", "status": "x"}},
    )
    assert res.status_code == 404


async def test_update_row_property_is_not_implemented_for_all_notes(client):
    res = await client.patch(
        f"/db/data-sources/{ALL_NOTES_ID}/rows/{uuid.uuid4()}",
        json={"property_key": "topics", "value": {"type": "multi_select", "multi_select": []}},
    )
    assert res.status_code == 501


async def test_update_row_property_with_explicit_null_clears_the_key(
    client, db_conn, test_user
):
    # Review finding 1, fix round 2: `jsonb_set(properties, path, NULL, true)`
    # would set the *entire* NOT NULL `properties` column to SQL NULL, not
    # just this key -- a real NotNullViolationError verified against the
    # harness. An explicit top-level `null` must instead drop just the key
    # (`properties - key`), spec §3.3: "Absent key ≡ empty."
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()

    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
        VALUES ($1, $2, $3, $4)
        """,
        note["id"], ds_id, test_user, {prop["key"]: {"type": "status", "status": "done"}},
    )

    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{note['id']}",
        json={"property_key": prop["key"], "value": None},
    )
    assert res.status_code == 200, res.text
    assert prop["key"] not in res.json()["properties"]

    row_after = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", note["id"]
    )
    # The column itself is still NOT NULL -- only the one key is gone.
    assert row_after["properties"] is not None
    assert prop["key"] not in row_after["properties"]


async def test_update_row_property_rejects_a_wrapper_whose_type_tag_mismatches_the_property(
    client, db_conn, test_user
):
    # task-10 review finding 2: `RowPropertyUpdate.value` is `Any` with no
    # shape validation, so a `status`-typed property could be PATCHed with a
    # `number` wrapper and get written into db_row_props.properties
    # verbatim — silently violating spec §3.3's invariant that every stored
    # value is a discriminated wrapper matching its property's declared
    # type, which Milestone 3's filter/sort compiler will assume holds.
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()

    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id) VALUES ($1, $2, $3)",
        note["id"], ds_id, test_user,
    )

    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{note['id']}",
        json={"property_key": prop["key"], "value": {"type": "number", "number": 42}},
    )
    assert res.status_code == 400

    row_after = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", note["id"]
    )
    assert prop["key"] not in row_after["properties"]  # rejected, never written


async def test_update_row_property_rejects_a_bare_scalar_value(client, db_conn, test_user):
    # Same invariant as above, but for a value that isn't even wrapped in a
    # dict at all (e.g. `{"property_key": "...", "value": "done"}`).
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Status", "type": "status"}
        )
    ).json()

    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id) VALUES ($1, $2, $3)",
        note["id"], ds_id, test_user,
    )

    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{note['id']}",
        json={"property_key": prop["key"], "value": "done"},
    )
    assert res.status_code == 400

    row_after = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", note["id"]
    )
    assert prop["key"] not in row_after["properties"]  # rejected, never written


async def test_update_row_property_rejects_an_oversized_number_with_400_not_500(
    client, db_conn, test_user
):
    """Fix 2 (task-51, M14 final cross-cutting review): pre-fix, this endpoint
    accepted `body.value` as an already-built wrapper with no coercion at all
    (unlike the agent-tools/internal-API write path, which validates through
    `coerce_property_write` -> `Number.coerce_write`) -- a too-large Python int
    (unbounded, so no `isinstance` check catches it) sailed through as a
    "well-formed" number wrapper, got written, then raised an unhandled
    `OverflowError` (not a `ValueError`) the moment `update_row_property_core`'s
    own `recompute_row` call decoded it back -- reproduced directly against this
    endpoint with a throwaway script before this test was written. Guarded
    narrowly in `update_row_property_core` itself (the shared core this PATCH
    endpoint and every automation action handler write through), since it
    structurally never reaches `Number.coerce_write` at all."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Score", "type": "number"}
        )
    ).json()

    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id) VALUES ($1, $2, $3)",
        note["id"], ds_id, test_user,
    )

    huge = int("1" + "0" * 400)
    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{note['id']}",
        json={"property_key": prop["key"], "value": {"type": "number", "number": huge}},
    )
    assert res.status_code == 400, res.text
    assert "out of range" in res.json()["detail"]

    # Never left the row in a broken state: the property was never written.
    row_after = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", note["id"]
    )
    assert prop["key"] not in (row_after["properties"] or {})


async def test_update_row_property_requires_a_value_field(client, db_conn, test_user):
    # Review finding 1, fix round 2: `value` has no default (was `Any = None`,
    # now required) -- an omitted `value` is a 422 at the Pydantic layer, not
    # a NotNullViolationError 500 once it reaches `jsonb_set`.
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Row 1') RETURNING id", test_user
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id) VALUES ($1, $2, $3)",
        note["id"], ds_id, test_user,
    )
    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{note['id']}",
        json={"property_key": "doesNotMatter"},
    )
    assert res.status_code == 422


# ---------------------------------------------------------------------------
# View updates (task-5 review finding 1: "there's also no view-update
# endpoint" -- column width/visibility/sort persistence has nowhere to go).
# ---------------------------------------------------------------------------

async def test_update_view_partially_updates_only_provided_fields(client):
    created = await _create_database(client)
    view_id = created["views"][0]["id"]

    res = await client.patch(f"/db/views/{view_id}", json={"name": "My View"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == "My View"
    assert body["type"] == "table"  # untouched
    assert body["is_locked"] is False  # untouched


async def test_update_view_can_persist_filter_sorts_and_config(client):
    created = await _create_database(client)
    view_id = created["views"][0]["id"]

    res = await client.patch(
        f"/db/views/{view_id}",
        json={
            "filter": {
                "type": "condition", "property": "a7Kd9x", "operator": "is_empty", "value": None,
            },
            "sorts": [{"property": "a7Kd9x", "direction": "asc"}],
            "config": {"frozen_column_index": 1},
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["filter"]["property"] == "a7Kd9x"
    assert body["sorts"] == [{"property": "a7Kd9x", "direction": "asc"}]
    assert body["config"] == {"frozen_column_index": 1}


async def test_update_view_drops_explicit_null_for_a_non_nullable_field_without_crashing(
    client,
):
    # Review finding 2, fix round 2: 5 of the 7 updatable fields (name,
    # config, sorts, is_locked, position) are NOT NULL columns. An explicit
    # `null` for one of them used to reach the database as a real
    # NotNullViolationError 500 -- verified against the harness. It must
    # instead be a no-op for that one field, with the rest of the same
    # request still applying, and only `icon`/`filter` may actually clear.
    created = await _create_database(client)
    view_id = created["views"][0]["id"]
    original_name = created["views"][0]["name"]

    res = await client.patch(
        f"/db/views/{view_id}",
        json={"name": None, "icon": "📊"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == original_name  # untouched, not nulled
    assert body["icon"] == "📊"  # the nullable field still applied


async def test_update_view_404s_for_unknown_view(client):
    res = await client.patch(f"/db/views/{uuid.uuid4()}", json={"name": "X"})
    assert res.status_code == 404


async def test_update_view_404s_for_another_users_view(client, db_conn):
    created = await _create_database(client)
    view_id = created["views"][0]["id"]

    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    app.dependency_overrides[get_user_id] = lambda: other_user

    res = await client.patch(f"/db/views/{view_id}", json={"name": "X"})
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Dashboard view config validation (task-45, research §13.2): update_view's
# `config` column is a completely unvalidated JSONB pass-through for every
# OTHER view type, but a `dashboard` view's `config.rows[].widgets[]` is
# checked against the widget-grid limits before it's ever persisted.
# ---------------------------------------------------------------------------

async def _create_dashboard_and_widget_views(client, n_widget_views: int = 1):
    """A fresh database, a `dashboard` view on its data source, and
    `n_widget_views` plain `table` views on the SAME data source to use as
    widget targets."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    dash_res = await client.post(
        f"/db/data-sources/{ds_id}/views", json={"type": "dashboard", "name": "Dash"}
    )
    assert dash_res.status_code == 201, dash_res.text
    dash_view = dash_res.json()

    widget_views = []
    for i in range(n_widget_views):
        v = await client.post(
            f"/db/data-sources/{ds_id}/views", json={"type": "table", "name": f"Widget {i}"}
        )
        assert v.status_code == 201, v.text
        widget_views.append(v.json())

    return created, dash_view, widget_views


def _widget(view_id: str, width: int = 6, widget_id: str = "w1") -> dict:
    return {"id": widget_id, "view_id": view_id, "width": width}


async def test_update_dashboard_view_accepts_config_at_the_limits_inclusive(client):
    # Exactly 4 widgets/row and exactly 12 total -- proves the limits are
    # inclusive boundaries ("up to 4"/"up to 12"), not off-by-one rejections.
    created, dash_view, widget_views = await _create_dashboard_and_widget_views(
        client, n_widget_views=12
    )
    rows = [
        {
            "id": f"row-{r}",
            "height": 300,
            "widgets": [
                _widget(widget_views[r * 4 + c]["id"], width=3, widget_id=f"w{r}-{c}")
                for c in range(4)
            ],
        }
        for r in range(3)
    ]

    res = await client.patch(f"/db/views/{dash_view['id']}", json={"config": {"rows": rows}})
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["config"]["rows"]) == 3
    assert sum(len(row["widgets"]) for row in body["config"]["rows"]) == 12


async def test_update_dashboard_view_rejects_more_than_4_widgets_in_one_row(client):
    created, dash_view, widget_views = await _create_dashboard_and_widget_views(
        client, n_widget_views=5
    )
    widgets = [_widget(v["id"], width=2, widget_id=f"w{i}") for i, v in enumerate(widget_views)]
    res = await client.patch(
        f"/db/views/{dash_view['id']}",
        json={"config": {"rows": [{"id": "row-1", "height": 300, "widgets": widgets}]}},
    )
    assert res.status_code == 400


async def test_update_dashboard_view_rejects_more_than_12_widgets_total(client):
    created, dash_view, widget_views = await _create_dashboard_and_widget_views(
        client, n_widget_views=13
    )
    # 4 + 4 + 4 + 1 = 13 widgets across 4 rows -- every row individually
    # respects the 4/row cap, only the 12-total cap is violated.
    counts = [4, 4, 4, 1]
    rows = []
    idx = 0
    for r, count in enumerate(counts):
        widgets = [
            _widget(widget_views[idx + c]["id"], width=3, widget_id=f"w{r}-{c}")
            for c in range(count)
        ]
        idx += count
        rows.append({"id": f"row-{r}", "height": 300, "widgets": widgets})

    res = await client.patch(f"/db/views/{dash_view['id']}", json={"config": {"rows": rows}})
    assert res.status_code == 400


async def test_update_dashboard_view_rejects_nonexistent_widget_view_id(client):
    created, dash_view, _ = await _create_dashboard_and_widget_views(client, n_widget_views=0)
    res = await client.patch(
        f"/db/views/{dash_view['id']}",
        json={
            "config": {
                "rows": [{"id": "row-1", "height": 300, "widgets": [_widget(str(uuid.uuid4()))]}]
            }
        },
    )
    assert res.status_code == 400


async def test_update_dashboard_view_rejects_widget_from_a_different_data_source(client):
    created, dash_view, _ = await _create_dashboard_and_widget_views(client, n_widget_views=0)
    other_db = await _create_database(client, "Other DB")
    other_ds_id = other_db["data_source"]["id"]
    other_view = await client.post(
        f"/db/data-sources/{other_ds_id}/views", json={"type": "table"}
    )
    assert other_view.status_code == 201, other_view.text
    other_view_id = other_view.json()["id"]

    res = await client.patch(
        f"/db/views/{dash_view['id']}",
        json={
            "config": {
                "rows": [{"id": "row-1", "height": 300, "widgets": [_widget(other_view_id)]}]
            }
        },
    )
    assert res.status_code == 400


async def test_update_dashboard_view_rejects_widget_from_a_different_user(client, db_conn):
    created, dash_view, _ = await _create_dashboard_and_widget_views(client, n_widget_views=0)
    ds_id = created["data_source"]["id"]

    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    # A view owned by another user, inserted directly into the SAME
    # data_source_id -- a "guess another user's view id in my own data
    # source" attempt, not merely "a view somewhere else".
    other_view_row = await db_conn.fetchrow(
        """
        INSERT INTO db_views (data_source_id, user_id, name, type)
        VALUES ($1, $2, 'Other users view', 'table')
        RETURNING id
        """,
        ds_id,
        other_user,
    )
    other_view_id = str(other_view_row["id"])

    res = await client.patch(
        f"/db/views/{dash_view['id']}",
        json={
            "config": {
                "rows": [{"id": "row-1", "height": 300, "widgets": [_widget(other_view_id)]}]
            }
        },
    )
    assert res.status_code == 400


async def test_update_dashboard_view_rejects_nested_dashboard_widget(client):
    created, dash_view, _ = await _create_dashboard_and_widget_views(client, n_widget_views=0)
    ds_id = created["data_source"]["id"]
    other_dash = await client.post(
        f"/db/data-sources/{ds_id}/views", json={"type": "dashboard", "name": "Dash 2"}
    )
    assert other_dash.status_code == 201, other_dash.text
    other_dash_id = other_dash.json()["id"]

    res = await client.patch(
        f"/db/views/{dash_view['id']}",
        json={
            "config": {
                "rows": [{"id": "row-1", "height": 300, "widgets": [_widget(other_dash_id)]}]
            }
        },
    )
    assert res.status_code == 400


async def test_update_dashboard_view_rejects_self_referencing_widget(client):
    # A dashboard widgetting itself is a special case of the nested-dashboard
    # rule -- the view being edited already has stored type="dashboard".
    created, dash_view, _ = await _create_dashboard_and_widget_views(client, n_widget_views=0)
    res = await client.patch(
        f"/db/views/{dash_view['id']}",
        json={
            "config": {
                "rows": [{"id": "row-1", "height": 300, "widgets": [_widget(dash_view["id"])]}]
            }
        },
    )
    assert res.status_code == 400


async def test_update_dashboard_view_rejects_widget_width_out_of_range(client):
    created, dash_view, widget_views = await _create_dashboard_and_widget_views(
        client, n_widget_views=1
    )
    for bad_width in (0, 13, -1):
        res = await client.patch(
            f"/db/views/{dash_view['id']}",
            json={
                "config": {
                    "rows": [
                        {
                            "id": "row-1",
                            "height": 300,
                            "widgets": [_widget(widget_views[0]["id"], width=bad_width)],
                        }
                    ]
                }
            },
        )
        assert res.status_code == 400, f"width {bad_width} should have been rejected"


async def test_update_non_dashboard_view_config_stays_an_unvalidated_pass_through(client):
    # Regression: a table view's config must NOT go through dashboard
    # validation -- an arbitrary shape with no rows/widgets at all must
    # still be accepted exactly as before this task.
    created = await _create_database(client)
    view_id = created["views"][0]["id"]  # the default table view
    res = await client.patch(
        f"/db/views/{view_id}", json={"config": {"frozen_column_index": 2}}
    )
    assert res.status_code == 200, res.text
    assert res.json()["config"] == {"frozen_column_index": 2}


# ---------------------------------------------------------------------------
# Tenancy guard: every generated query scopes on user_id.
# ---------------------------------------------------------------------------

_ROUTER_PATH = Path(__file__).resolve().parents[1] / "routers" / "databases.py"
_VIEWS_PATH = Path(__file__).resolve().parents[1] / "services" / "db" / "views.py"
_SQL_KEYWORDS = ("SELECT", "INSERT", "UPDATE", "DELETE")


def _extract_sql_statements(path: Path) -> list[str]:
    """Every triple-quoted string in `path` whose first token is a SQL
    keyword. This repo's convention (see both files) is to write every SQL
    statement as its own triple-quoted string, so this is a complete scan
    of the actual queries, not a sample — and checking the *first token*
    (rather than a substring anywhere in the block) is what keeps this
    from also matching prose docstrings that happen to contain a SQL
    keyword as a word fragment (e.g. "Deletes" contains "DELETE")."""
    src = path.read_text()
    blocks = re.findall(r'"""(.*?)"""', src, re.S)
    statements = []
    for b in blocks:
        stripped = b.strip()
        first_word = stripped.split(None, 1)[0].upper() if stripped else ""
        if first_word in _SQL_KEYWORDS:
            statements.append(b)
    return statements


# A real scope predicate, not just a mention: `user_id = $3` (or similar).
# INSERTs don't have a WHERE predicate at all — their tenancy guarantee is
# that they write user_id as a column value, so those are checked
# separately (a plain "is the word present" substring check, which is
# exactly right for a column list: `INSERT INTO t (user_id, ...) VALUES
# (...)`). A loose "user_id" substring check on every statement would also
# pass on a comment or a column-list mention with no actual WHERE
# predicate, which is what this is tightening (task-5 review, minor
# finding 1).
_SCOPE_PREDICATE_RE = re.compile(r"user_id\s*=\s*\$\d+")


def _assert_has_scope_predicate(stmt: str) -> None:
    first_word = stmt.strip().split(None, 1)[0].upper()
    if first_word == "INSERT":
        assert re.search(r"\buser_id\b", stmt), f"INSERT never mentions user_id:\n{stmt}"
        return
    assert _SCOPE_PREDICATE_RE.search(stmt), f"query missing a real user_id = $N predicate:\n{stmt}"


def test_every_query_in_databases_router_has_a_user_id_scope_predicate():
    statements = _extract_sql_statements(_ROUTER_PATH)
    # Milestone 7 (task-21) added the relation/sub-item/dependency endpoints'
    # own SQL (35 total statements at that point, up from 8) — the floor is
    # raised so this sweep can't silently go vacuous if those endpoints'
    # queries are ever refactored away from the router without a matching
    # drop in this floor (this exact failure mode is why the floor exists
    # at all, per the brief: "extend the floor; do not leave the new
    # handlers outside the sweep").
    assert len(statements) >= 30, "expected to find the router's SQL statements"
    for stmt in statements:
        _assert_has_scope_predicate(stmt)


def test_every_query_in_views_service_has_a_user_id_scope_predicate():
    statements = _extract_sql_statements(_VIEWS_PATH)
    assert len(statements) >= 2, "expected to find the views service's SQL statements"
    for stmt in statements:
        _assert_has_scope_predicate(stmt)


# ---------------------------------------------------------------------------
# GET /db/databases (list) -- added for the relation/rollup target pickers,
# which could not be built without a way to enumerate databases.
# ---------------------------------------------------------------------------


async def test_list_databases_returns_each_database_with_its_data_source(client):
    a = await _create_database(client, "Alpha")
    b = await _create_database(client, "Beta")

    res = await client.get("/db/databases")
    assert res.status_code == 200, res.text
    body = res.json()["databases"]

    by_id = {e["database"]["id"]: e for e in body}
    assert a["database"]["id"] in by_id
    assert b["database"]["id"] in by_id
    # Each entry carries the data source a picker needs to target.
    assert by_id[a["database"]["id"]]["data_source"]["id"] == a["data_source"]["id"]
    assert by_id[b["database"]["id"]]["data_source"]["id"] == b["data_source"]["id"]
    assert {e["database"]["title"] for e in body} >= {"Alpha", "Beta"}


async def test_list_databases_excludes_all_notes_and_soft_deleted(client, db_conn, test_user):
    created = await _create_database(client, "Gamma")
    db_id = created["database"]["id"]

    res = await client.get("/db/databases")
    assert db_id in {e["database"]["id"] for e in res.json()["databases"]}
    # The All Notes virtual source has no db_databases row and must never be
    # offered as a relation target (create_property rejects it outright).
    assert "all-notes" not in {e["database"]["id"] for e in res.json()["databases"]}

    await db_conn.execute(
        "UPDATE db_databases SET deleted_at = now() WHERE id = $1 AND user_id = $2",
        db_id,
        test_user,
    )
    res = await client.get("/db/databases")
    assert db_id not in {e["database"]["id"] for e in res.json()["databases"]}


# ===========================================================================
# Fix 4 (task-50, M14 combined review Important finding) -- `create_row`/
# `update_row_property` must actually trigger the Task 46 property-preamble
# reindex. Router-HTTP path (the other of the 2 call sites the brief names
# explicitly -- `services/agent/brain_tools.py`'s agent-tool path is covered
# in `test_brain_tools_db.py`). Mocking convention follows
# `tests/test_indexer.py`'s own `_db()` helper (same per-test-file
# duplication that file's docstring documents): `get_supabase()` is
# `index_note`'s only dependency besides the embedder, and MagicMock chains
# ignore whatever note_id/user_id they're actually filtered on.
# ===========================================================================


def _preamble_fake_supabase(*, ds_id, row_properties, prop_defs, notes_title="Untitled"):
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


async def test_update_row_property_triggers_property_preamble_reindex(client, db_conn, test_user):
    """Fix 4.2: `update_row_property` must call `try_index_note` after
    `update_row_property_core` succeeds -- editing a property cell is the
    entire point of spec §12 item 1 ("a query like 'what's blocked on the
    compiler' can match on property values"), and pre-fix, NOTHING on this
    path ever called `index_note`. Asserts the exact rendered preamble
    Task 46 built lands as `note_chunks` chunk 0 for this real row, via the
    real HTTP PATCH endpoint end-to-end."""
    from unittest.mock import patch

    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Notes", "type": "rich_text"}
        )
    ).json()
    row = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()
    note_id = row["id"]

    fake_db = _preamble_fake_supabase(
        ds_id=ds_id,
        row_properties={prop["key"]: {"type": "rich_text", "rich_text": "hello world"}},
        prop_defs=[{"key": prop["key"], "name": "Notes", "type": "rich_text", "position": 0, "config": {}}],
    )

    with (
        patch("services.indexer.get_supabase", return_value=fake_db),
        patch("services.indexer.embed_batch", side_effect=lambda texts: [[0.0]] * len(texts)),
        patch("services.indexer.embed", return_value=[0.0]),
        patch("services.indexer.generate_descriptor", return_value="d"),
    ):
        res = await client.patch(
            f"/db/data-sources/{ds_id}/rows/{note_id}",
            json={"property_key": prop["key"], "value": {"type": "rich_text", "rich_text": "hello world"}},
        )
    assert res.status_code == 200, res.text

    insert_call = fake_db.tables["note_chunks"].insert.call_args
    assert insert_call is not None, "note_chunks.insert was never called -- index_note was never invoked"
    rows = insert_call[0][0]
    assert len(rows) == 1  # no body blocks -- only the preamble chunk
    assert rows[0]["chunk_index"] == 0
    assert rows[0]["chunk_text"] == "Notes: hello world"
    assert rows[0]["block_id"] == "__property_preamble__"
    assert rows[0]["note_id"] == note_id


async def test_update_row_property_succeeds_even_if_indexing_fails(client, db_conn, test_user):
    """Fix 4's own required regression guard: `try_index_note` is best-
    effort/non-fatal -- a flaky/down embedder must never turn a successful
    property write into a 500."""
    from unittest.mock import patch

    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Notes", "type": "rich_text"}
        )
    ).json()
    row = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()
    note_id = row["id"]

    with patch("services.indexer.index_note", side_effect=RuntimeError("embedder down")):
        res = await client.patch(
            f"/db/data-sources/{ds_id}/rows/{note_id}",
            json={"property_key": prop["key"], "value": {"type": "rich_text", "rich_text": "still works"}},
        )

    assert res.status_code == 200, res.text
    assert res.json()["properties"][prop["key"]] == {"type": "rich_text", "rich_text": "still works"}


# ---------------------------------------------------------------------------
# Phase 0b — the four endpoints the UI-parity work is gated on.
#
# Each of these existed as a gap flagged from a live capture, not as a
# speculative API: a database could never be renamed, a view could never be
# deleted, and a property's description could never be written even though the
# column and the response field had been there since migration 014.
# ---------------------------------------------------------------------------


async def test_update_database_sets_title_icon_and_description(client):
    created = await _create_database(client)
    db_id = created["database"]["id"]

    res = await client.patch(
        f"/db/databases/{db_id}",
        json={
            "title": "Renamed",
            "icon": "🚀",
            "description": [{"type": "text", "text": "what this is for"}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["title"] == "Renamed"
    assert body["icon"] == "🚀"
    assert body["description"] == [{"type": "text", "text": "what this is for"}]

    # and it round-trips through the read path, not just the RETURNING
    fetched = (await client.get(f"/db/databases/{db_id}")).json()
    assert fetched["database"]["title"] == "Renamed"


async def test_update_database_is_partial_and_leaves_untouched_fields_alone(client):
    created = await _create_database(client, title="Keep me")
    db_id = created["database"]["id"]

    await client.patch(f"/db/databases/{db_id}", json={"icon": "📊"})
    body = (await client.patch(f"/db/databases/{db_id}", json={"is_locked": True})).json()

    assert body["title"] == "Keep me"
    assert body["icon"] == "📊"
    assert body["is_locked"] is True


async def test_update_database_null_clears_icon_but_is_dropped_for_title(client):
    created = await _create_database(client, title="Original")
    db_id = created["database"]["id"]
    await client.patch(f"/db/databases/{db_id}", json={"icon": "📊"})

    # icon is nullable -> an explicit null CLEARS it (that is how a user
    # removes an icon).
    cleared = (await client.patch(f"/db/databases/{db_id}", json={"icon": None})).json()
    assert cleared["icon"] is None

    # title is NOT NULL -> a null must be dropped, not raise a
    # NotNullViolationError, and the rest of the same request still applies.
    body = (
        await client.patch(f"/db/databases/{db_id}", json={"title": None, "icon": "🔥"})
    ).json()
    assert body["title"] == "Original"
    assert body["icon"] == "🔥"


async def test_update_database_404s_for_another_users_database(client, db_conn):
    created = await _create_database(client)

    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    app.dependency_overrides[get_user_id] = lambda: other_user

    res = await client.patch(
        f"/db/databases/{created['database']['id']}", json={"title": "mine now"}
    )
    assert res.status_code == 404


async def test_delete_database_is_soft_and_hides_it_from_reads(client, db_conn):
    created = await _create_database(client)
    db_id = created["database"]["id"]

    res = await client.delete(f"/db/databases/{db_id}")
    assert res.status_code == 204

    # Soft, not hard: the row survives with deleted_at set...
    row = await db_conn.fetchrow("SELECT deleted_at FROM db_databases WHERE id = $1", db_id)
    assert row is not None
    assert row["deleted_at"] is not None

    # ...but every read path filters it out.
    assert (await client.get(f"/db/databases/{db_id}")).status_code == 404
    listed = (await client.get("/db/databases")).json()["databases"]
    assert all(d["database"]["id"] != db_id for d in listed)


async def test_delete_database_does_not_trash_its_rows(client, db_conn):
    """A row is a `notes` row with its own trash. Cascading into notes from
    here would delete content that is reachable and restorable elsewhere."""
    created = await _create_database(client)
    db_id = created["database"]["id"]
    ds_id = created["data_source"]["id"]

    row = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()

    await client.delete(f"/db/databases/{db_id}")

    note = await db_conn.fetchrow("SELECT deleted_at FROM notes WHERE id = $1", row["id"])
    assert note is not None
    assert note["deleted_at"] is None


async def test_delete_database_twice_404s_rather_than_silently_succeeding(client):
    created = await _create_database(client)
    db_id = created["database"]["id"]

    assert (await client.delete(f"/db/databases/{db_id}")).status_code == 204
    assert (await client.delete(f"/db/databases/{db_id}")).status_code == 404


async def test_patching_a_trashed_database_404s_rather_than_resurrecting_it(client):
    created = await _create_database(client)
    db_id = created["database"]["id"]
    await client.delete(f"/db/databases/{db_id}")

    res = await client.patch(f"/db/databases/{db_id}", json={"title": "back from the dead"})
    assert res.status_code == 404


async def test_delete_view_removes_it_once_a_second_view_exists(client, db_conn):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    first_view = created["views"][0]["id"]

    second = (
        await client.post(f"/db/data-sources/{ds_id}/views", json={"name": "Board", "type": "board"})
    ).json()

    res = await client.delete(f"/db/views/{second['id']}")
    assert res.status_code == 204

    remaining = await db_conn.fetch("SELECT id FROM db_views WHERE data_source_id = $1", ds_id)
    assert [str(r["id"]) for r in remaining] == [first_view]


async def test_cannot_delete_the_only_view(client):
    """Captured from live Notion: a database with one view has no "Delete
    view" row at all, and it appears only once a second view exists. A data
    source with zero views has nothing to render and useDatabaseView's
    `views[0]` fallback would be undefined."""
    created = await _create_database(client)
    only_view = created["views"][0]["id"]

    res = await client.delete(f"/db/views/{only_view}")
    assert res.status_code == 400
    assert "only view" in res.json()["detail"]


async def test_delete_view_404s_for_unknown_and_for_another_users_view(client, db_conn):
    assert (await client.delete(f"/db/views/{uuid.uuid4()}")).status_code == 404

    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    second = (
        await client.post(f"/db/data-sources/{ds_id}/views", json={"name": "Board", "type": "board"})
    ).json()

    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    app.dependency_overrides[get_user_id] = lambda: other_user

    # Scoped by user_id, so another user cannot delete it — and must not be
    # able to tell whether it exists, hence 404 rather than 403.
    assert (await client.delete(f"/db/views/{second['id']}")).status_code == 404


async def test_property_description_can_be_written_and_cleared(client):
    """The column and the response field have existed since migration 014,
    but PropertyUpdate could never write it. Notion reaches this through the
    `ⓘ` beside a property name, tooltip "Add property description"."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Owner", "type": "rich_text"}
        )
    ).json()
    assert prop["description"] is None

    written = (
        await client.patch(
            f"/db/properties/{prop['id']}", json={"description": "Who is accountable"}
        )
    ).json()
    assert written["description"] == "Who is accountable"

    # An explicit null CLEARS it — COALESCE could not express this, which is
    # why the endpoint checks model_fields_set instead.
    cleared = (
        await client.patch(f"/db/properties/{prop['id']}", json={"description": None})
    ).json()
    assert cleared["description"] is None


async def test_property_description_is_untouched_by_an_unrelated_patch(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Owner", "type": "rich_text"}
        )
    ).json()
    await client.patch(f"/db/properties/{prop['id']}", json={"description": "keep me"})

    renamed = (await client.patch(f"/db/properties/{prop['id']}", json={"name": "Lead"})).json()
    assert renamed["name"] == "Lead"
    assert renamed["description"] == "keep me"


async def test_changing_a_property_type_converts_every_stored_value(client, db_conn):
    """A type change is not a column write. Values are §3.3 wrappers and
    rows.py rejects a wrapper whose tag does not match the property, so
    leaving them would invalidate every row."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Stage", "type": "select"}
        )
    ).json()
    key = prop["key"]

    row = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()
    await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row['id']}",
        json={"property_key": key, "value": {"type": "select", "select": "Done"}},
    )

    res = await client.patch(f"/db/properties/{prop['id']}", json={"type": "multi_select"})
    assert res.status_code == 200, res.text
    assert res.json()["type"] == "multi_select"

    stored = await db_conn.fetchval(
        "SELECT properties FROM db_row_props WHERE note_id = $1", row["id"]
    )
    assert stored[key] == {"type": "multi_select", "multi_select": ["Done"]}


async def test_illegal_type_change_400s_and_changes_nothing(client, db_conn):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Notes", "type": "rich_text"}
        )
    ).json()

    res = await client.patch(f"/db/properties/{prop['id']}", json={"type": "relation"})
    assert res.status_code == 400
    assert "relation" in res.json()["detail"]

    # The refusal must be total — no half-applied rename, no changed type.
    after = await db_conn.fetchrow(
        "SELECT type, name FROM db_properties WHERE id = $1", prop["id"]
    )
    assert after["type"] == "rich_text"
    assert after["name"] == "Notes"


async def test_type_change_drops_the_old_config_unless_a_new_one_is_supplied(client, db_conn):
    """A select's options mean nothing to a number."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Stage", "type": "select"}
        )
    ).json()
    await db_conn.execute(
        "UPDATE db_properties SET config = $1 WHERE id = $2",
        {"options": [{"name": "Done", "color": "green"}]},
        prop["id"],
    )

    body = (await client.patch(f"/db/properties/{prop['id']}", json={"type": "rich_text"})).json()
    assert body["config"] == {}


async def test_type_change_that_cannot_coerce_a_value_drops_that_key(client, db_conn):
    """Converting a column of mixed notes to Number must not fail because one
    row says "about ten" — that row simply empties."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Amount", "type": "rich_text"}
        )
    ).json()
    key = prop["key"]

    numeric = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()
    wordy = (await client.post(f"/db/data-sources/{ds_id}/rows")).json()
    for note_id, text in ((numeric["id"], "12"), (wordy["id"], "about ten")):
        await client.patch(
            f"/db/data-sources/{ds_id}/rows/{note_id}",
            json={"property_key": key, "value": {"type": "rich_text", "rich_text": text}},
        )

    assert (
        await client.patch(f"/db/properties/{prop['id']}", json={"type": "number"})
    ).status_code == 200

    kept = await db_conn.fetchval(
        "SELECT properties FROM db_row_props WHERE note_id = $1", numeric["id"]
    )
    dropped = await db_conn.fetchval(
        "SELECT properties FROM db_row_props WHERE note_id = $1", wordy["id"]
    )
    assert kept[key] == {"type": "number", "number": 12}
    # Dropped, not blanked: an absent key and an empty wrapper are different
    # states elsewhere in this codebase.
    assert key not in dropped


async def test_setting_the_same_type_is_a_no_op_not_a_conversion(client, db_conn):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Stage", "type": "select"}
        )
    ).json()
    await db_conn.execute(
        "UPDATE db_properties SET config = $1 WHERE id = $2", {"options": []}, prop["id"]
    )

    body = (await client.patch(f"/db/properties/{prop['id']}", json={"type": "select"})).json()
    # config survives, because nothing actually changed
    assert body["config"] == {"options": []}


async def test_property_response_carries_its_legal_conversion_targets(client):
    """The UI greys illegal "Change type" rows against this, so it must come
    from the same source of truth the PATCH enforces — not a second copy in
    the front end that can drift."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    select = (
        await client.post(
            f"/db/data-sources/{ds_id}/properties", json={"name": "Stage", "type": "select"}
        )
    ).json()
    assert "multi_select" in select["convertible_to"]
    assert "status" in select["convertible_to"]
    assert "relation" not in select["convertible_to"]
    assert "select" not in select["convertible_to"]  # never lists itself

    # And it agrees with what the endpoint actually allows.
    assert (
        await client.patch(f"/db/properties/{select['id']}", json={"type": "multi_select"})
    ).status_code == 200
