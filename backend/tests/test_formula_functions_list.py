"""Golden-value table for the 18 list-specific formula builtins (research
§H.3.7) plus the 8 shared scalar/list functions' list forms, plus the 3
page/person builtins (research §H.3.8) and their traversal-pattern idioms
-- Milestone 8d (Task 26).

Same SOURCED/OURS tagging convention as Task 25's
`test_formula_functions_core.py`. Specifically covers every trap this
task's brief names: zero-based indexing; `flat()` flattens exactly one
level with no depth argument; nested higher-order calls with `current`
shadowed, proven via the documented `lets`-capture workaround; `sort` on a
mixed-type list compares as strings but preserves element types;
`find` -> `EMPTY` on no match vs. `findIndex` -> `-1` on no match (the
deliberate asymmetry); the corrected "no lambda syntax" reading (`current`/
`index` as bare, implicitly-bound `Variable`s, never an `ast.Lambda`);
relation traversal producing a `list[Page]`/`list[Person]`, and the depth
budget returning `EMPTY`-equivalent (`None` from `with_relation_hop`) at
zero.

Pure Python, no database, no fixtures.
"""
from __future__ import annotations

import pytest

from services.db.formula import parse
from services.db.formula.evaluator import EvalContext, evaluate, make_now
from services.db.formula.values import EMPTY, Page, Person


def _eval(src: str, *, properties=None, page_id=None):
    tree = parse(src)
    ctx = EvalContext(properties=properties or {}, now=make_now(), page_id=page_id)
    return evaluate(tree, ctx)


# ---------------------------------------------------------------------------
# Plain list functions
# ---------------------------------------------------------------------------

PLAIN_LIST_CASES = [
    ("at_zero_based_official", "at([1,2,3], 1)", 2.0),  # SOURCED, official
    ("at_index_zero__ours", "at([1,2,3], 0)", 1.0),
    ("first__ours", "first([1,2,3])", 1.0),
    ("last__ours", "last([1,2,3])", 3.0),
    ("slice_official", "slice([1,2,3], 1, 2)", [2.0]),  # SOURCED, official
    ("slice_no_end__ours", "slice([1,2,3,4], 2)", [3.0, 4.0]),
    ("concat__ours", "concat([1,2],[3,4])", [1.0, 2.0, 3.0, 4.0]),
    ("reverse__ours", "reverse([1,2,3])", [3.0, 2.0, 1.0]),
    ("unique_official", "unique([1,1,2])", [1.0, 2.0]),  # SOURCED, official
    ("includes_true__ours", "includes([1,2,3], 2)", True),
    ("includes_false__ours", "includes([1,2,3], 9)", False),
    ("includes_bool_vs_number_not_equal__ours", "includes([1,2,3], true)", False),
    ("flat_official", "flat([[1,2],[3,4]])", [1.0, 2.0, 3.0, 4.0]),  # SOURCED, official
]  # fmt: skip


@pytest.mark.parametrize(
    "case_id,src,expected", PLAIN_LIST_CASES, ids=[c[0] for c in PLAIN_LIST_CASES]
)
def test_plain_list_function(case_id, src, expected):
    assert _eval(src) == expected


def test_at_out_of_range_is_empty_unresolved_edge():
    # research §1.9's own UNRESOLVED example, explicitly deferred from
    # Task 25 to this task (its report: "Task 26 inherits the identical
    # ruling"): EMPTY, never a raised exception.
    assert _eval("at([1,2,3], 99)") is EMPTY


def test_at_negative_index_is_empty_ours():
    assert _eval("at([1,2,3], -1)") is EMPTY


def test_first_and_last_of_empty_list_are_empty_ours():
    assert _eval("first([])") is EMPTY
    assert _eval("last([])") is EMPTY


def test_flat_flattens_exactly_one_level_not_recursively():
    # brief, explicit trap: "unlike JS", no depth argument, exactly one
    # level -- a doubly-nested list's inner lists stay nested.
    assert _eval("flat([[[1]]])") == [[1.0]]


def test_splice_official_dot_form_example():
    # research §3.7/§2.5, official: [1,2,3,4,5].splice(1,1,"eye-emoji")
    # mirrors JS Array.prototype.toSpliced() -- delete 1 element starting
    # at index 1, insert one value there.
    result = _eval('[1,2,3,4,5].splice(1, 1, "x")')
    assert result == [1.0, "x", 3.0, 4.0, 5.0]


def test_splice_negative_start_counts_from_the_end():
    result = _eval("splice([1,2,3,4,5], -1, 0, 99)")
    assert result == [1.0, 2.0, 3.0, 4.0, 99.0, 5.0]


def test_splice_out_of_range_start_ignores_delete_count_and_only_inserts():
    # research, explicit: startIndex >= length (or < -length) ignores
    # deleteCount and only inserts.
    result = _eval("splice([1,2,3], 99, 5, 100)")
    assert result == [1.0, 2.0, 3.0, 100.0]


# ---------------------------------------------------------------------------
# The 8 shared scalar/list functions -- Task 25 already implemented their
# list-accepting overload in full (see functions/list_fns.py's module
# docstring); these cases are this task's own additional coverage, not
# proof of a fix.
# ---------------------------------------------------------------------------


def test_length_of_a_list_official():
    assert _eval("length([1,2,3])") == 3.0


def test_sum_min_max_median_mean_already_accept_lists():
    assert _eval("sum([1,2,3], 4, 5)") == 15.0  # SOURCED, official
    assert _eval("min([1,2,3])") == 1.0  # SOURCED, official
    assert _eval("max([1,2,3])") == 3.0  # SOURCED, official
    assert _eval("median([1,2,3], 4)") == 2.5  # SOURCED, official
    assert _eval("mean([1,2,3], 4, 5)") == 3.0  # SOURCED, official


def test_join_stringifies_list_elements_official_shape():
    assert _eval('join([1,2,3], ",")') == "1,2,3"


# ---------------------------------------------------------------------------
# Higher-order functions: current/index binding, no lambda syntax
# ---------------------------------------------------------------------------

HIGHER_ORDER_CASES = [
    ("find_match_official", 'find(["a","b","c"], current == "b")', "b"),  # SOURCED
    ("find_index_match_official", 'findIndex(["a","b","c"], current == "b")', 1.0),  # SOURCED
    ("filter_official", "filter([1,2,3], current > 1)", [2.0, 3.0]),  # SOURCED
    ("some_official", "some([1,2,3], current == 2)", True),  # SOURCED
    ("every_official", "every([1,2,3], current > 0)", True),  # SOURCED
    ("map_current_plus_one_official", "map([1,2,3], current + 1)", [2.0, 3.0, 4.0]),  # SOURCED
    ("map_current_plus_index_official", "map([1,2,3], current + index)", [1.0, 3.0, 5.0]),  # SOURCED
    ("map_index_only_official", "map([1,2,3], index)", [0.0, 1.0, 2.0]),  # SOURCED [P2]
]  # fmt: skip


@pytest.mark.parametrize(
    "case_id,src,expected", HIGHER_ORDER_CASES, ids=[c[0] for c in HIGHER_ORDER_CASES]
)
def test_higher_order(case_id, src, expected):
    assert _eval(src) == expected


def test_find_no_match_is_empty_not_negative_one():
    # research §1.4/§3.7, official, the deliberate asymmetry the brief
    # names explicitly.
    assert _eval("find([1,2,3], current > 100)") is EMPTY


def test_find_index_no_match_is_negative_one_not_empty():
    assert _eval("findIndex([1,2,3], current > 100)") == -1.0


def test_index_is_bound_in_filter_not_only_map():
    # Task 24's report, judgment call #7: index is bound in ALL 8
    # higher-order functions, not only map -- proven here for filter.
    assert _eval("filter([10,20,30], index > 0)") == [20.0, 30.0]


def test_index_is_bound_in_sort_and_count_too():
    assert _eval('count([10,20,30], index >= 1)') == 2.0
    assert _eval("sort([3,1,2], index)") == [3.0, 1.0, 2.0]  # sorted by ORIGINAL position -> identity


def test_count_without_expr_is_plain_length():
    assert _eval("count([1,2,3])") == 3.0


def test_count_with_expr_counts_matches():
    assert _eval("count([1,2,3], current > 1)") == 2.0


def test_nested_higher_order_inner_current_shadows_outer():
    # research §2.12, official: "Nesting shadows" -- a naive nested
    # map(map(...)) loses access to the OUTER current inside the inner
    # expression, since current is a single implicit name rebound at each
    # nesting level (not a stack). Proven directly: the inner map's
    # `current` is NOT the outer element.
    result = _eval("map([1,2], map([10,20], current))")
    # Both outer iterations see the SAME inner result ([10,20]), because
    # the inner expression ("current") only ever refers to the INNER
    # binding -- if shadowing were broken (e.g. inner reads leaked to the
    # outer value), the two outer iterations would differ.
    assert result == [[10.0, 20.0], [10.0, 20.0]]


def test_lets_captures_outer_current_before_inner_shadow_official_workaround():
    # research §2.12/§2.4, official workaround for the shadowing above:
    # capture the outer `current` with `lets` before an inner higher-order
    # call rebinds it. Each outer element correctly influences its own
    # inner result once captured this way.
    result = _eval("map([1,2], lets(outer, current, map([10,20], current + outer)))")
    assert result == [[11.0, 21.0], [12.0, 22.0]]


def test_no_lambda_syntax_current_and_index_are_ordinary_variables():
    # Corrects a real error in this task's own brief (and Task 26's own
    # brief), found by Task 23's implementer and reconfirmed here:
    # research §2.12's first sentence is "There is no lambda syntax."
    # `current`/`index` parse as ordinary ast.Variable nodes (Task 23) and
    # are bound by evaluator.py via EvalContext.with_binding, exactly like
    # a `let` binding -- never an ast.Lambda, which the parser never
    # constructs at all (Task 23's report). This test's only assertion is
    # behavioural (map still works), because there is no syntax that could
    # even construct an ast.Lambda to test against directly.
    from services.db.formula import ast as A

    tree = parse("map([1,2,3], current + index)")
    assert not any(isinstance(n, A.Lambda) for n in A.walk(tree))
    assert _eval("map([1,2,3], current + index)") == [1.0, 3.0, 5.0]


# ---------------------------------------------------------------------------
# sort -- default ordering per type, mixed-type "compared as strings", and
# the 2-arg key-extractor form
# ---------------------------------------------------------------------------


def test_sort_numbers_ascending():
    assert _eval("sort([3, 1, 2])") == [1.0, 2.0, 3.0]


def test_sort_strings_a_to_z():
    assert _eval('sort(["banana", "apple", "cherry"])') == ["apple", "banana", "cherry"]


def test_sort_booleans_false_before_true():
    assert _eval("sort([true, false, true, false])") == [False, False, True, True]


def test_sort_mixed_type_list_compares_as_strings_but_keeps_element_types():
    # research §1.8/§3.7, official: "sorting a mixed-type list treats
    # everything as a string; element types are preserved in the output."
    result = _eval('sort([3, "a", 1, true])')
    assert result == [1.0, 3.0, "a", True]
    # Types preserved: the first two are still real Numbers, not strings.
    assert isinstance(result[0], float) and isinstance(result[1], float)
    assert isinstance(result[2], str)
    assert isinstance(result[3], bool)


def test_sort_with_expr_uses_it_as_a_per_element_key():
    # brief-uncovered decision (this task's report): the 2-arg form's expr
    # is a per-element KEY extractor (current bound per element, like
    # map), not a JS-style 2-argument comparator -- there is no way to
    # bind two elements at once in this language. Sorting by "current % 3"
    # groups values whose remainder mod 3 matches.
    result = _eval("sort([5, 1, 9, 2], mod(current, 3))")
    # keys: 5->2, 1->1, 9->0, 2->2 => ascending key order: 9(0), 1(1), 5(2), 2(2)
    assert result == [9.0, 1.0, 5.0, 2.0]


# ---------------------------------------------------------------------------
# Page / Person (id, name, email) and the documented traversal patterns
# ---------------------------------------------------------------------------


def test_id_on_a_page_strips_dashes_p2():
    page = Page(id="c5d67d15-8547-4486-9cc4-a062fb7b1377")
    assert _eval('id(prop("P"))', properties={"P": page}) == "c5d67d15854744869cc4a062fb7b1377"


def test_id_on_a_person():
    person = Person(id="abcd-1234")
    assert _eval('id(prop("P"))', properties={"P": person}) == "abcd1234"


def test_id_dot_form_matches_function_form():
    page = Page(id="abc-def")
    props = {"P": page}
    assert _eval('prop("P").id()', properties=props) == _eval('id(prop("P"))', properties=props)


def test_name_on_person_official():
    person = Person(id="1", name="Grace Hopper")
    assert _eval('name(prop("P"))', properties={"P": person}) == "Grace Hopper"


def test_name_on_a_page_is_empty_no_name_function_on_page():
    # research §1.6, official, explicit: "There is no .name() on a Page."
    page = Page(id="1")
    assert _eval('name(prop("P"))', properties={"P": page}) is EMPTY


def test_email_on_person_official():
    person = Person(id="1", email="grace@example.com")
    assert _eval('email(prop("P"))', properties={"P": person}) == "grace@example.com"


def test_name_with_no_cached_name_is_empty_not_a_crash():
    person = Person(id="1")  # name defaults to None
    assert _eval('name(prop("P"))', properties={"P": person}) is EMPTY


# -- documented traversal patterns (research §3.8) -- idioms, not builtins


def test_pattern_relation_length_official():
    rel = [Page(id="1"), Page(id="2"), Page(id="3")]
    assert _eval('prop("Relation").length()', properties={"Relation": rel}) == 3.0


def test_pattern_map_names_then_join_official():
    # research §3.8, official, verbatim: prop("Pioneers").map(name(current))
    # .join(", ") = "Grace Hopper, Ada Lovelace"
    pioneers = [Person(id="1", name="Grace Hopper"), Person(id="2", name="Ada Lovelace")]
    result = _eval(
        'prop("Pioneers").map(name(current)).join(", ")', properties={"Pioneers": pioneers}
    )
    assert result == "Grace Hopper, Ada Lovelace"


def test_pattern_map_emails_of_person_list_official():
    assignees = [Person(id="1", email="a@x.com"), Person(id="2", email="b@x.com")]
    result = _eval("prop(\"Assignees\").map(current.email())", properties={"Assignees": assignees})
    assert result == ["a@x.com", "b@x.com"]


def test_pattern_filter_related_pages_by_status_official_shape():
    # research §3.8/§1.6, official shape:
    # prop("Tasks").filter(current.prop("Status") !== "Done") -- exercised
    # here with THIS row's own "Status" property (Task 24/25's own
    # documented .prop() resolution limitation: a dot-prop call always
    # resolves against the CURRENT row, never the receiver's row -- see
    # evaluator._eval_prop's docstring), so this proves the idiom
    # COMPOSES rather than proving cross-row property resolution (which
    # this evaluator does not implement, by inherited design).
    tasks = [Page(id="1"), Page(id="2")]
    result = _eval(
        'prop("Tasks").filter(current.prop("Status") != "Done")',
        properties={"Tasks": tasks, "Status": "Not Started"},
    )
    assert result == tasks  # this row's Status != "Done" for every element


def test_pattern_map_ids_of_related_pages_p2():
    rel = [Page(id="aaa-1"), Page(id="bbb-2")]
    result = _eval('prop("Relation").map(current.id())', properties={"Relation": rel})
    assert result == ["aaa1", "bbb2"]


def test_pattern_unique_id_prefix_split_first_official():
    # research §3.8, official: prop("Task ID").split("-").first()
    result = _eval('prop("TaskID").split("-").first()', properties={"TaskID": "ENG-142"})
    assert result == "ENG"


# ---------------------------------------------------------------------------
# Relation traversal depth budget (spec §7.3, capped at 3) -- Task 27's
# enforcement job, this task's typed contract only.
# ---------------------------------------------------------------------------


def test_depth_budget_decrements_on_each_relation_hop():
    ctx = EvalContext(properties={}, now=make_now(), depth_budget=3)
    hop1 = ctx.with_relation_hop()
    hop2 = hop1.with_relation_hop()
    assert hop1.depth_budget == 2
    assert hop2.depth_budget == 1


def test_depth_budget_returns_none_and_sets_exceeded_flag_at_zero():
    ctx = EvalContext(properties={}, now=make_now(), depth_budget=1)
    hop1 = ctx.with_relation_hop()
    assert hop1.depth_budget == 0
    assert hop1.depth_exceeded is False

    hop2 = hop1.with_relation_hop()
    assert hop2 is None
    assert hop1.depth_exceeded is True  # the flag box is shared across derived contexts


def test_depth_exceeded_flag_is_shared_with_the_root_context():
    # The whole point of the shared mutable box: the flag set deep in a
    # chain of hops must be visible from the ORIGINAL context object a
    # caller (Task 27) is still holding, not just from the innermost one.
    root = EvalContext(properties={}, now=make_now(), depth_budget=1)
    hop1 = root.with_relation_hop()
    assert root.depth_exceeded is False
    hop1.with_relation_hop()  # trips the flag
    assert root.depth_exceeded is True


def test_with_relation_hop_never_raises():
    ctx = EvalContext(properties={}, now=make_now(), depth_budget=0)
    assert ctx.with_relation_hop() is None


# ---------------------------------------------------------------------------
# Registry completeness -- this task's own definition of done
# (`_PENDING_CATEGORIES` deleted, the consistency assertion now
# unconditional). `test_formula_eval.py::test_registry_has_all_93_
# functions_after_task_26` already pins the headline count; these cases
# add the arithmetic trail and the "unreachable stub actually raises"
# invariant this task's report also promises.
# ---------------------------------------------------------------------------


def test_93_reconciles_against_researchs_own_per_section_headers():
    # research §3.1-3.8 header counts: 8 (logic) + 25 (numeric) +
    # 16 (string) + 4 (regex) + 19 (date/time) + 18 (list) + 3
    # (page/person) = 93 -- the same reconciliation Task 24's report
    # already did once; re-verified here against the LIVE registry rather
    # than just the arithmetic, now that every category is implemented.
    from services.db.formula import functions

    assert 8 + 25 + 16 + 4 + 19 + 18 + 3 == 93
    assert len(functions.REGISTRY) == 93
    assert not hasattr(functions, "_PENDING_CATEGORIES")


def test_unreachable_higher_order_stubs_raise_if_ever_actually_invoked():
    # Documents the invariant `functions.unreachable_via_evaluator`'s
    # docstring claims: these 8 REGISTRY entries exist only to satisfy
    # check_registry_consistency() and are never reached through
    # evaluate() (evaluator.py intercepts all 8 names first) -- but if
    # something ever DID call them directly, they must fail loudly, not
    # silently return a wrong value.
    from services.db.formula import functions

    for name in ("map", "filter", "find", "findIndex", "some", "every", "sort", "count"):
        with pytest.raises(RuntimeError, match=name):
            functions.REGISTRY[name]([])


def test_unreachable_now_today_stubs_raise_if_ever_actually_invoked():
    from services.db.formula import functions

    for name in ("now", "today"):
        with pytest.raises(RuntimeError, match=name):
            functions.REGISTRY[name]([])
