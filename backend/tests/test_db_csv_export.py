"""Tests for `GET /db/data-sources/{data_source_id}/export` (Milestone 14, task-48):
CSV export honouring the currently open view's filter/sort.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §12 (research
§7.2/§10, "Markdown & CSV" export). Plan test case, line 471: "export honours the
current view's filters and sorts."

Runs against the local pgtest harness through the same transaction-wrapped `db_conn`/
`test_user` fixtures (`tests/conftest.py`) and `client`-fixture-building convention
`tests/test_databases_router.py`/`tests/test_databases_query_endpoint.py` already
established — reused verbatim, not duplicated with a different shape. NEVER touches
`core.config.settings.database_url` (the real Supabase project) — no code path here
can reach it.
"""
from __future__ import annotations

import csv
import io
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


async def _create_view(client: httpx.AsyncClient, ds_id: str, name: str = "Filtered view") -> dict:
    res = await client.post(f"/db/data-sources/{ds_id}/views", json={"name": name, "type": "table"})
    assert res.status_code == 201, res.text
    return res.json()


async def _patch_view(client: httpx.AsyncClient, view_id: str, patch: dict) -> dict:
    res = await client.patch(f"/db/views/{view_id}", json=patch)
    assert res.status_code == 200, res.text
    return res.json()


def _rows(csv_text: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(csv_text)))


# ---------------------------------------------------------------------------
# Unfiltered/unsorted view: every row exported, header order matches position.
# ---------------------------------------------------------------------------

async def test_unfiltered_view_exports_every_row_header_order_matches_position(
    client, db_conn, test_user
):
    created = await _create_database(client, "Reading List")
    ds_id = created["data_source"]["id"]
    default_view_id = created["views"][0]["id"]
    title_key = created["properties"][0]["key"]  # auto-created "Title" property, position 0

    author_prop = await _create_property(client, ds_id, "Author", "rich_text")
    year_prop = await _create_property(client, ds_id, "Year", "number")

    await _insert_row(
        db_conn, test_user, ds_id,
        {
            title_key: {"type": "title", "title": "Dune"},
            author_prop["key"]: {"type": "rich_text", "rich_text": "Herbert"},
            year_prop["key"]: {"type": "number", "number": 1965},
        },
    )
    await _insert_row(
        db_conn, test_user, ds_id,
        {
            title_key: {"type": "title", "title": "Foundation"},
            author_prop["key"]: {"type": "rich_text", "rich_text": "Asimov"},
            year_prop["key"]: {"type": "number", "number": 1951},
        },
    )

    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={default_view_id}")
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")

    rows = _rows(res.text)
    assert rows[0] == ["id", "Title", "Author", "Year"]
    body_titles = {r[1] for r in rows[1:]}
    assert body_titles == {"Dune", "Foundation"}
    assert len(rows) == 3  # header + 2 rows


# ---------------------------------------------------------------------------
# A view with a real filter/sort exports only the matching rows, sorted.
# ---------------------------------------------------------------------------

async def test_filtered_sorted_view_exports_only_matching_rows_in_sorted_order(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    title_key = created["properties"][0]["key"]
    status_prop = await _create_property(client, ds_id, "Status", "select", config={
        "options": [
            {"id": "opt_done", "name": "Done", "color": "green"},
            {"id": "opt_todo", "name": "Todo", "color": "gray"},
        ]
    })
    year_prop = await _create_property(client, ds_id, "Year", "number")

    await _insert_row(
        db_conn, test_user, ds_id,
        {
            title_key: {"type": "title", "title": "Later"},
            status_prop["key"]: {"type": "select", "select": "opt_done"},
            year_prop["key"]: {"type": "number", "number": 2020},
        },
    )
    await _insert_row(
        db_conn, test_user, ds_id,
        {
            title_key: {"type": "title", "title": "Earlier"},
            status_prop["key"]: {"type": "select", "select": "opt_done"},
            year_prop["key"]: {"type": "number", "number": 2010},
        },
    )
    await _insert_row(
        db_conn, test_user, ds_id,
        {
            title_key: {"type": "title", "title": "Excluded"},
            status_prop["key"]: {"type": "select", "select": "opt_todo"},
            year_prop["key"]: {"type": "number", "number": 2015},
        },
    )

    view = await _create_view(client, ds_id)
    await _patch_view(
        client, view["id"],
        {
            "filter": {
                "type": "condition", "property": status_prop["key"],
                "operator": "equals", "value": "opt_done",
            },
            "sorts": [{"property": year_prop["key"], "direction": "asc"}],
        },
    )

    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={view['id']}")
    assert res.status_code == 200, res.text
    rows = _rows(res.text)
    assert rows[0] == ["id", "Title", "Status", "Year"]
    body = rows[1:]
    assert len(body) == 2
    assert [r[1] for r in body] == ["Earlier", "Later"]  # 2010 before 2020, ascending
    assert [r[2] for r in body] == ["Done", "Done"]  # resolved option label, not raw id


# ---------------------------------------------------------------------------
# A representative property-type set renders through format_property_value.
# ---------------------------------------------------------------------------

async def test_representative_property_types_render_through_format_property_value(
    client, db_conn, test_user
):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    default_view_id = created["views"][0]["id"]
    title_key = created["properties"][0]["key"]

    number_prop = await _create_property(client, ds_id, "Count", "number")
    date_prop = await _create_property(client, ds_id, "Due", "date")
    checkbox_prop = await _create_property(client, ds_id, "Done", "checkbox")
    select_prop = await _create_property(client, ds_id, "Priority", "select", config={
        "options": [{"id": "opt_hi", "name": "High", "color": "red"}]
    })
    multi_prop = await _create_property(client, ds_id, "Topics", "multi_select", config={
        "options": [
            {"id": "opt_a", "name": "rust", "color": "orange"},
            {"id": "opt_b", "name": "async", "color": "blue"},
        ]
    })
    text_prop = await _create_property(client, ds_id, "Notes", "rich_text")

    await _insert_row(
        db_conn, test_user, ds_id,
        {
            title_key: {"type": "title", "title": "Row 1"},
            number_prop["key"]: {"type": "number", "number": 42},
            date_prop["key"]: {"type": "date", "date": {"start": "2026-09-01T00:00:00Z"}},
            checkbox_prop["key"]: {"type": "checkbox", "checkbox": True},
            select_prop["key"]: {"type": "select", "select": "opt_hi"},
            multi_prop["key"]: {"type": "multi_select", "multi_select": ["opt_a", "opt_b"]},
            text_prop["key"]: {"type": "rich_text", "rich_text": "hello world"},
        },
    )

    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={default_view_id}")
    assert res.status_code == 200, res.text
    rows = _rows(res.text)
    header = rows[0]
    body = dict(zip(header, rows[1]))

    assert body["Count"] == "42"
    assert body["Due"] == "2026-09-01"
    assert body["Done"] == "Yes"
    assert body["Priority"] == "High"
    assert body["Topics"] == "rust, async"
    assert body["Notes"] == "hello world"


# ---------------------------------------------------------------------------
# Empty data source: header-only CSV, not an error.
# ---------------------------------------------------------------------------

async def test_empty_data_source_exports_header_only_csv(client):
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    default_view_id = created["views"][0]["id"]

    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={default_view_id}")
    assert res.status_code == 200, res.text
    rows = _rows(res.text)
    assert rows == [["id", "Title"]]


# ---------------------------------------------------------------------------
# All Notes is explicitly not a supported export target -- 400, not a
# misleading 404/500.
# ---------------------------------------------------------------------------

async def test_all_notes_export_is_400_not_a_silent_success(client):
    res = await client.get(f"/db/data-sources/{ALL_NOTES_ID}/export?view_id={uuid.uuid4()}")
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# Cross-tenant: a view id belonging to another user 404s -- not a silent
# cross-tenant leak. Mutation-tested below (Milestone 2's own guard-test
# convention).
# ---------------------------------------------------------------------------

async def test_export_404s_for_a_view_id_belonging_to_another_user(client, db_conn, test_user):
    created = await _create_database(client, "Mine")
    ds_id = created["data_source"]["id"]
    own_view_id = created["views"][0]["id"]

    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    other_db = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'Other') RETURNING id", other_user
    )
    other_ds = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, 'Default') RETURNING id",
        other_db["id"], other_user,
    )
    other_view = await db_conn.fetchrow(
        "INSERT INTO db_views (data_source_id, user_id, name, type) VALUES ($1, $2, 'Theirs', 'table') RETURNING id",
        other_ds["id"], other_user,
    )

    # Case 1: the caller's own data source, but a view id that belongs to another
    # user entirely (not even on this data source) -- must not resolve.
    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={other_view['id']}")
    assert res.status_code == 404

    # Case 2: the other user's OWN data source + their OWN view id -- the exact
    # shape a well-formed but not-owned request would take.
    res = await client.get(f"/db/data-sources/{other_ds['id']}/export?view_id={other_view['id']}")
    assert res.status_code == 404

    # Sanity: the caller's own view against their own data source still works,
    # proving the 404s above are the ownership check, not a broken route.
    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={own_view_id}")
    assert res.status_code == 200


# ---------------------------------------------------------------------------
# Fix 3 (task-51, M14 final cross-cutting review): the export's own synthetic
# "id" header must not corrupt an export -> import -> export -> import round
# trip, and `db_import.py` must treat an "id" header in a USER'S OWN CSV as
# reserved metadata too (not just this app's own re-imported export).
# ---------------------------------------------------------------------------


async def test_export_import_export_import_round_trip_never_duplicate_header_400s(
    client, db_conn, test_user
):
    """The exact reviewer-reported repro: export -> import -> export -> import must
    succeed cleanly at EVERY step. Pre-fix: the first re-import treated the
    exported "id" column as an ordinary data column and created a REAL property
    literally named "id" for it; the second export then emitted TWO "id" headers
    (its own synthetic one + the now-real property), and the second re-import
    400ed with "CSV headers must be unique -- found a duplicate: 'id'"."""
    created = await _create_database(client, "Round Trip")
    ds_id = created["data_source"]["id"]
    view_id = created["views"][0]["id"]
    title_key = created["properties"][0]["key"]
    author_prop = await _create_property(client, ds_id, "Author", "rich_text")

    await _insert_row(
        db_conn, test_user, ds_id,
        {
            title_key: {"type": "title", "title": "Dune"},
            author_prop["key"]: {"type": "rich_text", "rich_text": "Herbert"},
        },
    )

    # Export #1.
    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={view_id}")
    assert res.status_code == 200, res.text
    csv_1 = res.text
    assert _rows(csv_1)[0] == ["id", "Title", "Author"]

    # Import #1 (of export #1's own output) -- a brand new database.
    res = await client.post(
        "/db/import/csv",
        data={"database_title": "Reimported 1"},
        files={"file": ("export1.csv", csv_1.encode("utf-8"), "text/csv")},
    )
    assert res.status_code == 201, res.text
    reimport_1 = res.json()
    by_header_1 = {c["header"]: c for c in reimport_1["columns"]}
    # The reserved "id" column is reported (diagnostics), but produced NO
    # real property -- see the property-list assertion further below.
    assert by_header_1["id"]["inferred_type"] == "id (reserved, not imported)"
    assert by_header_1["Title"]["inferred_type"] == "title"
    assert by_header_1["Author"]["inferred_type"] == "rich_text"

    res = await client.get(f"/db/databases/{reimport_1['database_id']}")
    assert res.status_code == 200, res.text
    detail = res.json()
    ds_id_2 = detail["data_source"]["id"]
    view_id_2 = detail["views"][0]["id"]

    # Export #2 (of import #1's own database) -- must NOT carry two "id" headers.
    res = await client.get(f"/db/data-sources/{ds_id_2}/export?view_id={view_id_2}")
    assert res.status_code == 200, res.text
    csv_2 = res.text
    header_2 = _rows(csv_2)[0]
    assert header_2.count("id") == 1
    assert header_2 == ["id", "Title", "Author"]

    # Import #2 (of export #2's own output) -- the exact step that 500/400ed
    # pre-fix on a duplicate "id" header. Must succeed cleanly.
    res = await client.post(
        "/db/import/csv",
        data={"database_title": "Reimported 2"},
        files={"file": ("export2.csv", csv_2.encode("utf-8"), "text/csv")},
    )
    assert res.status_code == 201, res.text
    reimport_2 = res.json()
    by_header_2 = {c["header"]: c for c in reimport_2["columns"]}
    assert by_header_2["id"]["inferred_type"] == "id (reserved, not imported)"
    assert by_header_2["Title"]["inferred_type"] == "title"


async def test_id_header_alongside_a_real_title_header_produces_no_property_and_correct_titles(
    client,
):
    """An `id` column AND a `Title` column (title correctly detected by name):
    the `id` column produces NO property and no data in any row, and titles
    are the real title text, never the raw id."""
    csv_text = (
        "id,Title,Author\n"
        "11111111-1111-1111-1111-111111111111,Dune,Herbert\n"
        "22222222-2222-2222-2222-222222222222,Foundation,Asimov\n"
    )
    res = await client.post(
        "/db/import/csv",
        data={"database_title": "IdPlusTitle"},
        files={"file": ("data.csv", csv_text.encode("utf-8"), "text/csv")},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    by_header = {c["header"]: c for c in body["columns"]}
    assert by_header["id"]["inferred_type"] == "id (reserved, not imported)"
    assert by_header["Title"]["inferred_type"] == "title"
    assert by_header["Author"]["inferred_type"] == "rich_text"

    res = await client.get(f"/db/databases/{body['database_id']}")
    props = {p["name"]: p for p in res.json()["properties"]}
    assert "id" not in props  # no property was created for the reserved column

    rows_res = await client.get(f"/db/data-sources/{props['Title']['data_source_id']}/rows")
    titles = {
        r["properties"][props["Title"]["key"]]["title"] for r in rows_res.json()["rows"]
    }
    assert titles == {"Dune", "Foundation"}  # never the raw uuid strings


async def test_id_header_with_no_title_match_falls_back_to_first_non_id_column(client):
    """An `id` column and NO title-matching header: title falls back to the first
    NON-`id` column, not to the `id` column itself (pre-fix: the index-0
    fallback landed on `id`, so every row's title silently became a raw UUID
    string)."""
    csv_text = (
        "id,Widget,Count\n"
        "11111111-1111-1111-1111-111111111111,Gadget,5\n"
        "22222222-2222-2222-2222-222222222222,Gizmo,7\n"
    )
    res = await client.post(
        "/db/import/csv",
        data={"database_title": "IdNoTitleMatch"},
        files={"file": ("data.csv", csv_text.encode("utf-8"), "text/csv")},
    )
    assert res.status_code == 201, res.text
    body = res.json()
    by_header = {c["header"]: c for c in body["columns"]}
    assert by_header["id"]["inferred_type"] == "id (reserved, not imported)"
    assert by_header["Widget"]["inferred_type"] == "title"
    assert by_header["Count"]["inferred_type"] == "number"

    res = await client.get(f"/db/databases/{body['database_id']}")
    props = {p["name"]: p for p in res.json()["properties"]}
    rows_res = await client.get(f"/db/data-sources/{props['Widget']['data_source_id']}/rows")
    titles = {r["properties"][props["Widget"]["key"]]["title"] for r in rows_res.json()["rows"]}
    assert titles == {"Gadget", "Gizmo"}


# ---------------------------------------------------------------------------
# Fix 4 (task-51, M14 final cross-cutting review): formula/rollup columns
# export the computed value, not blank.
# ---------------------------------------------------------------------------


async def test_formula_column_exports_the_computed_number_not_blank(client):
    """`query_rows` already merges the row's materialised formula result into
    `row["properties"][key]`, tagged with the RESULT's own type (e.g. `{"type":
    "number", "number": 42.0}`), not literally `"formula"` -- pre-fix, the export
    loop unwrapped by the PROPERTY's declared type ("formula"), which was never a
    key on that wrapper, so the cell was always blank."""
    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    default_view_id = created["views"][0]["id"]
    title_key = created["properties"][0]["key"]

    score_prop = await _create_property(client, ds_id, "Score", "number")
    formula_prop = await _create_property(
        client, ds_id, "Doubled", "formula",
        config={"expression": 'prop("Score") * 2'},
    )

    res = await client.post(f"/db/data-sources/{ds_id}/rows")
    assert res.status_code == 201, res.text
    row_id = res.json()["id"]
    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": title_key, "value": {"type": "title", "title": "Row 1"}},
    )
    assert res.status_code == 200, res.text
    res = await client.patch(
        f"/db/data-sources/{ds_id}/rows/{row_id}",
        json={"property_key": score_prop["key"], "value": {"type": "number", "number": 21.0}},
    )
    assert res.status_code == 200, res.text
    assert res.json()["properties"][formula_prop["key"]]["number"] == 42.0

    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={default_view_id}")
    assert res.status_code == 200, res.text
    rows = _rows(res.text)
    header = rows[0]
    body = dict(zip(header, rows[1]))
    assert body["Doubled"] == "42"  # not "" (blank)


async def test_rollup_column_exports_the_computed_count_not_blank(client):
    """A rollup's computed result is ALSO tagged with its own result type on the
    merged wrapper (never literally "rollup") -- same fix, exercised through a
    different (list-shaped) result path than the formula test above."""
    owner = await _create_database(client, "Owners")
    target = await _create_database(client, "Targets")
    owner_ds, target_ds = owner["data_source"]["id"], target["data_source"]["id"]
    owner_view_id = owner["views"][0]["id"]
    owner_title_key = owner["properties"][0]["key"]

    rel = (
        await client.post(
            f"/db/data-sources/{owner_ds}/relations",
            json={"name": "Rel", "target_data_source_id": target_ds, "two_way": False},
        )
    ).json()
    rel_key = rel["forward"]["key"]

    target_num = await _create_property(client, target_ds, "Value", "number")
    rollup_prop = await _create_property(
        client, owner_ds, "Count", "rollup",
        config={
            "relation_key": rel_key, "target_data_source_id": target_ds,
            "target_key": target_num["key"], "function": "count",
        },
    )

    owner_row = (await client.post(f"/db/data-sources/{owner_ds}/rows")).json()["id"]
    target_row_1 = (await client.post(f"/db/data-sources/{target_ds}/rows")).json()["id"]
    target_row_2 = (await client.post(f"/db/data-sources/{target_ds}/rows")).json()["id"]

    for target_row_id in (target_row_1, target_row_2):
        res = await client.post(
            f"/db/data-sources/{owner_ds}/rows/{owner_row}/relations/{rel_key}/links",
            json={"row_id": target_row_id},
        )
        assert res.status_code in (200, 201), res.text

    # Linking alone does not trigger a recompute of the OWNER row's rollup
    # (only a subsequent row-write does, `services/db/rows.py`'s
    # `update_row_property_core`) -- a trivial title edit is enough to force
    # one, the same way a real user editing any cell on the row would.
    res = await client.patch(
        f"/db/data-sources/{owner_ds}/rows/{owner_row}",
        json={"property_key": owner_title_key, "value": {"type": "title", "title": "Owner Row"}},
    )
    assert res.status_code == 200, res.text
    assert res.json()["properties"][rollup_prop["key"]]["number"] == 2.0

    res = await client.get(f"/db/data-sources/{owner_ds}/export?view_id={owner_view_id}")
    assert res.status_code == 200, res.text
    rows = _rows(res.text)
    header = rows[0]
    body = dict(zip(header, rows[1]))
    assert body["Count"] == "2"  # not "" (blank)


# ---------------------------------------------------------------------------
# Fix 5 (task-51, M14 final cross-cutting review): a truncated export must say
# so via the `X-Export-Truncated` response header; an untruncated one must not.
# ---------------------------------------------------------------------------


async def test_truncated_export_sets_the_truncation_header(client, db_conn, test_user, monkeypatch):
    """`_ROWS_LIMIT` monkeypatched down to a small number -- same precedent
    `test_databases_router.py`'s own `test_list_rows_caps_*_at_the_hard_limit`
    tests already establish for testing this exact constant, rather than
    actually creating 501+ rows."""
    import routers.databases as databases_module

    monkeypatch.setattr(databases_module, "_ROWS_LIMIT", 3, raising=False)

    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    default_view_id = created["views"][0]["id"]
    title_key = created["properties"][0]["key"]

    for i in range(5):
        await _insert_row(
            db_conn, test_user, ds_id, {title_key: {"type": "title", "title": f"Row {i}"}},
        )

    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={default_view_id}")
    assert res.status_code == 200, res.text
    assert res.headers.get("x-export-truncated") == "true"
    rows = _rows(res.text)
    assert len(rows) == 1 + 3  # header + _ROWS_LIMIT rows, not all 5


async def test_untruncated_export_never_sets_the_truncation_header(
    client, db_conn, test_user, monkeypatch
):
    import routers.databases as databases_module

    monkeypatch.setattr(databases_module, "_ROWS_LIMIT", 3, raising=False)

    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    default_view_id = created["views"][0]["id"]
    title_key = created["properties"][0]["key"]

    # Fewer rows than the (lowered) cap -- never truncated.
    for i in range(2):
        await _insert_row(
            db_conn, test_user, ds_id, {title_key: {"type": "title", "title": f"Row {i}"}},
        )

    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={default_view_id}")
    assert res.status_code == 200, res.text
    assert "x-export-truncated" not in res.headers


async def test_export_exactly_at_the_limit_is_not_truncated(
    client, db_conn, test_user, monkeypatch
):
    """The genuinely ambiguous case `_fetch_all_export_rows`'s own probe exists
    for: exactly `_ROWS_LIMIT` rows, no more -- the loop's own exit condition
    can't tell this apart from "there are more" on its own (both end with a
    FULL last page), so this is the one case that actually exercises the extra
    probe query rather than the cheap `break`-on-underfull-page path."""
    import routers.databases as databases_module

    monkeypatch.setattr(databases_module, "_ROWS_LIMIT", 3, raising=False)

    created = await _create_database(client)
    ds_id = created["data_source"]["id"]
    default_view_id = created["views"][0]["id"]
    title_key = created["properties"][0]["key"]

    for i in range(3):
        await _insert_row(
            db_conn, test_user, ds_id, {title_key: {"type": "title", "title": f"Row {i}"}},
        )

    res = await client.get(f"/db/data-sources/{ds_id}/export?view_id={default_view_id}")
    assert res.status_code == 200, res.text
    assert "x-export-truncated" not in res.headers
    rows = _rows(res.text)
    assert len(rows) == 1 + 3
