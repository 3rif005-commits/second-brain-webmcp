"""Tests for services/db/relations.py's §1.7 pure date-shift functions:
`next_weekday`, `shift_window`, `resolve_shift`. Pure Python -- no DB
connection (services.db.relations.cascade_dependency_shift, the DB-backed
orchestration layer built on top of these, is covered by
tests/test_db_relations.py instead).

Research: docs/research/notion-databases-research.md §4.4, quoted verbatim
in the module docstring/comments these tests check against.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from services.db.relations import (
    DATE_SHIFT_MODES,
    SHIFT_MAINTAIN_GAP,
    SHIFT_NEVER,
    SHIFT_WHEN_OVERLAP,
    DateWindow,
    next_weekday,
    resolve_shift,
    shift_window,
)


def _dt(y, m, d, hh=0, mm=0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Mode name constants: the plan's test case checks these "by their real
# names" -- a slug mapping is one more place for them to drift.
# ---------------------------------------------------------------------------


def test_shift_mode_constants_match_notions_real_names_verbatim():
    assert SHIFT_WHEN_OVERLAP == "Shift only when dates overlap"
    assert SHIFT_MAINTAIN_GAP == "Shift & maintain time between items"
    assert SHIFT_NEVER == "Do not automatically shift"
    assert DATE_SHIFT_MODES == (SHIFT_WHEN_OVERLAP, SHIFT_MAINTAIN_GAP, SHIFT_NEVER)


# ---------------------------------------------------------------------------
# next_weekday
# ---------------------------------------------------------------------------


def test_next_weekday_weekday_passes_through_unchanged():
    monday = _dt(2026, 8, 17, 9, 30)  # a Monday
    assert monday.weekday() == 0
    assert next_weekday(monday) == monday

    friday = _dt(2026, 8, 21, 9, 30)
    assert friday.weekday() == 4
    assert next_weekday(friday) == friday


def test_next_weekday_saturday_moves_to_monday_preserving_time():
    saturday = _dt(2026, 8, 22, 14, 15)
    assert saturday.weekday() == 5
    result = next_weekday(saturday)
    assert result == _dt(2026, 8, 24, 14, 15)
    assert result.weekday() == 0


def test_next_weekday_sunday_moves_to_monday_preserving_time():
    sunday = _dt(2026, 8, 23, 14, 15)
    assert sunday.weekday() == 6
    result = next_weekday(sunday)
    assert result == _dt(2026, 8, 24, 14, 15)
    assert result.weekday() == 0


# ---------------------------------------------------------------------------
# shift_window
# ---------------------------------------------------------------------------


def test_shift_window_translates_start_and_end_rigidly():
    w = DateWindow(start=_dt(2026, 8, 10), end=_dt(2026, 8, 12))
    shifted = shift_window(w, timedelta(days=7), avoid_weekends=False)
    assert shifted.start == _dt(2026, 8, 17)
    assert shifted.end == _dt(2026, 8, 19)


def test_shift_window_none_end_stays_none():
    w = DateWindow(start=_dt(2026, 8, 10), end=None)
    shifted = shift_window(w, timedelta(days=3), avoid_weekends=False)
    assert shifted.start == _dt(2026, 8, 13)
    assert shifted.end is None


def test_shift_window_avoid_weekends_nudges_both_endpoints_independently():
    # start lands on Saturday 8/22, end lands on Tuesday 8/25 -- only start
    # should be nudged; the duration is NOT re-flowed to compensate.
    w = DateWindow(start=_dt(2026, 8, 15), end=_dt(2026, 8, 18))  # Sat -> Tue, +7d
    shifted = shift_window(w, timedelta(days=7), avoid_weekends=True)
    assert shifted.start == _dt(2026, 8, 24)  # nudged Sat 8/22 -> Mon 8/24
    assert shifted.end == _dt(2026, 8, 25)  # Tue 8/25, untouched


def test_shift_window_avoid_weekends_false_leaves_weekend_dates_alone():
    w = DateWindow(start=_dt(2026, 8, 15))  # -> Sat 8/22 after +7d
    shifted = shift_window(w, timedelta(days=7), avoid_weekends=False)
    assert shifted.start == _dt(2026, 8, 22)
    assert shifted.start.weekday() == 5


def test_shift_window_does_not_touch_a_window_when_delta_is_zero_but_still_nudges_weekend_landing():
    # A zero delta still routes through the same nudge logic if the
    # window's own start/end happens to sit on a weekend -- shift_window
    # itself has no "was this window actually shifted" concept; that
    # distinction belongs to resolve_shift (a zero-overlap window it
    # decides NOT to touch returns None instead of calling shift_window at
    # all -- see the SHIFT_WHEN_OVERLAP no-overlap test below).
    w = DateWindow(start=_dt(2026, 8, 22))  # already a Saturday
    shifted = shift_window(w, timedelta(0), avoid_weekends=True)
    assert shifted.start == _dt(2026, 8, 24)


# ---------------------------------------------------------------------------
# resolve_shift -- SHIFT_NEVER
# ---------------------------------------------------------------------------


def test_resolve_shift_never_always_returns_none():
    blocker = DateWindow(start=_dt(2026, 8, 10), end=_dt(2026, 8, 12))
    blocked = DateWindow(start=_dt(2026, 8, 5), end=_dt(2026, 8, 6))
    result = resolve_shift(
        blocker, blocked, SHIFT_NEVER, avoid_weekends=False, blocker_delta=timedelta(days=7)
    )
    assert result is None


# ---------------------------------------------------------------------------
# resolve_shift -- SHIFT_MAINTAIN_GAP: "If task A is blocking task B and the
# due date of task A is shifted forward one week, the due date of B will
# also shift forward one week."
# ---------------------------------------------------------------------------


def test_resolve_shift_maintain_gap_translates_rigidly_by_blockers_delta():
    blocker = DateWindow(start=_dt(2026, 8, 17), end=_dt(2026, 8, 19))  # A's new position
    blocked = DateWindow(start=_dt(2026, 8, 24), end=_dt(2026, 8, 26))  # B, far ahead of A
    result = resolve_shift(
        blocker, blocked, SHIFT_MAINTAIN_GAP, avoid_weekends=False,
        blocker_delta=timedelta(days=7),
    )
    assert result == DateWindow(start=_dt(2026, 8, 31), end=_dt(2026, 9, 2))


def test_resolve_shift_maintain_gap_applies_avoid_weekends():
    blocker = DateWindow(start=_dt(2026, 8, 17))
    blocked = DateWindow(start=_dt(2026, 8, 15))  # -> Sat 8/22 after +7d
    result = resolve_shift(
        blocker, blocked, SHIFT_MAINTAIN_GAP, avoid_weekends=True,
        blocker_delta=timedelta(days=7),
    )
    assert result.start == _dt(2026, 8, 24)


# ---------------------------------------------------------------------------
# resolve_shift -- SHIFT_WHEN_OVERLAP: "Tasks will only be shifted when
# their dates start to overlap. The distance between tasks may still be
# decreased."
# ---------------------------------------------------------------------------


def test_resolve_shift_when_overlap_leaves_non_overlapping_pair_alone():
    blocker = DateWindow(start=_dt(2026, 8, 10), end=_dt(2026, 8, 12))
    blocked = DateWindow(start=_dt(2026, 8, 20), end=_dt(2026, 8, 22))  # starts after blocker ends
    result = resolve_shift(
        blocker, blocked, SHIFT_WHEN_OVERLAP, avoid_weekends=False,
        blocker_delta=timedelta(days=7),
    )
    assert result is None


def test_resolve_shift_when_overlap_shrinks_the_gap_in_the_overlapping_case():
    # blocker now ends 8/19; blocked starts 8/15 -- an overlap. B moves
    # forward by exactly (blocker.end - blocked.start) = 4 days, not by
    # A's full 7-day delta -- the gap between them shrinks from -4 (they
    # overlapped by 4 days) to 0 (they now abut).
    blocker = DateWindow(start=_dt(2026, 8, 17), end=_dt(2026, 8, 19))
    blocked = DateWindow(start=_dt(2026, 8, 15), end=_dt(2026, 8, 16))
    result = resolve_shift(
        blocker, blocked, SHIFT_WHEN_OVERLAP, avoid_weekends=False,
        blocker_delta=timedelta(days=7),
    )
    assert result == DateWindow(start=_dt(2026, 8, 19), end=_dt(2026, 8, 20))


def test_resolve_shift_when_overlap_boundary_touching_is_not_overlap():
    # blocked.start == blocker.end exactly -- "start to overlap" is a
    # strict inequality (blocked.start >= blocker_end -> no shift).
    blocker = DateWindow(start=_dt(2026, 8, 10), end=_dt(2026, 8, 15))
    blocked = DateWindow(start=_dt(2026, 8, 15), end=_dt(2026, 8, 16))
    result = resolve_shift(
        blocker, blocked, SHIFT_WHEN_OVERLAP, avoid_weekends=False,
        blocker_delta=timedelta(days=1),
    )
    assert result is None


def test_resolve_shift_when_overlap_treats_none_end_as_single_instant():
    # blocker has no `end` -- treated as end == start.
    blocker = DateWindow(start=_dt(2026, 8, 17), end=None)
    blocked = DateWindow(start=_dt(2026, 8, 15), end=_dt(2026, 8, 16))
    result = resolve_shift(
        blocker, blocked, SHIFT_WHEN_OVERLAP, avoid_weekends=False,
        blocker_delta=timedelta(days=2),
    )
    assert result.start == _dt(2026, 8, 17)  # 8/17 - 8/15 == 2-day shift
    assert result.end == _dt(2026, 8, 18)


def test_resolve_shift_when_overlap_applies_avoid_weekends():
    # In the overlap branch, blocked's new start always lands exactly on
    # blocker_end (that's what "abut" means) -- put blocker_end itself on
    # a Saturday so the nudge has something to do.
    blocker = DateWindow(start=_dt(2026, 8, 17), end=_dt(2026, 8, 22))  # Saturday
    blocked = DateWindow(start=_dt(2026, 8, 20))  # overlaps (20 < blocker_end 22)
    result = resolve_shift(
        blocker, blocked, SHIFT_WHEN_OVERLAP, avoid_weekends=True,
        blocker_delta=timedelta(days=7),
    )
    assert result.start == _dt(2026, 8, 24)  # nudged off Saturday to Monday


def test_resolve_shift_unknown_mode_raises():
    blocker = DateWindow(start=_dt(2026, 8, 10))
    blocked = DateWindow(start=_dt(2026, 8, 5))
    with pytest.raises(ValueError):
        resolve_shift(
            blocker, blocked, "Some Unknown Mode", avoid_weekends=False,
            blocker_delta=timedelta(days=1),
        )
