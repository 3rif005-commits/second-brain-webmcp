"""Row templates (Milestone 12, task-37) — `db_row_templates` CRUD, template
instantiation, and the pure repeat-schedule arithmetic the in-process scheduler
(`services/db/scheduler.py`) uses to advance a repeating template's `next_run_at`.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §1, §3.2.
Research: docs/research/notion-databases-research.md §J.5 (row templates, ~line 5632).
Migration: supabase/migrations/017_templates_automations.sql.

A template captures pre-filled property VALUES (`properties`, same JSONB wrapper shape
as `db_row_props.properties`) and a page BODY (`content`, same shape as `notes.content`)
— instantiating one is "merge `properties` into a new row's `db_row_props.properties`,
copy `content` verbatim into the new row's `notes.content`," via `services/db/rows.py`'s
`create_row_core` (no translation layer, per the migration's own header comment).

`repeat_config`'s shape is fixed by task-37-brief.md decision 5:

    {"frequency": "daily"|"weekly"|"monthly"|"yearly", "interval": 1,
     "weekdays": [1, 3], "start_date": "2026-01-01", "time_of_day": "09:00",
     "timezone": "UTC"}

`weekdays` (ISO weekday ints, 1=Monday, matching this codebase's M4 Monday-first
grouping convention) is meaningful only for `"weekly"`. There is no end-date field
(research §J.5.3: repeating *templates*, unlike automations' `every_frequency` trigger,
have no documented end condition beyond "turn Repeat off or delete the template").

UTC-only, matching M3's already-recorded gap (no per-user timezone concept anywhere in
this codebase): `repeat_config.timezone` is accepted and stored for forward-compatibility
only — `next_occurrence` below always computes in UTC.
"""
from __future__ import annotations

import calendar
import uuid as uuid_lib
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

import asyncpg

from models.database import RowResponse, RowTemplateCreate, RowTemplateResponse, RowTemplateUpdate
from services.db.rows import create_row_core


class DuplicateDefaultTemplateError(Exception):
    """Raised when an insert/update would leave a second `is_default=True`
    template on the same `data_source_id` — migration 017's partial unique
    index (`db_row_templates_one_default_uniq`) rejects this at the
    database, and this wraps that raw `asyncpg.UniqueViolationError` into
    something the router can turn into a clean 400 (per task-37-brief.md's
    reference facts: "must catch it and raise a clean `FilterValidationError`-
    style 400, not let asyncpg's `UniqueViolationError` surface as a 500" —
    mirroring `create_property`'s own unique-violation handling, `routers/
    databases.py`)."""


class TemplateConfigError(ValueError):
    """Raised when `repeat_config` is present but missing a required key or
    names an unknown `frequency` — a minimal shape check beyond this
    codebase's usual "JSONB pass-through, application code doesn't validate
    shape" convention (`ViewUpdate`'s docstring), added here specifically
    because `next_occurrence` needs `frequency`/`start_date` to exist to do
    date arithmetic at all; a `KeyError` reaching the router as a raw 500
    would be worse than a 400 naming the missing field."""


# ---------------------------------------------------------------------------
# next_occurrence: pure, no real-clock dependency, directly unit-testable.
# ---------------------------------------------------------------------------


def _as_utc(dt: datetime) -> datetime:
    """Normalize to an aware UTC datetime — a naive input (e.g. straight
    from an asyncpg `TIMESTAMPTZ` column read without a session timezone
    set, or a test's hand-built `datetime(...)`) is treated as already UTC,
    never silently reinterpreted."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_time_of_day(value: str | None) -> time:
    value = value or "00:00"
    parts = value.split(":")
    return time(int(parts[0]), int(parts[1]))


def _add_months_clamped(d: date, months: int) -> date:
    """Add `months` calendar months to `d`, clamping the day to the target
    month's last day when it overflows (e.g. Jan 31 + 1 month -> Feb 28/29,
    not "roll into March"). Computed from `d` fresh each call (not from a
    previously-clamped date) so a monthly-on-the-31st schedule returns to
    the 31st in every month that has one, rather than permanently
    degrading to the 28th after the first short month — see this module's
    `next_occurrence` docstring for why that's the chosen behavior."""
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def next_occurrence(repeat_config: dict[str, Any], after: datetime) -> datetime:
    """The earliest valid occurrence strictly AFTER `after`, per
    `repeat_config`'s `frequency`/`interval`/`weekdays`, anchored at
    `start_date` + `time_of_day` (UTC only — see module docstring).

    Pure and side-effect-free: no `datetime.now()`, no I/O. Two callers:
    seeding a freshly-(re)configured template's initial `next_run_at`
    (`after` = the anchor instant minus one second, so the anchor itself
    qualifies as "the next occurrence" when it's otherwise valid — see
    `seed_next_run_at` below) and the scheduler's tick, advancing past the
    `next_run_at` that was just fired (`after` = that same `next_run_at`).

    Monthly/yearly month-length overflow (e.g. a template anchored on Jan
    31): each cycle is computed from `start_date`'s ORIGINAL day-of-month
    via `_add_months_clamped`, not from the previous (possibly clamped)
    occurrence — so Jan 31 -> Feb 28 -> Mar 31, never permanently
    degrading to the 28th. This is a judgment call task-37-brief.md's
    decision 5 didn't spell out; documented here and in task-37-report.md.
    """
    if "frequency" not in repeat_config:
        raise TemplateConfigError("repeat_config.frequency is required")
    if "start_date" not in repeat_config:
        raise TemplateConfigError("repeat_config.start_date is required")

    frequency = repeat_config["frequency"]
    interval = repeat_config.get("interval") or 1
    try:
        start_date = date.fromisoformat(repeat_config["start_date"])
    except ValueError as exc:
        raise TemplateConfigError(f"invalid repeat_config.start_date: {exc}") from exc
    tod = _parse_time_of_day(repeat_config.get("time_of_day"))
    anchor = datetime.combine(start_date, tod, tzinfo=timezone.utc)
    after = _as_utc(after)

    if frequency == "daily":
        step = timedelta(days=interval)
        if anchor > after:
            return anchor
        elapsed_steps = (after - anchor) // step
        candidate = anchor + (elapsed_steps + 1) * step
        return candidate

    if frequency == "weekly":
        weekdays = sorted(repeat_config.get("weekdays") or [start_date.isoweekday()])
        # Monday (isoweekday 1) of the anchor's own week, same time-of-day.
        week_start = anchor - timedelta(days=anchor.isoweekday() - 1)
        # Bounded search: interval weeks apart, up to a few years out is
        # always enough to find a match (weekdays is non-empty by now).
        for week in range(0, 53 * 5 * max(interval, 1) + 10):
            if week % interval != 0:
                continue
            for wd in weekdays:
                candidate = week_start + timedelta(days=7 * week + (wd - 1))
                if candidate >= anchor and candidate > after:
                    return candidate
        raise TemplateConfigError("no weekly occurrence found within search bound")

    if frequency == "monthly":
        n = 0
        candidate = anchor
        while candidate <= after:
            n += interval
            candidate = datetime.combine(
                _add_months_clamped(start_date, n), tod, tzinfo=timezone.utc
            )
        return candidate

    if frequency == "yearly":
        n = 0
        candidate = anchor
        while candidate <= after:
            n += interval
            candidate = datetime.combine(
                _add_months_clamped(start_date, 12 * n), tod, tzinfo=timezone.utc
            )
        return candidate

    raise TemplateConfigError(f"unknown repeat_config.frequency: {frequency!r}")


def seed_next_run_at(repeat_config: dict[str, Any]) -> datetime:
    """The initial `next_run_at` for a template whose `repeat_config` was
    just set (on create, or via an update that (re)configures repeating) —
    the first valid occurrence at-or-after the schedule's own anchor
    (`start_date` + `time_of_day`), computed by asking `next_occurrence`
    for the first occurrence strictly after one second before the anchor.

    Exported (no leading underscore, task-38-brief.md decision 3's own judgment call —
    see task-38-report.md) so `services/db/automations.py`'s `_seed_automation_next_run_at`
    can reuse it as-is for the `every_frequency` trigger's `next_run_at` seeding, rather
    than forking a byte-identical copy of this function into a second module. Works
    unchanged for that caller: an `every_frequency` trigger dict carries the same
    `frequency`/`interval`/`weekdays`/`start_date`/`time_of_day`/`timezone` keys this
    function reads (plus `end_date`, which it simply never looks at).
    """
    start_date = date.fromisoformat(repeat_config["start_date"])
    tod = _parse_time_of_day(repeat_config.get("time_of_day"))
    anchor = datetime.combine(start_date, tod, tzinfo=timezone.utc)
    return next_occurrence(repeat_config, anchor - timedelta(seconds=1))


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def _to_response(row: asyncpg.Record) -> RowTemplateResponse:
    return RowTemplateResponse(
        **{k: (str(v) if isinstance(v, uuid_lib.UUID) else v) for k, v in dict(row).items()}
    )


async def create_template(
    conn: asyncpg.Connection, user_id: str, data_source_id: str, body: RowTemplateCreate
) -> RowTemplateResponse:
    """Inserts a new template. Raises `TemplateConfigError` if `repeat_config`
    is present but malformed, `DuplicateDefaultTemplateError` if
    `is_default=True` collides with an existing default for this data
    source (both framework-free — the router maps them to a 400)."""
    next_run_at = seed_next_run_at(body.repeat_config) if body.repeat_config else None
    try:
        row = await conn.fetchrow(
            """
            INSERT INTO db_row_templates
                (data_source_id, user_id, name, icon, properties, content,
                 is_default, repeat_config, next_run_at, position)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                    COALESCE(
                        (SELECT MAX(position) + 1 FROM db_row_templates
                         WHERE data_source_id = $1 AND user_id = $2),
                        0))
            RETURNING *
            """,
            data_source_id,
            user_id,
            body.name,
            body.icon,
            body.properties,
            body.content,
            body.is_default,
            body.repeat_config,
            next_run_at,
        )
    except asyncpg.UniqueViolationError as exc:
        raise DuplicateDefaultTemplateError(
            "a default template already exists for this data source"
        ) from exc
    return _to_response(row)


async def list_templates(
    conn: asyncpg.Connection, user_id: str, data_source_id: str
) -> list[RowTemplateResponse]:
    rows = await conn.fetch(
        """
        SELECT * FROM db_row_templates
        WHERE data_source_id = $1 AND user_id = $2
        ORDER BY position
        """,
        data_source_id,
        user_id,
    )
    return [_to_response(r) for r in rows]


async def get_template(
    conn: asyncpg.Connection, user_id: str, template_id: str
) -> RowTemplateResponse | None:
    row = await conn.fetchrow(
        """
        SELECT * FROM db_row_templates WHERE id = $1 AND user_id = $2
        """,
        template_id,
        user_id,
    )
    return _to_response(row) if row is not None else None


_TEMPLATE_UPDATABLE_FIELDS = ("name", "icon", "properties", "content", "is_default", "repeat_config")
# Migration 017: `icon` and `repeat_config` are the only nullable columns
# among the updatable fields (the rest are NOT NULL) — same
# "explicit null clears a nullable column, drops as a no-op for the rest"
# convention as `routers/databases.py`'s `_VIEW_NULLABLE_FIELDS`.
_TEMPLATE_NULLABLE_FIELDS = frozenset({"icon", "repeat_config"})


async def update_template(
    conn: asyncpg.Connection, user_id: str, template_id: str, body: RowTemplateUpdate
) -> RowTemplateResponse | None:
    """Partial update — only fields present in the request are touched.
    When `repeat_config` is part of the update, `next_run_at` is
    recomputed alongside it in the same statement: a fresh non-`None`
    `repeat_config` reseeds `next_run_at` from its own new anchor (a
    schedule change starts counting from its own start_date/time_of_day,
    not from whatever `next_run_at` the old schedule happened to leave
    behind); an explicit `repeat_config: null` (turn off repeating) clears
    `next_run_at` too. Raises `TemplateConfigError`/
    `DuplicateDefaultTemplateError` the same way `create_template` does.
    """
    updates = {
        field: value
        for field, value in body.model_dump(exclude_unset=True).items()
        if field in _TEMPLATE_UPDATABLE_FIELDS
        and (value is not None or field in _TEMPLATE_NULLABLE_FIELDS)
    }
    if "repeat_config" in updates:
        updates["next_run_at"] = (
            seed_next_run_at(updates["repeat_config"]) if updates["repeat_config"] else None
        )

    if not updates:
        row = await conn.fetchrow(
            """
            SELECT * FROM db_row_templates WHERE id = $1 AND user_id = $2
            """,
            template_id,
            user_id,
        )
    else:
        set_sql = ", ".join(f"{field} = ${i + 3}" for i, field in enumerate(updates))
        try:
            row = await conn.fetchrow(
                f"""
                UPDATE db_row_templates SET {set_sql}, updated_at = now()
                WHERE id = $1 AND user_id = $2
                RETURNING *
                """,
                template_id,
                user_id,
                *updates.values(),
            )
        except asyncpg.UniqueViolationError as exc:
            raise DuplicateDefaultTemplateError(
                "a default template already exists for this data source"
            ) from exc
    return _to_response(row) if row is not None else None


async def delete_template(conn: asyncpg.Connection, user_id: str, template_id: str) -> bool:
    row = await conn.fetchrow(
        """
        DELETE FROM db_row_templates WHERE id = $1 AND user_id = $2 RETURNING id
        """,
        template_id,
        user_id,
    )
    return row is not None


# ---------------------------------------------------------------------------
# Instantiation
# ---------------------------------------------------------------------------


async def instantiate_template(
    conn: asyncpg.Connection, user_id: str, template_id: str
) -> RowResponse | None:
    """Create a new row from a template: `properties` merged into the new
    row's `db_row_props.properties` (a captured key referencing a
    since-deleted property is silently dropped — the same "tolerate at
    read" convention `services/db/views.py`'s module docstring documents
    for a view's own dangling property references, applied here since this
    app has no sweep-templates-on-property-delete pass, per task-37-
    brief.md's reference facts), `content` copied verbatim into the new
    row's `notes.content`. Returns `None` if `template_id` doesn't exist
    (or isn't `user_id`'s) — the router/scheduler caller turns that into a
    404 / skips it, respectively.

    Relation-typed values in `properties` are passed through unfiltered —
    research §J.5.1's "don't fill in a relation property unless you want
    every instantiated row to relate to the same page" is user-facing
    authoring guidance, not something this function rejects or strips
    (task-37-brief.md decision 7).

    The new row's title is NOT set from the template's `name` — only from
    a captured `title`-typed property value, if any (task-37-brief.md
    decision 4). That sync happens inside `create_row_core` itself, reused
    rather than duplicated here.
    """
    row = await conn.fetchrow(
        """
        SELECT data_source_id, properties, content FROM db_row_templates
        WHERE id = $1 AND user_id = $2
        """,
        template_id,
        user_id,
    )
    if row is None:
        return None

    data_source_id = str(row["data_source_id"])
    existing_keys = {
        r["key"]
        for r in await conn.fetch(
            """
            SELECT key FROM db_properties WHERE data_source_id = $1 AND user_id = $2
            """,
            data_source_id,
            user_id,
        )
    }
    captured = row["properties"] or {}
    properties = {k: v for k, v in captured.items() if k in existing_keys}

    return await create_row_core(
        conn, user_id, data_source_id, properties=properties, content=row["content"] or []
    )
