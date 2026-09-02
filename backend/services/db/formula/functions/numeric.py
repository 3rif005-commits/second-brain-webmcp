"""§H.3.2 Numeric / math (25).

All 25 functions here are, structurally, plain math -- `evaluator.py`'s
`_invoke` already filters out any `EMPTY` argument before a call reaches
this module (none of these 25 names appear in `_EMPTY_AWARE`), so nothing
below needs to special-case `EMPTY` itself. What every function DOES have
to handle, per this task's brief and research §1.9's own `UNRESOLVED:`
list, is the set of runtime edges research explicitly declines to guess at
-- `divide(1,0)`, `sqrt(-1)`, `ln(0)`, and their siblings. Ruling (brief
§2, restated once here so each site below only needs a one-line pointer
back to this paragraph): every such edge returns `EMPTY`, never raises,
never produces `NaN`/`Infinity` -- research §1.9 establishes this language
has no first-class error values flowing through expressions, `EMPTY` is
its one documented "no value," and `NaN`/`Infinity` are not valid JSON
(would break `computed` JSONB serialisation at the materialisation
boundary, Task 27).
"""
from __future__ import annotations

import math

from ..values import EMPTY, Date, FValue, as_number
from . import builtin


def _num(v: FValue) -> float | None:
    return as_number(v)


def _flatten_numbers(args: list[FValue]) -> list[float] | None:
    """`min`/`max`/`sum`/`median`/`mean` all accept `...Number | List
    <Number>` (research §3.2): any mix of bare numbers and number-lists,
    flattened one level (`sum([1,2,3], 4, 5) = 15`, the official example).
    Returns `None` if any element -- top-level or inside a list -- is not a
    real number (including `EMPTY` elements inside a list; a bare `EMPTY`
    top-level argument never reaches here at all, filtered by
    `evaluator._invoke` before the call). `None` signals "the whole call
    is malformed," distinct from `[]` ("a well-formed call with zero
    numbers," e.g. `sum()` or `sum([])`) -- callers below tell the two
    apart (see `_sum` vs `_min`'s different empty-input rulings, both
    undocumented and both flagged in this task's report)."""
    out: list[float] = []
    for a in args:
        if isinstance(a, list):
            for item in a:
                n = _num(item)
                if n is None:
                    return None
                out.append(n)
        else:
            n = _num(a)
            if n is None:
                return None
            out.append(n)
    return out


@builtin("add")
def _add(args: list[FValue]) -> FValue:
    a, b = _num(args[0]), _num(args[1])
    if a is None or b is None:
        return EMPTY
    return a + b


@builtin("subtract")
def _subtract(args: list[FValue]) -> FValue:
    a, b = _num(args[0]), _num(args[1])
    if a is None or b is None:
        return EMPTY
    return a - b


@builtin("multiply")
def _multiply(args: list[FValue]) -> FValue:
    a, b = _num(args[0]), _num(args[1])
    if a is None or b is None:
        return EMPTY
    return a * b


@builtin("divide")
def _divide(args: list[FValue]) -> FValue:
    """`divide(1, 0)` is research §1.9's own headline UNRESOLVED example.
    Decided (module docstring): EMPTY, not `Infinity`/`NaN`/a raised
    exception."""
    a, b = _num(args[0]), _num(args[1])
    if a is None or b is None:
        return EMPTY
    try:
        return a / b
    except ZeroDivisionError:
        return EMPTY


@builtin("mod")
def _mod(args: list[FValue]) -> FValue:
    """`mod(Number, Number)` / `a % b`. Uses `math.fmod` (sign follows the
    DIVIDEND, e.g. `mod(-1, 3) == -1`), not Python's `%` operator (sign
    follows the DIVISOR, `-1 % 3 == 2`) -- a real, undocumented judgment
    call flagged in this task's report: research states the numeric model
    is "IEEE-754/JS-like" (§1.1), and JS's `%` is fmod-flavoured, so this
    picks the reading consistent with that statement over Python's own
    default `%` semantics. `mod(x, 0)` is the same documented-UNRESOLVED
    shape as `divide(x, 0)` -- EMPTY, not an exception."""
    a, b = _num(args[0]), _num(args[1])
    if a is None or b is None:
        return EMPTY
    try:
        return math.fmod(a, b)
    except ValueError:
        return EMPTY


@builtin("pow")
def _pow(args: list[FValue]) -> FValue:
    """`pow(Number, Number)` / `a ^ b`. A negative base with a
    non-integer exponent (`(-1) ** 0.5`) is real math (a complex result),
    but this language has no complex-number type -- Python's `**` returns
    a `complex` silently rather than raising, so this is the one numeric
    builtin that has to explicitly detect and reject that case (every
    other UNRESOLVED edge here raises a Python exception this function can
    `except`; this one does not)."""
    a, b = _num(args[0]), _num(args[1])
    if a is None or b is None:
        return EMPTY
    try:
        result = a**b
    except (ValueError, OverflowError, ZeroDivisionError):
        return EMPTY
    if isinstance(result, complex):
        return EMPTY
    return result


@builtin("abs")
def _abs(args: list[FValue]) -> FValue:
    a = _num(args[0])
    return EMPTY if a is None else abs(a)


def _round_half_up(x: float) -> float:
    """JS `Math.round` semantics: ties round towards +Infinity, e.g.
    `round(-0.5) == 0` (not `-1`), `round(2.5) == 3` (not `2`). Flagged
    per this task's brief: Python's builtin `round()` uses banker's
    rounding (round-half-to-even -- `round(0.5) == 0`, `round(2.5) == 2`
    in Python), which disagrees with JS on every `.5` tie. Decided: match
    JS, since research §1.1 states the whole numeric model is
    "IEEE-754/JS-like" and `round`'s own worked examples elsewhere in
    research (`round(1234, -2) = 1200`) come from the JS-flavoured
    reference. `floor(x + 0.5)` is the standard round-half-up
    implementation and matches JS `Math.round` for negative inputs too
    (`Math.round(-1.5) === -1`, not `-2`)."""
    return math.floor(x + 0.5)


@builtin("round")
def _round(args: list[FValue]) -> FValue:
    """`round(Number, Number?)`. Optional 2nd arg = decimal places;
    **negative places work** (research, official: `round(1234, -2) =
    1200`)."""
    a = _num(args[0])
    if a is None:
        return EMPTY
    places = 0.0
    if len(args) > 1:
        p = _num(args[1])
        if p is None:
            return EMPTY
        places = p
    try:
        scale = 10.0 ** places
        return _round_half_up(a * scale) / scale
    except (OverflowError, ValueError):
        return EMPTY


@builtin("ceil")
def _ceil(args: list[FValue]) -> FValue:
    """Standard mathematical ceiling -- `ceil(-0.6) = 0` (official
    example). Unlike `round`, `ceil`/`floor` have only one sane reading
    (smallest integer >= x / largest integer <= x) and Python's
    `math.ceil` already matches it exactly; no JS-vs-Python divergence to
    pick between here (flagged in this task's report only so a reviewer
    does not go looking for one after reading `round`'s docstring above)."""
    a = _num(args[0])
    return EMPTY if a is None else float(math.ceil(a))


@builtin("floor")
def _floor(args: list[FValue]) -> FValue:
    a = _num(args[0])
    return EMPTY if a is None else float(math.floor(a))


@builtin("sqrt")
def _sqrt(args: list[FValue]) -> FValue:
    """`sqrt(-1)` -- research §1.9's own second UNRESOLVED example.
    Decided: EMPTY (module docstring)."""
    a = _num(args[0])
    if a is None:
        return EMPTY
    try:
        return math.sqrt(a)
    except ValueError:
        return EMPTY


@builtin("cbrt")
def _cbrt(args: list[FValue]) -> FValue:
    """Cube root, defined for negative inputs too (`cbrt(-8) == -2`) --
    unlike `sqrt`, a real cube root always exists. Python's `x ** (1/3)`
    does NOT give the real root for negative `x` (returns a complex
    number, same trap as `pow` above), so this needs the sign-preserving
    formula instead of a bare `**`."""
    a = _num(args[0])
    if a is None:
        return EMPTY
    return math.copysign(abs(a) ** (1.0 / 3.0), a)


@builtin("exp")
def _exp(args: list[FValue]) -> FValue:
    a = _num(args[0])
    if a is None:
        return EMPTY
    try:
        return math.exp(a)
    except OverflowError:
        return EMPTY


@builtin("ln")
def _ln(args: list[FValue]) -> FValue:
    """`ln(0)` -- research §1.9's own third UNRESOLVED example (along with
    `ln` of a negative number, undocumented but the same domain-error
    shape). Decided: EMPTY."""
    a = _num(args[0])
    if a is None:
        return EMPTY
    try:
        return math.log(a)
    except ValueError:
        return EMPTY


@builtin("log10")
def _log10(args: list[FValue]) -> FValue:
    a = _num(args[0])
    if a is None:
        return EMPTY
    try:
        return math.log10(a)
    except ValueError:
        return EMPTY


@builtin("log2")
def _log2(args: list[FValue]) -> FValue:
    a = _num(args[0])
    if a is None:
        return EMPTY
    try:
        return math.log2(a)
    except ValueError:
        return EMPTY


@builtin("sign")
def _sign(args: list[FValue]) -> FValue:
    a = _num(args[0])
    if a is None:
        return EMPTY
    if a > 0:
        return 1.0
    if a < 0:
        return -1.0
    return 0.0


@builtin("min")
def _min(args: list[FValue]) -> FValue:
    """No numbers at all (`min()`, or every argument malformed) has no
    minimum to report -- EMPTY, unlike `sum` below where "zero numbers"
    has an unambiguous identity value. Neither the zero-argument case nor
    the malformed-element case is a research-documented example; this is
    our own edge-case ruling, flagged in this task's report (research only
    gives multi-number worked examples)."""
    nums = _flatten_numbers(args)
    if not nums:
        return EMPTY
    return min(nums)


@builtin("max")
def _max(args: list[FValue]) -> FValue:
    nums = _flatten_numbers(args)
    if not nums:
        return EMPTY
    return max(nums)


@builtin("sum")
def _sum(args: list[FValue]) -> FValue:
    """`sum()` / `sum([])` with zero numbers -> `0.0`, the mathematical
    identity for addition -- distinct from `min`/`max`'s EMPTY ruling
    above (there is no identity element for "smallest of nothing"). A
    malformed element (non-number found while flattening) is still EMPTY
    either way. Our own ruling for an undocumented edge, flagged in this
    task's report."""
    nums = _flatten_numbers(args)
    if nums is None:
        return EMPTY
    return float(sum(nums))


@builtin("median")
def _median(args: list[FValue]) -> FValue:
    nums = _flatten_numbers(args)
    if not nums:
        return EMPTY
    s = sorted(nums)
    n = len(s)
    mid = n // 2
    if n % 2 == 1:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0


@builtin("mean")
def _mean(args: list[FValue]) -> FValue:
    nums = _flatten_numbers(args)
    if not nums:
        return EMPTY
    return sum(nums) / len(nums)


@builtin("pi")
def _pi(args: list[FValue]) -> FValue:
    return math.pi


@builtin("e")
def _e(args: list[FValue]) -> FValue:
    return math.e


@builtin("toNumber")
def _to_number(args: list[FValue]) -> FValue:
    """`toNumber(Any)` -- the explicit String/Boolean/Date -> Number
    conversion (research §1.8's conversion table). `toNumber("abc")` is
    research §1.9's fourth named UNRESOLVED example: decided EMPTY, same
    as every other edge in this module. `toNumber(true) == 1` and
    `toNumber(now())` returning the Unix-ms timestamp are both official,
    documented examples (not this task's own guesses)."""
    (v,) = args
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, float):
        return v
    if isinstance(v, str):
        try:
            return float(v.strip())
        except ValueError:
            return EMPTY
    if isinstance(v, Date):
        # research §1.8: "toNumber(now()) returns the Unix ms timestamp" --
        # matches `timestamp()`'s own documented semantics (Task 26).
        # `Date` (Task 26) may carry a range (`start`/`end`); a Number has
        # no room for two instants, so this reads `.start` only -- the
        # same choice `functions/datetime.py`'s own `timestamp()` builtin
        # makes, for the identical reason (this task's report).
        return v.start.timestamp() * 1000.0
    return EMPTY  # List / Person / Page: no documented numeric coercion
