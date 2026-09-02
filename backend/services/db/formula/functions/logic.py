"""§H.3.1 Conditional / logic (8): `if`, `ifs`, `and`, `or`, `not`, `equal`,
`unequal`, `empty`.

Every function here receives an already-evaluated `list[FValue]` -- the
evaluator (`evaluator.py`) is what walks the AST; these are pure
value -> value functions, exactly the split spec §7.2 wants ("one tree,
three visitors" -- the evaluator is the visitor, this module is leaf
logic it calls into).

EMPTY-propagation note: `evaluator.py`'s `_invoke` is the ONE place the
general "an operation on EMPTY yields EMPTY" rule (brief §2) is enforced,
for every builtin except the five listed in its `_EMPTY_AWARE` set --
`empty`, `if`, `ifs`, `equal`, `unequal` are exactly those five, and this
is the module that implements all five. Every function below that is NOT
one of those five (there are none in this module -- all 8 logic functions
are either EMPTY-aware themselves or, for `and`/`or`/`not`, fine with the
generic propagation) can otherwise assume its arguments are never `EMPTY`.
"""
from __future__ import annotations

from ..values import EMPTY, Date, FValue, Page, Person, is_empty, truthy
from . import builtin


@builtin("if")
def _if(args: list[FValue]) -> FValue:
    """`if(Boolean, Any, Any)`. In normal parsing this is unreachable --
    Task 23's parser normalises every exactly-3-arg `if(...)` (and every
    ternary) to `ast.Conditional`, which `evaluator.py` evaluates directly
    (and lazily -- only the chosen branch is evaluated, see
    `evaluator._eval_conditional`). This registry entry exists for the one
    case `ast.Call("if", args)` can still reach the evaluator: a
    non-3-arg `if(...)` call, which the type checker already rejects
    (`_check_if_call`) but which could still reach evaluation for an
    unchecked or saved-with-errors formula (research §1.9: "a formula with
    errors can still be saved"). Malformed arity -> EMPTY, matching this
    task's brief-wide ruling for undocumented/malformed runtime input
    rather than raising."""
    if len(args) != 3:
        return EMPTY
    cond, then_, else_ = args
    return then_ if truthy(cond) else else_


@builtin("ifs")
def _ifs(args: list[FValue]) -> FValue:
    """`ifs(Boolean, Any, ...pairs, Any)` -- research §2.3: "returns the
    value that corresponds to the first true condition." Unlike `if`, this
    one really is reached through ordinary `Call` evaluation every time
    (Task 23 deliberately never normalises `ifs` to `ast.Conditional` --
    variable arity has no fixed 3-slot shape to normalise into). Requires
    an odd argument count (N condition/value pairs plus a trailing
    default); malformed arity -> EMPTY, same ruling as `if` above."""
    n = len(args)
    if n < 1 or n % 2 == 0:
        return EMPTY
    for i in range(0, n - 1, 2):
        if truthy(args[i]):
            return args[i + 1]
    return args[-1]


@builtin("and")
def _and(args: list[FValue]) -> FValue:
    """`and(Boolean, Boolean)` / `a and b` / `a && b`. Both operand forms
    (word/symbol operator and function-call syntax) route through this one
    implementation -- `evaluator._eval_binary`'s `"and"` case calls this
    same registry entry, so there is exactly one place `and`'s semantics
    live, regardless of which of the three documented spellings a formula
    uses (research §2.1/§3.1)."""
    a, b = args
    return truthy(a) and truthy(b)


@builtin("or")
def _or(args: list[FValue]) -> FValue:
    a, b = args
    return truthy(a) or truthy(b)


@builtin("not")
def _not(args: list[FValue]) -> FValue:
    (a,) = args
    return not truthy(a)


def _strict_eq(a: FValue, b: FValue) -> bool:
    """Strict, JS-`===`-style equality (research §1.8): cross-type
    comparison is always legal and always `false`, never an error; string
    comparison is case-sensitive. `bool` is checked before the numeric
    (`float`) branch -- the same trap `values.is_empty`/`as_number`
    document: Python's `True == 1.0` is `True`, which would silently make
    `true == 1` pass here if a bare `a == b` were tried across the
    bool/float boundary. `EMPTY` only equals `EMPTY` itself -- there being
    exactly one "no value" in this language, unlike SQL NULL, makes this
    the one sane reading (this is also what lets `x == empty()` work at
    all as a spelling of "is x empty").

    Recurses into `List` elements (not one of research's own worked
    examples -- our own extension, since `equal(Any, Any)`'s signature
    doesn't exempt lists, and comparing two multi-element lists
    element-by-element with the same strict rules is the only reading that
    doesn't invent a *different*, undocumented equality for lists)."""
    if a is EMPTY or b is EMPTY:
        return a is EMPTY and b is EMPTY
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, float) and isinstance(b, float):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if isinstance(a, Date) and isinstance(b, Date):
        # `Date` (Task 26) is a frozen dataclass (`start`, `end`) --
        # dataclass `==` is already field-wise, so this compares both
        # components in one expression; a ranged Date only equals another
        # ranged Date with the identical start AND end.
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_strict_eq(x, y) for x, y in zip(a, b))
    if isinstance(a, (Person, Page)) and isinstance(b, (Person, Page)):
        return type(a) is type(b) and a.id == b.id
    return False


@builtin("equal")
def _equal(args: list[FValue]) -> FValue:
    a, b = args
    return _strict_eq(a, b)


@builtin("unequal")
def _unequal(args: list[FValue]) -> FValue:
    a, b = args
    return not _strict_eq(a, b)


@builtin("empty")
def _empty(args: list[FValue]) -> FValue:
    """Two meanings by arity (research §1.4, official, this task's brief
    §2 names it explicitly): zero args -> the `EMPTY` sentinel itself (the
    null literal); one arg -> the `0`/`""`/`[]`/EMPTY predicate
    (`values.is_empty`, which already documents the bool-before-float
    dispatch trap this exact function is the textbook example of)."""
    if len(args) == 0:
        return EMPTY
    if len(args) == 1:
        return is_empty(args[0])
    return EMPTY  # malformed arity; see `_if`'s docstring for the ruling
