"""Tests for services/db/formula/{values,evaluator}.py -- Milestone 8c
(Task 25): the runtime value model (`FValue`/`EMPTY`/`is_empty`/`truthy`/
`as_number`/`stringify`) and the tree-walking evaluator built on Task 23's
parser and Task 24's checker. See task-25-brief.md and docs/research/
notion-databases-research.md §H.1/§H.1.4/§H.1.8/§H.1.9/§H.2.3-2.5 for the
language spec this is testing against.

Function-level golden values (the 53 logic/numeric/string/regex builtins)
live in test_formula_functions_core.py; this file is the evaluator's OWN
machinery: dispatch, EMPTY propagation, the bool-before-float trap, dot
notation, `let`/`lets`, `prop`/`context`, and the registry's own
consistency check.

Pure Python, no database, no fixtures.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from services.db.formula import check, parse
from services.db.formula.evaluator import EvalContext, FormulaEvalError, evaluate, make_now
from services.db.formula.values import EMPTY, Page, Person, as_number, is_empty, stringify, truthy
from services.db.formula import ast as A
from services.db.formula import functions


def _eval(src: str, properties: dict[str, str] | None = None, values: dict | None = None):
    properties = properties or {}
    tree = parse(src, property_names=properties.keys())
    ctx = EvalContext(properties=values or {}, now=make_now())
    return evaluate(tree, ctx)


def _eval_checked(src: str, properties: dict[str, str] | None = None, values: dict | None = None):
    """Like `_eval`, but also returns the type-checker's errors, for tests
    that want to assert BOTH sides at once (brief §4: "add(2,"2") rejected
    at type-check while 2 + "2" concatenates and evaluates")."""
    properties = properties or {}
    tree = parse(src, property_names=properties.keys())
    result = check(tree, properties=properties)
    ctx = EvalContext(properties=values or {}, now=make_now())
    return evaluate(tree, ctx), result.errors


# ---------------------------------------------------------------------------
# values.py: is_empty / truthy / as_number / stringify
# ---------------------------------------------------------------------------


class TestIsEmpty:
    def test_empty_sentinel_is_empty(self):
        assert is_empty(EMPTY) is True

    def test_zero_is_empty_official(self):
        # research §1.4, official: "0, "", and [] are considered empty."
        assert is_empty(0.0) is True

    def test_empty_string_is_empty_official(self):
        assert is_empty("") is True

    def test_empty_list_is_empty_official(self):
        assert is_empty([]) is True

    def test_nonzero_number_is_not_empty(self):
        assert is_empty(1.0) is False
        assert is_empty(-1.0) is False

    def test_nonempty_string_is_not_empty(self):
        assert is_empty("x") is False

    def test_nonempty_list_is_not_empty(self):
        assert is_empty([1.0]) is False

    def test_bool_before_float_trap_false_is_not_empty(self):
        # THE classic this task's brief calls out by name: Python's `bool`
        # is a subclass of `int` and `False == 0.0` is `True`, but the
        # official empty() definition names exactly three empty values
        # (0, "", []) and `false` is not one of them.
        assert is_empty(False) is False
        assert is_empty(True) is False


class TestTruthy:
    def test_real_booleans_used_as_is(self):
        assert truthy(True) is True
        assert truthy(False) is False

    def test_empty_is_falsy(self):
        # research §2.3's own hint: "likely non-empty => true, matching
        # empty()." EMPTY has no documented truthiness rule of its own
        # (brief-uncovered decision, flagged in this task's report) --
        # decided consistent with that hint: EMPTY (being empty) is falsy.
        assert truthy(EMPTY) is False

    def test_zero_is_falsy_matching_empty(self):
        assert truthy(0.0) is False

    def test_nonzero_number_is_truthy(self):
        assert truthy(1.0) is True
        assert truthy(-1.0) is True

    def test_empty_string_is_falsy(self):
        assert truthy("") is False

    def test_nonempty_string_is_truthy(self):
        assert truthy("x") is True

    def test_empty_list_is_falsy_nonempty_list_is_truthy(self):
        assert truthy([]) is False
        assert truthy([1.0]) is True


class TestAsNumber:
    def test_float_passes_through(self):
        assert as_number(3.5) == 3.5

    def test_bool_is_not_a_number_here(self):
        # `as_number` (arithmetic operators, numeric builtins) is stricter
        # than `toNumber()` (functions/numeric.py) -- booleans do NOT
        # implicitly participate in `+`/`-`/etc. the way they do in
        # `>`/`<` comparisons or explicit `toNumber()`.
        assert as_number(True) is None
        assert as_number(False) is None

    def test_string_is_not_a_number_here(self):
        # research §1.8: add(2, "2") is a type error, not a parse attempt.
        assert as_number("2") is None


class TestStringify:
    def test_bool_lowercase(self):
        assert stringify(True) == "true"
        assert stringify(False) == "false"

    def test_integral_float_no_trailing_dot_zero(self):
        assert stringify(3.0) == "3"
        assert stringify(-2.0) == "-2"

    def test_fractional_float_keeps_decimals(self):
        assert stringify(3.5) == "3.5"

    def test_string_passes_through(self):
        assert stringify("hi") == "hi"


# ---------------------------------------------------------------------------
# EMPTY propagation (the general rule, brief §2)
# ---------------------------------------------------------------------------


class TestEmptyPropagation:
    @pytest.mark.parametrize(
        "src",
        [
            "empty() + 1",
            "1 + empty()",
            "empty() - 1",
            "1 - empty()",
            "empty() * 2",
            "empty() / 2",
            "2 / empty()",
            "empty() % 2",
            "empty() ^ 2",
            "-empty()",
            "empty() > 1",
            "1 > empty()",
            "abs(empty())",
            "round(empty())",
            "lower(empty())",
            "length(empty())",
        ],
    )
    def test_operation_on_empty_yields_empty(self, src):
        assert _eval(src) is EMPTY

    def test_and_or_propagate_empty_too(self):
        # `and`/`or`/`not` are NOT in the evaluator's `_EMPTY_AWARE`
        # exception set -- ordinary propagation applies to them exactly
        # like any other function/operator.
        assert _eval("empty() and true") is EMPTY
        assert _eval("empty() or false") is EMPTY
        assert _eval("not empty()") is EMPTY

    def test_empty_predicate_is_the_documented_exception(self):
        # `empty(x)` must SEE a raw EMPTY argument to do its job.
        assert _eval("empty(empty())") is True

    def test_if_condition_empty_is_falsy_not_propagated(self):
        # If `if` propagated EMPTY like an ordinary function, this would
        # be EMPTY instead of evaluating the else-branch.
        assert _eval('if(empty(), "then", "else")') == "else"

    def test_ifs_condition_empty_is_falsy_not_propagated(self):
        assert _eval('ifs(empty(), "a", true, "b", "c")') == "b"

    def test_equal_sees_raw_empty_not_propagated(self):
        assert _eval("empty() == empty()") is True
        assert _eval("empty() == 0") is False  # strict cross-type-ish: EMPTY only equals EMPTY
        assert _eval("empty() != 0") is True


# ---------------------------------------------------------------------------
# `+` overload vs `add()` -- brief §4's explicit required pairing
# ---------------------------------------------------------------------------


class TestPlusVsAdd:
    def test_add_rejects_string_at_typecheck(self):
        _, errors = _eval_checked('add(2, "2")', properties={})
        assert errors, "add(2, \"2\") must be a type error (research §1.8)"

    def test_plus_concatenates_and_evaluates(self):
        value, errors = _eval_checked('2 + "2"')
        assert errors == []
        assert value == "22"

    def test_plus_stringifies_non_string_side(self):
        # research §1.8's own official example shape:
        # "There are " + prop("Members").length() + " members."
        assert _eval('"count: " + 3') == "count: 3"
        assert _eval('3 + " apples"') == "3 apples"

    def test_bool_operand_to_plus_does_not_silently_become_a_number(self):
        # Python's `True + 1 == 2` would be the WRONG answer here if `+`
        # treated bool as a number the way plain Python arithmetic does --
        # research documents no bool-to-number coercion for arithmetic
        # `+` (only for comparisons and explicit toNumber()).
        assert _eval("true + 1") is EMPTY


# ---------------------------------------------------------------------------
# Comparisons: booleans as 1/0, EMPTY propagation, cross-type -> EMPTY
# ---------------------------------------------------------------------------


class TestComparisons:
    def test_booleans_compare_as_one_and_zero(self):
        # research §1.8, official: "true > false is true."
        assert _eval("true > false") is True
        assert _eval("false > true") is False
        assert _eval("true >= true") is True

    def test_numbers_compare_normally(self):
        assert _eval("1 < 2") is True
        assert _eval("2 <= 2") is True

    def test_strict_equal_cross_type_is_false_never_an_error(self):
        # research §1.8, official: "1" == 1 is false; "true" != true is true.
        assert _eval('"1" == 1') is False
        assert _eval('"true" != true') is True

    def test_equal_bool_vs_number_bool_before_float_trap(self):
        # Python's `True == 1.0` is `True` -- must NOT leak through here.
        assert _eval("true == 1") is False
        assert _eval("false == 0") is False

    def test_string_equality_is_case_sensitive(self):
        assert _eval('"Abc" == "abc"') is False


# ---------------------------------------------------------------------------
# Conditionals: if/ternary share one node; ifs; lazy branch evaluation
# ---------------------------------------------------------------------------


class TestConditionals:
    def test_if_true_and_false_branches(self):
        assert _eval("if(true, 1, 2)") == 1.0
        assert _eval("if(false, 1, 2)") == 2.0

    def test_ternary_is_the_same_construct_as_if(self):
        assert _eval("true ? 1 : 2") == 1.0
        assert _eval("false ? 1 : 2") == 2.0

    def test_ifs_first_true_condition_wins(self):
        assert _eval("ifs(true, 1, true, 2, 3)") == 1.0
        assert _eval("ifs(false, 1, false, 2, 3)") == 3.0

    def test_conditional_only_evaluates_the_chosen_branch(self):
        # Not directly observable via a crash (this language has no
        # exceptions that escape an expression -- see evaluator.py's
        # `_eval_conditional` docstring), but IS observable via `let`
        # scoping: a variable bound only inside the untaken branch's own
        # subtree must not leak into, or be required by, the chosen one.
        assert _eval('if(true, "chosen", let(y, 1, y))') == "chosen"


# ---------------------------------------------------------------------------
# let / lets: sequential bindings, shadowing
# ---------------------------------------------------------------------------


class TestLetLets:
    def test_let_single_binding_official_example(self):
        assert _eval('let(person, "Alan", "Hello, " + person + "!")') == "Hello, Alan!"

    def test_let_multi_binding_official_example(self):
        assert _eval("let(radius, 4, round(pi() * radius ^ 2))") == 50.0

    def test_lets_multi_binding_official_example(self):
        assert _eval('lets(a, "Hello", b, "world", a + " " + b)') == "Hello world"

    def test_lets_sequential_bindings_see_earlier_ones(self):
        assert _eval("lets(base, 3, height, 8, base * height / 2)") == 12.0

    def test_nested_lets_inner_sees_outer(self):
        # research §2.4's own worked nesting example (the STRUCTURE is
        # sourced verbatim; research never states this example's final
        # numeric result, so "2.0" below is our own hand-derivation --
        # var1=4, var2=6, var3=lets(var4=24, var5=6, var5)=6, var3-var1=2
        # -- checking sequential-binding + inner-shadowing mechanics, not
        # a cited Notion output).
        src = """
        lets(
          var1, 2 + 2,
          var2, 3 + 3,
          var3, lets(var4, var1 * var2, var5, var4 / var1, var5),
          var3 - var1
        )
        """
        assert _eval(src) == 2.0

    def test_inner_let_shadows_outer(self):
        assert _eval("let(x, 1, let(x, 2, x))") == 2.0

    def test_shadowing_does_not_leak_back_to_outer_scope(self):
        assert _eval("let(x, 1, let(x, 2, x) + x)") == 3.0


# ---------------------------------------------------------------------------
# prop() / dot notation / context()
# ---------------------------------------------------------------------------


class TestPropAndDotNotation:
    def test_bare_prop_call(self):
        assert _eval('prop("Status")', {"Status": "select"}, {"Status": "Done"}) == "Done"

    def test_bare_token_property_reference(self):
        assert _eval("Status", {"Status": "select"}, {"Status": "Done"}) == "Done"

    def test_unresolved_property_is_empty_not_an_error(self):
        # research §1.9: "a formula with errors can still be saved... the
        # property will display nothing" -- evaluated defensively as
        # EMPTY, distinct from typecheck.py's separate decision to still
        # REPORT the error (Task 24 report, judgment call #5).
        assert _eval('prop("Gone")') is EMPTY

    def test_dot_notation_equals_function_call_notation(self):
        # research §2.5's general rule, official confirmed instance:
        # prop("Title").length() === length(prop("Title")).
        props = {"Title": "title"}
        values = {"Title": "hello"}
        assert _eval('prop("Title").length()', props, values) == _eval(
            'length(prop("Title"))', props, values
        )

    def test_number_receiver_dot_method_coerces_to_string(self):
        # research §1.8, official: 1932.substring(0,2) == "19". Originally
        # exercised the runtime side alone because Task 24's type checker
        # rejected this formula (a gap flagged in Task 25's report, since
        # fixed in the M8 combined-review fix wave -- see
        # test_formula_typecheck.py's
        # test_number_receiver_coerces_to_string_for_string_methods). Now
        # asserts both sides agree, via `_eval_checked`.
        value, errors = _eval_checked("1932.substring(0,2)")
        assert value == "19"
        assert errors == []

    def test_dot_prop_resolves_against_current_row_regardless_of_receiver(self):
        # Task 24's ruling (report judgment call #2), carried into the
        # evaluator unchanged (evaluator._eval_prop's docstring): the
        # receiver's own value is irrelevant to which property gets read.
        props = {"Status": "select"}
        values = {"Status": "Done"}
        assert _eval('(1).prop("Status")', props, values) == "Done"

    def test_context_variable_always_empty_no_automations_yet(self):
        # Task 24's own judgment call #6, carried forward: context() has a
        # real type for introspection but no real runtime source of
        # automation data in this codebase yet.
        assert _eval('context("Whoever triggered")') is EMPTY

    def test_dot_lets_form_is_empty_not_an_error(self):
        # typecheck.py rejects this shape outright; a formula containing
        # it cannot pass type-checking, but per research §1.9 a formula
        # WITH errors can still be saved, so evaluation must not crash.
        assert _eval("x.lets(1, x)") is EMPTY


# ---------------------------------------------------------------------------
# M8 combined-review fix wave: receiver.prop("Name") actually chases a
# relation hop when the receiver evaluates to a Page (evaluator._eval_prop_
# dot). The bug this replaces: the dot form ignored `receiver` entirely and
# always read ctx.properties (THIS row's own values) -- research §3.8's own
# documented idiom, `prop("Tasks").filter(current.prop("Status") != "Done")`,
# therefore compared every element against the CURRENT row's Status instead
# of each related row's, silently -- no exception, just a wrong filter
# result. These two tests fail against the pre-fix `_eval_prop` (confirmed
# by temporarily reverting evaluator.py and re-running this file): the first
# because both pages would resolve to ctx.properties's single "Status"
# value instead of their own distinct ones; the second because the pre-fix
# dot form never calls `with_relation_hop()` at all, so `depth_exceeded`
# could never become true through real dot-prop evaluation.
# ---------------------------------------------------------------------------


class TestRelationHopDotProp:
    def test_dot_prop_resolves_each_related_page_to_its_OWN_value(self):
        # Two Pages, DIFFERENT values under the same property name --
        # exactly the shape a `.filter(current.prop("Status") != "Done")`
        # walk over a real relation produces. Each element's `.prop(...)`
        # must resolve against ITS OWN related row, not the current row's
        # (nor the other element's).
        page1, page2 = Page(id="p1"), Page(id="p2")
        properties = {"Tasks": [page1, page2]}
        related_properties = {
            "p1": {"Status": "Done"},
            "p2": {"Status": "Todo"},
        }
        tree = parse('prop("Tasks").map(current.prop("Status"))', property_names=["Tasks"])
        ctx = EvalContext(properties=properties, now=make_now(), related_properties=related_properties)
        assert evaluate(tree, ctx) == ["Done", "Todo"]

    def test_dot_prop_receiver_ignores_the_current_rows_own_clashing_value(self):
        # The current row ALSO has a "Status" property (a different value
        # from either related page's) -- proves the resolution really did
        # switch away from `ctx.properties` for a Page receiver, rather
        # than coincidentally matching it.
        page = Page(id="p1")
        properties = {"Tasks": [page], "Status": "Current Row Value"}
        related_properties = {"p1": {"Status": "Related Row Value"}}
        tree = parse(
            'prop("Tasks").map(current.prop("Status"))', property_names=["Tasks", "Status"]
        )
        ctx = EvalContext(properties=properties, now=make_now(), related_properties=related_properties)
        assert evaluate(tree, ctx) == ["Related Row Value"]

    def test_dot_prop_chain_trips_the_depth_3_budget_and_sets_depth_exceeded(self):
        # A chain of 4 relation-hop dot-prop calls (default depth_budget=3,
        # spec §7.3): p0 -> p1 -> p2 -> p3 -> p4, each hop resolving via
        # `ctx.related_properties`. The first 3 hops succeed (consuming the
        # whole budget); the 4th finds it exhausted and must yield EMPTY
        # with `ctx.depth_exceeded` set, never a fabricated 4th-hop value
        # and never a raise.
        properties = {"Start": Page(id="p0")}
        related_properties = {
            "p0": {"Next": Page(id="p1")},
            "p1": {"Next": Page(id="p2")},
            "p2": {"Next": Page(id="p3")},
            "p3": {"Next": Page(id="p4")},
        }
        tree = parse(
            'prop("Start").prop("Next").prop("Next").prop("Next").prop("Next")',
            property_names=["Start"],
        )
        ctx = EvalContext(properties=properties, now=make_now(), related_properties=related_properties)
        result = evaluate(tree, ctx)
        assert result is EMPTY
        assert ctx.depth_exceeded is True

    def test_dot_prop_chain_of_exactly_3_hops_stays_within_budget(self):
        # The mirror image of the above: exactly 3 hops (the cap itself)
        # must NOT trip depth_exceeded and must resolve to the real value.
        properties = {"Start": Page(id="p0")}
        related_properties = {
            "p0": {"Next": Page(id="p1")},
            "p1": {"Next": Page(id="p2")},
            "p2": {"Next": "leaf value"},
        }
        tree = parse(
            'prop("Start").prop("Next").prop("Next").prop("Next")',
            property_names=["Start"],
        )
        ctx = EvalContext(properties=properties, now=make_now(), related_properties=related_properties)
        assert evaluate(tree, ctx) == "leaf value"
        assert ctx.depth_exceeded is False


# ---------------------------------------------------------------------------
# EvalContext.now: captured once, threaded, never re-derived
# ---------------------------------------------------------------------------


class TestNowPlumbing:
    def test_make_now_is_utc_aware(self):
        now = make_now()
        assert now.tzinfo is not None
        assert now.utcoffset().total_seconds() == 0

    def test_with_binding_does_not_touch_now(self):
        now = make_now()
        ctx = EvalContext(properties={}, now=now)
        ctx2 = ctx.with_binding("x", 1.0)
        assert ctx2.now is ctx.now

    def test_let_evaluation_threads_the_same_now_through_nested_scopes(self):
        fixed = datetime(2026, 1, 1, tzinfo=timezone.utc)
        tree = parse("let(x, 1, let(y, 2, x + y))")
        ctx = EvalContext(properties={}, now=fixed)
        assert evaluate(tree, ctx) == 3.0
        # `now` is never consumed by anything in this task's four
        # categories (Task 26 is the first real caller) -- this test
        # exists to pin the PLUMBING (the value survives nested `let`
        # scopes unchanged), which is the part this task owns.


# ---------------------------------------------------------------------------
# Defensive / unreachable-by-construction paths
# ---------------------------------------------------------------------------


class TestDefensivePaths:
    def test_lambda_node_raises_formula_eval_error(self):
        # ast.Lambda is never constructed by the parser (Task 23's report:
        # "there is no formula-language syntax that would produce it") --
        # handled defensively here, mirroring typecheck.py's identical
        # branch, in case that ever changes.
        node = A.Lambda(0, params=["x"], body=A.Literal(0, 1.0))
        ctx = EvalContext(properties={}, now=make_now())
        with pytest.raises(FormulaEvalError):
            evaluate(node, ctx)

    def test_unrecognized_function_raises_formula_eval_error_not_key_error(self):
        # A genuinely unknown function name (not one of Task 24's 93 in
        # typecheck.FUNCTION_SIGNATURES) must fail LOUDLY and specifically,
        # not with a bare KeyError or (worse) silently returning EMPTY as
        # if it were a documented runtime edge case. Task 25 wrote this
        # test against `now()`, which was unimplemented at the time;
        # updated by Task 26 (which implements `now()`) to a name that
        # will never exist, since the original assertion (`now()` raises)
        # is no longer true.
        tree = parse("totallyUnimplementedFormulaFunction()")
        ctx = EvalContext(properties={}, now=make_now())
        with pytest.raises(FormulaEvalError, match="totallyUnimplementedFormulaFunction"):
            evaluate(tree, ctx)

    def test_unbound_variable_is_empty_not_a_crash(self):
        tree = A.Variable(0, "nonexistent")
        ctx = EvalContext(properties={}, now=make_now())
        assert evaluate(tree, ctx) is EMPTY


# ---------------------------------------------------------------------------
# Registry consistency (brief §1: "a module-level check, and a test that
# calls it")
# ---------------------------------------------------------------------------


def test_registry_consistency_check_passes():
    functions.check_registry_consistency()


def test_registry_has_all_93_functions_after_task_26():
    # Task 25 implemented 53 (8 logic + 25 numeric + 16 string + 4 regex)
    # behind an explicit `_PENDING_CATEGORIES` hatch for the other 40.
    # Task 26's own definition of done deletes that hatch and completes
    # the registry -- this replaces Task 25's "53 + pending 40" assertion
    # (which referenced `_PENDING_CATEGORIES`, now gone) with the
    # unconditional total.
    assert len(functions.REGISTRY) == 93
    assert not hasattr(functions, "_PENDING_CATEGORIES")


def test_person_and_page_are_declared_but_unused_this_task():
    # Forward-compatibility check only: these two wrapper types exist for
    # Task 26, not exercised by anything in this task's four categories.
    p = Person(id="u1")
    pg = Page(id="p1")
    assert p.id == "u1"
    assert pg.id == "p1"
