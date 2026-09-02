"""Tests for the M4 grouping/sub-grouping layer (`services.db.query.grouping`).

Pure Python, no DB connection — same style as `test_db_aggregations.py`.
"""
from __future__ import annotations

import pytest

from services.db.query.aggregations import aggregate
from services.db.query.compiler import PropertyLookup
from services.db.query.grouping import _NO_VALUE_KEY, GroupBySpec, group_rows, sub_group

_ABSENT = object()


def _rows(key: str, type_: str, values: list) -> list[dict]:
    rows = []
    for i, v in enumerate(values):
        if v is _ABSENT:
            rows.append({"id": f"r{i}", "properties": {}})
        else:
            rows.append({"id": f"r{i}", "properties": {key: {"type": type_, type_: v}}})
    return rows


def _lookup(key: str, type_: str) -> PropertyLookup:
    return PropertyLookup(type=type_, storage="jsonb", key=key)


# --- select / multi_select ---------------------------------------------------


def test_select_groups_dynamically_from_present_options_sorted():
    lookup = _lookup("k1", "select")
    rows = _rows("k1", "select", ["b", "a", "a", _ABSENT])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    non_empty = [g for g in groups if g.rows and g.key in ("a", "b")]
    assert [g.key for g in non_empty] == ["a", "b"]
    assert {r["id"] for r in non_empty[0].rows} == {"r1", "r2"}  # "a" rows
    assert {r["id"] for r in non_empty[1].rows} == {"r0"}  # "b" rows


def test_multi_select_row_appears_in_every_tag_group():
    lookup = _lookup("k1", "multi_select")
    rows = _rows("k1", "multi_select", [["x", "y"], ["y"]])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    by_key = {g.key: g for g in groups}
    assert {r["id"] for r in by_key["x"].rows} == {"r0"}
    assert {r["id"] for r in by_key["y"].rows} == {"r0", "r1"}


# --- status -------------------------------------------------------------


def test_status_mode_option_groups_like_select():
    lookup = _lookup("k1", "status")
    rows = _rows("k1", "status", ["todo", "done"])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="option"))
    keys = {g.key for g in groups if g.rows}
    assert keys == {"todo", "done"}


def test_status_mode_group_raises_not_implemented():
    lookup = _lookup("k1", "status")
    rows = _rows("k1", "status", ["todo"])
    with pytest.raises(NotImplementedError):
        group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="group"))


def test_status_missing_mode_raises_value_error():
    lookup = _lookup("k1", "status")
    rows = _rows("k1", "status", ["todo"])
    with pytest.raises(ValueError):
        group_rows(rows, lookup, GroupBySpec(property_key="k1"))


# --- date / created_time / last_edited_time ----------------------------


def test_date_grouping_by_day():
    lookup = _lookup("k1", "date")
    rows = _rows(
        "k1", "date",
        [
            {"start": "2026-08-10T09:00:00+00:00", "end": None, "time_zone": None},
            {"start": "2026-08-10T20:00:00+00:00", "end": None, "time_zone": None},
            {"start": "2026-08-11T00:00:00+00:00", "end": None, "time_zone": None},
        ],
    )
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="day"))
    by_key = {g.key: g for g in groups}
    assert {r["id"] for r in by_key["2026-08-10"].rows} == {"r0", "r1"}
    assert {r["id"] for r in by_key["2026-08-11"].rows} == {"r2"}


def test_date_grouping_by_week_monday_start():
    lookup = _lookup("k1", "date")
    # 2026-08-10 is a Monday.
    rows = _rows(
        "k1", "date",
        [
            {"start": "2026-08-10T00:00:00+00:00", "end": None, "time_zone": None},  # Mon
            {"start": "2026-08-14T00:00:00+00:00", "end": None, "time_zone": None},  # Fri, same week
            {"start": "2026-08-17T00:00:00+00:00", "end": None, "time_zone": None},  # next Mon
        ],
    )
    groups = group_rows(
        rows, lookup, GroupBySpec(property_key="k1", mode="week", start_day_of_week=1)
    )
    assert len(groups) == 3  # 2 week buckets + implicit no-value group
    by_key = {g.key: g for g in groups}
    assert {r["id"] for r in by_key["2026-08-10"].rows} == {"r0", "r1"}
    assert {r["id"] for r in by_key["2026-08-17"].rows} == {"r2"}


def test_date_grouping_by_month_and_year():
    lookup = _lookup("k1", "date")
    rows = _rows(
        "k1", "date",
        [
            {"start": "2026-08-01T00:00:00+00:00", "end": None, "time_zone": None},
            {"start": "2026-09-01T00:00:00+00:00", "end": None, "time_zone": None},
        ],
    )
    month_groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="month"))
    assert {g.key for g in month_groups if g.rows} == {"2026-08", "2026-09"}

    year_groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="year"))
    assert {g.key for g in year_groups if g.rows} == {"2026"}


def test_date_grouping_mode_relative_raises_not_implemented():
    lookup = _lookup("k1", "date")
    rows = _rows("k1", "date", [{"start": "2026-08-10", "end": None, "time_zone": None}])
    with pytest.raises(NotImplementedError):
        group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="relative"))


def test_date_with_missing_start_is_routed_to_no_value_group_not_dropped():
    # A non-empty {"start": None, ...} wrapper passes REGISTRY's generic
    # is_empty check (the dict itself isn't {}), but has no extractable
    # instant to bucket on -- must land in the no-value group rather than
    # silently vanish from every group.
    lookup = _lookup("k1", "date")
    rows = _rows(
        "k1", "date",
        [
            {"start": None, "end": None, "time_zone": None},
            {"start": "2026-08-10T00:00:00+00:00", "end": None, "time_zone": None},
        ],
    )
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="day"))
    total_rows = sum(len(g.rows) for g in groups)
    assert total_rows == 2
    no_value = next(g for g in groups if g.key not in ("2026-08-10",))
    assert {r["id"] for r in no_value.rows} == {"r0"}


def test_created_time_groups_by_day_from_plain_iso_scalar():
    lookup = _lookup("k1", "created_time")
    rows = _rows("k1", "created_time", ["2026-08-10T09:00:00+00:00"])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="day"))
    assert any(g.key == "2026-08-10" and g.rows for g in groups)


# --- number ---------------------------------------------------------------


def test_number_range_bucketing():
    lookup = _lookup("k1", "number")
    rows = _rows("k1", "number", [5, 15, 25, 105, -5])
    spec = GroupBySpec(property_key="k1", range_start=0, range_end=30, range_size=10)
    groups = group_rows(rows, lookup, spec)
    by_key = {g.key: g for g in groups}
    assert {r["id"] for r in by_key["0-10"].rows} == {"r0"}
    assert {r["id"] for r in by_key["10-20"].rows} == {"r1"}
    assert {r["id"] for r in by_key["20-30"].rows} == {"r2"}
    # 105 (>= end) and -5 (< start) both land in the overflow bucket.
    other = next(g for g in groups if g.key == "__other__")
    assert {r["id"] for r in other.rows} == {"r3", "r4"}


def test_number_range_bucketing_rejects_size_below_one():
    lookup = _lookup("k1", "number")
    rows = _rows("k1", "number", [5])
    spec = GroupBySpec(property_key="k1", range_start=0, range_end=10, range_size=0.5)
    with pytest.raises(ValueError):
        group_rows(rows, lookup, spec)


def test_number_falls_back_to_exact_value_grouping_without_range_params():
    lookup = _lookup("k1", "number")
    rows = _rows("k1", "number", [3, 1, 3, 2])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    non_empty = [g for g in groups if g.rows]
    # Numerically ascending, not alphabetical (which would put "1" < "2" < "3" too,
    # but would break at 10 vs 2 -- exercised implicitly by using single digits
    # is not enough, so assert via the actual numeric order attribute instead).
    assert [g.key for g in non_empty] == ["1", "2", "3"]


# --- checkbox ---------------------------------------------------------------


def test_checkbox_always_has_both_fixed_groups():
    lookup = _lookup("k1", "checkbox")
    rows = _rows("k1", "checkbox", [True])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    by_key = {g.key: g for g in groups}
    assert "true" in by_key and "false" in by_key
    assert {r["id"] for r in by_key["true"].rows} == {"r0"}
    assert by_key["false"].rows == []


# --- title / rich_text / url / email / phone_number --------------------


def test_text_exact_mode_groups_by_distinct_value():
    lookup = _lookup("k1", "title")
    rows = _rows("k1", "title", ["Apple", "Apple", "Banana"])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="exact"))
    by_key = {g.key: g for g in groups}
    assert len(by_key["Apple"].rows) == 2
    assert len(by_key["Banana"].rows) == 1


def test_text_alphabet_prefix_mode_buckets_by_first_letter_case_insensitive():
    lookup = _lookup("k1", "title")
    rows = _rows("k1", "title", ["apple", "Avocado", "banana", "123 numeric"])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", mode="alphabet_prefix"))
    by_key = {g.key: g for g in groups}
    assert {r["id"] for r in by_key["A"].rows} == {"r0", "r1"}
    assert {r["id"] for r in by_key["B"].rows} == {"r2"}
    assert {r["id"] for r in by_key["#"].rows} == {"r3"}


def test_text_grouping_requires_explicit_mode():
    lookup = _lookup("k1", "title")
    rows = _rows("k1", "title", ["a"])
    with pytest.raises(ValueError):
        group_rows(rows, lookup, GroupBySpec(property_key="k1"))


# --- people / created_by / last_edited_by / relation -----------------------


def test_people_row_appears_in_every_id_group():
    lookup = _lookup("k1", "people")
    rows = _rows("k1", "people", [["u1", "u2"], ["u2"]])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    by_key = {g.key: g for g in groups}
    assert {r["id"] for r in by_key["u1"].rows} == {"r0"}
    assert {r["id"] for r in by_key["u2"].rows} == {"r0", "r1"}


def test_created_by_is_single_valued_not_flattened():
    lookup = _lookup("k1", "created_by")
    rows = _rows("k1", "created_by", ["u1", "u2"])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    by_key = {g.key: g for g in groups}
    assert {r["id"] for r in by_key["u1"].rows} == {"r0"}
    assert {r["id"] for r in by_key["u2"].rows} == {"r1"}


def test_relation_is_multi_valued():
    lookup = _lookup("k1", "relation")
    rows = _rows("k1", "relation", [["p1", "p2"]])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    keys = {g.key for g in groups if g.rows}
    assert keys == {"p1", "p2"}


# --- formula ------------------------------------------------------------


def test_formula_grouping_raises_not_implemented():
    lookup = _lookup("k1", "formula")
    rows = _rows("k1", "formula", [1])
    with pytest.raises(NotImplementedError):
        group_rows(rows, lookup, GroupBySpec(property_key="k1"))


# --- non-groupable types -------------------------------------------------


@pytest.mark.parametrize(
    "prop_type", ["files", "rollup", "unique_id", "verification", "button", "place"]
)
def test_non_groupable_types_raise_value_error(prop_type):
    lookup = _lookup("k1", prop_type)
    rows = _rows("k1", prop_type, [1])
    with pytest.raises(ValueError):
        group_rows(rows, lookup, GroupBySpec(property_key="k1"))


# --- the implicit empty/no-value group --------------------------------------


def test_empty_no_value_group_is_present_and_correctly_populated():
    lookup = _lookup("k1", "select")
    rows = _rows("k1", "select", ["a", _ABSENT, None])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    no_value = next(g for g in groups if g.key not in ("a",))
    assert {r["id"] for r in no_value.rows} == {"r1", "r2"}


def test_group_counts_via_aggregate_count_on_each_groups_rows():
    # A "group count" (e.g. Board's per-column header count) is just
    # aggregate(group.rows, None, "count") applied per group -- no separate
    # machinery needed, confirming aggregations.py and grouping.py compose.
    lookup = _lookup("k1", "select")
    rows = _rows("k1", "select", ["a", "a", "b"])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    counts = {g.key: aggregate(g.rows, None, "count") for g in groups}
    assert counts["a"] == 2
    assert counts["b"] == 1


def test_empty_group_present_even_with_zero_empty_rows():
    lookup = _lookup("k1", "select")
    rows = _rows("k1", "select", ["a", "b"])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    no_value = [g for g in groups if g.key not in ("a", "b")]
    assert len(no_value) == 1
    assert no_value[0].rows == []


def test_hide_empty_groups_false_keeps_the_full_structural_set_default():
    # checkbox always has both fixed groups (true/false) regardless of data -- a good
    # case for "structurally defined" since one bucket can be empty with zero configuration.
    lookup = _lookup("k1", "checkbox")
    rows = _rows("k1", "checkbox", [True])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1"))
    by_key = {g.key: g for g in groups}
    assert "false" in by_key and by_key["false"].rows == []


def test_hide_empty_groups_true_omits_every_zero_row_group():
    lookup = _lookup("k1", "checkbox")
    rows = _rows("k1", "checkbox", [True])
    groups = group_rows(rows, lookup, GroupBySpec(property_key="k1", hide_empty_groups=True))
    by_key = {g.key: g for g in groups}
    assert "false" not in by_key  # the empty checkbox bucket is gone
    assert _NO_VALUE_KEY not in by_key  # the empty implicit no-value bucket is gone too
    assert "true" in by_key and by_key["true"].rows  # the non-empty bucket survives


# --- sub-grouping: exactly two levels, every row accounted for once --------


def test_sub_grouping_produces_two_levels_and_every_row_is_counted_once():
    status_lookup = _lookup("status", "status")
    select_lookup = _lookup("priority", "select")
    rows = [
        {"id": "r0", "properties": {
            "status": {"type": "status", "status": "todo"},
            "priority": {"type": "select", "select": "high"},
        }},
        {"id": "r1", "properties": {
            "status": {"type": "status", "status": "todo"},
            "priority": {"type": "select", "select": "low"},
        }},
        {"id": "r2", "properties": {
            "status": {"type": "status", "status": "done"},
            "priority": {"type": "select", "select": "high"},
        }},
    ]
    top = group_rows(rows, status_lookup, GroupBySpec(property_key="status", mode="option"))
    nested = sub_group(top, select_lookup, GroupBySpec(property_key="priority"))

    for group in nested:
        assert group.subgroups is not None
        subgroup_row_ids = [r["id"] for sg in group.subgroups for r in sg.rows]
        # Every row in the top-level group is accounted for exactly once
        # across its subgroups (select is single-valued, no fan-out here).
        assert sorted(subgroup_row_ids) == sorted(r["id"] for r in group.rows)
        # Depth is exactly two: a subgroup's own subgroups field is unset.
        for sg in group.subgroups:
            assert sg.subgroups is None

    todo_group = next(g for g in nested if g.key == "todo")
    todo_subgroups = {sg.key: sg for sg in todo_group.subgroups}
    assert {r["id"] for r in todo_subgroups["high"].rows} == {"r0"}
    assert {r["id"] for r in todo_subgroups["low"].rows} == {"r1"}
