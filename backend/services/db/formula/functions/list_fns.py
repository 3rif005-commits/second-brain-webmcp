"""§H.3.7 List (18 list-specific, plus the 8 shared functions research
also counts toward this category's total).

This module implements the **10 "plain" list functions** -- `at`, `first`,
`last`, `slice`, `concat`, `reverse`, `unique`, `includes`, `flat`,
`splice` -- every one whose signature has no `current`/`index`-scoped
expression argument, so each is a normal `list[FValue] -> FValue`
`REGISTRY` entry like every other builtin in this package.

**Not here:** `map`/`filter`/`find`/`findIndex`/`some`/`every`/`sort`/
`count` (8) -- research §2.12's higher-order list functions. Each of these
needs the UNEVALUATED `current`/`index`-scoped expression AST node plus an
`EvalContext` to rebind `current`/`index` fresh per element, neither of
which a plain `list[FValue] -> FValue` function can access -- see
`functions.unreachable_via_evaluator`'s docstring and
`evaluator._eval_higher_order_call` (the real implementation) for the full
reasoning. This module registers all 8 as unreachable stubs purely so
`check_registry_consistency()`'s now-unconditional assertion has an entry
for every one of Task 24's 93 names.

**Also not here:** `length`/`join`/`split`/`sum`/`min`/`max`/`median`/
`mean`, the 8 functions research's own §3.7 counts toward "List" (their
list-accepting overload) alongside its 18-name headline. This task's brief
instructed extending them to accept lists "if [Task 25's registry] does
not permit overloading cleanly" -- checked directly against the
already-committed code: `functions/numeric.py`'s `_flatten_numbers`
already flattens any mix of bare numbers and `List<Number>` arguments for
`sum`/`min`/`max`/`median`/`mean`, and `functions/string.py`'s `_length`
already branches on `isinstance(v, list)`, and `_join`'s ONLY documented
shape (`join(List, Text)`) already required a list. Task 25's own golden
table (`test_formula_functions_core.py`) already exercises the list form
of every one of the 8 (`min([1,2,3])`, `sum([1,2,3], 4, 5)`,
`length([1,2,3])`, `join([1,2,3], ",")`, ...). **No implementation or
registry change was needed** -- flagged in this task's report as a finding
rather than silently re-implemented; this task's own golden table adds a
few more list-form cases for the remaining three (`median`/`mean`/
`split`-into-a-list-then-`length`) purely for this task's own coverage,
not because anything was missing.
"""
from __future__ import annotations

from ..values import EMPTY, FValue, as_number
from . import builtin, unreachable_via_evaluator
from .logic import _strict_eq

# ---------------------------------------------------------------------------
# Shared clamp helper
# ---------------------------------------------------------------------------


def _clamp_index(idx: float, n: int) -> int:
    """The same out-of-range convention `functions/string.py`'s
    identically-named helper uses for `substring` (clamp, never
    wrap/error) -- duplicated rather than imported, same reasoning as that
    module's own duplicated `_round_half_up`: keeping each category's only
    cross-module dependency `..values` avoids a real coupling between two
    otherwise-independent categories for one three-line helper. (`unique`/
    `includes` below break that discipline on purpose, importing
    `functions.logic._strict_eq` -- see `_unique`'s docstring for why that
    ONE coupling is warranted where this one isn't.)"""
    i = int(idx)
    if i < 0:
        return 0
    if i > n:
        return n
    return i


# ---------------------------------------------------------------------------
# The 10 plain list functions
# ---------------------------------------------------------------------------


@builtin("at")
def _at(args: list[FValue]) -> FValue:
    """`at(List, Number)` -- zero-based (research §1.5, official:
    `at([1,2,3],1)==2`). Out of range -- including negative, which is
    undocumented either way for `at` specifically (unlike `splice`, which
    DOES document negative-from-the-end indexing) -- is `at(list, 99)`'s
    exact UNRESOLVED shape from research §1.9, explicitly deferred to this
    task by Task 25's report ("Task 26 inherits the identical ruling
    rather than re-deriving it"): EMPTY, the same ruling as every other
    UNRESOLVED runtime edge in this package."""
    lst, idx = args[0], as_number(args[1])
    if not isinstance(lst, list) or idx is None:
        return EMPTY
    i = int(idx)
    if i < 0 or i >= len(lst):
        return EMPTY
    return lst[i]


@builtin("first")
def _first(args: list[FValue]) -> FValue:
    (lst,) = args
    if not isinstance(lst, list) or not lst:
        return EMPTY
    return lst[0]


@builtin("last")
def _last(args: list[FValue]) -> FValue:
    (lst,) = args
    if not isinstance(lst, list) or not lst:
        return EMPTY
    return lst[-1]


@builtin("slice")
def _slice(args: list[FValue]) -> FValue:
    """`slice(List, Number, Number?)` -- start inclusive, end optional and
    exclusive (research §3.7, official: `slice([1,2,3],1,2)=[2]`).
    Out-of-range indices clamp, mirroring `substring`'s identical
    ruling (`functions/string.py`) for the identical reason -- research
    gives no worked example for this edge for EITHER function."""
    lst = args[0]
    start_n = as_number(args[1])
    if not isinstance(lst, list) or start_n is None:
        return EMPTY
    n = len(lst)
    start_i = _clamp_index(start_n, n)
    if len(args) > 2:
        end_n = as_number(args[2])
        if end_n is None:
            return EMPTY
        end_i = _clamp_index(end_n, n)
    else:
        end_i = n
    if end_i < start_i:
        return []
    return lst[start_i:end_i]


@builtin("concat")
def _concat(args: list[FValue]) -> FValue:
    """`concat(...List) -> List` (research §3.7, official). A non-List
    variadic argument has no documented reading -- EMPTY for the whole
    call, rather than silently treating a scalar as a one-element list
    (undocumented either way; the conservative reading, flagged in this
    task's report)."""
    out: list[FValue] = []
    for a in args:
        if not isinstance(a, list):
            return EMPTY
        out.extend(a)
    return out


@builtin("reverse")
def _reverse(args: list[FValue]) -> FValue:
    (lst,) = args
    if not isinstance(lst, list):
        return EMPTY
    return list(reversed(lst))


@builtin("unique")
def _unique(args: list[FValue]) -> FValue:
    """`unique([1,1,2]) == [1,2]` (research §3.7, official), preserving
    first-occurrence order (undocumented explicitly, but the only reading
    consistent with `[1,1,2]` producing `[1,2]` rather than some other
    order). Equality is the formula language's OWN strict equality
    (`functions.logic._strict_eq`) -- reused directly, not duplicated, so
    `unique` can never disagree with `equal()`/`==` about whether two
    values are "the same" (`true` and `1` are NOT the same element for
    `unique`'s purposes, matching `equal(true, 1) == false` -- the exact
    bool-vs-number trap this package documents repeatedly). O(n^2)
    (linear scan per element) rather than a `set()`-backed dedup, because
    most `FValue`s (`list`, and this task's own `Date`/`Person`/`Page`)
    are not hashable, and research documents no list size large enough to
    make O(n^2) a real concern for this evaluator."""
    (lst,) = args
    if not isinstance(lst, list):
        return EMPTY
    out: list[FValue] = []
    for v in lst:
        if not any(_strict_eq(v, seen) for seen in out):
            out.append(v)
    return out


@builtin("includes")
def _includes(args: list[FValue]) -> FValue:
    """`includes(List, Any) -> Boolean` (research §3.7, official). Same
    strict-equality reuse as `unique` above, for the identical reason."""
    lst, needle = args[0], args[1]
    if not isinstance(lst, list):
        return EMPTY
    return any(_strict_eq(needle, v) for v in lst)


@builtin("flat")
def _flat(args: list[FValue]) -> FValue:
    """Flattens EXACTLY one level, no depth argument (research §1.5,
    official, explicitly "unlike JS") -- `flat([[1,2],[3,4]]) ==
    [1,2,3,4]`; a doubly-nested list's inner lists stay nested
    (`flat([[[1]]]) == [[1]]`, NOT `[1]`) -- this task's brief calls this
    trap out by name."""
    (lst,) = args
    if not isinstance(lst, list):
        return EMPTY
    out: list[FValue] = []
    for v in lst:
        if isinstance(v, list):
            out.extend(v)
        else:
            out.append(v)
    return out


@builtin("splice")
def _splice(args: list[FValue]) -> FValue:
    """`splice(List, Number, Number?, ...Any) -> List` -- **P2**,
    "mirrors JS `Array.prototype.toSpliced()`" (research §3.7,
    non-mutating remove-and/or-insert). `typecheck.FUNCTION_SIGNATURES`'s
    own signature (`optional=(_N,)` BEFORE the variadic `Any` slot) fixes
    the argument's POSITION, not just its presence -- so a 3rd argument,
    when present at all, is always `deleteCount` (a Number), never the
    first inserted item, matching real JS `splice`/`toSpliced` (there is
    no way to "skip deleteCount but still pass items" there either).

    Negative `startIndex` counts from the end (research, explicit: "-1 is
    the last element, there is no -0" -- `int(-0.0) == 0` in Python, which
    already reads as plain index 0, not "from the end," so no special
    case is needed for that literal edge). If `startIndex >= length` or
    `startIndex < -length`, `deleteCount` is ignored and the call only
    inserts (research, explicit) -- at the clamped end nearest the
    out-of-range index (undocumented for this EXACT sub-case; the
    symmetric clamp-direction reading, flagged in this task's report)."""
    lst = args[0]
    start_n = as_number(args[1])
    if not isinstance(lst, list) or start_n is None:
        return EMPTY
    n = len(lst)
    start = int(start_n)
    insert_items = list(args[3:])
    if start >= n or start < -n:
        insert_at = n if start >= n else 0
        return lst[:insert_at] + insert_items + lst[insert_at:]
    if start < 0:
        start += n
    delete_count = 0
    if len(args) > 2:
        dc = as_number(args[2])
        if dc is None:
            return EMPTY
        delete_count = max(0, int(dc))
    end = min(n, start + delete_count)
    return lst[:start] + insert_items + lst[end:]


# `map`/`filter`/`find`/`findIndex`/`some`/`every`/`sort`/`count` -- see
# this module's own docstring and `unreachable_via_evaluator`'s.
for _name in ("map", "filter", "find", "findIndex", "some", "every", "sort", "count"):
    builtin(_name)(unreachable_via_evaluator(_name))
