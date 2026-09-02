"""Injection-defence proof for the M3 filter compiler (spec §8.2's "three
-layer defence"): property keys and values containing
`'; DROP TABLE notes; --` must appear only as bound parameters and never in
the compiled SQL string, and executing the resulting query must never
affect `notes`.

Runs against the local pgtest harness (see tests/conftest.py's `db_conn`).
"""
from __future__ import annotations

import pytest

from services.db.query.ast import FilterCondition, FilterGroup
from services.db.query.operators import FilterValidationError
from services.db.query.compiler import PropertyLookup, compile_filter
from services.db.query.builder import QueryBuilder
from services.db.query.ast import Pagination
from services.db.relations import RelationRef

PAYLOAD = "'; DROP TABLE notes; --"

_TITLE_LOOKUP = {"title": PropertyLookup(type="title", storage="jsonb", key="a1b2c3d4")}


# ---------------------------------------------------------------------------
# Layer 1: the property key is never SQL. An unknown key (this payload is
# never a real property) must raise before any SQL is ever built.
# ---------------------------------------------------------------------------


def test_payload_as_property_key_raises_before_reaching_sql():
    node = FilterCondition(type="condition", property=PAYLOAD, operator="equals", value="x")
    with pytest.raises(FilterValidationError):
        compile_filter(node, _TITLE_LOOKUP, user_id="u-1", alias="p")


def test_payload_as_property_key_nested_in_group_raises():
    node = FilterGroup(
        type="group",
        op="and",
        children=[
            FilterCondition(type="condition", property="title", operator="equals", value="ok"),
            FilterGroup(
                type="group",
                op="or",
                children=[
                    FilterCondition(type="condition", property=PAYLOAD, operator="equals", value="x"),
                ],
            ),
        ],
    )
    with pytest.raises(FilterValidationError):
        compile_filter(node, _TITLE_LOOKUP, user_id="u-1", alias="p")


# ---------------------------------------------------------------------------
# Layer 1, other direction: a real, valid key with the payload as its
# *value*. The compiled SQL text must contain no substring of the literal
# payload anywhere, and executing it must not affect `notes`.
# ---------------------------------------------------------------------------


async def _notes_count(db_conn) -> int:
    return await db_conn.fetchval("SELECT count(*) FROM notes")


async def _notes_table_exists(db_conn) -> bool:
    return await db_conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notes')"
    )


async def _make_ordinary_source(db_conn, user_id) -> str:
    """jsonb-storage properties only exist under an ordinary data source
    (`db_row_props.properties`) — the All Notes virtual source has no jsonb
    column at all, so these injection checks (all jsonb-storage properties)
    need a real `db_data_sources` row, same as test_db_compiler.py."""
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'T') RETURNING id", user_id
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, 'Default') RETURNING id",
        db_row["id"], user_id,
    )
    return str(ds_row["id"])


async def _run_and_assert_safe(db_conn, test_user, node, properties):
    before = await _notes_count(db_conn)

    frag = compile_filter(node, properties, user_id=test_user, alias="p")
    # The literal payload must never appear in the compiled SQL text.
    assert PAYLOAD not in frag.sql
    assert "DROP TABLE" not in frag.sql.upper()
    # It must appear only as a bound parameter.
    assert PAYLOAD in frag.params or any(
        isinstance(p, list) and PAYLOAD in p for p in frag.params
    )

    data_source_id = await _make_ordinary_source(db_conn, test_user)
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=properties)
    built = qb.build(node, [], Pagination())
    assert PAYLOAD not in built.sql
    assert "DROP TABLE" not in built.sql.upper()

    # Execute it — the strongest possible proof: notes must still exist and
    # row count must be unchanged.
    await db_conn.fetch(built.sql, *built.params)

    assert await _notes_table_exists(db_conn)
    after = await _notes_count(db_conn)
    assert after == before


async def test_payload_as_scalar_value_never_leaks_into_sql(db_conn, test_user):
    node = FilterCondition(type="condition", property="title", operator="equals", value=PAYLOAD)
    await _run_and_assert_safe(db_conn, test_user, node, _TITLE_LOOKUP)


# ---------------------------------------------------------------------------
# Same payload embedded in a str_or_list array value.
# ---------------------------------------------------------------------------

_SELECT_LOOKUP = {"choice": PropertyLookup(type="select", storage="jsonb", key="b2c3d4e5")}


async def test_payload_in_str_or_list_array_never_leaks_into_sql(db_conn, test_user):
    node = FilterCondition(
        type="condition", property="choice", operator="equals", value=["safe", PAYLOAD]
    )
    await _run_and_assert_safe(db_conn, test_user, node, _SELECT_LOOKUP)


# ---------------------------------------------------------------------------
# Same payload two levels deep in a nested group, to prove renumbering
# doesn't create a seam where a value leaks into literal SQL text.
# ---------------------------------------------------------------------------


async def test_payload_nested_two_levels_deep_never_leaks_into_sql(db_conn, test_user):
    node = FilterGroup(
        type="group",
        op="and",
        children=[
            FilterCondition(type="condition", property="title", operator="is_not_empty", value=None),
            FilterGroup(
                type="group",
                op="or",
                children=[
                    FilterCondition(
                        type="condition", property="title", operator="equals", value="safe"
                    ),
                    FilterGroup(
                        type="group",
                        op="and",
                        children=[
                            FilterCondition(
                                type="condition",
                                property="title",
                                operator="contains",
                                value=PAYLOAD,
                            ),
                        ],
                    ),
                ],
            ),
        ],
    )
    await _run_and_assert_safe(db_conn, test_user, node, _TITLE_LOOKUP)


async def test_payload_nested_two_levels_deep_in_str_or_list_never_leaks(db_conn, test_user):
    node = FilterGroup(
        type="group",
        op="or",
        children=[
            FilterCondition(type="condition", property="title", operator="is_empty", value=None),
            FilterGroup(
                type="group",
                op="and",
                children=[
                    FilterCondition(
                        type="condition",
                        property="choice",
                        operator="does_not_equal",
                        value=[PAYLOAD, "other"],
                    ),
                ],
            ),
        ],
    )
    await _run_and_assert_safe(
        db_conn, test_user, node, {**_TITLE_LOOKUP, **_SELECT_LOOKUP}
    )


# ---------------------------------------------------------------------------
# Final harness leak-check: notes still exists, and the transaction-per-test
# rollback (tests/conftest.py's db_conn) means running this whole file
# leaves zero row growth. This test itself adds a belt-and-suspenders check
# within its own transaction.
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Milestone 7 (task-20): relation's "uuid" arg_type must reject the
# injection payload at coercion, the same layer-1 defence an unknown
# property key gets -- and the leakage sweep must exercise the new
# EXISTS/NOT EXISTS branch too, not just the pre-existing JSONB-shaped
# families every test above covers.
# ---------------------------------------------------------------------------

_RELATION_LOOKUP = {
    "rel": PropertyLookup(
        type="relation",
        storage="jsonb",
        key="c3d4e5f6",
        relation=RelationRef(relation_id="11111111-1111-1111-1111-111111111111", side="forward"),
    )
}


def test_relation_payload_value_rejected_by_uuid_coercion_before_reaching_sql():
    node = FilterCondition(type="condition", property="rel", operator="contains", value=PAYLOAD)
    with pytest.raises(FilterValidationError):
        compile_filter(node, _RELATION_LOOKUP, user_id="u-1", alias="p")


async def test_relation_exists_branch_survives_and_returns_right_row(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    relation_id = "22222222-2222-2222-2222-222222222222"
    row_note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'row') RETURNING id", test_user
    )
    target_note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, 'target') RETURNING id", test_user
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, '{}')",
        row_note["id"], data_source_id, test_user,
    )
    await db_conn.execute(
        "INSERT INTO db_relation_links (user_id, relation_id, from_row_id, to_row_id) VALUES ($1, $2, $3, $4)",
        test_user, relation_id, row_note["id"], target_note["id"],
    )

    lookup = {
        "rel": PropertyLookup(
            type="relation",
            storage="jsonb",
            key="c3d4e5f6",
            relation=RelationRef(relation_id=relation_id, side="forward"),
        )
    }
    node = FilterCondition(
        type="condition", property="rel", operator="contains", value=str(target_note["id"])
    )
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    built = qb.build(node, [], Pagination())
    assert "EXISTS" in built.sql
    assert PAYLOAD not in built.sql
    assert "DROP TABLE" not in built.sql.upper()

    rows = await db_conn.fetch(built.sql, *built.params)
    assert {str(r["note_id"]) for r in rows} == {str(row_note["id"])}
    assert await _notes_table_exists(db_conn)


async def test_notes_table_survives_the_whole_suite(db_conn, test_user):
    assert await _notes_table_exists(db_conn)
    before = await _notes_count(db_conn)
    node = FilterCondition(type="condition", property="title", operator="contains", value=PAYLOAD)
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=_TITLE_LOOKUP)
    built = qb.build(node, [], Pagination())
    await db_conn.fetch(built.sql, *built.params)
    assert await _notes_table_exists(db_conn)
    assert await _notes_count(db_conn) == before
