"""Tests for `routers/internal.py`'s 5 new `/internal/db/*` routes (Milestone 14,
task 49's MCP mirror) -- Fix 5 (task-50, M14 combined review Important finding).

Before this task, `tests/test_mcp_server.py` mocked `httpx` and proved only that the MCP
*client* calls the right URL -- nothing exercised these route handlers themselves. This is
the highest-stakes new surface in the milestone (a single `x-internal-key` header is a
WRITE primitive against a `user_id` supplied in the request body, no per-request JWT at
this layer), and it shipped with zero direct coverage.

Uses FastAPI's `TestClient`-equivalent (`httpx.AsyncClient` + `ASGITransport`, the same
pattern every other `test_*_router.py` file in this repo already establishes for its own
router -- see `tests/test_databases_router.py`'s `client` fixture) against the real app,
with a real `x-internal-key` header (no JWT here -- `user_id` is explicit in the body,
the same trust model this router's 3 pre-existing routes already use).

These 5 routes call `get_pool()` directly (not a FastAPI `Depends`), so `patched_pool`
below patches `routers.internal.get_pool` the same way `test_brain_tools_db.py`'s own
`patched_pool` patches `services.agent.brain_tools.get_pool` -- runs against the local
pgtest harness through the transaction-wrapped `db_conn`/`test_user` fixtures
(`tests/conftest.py`), rolled back on teardown. NEVER touches
`core.config.settings.database_url` (the real Supabase project).
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
import pytest_asyncio

from core.config import settings
from main import app

pytestmark = pytest.mark.asyncio

TEST_INTERNAL_KEY = "test-internal-key-task-50"


@pytest.fixture(autouse=True)
def _internal_key(monkeypatch):
    """Swap in a known key for the duration of each test (monkeypatch reverts it
    automatically) -- never assume/depend on whatever real key this environment's
    `.env` actually sets."""
    monkeypatch.setattr(settings, "internal_api_key", TEST_INTERNAL_KEY)


def _fake_pool(conn) -> MagicMock:
    """Same fake-pool shape `test_brain_tools_db.py`'s own `_fake_pool()` uses."""
    pool = MagicMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=conn)
    cm.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=cm)
    return pool


@pytest_asyncio.fixture
async def patched_pool(db_conn):
    fake_pool = _fake_pool(db_conn)
    with patch("routers.internal.get_pool", AsyncMock(return_value=fake_pool)):
        yield db_conn


@pytest_asyncio.fixture
async def client():
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


# ===========================================================================
# Helpers (duplicated from test_brain_tools_db.py's own precedent of small,
# per-test-file helper duplication rather than a shared cross-file import).
# ===========================================================================


async def _make_data_source(db_conn, user_id, *, name="DS", title="T") -> str:
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, $2) RETURNING id",
        user_id, title,
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, $3) RETURNING id",
        db_row["id"], user_id, name,
    )
    return str(ds_row["id"])


async def _insert_property(
    db_conn, user_id, data_source_id, key, name, type_, *, config=None,
) -> str:
    await db_conn.execute(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type, config)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        data_source_id, user_id, key, name, type_, config or {},
    )
    return key


async def _make_row(db_conn, user_id, data_source_id, *, title="Row", properties=None) -> str:
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id", user_id, title
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, $4)",
        note["id"], data_source_id, user_id, properties or {},
    )
    return str(note["id"])


async def _other_user(db_conn) -> str:
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    return other_user


# ===========================================================================
# /internal/db/list_databases
# ===========================================================================


async def test_list_databases_missing_key_is_422(client):
    res = await client.post("/internal/db/list_databases", json={"user_id": "u1"})
    assert res.status_code == 422


async def test_list_databases_wrong_key_is_403(client):
    res = await client.post(
        "/internal/db/list_databases",
        json={"user_id": "u1"},
        headers={"x-internal-key": "wrong-key"},
    )
    assert res.status_code == 403


async def test_list_databases_correct_key_and_owner_returns_real_data(
    patched_pool, db_conn, test_user
):
    ds_id = await _make_data_source(db_conn, test_user, title="Mine")

    res = await client_post_internal(
        db_conn, "/internal/db/list_databases", {"user_id": test_user}
    )
    assert res.status_code == 200, res.text
    titles = [e["database"]["title"] for e in res.json()["databases"]]
    assert "Mine" in titles
    mine = next(e for e in res.json()["databases"] if e["database"]["title"] == "Mine")
    assert mine["data_source"]["id"] == ds_id


# ===========================================================================
# /internal/db/get_database_schema
# ===========================================================================


async def test_get_database_schema_missing_key_is_422(client):
    res = await client.post(
        "/internal/db/get_database_schema",
        json={"database_id": str(uuid.uuid4()), "user_id": "u1"},
    )
    assert res.status_code == 422


async def test_get_database_schema_wrong_key_is_403(client):
    res = await client.post(
        "/internal/db/get_database_schema",
        json={"database_id": str(uuid.uuid4()), "user_id": "u1"},
        headers={"x-internal-key": "wrong-key"},
    )
    assert res.status_code == 403


async def test_get_database_schema_rejects_a_database_the_body_user_does_not_own(
    patched_pool, db_conn, test_user
):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    db_id = str(await db_conn.fetchval(
        "SELECT database_id FROM db_data_sources WHERE id = $1", ds_id
    ))

    res = await client_post_internal(
        db_conn, "/internal/db/get_database_schema",
        {"database_id": db_id, "user_id": test_user},
    )
    # `get_database`'s own tenancy check -- checked, not assumed: it 404s.
    assert res.status_code == 404


async def test_get_database_schema_correct_key_and_owner_returns_real_data(
    patched_pool, db_conn, test_user
):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "num1", "Score", "number")
    db_id = str(await db_conn.fetchval(
        "SELECT database_id FROM db_data_sources WHERE id = $1", ds_id
    ))

    res = await client_post_internal(
        db_conn, "/internal/db/get_database_schema",
        {"database_id": db_id, "user_id": test_user},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["data_source"]["id"] == ds_id
    assert "num1" in [p["key"] for p in body["properties"]]


# ===========================================================================
# /internal/db/query_database
# ===========================================================================


async def test_query_database_missing_key_is_422(client):
    res = await client.post(
        "/internal/db/query_database",
        json={"data_source_id": str(uuid.uuid4()), "user_id": "u1"},
    )
    assert res.status_code == 422


async def test_query_database_wrong_key_is_403(client):
    res = await client.post(
        "/internal/db/query_database",
        json={"data_source_id": str(uuid.uuid4()), "user_id": "u1"},
        headers={"x-internal-key": "wrong-key"},
    )
    assert res.status_code == 403


async def test_query_database_rejects_a_data_source_the_body_user_does_not_own(
    patched_pool, db_conn, test_user
):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    await _insert_property(db_conn, other_user, ds_id, "num1", "Score", "number")
    await _make_row(db_conn, other_user, ds_id, properties={"num1": {"type": "number", "number": 1}})

    res = await client_post_internal(
        db_conn, "/internal/db/query_database",
        {"data_source_id": ds_id, "user_id": test_user},
    )
    assert res.status_code == 404


async def test_query_database_correct_key_and_owner_returns_real_rows(
    patched_pool, db_conn, test_user
):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "num1", "Score", "number")
    row_id = await _make_row(
        db_conn, test_user, ds_id, properties={"num1": {"type": "number", "number": 42}}
    )

    res = await client_post_internal(
        db_conn, "/internal/db/query_database",
        {"data_source_id": ds_id, "user_id": test_user},
    )
    assert res.status_code == 200, res.text
    ids = [r["id"] for r in res.json()["rows"]]
    assert ids == [row_id]

    # Cross-checked against a direct DB query, per the brief's own requirement.
    db_value = await db_conn.fetchval(
        "SELECT properties -> 'num1' ->> 'number' FROM db_row_props WHERE note_id = $1",
        uuid.UUID(row_id),
    )
    assert db_value == "42"


# ===========================================================================
# /internal/db/create_row
# ===========================================================================


async def test_create_row_missing_key_is_422(client):
    res = await client.post(
        "/internal/db/create_row",
        json={"data_source_id": str(uuid.uuid4()), "user_id": "u1", "properties": {}},
    )
    assert res.status_code == 422


async def test_create_row_wrong_key_is_403(client):
    res = await client.post(
        "/internal/db/create_row",
        json={"data_source_id": str(uuid.uuid4()), "user_id": "u1", "properties": {}},
        headers={"x-internal-key": "wrong-key"},
    )
    assert res.status_code == 403


async def test_create_row_rejects_a_data_source_the_body_user_does_not_own(
    patched_pool, db_conn, test_user
):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)

    res = await client_post_internal(
        db_conn, "/internal/db/create_row",
        {"data_source_id": ds_id, "user_id": test_user, "properties": {}},
    )
    assert res.status_code == 404


async def test_create_row_correct_key_and_owner_creates_a_real_row(
    patched_pool, db_conn, test_user
):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "num1", "Score", "number")

    res = await client_post_internal(
        db_conn, "/internal/db/create_row",
        {"data_source_id": ds_id, "user_id": test_user, "properties": {"num1": 7}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["properties"]["num1"] == {"type": "number", "number": 7}

    # Cross-checked against a direct DB query.
    db_value = await db_conn.fetchval(
        "SELECT properties -> 'num1' ->> 'number' FROM db_row_props WHERE note_id = $1",
        uuid.UUID(body["id"]),
    )
    assert db_value == "7"


async def test_create_row_with_a_non_str_title_is_a_clean_400_not_a_500(
    patched_pool, db_conn, test_user
):
    """Fix 1 x Fix 5: this is the exact gap the reviewer flagged --
    `/internal/db/create_row` has no `except Exception` catch-all the way
    `engine.py`'s in-app agent loop does, so before Fix 1, a non-str title
    sailed past `coerce_property_write` (no validation for `title`) and
    crashed `create_row_core` with a raw `asyncpg.exceptions.DataError`
    (binding a non-str value to `notes.title`, a `text` column), unhandled
    here. With Fix 1 in place, `coerce_property_write` itself raises
    `ValueError` first, which this route already converts to a 400."""
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "ttl1", "Name", "title")

    res = await client_post_internal(
        db_conn, "/internal/db/create_row",
        {"data_source_id": ds_id, "user_id": test_user, "properties": {"ttl1": 12345}},
    )
    assert res.status_code == 400
    assert res.status_code != 500
    assert "title" in res.json()["detail"]

    count = await db_conn.fetchval(
        "SELECT count(*) FROM db_row_props WHERE data_source_id = $1", uuid.UUID(ds_id)
    )
    assert count == 0


async def test_create_row_rejects_an_oversized_number_with_400_not_500(
    patched_pool, db_conn, test_user
):
    """Fix 2 (task-51, M14 final cross-cutting review): a too-large Python int
    (unbounded, e.g. a 400+-digit literal) sails past a bare `isinstance(raw,
    (int, float))` check, then previously crashed with an unhandled
    `OverflowError` (not a `ValueError`, so no existing catch here covered it)
    the moment `create_row_core`'s own `recompute_row` call decoded it back
    (`services/db/recompute.py`'s `_decode_stored`, run on EVERY row write).
    Now guarded in `Number.coerce_write` itself (`services/db/properties/
    scalar.py`), reached here via `coerce_property_write`."""
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "num1", "Score", "number")

    huge = int("1" + "0" * 400)
    res = await client_post_internal(
        db_conn, "/internal/db/create_row",
        {"data_source_id": ds_id, "user_id": test_user, "properties": {"num1": huge}},
    )
    assert res.status_code == 400, res.text
    assert "out of range" in res.json()["detail"]

    count = await db_conn.fetchval(
        "SELECT count(*) FROM db_row_props WHERE data_source_id = $1", uuid.UUID(ds_id)
    )
    assert count == 0


# ===========================================================================
# /internal/db/update_row
# ===========================================================================


async def test_update_row_missing_key_is_422(client):
    res = await client.post(
        "/internal/db/update_row",
        json={
            "data_source_id": str(uuid.uuid4()), "user_id": "u1",
            "note_id": str(uuid.uuid4()), "property_key": "k", "value": 1,
        },
    )
    assert res.status_code == 422


async def test_update_row_wrong_key_is_403(client):
    res = await client.post(
        "/internal/db/update_row",
        json={
            "data_source_id": str(uuid.uuid4()), "user_id": "u1",
            "note_id": str(uuid.uuid4()), "property_key": "k", "value": 1,
        },
        headers={"x-internal-key": "wrong-key"},
    )
    assert res.status_code == 403


async def test_update_row_rejects_a_data_source_the_body_user_does_not_own(
    patched_pool, db_conn, test_user
):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    row_id = await _make_row(db_conn, other_user, ds_id)

    res = await client_post_internal(
        db_conn, "/internal/db/update_row",
        {
            "data_source_id": ds_id, "user_id": test_user,
            "note_id": row_id, "property_key": "nope", "value": 1,
        },
    )
    assert res.status_code == 404


async def test_update_row_correct_key_and_owner_updates_a_real_row(
    patched_pool, db_conn, test_user
):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "ttl1", "Name", "title")
    row_id = await _make_row(db_conn, test_user, ds_id)

    res = await client_post_internal(
        db_conn, "/internal/db/update_row",
        {
            "data_source_id": ds_id, "user_id": test_user,
            "note_id": row_id, "property_key": "ttl1", "value": "New Title",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["properties"]["ttl1"] == {"type": "title", "title": "New Title"}

    # Cross-checked against a direct DB query -- title sync too (same core
    # function the HTTP PATCH endpoint calls).
    note_title = await db_conn.fetchval(
        "SELECT title FROM notes WHERE id = $1", uuid.UUID(row_id)
    )
    assert note_title == "New Title"


async def test_update_row_with_a_non_str_title_is_a_clean_400_not_a_500(
    patched_pool, db_conn, test_user
):
    """Fix 1 x Fix 5, update_row's half of the exact gap the reviewer flagged --
    a non-str title reaching `update_row_property_core` crashes the same way
    on the `notes.title` sync (`asyncpg.exceptions.DataError`), unhandled
    here pre-Fix-1."""
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "ttl1", "Name", "title")
    row_id = await _make_row(db_conn, test_user, ds_id)

    res = await client_post_internal(
        db_conn, "/internal/db/update_row",
        {
            "data_source_id": ds_id, "user_id": test_user,
            "note_id": row_id, "property_key": "ttl1", "value": 12345,
        },
    )
    assert res.status_code == 400
    assert res.status_code != 500
    assert "title" in res.json()["detail"]

    row = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", uuid.UUID(row_id)
    )
    assert "ttl1" not in (row["properties"] or {})


# ===========================================================================
# Small helper: every "correct key" test above needs BOTH `patched_pool`
# (so the route's own `get_pool()` call resolves to `db_conn`) and a real
# HTTP round-trip through the ASGI app (so `_check_internal_key`/FastAPI's
# own Header()-required validation genuinely run) -- httpx.AsyncClient
# can't be a fixture parameter of a plain helper function, so this builds
# one per call rather than depending on the `client` fixture (which isn't
# requested by the "correct key" tests, keeping their fixture list to just
# `patched_pool, db_conn, test_user`).
# ===========================================================================


async def client_post_internal(db_conn, path: str, json_body: dict) -> httpx.Response:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        return await c.post(path, json=json_body, headers={"x-internal-key": TEST_INTERNAL_KEY})
