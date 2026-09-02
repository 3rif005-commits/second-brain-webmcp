"""Tests for the M4 aggregation layer (`services.db.query.aggregations`).

Pure Python, no DB connection — `aggregate()` operates on the already-fetched
`{"id", "properties"}` row shape `services/db/query/builder.py`'s `build()`
output produces, same style as `test_db_operators.py`.
"""
from __future__ import annotations

import pytest

from services.db.query.aggregations import aggregate
from services.db.query.compiler import PropertyLookup


def _rows(key: str, type_: str, values: list) -> list[dict]:
    """`values` entries are raw (unwrapped) values; `None` means the
    property is entirely absent from the row (not merely an empty wrapper),
    matching how a row with no `db_row_props.properties` entry for a key
    actually looks."""
    rows = []
    for v in values:
        if v is _ABSENT:
            rows.append({"id": "x", "properties": {}})
        else:
            rows.append({"id": "x", "properties": {key: {"type": type_, type_: v}}})
    return rows


_ABSENT = object()


def _lookup(key: str, type_: str) -> PropertyLookup:
    return PropertyLookup(type=type_, storage="jsonb", key=key)


# --- count: the one property-independent aggregate --------------------------


def test_count_does_not_require_a_lookup():
    rows = [{"id": "a", "properties": {}}, {"id": "b", "properties": {}}]
    assert aggregate(rows, None, "count") == 2


def test_count_of_empty_row_list_is_zero():
    assert aggregate([], None, "count") == 0


def test_every_aggregator_except_count_requires_a_lookup():
    with pytest.raises(ValueError):
        aggregate([], None, "sum")


# --- number: sum/average/median/min/max/range -------------------------------


def test_number_aggregates_over_populated_set():
    lookup = _lookup("k1", "number")
    rows = _rows("k1", "number", [10, 20, 30, _ABSENT, None])
    assert aggregate(rows, lookup, "sum") == 60
    assert aggregate(rows, lookup, "average") == 20
    assert aggregate(rows, lookup, "median") == 20
    assert aggregate(rows, lookup, "min") == 10
    assert aggregate(rows, lookup, "max") == 30
    assert aggregate(rows, lookup, "range") == 20


def test_number_aggregates_skip_absent_and_none_not_treat_as_zero():
    lookup = _lookup("k1", "number")
    rows = _rows("k1", "number", [5, _ABSENT])
    # If an absent cell were treated as 0, sum would be 5 too (coincidence-proof
    # via average, which would be 2.5 instead of 5).
    assert aggregate(rows, lookup, "average") == 5


def test_number_aggregates_empty_set_results():
    lookup = _lookup("k1", "number")
    rows = _rows("k1", "number", [_ABSENT, None])
    assert aggregate(rows, lookup, "sum") == 0
    assert aggregate(rows, lookup, "average") is None
    assert aggregate(rows, lookup, "median") is None
    assert aggregate(rows, lookup, "min") is None
    assert aggregate(rows, lookup, "max") is None
    assert aggregate(rows, lookup, "range") is None


def test_number_aggregates_zero_rows():
    lookup = _lookup("k1", "number")
    assert aggregate([], lookup, "sum") == 0
    assert aggregate([], lookup, "average") is None
    assert aggregate([], lookup, "range") is None


@pytest.mark.parametrize("aggregator", ["sum", "average", "median", "min", "max", "range"])
def test_numeric_aggregators_reject_non_number_type(aggregator):
    # research restricts these to Number only; unique_id is explicitly
    # out of scope even though it's also numeric.
    lookup = _lookup("k1", "unique_id")
    rows = _rows("k1", "unique_id", [1, 2, 3])
    with pytest.raises(ValueError):
        aggregate(rows, lookup, aggregator)


# --- count_values / unique: multi_select tag-vs-cell distinction ------------


def test_multi_select_count_values_counts_individual_tags_not_cells():
    lookup = _lookup("k1", "multi_select")
    rows = _rows("k1", "multi_select", [["a", "b"], ["b"], []])
    # 3 non-empty... wait: third row is [] which IS empty (is_empty([])==True).
    assert aggregate(rows, lookup, "count_values") == 3  # "a","b" + "b" = 3 tags


def test_multi_select_unique_is_the_distinct_flattened_tag_count():
    lookup = _lookup("k1", "multi_select")
    rows = _rows("k1", "multi_select", [["a", "b"], ["b", "c"]])
    assert aggregate(rows, lookup, "unique") == 3  # {"a","b","c"}


def test_other_types_count_values_and_unique_operate_on_whole_cells():
    lookup = _lookup("k1", "select")
    rows = _rows("k1", "select", ["a", "a", "b", _ABSENT])
    assert aggregate(rows, lookup, "count_values") == 3
    assert aggregate(rows, lookup, "unique") == 2


# --- empty / not_empty / percent_empty / percent_not_empty ------------------


def test_empty_and_not_empty_counts():
    lookup = _lookup("k1", "rich_text")
    rows = _rows("k1", "rich_text", ["x", "", _ABSENT, "y"])
    assert aggregate(rows, lookup, "empty") == 2
    assert aggregate(rows, lookup, "not_empty") == 2


def test_percent_empty_and_percent_not_empty_are_row_percentages():
    lookup = _lookup("k1", "rich_text")
    rows = _rows("k1", "rich_text", ["x", "", _ABSENT, "y"])
    assert aggregate(rows, lookup, "percent_empty") == 50.0
    assert aggregate(rows, lookup, "percent_not_empty") == 50.0


def test_percent_empty_division_by_zero_is_none_not_an_exception():
    lookup = _lookup("k1", "rich_text")
    assert aggregate([], lookup, "percent_empty") is None
    assert aggregate([], lookup, "percent_not_empty") is None


def test_count_values_empty_unique_empty_not_empty_all_zero_on_empty_set():
    lookup = _lookup("k1", "rich_text")
    assert aggregate([], lookup, "count_values") == 0
    assert aggregate([], lookup, "unique") == 0
    assert aggregate([], lookup, "empty") == 0
    assert aggregate([], lookup, "not_empty") == 0


# --- checkbox -----------------------------------------------------------


def test_checkbox_checked_unchecked_counts():
    lookup = _lookup("k1", "checkbox")
    rows = _rows("k1", "checkbox", [True, True, False])
    assert aggregate(rows, lookup, "checked") == 2
    assert aggregate(rows, lookup, "unchecked") == 1


def test_checkbox_percent_checked_and_unchecked():
    lookup = _lookup("k1", "checkbox")
    rows = _rows("k1", "checkbox", [True, True, False, False])
    assert aggregate(rows, lookup, "percent_checked") == 50.0
    assert aggregate(rows, lookup, "percent_unchecked") == 50.0


def test_checkbox_empty_set_results():
    lookup = _lookup("k1", "checkbox")
    assert aggregate([], lookup, "checked") == 0
    assert aggregate([], lookup, "unchecked") == 0
    assert aggregate([], lookup, "percent_checked") is None
    assert aggregate([], lookup, "percent_unchecked") is None


@pytest.mark.parametrize("aggregator", ["checked", "unchecked", "percent_checked", "percent_unchecked"])
def test_checkbox_aggregators_reject_non_checkbox_type(aggregator):
    lookup = _lookup("k1", "select")
    rows = _rows("k1", "select", ["a"])
    with pytest.raises(ValueError):
        aggregate(rows, lookup, aggregator)


# --- date-ish: earliest_date / latest_date / date_range ----------------------


def test_date_aggregates_over_populated_set():
    lookup = _lookup("k1", "date")
    rows = _rows(
        "k1", "date",
        [
            {"start": "2026-08-01", "end": None, "time_zone": None},
            {"start": "2026-08-10", "end": None, "time_zone": None},
            _ABSENT,
        ],
    )
    assert aggregate(rows, lookup, "earliest_date") == "2026-08-01"
    assert aggregate(rows, lookup, "latest_date") == "2026-08-10"
    assert aggregate(rows, lookup, "date_range") == 9.0


def test_created_time_aggregates_plain_iso_scalar_not_an_object():
    lookup = _lookup("k1", "created_time")
    rows = _rows(
        "k1", "created_time",
        ["2026-08-01T00:00:00+00:00", "2026-08-03T12:00:00+00:00"],
    )
    assert aggregate(rows, lookup, "earliest_date") == "2026-08-01T00:00:00+00:00"
    assert aggregate(rows, lookup, "latest_date") == "2026-08-03T12:00:00+00:00"
    assert aggregate(rows, lookup, "date_range") == 2.5


def test_date_aggregates_empty_set_results():
    lookup = _lookup("k1", "date")
    assert aggregate([], lookup, "earliest_date") is None
    assert aggregate([], lookup, "latest_date") is None
    assert aggregate([], lookup, "date_range") is None
    rows = _rows("k1", "date", [_ABSENT])
    assert aggregate(rows, lookup, "earliest_date") is None


@pytest.mark.parametrize("aggregator", ["earliest_date", "latest_date", "date_range"])
def test_date_aggregators_reject_non_date_type(aggregator):
    lookup = _lookup("k1", "select")
    rows = _rows("k1", "select", ["a"])
    with pytest.raises(ValueError):
        aggregate(rows, lookup, aggregator)


def test_unknown_aggregator_raises():
    lookup = _lookup("k1", "number")
    with pytest.raises(ValueError):
        aggregate([], lookup, "bogus")
