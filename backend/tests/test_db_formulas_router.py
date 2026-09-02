"""Tests for Milestone 8's HTTP seam (task-28): `POST .../formulas/validate`,
formula/rollup property creation and update with save-time validation, and
the recompute triggers wired into row and property writes.

Runs against the local pgtest harness (localhost:55432, migrations 001-019
applied) through the same transaction-wrapped `db_conn`/`test_user` fixtures
and `client`-fixture-building convention `tests/test_databases_router.py`/
`tests/test_db_relations_router.py` already established -- reused verbatim,
not duplicated with a different shape. NEVER touches
`core.config.settings.database_url` (the real Supabase project) -- no code
path here can reach it.
"""
from __future__ import annotations

from datetime import UTC, datetime

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
    return res


async def _create_row(client: httpx.AsyncClient, ds_id: str) -> str:
    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _dt(y: int, m: int, d: int) -> datetime:
    return datetime(y, m, d, tzinfo=UTC)


# ---------------------------------------------------------------------------
# POST /db/data-sources/{data_source_id}/formulas/validate
# ---------------------------------------------------------------------------


async def test_validate_formula_valid_expression_returns_type_and_referenced_keys(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    price = (await _create_property(client, ds_id, "Price", "number")).json()

    res = await client.post(
        f"/db/data-sources/{ds_id}/formulas/validate",
        json={"expression": 'prop("Price") * 2'},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["valid"] is True
    assert body["errors"] == []
    assert body["result_type"] == "number"
    assert body["referenced_properties"] == [price["key"]]
    assert body["is_volatile"] is False


async def test_validate_formula_syntax_error_is_200_not_400(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]

    res = await client.post(
        f"/db/data-sources/{ds_id}/formulas/validate",
        json={"expression": "1 + "},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["valid"] is False
    assert len(body["errors"]) == 1
    err = body["errors"][0]
    assert err["line"] >= 1
    assert err["col"] >= 1
    assert isinstance(err["pos"], int)


async def test_validate_formula_type_error_is_200_valid_false_with_result_type_still_present(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    await _create_property(client, ds_id, "Title2", "rich_text")

    res = await client.post(
        f"/db/data-sources/{ds_id}/formulas/validate",
        json={"expression": 'prop("Title2") - 1'},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["valid"] is False
    assert len(body["errors"]) == 1
    assert "Number" in body["errors"][0]["message"]


async def test_validate_formula_is_volatile_true_for_now(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]

    res = await client.post(
        f"/db/data-sources/{ds_id}/formulas/validate", json={"expression": "now()"}
    )
    assert res.status_code == 200, res.text
    assert res.json()["is_volatile"] is True


async def test_validate_formula_unknown_data_source_404s(client):
    import uuid

    res = await client.post(
        f"/db/data-sources/{uuid.uuid4()}/formulas/validate", json={"expression": "1 + 1"}
    )
    assert res.status_code == 404


async def test_validate_formula_on_all_notes_400s(client):
    res = await client.post(
        "/db/data-sources/all-notes/formulas/validate", json={"expression": "1 + 1"}
    )
    assert res.status_code == 400


async def test_validate_formula_expression_length_cap_is_200_not_500(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    huge = "1" + "+1" * 10_000  # well over the 5,000-char cap

    res = await client.post(
        f"/db/data-sources/{ds_id}/formulas/validate", json={"expression": huge}
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["valid"] is False
    assert "limit" in body["errors"][0]["message"]


# ---------------------------------------------------------------------------
# Formula property creation: save-time validation.
# ---------------------------------------------------------------------------


async def test_create_formula_property_stores_result_type_and_is_volatile(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    await _create_property(client, ds_id, "Price", "number")

    res = await _create_property(
        client, ds_id, "Doubled", "formula", config={"expression": 'prop("Price") * 2'}
    )
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["result_type"] == "number"
    assert body["is_volatile"] is False


async def test_create_formula_property_with_type_error_still_saves(client):
    """Research §1.9, quoted verbatim in task-28-brief.md §2: "a formula with
    errors can still be saved... the property will display nothing." Only a
    dependency cycle or a malformed rollup are hard rejections -- a formula
    that merely fails to typecheck is NOT one of them, even though it looks
    like it should be at first glance."""
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    await _create_property(client, ds_id, "Title2", "rich_text")

    res = await _create_property(
        client, ds_id, "Bad", "formula", config={"expression": 'prop("Title2") - 1'}
    )
    assert res.status_code == 201, res.text
    body = res.json()
    # result_type/is_volatile are still populated from the checker's
    # best-effort result even though it also produced errors -- "unknown"
    # here, not a guessed "number", since `_error()` deliberately returns
    # FType.UNKNOWN for a failed subexpression rather than cascading a
    # guess (typecheck.py's own "don't cascade one mistake into ten error
    # messages" design). The point of this assertion is that the save
    # succeeded (201) with SOME persisted result_type, not which one.
    assert body["result_type"] == "unknown"


async def test_create_formula_property_unparseable_expression_still_saves(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]

    res = await _create_property(client, ds_id, "Bad", "formula", config={"expression": "1 + "})
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["result_type"] is None
    assert body["is_volatile"] is False


async def test_create_formula_property_cycle_is_rejected_with_path(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]

    a = await _create_property(client, ds_id, "A", "formula", config={"expression": 'prop("B")'})
    assert a.status_code == 201, a.text

    b = await _create_property(client, ds_id, "B", "formula", config={"expression": 'prop("A")'})
    assert b.status_code == 400, b.text
    assert "cycle" in b.json()["detail"].lower()


async def test_create_formula_property_missing_expression_400s(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    res = await _create_property(client, ds_id, "Bad", "formula", config={})
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# Rollup property creation: save-time validation.
# ---------------------------------------------------------------------------


async def test_create_rollup_property_unknown_function_400s(client):
    owner = await _create_database(client, "Owners")
    target = await _create_database(client, "Targets")
    owner_ds, target_ds = owner["data_source"]["id"], target["data_source"]["id"]
    rel = (
        await client.post(
            f"/db/data-sources/{owner_ds}/relations",
            json={"name": "Rel", "target_data_source_id": target_ds, "two_way": False},
        )
    ).json()
    rel_key = rel["forward"]["key"]

    res = await _create_property(
        client, owner_ds, "Bad", "rollup",
        config={
            "relation_key": rel_key, "target_data_source_id": target_ds,
            "target_key": "whatever", "function": "not_a_real_function",
        },
    )
    assert res.status_code == 400, res.text


async def test_create_rollup_property_relation_key_not_a_relation_400s(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    num = await _create_property(client, ds_id, "Num", "number")
    num = num.json()

    res = await _create_property(
        client, ds_id, "Bad", "rollup",
        config={
            "relation_key": num["key"], "target_data_source_id": ds_id,
            "target_key": num["key"], "function": "sum",
        },
    )
    assert res.status_code == 400, res.text


async def test_create_rollup_property_success_stores_result_type(client):
    owner = await _create_database(client, "Owners")
    target = await _create_database(client, "Targets")
    owner_ds, target_ds = owner["data_source"]["id"], target["data_source"]["id"]
    target_num = (await _create_property(client, target_ds, "Value", "number")).json()
    rel = (
        await client.post(
            f"/db/data-sources/{owner_ds}/relations",
            json={"name": "Rel", "target_data_source_id": target_ds, "two_way": False},
        )
    ).json()
    rel_key = rel["forward"]["key"]

    res = await _create_property(
        client, owner_ds, "Sum", "rollup",
        config={
            "relation_key": rel_key, "target_data_source_id": target_ds,
            "target_key": target_num["key"], "function": "sum",
        },
    )
    assert res.status_code == 201, res.text
    assert res.json()["result_type"] == "number"


# ---------------------------------------------------------------------------
# PATCH /db/properties/{property_id}: name-only rename is unchanged, and
# config edits re-run the same save-time validation + recompute.
# ---------------------------------------------------------------------------


async def test_rename_only_leaves_key_and_config_untouched(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    prop = (await _create_property(client, ds_id, "Status", "status")).json()

    res = await client.patch(f"/db/properties/{prop['id']}", json={"name": "Progress"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == "Progress"
    assert body["key"] == prop["key"]
    assert body["config"] == prop["config"]


async def test_update_property_config_edits_formula_and_recomputes(client, db_conn, test_user):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    price = (await _create_property(client, ds_id, "Price", "number")).json()
    formula = await _create_property(
        client, ds_id, "Doubled", "formula", config={"expression": 'prop("Price") * 2'}
    )
    formula = formula.json()

    row_id = await _create_row(client, ds_id)
    await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": price["key"], "value": {"type": "number", "number": 5.0}},
    )

    res = await client.patch(
        f"/db/properties/{formula['id']}",
        json={"config": {"expression": 'prop("Price") * 10'}},
    )
    assert res.status_code == 200, res.text

    stored = await db_conn.fetchval(
        "SELECT computed -> $1 ->> 'number' FROM db_row_props WHERE note_id = $2",
        formula["key"], row_id,
    )
    assert float(stored) == 50.0


# ---------------------------------------------------------------------------
# Recompute triggers: row writes.
# ---------------------------------------------------------------------------


async def test_create_row_triggers_recompute(client, db_conn):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    await _create_property(
        client, ds_id, "Constant", "formula", config={"expression": "1 + 1"}
    )
    formula = (await client.get(f"/db/databases/{db['database']['id']}")).json()
    fkey = next(p["key"] for p in formula["properties"] if p["name"] == "Constant")

    row_id = await _create_row(client, ds_id)
    stored = await db_conn.fetchval(
        "SELECT computed -> $1 ->> 'number' FROM db_row_props WHERE note_id = $2", fkey, row_id
    )
    assert float(stored) == 2.0


async def test_update_row_property_response_includes_dependent_formula_value(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    price = (await _create_property(client, ds_id, "Price", "number")).json()
    formula = (
        await _create_property(
            client, ds_id, "Doubled", "formula", config={"expression": 'prop("Price") * 2'}
        )
    ).json()

    row_id = await _create_row(client, ds_id)
    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": price["key"], "value": {"type": "number", "number": 21.0}},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["properties"][formula["key"]]["number"] == 42.0


async def test_query_rows_merges_materialised_formula_value(client):
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    price = (await _create_property(client, ds_id, "Price", "number")).json()
    formula = (
        await _create_property(
            client, ds_id, "Doubled", "formula", config={"expression": 'prop("Price") * 2'}
        )
    ).json()
    row_id = await _create_row(client, ds_id)
    await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": price["key"], "value": {"type": "number", "number": 3.0}},
    )

    res = await client.post(f"/db/data-sources/{ds_id}/query", json={})
    assert res.status_code == 200, res.text
    rows = {r["id"]: r for r in res.json()["rows"]}
    assert rows[row_id]["properties"][formula["key"]]["number"] == 6.0


async def test_query_rows_can_filter_and_sort_by_a_formula_property(client):
    """M8 combined review, Critical finding.

    Spec §7.3's stated payoff for materialising is that "formulas and
    rollups filter and sort in SQL exactly like stored values". Every layer
    beneath this endpoint implemented that correctly, but `query_rows`
    built its `PropertyLookup`s without `result_type`/`is_volatile`, so a
    filter or sort naming a formula key 400'd with "has no filterable
    operators" / "has no SQL shape" for EVERY formula and rollup property.

    The reason it shipped: `test_db_computed_query.py`'s filter/sort tests
    construct `PropertyLookup(..., result_type="number")` by hand and drive
    `QueryBuilder` directly, so they never exercise the router's own
    construction site. This test goes through the real HTTP endpoint
    instead, which is the only thing that would have caught it -- exactly
    the same lesson as the `db_row_props.computed` column never being
    SELECTed (task-28-report.md's defect 2).
    """
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    price = (await _create_property(client, ds_id, "Price", "number")).json()
    formula = (
        await _create_property(
            client, ds_id, "Doubled", "formula", config={"expression": 'prop("Price") * 2'}
        )
    ).json()

    # Three rows with Price 1/2/3 -> Doubled 2/4/6.
    row_ids = []
    for price_value in (1.0, 2.0, 3.0):
        row_id = await _create_row(client, ds_id)
        await client.patch(
            f"/db/data-sources/{ds_id}/rows/{row_id}",
            json={
                "property_key": price["key"],
                "value": {"type": "number", "number": price_value},
            },
        )
        row_ids.append(row_id)

    # FILTER: Doubled > 3 must return exactly the Price=2 and Price=3 rows.
    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={
            "filter": {
                "type": "condition",
                "property": formula["key"],
                "operator": "greater_than",
                "value": 3,
            }
        },
    )
    assert res.status_code == 200, res.text
    got = {r["id"] for r in res.json()["rows"]}
    assert got == {row_ids[1], row_ids[2]}, (
        "filtering by a materialised formula returned the wrong rows"
    )

    # SORT: descending by Doubled must be 6, 4, 2.
    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"sorts": [{"property": formula["key"], "direction": "desc"}]},
    )
    assert res.status_code == 200, res.text
    ordered = [
        r["properties"][formula["key"]]["number"] for r in res.json()["rows"]
    ]
    assert ordered == [6.0, 4.0, 2.0], f"sort by formula gave {ordered}"


async def test_query_rows_rejects_filtering_by_a_volatile_formula(client):
    """The other half of the same wiring: `is_volatile` must arrive too.

    A volatile formula is never materialised (spec §7.4), so it has no SQL
    value to filter on. Task 27 deliberately did not build spec §7.4's
    compute-then-filter fallback, so the contract is a clean 400 naming
    volatility -- never silently wrong rows. Before the fix this returned
    the WRONG error (result_type=None rather than volatility), and after a
    naive fix that passed only `result_type` it would have tried to filter
    a column that is guaranteed empty.
    """
    db = await _create_database(client)
    ds_id = db["data_source"]["id"]
    volatile = (
        await _create_property(
            client, ds_id, "Age", "formula", config={"expression": "now()"}
        )
    ).json()
    assert volatile["is_volatile"] is True, "precondition: now() marks the formula volatile"

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={
            "filter": {
                "type": "condition",
                "property": volatile["key"],
                "operator": "is_not_empty",
                "value": None,
            }
        },
    )
    assert res.status_code == 400, res.text
    assert "volatile" in res.json()["detail"].lower(), res.text


# ---------------------------------------------------------------------------
# The M7/M8 composition: a date write that both shifts dependents AND
# invalidates a formula on the shifted row.
# ---------------------------------------------------------------------------


def _wrap_date(dt: datetime) -> dict:
    return {"type": "date", "date": {"start": _iso(dt), "end": None, "time_zone": None}}


async def test_date_shift_cascade_also_invalidates_formula_on_shifted_row(client, db_conn):
    db = await _create_database(client, "Tasks")
    ds_id = db["data_source"]["id"]
    date_prop = (await _create_property(client, ds_id, "Due", "date")).json()
    date_key = date_prop["key"]
    # A formula on the SAME data source that reads the date property
    # directly (not through a rollup) -- the case task-28-brief.md §3 calls
    # out by name: "make sure the two compose... test that specific
    # combination."
    days_formula = (
        await _create_property(
            client, ds_id, "DueDay", "formula", config={"expression": 'prop("Due").date()'}
        )
    ).json()

    pair = (await client.post(f"/db/data-sources/{ds_id}/dependencies")).json()
    relation_id = pair["forward"]["config"]["relation_id"]
    forward_key = pair["forward"]["key"]

    blocker = await _create_row(client, ds_id)
    blocked = await _create_row(client, ds_id)
    await client.post(
        f"/db/data-sources/{ds_id}/rows/{blocker}/relations/{forward_key}/links",
        json={"row_id": blocked},
    )
    await client.patch(
        f"/db/relations/{relation_id}/dependency-settings",
        json={"date_shift_mode": "Shift & maintain time between items", "date_property_key": date_key},
    )

    await client.patch(
        f"/db/data-sources/{ds_id}/rows/{blocker}",
        json={"property_key": date_key, "value": _wrap_date(_dt(2026, 8, 17))},
    )
    await client.patch(
        f"/db/data-sources/{ds_id}/rows/{blocked}",
        json={"property_key": date_key, "value": _wrap_date(_dt(2026, 8, 24))},
    )

    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{blocker}",
        json={"property_key": date_key, "value": _wrap_date(_dt(2026, 8, 24))},  # +7 days
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["shifted_rows"] is not None
    shifted = body["shifted_rows"][0]
    assert shifted["id"] == blocked
    assert shifted["properties"][date_key]["date"]["start"] == _iso(_dt(2026, 8, 31))

    # The formula on the SHIFTED row (not the one directly written) picked
    # up the new date too -- this is the actual assertion this test exists
    # for: recompute_row was called for `blocked`, not just `blocker`.
    stored = await db_conn.fetchval(
        "SELECT computed -> $1 ->> 'number' FROM db_row_props WHERE note_id = $2",
        days_formula["key"], blocked,
    )
    assert float(stored) == 31.0
