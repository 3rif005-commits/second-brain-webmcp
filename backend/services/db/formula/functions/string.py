"""§H.3.3 String (16) and §H.3.5 `formatNumber` format strings.

Every function here is a plain `list[FValue] -> FValue` builtin;
`evaluator.py`'s `_invoke` has already filtered out any top-level `EMPTY`
argument before a call reaches this module (none of these 16 names are in
`_EMPTY_AWARE`), so nothing below needs to think about a bare `EMPTY`
input -- only about malformed/wrongly-typed input, which this module
answers uniformly with `EMPTY` too (this task's brief-wide ruling), never
an exception.
"""
from __future__ import annotations

import math

from ..values import EMPTY, FValue, as_number, stringify
from . import builtin

# Guards against a user-authored formula generating pathologically large
# strings on a shared event loop (`repeat`) -- a module constant with a
# comment, not a magic number buried in the function body, per this task's
# brief.
_MAX_REPEAT_LENGTH = 100_000


def _as_string_receiver(v: FValue) -> str | None:
    """The documented number/boolean-receiver-on-a-string-method coercion
    (research §1.8, official: `1932.substring(0,2) == "19"`). This task's
    brief calls this out explicitly: "the coercion is Task 24's typing
    rule; make sure the runtime actually implements it rather than
    assuming the checker handled it" -- and indeed Task 24's `typecheck.py`
    does NOT implement it (`_check_overloaded_call`'s `_matches` requires
    an exact `unify()` match for a `STRING` parameter slot; `NUMBER` does
    not unify with `STRING`, so `1932.substring(0,2)` currently FAILS
    type-checking even though research documents it as legal runtime
    behaviour). That is a real gap in the already-committed, already-
    reviewed Task 24 checker, flagged in this task's report rather than
    silently patched here (out of this task's file scope, and a
    checker-table change deserves its own review) -- this function
    implements the documented RUNTIME side regardless of what the checker
    currently accepts, exactly as the brief instructs.

    Scope of the coercion, our own reading (research gives exactly one
    worked example, on `substring`'s receiver, and never states how far
    "a string method" extends): applied to every function in this module
    at its FIRST argument only -- the "receiver" position in dot-notation
    terms -- not to every string-typed argument of every function.
    `contains(42, "2")`, `42.trim()`, `42.upper()` etc. all get the same
    treatment via this one helper; `replace(a, b, c)`'s 2nd/3rd argument
    positions do NOT (that is `functions/regex.py`'s own, separately
    documented coercion, per research's *different* rule for
    replace/replaceAll/test: "auto-convert Numbers and Booleans... to
    strings" there too, but stated as its own row in research's table, not
    derived from this one)."""
    if isinstance(v, str):
        return v
    if isinstance(v, (float, bool)):
        return stringify(v)
    return None


def _clamp_index(idx: float, n: int) -> int:
    """Out-of-range `substring` indices (this task's brief calls this out
    explicitly; research gives no worked example for it). Decided:
    negative clamps to `0`, past-the-end clamps to `n` -- the
    conservative "never raise, never wrap around" reading. NOT
    implemented: JS `String.prototype.substring`'s documented quirk of
    swapping `start`/`end` when `start > end` -- research's own examples
    never exercise that, and inventing it would be extending a *different*
    language's spec (`.substring` is one of several JS string methods
    with famously inconsistent negative/out-of-order-index handling) onto
    Notion with zero evidence Notion's engine copies that particular
    quirk. `start > end` (after clamping) returns `""` here instead."""
    i = int(idx)
    if i < 0:
        return 0
    if i > n:
        return n
    return i


@builtin("length")
def _length(args: list[FValue]) -> FValue:
    (v,) = args
    if isinstance(v, str):
        return float(len(v))
    if isinstance(v, list):
        return float(len(v))
    return EMPTY


@builtin("substring")
def _substring(args: list[FValue]) -> FValue:
    text = _as_string_receiver(args[0])
    start_n = as_number(args[1])
    if text is None or start_n is None:
        return EMPTY
    n = len(text)
    start_i = _clamp_index(start_n, n)
    if len(args) > 2:
        end_n = as_number(args[2])
        if end_n is None:
            return EMPTY
        end_i = _clamp_index(end_n, n)
    else:
        end_i = n
    if end_i < start_i:
        return ""
    return text[start_i:end_i]


@builtin("contains")
def _contains(args: list[FValue]) -> FValue:
    haystack = _as_string_receiver(args[0])
    needle = _as_string_receiver(args[1])
    if haystack is None or needle is None:
        return EMPTY
    return needle in haystack


@builtin("lower")
def _lower(args: list[FValue]) -> FValue:
    s = _as_string_receiver(args[0])
    return EMPTY if s is None else s.lower()


@builtin("upper")
def _upper(args: list[FValue]) -> FValue:
    s = _as_string_receiver(args[0])
    return EMPTY if s is None else s.upper()


@builtin("repeat")
def _repeat(args: list[FValue]) -> FValue:
    s = _as_string_receiver(args[0])
    n = as_number(args[1])
    if s is None or n is None:
        return EMPTY
    count = int(n)
    if count < 0:
        return EMPTY  # undocumented; no sensible reading for a negative count
    if len(s) * count > _MAX_REPEAT_LENGTH:
        return EMPTY  # denial-of-service guard, see module constant's comment
    return s * count


@builtin("trim")
def _trim(args: list[FValue]) -> FValue:
    s = _as_string_receiver(args[0])
    return EMPTY if s is None else s.strip()


def _pad(s: str, target_len: float, fill: str, *, start: bool) -> str:
    needed = int(target_len) - len(s)
    if needed <= 0 or not fill:
        # `needed <= 0`: already at/past the target length -- no padding
        # (official example only shows the padding case). `not fill`: an
        # empty fill string has nothing to repeat -- undocumented,
        # decided as a no-op rather than an infinite loop or an error.
        return s
    reps = (needed // len(fill)) + 1
    pad = (fill * reps)[:needed]
    return pad + s if start else s + pad


@builtin("padStart")
def _pad_start(args: list[FValue]) -> FValue:
    s = _as_string_receiver(args[0])
    target = as_number(args[1])
    fill = _as_string_receiver(args[2])
    if s is None or target is None or fill is None:
        return EMPTY
    return _pad(s, target, fill, start=True)


@builtin("padEnd")
def _pad_end(args: list[FValue]) -> FValue:
    s = _as_string_receiver(args[0])
    target = as_number(args[1])
    fill = _as_string_receiver(args[2])
    if s is None or target is None or fill is None:
        return EMPTY
    return _pad(s, target, fill, start=False)


@builtin("split")
def _split(args: list[FValue]) -> FValue:
    s = _as_string_receiver(args[0])
    sep = _as_string_receiver(args[1])
    if s is None or sep is None:
        return EMPTY
    if sep == "":
        # Undocumented edge (research gives no empty-separator example).
        # Decided: character-split, matching JS's `"abc".split("")` ->
        # `["a","b","c"]` -- the numeric/date model is already documented
        # JS-flavoured (§1.1), so this is the most consistent reading.
        return list(s)
    return s.split(sep)


@builtin("join")
def _join(args: list[FValue]) -> FValue:
    lst, sep = args[0], args[1]
    if not isinstance(lst, list):
        return EMPTY
    sep_s = _as_string_receiver(sep)
    if sep_s is None:
        return EMPTY
    # research §1.8: "join() stringifies all elements" -- reuses
    # `values.stringify`, the SAME stringification `+`/`format()` use, so
    # `join([1, true, "x"], ",")` and manually writing
    # `format(1) + "," + format(true) + "," + "x"` cannot disagree.
    return sep_s.join(stringify(v) for v in lst)


@builtin("format")
def _format(args: list[FValue]) -> FValue:
    (v,) = args
    return stringify(v)


@builtin("link")
def _link(args: list[FValue]) -> FValue:
    """`link(Text, Text)` documents "Text (rich)" as its return type
    (research §3.9) -- a hyperlink annotation over the label. This
    evaluator's `FValue` model (this task's brief §2) has no rich-text/
    annotation wrapper type, so the annotation cannot be represented.
    Decided (flagged in this task's report): return the LABEL only,
    discarding the URL -- the lesser information loss for a plain string
    result (embedding the URL as literal text would silently corrupt
    every downstream string operation on the value, e.g. a `length()` or
    `contains()` call the formula author did not ask to be affected by
    the link target)."""
    label = _as_string_receiver(args[0])
    url = _as_string_receiver(args[1])
    if label is None or url is None:
        return EMPTY
    return label


@builtin("style")
def _style(args: list[FValue]) -> FValue:
    """Same rich-text-representation gap as `link` above: `style` returns
    annotated rich text (bold/italic/color/etc., research §3.9), which
    this evaluator cannot carry in `FValue`. Decided: identity on the text
    VALUE -- style tokens affect only rendering in real Notion, and this
    evaluator computes values, not rendering (materialisation, Task 27,
    writes `computed` JSONB; a rich-text/annotation value would need its
    own representation there too, out of this task's scope). Unrecognised
    style tokens are silently ignored (no first-class errors, research
    §1.9), not validated against the documented token set -- validating
    tokens whose only effect is on a rendering layer this evaluator
    doesn't have would be validation theatre."""
    text = _as_string_receiver(args[0])
    return EMPTY if text is None else text


@builtin("unstyle")
def _unstyle(args: list[FValue]) -> FValue:
    text = _as_string_receiver(args[0])
    return EMPTY if text is None else text


# ---------------------------------------------------------------------------
# formatNumber (research §3.5) -- marked [P2] end to end: the official
# reference lists the NAME `formatNumber` with no description at all; every
# format string, every currency code, and the "humanize ignores precision" /
# "bytes_* don't pad insignificant decimals" quirks come from the
# community reference only. Flagged in this task's report as this task's
# single largest P2 surface.
# ---------------------------------------------------------------------------


def _round_half_up(x: float) -> float:
    """Same JS `Math.round` tie-breaking as `functions/numeric.py`'s
    `_round` -- duplicated here (rather than imported) to keep this
    module's only cross-module dependency `..values`, since `numeric.py`
    importing `string.py` (or vice versa) for one three-line helper is not
    worth a real coupling between two otherwise-independent categories."""
    return math.floor(x + 0.5)


def _natural_commas(value: float, precision: int | None) -> str:
    """The comma-grouped decimal core shared by `commas`, `percent`, and
    every currency format. With an explicit `precision`, always shows
    exactly that many decimal places. With no `precision` (research's own
    `commas`/`percent` examples are both precision-less): an integral
    value prints with no decimal point at all (`12345` -> `"12,345"`,
    matching the official example exactly); a fractional value prints its
    natural (shortest round-tripping) decimal digits (`0.856*100 == 85.6`
    -> `"85.6"`, also matching). This "natural precision" default has no
    research-documented example beyond those two (both of which happen not
    to need one) -- our own reading for the untested general case,
    flagged in this task's report."""
    if precision is not None:
        return f"{value:,.{precision}f}"
    if float(value).is_integer():
        return f"{int(value):,}"
    text = repr(float(value))
    decimals = len(text.split(".", 1)[1]) if "." in text else 0
    return f"{value:,.{decimals}f}"


def _compact(value: float) -> str:
    """`humanize`/`compact`: `1234567 -> "1.2M"` (official example).
    Always 1 decimal place (our own reading for the untested
    exact-multiple case, e.g. `2000000` -> `"2.0M"` not `"2M"` -- research
    shows only the one non-round example) and, per the documented quirk,
    ALWAYS ignores `precision`."""
    sign = "-" if value < 0 else ""
    v = abs(value)
    for threshold, suffix in ((1e12, "T"), (1e9, "B"), (1e6, "M"), (1e3, "K")):
        if v >= threshold:
            scaled = _round_half_up((v / threshold) * 10) / 10
            return f"{sign}{scaled:.1f}{suffix}"
    scaled = _round_half_up(v * 10) / 10
    return f"{sign}{scaled:.1f}"


_DECIMAL_BYTE_UNITS = ((1e12, "TB"), (1e9, "GB"), (1e6, "MB"), (1e3, "KB"))
_BINARY_BYTE_UNITS = (
    (1024.0**4, "TiB"),
    (1024.0**3, "GiB"),
    (1024.0**2, "MiB"),
    (1024.0, "KiB"),
)


def _bytes_format(
    value: float, units: tuple[tuple[float, str], ...], precision: int | None
) -> str:
    """`bytes_decimal`/`bytes_binary`(`bytes`): documented quirk --
    "respect precision but do not pad insignificant decimals"
    (`formatNumber(1, "bytes_decimal", 4) -> "1 B"`, not `"1.0000 B"`).
    Implemented literally: round to `precision` (default 2) decimal
    places, then print with NO decimal point at all if the rounded value
    is exactly integral, matching the quirk's own worked example."""
    sign = "-" if value < 0 else ""
    v = abs(value)
    scale, suffix = 1.0, "B"
    for threshold, unit_suffix in units:
        if v >= threshold:
            scale, suffix = threshold, unit_suffix
            break
    scaled = v / scale
    p = 2 if precision is None else precision
    factor = 10.0**p
    rounded = _round_half_up(scaled * factor) / factor
    if float(rounded).is_integer():
        return f"{sign}{int(rounded)} {suffix}"
    return f"{sign}{rounded:.{p}f} {suffix}"


# research §3.5, verbatim list -- 38 currency-format groups, 3 of which
# have a documented second spelling (`dollar`/`euro`/`yen`), for 41
# accepted string tokens total. This task's report notes the exact count:
# research's own §3.5 prose never states a headline total for this list
# (unlike its "88 functions"/"40 number formats" miscounts elsewhere), so
# there is no claimed number to check this recount against -- included
# here only so a future reader can verify the table against research
# without re-tallying it themselves.
_CURRENCY_ALIASES = {"dollar": "usd", "euro": "eur", "yen": "jpy"}
_CURRENCY_CODES = frozenset(
    {
        "usd", "eur", "jpy", "aud", "cad", "sgd", "gbp", "rub", "inr", "krw",
        "cny", "brl", "try", "idr", "chf", "hkd", "nzd", "sek", "nok", "mxn",
        "zar", "twd", "dkk", "pln", "thb", "huf", "czk", "ils", "clp", "php",
        "aed", "cop", "sar", "myr", "ron", "ars", "uyu", "pen",
    }
)  # fmt: skip


@builtin("formatNumber")
def _format_number(args: list[FValue]) -> FValue:
    value = as_number(args[0])
    if value is None:
        return EMPTY

    fmt = "commas"
    if len(args) > 1:
        if not isinstance(args[1], str):
            return EMPTY
        fmt = args[1].lower()

    precision: int | None = None
    if len(args) > 2:
        p = as_number(args[2])
        if p is None:
            return EMPTY
        # research: "precision is decimal places 0-12." Clamped, not
        # rejected, for an out-of-range value -- undocumented edge, and
        # clamping (vs. EMPTY) keeps a formula usable rather than blanking
        # a cell over a fencepost typo. Flagged in this task's report.
        precision = max(0, min(12, int(p)))

    if fmt in ("humanize", "compact"):
        return _compact(value)
    if fmt == "percent":
        return _natural_commas(value * 100.0, precision) + "%"
    if fmt == "bytes_decimal":
        return _bytes_format(value, _DECIMAL_BYTE_UNITS, precision)
    if fmt in ("bytes_binary", "bytes"):
        return _bytes_format(value, _BINARY_BYTE_UNITS, precision)
    if fmt == "commas":
        return _natural_commas(value, precision)

    code = _CURRENCY_ALIASES.get(fmt, fmt)
    if code in _CURRENCY_CODES:
        # No worked example anywhere in research for ANY currency format
        # -- symbol choice, symbol placement, and decimal-count defaults
        # are entirely this task's own invention, not sourced. Decided:
        # `"{CODE} {amount}"` (ISO-4217-style code prefix, not a currency
        # SYMBOL like "$") specifically BECAUSE a symbol table would look
        # sourced/authoritative to a future reader when it is not --
        # flagged prominently in this task's report as the least-invented
        # honest choice available, pending a live-workspace probe.
        amount = _natural_commas(value, precision if precision is not None else 2)
        return f"{code.upper()} {amount}"

    return EMPTY  # unrecognised format string -- undocumented; decided EMPTY
