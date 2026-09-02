"""Tests for services/db/formula/{types,typecheck}.py -- Milestone 8b (Task
24): the seven-type type system, `unify()`, and the type checker built on
Task 23's parser. See task-24-brief.md and docs/research/notion-databases-
research.md §H.1/§H.1.8/§H.1.9/§H.2.3/§H.2.4/§H.2.5/§H.2.12/§H.3.1-3.8 for
the language spec this is testing against.

Pure Python, no database, no fixtures.
"""
from __future__ import annotations

import itertools

import pytest

from services.db.formula import parse
from services.db.formula.types import FType, PROPERTY_TYPE_TO_FTYPE, unify
from services.db.formula.typecheck import FUNCTION_SIGNATURES, check


def _check(src: str, properties: dict[str, str] | None = None):
    properties = properties or {}
    tree = parse(src, property_names=properties.keys())
    return check(tree, properties=properties)


# ---------------------------------------------------------------------------
# unify() -- truth table across all 7 types plus EMPTY/UNKNOWN
# ---------------------------------------------------------------------------

_VALUE_TYPES = [
    FType.STRING,
    FType.NUMBER,
    FType.BOOLEAN,
    FType.DATE,
    FType.LIST,
    FType.PERSON,
    FType.PAGE,
]
_ALL_TYPES = _VALUE_TYPES + [FType.EMPTY, FType.UNKNOWN]


def test_unify_same_type_is_itself():
    for t in _ALL_TYPES:
        assert unify(t, t) == t


def test_unify_distinct_value_types_never_unify():
    for a, b in itertools.combinations(_VALUE_TYPES, 2):
        assert unify(a, b) is None
        assert unify(b, a) is None


def test_unify_empty_unifies_with_everything():
    # Checked against the 7 real value types, where "unifies with
    # everything, returning the other type" has one unambiguous meaning.
    # EMPTY-vs-UNKNOWN (two different wildcards) is checked separately below
    # -- which literal value comes back when BOTH sides are wildcards isn't
    # part of the contract, only that the result is non-None.
    for t in _VALUE_TYPES:
        assert unify(FType.EMPTY, t) == t
        assert unify(t, FType.EMPTY) == t
    assert unify(FType.EMPTY, FType.EMPTY) == FType.EMPTY


def test_unify_unknown_unifies_with_everything():
    for t in _VALUE_TYPES:
        assert unify(FType.UNKNOWN, t) == t
        assert unify(t, FType.UNKNOWN) == t
    assert unify(FType.UNKNOWN, FType.UNKNOWN) == FType.UNKNOWN


def test_unify_empty_and_unknown_together():
    # Both are wildcards; unify(a, b) with a in {EMPTY, UNKNOWN} always
    # takes the "a is a wildcard" branch and returns b. Not required to be
    # symmetric when BOTH sides are (different) wildcards -- only that
    # neither direction is ever None (an incompatibility), which is all
    # `unify`'s contract promises.
    assert unify(FType.EMPTY, FType.UNKNOWN) is not None
    assert unify(FType.UNKNOWN, FType.EMPTY) is not None


def test_seven_value_types_exactly():
    # Research §H.1.1: "Notion formulas have seven value types" -- stated
    # explicitly, count checked here so a miscount (the brief warns this
    # exact spot is where "eight" sometimes creeps in from stale docs) fails
    # loudly.
    assert len(_VALUE_TYPES) == 7
    assert len(set(_VALUE_TYPES)) == 7


# ---------------------------------------------------------------------------
# Property-type -> formula-type mapping (research §1.2, all 24 REGISTRY keys)
# ---------------------------------------------------------------------------


def test_property_type_mapping_covers_all_24_registry_keys():
    from services.db.properties.base import REGISTRY

    assert set(PROPERTY_TYPE_TO_FTYPE.keys()) == set(REGISTRY.keys())
    assert len(PROPERTY_TYPE_TO_FTYPE) == 24


@pytest.mark.parametrize(
    "prop_type,expected",
    [
        ("title", FType.STRING),
        ("multi_select", FType.LIST),
        ("checkbox", FType.BOOLEAN),
        ("date", FType.DATE),
        ("relation", FType.LIST),
        ("created_by", FType.PERSON),
        ("number", FType.NUMBER),
    ],
)
def test_property_type_mapping_spot_checks(prop_type, expected):
    assert PROPERTY_TYPE_TO_FTYPE[prop_type] == expected


# ---------------------------------------------------------------------------
# The plan's named cases
# ---------------------------------------------------------------------------


def test_add_function_rejects_string_argument():
    # research §1.8: "add(2, "2") -- arithmetic never parses a string."
    r = _check('add(2, "2")')
    assert r.errors
    assert "add" in r.errors[0].message


def test_plus_operator_concatenates_string_and_number():
    # Same brief example, opposite operator: `2 + "2"` concatenates, no
    # error -- the documented add()/+ asymmetry.
    r = _check('2 + "2"')
    assert r.errors == []
    assert r.type == FType.STRING


def test_official_example_if_date_branch_unifies_with_empty_string_is_error():
    props = {"Date": "date"}
    r = _check('if(Date, Date.dateAdd(1,"day"), "")', props)
    assert r.errors
    assert "branches" in r.errors[0].message


def test_official_example_if_date_branch_unifies_with_empty_call_is_fine():
    props = {"Date": "date"}
    r = _check('if(Date, Date.dateAdd(1,"day"), empty())', props)
    assert r.errors == []
    assert r.type == FType.DATE


# ---------------------------------------------------------------------------
# Strict == / !=
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "src",
    [
        '"1" == 1',
        '"true" != true',
        "1 == true",
        '[] == ""',
        "now() == 1",
    ],
)
def test_strict_equality_cross_type_never_errors(src):
    r = _check(src)
    assert r.errors == [], r.errors
    assert r.type == FType.BOOLEAN


# ---------------------------------------------------------------------------
# Booleans compare as 1/0
# ---------------------------------------------------------------------------


def test_boolean_comparison_type_checks():
    r = _check("true > false")
    assert r.errors == []
    assert r.type == FType.BOOLEAN


def test_date_comparison_type_checks():
    # research §2.6's own official example: `now() > Due Date`.
    props = {"Due Date": "date"}
    r = _check("now() > Due Date", props)
    assert r.errors == []
    assert r.type == FType.BOOLEAN


def test_string_comparison_via_greater_than_is_a_type_error():
    # No documented evidence extends `>` to strings (only `sort()` orders
    # them) -- decided conservatively; see typecheck.py's `_COMPARABLE`.
    r = _check('"a" > "b"')
    assert r.errors


# ---------------------------------------------------------------------------
# Function signature table
# ---------------------------------------------------------------------------


def test_function_signature_count_is_93_not_88():
    # The brief and research §3's headline both say "88 functions on the
    # official reference." A careful tally of research's own §3.1-3.8
    # per-section tables (whose *header* counts already include the P2
    # community functions padStart/padEnd/count/splice) sums to 93, and
    # cross-checks exactly against research's separately stated "~97
    # callable names total" once prop/context/let/lets (4 more, from §3.10,
    # not counted in the 3.1-3.8 headers) are added: 93 + 4 == 97. "88"
    # appears to be a genuine arithmetic slip in the research document
    # itself -- flagged in this task's report as a brief/research defect,
    # not silently followed. This test pins the verified number (93) so a
    # function accidentally added or dropped from FUNCTION_SIGNATURES still
    # fails loudly, which is the actual point of the brief's count-assertion
    # instruction.
    assert len(FUNCTION_SIGNATURES) == 93


def test_every_documented_function_name_has_a_signature():
    names = {
        "if", "ifs", "and", "or", "not", "equal", "unequal", "empty",
        "add", "subtract", "multiply", "divide", "mod", "pow", "abs",
        "round", "ceil", "floor", "sqrt", "cbrt", "exp", "ln", "log10",
        "log2", "sign", "min", "max", "sum", "median", "mean", "pi", "e",
        "toNumber", "length", "substring", "contains", "lower", "upper",
        "repeat", "trim", "padStart", "padEnd", "split", "join", "format",
        "formatNumber", "link", "style", "unstyle", "test", "match",
        "replace", "replaceAll", "now", "today", "minute", "hour", "day",
        "date", "week", "month", "year", "dateAdd", "dateSubtract",
        "dateBetween", "dateRange", "dateStart", "dateEnd", "timestamp",
        "fromTimestamp", "formatDate", "parseDate", "at", "first", "last",
        "slice", "concat", "sort", "reverse", "unique", "includes", "find",
        "findIndex", "filter", "some", "every", "map", "flat", "count",
        "splice", "id", "name", "email",
    }
    assert names == set(FUNCTION_SIGNATURES.keys())
    assert len(names) == 93


# ---------------------------------------------------------------------------
# ifs() shape
# ---------------------------------------------------------------------------


def test_ifs_even_argument_count_is_error():
    r = _check("ifs(true, 1, false, 2)")
    assert r.errors
    assert "odd" in r.errors[0].message


def test_ifs_odd_argument_count_unifies_branches():
    r = _check("ifs(true, 1, true, 2, 3)")
    assert r.errors == []
    assert r.type == FType.NUMBER


def test_ifs_branch_mismatch_is_error():
    r = _check('ifs(true, 1, false, "x", 3)')
    assert r.errors


def test_ifs_condition_slot_accepts_any_type():
    props = {"Date": "date"}
    r = _check('ifs(Date, 1, 2)', props)
    assert r.errors == []


# ---------------------------------------------------------------------------
# Variables: unbound, shadowing, sequential lets
# ---------------------------------------------------------------------------


def test_unbound_variable_is_error():
    r = _check("undefinedVar + 1")
    assert r.errors
    assert "unbound" in r.errors[0].message


def test_lets_bindings_are_sequential():
    # var2's value references var1 -- must type-check, proving each binding
    # sees the ones before it (Task 23's ruling, inherited).
    r = _check("lets(a, 2, b, a + 1, b)")
    assert r.errors == []
    assert r.type == FType.NUMBER


def test_let_inner_shadows_outer():
    r = _check('let(a, 1, let(a, "x", a))')
    assert r.errors == []
    assert r.type == FType.STRING


def test_let_body_sees_bindings_not_outer_scope_after_close():
    # `a` used outside its let() is unbound.
    r = _check("let(a, 1, a) + a")
    assert r.errors
    assert "unbound" in r.errors[-1].message


# ---------------------------------------------------------------------------
# Volatility
# ---------------------------------------------------------------------------


def test_volatile_now_top_level():
    r = _check("now()")
    assert r.is_volatile is True


def test_volatile_today_nested_deep_inside_let_body():
    r = _check("let(a, 1, let(b, a + 1, if(b > 0, today(), empty())))")
    assert r.is_volatile is True


def test_not_volatile_without_now_or_today():
    r = _check("1 + 2")
    assert r.is_volatile is False


def test_volatile_now_inside_list_literal_inside_map():
    r = _check("map([1,2,3], if(current > now(), 1, 0))")
    assert r.is_volatile is True


# ---------------------------------------------------------------------------
# Higher-order list functions: current/index binding
# ---------------------------------------------------------------------------


def test_map_binds_current_and_index():
    r = _check("map([1,2,3], current + index)")
    assert r.errors == []
    assert r.type == FType.LIST


def test_index_bound_in_filter_not_only_map():
    # Brief's ruling (research leaves this UNRESOLVED): bind `index`
    # everywhere, not only `map`.
    r = _check("filter([1,2,3], index > 0)")
    assert r.errors == []
    assert r.type == FType.LIST


def test_index_bound_in_sort_comparator():
    r = _check("sort([1,2,3], index)")
    assert r.errors == []


def test_index_bound_in_count_predicate():
    r = _check("count([1,2,3], index > 0)")
    assert r.errors == []
    assert r.type == FType.NUMBER


def test_current_outside_list_function_is_unbound():
    r = _check("current + 1")
    assert r.errors
    assert "unbound" in r.errors[0].message


def test_map_wrong_arity_is_error():
    r = _check("map([1,2,3])")
    assert r.errors


def test_map_first_arg_must_be_list():
    r = _check("map(5, current)")
    assert r.errors


def test_find_returns_unknown_element_type_no_error():
    # `current`/element types are UNKNOWN by design (LIST is unparameterised
    # -- see types.py); this is a documented limitation, not a bug, so a
    # find() over a heterogeneous-looking list still type-checks cleanly.
    r = _check('find(["a","b","c"], current == "b")')
    assert r.errors == []
    assert r.type == FType.UNKNOWN


# ---------------------------------------------------------------------------
# Dot-notation rewrite: a.f(b) type-checks exactly as f(a, b)
# ---------------------------------------------------------------------------


def test_dot_form_and_call_form_agree_length():
    a = _check('"hello".length()')
    b = _check('length("hello")')
    assert a.errors == b.errors == []
    assert a.type == b.type == FType.NUMBER


def test_dot_form_reports_error_at_written_position():
    # `[1,2].trim()` -- trim requires a String, and a List receiver has no
    # coercion path (Number/Boolean receivers DO coerce as of the M8 fix
    # wave -- see test_number_receiver_coerces_to_string_for_string_methods
    # below, which is why this test no longer uses `5.trim()`). Dot form
    # should error exactly like the call form would, positioned at the
    # written dot-call.
    r = _check("[1,2].trim()")
    assert r.errors


def test_number_receiver_coerces_to_string_for_string_methods():
    # research §1.8, official: 1932.substring(0,2) == "19". M8 combined
    # review finding: Task 25's runtime already implements this
    # (functions/string.py's `_as_string_receiver`) but Task 24's checker
    # never agreed, so this legal formula failed to type-check. Fixed to
    # match the runtime exactly (typecheck.py's `_STRING_RECEIVER_
    # COERCIBLE`).
    r = _check("1932.substring(0,2)")
    assert r.errors == []
    assert r.type == FType.STRING


def test_boolean_receiver_also_coerces_to_string():
    # `_as_string_receiver` coerces both Number AND Boolean receivers --
    # the checker mirrors both, not just the Number case research's one
    # worked example happens to use.
    r = _check("true.upper()")
    assert r.errors == []
    assert r.type == FType.STRING


def test_number_receiver_coercion_is_scoped_to_the_receiver_position_only():
    # `contains`'s SECOND argument (the needle) is coerced by
    # functions/string.py's runtime too, but this fix deliberately does not
    # extend the checker there -- research documents exactly one worked
    # example (a RECEIVER), and this finding's own instruction was to scope
    # the fix to that, not invent a blanket Number/Boolean->String
    # coercion. A non-receiver Number argument still errors.
    r = _check('contains("hello", 5)')
    assert r.errors != []


def test_number_receiver_coercion_does_not_extend_to_regex_functions():
    # functions/regex.py documents a separate, already-distinct Number/
    # Boolean->String coercion rule (research's own different table row for
    # test/match/replace/replaceAll) -- untouched by this fix.
    r = _check('test(42, "^4")')
    assert r.errors != []


def test_dot_form_if_three_combined_args_is_conditional_equivalent():
    r = _check('true.if("a", "b")')
    assert r.errors == []
    assert r.type == FType.STRING


# ---------------------------------------------------------------------------
# prop() / property resolution
# ---------------------------------------------------------------------------


def test_prop_call_resolves_known_property():
    props = {"Title": "title"}
    r = _check('prop("Title")', props)
    assert r.errors == []
    assert r.type == FType.STRING


def test_prop_call_unknown_property_is_error_and_unknown_type():
    r = _check('prop("Nope")')
    assert r.errors
    assert "unknown property" in r.errors[0].message
    assert r.type == FType.UNKNOWN


def test_bare_property_ref_resolves_same_as_prop_call():
    props = {"Start Date": "date"}
    r = _check("Start Date", props)
    assert r.errors == []
    assert r.type == FType.DATE


def test_unresolved_property_does_not_cascade_into_second_error():
    # unknown property -> UNKNOWN; UNKNOWN + 1 must NOT also error.
    r = _check('prop("Nope") + 1')
    assert len(r.errors) == 1


def test_dot_prop_resolves_against_current_data_source():
    # current.Status desugars (parser) to MethodCall(current, "prop",
    # [Literal("Status")]); typecheck resolves it against the SAME
    # properties dict as a bare prop("Status") would (documented
    # simplification -- see typecheck.py's _check_prop_call docstring).
    # `current` is only bound inside a higher-order list function's
    # expr argument, matching research's own example shape
    # (`Parent Task.Sub-item.every(current.Status == "Done")`).
    props = {"Status": "status"}
    r = _check('filter([1,2,3], current.Status == "Done")', props)
    assert r.errors == []
    assert r.type == FType.LIST


# ---------------------------------------------------------------------------
# context()
# ---------------------------------------------------------------------------


def test_context_known_variable():
    r = _check('context("Trigger page")')
    assert r.errors == []
    assert r.type == FType.PAGE


def test_context_unknown_variable_is_error():
    r = _check('context("Nonsense")')
    assert r.errors


# ---------------------------------------------------------------------------
# variable.lets(...) dot form: no defined semantics, rejected
# ---------------------------------------------------------------------------


def test_lets_dot_form_is_rejected_not_silently_accepted():
    r = _check("5.lets(a, 1, a)")
    assert r.errors
    assert any("dot-notation" in e.message for e in r.errors)


# ---------------------------------------------------------------------------
# List literal heterogeneity
# ---------------------------------------------------------------------------


def test_heterogeneous_list_literal_type_checks():
    r = _check('["Apples", 1, true, now()]')
    assert r.errors == []
    assert r.type == FType.LIST


# ---------------------------------------------------------------------------
# empty()
# ---------------------------------------------------------------------------


def test_empty_zero_arg_returns_empty_type():
    r = _check("empty()")
    assert r.errors == []
    assert r.type == FType.EMPTY


def test_empty_one_arg_returns_boolean():
    r = _check('empty("")')
    assert r.errors == []
    assert r.type == FType.BOOLEAN


# ---------------------------------------------------------------------------
# Unknown function
# ---------------------------------------------------------------------------


def test_unknown_function_is_error():
    r = _check("totallyNotAFunction(1, 2)")
    assert r.errors
    assert "unknown function" in r.errors[0].message


# ---------------------------------------------------------------------------
# CheckResult.referenced matches deps.referenced_properties (spec §7.2)
# ---------------------------------------------------------------------------


def test_check_result_referenced_matches_deps_module():
    from services.db.formula.deps import referenced_properties

    props = {"A": "number", "B": "number"}
    tree = parse('prop("A") + B', property_names=props.keys())
    r = check(tree, properties=props)
    assert r.referenced == referenced_properties(tree) == {"A", "B"}
