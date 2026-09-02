"""§H.3.6 Date & time (19).

**THREE UTC-only decisions**, stated once here so they read as one theme
rather than three separate surprises later (this task's brief, explicit --
mirrors the gap note `services/db/query/operators.py` already carries for
its own UTC-only window-function SQL):

1. `EvalContext.now` (`evaluator.py`, Task 25) is captured ONCE, in UTC, by
   whichever caller starts an evaluation pass -- never a fresh, per-call
   `datetime.now()`.
2. `now()`/`today()` (this module) return that captured UTC instant
   directly. Research documents `now()` as returning the current moment
   "in the viewer's local time zone" -- this codebase has NO per-user time
   zone concept (M3 grepped the whole backend and found none, and settled
   on UTC-only; M7 kept the same decision for relation date-shifts). There
   is no "viewer" zone for this evaluator to render into.
3. `formatDate`'s third (time-zone) argument is accepted syntactically
   here -- a formula using it still parses/type-checks/evaluates -- but has
   NO effect on the rendered output: every rendering is UTC, for the
   identical reason as #2.

`now`/`today` are registered in `REGISTRY` via `unreachable_via_evaluator`
(see that function's docstring) rather than a real implementation: neither
can be a pure `list[FValue] -> FValue` function, since both need
`EvalContext.now`, which no `REGISTRY` function can see.
`evaluator._eval_now_today` is where they are actually implemented.

Two more traps this task's brief names explicitly, both cited again at
their own implementation site below: `day(Date)` is day-of-WEEK (1=Monday)
while `date(Date)` is day-of-MONTH -- the opposite of what the adjacent
names suggest; and `dateBetween(a, b, u)` computes **a - b** (research
§3.6.1's own worked examples confirm this, and the naive "b - a" reading
is the one everybody gets wrong first).
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Callable

from ..values import _MONTH_NAMES, _WEEKDAY_NAMES, EMPTY, Date, FValue, as_number
from . import builtin, unreachable_via_evaluator

# ---------------------------------------------------------------------------
# Calendar-unit shifting (`dateAdd`/`dateSubtract`) and calendar-unit
# differencing (`dateBetween`)
# ---------------------------------------------------------------------------

# research §3.6.1, official, complete: "years quarters months weeks days
# hours minutes" -- **no `"seconds"`, no `"milliseconds"`**, stated three
# times (once per function) and stopping at minutes. This task's brief
# names the missing "seconds" unit explicitly as a trap. Singular forms
# ("day", "week", ...) are ALSO accepted -- research: Notion's own help
# pages use both spellings inconsistently ("2, 'week'" in one place, the
# plural-only reference table in another) and explicitly suggests "a
# tolerant parser should accept both." Case is lower-cased before lookup
# (undocumented either way; the conservative permissive reading).
_CALENDAR_UNITS = frozenset({"years", "year", "quarters", "quarter", "months", "month"})
_FIXED_SECONDS_PER_UNIT = {
    "weeks": 604800.0, "week": 604800.0,
    "days": 86400.0, "day": 86400.0,
    "hours": 3600.0, "hour": 3600.0,
    "minutes": 60.0, "minute": 60.0,
}  # fmt: skip


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return (datetime(year + 1, 1, 1) - datetime(year, 12, 1)).days
    return (datetime(year, month + 1, 1) - datetime(year, month, 1)).days


def _add_months(dt: datetime, months: int) -> datetime:
    """Calendar-month arithmetic with no stdlib/third-party helper (this
    package uses only `math`/`datetime`, the same discipline
    `functions/numeric.py`/`string.py` already established -- notably NOT
    `python-dateutil`, which is present in both venvs only as a transitive
    dependency of `strictyaml`, not a declared direct one, and depending
    on it directly here would be fragile). Overflow clamps to the target
    month's last day (`Jan 31 + 1 month -> Feb 28`, not `Mar 3`) -- no
    official worked example for this exact edge, but this matches
    moment.js's own documented `add()` behaviour, and research states
    Notion's tokens/semantics here trace back to a moment.js-flavoured
    convention (§3.6.2) -- decided, flagged in this task's report."""
    total = dt.month - 1 + months
    year = dt.year + total // 12
    month = total % 12 + 1
    day = min(dt.day, _days_in_month(year, month))
    return dt.replace(year=year, month=month, day=day)


def _shift_datetime(dt: datetime, n: float, unit: str) -> datetime | None:
    """`None` means "not a recognised unit" (including the documented-
    absent `"seconds"`/`"milliseconds"`) -- the caller converts that to
    `EMPTY`. Fractional `n` is honoured for the four fixed-duration units
    (`timedelta` accepts a `float`); month/quarter/year arithmetic has no
    documented fractional reading, so `n` is truncated to `int` for those
    three (decided, flagged in this task's report)."""
    key = unit.lower()
    if key in ("years", "year"):
        return _add_months(dt, int(n) * 12)
    if key in ("quarters", "quarter"):
        return _add_months(dt, int(n) * 3)
    if key in ("months", "month"):
        return _add_months(dt, int(n))
    seconds = _FIXED_SECONDS_PER_UNIT.get(key)
    if seconds is None:
        return None
    return dt + timedelta(seconds=n * seconds)


@builtin("dateAdd")
def _date_add(args: list[FValue]) -> FValue:
    """`dateAdd(Date, Number, Text)` (research §3.6, official). An
    unrecognised unit string -- including `"seconds"`, which this task's
    brief calls out by name as a real, documented-absent unit, not an
    omission -- is EMPTY at runtime (this task's brief, explicit: "an
    unknown unit is a type error at check time if the unit is a literal,
    and EMPTY at runtime if it is not"). The check-time half of that
    ruling is NOT implemented -- `typecheck.py`'s `dateAdd`/`dateSubtract`/
    `dateBetween` signatures take an ordinary `String` parameter slot with
    no literal-value validation, so `dateAdd(now(), 1, "seconds")`
    currently passes type-checking. This is the same class of gap Task 25
    found and did not patch in Task 24's already-reviewed `typecheck.py`
    (its report, finding #1) -- flagged here for the same combined-review
    fix wave, not patched in this task either."""
    d, n, unit = args[0], as_number(args[1]), args[2]
    if not isinstance(d, Date) or n is None or not isinstance(unit, str):
        return EMPTY
    new_start = _shift_datetime(d.start, n, unit)
    if new_start is None:
        return EMPTY
    new_end = _shift_datetime(d.end, n, unit) if d.end is not None else None
    return Date(start=new_start, end=new_end)


@builtin("dateSubtract")
def _date_subtract(args: list[FValue]) -> FValue:
    """`dateSubtract(Date, Number, Text)` -- `dateAdd` with the shift
    negated; see `_date_add`'s docstring for the shared unit/error rulings."""
    d, n, unit = args[0], as_number(args[1]), args[2]
    if not isinstance(d, Date) or n is None or not isinstance(unit, str):
        return EMPTY
    new_start = _shift_datetime(d.start, -n, unit)
    if new_start is None:
        return EMPTY
    new_end = _shift_datetime(d.end, -n, unit) if d.end is not None else None
    return Date(start=new_start, end=new_end)


def _months_between(a: datetime, b: datetime) -> float:
    """Whole calendar months from `b` to `a` (`a - b`), truncated toward
    zero, sign-correct in either direction -- the standard "age in whole
    months" algorithm (count year/month difference, then subtract one if
    the day-of-month/time-of-day hasn't yet been reached). Research gives
    worked examples only for the `"days"` unit (§3.6.1); month/quarter/
    year units have no official example to check this against -- this
    task's own reading, flagged in its report."""
    sign = 1
    x, y = a, b
    if x < y:
        x, y = y, x
        sign = -1
    months = (x.year - y.year) * 12 + (x.month - y.month)
    if (x.day, x.hour, x.minute) < (y.day, y.hour, y.minute):
        months -= 1
    return float(sign * months)


@builtin("dateBetween")
def _date_between(args: list[FValue]) -> FValue:
    """`dateBetween(Date, Date, Text)` -- **computes `a - b`**, the first
    argument minus the second (research §3.6.1's own worked examples,
    cited verbatim in this task's brief: `dateBetween(dateStart(range),
    dateEnd(range), "days") = -365`, `dateBetween(dateEnd(range),
    dateStart(range), "days") = 365` -- reversing the arguments flips the
    sign, and the naive "b - a" reading is exactly backwards). Truncates
    toward zero for every unit (research `UNRESOLVED:` for the fixed-
    duration units; decided consistently with this package's
    "IEEE-754/JS-like" numeric model elsewhere). Unrecognised unit
    (including `"seconds"`) -> EMPTY, same ruling as `dateAdd`/
    `dateSubtract` above."""
    a, b, unit = args[0], args[1], args[2]
    if not isinstance(a, Date) or not isinstance(b, Date) or not isinstance(unit, str):
        return EMPTY
    key = unit.lower()
    if key in ("years", "year"):
        return float(int(_months_between(a.start, b.start) / 12.0))
    if key in ("quarters", "quarter"):
        return float(int(_months_between(a.start, b.start) / 3.0))
    if key in ("months", "month"):
        return _months_between(a.start, b.start)
    seconds = _FIXED_SECONDS_PER_UNIT.get(key)
    if seconds is None:
        return EMPTY
    diff_seconds = (a.start - b.start).total_seconds()
    return float(math.trunc(diff_seconds / seconds))


# ---------------------------------------------------------------------------
# Field accessors
# ---------------------------------------------------------------------------


@builtin("minute")
def _minute(args: list[FValue]) -> FValue:
    (d,) = args
    return float(d.start.minute) if isinstance(d, Date) else EMPTY


@builtin("hour")
def _hour(args: list[FValue]) -> FValue:
    (d,) = args
    return float(d.start.hour) if isinstance(d, Date) else EMPTY


@builtin("day")
def _day(args: list[FValue]) -> FValue:
    """`day(Date)` is **day of WEEK, 1 = Monday ... 7 = Sunday** (research
    §3.6, official) -- NOT day of month, which is `date()` immediately
    below. This task's brief names this exact adjacent pair as the
    sharpest trap in the whole milestone -- two functions whose names mean
    the opposite of what a reader expects. `datetime.isoweekday()` already
    returns Monday=1..Sunday=7 with no adjustment needed."""
    (d,) = args
    return float(d.start.isoweekday()) if isinstance(d, Date) else EMPTY


@builtin("date")
def _date_of_month(args: list[FValue]) -> FValue:
    """`date(Date)` is **day of MONTH, 1-31** -- the opposite trap-partner
    of `day()` immediately above."""
    (d,) = args
    return float(d.start.day) if isinstance(d, Date) else EMPTY


@builtin("week")
def _week(args: list[FValue]) -> FValue:
    """`week(Date)` is the **ISO** week of year, 1-53 (research §3.6,
    official). `datetime.isocalendar()` already gives the ISO week
    directly -- this task's brief explicitly warns against hand-rolling
    it (e.g. `(day_of_year - 1) // 7 + 1`, which disagrees with ISO at
    year boundaries)."""
    (d,) = args
    return float(d.start.isocalendar()[1]) if isinstance(d, Date) else EMPTY


@builtin("month")
def _month(args: list[FValue]) -> FValue:
    (d,) = args
    return float(d.start.month) if isinstance(d, Date) else EMPTY


@builtin("year")
def _year(args: list[FValue]) -> FValue:
    (d,) = args
    return float(d.start.year) if isinstance(d, Date) else EMPTY


# ---------------------------------------------------------------------------
# Range construction/projection, conversions
# ---------------------------------------------------------------------------


@builtin("dateRange")
def _date_range(args: list[FValue]) -> FValue:
    """`dateRange(Date, Date) -> Date (with an end)` (research §1.3/§3.6,
    official). Reads only `.start` off each argument -- a `Date` argument
    that is itself already a range degenerates to its own start component,
    the same flattening choice `dateStart`/`dateEnd` below make."""
    a, b = args
    if not isinstance(a, Date) or not isinstance(b, Date):
        return EMPTY
    return Date(start=a.start, end=b.start)


@builtin("dateStart")
def _date_start(args: list[FValue]) -> FValue:
    (d,) = args
    return Date(start=d.start) if isinstance(d, Date) else EMPTY


@builtin("dateEnd")
def _date_end(args: list[FValue]) -> FValue:
    """`dateEnd(Date)` -- "End of the range" (research §3.6). Every
    official example applies this to a REAL `dateRange()` output; there is
    no documented reading for a Date with no `end` at all. Decided
    (flagged in this task's report): a single-instant Date's own `start`
    IS its end too (a degenerate, zero-width range) -- so `dateEnd` never
    fails on the same input `dateStart` always accepts, rather than being
    silently asymmetric with it."""
    (d,) = args
    if not isinstance(d, Date):
        return EMPTY
    return Date(start=d.end if d.end is not None else d.start)


@builtin("timestamp")
def _timestamp(args: list[FValue]) -> FValue:
    """`timestamp(Date) -> Number`, Unix **milliseconds** (research §3.6,
    official). Reads `.start` only -- a ranged Date has no single
    documented instant to convert (the same choice `toNumber(Date)` in
    `functions/numeric.py` makes, kept consistent with this function on
    purpose)."""
    (d,) = args
    return d.start.timestamp() * 1000.0 if isinstance(d, Date) else EMPTY


@builtin("fromTimestamp")
def _from_timestamp(args: list[FValue]) -> FValue:
    """`fromTimestamp(Number) -> Date` (research §3.6, official, verbatim:
    "the returned date will not retain the seconds & milliseconds") --
    truncated to the minute, not merely round-tripped."""
    (n,) = args
    ms = as_number(n)
    if ms is None:
        return EMPTY
    try:
        dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return EMPTY  # this task's brief-wide UNRESOLVED-edge ruling: EMPTY, never raise
    return Date(start=dt.replace(second=0, microsecond=0))


@builtin("parseDate")
def _parse_date(args: list[FValue]) -> FValue:
    """`parseDate(Text) -> Date`, ISO 8601 (research §3.6, official).
    `parseDate("garbage")` is research §1.9's own UNRESOLVED runtime-edge
    example, explicitly deferred from Task 25 to this task (Task 25's
    report: "Task 26 inherits the identical ruling rather than
    re-deriving it") -- EMPTY, the same ruling as every other UNRESOLVED
    edge in this package, never a raised exception."""
    (s,) = args
    if not isinstance(s, str):
        return EMPTY
    text = s.strip()
    if not text:
        return EMPTY
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return EMPTY
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)  # UTC-only, see module docstring
    else:
        dt = dt.astimezone(timezone.utc)
    return Date(start=dt)


# ---------------------------------------------------------------------------
# formatDate -- Luxon/Moment-style tokens (research §3.6.2, [P2] end to
# end: "Notion uses Luxon internally but retains Moment.js-style tokens").
# ---------------------------------------------------------------------------


_ORDINAL_SUFFIX = {1: "st", 2: "nd", 3: "rd"}


def _ordinal(n: int) -> str:
    """English ordinal suffix (`Do`/`do`/`DDDo`/`Mo`/`Qo` tokens). The
    11th/12th/13th exception (`10 <= n % 100 <= 20`, not just `n % 10 in
    (1,2,3)`) is why `_ORDINAL_SUFFIX` alone isn't enough."""
    if 10 <= n % 100 <= 20:
        return f"{n}th"
    return f"{n}{_ORDINAL_SUFFIX.get(n % 10, 'th')}"


def _h12(hour24: int) -> int:
    h = hour24 % 12
    return 12 if h == 0 else h


def _day_of_year(dt: datetime) -> int:
    return (dt.date() - dt.replace(month=1, day=1).date()).days + 1


def _quarter(dt: datetime) -> int:
    return (dt.month - 1) // 3 + 1


# The token subset this task actually implements -- see this task's report
# for the honest "supported tokens" list (do not extend the claim beyond
# what is registered here). Matched by DESCENDING length so e.g. `YYYY`
# wins over `YY`/`Y`, `MMMM` over `MMM`/`MM`/`M`.
_TOKEN_RENDERERS: dict[str, Callable[[datetime], str]] = {
    # Meridiem
    "A": lambda dt: "AM" if dt.hour < 12 else "PM",
    "a": lambda dt: "am" if dt.hour < 12 else "pm",
    # Hour
    "HH": lambda dt: f"{dt.hour:02d}",
    "H": lambda dt: str(dt.hour),
    "hh": lambda dt: f"{_h12(dt.hour):02d}",
    "h": lambda dt: str(_h12(dt.hour)),
    "kk": lambda dt: f"{(dt.hour or 24):02d}",
    "k": lambda dt: str(dt.hour or 24),
    # Minute
    "mm": lambda dt: f"{dt.minute:02d}",
    "m": lambda dt: str(dt.minute),
    # Second / fractional second -- research's own doc note ("Notion only
    # stores time to the minute, so seconds always render as 0") describes
    # PROPERTY-sourced dates, not this function; a `Date` built from
    # `parseDate`/`now`/etc. may carry real seconds, and this renders
    # whatever `.start` actually holds rather than hard-coding zero.
    "ss": lambda dt: f"{dt.second:02d}",
    "s": lambda dt: str(dt.second),
    "SSS": lambda dt: f"{dt.microsecond // 1000:03d}",
    "SS": lambda dt: f"{dt.microsecond // 10000:02d}",
    "S": lambda dt: str(dt.microsecond // 100000),
    # Day of month / year
    "DDDD": lambda dt: f"{_day_of_year(dt):03d}",
    "DDDo": lambda dt: _ordinal(_day_of_year(dt)),
    "DDD": lambda dt: str(_day_of_year(dt)),
    "DD": lambda dt: f"{dt.day:02d}",
    "Do": lambda dt: _ordinal(dt.day),
    "D": lambda dt: str(dt.day),
    # Day of week
    "dddd": lambda dt: _WEEKDAY_NAMES[dt.weekday()],
    "ddd": lambda dt: _WEEKDAY_NAMES[dt.weekday()][:3],
    "dd": lambda dt: _WEEKDAY_NAMES[dt.weekday()][:2],
    # Zero-based day of week (Sunday=0..Saturday=6, the Moment/Luxon en-US
    # default -- undocumented by research either way, decided here).
    "do": lambda dt: _ordinal(dt.isoweekday() % 7),
    "d": lambda dt: str(dt.isoweekday() % 7),
    "E": lambda dt: str(dt.isoweekday()),  # ISO day of week, 1=Monday..7=Sunday
    # Month
    "MMMM": lambda dt: _MONTH_NAMES[dt.month - 1],
    "MMM": lambda dt: _MONTH_NAMES[dt.month - 1][:3],
    "MM": lambda dt: f"{dt.month:02d}",
    "Mo": lambda dt: _ordinal(dt.month),
    "M": lambda dt: str(dt.month),
    # Quarter
    "QQ": lambda dt: f"{_quarter(dt):02d}",
    "Qo": lambda dt: _ordinal(_quarter(dt)),
    "Q": lambda dt: str(_quarter(dt)),
    # Year
    "YYYY": lambda dt: f"{dt.year:04d}",
    "YY": lambda dt: f"{dt.year % 100:02d}",
    "Y": lambda dt: str(dt.year),
    # Timestamp
    "x": lambda dt: str(int(dt.timestamp() * 1000)),
    "X": lambda dt: str(int(dt.timestamp())),
    # Time zone -- UTC-only, see module docstring's decision #3. Cheap and
    # honest to implement (unlike the locale composite macros below) since
    # every `Date` this evaluator produces IS UTC by construction.
    "ZZZ": lambda dt: "UTC",
    "ZZ": lambda dt: "+0000",
    "Z": lambda dt: "+00:00",
}
_TOKENS_BY_LENGTH = sorted(_TOKEN_RENDERERS, key=len, reverse=True)

# NOT implemented (research §3.6.2's own token table documents these too;
# an unrecognised run of letters that isn't `[bracket-escaped]` just
# passes through character-by-character below, printing the token's own
# literal letters rather than the intended localized/composite string --
# a known, reported gap, not a silent invention):
#   - Locale composite macros: LT LTS L l LL ll LLL lll LLLL llll
#   - Non-ISO week-of-year: w wo ww
#   - ISO week-of-year (formatDate-specific token; `week()` the builtin
#     already covers ISO week via `isocalendar()`): W Wo WW
#   - Week-year: gg gggg GG GGGG
#   - Localized (non-ISO) day-of-week number: e


def _render_format_tokens(dt: datetime, fmt: str) -> str:
    """Greedy longest-match token scan, with `[...]` as a literal-text
    escape (research §3.6.2, official example:
    `formatDate(now(), "[Month of] MMMM, YYYY")` -> `"Month of June, 2022"`)."""
    out: list[str] = []
    i = 0
    n = len(fmt)
    while i < n:
        ch = fmt[i]
        if ch == "[":
            end = fmt.find("]", i + 1)
            if end == -1:
                out.append(fmt[i + 1 :])  # unterminated bracket -- take the rest literally
                break
            out.append(fmt[i + 1 : end])
            i = end + 1
            continue
        matched = False
        for tok in _TOKENS_BY_LENGTH:
            if fmt.startswith(tok, i):
                out.append(_TOKEN_RENDERERS[tok](dt))
                i += len(tok)
                matched = True
                break
        if not matched:
            out.append(ch)
            i += 1
    return "".join(out)


@builtin("formatDate")
def _format_date(args: list[FValue]) -> FValue:
    """`formatDate(Date, Text, Text?) -> Text` (research §3.6.2). Supports
    the token subset listed in `_TOKEN_RENDERERS` above (see this task's
    report for the exact "supported tokens" list -- claiming full Luxon/
    Moment compatibility would be an overclaim this task's brief
    explicitly warns against). Third argument (time zone) is accepted
    syntactically but has no effect -- UTC-only decision #3, module
    docstring."""
    d = args[0]
    fmt = args[1]
    if not isinstance(d, Date) or not isinstance(fmt, str):
        return EMPTY
    if len(args) > 2 and not isinstance(args[2], str):
        return EMPTY
    return _render_format_tokens(d.start, fmt)


# `now`/`today` cannot be pure `list[FValue] -> FValue` functions (both
# need `EvalContext.now`) -- see `unreachable_via_evaluator`'s docstring
# and `evaluator._eval_now_today`, the real implementation.
builtin("now")(unreachable_via_evaluator("now"))
builtin("today")(unreachable_via_evaluator("today"))
