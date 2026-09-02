"""The 20 calculation-row aggregators (research §I.5.1/5.2), computed in
plain Python over already-fetched rows.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §5.1.
Research: docs/research/notion-databases-research.md §I.5 (~line 4600).

Grouping/aggregation operate on already-fetched, already-filtered rows (the
`{"id", "properties"}` shape `services/db/query/builder.py`'s `build()`
produces once decoded), not pushed into SQL — see task-13-brief.md's
"architectural decision already made" note. This module never touches
asyncpg/SqlFragment.
"""
from __future__ import annotations

import statistics
from datetime import UTC, datetime
from typing import Any

from services.db.properties.base import REGISTRY
from .compiler import PropertyLookup

__all__ = ["aggregate"]

_VALID_AGGREGATORS = frozenset({
    "count", "count_values", "sum", "average", "median", "min", "max", "range",
    "unique", "empty", "not_empty", "percent_empty", "percent_not_empty",
    "checked", "unchecked", "percent_checked", "percent_unchecked",
    "earliest_date", "latest_date", "date_range",
})

_NUMERIC_AGGREGATORS = frozenset({"sum", "average", "median", "min", "max", "range"})
_CHECKBOX_AGGREGATORS = frozenset(
    {"checked", "unchecked", "percent_checked", "percent_unchecked"}
)
_DATE_AGGREGATORS = frozenset({"earliest_date", "latest_date", "date_range"})
_DATE_TYPES = ("date", "created_time", "last_edited_time")


def _raw_value(row: dict, lookup: PropertyLookup) -> Any:
    """Unwrap `row["properties"][lookup.key]`'s §3.3 discriminated wrapper
    (`{"type": X, X: value}`) into its bare value. `None` (both when the key
    is entirely absent and when the wrapper itself carries a null) is the
    uniform "no value" signal every REGISTRY[...].is_empty() already treats
    as empty."""
    wrapper = row.get("properties", {}).get(lookup.key)
    if wrapper is None:
        return None
    return wrapper.get(lookup.type)


def _hashable(value: Any) -> Any:
    """A canonical, hashable stand-in for `value` so `unique` can dedupe
    list/dict-shaped cell values (people/relation/files) the same as any
    scalar — Python's own `set()` can't hold a `list`."""
    if isinstance(value, list):
        return tuple(_hashable(v) for v in value)
    if isinstance(value, dict):
        return tuple(sorted((k, _hashable(v)) for k, v in value.items()))
    return value


def _date_instant(prop_type: str, raw: Any) -> str | None:
    """The comparable ISO-8601 instant inside a date-ish raw value, mirroring
    properties/base.py's `_VALUE_SHAPES` SQL projection: a `date` value is
    `{"start", "end", "time_zone"}` (always project `start`); `created_time`/
    `last_edited_time` are already plain ISO-8601 scalars (base.py's default
    text shape — see `_wrap_column_value` in routers/databases.py, which
    `_jsonify`s a `datetime` straight to `.isoformat()`)."""
    if prop_type == "date":
        return raw.get("start") if isinstance(raw, dict) else None
    return raw


def _parse_instant(value: str) -> datetime:
    """Bare ISO-8601 parse, no guarded-cast machinery: this runs in Python
    over already-fetched values, not in SQL (task-13-brief.md explicitly
    permits this simplification over operators.py's guarded date family)."""
    normalised = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalised)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _numeric_aggregate(rows: list[dict], lookup: PropertyLookup, aggregator: str) -> Any:
    if lookup.type != "number":
        # Scoped to exactly "number" per research's own restriction —
        # unique_id is numeric too but deliberately out of scope
        # (task-13-brief.md: "do not extend it").
        raise ValueError(f"{aggregator!r} only applies to number properties, got {lookup.type!r}")
    is_empty = REGISTRY["number"].is_empty
    values = [v for v in (_raw_value(row, lookup) for row in rows) if not is_empty(v)]
    if aggregator == "sum":
        return sum(values) if values else 0
    if not values:
        return None
    if aggregator == "average":
        return sum(values) / len(values)
    if aggregator == "median":
        return statistics.median(values)
    if aggregator == "min":
        return min(values)
    if aggregator == "max":
        return max(values)
    return max(values) - min(values)  # range


def _checkbox_aggregate(rows: list[dict], lookup: PropertyLookup, aggregator: str) -> Any:
    if lookup.type != "checkbox":
        raise ValueError(f"{aggregator!r} only applies to checkbox properties, got {lookup.type!r}")
    # checkbox is NOT NULL, so a real cell is always True/False; a missing
    # key (bad legacy data) falls back to "unchecked" rather than crashing.
    checked = sum(1 for row in rows if _raw_value(row, lookup) is True)
    unchecked = len(rows) - checked
    if aggregator == "checked":
        return checked
    if aggregator == "unchecked":
        return unchecked
    if not rows:
        return None
    if aggregator == "percent_checked":
        return 100 * (checked / len(rows))
    return 100 * (unchecked / len(rows))  # percent_unchecked


def _date_aggregate(rows: list[dict], lookup: PropertyLookup, aggregator: str) -> Any:
    if lookup.type not in _DATE_TYPES:
        raise ValueError(f"{aggregator!r} only applies to date-ish properties, got {lookup.type!r}")
    is_empty = REGISTRY[lookup.type].is_empty
    instants: list[tuple[datetime, str]] = []
    for row in rows:
        raw = _raw_value(row, lookup)
        if is_empty(raw):
            continue
        instant_str = _date_instant(lookup.type, raw)
        if instant_str is None:
            continue
        instants.append((_parse_instant(instant_str), instant_str))
    if not instants:
        return None  # no identity value for "earliest of nothing" (same reasoning as min/max/range)
    if aggregator == "earliest_date":
        return min(instants, key=lambda pair: pair[0])[1]
    if aggregator == "latest_date":
        return max(instants, key=lambda pair: pair[0])[1]
    earliest = min(instants, key=lambda pair: pair[0])[0]
    latest = max(instants, key=lambda pair: pair[0])[0]
    # Plain day-count float, not an ISO-8601 duration string — this is what a
    # frontend needs to render "X days" without parsing a duration format.
    return (latest - earliest).total_seconds() / 86400.0


def _universal_aggregate(rows: list[dict], lookup: PropertyLookup, aggregator: str) -> Any:
    is_empty = REGISTRY[lookup.type].is_empty

    if lookup.type == "multi_select" and aggregator in ("count_values", "unique"):
        # research §I.5.3 (resolved by task-13-brief.md): individual tags
        # across all rows, not cells — a row with ["a","b"] contributes 2 to
        # count_values, and `unique` dedupes the flattened tag multiset (not
        # distinct tag-*combinations*, resolved the same way for consistency).
        tags: list[str] = []
        for row in rows:
            raw = _raw_value(row, lookup)
            if not is_empty(raw):
                tags.extend(raw)
        return len(tags) if aggregator == "count_values" else len(set(tags))

    non_empty: list[Any] = []
    empty_count = 0
    for row in rows:
        raw = _raw_value(row, lookup)
        if is_empty(raw):
            empty_count += 1
        else:
            non_empty.append(raw)

    if aggregator == "count_values":
        return len(non_empty)
    if aggregator == "unique":
        return len({_hashable(v) for v in non_empty})
    if aggregator == "empty":
        return empty_count
    if aggregator == "not_empty":
        return len(non_empty)
    # percent_empty / percent_not_empty: a percentage of *rows*
    # (len(rows) as denominator), matching every UI definition research
    # quotes — not the aggregated property's own non-null count.
    if not rows:
        return None
    if aggregator == "percent_empty":
        return 100 * (empty_count / len(rows))
    return 100 * (len(non_empty) / len(rows))  # percent_not_empty


def aggregate(rows: list[dict], lookup: PropertyLookup | None, aggregator: str) -> Any:
    """`rows` are the decoded {"id", "properties"} shape. `lookup` is None
    only for `count` (research §I.5.1: the only property-independent
    aggregate); every other aggregator requires it."""
    if aggregator not in _VALID_AGGREGATORS:
        raise ValueError(f"unknown aggregator: {aggregator!r}")
    if aggregator == "count":
        return len(rows)
    if lookup is None:
        raise ValueError(f"aggregator {aggregator!r} requires a property lookup (only 'count' doesn't)")

    if aggregator in _NUMERIC_AGGREGATORS:
        return _numeric_aggregate(rows, lookup, aggregator)
    if aggregator in _CHECKBOX_AGGREGATORS:
        return _checkbox_aggregate(rows, lookup, aggregator)
    if aggregator in _DATE_AGGREGATORS:
        return _date_aggregate(rows, lookup, aggregator)
    return _universal_aggregate(rows, lookup, aggregator)
