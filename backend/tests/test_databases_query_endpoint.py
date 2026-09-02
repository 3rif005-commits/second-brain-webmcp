"""Tests for `POST /db/data-sources/{data_source_id}/query` and
`POST /db/data-sources/{data_source_id}/views` (task-15, Milestone 6): wiring
Milestone 3's filter/sort compiler and Milestone 4's grouping into an HTTP endpoint for
the first time, plus the first way to create a non-default view.

Runs against the local pgtest harness (localhost:55432, migrations 001-019 applied — see
repo root's `scripts/pgtest/up.sh`/`apply.sh`) through the same transaction-wrapped
`db_conn`/`test_user` fixtures (`tests/conftest.py`) and `client`-fixture-building
convention `tests/test_databases_router.py` already established — reused verbatim below,
not duplicated with a different shape. NEVER touches `core.config.settings.database_url`
(the real Supabase project) — no code path here can reach it.
"""
from __future__ import annotations

import uuid

import httpx
import pytest_asyncio

from main import app
from routers.databases import ALL_NOTES_ID
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


# ---------------------------------------------------------------------------
# No filter/sorts/group: byte-shape equivalence with list_rows, both modes.
# ---------------------------------------------------------------------------

async def test_query_with_no_filter_matches_list_rows_ordinary_mode(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = await _create_property(client, ds_id, "Status", "status")
    await _insert_row(db_conn, test_user, ds_id, {prop["key"]: {"type": "status", "status": "todo"}})

    list_res = await client.get(f"/db/data-sources/{ds_id}/rows")
    query_res = await client.post(f"/db/data-sources/{ds_id}/query", json={})
    assert list_res.status_code == query_res.status_code == 200
    assert query_res.json() == {"rows": list_res.json()["rows"]}


async def test_query_with_no_filter_matches_list_rows_all_notes_mode(client, db_conn, test_user):
    await db_conn.execute("INSERT INTO notes (user_id, title) VALUES ($1, 'N1')", test_user)

    list_res = await client.get(f"/db/data-sources/{ALL_NOTES_ID}/rows")
    query_res = await client.post(f"/db/data-sources/{ALL_NOTES_ID}/query", json={})
    assert list_res.status_code == query_res.status_code == 200
    assert query_res.json() == {"rows": list_res.json()["rows"]}


# ---------------------------------------------------------------------------
# task-17: `cover_image_url` plumbing for Gallery view. Not a `COLUMN_BACKED`
# property (it never becomes a column in `properties{}`, never shows up as a
# Table/Board column) -- a dedicated field alongside `properties` on each row
# dict, populated only by `POST .../query` (QueryBuilder's `_columns()` now
# selects `n.cover_image_url` in both modes). `GET .../rows` (list_rows)
# deliberately keeps using its own hand-rolled SQL, which does NOT select
# this column -- the shared decode helpers read it with `record.get(...)`
# rather than `record[...]` specifically so list_rows keeps returning
# `cover_image_url: None` (never a KeyError) instead of the real value. That
# asymmetry is intentional per task-17-brief.md's minimal-scope call: no live
# frontend caller uses `GET .../rows` any more (task-16 moved everything to
# `POST .../query`), so it doesn't need the real value, and the two byte-
# shape-equivalence tests above only hold because neither test note sets a
# real cover_image_url (both sides read back None either way).
# ---------------------------------------------------------------------------

async def test_query_returns_real_cover_image_url_ordinary_mode(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title, cover_image_url) VALUES ($1, 'Row 1', $2) RETURNING id",
        test_user, "https://example.com/cover.png",
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) "
        "VALUES ($1, $2, $3, '{}')",
        note["id"], ds_id, test_user,
    )

    res = await client.post(f"/db/data-sources/{ds_id}/query", json={})
    assert res.status_code == 200
    rows = res.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["cover_image_url"] == "https://example.com/cover.png"


async def test_query_returns_real_cover_image_url_all_notes_mode(client, db_conn, test_user):
    await db_conn.execute(
        "INSERT INTO notes (user_id, title, cover_image_url) VALUES ($1, 'N1', $2)",
        test_user, "https://example.com/all-notes-cover.png",
    )

    res = await client.post(f"/db/data-sources/{ALL_NOTES_ID}/query", json={})
    assert res.status_code == 200
    rows = res.json()["rows"]
    assert len(rows) == 1
    assert rows[0]["cover_image_url"] == "https://example.com/all-notes-cover.png"


async def test_query_returns_null_cover_image_url_when_note_has_none(client, db_conn, test_user):
    await db_conn.execute("INSERT INTO notes (user_id, title) VALUES ($1, 'No cover')", test_user)

    res = await client.post(f"/db/data-sources/{ALL_NOTES_ID}/query", json={})
    assert res.status_code == 200
    rows = res.json()["rows"]
    assert rows[0]["cover_image_url"] is None


async def test_list_rows_does_not_leak_the_real_cover_image_url(client, db_conn, test_user):
    """`GET .../rows` has no live caller left (task-16); this pins the
    documented asymmetry above -- it always reports `None`, on purpose,
    rather than silently starting to leak the real value the moment
    someone adds `n.cover_image_url` to its own hand-rolled SQL later
    without reading this comment."""
    await db_conn.execute(
        "INSERT INTO notes (user_id, title, cover_image_url) VALUES ($1, 'N1', $2)",
        test_user, "https://example.com/cover.png",
    )

    res = await client.get(f"/db/data-sources/{ALL_NOTES_ID}/rows")
    assert res.status_code == 200
    assert res.json()["rows"][0]["cover_image_url"] is None


# ---------------------------------------------------------------------------
# A real filter returns only matching rows, both modes.
# ---------------------------------------------------------------------------

async def test_filter_equals_returns_only_matching_rows_ordinary_mode(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = await _create_property(client, ds_id, "Notes", "rich_text")
    keep_id = await _insert_row(
        db_conn, test_user, ds_id, {prop["key"]: {"type": "rich_text", "rich_text": "keep"}}
    )
    await _insert_row(db_conn, test_user, ds_id, {prop["key"]: {"type": "rich_text", "rich_text": "drop"}})

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={
            "filter": {
                "type": "condition", "property": prop["key"], "operator": "equals", "value": "keep",
            }
        },
    )
    assert res.status_code == 200, res.text
    ids = {r["id"] for r in res.json()["rows"]}
    assert ids == {keep_id}


async def test_filter_equals_returns_only_matching_rows_all_notes_mode(client, db_conn, test_user):
    keep = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Keep Me') RETURNING id", test_user
    )
    await db_conn.execute("INSERT INTO notes (user_id, title) VALUES ($1, 'Other')", test_user)

    res = await client.post(
        f"/db/data-sources/{ALL_NOTES_ID}/query",
        json={
            "filter": {
                "type": "condition", "property": "title", "operator": "equals", "value": "Keep Me",
            }
        },
    )
    assert res.status_code == 200, res.text
    ids = {r["id"] for r in res.json()["rows"]}
    assert ids == {str(keep["id"])}


# ---------------------------------------------------------------------------
# Unknown property key -> 400, not 500, not silently ignored.
# ---------------------------------------------------------------------------

async def test_unknown_property_key_in_filter_is_400_not_500(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"filter": {"type": "condition", "property": "ghost", "operator": "equals", "value": "x"}},
    )
    assert res.status_code == 400


async def test_unknown_property_key_in_sorts_is_400_not_500(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"sorts": [{"property": "ghost", "direction": "asc"}]},
    )
    assert res.status_code == 400


async def test_unknown_property_key_in_group_by_is_400_not_500(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"group_by": {"property_key": "ghost"}},
    )
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# group_by on select/status: human-readable labels from db_properties.config,
# falling back to the raw option id when unconfigured -- the specific "group
# labels are opaque ids" gap this task closes (task-15-brief.md §1.6).
# ---------------------------------------------------------------------------

async def test_group_by_select_with_configured_options_returns_human_readable_labels(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = await _create_property(
        client, ds_id, "Priority", "select",
        config={
            "options": [
                {"id": "opt_hi", "name": "High", "color": "red"},
                {"id": "opt_lo", "name": "Low", "color": "blue"},
            ]
        },
    )
    await _insert_row(db_conn, test_user, ds_id, {prop["key"]: {"type": "select", "select": "opt_hi"}})
    await _insert_row(db_conn, test_user, ds_id, {prop["key"]: {"type": "select", "select": "opt_lo"}})

    res = await client.post(
        f"/db/data-sources/{ds_id}/query", json={"group_by": {"property_key": prop["key"]}}
    )
    assert res.status_code == 200, res.text
    by_key = {g["key"]: g for g in res.json()["groups"]}
    assert by_key["opt_hi"]["label"] == "High"
    assert by_key["opt_hi"]["row_count"] == 1
    assert by_key["opt_lo"]["label"] == "Low"


async def test_group_by_status_with_configured_options_returns_human_readable_labels(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = await _create_property(
        client, ds_id, "Status", "status",
        config={"options": [{"id": "st_done", "name": "Done", "color": "green"}]},
    )
    await _insert_row(db_conn, test_user, ds_id, {prop["key"]: {"type": "status", "status": "st_done"}})

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"group_by": {"property_key": prop["key"], "mode": "option"}},
    )
    assert res.status_code == 200, res.text
    by_key = {g["key"]: g for g in res.json()["groups"]}
    assert by_key["st_done"]["label"] == "Done"


async def test_group_by_select_with_no_configured_options_falls_back_to_raw_key(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = await _create_property(client, ds_id, "Priority", "select")  # config={} default
    await _insert_row(
        db_conn, test_user, ds_id, {prop["key"]: {"type": "select", "select": "unconfigured_id"}}
    )

    res = await client.post(
        f"/db/data-sources/{ds_id}/query", json={"group_by": {"property_key": prop["key"]}}
    )
    assert res.status_code == 200, res.text
    by_key = {g["key"]: g for g in res.json()["groups"]}
    assert by_key["unconfigured_id"]["label"] == "unconfigured_id"  # no crash, raw id as label


async def test_group_by_select_with_stale_option_id_falls_back_to_raw_key(
    client, db_conn, test_user
):
    # The property HAS configured options, but the specific stored value doesn't match
    # any of them (a deleted option) -- must still fall back cleanly, not KeyError.
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = await _create_property(
        client, ds_id, "Priority", "select",
        config={"options": [{"id": "opt_hi", "name": "High", "color": "red"}]},
    )
    await _insert_row(
        db_conn, test_user, ds_id, {prop["key"]: {"type": "select", "select": "opt_deleted"}}
    )

    res = await client.post(
        f"/db/data-sources/{ds_id}/query", json={"group_by": {"property_key": prop["key"]}}
    )
    assert res.status_code == 200, res.text
    by_key = {g["key"]: g for g in res.json()["groups"]}
    assert by_key["opt_deleted"]["label"] == "opt_deleted"


# ---------------------------------------------------------------------------
# hide_empty_groups
# ---------------------------------------------------------------------------

async def test_hide_empty_groups_default_false_includes_the_empty_group(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = await _create_property(client, ds_id, "Done", "checkbox")
    await _insert_row(db_conn, test_user, ds_id, {prop["key"]: {"type": "checkbox", "checkbox": True}})

    res = await client.post(
        f"/db/data-sources/{ds_id}/query", json={"group_by": {"property_key": prop["key"]}}
    )
    assert res.status_code == 200, res.text
    keys = {g["key"] for g in res.json()["groups"]}
    assert "false" in keys  # the genuinely empty group is still returned


async def test_hide_empty_groups_true_omits_the_empty_group(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    prop = await _create_property(client, ds_id, "Done", "checkbox")
    await _insert_row(db_conn, test_user, ds_id, {prop["key"]: {"type": "checkbox", "checkbox": True}})

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"group_by": {"property_key": prop["key"], "hide_empty_groups": True}},
    )
    assert res.status_code == 200, res.text
    keys = {g["key"] for g in res.json()["groups"]}
    assert "false" not in keys
    assert "true" in keys


# ---------------------------------------------------------------------------
# sub_group_by: two-level nested shape.
# ---------------------------------------------------------------------------

async def test_sub_group_by_produces_two_level_nested_shape(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    status_prop = await _create_property(
        client, ds_id, "Status", "status",
        config={"options": [{"id": "todo", "name": "To Do", "color": "gray"}]},
    )
    priority_prop = await _create_property(client, ds_id, "Priority", "select")

    await _insert_row(db_conn, test_user, ds_id, {
        status_prop["key"]: {"type": "status", "status": "todo"},
        priority_prop["key"]: {"type": "select", "select": "high"},
    })
    await _insert_row(db_conn, test_user, ds_id, {
        status_prop["key"]: {"type": "status", "status": "todo"},
        priority_prop["key"]: {"type": "select", "select": "low"},
    })

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={
            "group_by": {"property_key": status_prop["key"], "mode": "option"},
            "sub_group_by": {"property_key": priority_prop["key"]},
        },
    )
    assert res.status_code == 200, res.text
    groups = res.json()["groups"]
    todo = next(g for g in groups if g["key"] == "todo")
    assert todo["label"] == "To Do"
    assert todo["row_count"] == 2
    assert todo["subgroups"] is not None
    sub_by_key = {sg["key"]: sg for sg in todo["subgroups"]}
    assert sub_by_key["high"]["row_count"] == 1
    assert sub_by_key["low"]["row_count"] == 1
    # Depth is exactly two: a subgroup's own subgroups field is omitted entirely
    # (response_model_exclude_none=True), not present-and-null.
    assert "subgroups" not in sub_by_key["high"]

    # Every top-level group without a sub_group_by request has subgroups omitted, not
    # present-and-null -- response_model_exclude_none=True on the route.
    no_sub_res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"group_by": {"property_key": status_prop["key"], "mode": "option"}},
    )
    assert "rows" not in no_sub_res.json()  # the other top-level field is omitted too
    for g in no_sub_res.json()["groups"]:
        assert "subgroups" not in g


# ---------------------------------------------------------------------------
# aggregations (Milestone 10, task-32): wiring `aggregations.aggregate()` (the
# 20-function calculation engine Milestone 4 built, zero HTTP callers until now) into
# this endpoint for a Chart view's y-axis / Number-mode value.
# ---------------------------------------------------------------------------

async def test_aggregations_sum_per_group_matches_hand_computed_sum(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    status_prop = await _create_property(client, ds_id, "Status", "select")
    estimate_prop = await _create_property(client, ds_id, "Estimate", "number")

    await _insert_row(db_conn, test_user, ds_id, {
        status_prop["key"]: {"type": "select", "select": "todo"},
        estimate_prop["key"]: {"type": "number", "number": 3},
    })
    await _insert_row(db_conn, test_user, ds_id, {
        status_prop["key"]: {"type": "select", "select": "todo"},
        estimate_prop["key"]: {"type": "number", "number": 5},
    })
    await _insert_row(db_conn, test_user, ds_id, {
        status_prop["key"]: {"type": "select", "select": "done"},
        estimate_prop["key"]: {"type": "number", "number": 10},
    })

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={
            "group_by": {"property_key": status_prop["key"]},
            "aggregations": [{"key": "y", "property_key": estimate_prop["key"], "aggregator": "sum"}],
        },
    )
    assert res.status_code == 200, res.text
    by_key = {g["key"]: g for g in res.json()["groups"]}
    assert by_key["todo"]["aggregates"] == {"y": 8}  # hand-computed: 3 + 5
    assert by_key["done"]["aggregates"] == {"y": 10}


async def test_aggregations_count_without_property_key_works(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    status_prop = await _create_property(client, ds_id, "Status", "select")
    await _insert_row(db_conn, test_user, ds_id, {status_prop["key"]: {"type": "select", "select": "todo"}})
    await _insert_row(db_conn, test_user, ds_id, {status_prop["key"]: {"type": "select", "select": "todo"}})

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"aggregations": [{"key": "n", "aggregator": "count"}]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["aggregates"] == {"n": 2}


async def test_aggregations_count_with_property_key_still_works(client, db_conn, test_user):
    # aggregate()'s own contract (aggregations.py): `count` ignores `lookup` entirely, so
    # a caller supplying a (valid) property_key alongside "count" must not 400.
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    status_prop = await _create_property(client, ds_id, "Status", "select")
    await _insert_row(db_conn, test_user, ds_id, {status_prop["key"]: {"type": "select", "select": "todo"}})

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"aggregations": [{"key": "n", "property_key": status_prop["key"], "aggregator": "count"}]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["aggregates"] == {"n": 1}


async def test_aggregations_unsupported_aggregator_is_400_not_500(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"aggregations": [{"key": "y", "aggregator": "bogus"}]},
    )
    assert res.status_code == 400


async def test_aggregations_unknown_property_key_is_400(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"aggregations": [{"key": "y", "property_key": "ghost", "aggregator": "sum"}]},
    )
    assert res.status_code == 400


async def test_aggregations_two_level_nested_with_sub_group_by(client, db_conn, test_user):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    status_prop = await _create_property(client, ds_id, "Status", "select")
    priority_prop = await _create_property(client, ds_id, "Priority", "select")
    estimate_prop = await _create_property(client, ds_id, "Estimate", "number")

    await _insert_row(db_conn, test_user, ds_id, {
        status_prop["key"]: {"type": "select", "select": "todo"},
        priority_prop["key"]: {"type": "select", "select": "high"},
        estimate_prop["key"]: {"type": "number", "number": 2},
    })
    await _insert_row(db_conn, test_user, ds_id, {
        status_prop["key"]: {"type": "select", "select": "todo"},
        priority_prop["key"]: {"type": "select", "select": "high"},
        estimate_prop["key"]: {"type": "number", "number": 4},
    })
    await _insert_row(db_conn, test_user, ds_id, {
        status_prop["key"]: {"type": "select", "select": "todo"},
        priority_prop["key"]: {"type": "select", "select": "low"},
        estimate_prop["key"]: {"type": "number", "number": 9},
    })

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={
            "group_by": {"property_key": status_prop["key"]},
            "sub_group_by": {"property_key": priority_prop["key"]},
            "aggregations": [{"key": "y", "property_key": estimate_prop["key"], "aggregator": "sum"}],
        },
    )
    assert res.status_code == 200, res.text
    groups = res.json()["groups"]
    todo = next(g for g in groups if g["key"] == "todo")
    assert todo["aggregates"] == {"y": 15}  # 2 + 4 + 9 -- the WHOLE top-level group
    sub_by_key = {sg["key"]: sg for sg in todo["subgroups"]}
    assert sub_by_key["high"]["aggregates"] == {"y": 6}  # 2 + 4 -- just this subgroup
    assert sub_by_key["low"]["aggregates"] == {"y": 9}


async def test_aggregations_ungrouped_reflects_full_filtered_set_not_just_first_page(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    estimate_prop = await _create_property(client, ds_id, "Estimate", "number")

    total_rows = 8
    for _ in range(total_rows):
        await _insert_row(
            db_conn, test_user, ds_id, {estimate_prop["key"]: {"type": "number", "number": 1}}
        )

    small_page_size = 3
    assert small_page_size < total_rows  # the assertion below is only meaningful if this holds

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={
            "page_size": small_page_size,
            "aggregations": [{"key": "y", "property_key": estimate_prop["key"], "aggregator": "sum"}],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert len(body["rows"]) == small_page_size  # `rows` is still paginated as normal
    assert body["aggregates"] == {"y": total_rows}  # but the aggregate covers every row, not page 1


async def test_aggregations_grouped_reflects_full_group_not_just_first_page(
    client, db_conn, test_user
):
    # fix-wave-1 finding 1: before the fix, `compute_full_set` only fired when
    # `body.group_by is None`, so a *grouped* query with aggregations stayed clipped to
    # `body.page_size` for its row fetch -- silently truncating a group's aggregate to
    # whichever of its rows happened to land in page 1. This is the exact case every
    # grouped Chart type (column/bar/line/donut) hits in practice, since the frontend never
    # sends a custom `page_size` for a Chart request (getQueryExtras/loadRows never set
    # one) and `QueryRequest.page_size` defaults to 50.
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    status_prop = await _create_property(client, ds_id, "Status", "select")
    estimate_prop = await _create_property(client, ds_id, "Estimate", "number")

    total_rows = 8
    for _ in range(total_rows):
        await _insert_row(db_conn, test_user, ds_id, {
            status_prop["key"]: {"type": "select", "select": "todo"},
            estimate_prop["key"]: {"type": "number", "number": 1},
        })

    small_page_size = 3
    assert small_page_size < total_rows  # the assertion below is only meaningful if this holds

    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={
            "page_size": small_page_size,
            "group_by": {"property_key": status_prop["key"]},
            "aggregations": [{"key": "y", "property_key": estimate_prop["key"], "aggregator": "sum"}],
        },
    )
    assert res.status_code == 200, res.text
    groups = {g["key"]: g for g in res.json()["groups"]}
    assert groups["todo"]["aggregates"] == {"y": total_rows}  # every row in the group, not page 1
    assert groups["todo"]["row_count"] == total_rows


async def test_aggregations_ungrouped_still_validates_out_of_range_page_size(client):
    # The full-filtered-set fetch above bypasses `ast.Pagination`'s own `le=200` cap for
    # the *SQL fetch it issues*, but `body.page_size`/`body.offset` themselves must stay
    # just as validated as any other request through this endpoint -- regression check for
    # the "aggregations short-circuits pagination validation entirely" failure shape.
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"page_size": 999, "aggregations": [{"key": "n", "aggregator": "count"}]},
    )
    assert res.status_code == 400, res.text


async def test_aggregations_absent_from_request_leaves_the_key_entirely_absent(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    status_prop = await _create_property(client, ds_id, "Status", "select")
    await _insert_row(db_conn, test_user, ds_id, {status_prop["key"]: {"type": "select", "select": "todo"}})

    ungrouped_res = await client.post(f"/db/data-sources/{ds_id}/query", json={})
    assert ungrouped_res.status_code == 200, ungrouped_res.text
    assert "aggregates" not in ungrouped_res.json()

    grouped_res = await client.post(
        f"/db/data-sources/{ds_id}/query",
        json={"group_by": {"property_key": status_prop["key"]}},
    )
    assert grouped_res.status_code == 200, grouped_res.text
    for g in grouped_res.json()["groups"]:
        assert "aggregates" not in g


async def test_aggregation_tenancy_scopes_to_current_user(client, db_conn, test_user):
    # Same technique `test_all_notes_query_scopes_to_current_user_excludes_others_notes`
    # (above) already uses for the plain rows list -- aggregation happens in Python over
    # rows the compiler already scoped, so this should be structurally guaranteed, but
    # assert it directly rather than only assuming it (task-32-brief.md's own instruction).
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    await db_conn.execute("INSERT INTO notes (user_id, title) VALUES ($1, 'Theirs')", other_user)
    await db_conn.execute("INSERT INTO notes (user_id, title) VALUES ($1, 'Mine')", test_user)

    res = await client.post(
        f"/db/data-sources/{ALL_NOTES_ID}/query",
        json={"aggregations": [{"key": "n", "aggregator": "count"}]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["aggregates"] == {"n": 1}  # only the current user's note is counted


# ---------------------------------------------------------------------------
# POST .../views: minimal view creation.
# ---------------------------------------------------------------------------

async def test_create_view_creates_a_row_visible_in_get_database(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    db_id = created["database"]["id"]

    res = await client.post(
        f"/db/data-sources/{ds_id}/views", json={"name": "Board View", "type": "board", "icon": "🗂"}
    )
    assert res.status_code == 201, res.text
    view = res.json()
    assert view["type"] == "board"
    assert view["name"] == "Board View"
    assert view["icon"] == "🗂"
    assert view["data_source_id"] == ds_id

    get_res = await client.get(f"/db/databases/{db_id}")
    assert get_res.status_code == 200
    views = get_res.json()["views"]
    assert len(views) == 2  # the default table view from create_database + this new one
    assert any(v["id"] == view["id"] for v in views)


async def test_create_view_defaults_name_when_omitted(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(f"/db/data-sources/{ds_id}/views", json={"type": "list"})
    assert res.status_code == 201, res.text
    assert res.json()["name"] == "New view"


async def test_create_view_accepts_an_unrecognized_type_no_closed_enum(client):
    # task-15-brief.md §2: no type allow-list beyond "non-empty string" -- a
    # not-yet-built view type (e.g. a future Timeline/Chart) must not be rejected here.
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    res = await client.post(f"/db/data-sources/{ds_id}/views", json={"type": "timeline"})
    assert res.status_code == 201, res.text
    assert res.json()["type"] == "timeline"


async def test_create_view_positions_append_after_the_default_view(client, db_conn):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    default_view_position = created["views"][0]["position"]

    res = await client.post(f"/db/data-sources/{ds_id}/views", json={"type": "board"})
    assert res.status_code == 201, res.text
    assert res.json()["position"] > default_view_position


async def test_create_view_rejected_on_all_notes_with_400(client):
    res = await client.post(f"/db/data-sources/{ALL_NOTES_ID}/views", json={"type": "table"})
    assert res.status_code == 400


async def test_create_view_404s_for_unknown_data_source(client):
    res = await client.post(f"/db/data-sources/{uuid.uuid4()}/views", json={"type": "table"})
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# Tenancy: prove the query endpoint's compiled SQL still carries the mandatory
# scope predicate now that it goes through QueryBuilder (not hand-written SQL
# in this router) -- this milestone's whole existence is "the compiler
# finally gets a live caller," so this proves the guarantee survives that seam
# rather than just assuming it (`services/db/query/builder.py`'s `_scope()`).
# ---------------------------------------------------------------------------

async def test_all_notes_query_scopes_to_current_user_excludes_others_notes(
    client, db_conn, test_user
):
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    mine = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Mine') RETURNING id", test_user
    )
    theirs = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'Theirs') RETURNING id", other_user
    )

    res = await client.post(f"/db/data-sources/{ALL_NOTES_ID}/query", json={})
    assert res.status_code == 200
    ids = {r["id"] for r in res.json()["rows"]}
    assert str(mine["id"]) in ids
    assert str(theirs["id"]) not in ids


async def test_query_404s_for_another_users_ordinary_data_source(client, db_conn):
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
    res = await client.post(f"/db/data-sources/{ds_row['id']}/query", json={})
    assert res.status_code == 404
