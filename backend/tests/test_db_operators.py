"""Tests for the M3 filter AST (`services.db.query.ast`) and the property-type
x filter-operator matrix (`services.db.query.operators`). Pure Python — no DB
connection: Task 12 owns the compiler/query-builder tests that run generated
SQL against a real Postgres.
"""
from __future__ import annotations

import uuid

import pytest

from services.db.relations import RelationRef
from services.db.query.ast import (
    FilterCondition,
    FilterGroup,
    FilterValidationError,
    Pagination,
    SortSpec,
    parse_filter,
)
from services.db.properties.base import SqlContext, SqlFragment
from services.db.query.operators import (
    RESULT_TYPE_OPERATORS,
    TYPE_OPERATORS,
    coerce_value,
    compile_condition,
)

# operators.py re-exports ast.py's FilterValidationError rather than
# defining its own — ast.py's docstring is explicit that one class is
# "Raised by ast.py/operators.py", so Task 12's compiler only ever needs to
# catch one exception type. Assert that identity here so a future edit
# can't silently reintroduce two classes.
from services.db.query.operators import FilterValidationError as OpFilterValidationError


def test_operators_filter_validation_error_is_ast_filter_validation_error():
    assert OpFilterValidationError is FilterValidationError


def test_parse_filter_none_returns_none():
    assert parse_filter(None) is None


def test_parse_filter_nested_and_or_parses():
    raw = {
        "type": "group",
        "op": "and",
        "children": [
            {"type": "condition", "property": "a7Kd9x", "operator": "greater_than", "value": 10},
            {
                "type": "group",
                "op": "or",
                "children": [
                    {"type": "condition", "property": "p2Lm4q", "operator": "contains", "value": "opt_a1"},
                    {"type": "condition", "property": "z8Rt0v", "operator": "past_week", "value": {}},
                ],
            },
        ],
    }
    node = parse_filter(raw)
    assert isinstance(node, FilterGroup)
    assert node.op == "and"
    assert isinstance(node.children[0], FilterCondition)
    assert isinstance(node.children[1], FilterGroup)
    assert node.children[1].op == "or"


def _nest_groups(depth: int) -> dict:
    """A chain of `depth` nested groups, innermost holding one condition."""
    node = {"type": "condition", "property": "p", "operator": "is_empty", "value": None}
    for _ in range(depth):
        node = {"type": "group", "op": "and", "children": [node]}
    return node


def test_parse_filter_depth_10_is_allowed():
    assert parse_filter(_nest_groups(10)) is not None


def test_parse_filter_depth_11_raises():
    with pytest.raises(FilterValidationError):
        parse_filter(_nest_groups(11))


def test_parse_filter_unrecognised_type_raises():
    with pytest.raises(FilterValidationError):
        parse_filter({"type": "bogus", "property": "p", "operator": "equals", "value": 1})


def test_parse_filter_empty_children_raises():
    with pytest.raises(FilterValidationError):
        parse_filter({"type": "group", "op": "and", "children": []})


def test_sort_spec_defaults_to_ascending():
    assert SortSpec(property="a7Kd9x").direction == "asc"


def test_pagination_defaults():
    p = Pagination()
    assert p.page_size == 50
    assert p.offset == 0


def test_pagination_rejects_page_size_over_200():
    with pytest.raises(Exception):
        Pagination(page_size=201)


# --- The operator matrix ---------------------------------------------------


def test_type_operators_pair_count_is_still_131():
    # Unchanged by Milestone 8 (Task 27): TYPE_OPERATORS itself gains no
    # new keys for formula/rollup (see RESULT_TYPE_OPERATORS's own module
    # comment for why a flat per-TYPE dict can't represent an operator set
    # that depends on a per-PROPERTY result_type). This is the M3 count,
    # preserved exactly, not "the whole matrix" any more -- see the next
    # two tests for the surface Task 27 actually added.
    assert sum(len(v) for v in TYPE_OPERATORS.values()) == 131


def test_result_type_operators_pair_count_is_32():
    # The genuinely NEW operator-matrix surface this task adds: string(8)
    # + number(8) + boolean(2) + date(14) = 32, reusing the EXACT SAME
    # Operator tuples TYPE_OPERATORS's own text/number/checkbox/date
    # families already use (no new arg_types invented).
    assert sum(len(v) for v in RESULT_TYPE_OPERATORS.values()) == 32
    assert set(RESULT_TYPE_OPERATORS) == {"string", "number", "boolean", "date"}


def test_combined_operator_pair_total_is_163_not_131():
    # The brief's own instruction: "Adding formula/rollup changes [the
    # count]. Update the number and say so." 131 (TYPE_OPERATORS, M3,
    # unchanged) + 32 (RESULT_TYPE_OPERATORS, new) = 163 is the real total
    # reachable operator-pair surface after this task -- flagged here
    # explicitly rather than only in the two tests above, so a reviewer
    # diffing this file sees the number the brief asked for directly.
    total = sum(len(v) for v in TYPE_OPERATORS.values()) + sum(
        len(v) for v in RESULT_TYPE_OPERATORS.values()
    )
    assert total == 163


@pytest.mark.parametrize("excluded", ["formula", "rollup", "place", "button"])
def test_formula_rollup_place_button_excluded_from_type_operators(excluded):
    # Still true after Task 27, for an evolved reason for formula/rollup
    # specifically: it used to be "M3 couldn't know their result type at
    # all"; now it is "even knowing it, a flat dict keyed by property TYPE
    # can't express an operator set that depends on result_type, a
    # per-PROPERTY value" -- see RESULT_TYPE_OPERATORS, the table that
    # actually carries their operators now.
    assert excluded not in TYPE_OPERATORS


def test_text_types_share_the_same_8_operators():
    expected = {
        "equals", "does_not_equal", "contains", "does_not_contain",
        "starts_with", "ends_with", "is_empty", "is_not_empty",
    }
    for key in ("title", "rich_text", "url", "email", "phone_number"):
        assert set(TYPE_OPERATORS[key]) == expected


def test_checkbox_has_only_equals_pair():
    assert set(TYPE_OPERATORS["checkbox"]) == {"equals", "does_not_equal"}


def test_date_created_time_last_edited_time_share_14_operators():
    expected = set(TYPE_OPERATORS["date"])
    assert len(expected) == 14
    assert set(TYPE_OPERATORS["created_time"]) == expected
    assert set(TYPE_OPERATORS["last_edited_time"]) == expected


def test_unique_id_has_full_8_number_operators():
    assert set(TYPE_OPERATORS["unique_id"]) == set(TYPE_OPERATORS["number"])


def test_verification_has_single_status_operator():
    assert set(TYPE_OPERATORS["verification"]) == {"status"}


def test_files_has_only_existence_operators():
    assert set(TYPE_OPERATORS["files"]) == {"is_empty", "is_not_empty"}


# --- coerce_value ------------------------------------------------------

def test_coerce_none_accepts_empty_dict_and_none():
    assert coerce_value("none", {}) is None
    assert coerce_value("none", None) is None


def test_coerce_none_rejects_anything_else():
    with pytest.raises(OpFilterValidationError):
        coerce_value("none", "x")


def test_coerce_str_accepts_str_rejects_bool():
    assert coerce_value("str", "hello") == "hello"
    with pytest.raises(OpFilterValidationError):
        coerce_value("str", True)


def test_coerce_num_accepts_int_float_rejects_bool():
    assert coerce_value("num", 5) == 5
    assert coerce_value("num", 5.5) == 5.5
    with pytest.raises(OpFilterValidationError):
        coerce_value("num", True)  # the bool-is-not-num trap
    with pytest.raises(OpFilterValidationError):
        coerce_value("num", "5")


def test_coerce_bool_accepts_only_true_false():
    assert coerce_value("bool", True) is True
    assert coerce_value("bool", False) is False
    with pytest.raises(OpFilterValidationError):
        coerce_value("bool", 1)


def test_coerce_str_or_list_accepts_str_and_nonempty_list():
    assert coerce_value("str_or_list", "a") == "a"
    assert coerce_value("str_or_list", ["a", "b"]) == ["a", "b"]


def test_coerce_str_or_list_rejects_empty_list():
    with pytest.raises(OpFilterValidationError):
        coerce_value("str_or_list", [])


def test_coerce_date_accepts_iso8601():
    result = coerce_value("date", "2026-08-10T12:00:00Z")
    assert result.year == 2026 and result.month == 8 and result.day == 10


def test_coerce_date_accepts_relative_keyword():
    result = coerce_value("date", "today")
    assert result is not None


def test_coerce_date_rejects_garbage():
    with pytest.raises(OpFilterValidationError):
        coerce_value("date", "not-a-date")


def test_coerce_uuid_accepts_valid_uuid_rejects_garbage():
    valid = "12345678-1234-5678-1234-567812345678"
    assert coerce_value("uuid", valid) == valid
    with pytest.raises(OpFilterValidationError):
        coerce_value("uuid", "not-a-uuid")


def test_coerce_uuid_or_me_accepts_me_and_uuid():
    assert coerce_value("uuid_or_me", "me") == "me"
    valid = "12345678-1234-5678-1234-567812345678"
    assert coerce_value("uuid_or_me", valid) == valid
    with pytest.raises(OpFilterValidationError):
        coerce_value("uuid_or_me", "nope")


def test_coerce_verification_status_accepts_enum_rejects_other():
    assert coerce_value("verification_status", "verified") == "verified"
    with pytest.raises(OpFilterValidationError):
        coerce_value("verification_status", "bogus")


def test_coerce_verification_status_rejects_unhashable_value_without_a_typeerror():
    # A dict/list raw_value must fail loudly as FilterValidationError, same
    # as every other arg_type — not leak a raw TypeError from `in` against
    # the enum set.
    with pytest.raises(OpFilterValidationError):
        coerce_value("verification_status", {"a": 1})


# --- compile_condition ---------------------------------------------------

_ARG_TYPE_SAMPLE_VALUES: dict[str, list[Any]] = {
    "none": [None],
    "str": ["needle"],
    "num": [42],
    "bool": [True],
    "str_or_list": ["needle", ["needle", "other"]],
    "date": ["2026-08-10"],
    "uuid": ["12345678-1234-5678-1234-567812345678"],
    "uuid_or_me": ["12345678-1234-5678-1234-567812345678"],
    "verification_status": ["verified"],
}


def _ctx_for(prop_type: str) -> SqlContext:
    # Any jsonb-backed condition works with an arbitrary base62-shaped key;
    # the native-array branch is exercised separately via `topics`.
    if prop_type == "relation":
        # "relation" needs a real RelationRef (task-20-brief.md §3.1) --
        # compile_condition's relation branch raises FilterValidationError
        # when ctx.relation is None, which is exercised separately by
        # test_compile_condition_relation_without_ref_raises below. This
        # matrix sweep is about proving every (type, operator) pair
        # compiles, so it needs a *configured* relation property.
        return SqlContext(
            key="a1b2c3d4",
            alias="p",
            storage="jsonb",
            relation=RelationRef(relation_id=str(uuid.uuid4()), side="forward"),
            row_id_expr="n.id",
            user_id="u-1",
        )
    return SqlContext(key="a1b2c3d4", alias="p", storage="jsonb")


@pytest.mark.parametrize(
    "prop_type,operator_name",
    [
        (prop_type, operator_name)
        for prop_type, ops in TYPE_OPERATORS.items()
        for operator_name in ops
    ],
)
def test_compile_condition_covers_full_matrix(prop_type, operator_name):
    operator = TYPE_OPERATORS[prop_type][operator_name]
    for sample in _ARG_TYPE_SAMPLE_VALUES[operator.arg_type]:
        frag = compile_condition(
            prop_type, _ctx_for(prop_type), operator_name, sample, user_id="u-1"
        )
        assert isinstance(frag, SqlFragment)
        # No literal occurrence of the bound value anywhere in `sql` —
        # every value travels through `params`, never interpolated.
        for value in frag.params:
            if isinstance(value, str) and value:
                assert value not in frag.sql


def test_compile_condition_unknown_type_raises():
    with pytest.raises(OpFilterValidationError):
        compile_condition("formula", _ctx_for("formula"), "equals", "x", user_id="u-1")


def test_compile_condition_unknown_operator_raises():
    with pytest.raises(OpFilterValidationError):
        compile_condition("title", _ctx_for("title"), "greater_than", "x", user_id="u-1")


# --- Milestone 8 (Task 27): formula/rollup, dispatched by result_type ------


def _ctx_for_result_type(result_type: str) -> SqlContext:
    return SqlContext(key="a1b2c3d4", alias="p", storage="jsonb", result_type=result_type)


@pytest.mark.parametrize("prop_type", ["formula", "rollup"])
@pytest.mark.parametrize(
    "result_type,operator_name,sample",
    [
        (result_type, operator_name, sample)
        for result_type, ops in RESULT_TYPE_OPERATORS.items()
        for operator_name, operator in ops.items()
        for sample in _ARG_TYPE_SAMPLE_VALUES[operator.arg_type]
    ],
)
def test_compile_condition_covers_the_result_type_matrix(prop_type, result_type, operator_name, sample):
    frag = compile_condition(
        prop_type, _ctx_for_result_type(result_type), operator_name, sample, user_id="u-1"
    )
    assert isinstance(frag, SqlFragment)
    assert "p.computed" in frag.sql
    for value in frag.params:
        if isinstance(value, str) and value:
            assert value not in frag.sql


@pytest.mark.parametrize("prop_type", ["formula", "rollup"])
def test_compile_condition_formula_rollup_with_no_result_type_raises(prop_type):
    with pytest.raises(OpFilterValidationError):
        compile_condition(prop_type, _ctx_for_result_type(None), "equals", "x", user_id="u-1")


@pytest.mark.parametrize("prop_type", ["formula", "rollup"])
@pytest.mark.parametrize("result_type", ["list", "person", "page", "unknown", "empty"])
def test_compile_condition_formula_rollup_unfilterable_result_type_raises(prop_type, result_type):
    # research §4.6/§4.7: Notion's own formula API has no list/person/page
    # result type and no filter object for any of them either.
    with pytest.raises(OpFilterValidationError):
        compile_condition(prop_type, _ctx_for_result_type(result_type), "is_empty", None, user_id="u-1")


def test_compile_condition_number_formula_uses_the_number_scalar_sql_shape():
    frag = compile_condition(
        "formula", _ctx_for_result_type("number"), "greater_than", 10, user_id="u-1"
    )
    assert "computed -> 'a1b2c3d4' ->> 'number'" in frag.sql
    assert "::double precision" in frag.sql
    assert frag.sql.strip().endswith("> $1")


def test_compile_condition_date_rollup_uses_the_date_scalar_sql_shape():
    frag = compile_condition(
        "rollup", _ctx_for_result_type("date"), "before", "2026-08-10", user_id="u-1"
    )
    assert "computed -> 'a1b2c3d4' -> 'date' ->> 'start'" in frag.sql


def test_native_array_topics_uses_array_operators():
    ctx = SqlContext(key="topics", alias="notes", storage="column")
    frag = compile_condition("multi_select", ctx, "contains", "sql", user_id="u-1")
    assert "= ANY(" in frag.sql
    assert "?" not in frag.sql


def test_jsonb_multi_select_uses_jsonb_operators():
    ctx = SqlContext(key="a1b2c3d4", alias="p", storage="jsonb")
    frag = compile_condition("multi_select", ctx, "contains", "sql", user_id="u-1")
    assert "?" in frag.sql
    assert "ANY(" not in frag.sql


def test_me_resolution_binds_user_id_not_literal_me():
    ctx = SqlContext(key="a1b2c3d4", alias="p", storage="jsonb")
    frag = compile_condition("people", ctx, "contains", "me", user_id="user-123")
    assert "user-123" in frag.params
    assert "me" not in frag.params
    assert "me" not in frag.sql


# --- Milestone 7: relation's EXISTS/NOT EXISTS branch -----------------------


def test_compile_condition_relation_without_ref_raises():
    # ctx.relation is None -- a malformed/pre-015 relation property, or a
    # caller bug. A 400 (FilterValidationError), never a crash and never a
    # silent JSONB fallback (task-20-brief.md §3.2).
    ctx = SqlContext(key="a1b2c3d4", alias="p", storage="jsonb")
    with pytest.raises(OpFilterValidationError):
        compile_condition("relation", ctx, "contains", str(uuid.uuid4()), user_id="u-1")


def _relation_ctx(side="forward", relation_id=None) -> SqlContext:
    return SqlContext(
        key="a1b2c3d4",
        alias="p",
        storage="jsonb",
        relation=RelationRef(relation_id=relation_id or str(uuid.uuid4()), side=side),
        row_id_expr="n.id",
        user_id="u-1",
    )


def test_relation_contains_compiles_to_exists_with_bound_relation_id_and_user_id():
    other_id = str(uuid.uuid4())
    frag = compile_condition("relation", _relation_ctx(), "contains", other_id, user_id="u-1")
    assert frag.sql.strip().startswith("EXISTS")
    assert "db_relation_links" in frag.sql
    assert "rl.from_row_id = n.id" in frag.sql
    assert "rl.to_row_id = $3" in frag.sql
    assert frag.params[-1] == other_id
    # relation_id and user_id are bound params, never literals.
    assert frag.params[0] not in frag.sql
    assert "u-1" not in frag.sql


def test_relation_does_not_contain_compiles_to_not_exists():
    frag = compile_condition(
        "relation", _relation_ctx(), "does_not_contain", str(uuid.uuid4()), user_id="u-1"
    )
    assert frag.sql.strip().startswith("NOT EXISTS")


def test_relation_is_empty_and_is_not_empty_omit_the_value_clause():
    empty_frag = compile_condition("relation", _relation_ctx(), "is_empty", None, user_id="u-1")
    assert empty_frag.sql.strip().startswith("NOT EXISTS")
    assert len(empty_frag.params) == 2  # relation_id, user_id only

    not_empty_frag = compile_condition(
        "relation", _relation_ctx(), "is_not_empty", None, user_id="u-1"
    )
    assert not_empty_frag.sql.strip().startswith("EXISTS")
    assert len(not_empty_frag.params) == 2


def test_relation_reverse_side_swaps_own_and_other_columns():
    forward_frag = compile_condition(
        "relation", _relation_ctx(side="forward"), "is_not_empty", None, user_id="u-1"
    )
    reverse_frag = compile_condition(
        "relation", _relation_ctx(side="reverse"), "is_not_empty", None, user_id="u-1"
    )
    assert "rl.from_row_id = n.id" in forward_frag.sql
    assert "rl.to_row_id = n.id" in reverse_frag.sql


def test_relation_value_must_be_a_uuid():
    with pytest.raises(OpFilterValidationError):
        compile_condition("relation", _relation_ctx(), "contains", "not-a-uuid", user_id="u-1")


# --- Fix-round findings (task review of 93f0655..1b49404) ------------------

@pytest.mark.parametrize("prop_type", ["created_by", "last_edited_by"])
def test_created_by_and_last_edited_by_use_text_scalar_sql_not_jsonb_array(prop_type):
    # REGISTRY[...].sql_extract() for these two types is NOT in base.py's
    # _ARRAY_VALUED (only multi_select/people/files are, since Milestone 7
    # repointed relation off JSONB entirely), so it falls through to the
    # plain text-scalar shape ("->>' <type>'", not the
    # bare "-> '<type>'" the array types get). Postgres has no `text ? ...`
    # or `text = jsonb` operator, so routing these through the jsonb-array
    # SQL family (`E ? $1`, `E = '[]'::jsonb`, ...) would fail at execution
    # time -- a bug the DB-free full-matrix test couldn't catch because it
    # only asserts "a SqlFragment came back," never inspects its shape.
    ctx = SqlContext(key="a1b2c3d4", alias="p", storage="jsonb")

    contains_frag = compile_condition(
        prop_type, ctx, "contains", "12345678-1234-5678-1234-567812345678", user_id="u-1"
    )
    assert "->>" in contains_frag.sql  # scalar text extraction, not the bare array "->"
    assert "?" not in contains_frag.sql
    assert "'[]'::jsonb" not in contains_frag.sql

    empty_frag = compile_condition(prop_type, ctx, "is_empty", None, user_id="u-1")
    assert "= ''" in empty_frag.sql  # text-empty check, not jsonb "= '[]'::jsonb"
    assert "'[]'::jsonb" not in empty_frag.sql


_DATE_WINDOW_OPERATORS = (
    "this_week", "past_week", "past_month", "past_year",
    "next_week", "next_month", "next_year",
)


def _is_fully_parenthesized(sql: str) -> bool:
    """True iff `sql` is wrapped in one matching outer `(...)` pair that
    doesn't close until the very last character. A naive `startswith("(")
    and endswith(")")` check is NOT sufficient here: several of the
    date-window fragments end in `now()`, whose own closing paren
    satisfies `endswith(")")` even when the fragment's outer boundary
    (from the guarded-date CASE expression) closes early mid-string —
    exactly the bug this test exists to catch."""
    if not (sql.startswith("(") and sql.endswith(")")):
        return False
    depth = 0
    for i, ch in enumerate(sql):
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0 and i != len(sql) - 1:
                return False
    return depth == 0


@pytest.mark.parametrize("operator_name", _DATE_WINDOW_OPERATORS)
def test_date_window_operators_are_self_parenthesized(operator_name):
    # Every other multi-clause fragment in this module self-parenthesizes;
    # these 7 were the exception. compile_condition's contract with Task 12
    # is that a fragment is atomic -- an unparenthesized `A AND B` spliced
    # into `... OR <this fragment>` silently mis-binds (AND before OR), no
    # error, just wrong rows.
    ctx = SqlContext(key="a1b2c3d4", alias="p", storage="jsonb")
    frag = compile_condition("date", ctx, operator_name, None, user_id="u-1")
    assert _is_fully_parenthesized(frag.sql), frag.sql

    # Concretely: joined with a sibling OR clause, the fragment's own
    # boundary must be the only thing OR can see -- not one of its
    # internal ANDs.
    joined = f"{frag.sql} OR some_other_condition"
    assert joined.startswith("(") and " OR some_other_condition" in joined


def test_coerce_date_relative_and_iso_both_return_aware_datetimes():
    # Both branches of coerce_value("date", ...) must return the same kind
    # of datetime -- these get bound against ::timestamptz SQL, and asyncpg
    # cares whether a bound datetime is naive or aware.
    relative = coerce_value("date", "today")
    iso_no_offset = coerce_value("date", "2026-08-10")
    iso_with_offset = coerce_value("date", "2026-08-10T12:00:00Z")
    assert relative.tzinfo is not None
    assert iso_no_offset.tzinfo is not None
    assert iso_with_offset.tzinfo is not None


def test_coerce_date_today_uses_utc_calendar_day_not_local_system_clock():
    from datetime import UTC, datetime

    from services.db.query.operators import _resolve_relative_date

    result = _resolve_relative_date("today")
    assert result.date() == datetime.now(UTC).date()


# --- The numeric cast (properties/base.py, spec §8.2) ----------------------
#
# Spec §8.2 calls for a *guarded* `::double precision` cast (CASE WHEN ...
# ELSE NULL END) so one malformed legacy `number` value can't fail a whole
# filtered query. M3 tried that guard and reverted it (see task-11-report.md):
# it breaks Milestone 0's validated B-tree expression index, since a
# CASE-wrapped expression no longer matches the bare-cast expression the
# index was built on. The human partner decided, given zero legacy/malformed
# `number` data exists yet for this brand-new feature, to keep the fast
# indexed path and defer the guard. This test documents that decision so a
# future change back to a guarded cast is a deliberate one, not an accident.

def test_number_sql_extract_uses_the_plain_unguarded_cast_by_deliberate_m3_decision():
    from services.db.properties.base import REGISTRY as base_registry

    frag = base_registry["number"].sql_extract(SqlContext(key="a1b2c3d4", alias="p"))
    assert "CASE WHEN" not in frag.sql
    assert frag.sql == "(p.properties -> 'a1b2c3d4' ->> 'number')::double precision"
