"""Tests for `GET /db/notes/{note_id}/row` — the RowPeek follow-up: lets a
standalone note page (`/brain/{noteId}`, which only ever has a bare note id) discover
whether the note it's showing is a database row and, if so, fetch its property
schema + current values.

Runs against the local pgtest harness through the same transaction-wrapped `db_conn`/
`test_user` fixtures (`tests/conftest.py`) and `client`-fixture-building convention
`tests/test_databases_router.py`/`tests/test_db_csv_export.py` already established —
reused verbatim, not duplicated with a different shape. NEVER touches
`core.config.settings.database_url` (the real Supabase project) — no code path here
can reach it.
"""
from __future__ import annotations

import uuid

import httpx
import pytest_asyncio

from main import app
from routers.notes import get_user_id
from services.db.connection import get_conn


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


async def _create_property(
    client: httpx.AsyncClient, ds_id: str, name: str, type_: str, config: dict | None = None
) -> dict:
    res = await client.post(
        f"/db/data-sources/{ds_id}/properties",
        json={"name": name, "type": type_, "config": config or {}},
    )
    assert res.status_code == 201, res.text
    return res.json()


async def _insert_row(db_conn, user_id: str, ds_id: str, properties: dict, *, title="Row") -> str:
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id", user_id, title
    )
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
        VALUES ($1, $2, $3, $4)
        """,
        note["id"], ds_id, user_id, properties,
    )
    return str(note["id"])


async def test_returns_schema_and_values_for_a_real_database_row(client, db_conn, test_user):
    created = await _create_database(client, "Tasks")
    ds_id = created["data_source"]["id"]
    title_key = created["properties"][0]["key"]
    status_prop = await _create_property(client, ds_id, "Status", "status")

    row_id = await _insert_row(
        db_conn,
        test_user,
        ds_id,
        {
            title_key: {"type": "title", "title": "Write the report"},
            status_prop["key"]: {"type": "status", "status": "todo"},
        },
        title="Write the report",
    )

    res = await client.get(f"/db/notes/{row_id}/row")
    assert res.status_code == 200, res.text
    body = res.json()

    assert body["data_source_id"] == ds_id
    assert body["database_id"] == created["database"]["id"]
    assert body["database_title"] == "Tasks"
    assert {p["key"] for p in body["properties"]} == {title_key, status_prop["key"]}
    assert body["values"][title_key] == {"type": "title", "title": "Write the report"}
    assert body["values"][status_prop["key"]] == {"type": "status", "status": "todo"}


async def test_properties_are_returned_in_position_order(client, db_conn, test_user):
    created = await _create_database(client, "Tasks")
    ds_id = created["data_source"]["id"]
    p_b = await _create_property(client, ds_id, "B", "rich_text")
    p_a = await _create_property(client, ds_id, "A", "rich_text")
    row_id = await _insert_row(db_conn, test_user, ds_id, {})

    res = await client.get(f"/db/notes/{row_id}/row")
    assert res.status_code == 200, res.text
    keys_in_order = [p["key"] for p in res.json()["properties"]]
    title_key = created["properties"][0]["key"]
    assert keys_in_order == [title_key, p_b["key"], p_a["key"]]


async def test_404s_for_an_ordinary_non_database_note(client, db_conn, test_user):
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Just a note') RETURNING id", test_user
    )
    res = await client.get(f"/db/notes/{note['id']}/row")
    assert res.status_code == 404


async def test_404s_for_a_note_id_that_does_not_exist(client):
    res = await client.get(f"/db/notes/{uuid.uuid4()}/row")
    assert res.status_code == 404


async def test_404s_for_a_row_belonging_to_another_user_mutation_tested(client, db_conn, test_user):
    """Cross-tenant: a row that exists but belongs to a different user 404s, not a
    silent cross-tenant leak. Mutation-tested by hand against the endpoint's own code
    (not just asserted here): temporarily stripped `AND user_id = $2` from the first
    query (the `db_row_props` lookup) — the request still 404'd, because the SECOND
    query (`ds.user_id = $2` on the `db_data_sources` join) independently re-enforces
    the same tenancy boundary. Genuine defense in depth, not a single point of
    failure — confirmed by reading both queries, not assumed. The check below proves
    the row genuinely exists (so the 404 is really tenancy, not a not-found accident)
    without needing to break the endpoint's own code to prove it."""
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    other_db = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'Theirs') RETURNING id", other_user
    )
    other_ds = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, 'Default') RETURNING id",
        other_db["id"], other_user,
    )
    other_row_id = await _insert_row(db_conn, other_user, str(other_ds["id"]), {})

    res = await client.get(f"/db/notes/{other_row_id}/row")
    assert res.status_code == 404

    unscoped = await db_conn.fetchrow(
        "SELECT data_source_id FROM db_row_props WHERE note_id = $1", uuid.UUID(other_row_id)
    )
    assert unscoped is not None
    assert str(unscoped["data_source_id"]) == str(other_ds["id"])


async def test_formula_and_rollup_values_are_merged_from_computed(client, db_conn, test_user):
    """`db_row_props.computed` (formula/rollup materialised results) must be merged
    into `values`, not just the raw `properties` JSONB — otherwise a formula column
    would always come back empty even when it has a real computed value, the exact
    bug class Task 48's CSV export shipped with and later had to fix."""
    created = await _create_database(client, "Tasks")
    ds_id = created["data_source"]["id"]
    formula_prop = await _create_property(
        client, ds_id, "Doubled", "formula", config={"expression": "1"}
    )
    row_id = await _insert_row(db_conn, test_user, ds_id, {})
    await db_conn.execute(
        "UPDATE db_row_props SET computed = $1 WHERE note_id = $2",
        {formula_prop["key"]: {"type": "number", "number": 42.0}},
        uuid.UUID(row_id),
    )

    res = await client.get(f"/db/notes/{row_id}/row")
    assert res.status_code == 200, res.text
    assert res.json()["values"][formula_prop["key"]] == {"type": "number", "number": 42.0}
