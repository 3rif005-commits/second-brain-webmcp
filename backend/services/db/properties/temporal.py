"""Date, CreatedTime, LastEditedTime: Milestone 5's richer descriptors for
the date-ish types (task-14-brief.md §3).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §5.
Research: docs/research/notion-databases-research.md §F.1 item 8 (Date,
~line 797).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict

from .base import Operator, SqlContext, SqlFragment, _EmptyConfig, _GenericProperty

__all__ = ["Date", "DateConfig", "CreatedTime", "LastEditedTime"]


class DateConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")


_DATE_OPS: tuple[Operator, ...] = (
    Operator(name="equals", arg_type="date"),
    Operator(name="before", arg_type="date"),
    Operator(name="after", arg_type="date"),
    Operator(name="on_or_before", arg_type="date"),
    Operator(name="on_or_after", arg_type="date"),
    Operator(name="this_week", arg_type="none"),
    Operator(name="past_week", arg_type="none"),
    Operator(name="past_month", arg_type="none"),
    Operator(name="past_year", arg_type="none"),
    Operator(name="next_week", arg_type="none"),
    Operator(name="next_month", arg_type="none"),
    Operator(name="next_year", arg_type="none"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)

_DATE_VALUE_KEYS = {"start", "end", "time_zone"}


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


def _parse_iso(raw: Any, field_name: str) -> datetime:
    """Same normalisation as query/operators.py's `_coerce_date`: a
    trailing 'Z' isn't accepted by `datetime.fromisoformat` on the Python
    versions this repo targets, so it's swapped for an explicit UTC offset
    first. Not imported from operators.py (that would be
    properties -> query -> properties, a circular import: operators.py
    imports REGISTRY from this package's base.py)."""
    if not isinstance(raw, str):
        raise ValueError(f"date {field_name} must be an ISO-8601 string, got: {raw!r}")
    normalised = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalised)
    except ValueError as exc:
        raise ValueError(f"date {field_name} must be ISO-8601, got: {raw!r}") from exc
    # A bare date/datetime string with no offset (e.g. "2026-08-10") parses
    # naive. `start` and `end` must compare as the same kind of datetime —
    # Python raises TypeError comparing naive to aware, which callers of
    # coerce_write wouldn't catch as the ValueError this function otherwise
    # promises (query/operators.py's `_coerce_date` hit the identical
    # trap first; same fix, mirrored here).
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


@dataclass(frozen=True)
class Date:
    key: str = "date"
    config_model: type[BaseModel] = DateConfig

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return _is_empty(value)

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_extract(ctx)

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_order(ctx, direction)

    def operators(self) -> dict[str, Operator]:
        return {op.name: op for op in _DATE_OPS}

    def aggregations(self) -> set[str]:
        return {
            "count_all", "count_empty", "count_not_empty",
            "earliest_date", "latest_date", "date_range",
        }

    def coerce_write(self, raw: Any) -> Any:
        """raw must be None, or a dict with a required `start` (ISO-8601 date or
        date-time string) and optional `end` (same validation, must be >= start)
        and `time_zone` (a real IANA zone per zoneinfo.ZoneInfo). Extra keys
        rejected. Returns `raw` unchanged (not reshaped/defaulted) once validated
        -- sql_extract's `-> 'date' ->> 'start'` hop works whether or not `end`/
        `time_zone` keys are present, so there's no reason to rewrite the value's
        shape and risk diverging from what the caller actually wrote.
        """
        if raw is None:
            return None
        if not isinstance(raw, dict):
            raise ValueError(f"date value must be a dict or None, got: {raw!r}")
        extra = set(raw) - _DATE_VALUE_KEYS
        if extra:
            raise ValueError(f"date value has unexpected keys: {sorted(extra)}")
        if "start" not in raw or raw["start"] is None:
            raise ValueError("date value requires a non-null 'start'")
        start = _parse_iso(raw["start"], "start")
        if raw.get("end") is not None:
            end = _parse_iso(raw["end"], "end")
            if end < start:
                raise ValueError(
                    f"date range end ({raw['end']!r}) must be >= start ({raw['start']!r})"
                )
        if raw.get("time_zone") is not None:
            try:
                ZoneInfo(raw["time_zone"])
            except ZoneInfoNotFoundError as exc:
                raise ValueError(f"unknown IANA time zone: {raw['time_zone']!r}") from exc
        return raw


@dataclass(frozen=True)
class CreatedTime:
    """Research: "Read-only, auto-updated". `coerce_write` always rejects a
    real value -- the actual timestamp comes from the row's real creation
    time at read time (existing M1/M2 `COLUMN_BACKED` `created_at` mapping
    for column storage; nothing in this codebase currently creates a
    jsonb-storage created_time property, so rejecting all writes there is
    sufficient, per the brief)."""

    key: str = "created_time"
    config_model: type[BaseModel] = _EmptyConfig

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return _is_empty(value)

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_extract(ctx)

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_order(ctx, direction)

    def operators(self) -> dict[str, Operator]:
        return {op.name: op for op in _DATE_OPS}

    def aggregations(self) -> set[str]:
        return {
            "count_all", "count_empty", "count_not_empty",
            "earliest_date", "latest_date", "date_range",
        }

    def coerce_write(self, raw: Any) -> Any:
        if raw is None:
            return None
        raise ValueError("created_time is read-only and cannot be written directly")


@dataclass(frozen=True)
class LastEditedTime:
    """Same read-only contract as CreatedTime -- research: both are
    "Read-only, auto-updated"."""

    key: str = "last_edited_time"
    config_model: type[BaseModel] = _EmptyConfig

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return _is_empty(value)

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_extract(ctx)

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_order(ctx, direction)

    def operators(self) -> dict[str, Operator]:
        return {op.name: op for op in _DATE_OPS}

    def aggregations(self) -> set[str]:
        return {
            "count_all", "count_empty", "count_not_empty",
            "earliest_date", "latest_date", "date_range",
        }

    def coerce_write(self, raw: Any) -> Any:
        if raw is None:
            return None
        raise ValueError("last_edited_time is read-only and cannot be written directly")
