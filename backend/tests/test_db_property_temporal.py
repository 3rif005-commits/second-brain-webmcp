"""Milestone 5 (task-14-brief.md §3): Date, CreatedTime, LastEditedTime."""
from __future__ import annotations

import pytest

from services.db.properties.base import REGISTRY, SqlContext, _GenericProperty
from services.db.properties.temporal import CreatedTime, Date, DateConfig, LastEditedTime


# ---------------------------------------------------------------------------
# Date
# ---------------------------------------------------------------------------

def test_date_default_and_is_empty():
    d = Date()
    assert d.default() is None
    assert d.is_empty(None) is True
    assert d.is_empty({}) is True
    assert d.is_empty({"start": "2026-01-01"}) is False


def test_date_config_forbids_extra_fields():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        DateConfig(foo="bar")


def test_date_coerce_write_none_is_valid():
    assert Date().coerce_write(None) is None


def test_date_coerce_write_accepts_start_only():
    value = {"start": "2026-08-10"}
    assert Date().coerce_write(value) == value


def test_date_coerce_write_accepts_datetime_start():
    value = {"start": "2026-08-10T12:00:00Z"}
    assert Date().coerce_write(value) == value


def test_date_coerce_write_accepts_start_end_time_zone():
    value = {"start": "2026-08-10", "end": "2026-08-12", "time_zone": "America/New_York"}
    assert Date().coerce_write(value) == value


def test_date_coerce_write_requires_start():
    with pytest.raises(ValueError):
        Date().coerce_write({"end": "2026-08-12"})
    with pytest.raises(ValueError):
        Date().coerce_write({})


def test_date_coerce_write_rejects_null_start():
    with pytest.raises(ValueError):
        Date().coerce_write({"start": None})


def test_date_coerce_write_rejects_non_dict():
    with pytest.raises(ValueError):
        Date().coerce_write("2026-08-10")
    with pytest.raises(ValueError):
        Date().coerce_write(["2026-08-10"])


def test_date_coerce_write_rejects_extra_keys():
    with pytest.raises(ValueError):
        Date().coerce_write({"start": "2026-08-10", "color": "red"})


def test_date_coerce_write_rejects_malformed_start():
    with pytest.raises(ValueError):
        Date().coerce_write({"start": "not-a-date"})


def test_date_coerce_write_rejects_inverted_range():
    with pytest.raises(ValueError):
        Date().coerce_write({"start": "2026-08-12", "end": "2026-08-10"})


def test_date_coerce_write_accepts_equal_start_and_end():
    value = {"start": "2026-08-10", "end": "2026-08-10"}
    assert Date().coerce_write(value) == value


def test_date_coerce_write_rejects_malformed_end():
    with pytest.raises(ValueError):
        Date().coerce_write({"start": "2026-08-10", "end": "not-a-date"})


def test_date_coerce_write_accepts_mixed_naive_and_aware_start_and_end():
    # A bare date-only `start` (naive once parsed) alongside a `end` that
    # carries an explicit UTC offset (aware) — exactly what a date-only
    # picker for `start` plus a full timestamp for `end` would produce.
    # Regression: this used to raise a bare TypeError ("can't compare
    # offset-naive and offset-aware datetimes") instead of the ValueError
    # coerce_write promises on bad input, because the naive value was never
    # normalised to UTC before the start<=end comparison.
    value = {"start": "2026-08-10", "end": "2026-08-11T00:00:00+05:00"}
    assert Date().coerce_write(value) == value


def test_date_coerce_write_rejects_inverted_range_with_mixed_awareness():
    with pytest.raises(ValueError):
        Date().coerce_write({"start": "2026-08-12", "end": "2026-08-10T00:00:00+05:00"})


def test_date_coerce_write_rejects_bad_timezone():
    with pytest.raises(ValueError):
        Date().coerce_write({"start": "2026-08-10", "time_zone": "Mars/Phobos"})


def test_date_coerce_write_accepts_valid_iana_timezone():
    value = {"start": "2026-08-10", "time_zone": "Europe/Paris"}
    assert Date().coerce_write(value) == value


def test_date_coerce_write_null_end_and_timezone_are_valid():
    value = {"start": "2026-08-10", "end": None, "time_zone": None}
    assert Date().coerce_write(value) == value


def test_date_operators_and_aggregations():
    ops = Date().operators()
    assert set(ops) >= {"equals", "before", "after", "this_week", "is_empty"}
    aggs = Date().aggregations()
    assert {"earliest_date", "latest_date", "date_range"} <= aggs


def test_date_registry_entry_is_the_rich_descriptor():
    assert isinstance(REGISTRY["date"], Date)


# --- sql_extract/sql_order byte-identity ---

def test_date_sql_extract_byte_identical_to_generic():
    ctx = SqlContext(key="dtAbc12345", alias="p")
    assert Date().sql_extract(ctx).sql == _GenericProperty(key="date").sql_extract(ctx).sql


def test_date_sql_order_byte_identical_to_generic_and_sorts_on_start():
    ctx = SqlContext(key="dtAbc12345", alias="p")
    for direction in ("asc", "desc"):
        order = Date().sql_order(ctx, direction)
        assert order.sql == _GenericProperty(key="date").sql_order(ctx, direction).sql
    assert "'start'" in Date().sql_order(ctx, "asc").sql


# ---------------------------------------------------------------------------
# CreatedTime / LastEditedTime
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("cls,type_key", [(CreatedTime, "created_time"), (LastEditedTime, "last_edited_time")])
def test_read_only_temporal_default_and_is_empty(cls, type_key):
    inst = cls()
    assert inst.default() is None
    assert inst.is_empty(None) is True
    assert inst.is_empty("2026-08-10T00:00:00Z") is False


@pytest.mark.parametrize("cls", [CreatedTime, LastEditedTime])
def test_read_only_temporal_coerce_write_accepts_none(cls):
    assert cls().coerce_write(None) is None


@pytest.mark.parametrize("cls", [CreatedTime, LastEditedTime])
def test_read_only_temporal_coerce_write_rejects_any_real_value(cls):
    inst = cls()
    with pytest.raises(ValueError):
        inst.coerce_write("2026-08-10T00:00:00Z")
    with pytest.raises(ValueError):
        inst.coerce_write({"start": "2026-08-10"})


@pytest.mark.parametrize("cls,type_key", [(CreatedTime, "created_time"), (LastEditedTime, "last_edited_time")])
def test_read_only_temporal_registry_entry_is_the_rich_descriptor(cls, type_key):
    assert isinstance(REGISTRY[type_key], cls)


@pytest.mark.parametrize("cls,type_key", [(CreatedTime, "created_time"), (LastEditedTime, "last_edited_time")])
def test_read_only_temporal_sql_extract_byte_identical_to_generic(cls, type_key):
    ctx = SqlContext(key="tsAbc12345", alias="p")
    assert cls().sql_extract(ctx).sql == _GenericProperty(key=type_key).sql_extract(ctx).sql


@pytest.mark.parametrize("cls,type_key", [(CreatedTime, "created_time"), (LastEditedTime, "last_edited_time")])
def test_read_only_temporal_sql_order_byte_identical_to_generic(cls, type_key):
    ctx = SqlContext(key="tsAbc12345", alias="p")
    for direction in ("asc", "desc"):
        assert (
            cls().sql_order(ctx, direction).sql
            == _GenericProperty(key=type_key).sql_order(ctx, direction).sql
        )


def test_created_at_column_backed_sql_extract_byte_identical_to_generic():
    # `created_at` is COLUMN_BACKED as created_time; `updated_at` as
    # last_edited_time.
    ctx = SqlContext(key="created_at", alias="notes", storage="column")
    assert (
        REGISTRY["created_time"].sql_extract(ctx).sql
        == _GenericProperty(key="created_time").sql_extract(ctx).sql
        == "notes.created_at"
    )


def test_updated_at_column_backed_sql_extract_byte_identical_to_generic():
    ctx = SqlContext(key="updated_at", alias="notes", storage="column")
    assert (
        REGISTRY["last_edited_time"].sql_extract(ctx).sql
        == _GenericProperty(key="last_edited_time").sql_extract(ctx).sql
        == "notes.updated_at"
    )
