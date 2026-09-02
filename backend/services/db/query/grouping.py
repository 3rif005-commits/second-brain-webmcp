"""Grouping and (two-level) sub-grouping, computed in plain Python over
already-fetched rows.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §5.1.
Research: docs/research/notion-databases-research.md §I.4 (~line 4495).

Same "already-fetched rows, plain Python" scope as aggregations.py — see
that module's docstring and task-13-brief.md's "architectural decision
already made" note. This module never touches asyncpg/SqlFragment.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, date as date_cls, datetime, timedelta
from typing import Any

from services.db.properties.base import REGISTRY
from .compiler import PropertyLookup

__all__ = ["Group", "GroupBySpec", "group_rows", "sub_group"]

# Stable key/label for the implicit "no value" bucket every grouped type
# gets (task-13-brief.md: "never silently drop rows" applies to grouping
# the same as everything else in this module). "__" can't collide with a
# real option string/tag/id/number key, none of which this codebase ever
# mints with that prefix (see keys.mint_key's base62 alphabet).
_NO_VALUE_KEY = "__no_value__"
_NO_VALUE_LABEL = "No value"

_NOT_GROUPABLE = frozenset(
    {"files", "rollup", "unique_id", "verification", "button", "place"}
)
_DATE_TYPES = ("date", "created_time", "last_edited_time")
_TEXT_TYPES = ("title", "rich_text", "url", "email", "phone_number")


@dataclass(frozen=True)
class GroupBySpec:
    property_key: str
    mode: str | None = None        # per-type sub-mode, see grouping.py's per-type table
    start_day_of_week: int = 1     # 1=Monday, 0=Sunday (spec §5.1's decided default)
    range_start: float | None = None
    range_end: float | None = None
    range_size: float | None = None  # required with range_start/range_end for number bucketing
    # task-15-brief.md §1.7: additive, HTTP-endpoint-only flag -- every grouping family
    # above still builds its full, structurally-defined bucket set exactly as before
    # (checkbox's fixed True/False, a range spec's every bucket, the implicit no-value
    # group, ...); this only trims the *returned* list at the very end of group_rows, so
    # hide_empty_groups=False (the default) is byte-identical to Milestone 4's original
    # behaviour and every existing test above keeps passing unmodified.
    hide_empty_groups: bool = False


@dataclass(frozen=True)
class Group:
    key: str            # stable identifier for this bucket (used for equality/lookup)
    label: str           # display label
    rows: list[dict]
    # Populated only by sub_group() -- depth is exactly two levels (research
    # §I.4.3: sub-grouping is Board-only, no third tier), so a subgroup's own
    # `subgroups` is always None. `.rows` always stays the flat row list even
    # after sub-grouping; the nested view lives here instead.
    subgroups: list["Group"] | None = None


def _raw_value(row: dict, lookup: PropertyLookup) -> Any:
    """Same unwrap as aggregations.py's `_raw_value` — see that module's
    docstring for why `None` is the uniform "no value" signal."""
    wrapper = row.get("properties", {}).get(lookup.key)
    if wrapper is None:
        return None
    return wrapper.get(lookup.type)


def _date_instant(prop_type: str, raw: Any) -> str | None:
    """Same projection as aggregations.py's `_date_instant` (see its
    docstring): `date` is `{"start", "end", "time_zone"}`, project `start`;
    created_time/last_edited_time are already plain ISO-8601 scalars."""
    if prop_type == "date":
        return raw.get("start") if isinstance(raw, dict) else None
    return raw


def _parse_instant(value: str) -> datetime:
    normalised = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalised)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _grouping_is_empty(prop_type: str, raw: Any) -> bool:
    """What counts as "no value" for grouping purposes: REGISTRY's own
    is_empty, plus (date-ish types only) a non-empty wrapper that still
    carries no extractable instant (e.g. `{"start": None, ...}, which
    `is_empty` doesn't catch since the dict itself is non-empty) -- routed
    to the no-value group rather than silently dropped by the date bucketer."""
    if REGISTRY[prop_type].is_empty(raw):
        return True
    if prop_type in _DATE_TYPES:
        return _date_instant(prop_type, raw) is None
    return False


def _bucket(buckets: dict[str, Group], key: str, label: str, row: dict) -> None:
    if key not in buckets:
        buckets[key] = Group(key=key, label=label, rows=[])
    buckets[key].rows.append(row)


def _group_by_values(
    rows_with_raw: list[tuple[dict, Any]], *, multi: bool
) -> list[Group]:
    """select/status(option)/text(exact)/created_by/last_edited_by (single-
    valued) and multi_select/people/relation (multi-valued, flattened -- a
    row with 2 values appears in 2 groups). Sorted alphabetically for
    determinism (task-13-brief.md explicitly allows this for select/
    multi_select; applied uniformly to every dynamic string-keyed type here)."""
    buckets: dict[str, Group] = {}
    for row, raw in rows_with_raw:
        values = dict.fromkeys(raw) if multi else (raw,)  # dedupe within a row
        for value in values:
            _bucket(buckets, value, value, row)
    return [buckets[k] for k in sorted(buckets)]


def _group_by_alphabet_prefix(rows_with_raw: list[tuple[dict, Any]]) -> list[Group]:
    buckets: dict[str, Group] = {}
    for row, raw in rows_with_raw:
        first = raw[0] if raw else ""
        key = first.upper() if first.isalpha() else "#"
        _bucket(buckets, key, key, row)
    return [buckets[k] for k in sorted(buckets)]


def _week_start(d: date_cls, start_day_of_week: int) -> date_cls:
    # date.weekday(): Monday=0 .. Sunday=6. Map the spec's own convention
    # (0=Sunday, 1=Monday) onto it.
    anchor = 0 if start_day_of_week == 1 else 6
    delta = (d.weekday() - anchor) % 7
    return d - timedelta(days=delta)


def _group_by_date(
    rows_with_raw: list[tuple[dict, Any]], prop_type: str, spec: GroupBySpec
) -> list[Group]:
    buckets: dict[str, Group] = {}
    for row, raw in rows_with_raw:
        dt = _parse_instant(_date_instant(prop_type, raw))
        if spec.mode == "day":
            key = label = dt.date().isoformat()
        elif spec.mode == "week":
            key = _week_start(dt.date(), spec.start_day_of_week).isoformat()
            label = f"Week of {key}"
        elif spec.mode == "month":
            key = f"{dt.year:04d}-{dt.month:02d}"
            label = dt.strftime("%B %Y")
        else:  # "year"
            key = label = f"{dt.year:04d}"
        _bucket(buckets, key, label, row)
    # ISO-formatted keys sort alphabetically == chronologically, so a plain
    # key sort is enough (no separate datetime-keyed sort needed).
    return [buckets[k] for k in sorted(buckets)]


def _number_key(value: float) -> str:
    return f"{value:g}" if isinstance(value, float) else str(value)


def _group_by_number(rows_with_raw: list[tuple[dict, Any]], spec: GroupBySpec) -> list[Group]:
    if spec.range_start is not None and spec.range_end is not None and spec.range_size is not None:
        start, end, size = spec.range_start, spec.range_end, spec.range_size
        if size < 1:
            raise ValueError(f"range_size must be >= 1, got {size!r}")
        if end <= start:
            raise ValueError(f"range_end ({end!r}) must be greater than range_start ({start!r})")
        n_buckets = math.ceil((end - start) / size)
        bucket_rows: list[list[dict]] = [[] for _ in range(n_buckets)]
        overflow: list[dict] = []
        for row, raw in rows_with_raw:
            if raw < start or raw >= end:
                overflow.append(row)
                continue
            idx = min(int((raw - start) // size), n_buckets - 1)
            bucket_rows[idx].append(row)
        # Bucket set is config-derived (like checkbox's fixed True/False),
        # not data-derived -- always return every bucket, even empty ones,
        # same "let the caller hide_empty_groups, don't do it here" standard.
        groups = [
            Group(
                key=f"{_number_key(start + i * size)}-{_number_key(min(start + (i + 1) * size, end))}",
                label=f"{_number_key(start + i * size)}-{_number_key(min(start + (i + 1) * size, end))}",
                rows=bucket_rows[i],
            )
            for i in range(n_buckets)
        ]
        groups.append(Group(key="__other__", label="Other", rows=overflow))
        return groups

    # No (or partial) range config: fall back to one group per distinct
    # number present, ordered numerically (not alphabetically -- "10" would
    # sort before "2" as a string).
    buckets: dict[float, list[dict]] = {}
    for row, raw in rows_with_raw:
        buckets.setdefault(raw, []).append(row)
    return [
        Group(key=_number_key(value), label=_number_key(value), rows=buckets[value])
        for value in sorted(buckets)
    ]


def _group_by_checkbox(rows_with_raw: list[tuple[dict, Any]]) -> list[Group]:
    # Exactly two fixed groups, always both present (task-13-brief.md:
    # "hide_empty_groups is the caller's concern, not this function's").
    false_group = Group(key="false", label="False", rows=[])
    true_group = Group(key="true", label="True", rows=[])
    for row, raw in rows_with_raw:
        (true_group if raw else false_group).rows.append(row)
    return [false_group, true_group]


def group_rows(rows: list[dict], lookup: PropertyLookup, spec: GroupBySpec) -> list[Group]:
    """Returns ordered groups per the type's grouping semantics (research
    §I.4.2/4.5). Raises ValueError for a non-groupable type (files/rollup/
    unique_id/verification/button/place) or a missing/unsupported mode, and
    NotImplementedError for the three cases this milestone explicitly defers
    (status mode="group", date mode="relative", formula) -- never silently
    drops rows into a wrong or missing group, same "fail loud" standard as
    the M3 compiler's unknown-key 400.
    """
    prop_type = lookup.type
    if prop_type in _NOT_GROUPABLE:
        raise ValueError(f"{prop_type!r} is not a groupable property type")
    if prop_type == "formula":
        # Needs the formula engine (Milestone 8) to know the result type
        # before any grouping mode makes sense (task-13-brief.md).
        raise NotImplementedError(
            "formula grouping requires the formula engine's result type; deferred to Milestone 8"
        )
    if prop_type == "status" and spec.mode == "group":
        # Status *groups* (To Do/In Progress/Done) aren't modelled in config
        # yet -- same root cause as the select/multi_select option-order gap
        # below, but there's no reasonable dynamic fallback here.
        raise NotImplementedError(
            "status group_by='group' needs status-group config; deferred to Milestone 5"
        )
    if prop_type in _DATE_TYPES and spec.mode == "relative":
        # research §I flags the exact "relative" bucket boundaries
        # (Today/This week/...) as genuinely undocumented -- inventing them
        # now risks a breaking UI change later. Defer, don't guess.
        raise NotImplementedError(
            "date grouping mode='relative' has no documented bucket boundaries; deferred to Milestone 5"
        )

    if prop_type == "status" and spec.mode != "option":
        raise ValueError(f"status grouping requires mode='option' or 'group', got {spec.mode!r}")
    if prop_type in _DATE_TYPES and spec.mode not in ("day", "week", "month", "year"):
        raise ValueError(
            f"date grouping requires mode in day/week/month/year/relative, got {spec.mode!r}"
        )
    if prop_type in _TEXT_TYPES and spec.mode not in ("exact", "alphabet_prefix"):
        raise ValueError(
            f"text grouping requires mode='exact' or 'alphabet_prefix', got {spec.mode!r}"
        )

    empty_rows: list[dict] = []
    non_empty: list[tuple[dict, Any]] = []
    for row in rows:
        raw = _raw_value(row, lookup)
        if _grouping_is_empty(prop_type, raw):
            empty_rows.append(row)
        else:
            non_empty.append((row, raw))

    if prop_type in ("select", "multi_select"):
        groups = _group_by_values(non_empty, multi=(prop_type == "multi_select"))
    elif prop_type == "status":
        groups = _group_by_values(non_empty, multi=False)
    elif prop_type in _DATE_TYPES:
        groups = _group_by_date(non_empty, prop_type, spec)
    elif prop_type == "number":
        groups = _group_by_number(non_empty, spec)
    elif prop_type == "checkbox":
        groups = _group_by_checkbox(non_empty)
    elif prop_type in _TEXT_TYPES:
        if spec.mode == "alphabet_prefix":
            groups = _group_by_alphabet_prefix(non_empty)
        else:
            groups = _group_by_values(non_empty, multi=False)
    elif prop_type in ("people", "relation"):
        groups = _group_by_values(non_empty, multi=True)
    elif prop_type in ("created_by", "last_edited_by"):
        groups = _group_by_values(non_empty, multi=False)
    else:
        raise AssertionError(f"unreachable: no grouping family for {prop_type!r}")

    # Always appended, even with zero rows -- same "let the caller decide
    # hide_empty_groups" reasoning task-13-brief.md states explicitly for
    # checkbox's fixed groups, applied consistently to this implicit group.
    groups.append(Group(key=_NO_VALUE_KEY, label=_NO_VALUE_LABEL, rows=empty_rows))
    if spec.hide_empty_groups:
        groups = [g for g in groups if g.rows]
    return groups


def sub_group(groups: list[Group], lookup: PropertyLookup, spec: GroupBySpec) -> list[Group]:
    """Sub-grouping is just calling group_rows again on each top-level
    group's flat `.rows`, attaching the result as `.subgroups` -- depth is
    exactly two levels (research §I.4.3: sub-grouping is Board-only, no
    third tier), so this never recurses into the subgroups it produces."""
    return [
        Group(key=g.key, label=g.label, rows=g.rows, subgroups=group_rows(g.rows, lookup, spec))
        for g in groups
    ]
