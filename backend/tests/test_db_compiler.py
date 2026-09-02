"""Tests for services/db/query/compiler.py and services/db/query/builder.py:
turning Task 11's filter AST into executable SQL, resolving property keys,
compiling sorts, and assembling the two query-builder modes (All Notes vs.
an ordinary data source).

Runs against the local pgtest harness (localhost:55432, migrations 001-019
applied — see repo root's `scripts/pgtest/up.sh`/`apply.sh`) through the
transaction-wrapped `db_conn`/`test_user` fixtures (tests/conftest.py),
rolled back on teardown. NEVER touches `core.config.settings.database_url`
(the real Supabase project).
"""
from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest
from fastapi import HTTPException

from services.db.properties.base import REGISTRY, SqlContext, SqlFragment
from services.db.properties.columns import COLUMN_BACKED
from services.db.relations import RelationRef
from services.db.query.ast import (
    FilterCondition,
    FilterGroup,
    Pagination,
    SortSpec,
    parse_filter,
)
from services.db.query.operators import TYPE_OPERATORS, FilterValidationError
from services.db.query.compiler import (
    PropertyLookup,
    compile_filter,
    compile_sorts,
    filter_validation_error_to_http,
    renumber,
)
from services.db.query.builder import QueryBuilder


# ---------------------------------------------------------------------------
# renumber()
# ---------------------------------------------------------------------------


def test_renumber_shifts_placeholders_and_keeps_params_order():
    frag = SqlFragment("a = $1 AND b = $2", ("x", "y"))
    shifted = renumber(frag, start=3)
    assert shifted.sql == "a = $3 AND b = $4"
    assert shifted.params == ("x", "y")


def test_renumber_start_1_is_a_noop_on_sql_text():
    frag = SqlFragment("a = $1", ("x",))
    shifted = renumber(frag, start=1)
    assert shifted.sql == "a = $1"


def test_renumber_handles_double_digit_placeholders_without_collision():
    # 9 params -> $9, shifting by +5 must produce $14, not something that
    # collides with an intermediate $1 substitution.
    sql = " AND ".join(f"c{i} = ${i}" for i in range(1, 10))
    frag = SqlFragment(sql, tuple(range(1, 10)))
    shifted = renumber(frag, start=6)
    expected = " AND ".join(f"c{i} = ${i + 5}" for i in range(1, 10))
    assert shifted.sql == expected


def test_renumber_no_params_leaves_sql_untouched():
    frag = SqlFragment("TRUE", ())
    shifted = renumber(frag, start=5)
    assert shifted.sql == "TRUE"
    assert shifted.params == ()


# ---------------------------------------------------------------------------
# compile_filter — resolution, unknown keys, renumbering through groups
# ---------------------------------------------------------------------------

_TITLE_LOOKUP = {"title": PropertyLookup(type="title", storage="jsonb", key="a1b2c3d4")}
_TWO_PROP_LOOKUP = {
    "title": PropertyLookup(type="title", storage="jsonb", key="a1b2c3d4"),
    "num": PropertyLookup(type="number", storage="jsonb", key="z9y8x7w6"),
}


def test_compile_filter_none_returns_true_with_no_params():
    frag = compile_filter(None, _TITLE_LOOKUP, user_id="u-1", alias="p")
    assert frag.sql == "TRUE"
    assert frag.params == ()


def test_compile_filter_single_condition():
    node = FilterCondition(type="condition", property="title", operator="equals", value="hi")
    frag = compile_filter(node, _TITLE_LOOKUP, user_id="u-1", alias="p")
    assert frag.params == ("hi",)
    assert "$1" in frag.sql


def test_compile_filter_unknown_key_raises():
    node = FilterCondition(type="condition", property="nope", operator="equals", value="hi")
    with pytest.raises(FilterValidationError):
        compile_filter(node, _TITLE_LOOKUP, user_id="u-1", alias="p")


def test_compile_filter_unknown_key_nested_in_group_raises():
    node = FilterGroup(
        type="group",
        op="and",
        children=[
            FilterCondition(type="condition", property="title", operator="equals", value="hi"),
            FilterGroup(
                type="group",
                op="or",
                children=[
                    FilterCondition(type="condition", property="ghost", operator="equals", value="x"),
                ],
            ),
        ],
    )
    with pytest.raises(FilterValidationError):
        compile_filter(node, _TITLE_LOOKUP, user_id="u-1", alias="p")


def test_compile_filter_group_renumbers_children_params_contiguously():
    node = FilterGroup(
        type="group",
        op="and",
        children=[
            FilterCondition(type="condition", property="title", operator="equals", value="hi"),
            FilterCondition(type="condition", property="num", operator="greater_than", value=10),
        ],
    )
    frag = compile_filter(node, _TWO_PROP_LOOKUP, user_id="u-1", alias="p")
    assert frag.params == ("hi", 10)
    assert "$1" in frag.sql and "$2" in frag.sql
    assert "$3" not in frag.sql
    assert frag.sql.startswith("(") and frag.sql.endswith(")")


def test_filter_validation_error_to_http_maps_to_400():
    exc = filter_validation_error_to_http(FilterValidationError("bad"))
    assert isinstance(exc, HTTPException)
    assert exc.status_code == 400


# ---------------------------------------------------------------------------
# compile_sorts
# ---------------------------------------------------------------------------


def test_compile_sorts_empty_list_is_empty_fragment():
    frag = compile_sorts([], _TITLE_LOOKUP, user_id="u-1", alias="p")
    assert frag.sql == ""


def test_compile_sorts_unknown_key_raises():
    with pytest.raises(FilterValidationError):
        compile_sorts([SortSpec(property="ghost")], _TITLE_LOOKUP, user_id="u-1", alias="p")


def test_compile_sorts_uses_registry_sql_order():
    frag = compile_sorts([SortSpec(property="title", direction="asc")], _TITLE_LOOKUP, user_id="u-1", alias="p")
    expected = REGISTRY["title"].sql_order(
        SqlContext(key="a1b2c3d4", alias="p", storage="jsonb"), "asc"
    ).sql
    assert frag.sql == expected


def test_compile_sorts_joins_multiple_with_comma():
    frag = compile_sorts(
        [SortSpec(property="title", direction="asc"), SortSpec(property="num", direction="desc")],
        _TWO_PROP_LOOKUP,
        user_id="u-1",
        alias="p",
    )
    assert ", " in frag.sql
    assert frag.sql.count(",") == 1


def test_compile_sorts_unresolvable_registry_type_raises_filter_validation_error_not_keyerror():
    # A PropertyLookup.type that isn't a real REGISTRY key (corrupt data, a
    # typo) must fail the same way an unknown property key does — a bare
    # `REGISTRY[lookup.type]` KeyError would surface as an uncaught 500
    # instead of the FilterValidationError -> 400 every other bad-input path
    # in this module gives.
    bogus_lookup = {"x": PropertyLookup(type="not_a_real_type", storage="jsonb", key="a1b2c3d4")}
    with pytest.raises(FilterValidationError):
        compile_sorts([SortSpec(property="x", direction="asc")], bogus_lookup, user_id="u-1", alias="p")


def test_compile_sorts_accepts_place_and_button_types_unlike_compile_filter():
    # Deliberate asymmetry with compile_filter (see compiler.py's
    # compile_sorts docstring): place/button are absent from TYPE_OPERATORS
    # entirely (never filterable), but both still have a working generic
    # REGISTRY entry, so sorting by one is not rejected here.
    lookup = {"pl": PropertyLookup(type="place", storage="jsonb", key="a1b2c3d4")}
    frag = compile_sorts([SortSpec(property="pl", direction="asc")], lookup, user_id="u-1", alias="p")
    assert frag.sql


def test_compile_sorts_accepts_a_result_typed_formula_or_rollup(monkeypatch):
    # Milestone 8 (Task 27): formula/rollup ARE sortable once `result_type`
    # is known -- the asymmetry with compile_filter that survives this
    # task is place/button (above), not formula/rollup any more.
    for prop_type in ("formula", "rollup"):
        lookup = {
            "f": PropertyLookup(type=prop_type, storage="jsonb", key="a1b2c3d4", result_type="number")
        }
        frag = compile_sorts([SortSpec(property="f", direction="asc")], lookup, user_id="u-1", alias="p")
        assert frag.sql
        assert "computed" in frag.sql


def test_compile_sorts_rejects_a_formula_with_no_sql_shaped_result_type():
    # No result_type set at all (property not yet type-checked/saved), and
    # a List-typed result -- neither has a SQL shape (research §4.6/§4.7).
    # compile_sorts has no `RESULT_TYPE_OPERATORS`-style PRE-check for this
    # the way compile_condition's formula/rollup branch does (there is no
    # "operator" concept for a bare sort) -- `Formula.sql_order` itself
    # raises a plain `ValueError`, which compile_sorts wraps into
    # `FilterValidationError` so it still reaches a router as a 400.
    for result_type in (None, "list", "person", "page"):
        lookup = {"f": PropertyLookup(type="formula", storage="jsonb", key="a1b2c3d4", result_type=result_type)}
        with pytest.raises(FilterValidationError):
            compile_sorts([SortSpec(property="f", direction="asc")], lookup, user_id="u-1", alias="p")


# ---------------------------------------------------------------------------
# Depth 10 allowed / 11 rejected, end to end through compile_filter
# ---------------------------------------------------------------------------


def _nest_groups(depth: int, key: str) -> dict:
    node = {"type": "condition", "property": key, "operator": "is_empty", "value": None}
    for _ in range(depth):
        node = {"type": "group", "op": "and", "children": [node]}
    return node


def test_compile_filter_depth_10_compiles():
    node = parse_filter(_nest_groups(10, "title"))
    frag = compile_filter(node, _TITLE_LOOKUP, user_id="u-1", alias="p")
    assert frag.sql


def test_compile_filter_depth_11_rejected_at_parse():
    with pytest.raises(FilterValidationError):
        parse_filter(_nest_groups(11, "title"))


# ---------------------------------------------------------------------------
# QueryBuilder._scope() guard
# ---------------------------------------------------------------------------


def test_scope_all_notes_mode_has_user_id_predicate_and_excludes_deleted():
    qb = QueryBuilder(user_id="u-1", data_source_id=None, properties=_TITLE_LOOKUP)
    scope = qb._scope()
    assert "user_id = $1" in scope.sql
    assert "deleted_at IS NULL" in scope.sql
    assert scope.params == ("u-1",)


def test_scope_ordinary_mode_has_user_id_and_data_source_and_deleted_at():
    qb = QueryBuilder(user_id="u-1", data_source_id="ds-1", properties=_TITLE_LOOKUP)
    scope = qb._scope()
    assert "user_id = $1" in scope.sql
    assert "data_source_id = $2" in scope.sql
    assert "n.deleted_at IS NULL" in scope.sql
    assert scope.params == ("u-1", "ds-1")


def test_build_all_notes_mode_sql_contains_scope():
    qb = QueryBuilder(user_id="u-1", data_source_id=None, properties=_TITLE_LOOKUP)
    frag = qb.build(None, [], Pagination())
    assert "user_id = $1" in frag.sql
    assert "FROM notes n" in frag.sql


def test_build_ordinary_mode_sql_contains_scope_and_join():
    qb = QueryBuilder(user_id="u-1", data_source_id="ds-1", properties=_TITLE_LOOKUP)
    frag = qb.build(None, [], Pagination())
    assert "user_id = $1" in frag.sql
    assert "data_source_id = $2" in frag.sql
    assert "JOIN notes n ON n.id = p.note_id" in frag.sql


def test_build_always_appends_row_identity_tiebreaker():
    qb = QueryBuilder(user_id="u-1", data_source_id=None, properties=_TITLE_LOOKUP)
    frag = qb.build(None, [], Pagination())
    assert "n.id ASC" in frag.sql


def test_build_pagination_params_bound_not_interpolated():
    qb = QueryBuilder(user_id="u-1", data_source_id=None, properties=_TITLE_LOOKUP)
    frag = qb.build(None, [], Pagination(page_size=17, offset=34))
    assert 17 in frag.params
    assert 34 in frag.params
    assert "17" not in frag.sql
    assert "34" not in frag.sql


def test_ordinary_mode_column_backed_property_resolves_to_notes_alias_not_row_alias():
    # Final M3 review, Important finding 1: a storage="column" property's
    # real home is always `notes n`, never the mode's row alias — even in
    # ordinary mode, where the row alias is "p" (db_row_props). db_row_props
    # happens to have its own created_at/updated_at columns (migration 014)
    # that COLUMN_BACKED names-match exactly, so naively using the mode
    # alias for a column-backed lookup would compile to syntactically valid
    # but wrong-table SQL (`p.created_at` instead of `n.created_at`) —
    # silent wrong answers, no error. create_property hardcodes
    # storage='jsonb' today so this is unreachable via the current write
    # path, but PropertyLookup/QueryBuilder don't structurally forbid it.
    lookup = {"created": PropertyLookup(type="created_time", storage="column", key="created_at")}
    node = FilterCondition(type="condition", property="created", operator="is_not_empty", value=None)
    qb = QueryBuilder(user_id="u-1", data_source_id="ds-1", properties=lookup)
    frag = qb.build(node, [SortSpec(property="created", direction="asc")], Pagination())
    assert "n.created_at" in frag.sql
    assert "p.created_at" not in frag.sql


# ---------------------------------------------------------------------------
# _scope() guard sweep — every SqlFragment QueryBuilder.build() can produce
# must scope on user_id (spec §8.3), not just the empty-filter/empty-sorts
# corner the two `test_build_*_mode_sql_contains_scope` tests above happen
# to cover. Same technique test_databases_router.py's tenancy-guard sweep
# uses (tests/test_databases_router.py:876-926): grep the compiled SQL for
# a real `user_id = $N` predicate, not just a substring mention, plus a
# count floor so the sweep itself can't silently shrink to near-nothing.
# That existing sweep enumerates SQL statements straight from source
# (routers/databases.py, services/db/views.py); builder.py's scope isn't a
# static literal — it's assembled by `_scope()` at call time — so this
# sweep instead parametrizes the actual shape space `build()` accepts and
# inspects each call's output, which is the closest equivalent for a
# builder rather than hand-written SQL.
# ---------------------------------------------------------------------------

_SCOPE_PREDICATE_RE = re.compile(r"user_id\s*=\s*\$\d+")

_SCOPE_SWEEP_ALL_NOTES_PROPS = {
    "title": PropertyLookup(type="title", storage="column", key="title"),
}
_SCOPE_SWEEP_ORDINARY_PROPS = {
    "title": PropertyLookup(type="title", storage="jsonb", key="a1b2c3d4"),
}


def _scope_sweep_simple_filter() -> FilterCondition:
    return FilterCondition(type="condition", property="title", operator="is_not_empty", value=None)


def _scope_sweep_nested_group_filter() -> FilterGroup:
    return FilterGroup(
        type="group",
        op="and",
        children=[
            FilterCondition(type="condition", property="title", operator="is_not_empty", value=None),
            FilterGroup(
                type="group",
                op="or",
                children=[
                    FilterCondition(type="condition", property="title", operator="is_empty", value=None),
                ],
            ),
        ],
    )


def _build_scope_sweep_cases() -> list:
    # Both modes x {no filter, simple filter, nested-group filter} x
    # {no sorts, with sorts}: 2 x 3 x 2 = 12 cases.
    modes = [
        ("all_notes", None, _SCOPE_SWEEP_ALL_NOTES_PROPS),
        ("ordinary", "ds-1", _SCOPE_SWEEP_ORDINARY_PROPS),
    ]
    filters = [
        ("no_filter", lambda: None),
        ("simple_filter", _scope_sweep_simple_filter),
        ("nested_group_filter", _scope_sweep_nested_group_filter),
    ]
    sorts_variants = [
        ("no_sorts", []),
        ("with_sorts", [SortSpec(property="title", direction="asc")]),
    ]
    cases = []
    for mode_name, data_source_id, properties in modes:
        for filter_name, filter_fn in filters:
            for sorts_name, sorts in sorts_variants:
                cases.append(
                    pytest.param(
                        data_source_id, properties, filter_fn(), sorts,
                        id=f"{mode_name}-{filter_name}-{sorts_name}",
                    )
                )
    return cases


_SCOPE_SWEEP_CASES = _build_scope_sweep_cases()


def test_scope_sweep_case_count_floor():
    # Same discipline as test_databases_router.py's own
    # `assert len(statements) >= 8` — a floor so this sweep can't silently
    # regress to near-vacuous coverage if a case is accidentally dropped.
    assert len(_SCOPE_SWEEP_CASES) >= 8


@pytest.mark.parametrize("data_source_id,properties,filter_node,sorts", _SCOPE_SWEEP_CASES)
def test_build_always_scopes_on_user_id(data_source_id, properties, filter_node, sorts):
    qb = QueryBuilder(user_id="u-1", data_source_id=data_source_id, properties=properties)
    frag = qb.build(filter_node, sorts, Pagination())
    assert _SCOPE_PREDICATE_RE.search(frag.sql), f"missing user_id = $N predicate:\n{frag.sql}"


# ===========================================================================
# Harness-backed tests
# ===========================================================================


async def _make_ordinary_source(db_conn, user_id):
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'T') RETURNING id", user_id
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, 'Default') RETURNING id",
        db_row["id"], user_id,
    )
    return str(ds_row["id"])


async def _insert_note(db_conn, user_id, *, title="Note"):
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id",
        user_id, title,
    )
    return str(note["id"])


# task-12 finding (report.md "Concerns"): `unique_id`'s 6 numeric comparison
# operators (equals/does_not_equal/greater_than/less_than/gte/lte) compile
# to syntactically valid SQL that always raises at execution time. Root
# cause is in properties/base.py (out of scope for this task to modify):
# `_VALUE_SHAPES` gives `"number"` a `::double precision` cast but has no
# entry for `"unique_id"`, so `_GenericProperty._value_sql` falls back to a
# bare, uncast `->> 'unique_id'` (text) hop. Comparing that text expression
# to a bound Python int makes Postgres infer the placeholder's type as
# `text`, and asyncpg refuses to encode an int as text
# (`asyncpg.exceptions.DataError: expected str, got int`) — even though
# operators.py deliberately grants unique_id the full 8 numeric operators
# ("schema is permissive", operators.py's own module docstring). is_empty/
# is_not_empty don't bind a value, so those 2 of the 8 are unaffected.
_UNIQUE_ID_BROKEN_NUMERIC_OPS = {
    "equals", "does_not_equal", "greater_than", "less_than",
    "greater_than_or_equal_to", "less_than_or_equal_to",
}


async def test_full_operator_matrix_compiles_and_executes(db_conn, test_user):
    """All ~131 (type x operator) pairs compile to SQL that actually
    executes against the real schema, one condition per pair."""
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    executed = 0
    for prop_type, ops in TYPE_OPERATORS.items():
        if prop_type == "relation":
            # Milestone 7: relation's filter branch needs a real RelationRef
            # (task-20-brief.md §3.1) -- a bare jsonb PropertyLookup with no
            # `relation` set is the "malformed/pre-015 config" case, which
            # correctly 400s (test_db_operators.py's dedicated test covers
            # that). This sweep is about "every pair executes", so it needs
            # a configured one; the relation_id doesn't need to correspond
            # to a real db_properties row for the EXISTS subquery to run.
            lookup = {
                "prop": PropertyLookup(
                    type=prop_type,
                    storage="jsonb",
                    key="a1b2c3d4",
                    relation=RelationRef(relation_id=str(uuid.uuid4()), side="forward"),
                )
            }
        else:
            lookup = {"prop": PropertyLookup(type=prop_type, storage="jsonb", key="a1b2c3d4")}
        for operator_name, operator in ops.items():
            if prop_type == "unique_id" and operator_name in _UNIQUE_ID_BROKEN_NUMERIC_OPS:
                continue
            sample = _sample_for(operator.arg_type)
            node = FilterCondition(
                type="condition", property="prop", operator=operator_name, value=sample
            )
            qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
            frag = qb.build(node, [], Pagination())
            # Must actually run without raising against the real schema.
            await db_conn.fetch(frag.sql, *frag.params)
            executed += 1
    # 131 total pairs - 6 known-broken unique_id numeric ops (see above) =
    # 125. A floor, not `== 125`, so a future TYPE_OPERATORS addition
    # doesn't need this test edited — but if TYPE_OPERATORS were ever
    # emptied by a refactor, this catches it rather than passing vacuously.
    assert executed >= 125


@pytest.mark.parametrize("operator_name", sorted(_UNIQUE_ID_BROKEN_NUMERIC_OPS))
async def test_unique_id_numeric_operators_currently_fail_at_execution(db_conn, test_user, operator_name):
    """Documents the gap above for all 6 excluded ops (not just one), so the
    pin and the `test_full_operator_matrix_compiles_and_executes` exclusion
    set can't silently drift apart. If this starts failing because a given
    op's query now succeeds, that's progress — update both together."""
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    lookup = {"prop": PropertyLookup(type="unique_id", storage="jsonb", key="a1b2c3d4")}
    node = FilterCondition(type="condition", property="prop", operator=operator_name, value=1)
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    with pytest.raises(asyncpg.exceptions.DataError):
        await db_conn.fetch(frag.sql, *frag.params)


def _sample_for(arg_type: str):
    return {
        "none": None,
        "str": "needle",
        "num": 1,
        "bool": True,
        "str_or_list": "needle",
        "date": "2026-08-10",
        "uuid": "12345678-1234-5678-1234-567812345678",
        "uuid_or_me": "me",
        "verification_status": "verified",
    }[arg_type]


async def test_native_array_topics_end_to_end_all_notes_mode(db_conn, test_user):
    note1 = await _insert_note(db_conn, test_user, title="Has topic")
    await db_conn.execute("UPDATE notes SET topics = $1 WHERE id = $2", ["python"], note1)
    note2 = await _insert_note(db_conn, test_user, title="No topic")

    properties = {
        prop.column: PropertyLookup(type=prop.type, storage="column", key=prop.column)
        for prop in COLUMN_BACKED.values()
    }
    node = FilterCondition(type="condition", property="topics", operator="contains", value="python")
    qb = QueryBuilder(user_id=test_user, data_source_id=None, properties=properties)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    ids = {str(r["id"]) for r in rows}
    assert ids == {note1}


async def test_semantic_correctness_number_equals(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    matching_note = await _insert_note(db_conn, test_user, title="42")
    other_note = await _insert_note(db_conn, test_user, title="7")
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
        VALUES ($1, $2, $3, $4)
        """,
        matching_note, data_source_id, test_user, {"a1b2c3d4": {"type": "number", "number": 42}},
    )
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
        VALUES ($1, $2, $3, $4)
        """,
        other_note, data_source_id, test_user, {"a1b2c3d4": {"type": "number", "number": 7}},
    )

    lookup = {"num": PropertyLookup(type="number", storage="jsonb", key="a1b2c3d4")}
    node = FilterCondition(type="condition", property="num", operator="equals", value=42)
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {matching_note}


# ---------------------------------------------------------------------------
# Row-level semantic correctness (final M3 review, Important finding 2):
# the matrix sweep above only proves every pair *executes*; these prove a
# representative pair per remaining value-shape family (text, choice, date)
# returns the *right rows*, closing the gap left between Task 11's DB-free
# shape tests and this task's DB-executes-without-raising sweep.
# ---------------------------------------------------------------------------


async def _insert_row(db_conn, user_id, data_source_id, note_id, properties):
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, $4)",
        note_id, data_source_id, user_id, properties,
    )


async def test_text_does_not_equal_is_null_safe_includes_absent_property(db_conn, test_user):
    # SQL's three-valued logic: a bare `E <> $1` is NULL (neither true nor
    # false) when the property is absent entirely, which would silently
    # drop that row from a "does not equal" result set — exactly why
    # `_text_scalar_sql`'s does_not_equal wraps in `(E IS NULL OR E <> $1)`.
    # Proves that guard actually holds against real Postgres, not just that
    # the SQL string contains "IS NULL" (operators.py's own DB-free tests
    # already check the string shape).
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    matching_value = await _insert_note(db_conn, test_user, title="different value")
    matching_absent = await _insert_note(db_conn, test_user, title="absent property")
    excluded_equal = await _insert_note(db_conn, test_user, title="equal value")
    await _insert_row(
        db_conn, test_user, data_source_id, matching_value,
        {"a1b2c3d4": {"type": "title", "title": "something else"}},
    )
    await _insert_row(db_conn, test_user, data_source_id, matching_absent, {})
    await _insert_row(
        db_conn, test_user, data_source_id, excluded_equal,
        {"a1b2c3d4": {"type": "title", "title": "target"}},
    )

    lookup = {"t": PropertyLookup(type="title", storage="jsonb", key="a1b2c3d4")}
    node = FilterCondition(type="condition", property="t", operator="does_not_equal", value="target")
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {matching_value, matching_absent}


async def test_text_contains_percent_literal_not_wildcard(db_conn, test_user):
    # `_escape_like`/`ESCAPE '\'` exist so a literal "%" in the search value
    # is matched literally, not as an ILIKE wildcard. If escaping were
    # broken, searching for "%" would compile to `ILIKE '%' || '%' || '%'`
    # == `ILIKE '%%%'`, which matches every row regardless of content —
    # this test's negative case (a row with no "%" at all) is what proves
    # escaping actually happened, not just that the containing row matched.
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    has_percent = await _insert_note(db_conn, test_user, title="50% off")
    no_percent = await _insert_note(db_conn, test_user, title="fifty percent off")
    await _insert_row(
        db_conn, test_user, data_source_id, has_percent,
        {"a1b2c3d4": {"type": "title", "title": "50% off"}},
    )
    await _insert_row(
        db_conn, test_user, data_source_id, no_percent,
        {"a1b2c3d4": {"type": "title", "title": "fifty percent off"}},
    )

    lookup = {"t": PropertyLookup(type="title", storage="jsonb", key="a1b2c3d4")}
    node = FilterCondition(type="condition", property="t", operator="contains", value="%")
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {has_percent}


async def test_choice_equals_list_form_is_or_semantics(db_conn, test_user):
    # `equals: ["A", "B"]` on a select/status property compiles to
    # `E = ANY($1::text[])` (_choice_scalar_sql's list branch) — OR
    # semantics: match A OR B, not both.
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    note_a = await _insert_note(db_conn, test_user, title="A")
    note_b = await _insert_note(db_conn, test_user, title="B")
    note_c = await _insert_note(db_conn, test_user, title="C")
    for note_id, value in ((note_a, "A"), (note_b, "B"), (note_c, "C")):
        await _insert_row(
            db_conn, test_user, data_source_id, note_id,
            {"a1b2c3d4": {"type": "select", "select": value}},
        )

    lookup = {"choice": PropertyLookup(type="select", storage="jsonb", key="a1b2c3d4")}
    node = FilterCondition(type="condition", property="choice", operator="equals", value=["A", "B"])
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {note_a, note_b}


async def test_date_past_week_selects_rows_inside_the_window(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    now = datetime.now(UTC)
    inside_window = await _insert_note(db_conn, test_user, title="3 days ago")
    outside_window = await _insert_note(db_conn, test_user, title="3 weeks ago")
    inside_iso = (now - timedelta(days=3)).isoformat()
    outside_iso = (now - timedelta(days=21)).isoformat()
    await _insert_row(
        db_conn, test_user, data_source_id, inside_window,
        {"a1b2c3d4": {"type": "date", "date": {"start": inside_iso}}},
    )
    await _insert_row(
        db_conn, test_user, data_source_id, outside_window,
        {"a1b2c3d4": {"type": "date", "date": {"start": outside_iso}}},
    )

    lookup = {"d": PropertyLookup(type="date", storage="jsonb", key="a1b2c3d4")}
    node = FilterCondition(type="condition", property="d", operator="past_week", value=None)
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {inside_window}


async def test_date_malformed_value_excluded_not_erroring(db_conn, test_user):
    # `_guarded_date_expr`'s regex-guarded CASE cast (operators.py) exists
    # so one legacy/malformed non-ISO date string doesn't 500 the whole
    # query — it should evaluate to NULL (excluded from any non-IS-NULL
    # comparison) instead. Proves both halves: the query doesn't raise, and
    # the malformed row is excluded rather than matching spuriously.
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    well_formed = await _insert_note(db_conn, test_user, title="well-formed")
    malformed = await _insert_note(db_conn, test_user, title="malformed")
    await _insert_row(
        db_conn, test_user, data_source_id, well_formed,
        {"a1b2c3d4": {"type": "date", "date": {"start": "2020-01-01T00:00:00Z"}}},
    )
    await _insert_row(
        db_conn, test_user, data_source_id, malformed,
        {"a1b2c3d4": {"type": "date", "date": {"start": "not-a-real-date"}}},
    )

    lookup = {"d": PropertyLookup(type="date", storage="jsonb", key="a1b2c3d4")}
    node = FilterCondition(type="condition", property="d", operator="before", value="2030-01-01")
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)  # must not raise
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {well_formed}


async def test_ordinary_mode_excludes_trashed_notes(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    live_note = await _insert_note(db_conn, test_user, title="live")
    trashed_note = await _insert_note(db_conn, test_user, title="trashed")
    await db_conn.execute("UPDATE notes SET deleted_at = now() WHERE id = $1", trashed_note)
    for note_id in (live_note, trashed_note):
        await db_conn.execute(
            """
            INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
            VALUES ($1, $2, $3, '{}')
            """,
            note_id, data_source_id, test_user,
        )

    lookup: dict = {}
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(None, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {live_note}


async def test_all_notes_mode_excludes_trashed_notes(db_conn, test_user):
    live_note = await _insert_note(db_conn, test_user, title="live")
    trashed_note = await _insert_note(db_conn, test_user, title="trashed")
    await db_conn.execute("UPDATE notes SET deleted_at = now() WHERE id = $1", trashed_note)

    qb = QueryBuilder(user_id=test_user, data_source_id=None, properties={})
    frag = qb.build(None, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    ids = {str(r["id"]) for r in rows}
    assert ids == {live_note}


async def test_ordinary_mode_column_backed_reads_notes_row_not_db_row_props_row(db_conn, test_user):
    # Same finding as the SQL-text test above, proven with real, deliberately
    # mismatched data: notes.created_at and db_row_props.created_at are set
    # to *different* values for both notes, then swapped between them, so
    # filtering on the column-backed created_time property only returns the
    # expected row if the compiled SQL actually reads notes.created_at
    # (n.created_at) rather than db_row_props.created_at (p.created_at).
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    t1 = datetime(2020, 1, 1, tzinfo=UTC)
    t2 = datetime(2021, 1, 1, tzinfo=UTC)
    note1 = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title, created_at) VALUES ($1, 'n1', $2) RETURNING id",
        test_user, t1,
    )
    note2 = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title, created_at) VALUES ($1, 'n2', $2) RETURNING id",
        test_user, t2,
    )
    note1_id, note2_id = str(note1["id"]), str(note2["id"])
    # db_row_props.created_at deliberately swapped relative to notes.created_at.
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties, created_at) VALUES ($1, $2, $3, '{}', $4)",
        note1["id"], data_source_id, test_user, t2,
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties, created_at) VALUES ($1, $2, $3, '{}', $4)",
        note2["id"], data_source_id, test_user, t1,
    )

    lookup = {"created": PropertyLookup(type="created_time", storage="column", key="created_at")}
    node = FilterCondition(type="condition", property="created", operator="equals", value=t1.isoformat())
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    # notes.created_at == t1 for note1 -> correct (n.created_at) resolution
    # returns note1. The bug this guards against (p.created_at) would
    # instead return note2, whose db_row_props.created_at == t1.
    assert note_ids == {note1_id}


# ---------------------------------------------------------------------------
# Milestone 7 (task-20): the relation filter compiles to EXISTS/NOT EXISTS
# and executes against the harness returning the right row ids -- not just
# "a fragment came back" (M3's own final review promoted exactly this gap
# to an Important finding for every other type; the brief names it again
# here so it isn't reintroduced for relation).
# ---------------------------------------------------------------------------


async def _insert_relation_link(db_conn, user_id, relation_id, from_row_id, to_row_id, position=0.0):
    await db_conn.execute(
        """
        INSERT INTO db_relation_links (user_id, relation_id, from_row_id, to_row_id, position)
        VALUES ($1, $2, $3, $4, $5)
        """,
        user_id, relation_id, from_row_id, to_row_id, position,
    )


async def test_relation_contains_executes_and_returns_right_row_ids(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    relation_id = str(uuid.uuid4())
    linked_note = await _insert_note(db_conn, test_user, title="linked")
    unlinked_note = await _insert_note(db_conn, test_user, title="unlinked")
    target_note = await _insert_note(db_conn, test_user, title="target")
    other_note = await _insert_note(db_conn, test_user, title="other target")
    for note_id in (linked_note, unlinked_note):
        await _insert_row(db_conn, test_user, data_source_id, note_id, {})
    await _insert_relation_link(db_conn, test_user, relation_id, linked_note, target_note)
    await _insert_relation_link(db_conn, test_user, relation_id, unlinked_note, other_note)

    lookup = {
        "rel": PropertyLookup(
            type="relation", storage="jsonb", key="a1b2c3d4",
            relation=RelationRef(relation_id=relation_id, side="forward"),
        )
    }
    node = FilterCondition(type="condition", property="rel", operator="contains", value=target_note)
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {linked_note}


async def test_relation_does_not_contain_executes_and_returns_right_row_ids(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    relation_id = str(uuid.uuid4())
    linked_note = await _insert_note(db_conn, test_user, title="linked")
    unlinked_note = await _insert_note(db_conn, test_user, title="unlinked")
    target_note = await _insert_note(db_conn, test_user, title="target")
    other_note = await _insert_note(db_conn, test_user, title="other target")
    for note_id in (linked_note, unlinked_note):
        await _insert_row(db_conn, test_user, data_source_id, note_id, {})
    await _insert_relation_link(db_conn, test_user, relation_id, linked_note, target_note)
    await _insert_relation_link(db_conn, test_user, relation_id, unlinked_note, other_note)

    lookup = {
        "rel": PropertyLookup(
            type="relation", storage="jsonb", key="a1b2c3d4",
            relation=RelationRef(relation_id=relation_id, side="forward"),
        )
    }
    node = FilterCondition(
        type="condition", property="rel", operator="does_not_contain", value=target_note
    )
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    note_ids = {str(r["note_id"]) for r in rows}
    assert note_ids == {unlinked_note}


async def test_relation_is_empty_and_is_not_empty_executes_and_returns_right_row_ids(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    relation_id = str(uuid.uuid4())
    has_link = await _insert_note(db_conn, test_user, title="has link")
    no_link = await _insert_note(db_conn, test_user, title="no link")
    target_note = await _insert_note(db_conn, test_user, title="target")
    for note_id in (has_link, no_link):
        await _insert_row(db_conn, test_user, data_source_id, note_id, {})
    await _insert_relation_link(db_conn, test_user, relation_id, has_link, target_note)

    lookup = {
        "rel": PropertyLookup(
            type="relation", storage="jsonb", key="a1b2c3d4",
            relation=RelationRef(relation_id=relation_id, side="forward"),
        )
    }
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)

    not_empty_node = FilterCondition(type="condition", property="rel", operator="is_not_empty", value=None)
    not_empty_frag = qb.build(not_empty_node, [], Pagination())
    not_empty_rows = await db_conn.fetch(not_empty_frag.sql, *not_empty_frag.params)
    assert {str(r["note_id"]) for r in not_empty_rows} == {has_link}

    empty_node = FilterCondition(type="condition", property="rel", operator="is_empty", value=None)
    empty_frag = qb.build(empty_node, [], Pagination())
    empty_rows = await db_conn.fetch(empty_frag.sql, *empty_frag.params)
    assert {str(r["note_id"]) for r in empty_rows} == {no_link}


async def test_relation_reverse_side_reads_the_other_direction_end_to_end(db_conn, test_user):
    # A reverse-side property's own_column is to_row_id: a link stored as
    # (from_row_id=some_other_note, to_row_id=this_row) must be visible to
    # a reverse-side "contains" filter on this_row, even though the row
    # never appears as from_row_id anywhere.
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    relation_id = str(uuid.uuid4())
    this_row = await _insert_note(db_conn, test_user, title="this row")
    other_row = await _insert_note(db_conn, test_user, title="other row")
    pointer_note = await _insert_note(db_conn, test_user, title="pointer")
    await _insert_row(db_conn, test_user, data_source_id, this_row, {})
    await _insert_row(db_conn, test_user, data_source_id, other_row, {})
    # forward link: pointer_note -> this_row
    await _insert_relation_link(db_conn, test_user, relation_id, pointer_note, this_row)

    lookup = {
        "rel": PropertyLookup(
            type="relation", storage="jsonb", key="a1b2c3d4",
            relation=RelationRef(relation_id=relation_id, side="reverse"),
        )
    }
    node = FilterCondition(type="condition", property="rel", operator="contains", value=pointer_note)
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    assert {str(r["note_id"]) for r in rows} == {this_row}


async def test_relation_sort_orders_by_link_count(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    relation_id = str(uuid.uuid4())
    two_links = await _insert_note(db_conn, test_user, title="two links")
    one_link = await _insert_note(db_conn, test_user, title="one link")
    zero_links = await _insert_note(db_conn, test_user, title="zero links")
    targets = [await _insert_note(db_conn, test_user, title=f"t{i}") for i in range(2)]
    for note_id in (two_links, one_link, zero_links):
        await _insert_row(db_conn, test_user, data_source_id, note_id, {})
    await _insert_relation_link(db_conn, test_user, relation_id, two_links, targets[0])
    await _insert_relation_link(db_conn, test_user, relation_id, two_links, targets[1])
    await _insert_relation_link(db_conn, test_user, relation_id, one_link, targets[0])

    lookup = {
        "rel": PropertyLookup(
            type="relation", storage="jsonb", key="a1b2c3d4",
            relation=RelationRef(relation_id=relation_id, side="forward"),
        )
    }
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(None, [SortSpec(property="rel", direction="asc")], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    ordered_ids = [str(r["note_id"]) for r in rows]
    assert ordered_ids == [zero_links, one_link, two_links]


async def test_relation_filter_and_sort_combined_params_renumber_correctly(db_conn, test_user):
    # Regression coverage for the ordering the brief calls out explicitly:
    # scope params, then filter params, then sort params, then limit/offset.
    # A relation filter AND a relation sort together (two different
    # relation_ids, so no ambiguity about which fragment's params ended up
    # where) proves builder.build() spliced them in the right order rather
    # than merely "some correct count of params".
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    filter_relation_id = str(uuid.uuid4())
    sort_relation_id = str(uuid.uuid4())
    row_a = await _insert_note(db_conn, test_user, title="a")
    row_b = await _insert_note(db_conn, test_user, title="b")
    target = await _insert_note(db_conn, test_user, title="target")
    for note_id in (row_a, row_b):
        await _insert_row(db_conn, test_user, data_source_id, note_id, {})
    await _insert_relation_link(db_conn, test_user, filter_relation_id, row_a, target)
    await _insert_relation_link(db_conn, test_user, filter_relation_id, row_b, target)
    await _insert_relation_link(db_conn, test_user, sort_relation_id, row_a, target)

    lookup = {
        "filt": PropertyLookup(
            type="relation", storage="jsonb", key="a1b2c3d4",
            relation=RelationRef(relation_id=filter_relation_id, side="forward"),
        ),
        "sortby": PropertyLookup(
            type="relation", storage="jsonb", key="b2c3d4e5",
            relation=RelationRef(relation_id=sort_relation_id, side="forward"),
        ),
    }
    node = FilterCondition(type="condition", property="filt", operator="is_not_empty", value=None)
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    frag = qb.build(node, [SortSpec(property="sortby", direction="desc")], Pagination())
    rows = await db_conn.fetch(frag.sql, *frag.params)
    ordered_ids = [str(r["note_id"]) for r in rows]
    # Both rows pass the filter (both link to `target` on filter_relation_id);
    # sorted desc by link count on sort_relation_id, row_a (1 link) before
    # row_b (0 links).
    assert ordered_ids == [row_a, row_b]


# --- ASC NULLS LAST / DESC NULLS FIRST, one type per value-shape family ----


async def test_sort_text_asc_nulls_last_desc_nulls_first(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    with_value = await _insert_note(db_conn, test_user, title="has value")
    empty = await _insert_note(db_conn, test_user, title="empty")
    for note_id, props in (
        (with_value, {"a1b2c3d4": {"type": "title", "title": "hello"}}),
        (empty, {}),
    ):
        await db_conn.execute(
            "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, $4)",
            note_id, data_source_id, test_user, props,
        )

    lookup = {"t": PropertyLookup(type="title", storage="jsonb", key="a1b2c3d4")}
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)

    asc_frag = qb.build(None, [SortSpec(property="t", direction="asc")], Pagination())
    asc_rows = await db_conn.fetch(asc_frag.sql, *asc_frag.params)
    assert str(asc_rows[-1]["note_id"]) == empty

    desc_frag = qb.build(None, [SortSpec(property="t", direction="desc")], Pagination())
    desc_rows = await db_conn.fetch(desc_frag.sql, *desc_frag.params)
    assert str(desc_rows[0]["note_id"]) == empty


async def test_sort_number_asc_nulls_last_desc_nulls_first(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    with_value = await _insert_note(db_conn, test_user, title="has value")
    empty = await _insert_note(db_conn, test_user, title="empty")
    for note_id, props in (
        (with_value, {"a1b2c3d4": {"type": "number", "number": 5}}),
        (empty, {}),
    ):
        await db_conn.execute(
            "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, $4)",
            note_id, data_source_id, test_user, props,
        )

    lookup = {"n": PropertyLookup(type="number", storage="jsonb", key="a1b2c3d4")}
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)

    asc_frag = qb.build(None, [SortSpec(property="n", direction="asc")], Pagination())
    asc_rows = await db_conn.fetch(asc_frag.sql, *asc_frag.params)
    assert str(asc_rows[-1]["note_id"]) == empty

    desc_frag = qb.build(None, [SortSpec(property="n", direction="desc")], Pagination())
    desc_rows = await db_conn.fetch(desc_frag.sql, *desc_frag.params)
    assert str(desc_rows[0]["note_id"]) == empty


async def test_sort_multi_select_jsonb_array_asc_nulls_last(db_conn, test_user):
    data_source_id = await _make_ordinary_source(db_conn, test_user)
    with_value = await _insert_note(db_conn, test_user, title="has value")
    empty = await _insert_note(db_conn, test_user, title="empty")
    for note_id, props in (
        (with_value, {"a1b2c3d4": {"type": "multi_select", "multi_select": ["a"]}}),
        (empty, {}),
    ):
        await db_conn.execute(
            "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, $4)",
            note_id, data_source_id, test_user, props,
        )

    lookup = {"m": PropertyLookup(type="multi_select", storage="jsonb", key="a1b2c3d4")}
    qb = QueryBuilder(user_id=test_user, data_source_id=data_source_id, properties=lookup)
    asc_frag = qb.build(None, [SortSpec(property="m", direction="asc")], Pagination())
    asc_rows = await db_conn.fetch(asc_frag.sql, *asc_frag.params)
    assert str(asc_rows[-1]["note_id"]) == empty


async def test_sort_native_array_topics_all_notes_mode(db_conn, test_user):
    # task-12 finding (report.md "Concerns"): unlike every jsonb-backed
    # value-shape family (text/number/multi_select above), `topics` is a
    # native `TEXT[] NOT NULL DEFAULT '{}'` column — an untouched row's
    # value is an actual empty array, never SQL NULL. `sql_order`'s "ASC
    # NULLS LAST / DESC NULLS FIRST" convention (properties/base.py,
    # unmodified by this task) only affects real NULLs, so it has no effect
    # here: plain Postgres array comparison sorts `'{}'` as the smallest
    # possible value, putting the empty-topics row FIRST for ASC and LAST
    # for DESC — the inverse of every other family's "empties trail" rule,
    # and the inverse of what a literal reading of the brief's own sort-test
    # instruction ("assert the NULL/empty row lands last for asc") predicts.
    # compile_sorts()/build() are wiring this correctly (they faithfully
    # call REGISTRY["multi_select"].sql_order() and execute what it
    # returns) — the gap is in that pre-existing, generic sql_order
    # implementation not special-casing native-array/empty-default columns,
    # which is properties/base.py's territory, out of scope here.
    with_topic = await _insert_note(db_conn, test_user, title="has topic")
    await db_conn.execute("UPDATE notes SET topics = $1 WHERE id = $2", ["a"], with_topic)
    no_topic = await _insert_note(db_conn, test_user, title="no topic")

    properties = {
        prop.column: PropertyLookup(type=prop.type, storage="column", key=prop.column)
        for prop in COLUMN_BACKED.values()
    }
    qb = QueryBuilder(user_id=test_user, data_source_id=None, properties=properties)
    asc_frag = qb.build(None, [SortSpec(property="topics", direction="asc")], Pagination())
    asc_rows = await db_conn.fetch(asc_frag.sql, *asc_frag.params)
    assert str(asc_rows[0]["id"]) == no_topic  # empty array sorts FIRST, not last

    desc_frag = qb.build(None, [SortSpec(property="topics", direction="desc")], Pagination())
    desc_rows = await db_conn.fetch(desc_frag.sql, *desc_frag.params)
    assert str(desc_rows[-1]["id"]) == no_topic  # and LAST for desc


# --- Pagination --------------------------------------------------------


async def test_pagination_window(db_conn, test_user):
    note_ids = []
    for i in range(5):
        note_ids.append(await _insert_note(db_conn, test_user, title=f"n{i}"))

    qb = QueryBuilder(user_id=test_user, data_source_id=None, properties={})
    frag = qb.build(None, [], Pagination(page_size=2, offset=1))
    assert 2 in frag.params
    assert 1 in frag.params
    rows = await db_conn.fetch(frag.sql, *frag.params)
    assert len(rows) == 2


async def test_pagination_two_pages_are_disjoint_and_complete(db_conn, test_user):
    # Final M3 review, Important finding 2: the row-count-only check above
    # doesn't prove pages don't repeat/skip rows. >=5 rows with tied sort
    # keys (two pairs share the same title) — the `n.id ASC` tiebreaker
    # `build()` always appends is what guarantees LIMIT/OFFSET pagination
    # over tied rows is deterministic and complete across consecutive pages;
    # this proves that end to end against a real fetched full ordering,
    # rather than just asserting a window's row count.
    titles = ["a", "a", "b", "b", "c"]
    note_ids = [await _insert_note(db_conn, test_user, title=t) for t in titles]

    lookup = {"title": PropertyLookup(type="title", storage="column", key="title")}
    qb = QueryBuilder(user_id=test_user, data_source_id=None, properties=lookup)
    sorts = [SortSpec(property="title", direction="asc")]

    full_frag = qb.build(None, sorts, Pagination(page_size=200, offset=0))
    full_rows = await db_conn.fetch(full_frag.sql, *full_frag.params)
    full_ids = [str(r["id"]) for r in full_rows]
    assert set(full_ids) == set(note_ids)

    page1_frag = qb.build(None, sorts, Pagination(page_size=3, offset=0))
    page1_ids = [str(r["id"]) for r in await db_conn.fetch(page1_frag.sql, *page1_frag.params)]

    page2_frag = qb.build(None, sorts, Pagination(page_size=3, offset=3))
    page2_ids = [str(r["id"]) for r in await db_conn.fetch(page2_frag.sql, *page2_frag.params)]

    # Correctly ordered: each page matches the corresponding slice of the
    # complete, deterministically-ordered result.
    assert page1_ids == full_ids[0:3]
    assert page2_ids == full_ids[3:6]
    # Disjoint and complete: no row repeated or skipped across the two pages.
    assert set(page1_ids).isdisjoint(page2_ids)
    assert set(page1_ids) | set(page2_ids) == set(full_ids)
