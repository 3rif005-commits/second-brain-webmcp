"""A pure, textual value formatter for the 24 REGISTRY property types.

Milestone 14, Task 46 (spec §12, "Q10 — AI integration", item 1): the
indexer needs a short, human-readable rendering of each of a database row's
own property values to build its "property preamble" chunk (e.g. `"Status:
In progress · Topics: rust, async · Due: 2026-09-01"`), so a semantic query
can match on property values, not just body prose.

There is no Python equivalent of the frontend's `renderCellValue`
(`frontend/components/database/cells/renderCellValue.tsx`) — that's React/
TSX and cannot be reused server-side, and it renders JSX widgets, not text,
so it wouldn't help here even ported. This module is a from-scratch,
purely-textual formatter keyed off `db_properties.type`, cross-checked
against the §3.3 wrapper shapes documented in `properties/base.py`'s
`_VALUE_SHAPES` and the richer per-type descriptors in `choice.py` /
`temporal.py` / `scalar.py` where one exists.

**Value shape contract.** `format_property_value` takes the *unwrapped*
domain value, not the raw `db_row_props.properties[key]` wrapper object. A
stored property value is a discriminated wrapper keyed by its own type name
(`{"type": "select", "select": "<option id>"}`, `{"type": "date", "date":
{"start": ..., "end": ..., "time_zone": ...}}`, ...) — see
`frontend/lib/database/types.ts`'s `PropertyValue` union, which documents
the identical shape the frontend cells already unwrap via `value?.select`
etc. The caller (indexer.py) is the one place that already has both the
wrapper and the property's declared `type`, so it does the one-line unwrap
(`wrapper.get(prop_type)`) before calling in; this function stays a pure
`(type, value) -> text` mapping with no note/row/indexer awareness at all,
so **Task 48 (CSV export) can import it unchanged** for the identical
value-to-text problem.

**Design note — this module is intentionally reused, not just designed to
be reusable.** Task 48 is not dispatched yet.
"""
from __future__ import annotations

from typing import Any

__all__ = ["format_property_value"]


def _option_label(option_id: Any, config: dict) -> str | None:
    """Resolve a select/status/multi_select option id to its configured
    display name (`SelectOption`/`StatusOption` in choice.py: `{"id",
    "name", "color"}`). `coerce_write` in choice.py validates that the
    *stored* value is always an option's opaque, server-minted `id` — never
    its `name` — so showing the raw id in the preamble (as the frontend's
    own `SelectCell`/`MultiSelectCell` currently do, pill-labelled by id) is
    exactly the "raw id shown where a label is knowable from config" case
    the brief calls out. Returns None (not the id) when no match is found,
    so the caller can decide the fallback."""
    for opt in (config.get("options") or []):
        if isinstance(opt, dict) and opt.get("id") == option_id:
            name = opt.get("name")
            if isinstance(name, str) and name:
                return name
    return None


def _text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _short_date(value: Any) -> str | None:
    """ISO-8601 timestamp -> its date portion, matching the spec's own
    example rendering (`"Due: 2026-09-01"`, not a full timestamp)."""
    if not isinstance(value, str) or not value:
        return None
    return value[:10]


def _format_number(value: Any) -> str | None:
    # bool is a subclass of int (isinstance(True, int) is True) -- the same
    # trap scalar.py's Number.coerce_write already guards against; a bool
    # here would mean the stored value is malformed, not a real number.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _format_checkbox(value: Any) -> str | None:
    if not isinstance(value, bool):
        return None
    return "Yes" if value else "No"


def _format_date(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    start = _short_date(value.get("start"))
    if not start:
        return None
    end = _short_date(value.get("end"))
    if end and end != start:
        return f"{start} → {end}"
    return start


def _format_single_option(value: Any, config: dict) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return _option_label(value, config) or value


def _format_multi_option(value: Any, config: dict) -> str | None:
    if not isinstance(value, list) or not value:
        return None
    labels = [
        _option_label(item, config) or item
        for item in value
        if isinstance(item, str) and item
    ]
    return ", ".join(labels) if labels else None


def _format_unique_id(value: Any, config: dict) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    prefix = config.get("prefix")
    return f"{prefix}-{value}" if isinstance(prefix, str) and prefix else str(value)


def _format_people(value: Any) -> str | None:
    # No user-directory lookup exists in this codebase to turn a person id
    # into a display name (this is a single-user app per choice.py's Status
    # docstring), so this is the documented raw-render case for `people`:
    # the ids themselves, comma-joined, rather than nothing at all.
    if not isinstance(value, list) or not value:
        return None
    ids = [str(v) for v in value if v]
    return ", ".join(ids) if ids else None


def _format_files(value: Any) -> str | None:
    if not isinstance(value, list) or not value:
        return None
    names = []
    for item in value:
        if isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"]:
            names.append(item["name"])
        elif isinstance(item, str) and item:
            names.append(item)
    return ", ".join(names) if names else None


def format_property_value(prop_type: str, value: Any, config: dict | None = None) -> str | None:
    """Render `value` (already unwrapped from its §3.3 wrapper — see module
    docstring) as short, human-readable text, or None if it's empty/absent
    or not renderable (in which case the caller skips the property entirely
    rather than emitting a blank/noisy entry).

    Types deliberately rendered as None (documented judgment calls, not
    oversights — see task-46-report.md):

    - `relation`: only the linked rows' ids are visible here, no fetched
      target title (this module takes no note/row/indexer context to go
      fetch one) -- raw uuids are noise, not signal, per the brief's own
      example of this exact case.
    - `formula` / `rollup`: their materialised result lives in
      `db_row_props.computed`, a column this task's caller (indexer.py)
      does not fetch (scope: the property *preamble*, not a general
      computed-value formatter) -- there is no result to format yet from
      what's passed in here.
    - `button`: no per-row value exists at all (research §25 — "every row
      shows the same button").
    - `created_by` / `last_edited_by`: stored as an opaque user id with no
      directory to resolve a display name from, same limitation as
      `people` below -- but unlike `people`/`files`, a single raw uuid
      isn't worth a preamble line entry on its own (a `people` *list* at
      least conveys "N people", a single created_by id conveys nothing a
      reader could act on), so this one is skipped rather than raw-rendered.
    - `place` / `verification`: no richer per-type descriptor has landed
      for either yet (still `_GenericProperty` in REGISTRY) -- there is no
      documented value shape in this codebase to format against.
    """
    config = config or {}

    if value is None:
        return None

    if prop_type in ("title", "rich_text", "url", "email", "phone_number"):
        return _text(value)

    if prop_type in ("created_time", "last_edited_time"):
        return _short_date(value)

    if prop_type == "number":
        return _format_number(value)

    if prop_type == "checkbox":
        return _format_checkbox(value)

    if prop_type == "date":
        return _format_date(value)

    if prop_type in ("select", "status"):
        return _format_single_option(value, config)

    if prop_type == "multi_select":
        return _format_multi_option(value, config)

    if prop_type == "unique_id":
        return _format_unique_id(value, config)

    if prop_type == "people":
        return _format_people(value)

    if prop_type == "files":
        return _format_files(value)

    # relation / formula / rollup / button / created_by / last_edited_by /
    # place / verification: see docstring above.
    return None
