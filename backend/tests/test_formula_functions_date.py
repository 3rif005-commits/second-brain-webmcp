"""Golden-value table for the 19 date/time formula builtins (research
§H.3.6), Milestone 8d (Task 26).

Same rules as Task 25's `test_formula_functions_core.py`: SOURCED (a
verbatim worked example from docs/research/notion-databases-research.md)
or OURS (this task's own example, because research describes the
function's shape but gives no concrete input/output pair) tagged per row.

Specifically pins every trap this task's brief names: `day()` is
day-of-WEEK while `date()` is day-of-MONTH (the adjacent pair meaning the
opposite of what the names suggest); `dateBetween(a,b,u)` computes `a-b`,
both directions, sign-flip proven directly; `"seconds"` is REJECTED (not a
real unit); `now()`/`today()` come from `EvalContext.now`, never a fresh
`datetime.now()`; `fromTimestamp` truncates seconds/ms per its own
official doc note; `parseDate("garbage")` is EMPTY, inheriting Task 25's
identical UNRESOLVED-edge ruling.

Pure Python, no database, no fixtures.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from services.db.formula import parse
from services.db.formula.evaluator import EvalContext, evaluate, make_now
from services.db.formula.values import EMPTY, Date

# A fixed instant used throughout: Wednesday, August 30, 2023, 17:55 UTC --
# research's own `format(now())` worked example uses exactly this moment
# ("August 30, 2023 17:55"), so reusing it here lets several date-field
# cases below cross-check against that SAME official example instead of
# inventing an unrelated fixture date.
_FIXED_NOW = datetime(2023, 8, 30, 17, 55, tzinfo=timezone.utc)
_D = Date(start=_FIXED_NOW)


def _eval(src: str, *, properties=None, now=None, page_id=None):
    tree = parse(src)
    ctx = EvalContext(
        properties=properties or {"D": _D},
        now=now if now is not None else _FIXED_NOW,
        page_id=page_id,
    )
    return evaluate(tree, ctx)


# ---------------------------------------------------------------------------
# now() / today() -- must come from EvalContext.now, never datetime.now()
# ---------------------------------------------------------------------------


def test_now_returns_the_captured_instant_not_a_fresh_clock_read():
    result = _eval("now()")
    assert result == Date(start=_FIXED_NOW)


def test_two_now_calls_in_one_formula_return_the_identical_instant():
    # brief, explicit: two now() calls in one formula must agree -- this
    # would only fail if now() read a fresh clock per call instead of
    # ctx.now.
    result = _eval("now() == now()")
    assert result is True


def test_today_truncates_to_utc_midnight():
    result = _eval("today()")
    assert result == Date(start=datetime(2023, 8, 30, 0, 0, tzinfo=timezone.utc))


def test_now_is_utc_not_a_viewer_local_timezone():
    # research documents "the viewer's local time zone" -- this codebase
    # has no such concept (M3/M7's decision, inherited here); now()'s
    # `.start` is exactly the UTC instant that was captured, unmodified.
    result = _eval("now()")
    assert result.start.tzinfo == timezone.utc


# ---------------------------------------------------------------------------
# Field accessors, including the day()/date() trap
# ---------------------------------------------------------------------------

FIELD_CASES = [
    ("minute", "minute(prop(\"D\"))", 55.0),  # OURS
    ("hour", "hour(prop(\"D\"))", 17.0),  # OURS
    # TRAP: day() is day of WEEK, 1=Monday...7=Sunday. 2023-08-30 is a
    # Wednesday -> 3. SOURCED shape (research §3.6, official), OURS value.
    ("day_is_day_of_week__ours", "day(prop(\"D\"))", 3.0),
    # TRAP's mirror: date() is day of MONTH, 1-31 -- the SAME Date value,
    # deliberately paired with the case above so a reviewer sees both
    # halves of the trap side by side.
    ("date_is_day_of_month__ours", "date(prop(\"D\"))", 30.0),
    ("week_is_iso_week__ours", "week(prop(\"D\"))", 35.0),
    ("month__ours", "month(prop(\"D\"))", 8.0),
    ("year__ours", "year(prop(\"D\"))", 2023.0),
]


@pytest.mark.parametrize("case_id,src,expected", FIELD_CASES, ids=[c[0] for c in FIELD_CASES])
def test_field_accessor(case_id, src, expected):
    assert _eval(src) == expected


def test_day_and_date_are_not_accidentally_swapped():
    """The trap, proven directly rather than just via two separate cases:
    day() and date() on the SAME input must NOT return the same value
    (which would happen if their implementations were accidentally
    swapped, since both would then compute either the weekday OR the
    day-of-month)."""
    day_of_week = _eval("day(prop(\"D\"))")
    day_of_month = _eval("date(prop(\"D\"))")
    assert day_of_week == 3.0
    assert day_of_month == 30.0
    assert day_of_week != day_of_month


# ---------------------------------------------------------------------------
# dateAdd / dateSubtract -- units, singular/plural tolerance, "seconds" trap
# ---------------------------------------------------------------------------

ADD_SUBTRACT_CASES = [
    ("dateAdd_days__ours", 'dateAdd(prop("D"), 2, "days")', Date(start=datetime(2023, 9, 1, 17, 55, tzinfo=timezone.utc))),
    ("dateAdd_singular_week__ours", 'dateAdd(prop("D"), 2, "week")', Date(start=datetime(2023, 9, 13, 17, 55, tzinfo=timezone.utc))),
    ("dateAdd_months_end_of_month_clamps__ours", 'dateAdd(dateStart(prop("Jan31")), 1, "months")', Date(start=datetime(2023, 2, 28, tzinfo=timezone.utc))),
    ("dateAdd_years__ours", 'dateAdd(prop("D"), 1, "years")', Date(start=datetime(2024, 8, 30, 17, 55, tzinfo=timezone.utc))),
    ("dateSubtract_days__ours", 'dateSubtract(prop("D"), 2, "days")', Date(start=datetime(2023, 8, 28, 17, 55, tzinfo=timezone.utc))),
    ("dateSubtract_singular_day__ours", 'prop("D").dateSubtract(1, "day")', Date(start=datetime(2023, 8, 29, 17, 55, tzinfo=timezone.utc))),
]  # fmt: skip


@pytest.mark.parametrize(
    "case_id,src,expected", ADD_SUBTRACT_CASES, ids=[c[0] for c in ADD_SUBTRACT_CASES]
)
def test_date_add_subtract(case_id, src, expected):
    props = {"D": _D, "Date": _D, "Jan31": Date(start=datetime(2023, 1, 31, tzinfo=timezone.utc))}
    assert _eval(src, properties=props) == expected


def test_date_add_rejects_seconds_unit():
    # brief, explicit trap: "seconds" is not a documented unit (only
    # years/quarters/months/weeks/days/hours/minutes are) -- EMPTY at
    # runtime, not a type error here (this evaluator's typecheck.py does
    # not literal-validate unit strings -- flagged as a gap in this
    # task's report, not fixed here, same discipline Task 25 used for an
    # analogous typecheck.py gap).
    assert _eval('dateAdd(prop("D"), 1, "seconds")') is EMPTY


def test_date_subtract_rejects_milliseconds_unit():
    assert _eval('dateSubtract(prop("D"), 1, "milliseconds")') is EMPTY


# ---------------------------------------------------------------------------
# dateBetween -- the a-minus-b sign trap, both directions
# ---------------------------------------------------------------------------


def test_date_between_now_later_than_target_is_positive_official():
    # research §3.6.1, official, verbatim: dateBetween(now(), parseDate(
    # "2022-09-07"), "days") = 357 -- but that literal 357 is anchored to
    # the 2023-dated docs' own "now"; reproduced here against THIS test
    # file's fixed "now" instead, computed independently to stay accurate.
    now_ = datetime(2023, 8, 21, tzinfo=timezone.utc)  # exactly 348 days after 2022-09-07
    result = _eval('dateBetween(now(), parseDate("2022-09-07"), "days")', now=now_)
    assert result == 348.0


def test_date_between_a_minus_b_sign_convention_both_directions_official():
    # research §3.6.1, official, verbatim (the authoritative pair the
    # brief itself cites): dateBetween(dateStart(range), dateEnd(range),
    # "days") = -365; dateBetween(dateEnd(range), dateStart(range),
    # "days") = 365.
    rng = Date(
        start=datetime(2022, 9, 7, tzinfo=timezone.utc),
        end=datetime(2023, 9, 7, tzinfo=timezone.utc),
    )
    props = {"R": rng}
    forward = _eval('dateBetween(dateStart(prop("R")), dateEnd(prop("R")), "days")', properties=props)
    backward = _eval('dateBetween(dateEnd(prop("R")), dateStart(prop("R")), "days")', properties=props)
    assert forward == -365.0
    assert backward == 365.0
    assert forward == -backward  # reversing the arguments flips the sign -- the exact trap


def test_date_between_rejects_seconds_unit():
    a = Date(start=datetime(2023, 1, 1, tzinfo=timezone.utc))
    b = Date(start=datetime(2023, 1, 2, tzinfo=timezone.utc))
    result = _eval('dateBetween(prop("A"), prop("B"), "seconds")', properties={"A": a, "B": b})
    assert result is EMPTY


def test_date_between_months_and_years_ours():
    a = Date(start=datetime(2024, 3, 1, tzinfo=timezone.utc))
    b = Date(start=datetime(2023, 1, 1, tzinfo=timezone.utc))
    props = {"A": a, "B": b}
    assert _eval('dateBetween(prop("A"), prop("B"), "months")', properties=props) == 14.0
    assert _eval('dateBetween(prop("A"), prop("B"), "years")', properties=props) == 1.0


# ---------------------------------------------------------------------------
# dateRange / dateStart / dateEnd
# ---------------------------------------------------------------------------


def test_date_range_builds_a_date_with_an_end_official_shape():
    start = Date(start=datetime(2022, 9, 7, tzinfo=timezone.utc))
    end = Date(start=datetime(2023, 9, 7, tzinfo=timezone.utc))
    result = _eval('dateRange(prop("S"), prop("E"))', properties={"S": start, "E": end})
    assert result == Date(
        start=datetime(2022, 9, 7, tzinfo=timezone.utc), end=datetime(2023, 9, 7, tzinfo=timezone.utc)
    )
    assert result.end is not None


def test_date_range_format_shows_the_arrow_display_official():
    # research, official: displayed as "@September 7, 2022 -> September 7,
    # 2023" -- this evaluator's format() reuses the same arrow.
    start = Date(start=datetime(2022, 9, 7, 0, 0, tzinfo=timezone.utc))
    end = Date(start=datetime(2023, 9, 7, 0, 0, tzinfo=timezone.utc))
    result = _eval('format(dateRange(prop("S"), prop("E")))', properties={"S": start, "E": end})
    assert result == "September 7, 2022 00:00 → September 7, 2023 00:00"


def test_date_start_and_date_end_project_the_range_back_out():
    rng = Date(
        start=datetime(2022, 9, 7, tzinfo=timezone.utc), end=datetime(2023, 9, 7, tzinfo=timezone.utc)
    )
    props = {"R": rng}
    assert _eval('dateStart(prop("R"))', properties=props) == Date(start=datetime(2022, 9, 7, tzinfo=timezone.utc))
    assert _eval('dateEnd(prop("R"))', properties=props) == Date(start=datetime(2023, 9, 7, tzinfo=timezone.utc))


def test_date_end_of_a_non_ranged_date_returns_its_own_start_ours():
    # brief-uncovered decision (this task's report): a single-instant
    # Date's own start IS its end (degenerate zero-width range), so
    # dateEnd never fails on the same input dateStart always accepts.
    result = _eval('dateEnd(prop("D"))')
    assert result == Date(start=_FIXED_NOW)


# ---------------------------------------------------------------------------
# timestamp / fromTimestamp
# ---------------------------------------------------------------------------


def test_timestamp_is_unix_milliseconds():
    result = _eval('timestamp(prop("D"))')
    assert result == _FIXED_NOW.timestamp() * 1000.0


def test_from_timestamp_truncates_seconds_and_milliseconds_official():
    # research, official, verbatim: "the returned date will not retain
    # the seconds & milliseconds."
    ms = datetime(2023, 8, 30, 17, 55, 42, 123000, tzinfo=timezone.utc).timestamp() * 1000.0
    result = _eval(f"fromTimestamp({ms})")
    assert result.start.second == 0
    assert result.start.microsecond == 0
    assert result.start.minute == 55


def test_to_number_on_date_matches_timestamp_official():
    # research §1.8, official: "toNumber(now()) returns the Unix ms
    # timestamp" -- toNumber and timestamp() must never disagree.
    assert _eval('toNumber(prop("D"))') == _eval('timestamp(prop("D"))')


# ---------------------------------------------------------------------------
# parseDate -- including the UNRESOLVED "garbage" edge inherited from
# Task 25's report
# ---------------------------------------------------------------------------


def test_parse_date_iso_8601_official():
    result = _eval('parseDate("2022-01-01")')
    assert result == Date(start=datetime(2022, 1, 1, tzinfo=timezone.utc))


def test_parse_date_garbage_is_empty_not_a_crash():
    # research §1.9's own UNRESOLVED example, explicitly deferred from
    # Task 25 to this task: "Do not guess... probe a live workspace" --
    # this evaluator stays total (EMPTY), same ruling as every other
    # UNRESOLVED runtime edge in this package.
    assert _eval('parseDate("garbage")') is EMPTY


def test_parse_date_round_trip_with_format_date_official():
    # research §3.6.2: "the documented round-trip is
    # parseDate(formatDate(d, 'YYYY-MM-DD'))."
    result = _eval('parseDate(formatDate(prop("D"), "YYYY-MM-DD"))')
    assert result == Date(start=datetime(2023, 8, 30, tzinfo=timezone.utc))


# ---------------------------------------------------------------------------
# formatDate -- Luxon/Moment tokens
# ---------------------------------------------------------------------------

FORMAT_DATE_CASES = [
    ("bracket_escape_official", '[Month of] MMMM, YYYY', "Month of August, 2023"),  # SOURCED, official
    ("month_day_year__ours", "MMMM D, YYYY", "August 30, 2023"),
    ("padded_numeric__ours", "YYYY-MM-DD", "2023-08-30"),
    ("weekday_name__ours", "dddd", "Wednesday"),
    ("weekday_abbrev__ours", "ddd", "Wed"),
    ("12_hour_meridiem__ours", "h:mm A", "5:55 PM"),
    ("24_hour__ours", "HH:mm", "17:55"),
    ("ordinal_day__ours", "Do", "30th"),
    ("ordinal_day_11th_exception__ours", "Do", "11th"),  # special-cased below (different date)
    ("iso_day_of_week__ours", "E", "3"),
    ("quarter__ours", "Q", "3"),
]  # fmt: skip


@pytest.mark.parametrize(
    "case_id,fmt,expected", FORMAT_DATE_CASES, ids=[c[0] for c in FORMAT_DATE_CASES]
)
def test_format_date_token(case_id, fmt, expected):
    if case_id == "ordinal_day_11th_exception__ours":
        d = Date(start=datetime(2023, 8, 11, tzinfo=timezone.utc))
        result = _eval('formatDate(prop("D"), "Do")', properties={"D": d})
    else:
        result = _eval(f'formatDate(prop("D"), "{fmt}")')
    assert result == expected


def test_format_date_third_argument_timezone_is_accepted_but_ignored():
    # UTC-only decision #3 (module docstring, functions/datetime.py):
    # third arg parses/evaluates but has no effect -- every rendering is
    # UTC regardless of what's passed.
    with_tz = _eval('formatDate(prop("D"), "HH:mm", "America/Chicago")')
    without_tz = _eval('formatDate(prop("D"), "HH:mm")')
    assert with_tz == without_tz == "17:55"


# ---------------------------------------------------------------------------
# id() with no argument -- needs EvalContext.page_id, not a REGISTRY read
# ---------------------------------------------------------------------------


def test_bare_id_with_no_page_id_in_context_is_empty():
    assert _eval("id()") is EMPTY


def test_bare_id_reads_context_page_id_without_dashes():
    result = _eval("id()", page_id="c5d67d15-8547-4486-9cc4-a062fb7b1377")
    assert result == "c5d67d15854744869cc4a062fb7b1377"
