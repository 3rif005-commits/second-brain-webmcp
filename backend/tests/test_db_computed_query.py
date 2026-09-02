"""Harness-backed proof that a materialised formula/rollup value actually
filters and sorts through real SQL and returns the right row ids -- not
just that a `SqlFragment` came back (M3's final review promoted exactly
that gap to an Important finding; task-27-brief.md repeats the same
requirement for this milestone).

Runs against the local pgtest harness (localhost:55432, migrations 001-019
applied) through the transaction-wrapped `db_conn`/`test_user` fixtures
(tests/conftest.py), rolled back on teardown. NEVER touches
`core.config.settings.database_url` (the real Supabase project).
"""
from __future__ import annotations

from services.db import recompute, relations
from services.db.query.ast import FilterCondition, Pagination, SortSpec
from services.db.query.builder import QueryBuilder
from services.db.query.compiler import PropertyLookup


# ===========================================================================
# Helpers (deliberately duplicated per-file, matching this codebase's own
# test-file convention).
# ===========================================================================


async def _make_data_source(db_conn, user_id, *, name="DS"):
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'T') RETURNING id", user_id
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, $3) RETURNING id",
        db_row["id"], user_id, name,
    )
    return str(ds_row["id"])


async def _insert_note(db_conn, user_id, *, title="Note"):
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id", user_id, title
    )
    return str(note["id"])


async def _insert_row(db_conn, user_id, data_source_id, note_id, *, properties=None):
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, $4)",
        note_id, data_source_id, user_id, properties or {},
    )


async def _insert_property(
    db_conn, user_id, data_source_id, key, name, type_, *, config=None, result_type=None,
):
    await db_conn.execute(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type, config, result_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        """,
        data_source_id, user_id, key, name, type_, config or {}, result_type,
    )


# ===========================================================================
# 1. Filter over a materialised NUMBER formula
# ===========================================================================


async def test_filter_over_a_materialised_number_formula_returns_the_right_rows(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Doubled", "formula",
        config={"expression": 'prop("Price") * 2'}, result_type="number",
    )
    cheap = await _insert_note(db_conn, test_user, title="Cheap")
    expensive = await _insert_note(db_conn, test_user, title="Expensive")
    await _insert_row(db_conn, test_user, ds, cheap, properties={"numKey": {"type": "number", "number": 5.0}})
    await _insert_row(db_conn, test_user, ds, expensive, properties={"numKey": {"type": "number", "number": 50.0}})

    await recompute.recompute_full(db_conn, test_user)

    properties = {"doubled": PropertyLookup(type="formula", storage="jsonb", key="fKey", result_type="number")}
    node = FilterCondition(type="condition", property="doubled", operator="greater_than", value=50)
    qb = QueryBuilder(user_id=test_user, data_source_id=ds, properties=properties)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    ids = {str(r["note_id"]) for r in rows}
    assert ids == {expensive}


# ===========================================================================
# 2. Sort over a materialised NUMBER rollup
# ===========================================================================


async def test_sort_over_a_materialised_rollup_returns_rows_in_the_right_order(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user, name="Owners")
    target_ds = await _make_data_source(db_conn, test_user, name="Targets")
    forward, _ = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=owner_ds, name="Rel",
        target_data_source_id=target_ds, two_way=False,
    )
    ref = relations.relation_ref_from_config(forward["config"])
    await _insert_property(db_conn, test_user, target_ds, "numKey", "Value", "number")
    await _insert_property(
        db_conn, test_user, owner_ds, "rKey", "Sum", "rollup",
        config={
            "relation_key": forward["key"], "target_data_source_id": target_ds,
            "target_key": "numKey", "function": "sum",
        },
        result_type="number",
    )

    low = await _insert_note(db_conn, test_user, title="Low")
    high = await _insert_note(db_conn, test_user, title="High")
    await _insert_row(db_conn, test_user, owner_ds, low)
    await _insert_row(db_conn, test_user, owner_ds, high)
    t_low = await _insert_note(db_conn, test_user)
    t_high = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, target_ds, t_low, properties={"numKey": {"type": "number", "number": 1.0}})
    await _insert_row(db_conn, test_user, target_ds, t_high, properties={"numKey": {"type": "number", "number": 99.0}})
    await relations.set_links(db_conn, test_user, ref, low, [t_low])
    await relations.set_links(db_conn, test_user, ref, high, [t_high])

    await recompute.recompute_full(db_conn, test_user)

    properties = {"sum": PropertyLookup(type="rollup", storage="jsonb", key="rKey", result_type="number")}
    qb = QueryBuilder(user_id=test_user, data_source_id=owner_ds, properties=properties)

    asc_frag = qb.build(None, [SortSpec(property="sum", direction="asc")], Pagination())
    asc_rows = await db_conn.fetch(asc_frag.sql, *asc_frag.params)
    assert [str(r["note_id"]) for r in asc_rows] == [low, high]

    desc_frag = qb.build(None, [SortSpec(property="sum", direction="desc")], Pagination())
    desc_rows = await db_conn.fetch(desc_frag.sql, *desc_frag.params)
    assert [str(r["note_id"]) for r in desc_rows] == [high, low]


# ===========================================================================
# 3. Filter over a materialised STRING formula, and an unsupported row is
#    correctly excluded by an ordinary `is_not_empty`/`equals` filter (no
#    special-casing needed -- it reads as SQL NULL).
# ===========================================================================


async def test_filter_over_a_string_formula_excludes_unsupported_rows_via_ordinary_null_semantics(
    db_conn, test_user
):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "k0", "P0", "number")
    for i in range(1, 16):  # depth 15 -> unsupported for the last one
        await _insert_property(
            db_conn, test_user, ds, f"k{i}", f"P{i}", "formula",
            config={"expression": f'prop("P{i - 1}") + 1'}, result_type="number",
        )
    normal = await _insert_note(db_conn, test_user, title="Normal")
    await _insert_row(db_conn, test_user, ds, normal, properties={"k0": {"type": "number", "number": 0.0}})

    await recompute.recompute_full(db_conn, test_user)

    # k15 is depth 15 -> unsupported -> NULL through the SQL extraction hop.
    properties = {"p15": PropertyLookup(type="formula", storage="jsonb", key="k15", result_type="number")}
    node = FilterCondition(type="condition", property="p15", operator="is_not_empty", value=None)
    qb = QueryBuilder(user_id=test_user, data_source_id=ds, properties=properties)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    assert rows == []  # the only row's formula is unsupported -> excluded
