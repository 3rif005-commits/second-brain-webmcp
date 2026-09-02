"""backend/services/db/rows.py — the transactional core of "create a database row" (a
Notion-style row IS a note: `db_row_props.note_id` is a FK to `notes.id`), extracted out
of `routers/databases.py`'s `create_row` (task-37, Milestone 12) so Task 38's automations
(`add_page_to`/`edit_pages_in`) and this task's own template instantiation
(`services/db/templates.py`'s `instantiate_template`) can create rows without going
through HTTP.

`create_row_core` is `create_row`'s entire previous transactional body, byte-identical
for every existing caller (title stays `"Untitled"`, properties stays `{}`, content stays
`[]`) — the router's `create_row` is now a thin wrapper: validate the data source exists
and is owned by `user_id` (and, per task-37 decision 3, look up a default template),
then call this.

`update_row_property_core` (task-38-brief.md decision 5) is the same move applied to
`update_row_property` — its full pre-transaction validation (relation-type rejection,
wrapper-shape check) and transactional body (the Milestone 7 date-shift cascade, the
title-sync block) moved here verbatim; `routers/databases.py`'s `update_row_property` is
now a thin wrapper that does the data-source-ownership check, calls this, and maps its
framework-free typed exceptions to HTTP (same "raise a typed exception in the service
layer, map to HTTP in the router" convention `services/db/templates.py`'s
`DuplicateDefaultTemplateError`/`TemplateConfigError` and `services/db/relations.py`'s
`RelationError` already establish — `RelationError`/`ValueError` raised by
`cascade_dependency_shift` below are deliberately NOT caught here, for the same reason:
they already are framework-free, and the router already has a mapping seam
(`_relation_error_to_http`) for them).

Both `*_core` functions optionally fire Milestone 12 automations (task-38-brief.md
decision 4) right after their own transactional work, inside the SAME transaction — a
`page_added` hook in `create_row_core`, a `property_edited` hook in
`update_row_property_core`. `trigger_automations` (default `True`) exists so
`services/db/automations.py`'s own `add_page_to`/`edit_pages_in` action handlers — which
call these same two functions to make an automation's OWN row writes happen — can pass
`trigger_automations=False` and not re-fire automations from inside an automation's own
action chain. This guard isn't spelled out by name in task-38-brief.md's decision list,
but research §J.6.7 is explicit that Notion itself forbids exactly this ("Database
automations can't be triggered by other automations ... A database automation creating a
page in another database will not trigger a database automation"), and without it a
chain of automations that write into each other's trigger conditions would recurse
without bound — flagged in task-38-report.md as a judgment call beyond the brief's own
ruling.

`services/db/automations.py` is imported lazily (inside the two functions below, not at
module level) to break an import cycle: `automations.py` imports `create_row_core`/
`update_row_property_core` from this module for its own `add_page_to`/`edit_pages_in`
action handlers, so this module cannot import `automations.py` at the top level too.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import asyncpg

from models.database import RowResponse, ShiftedRow
from services.db import recompute
from services.db.relations import SHIFT_NEVER, cascade_dependency_shift, relation_ref_from_config


class PropertyNotFoundError(Exception):
    """`property_key` doesn't exist on this `data_source_id` (or isn't `user_id`'s) —
    `update_row_property_core`'s router wrapper maps this to a 404, same status
    `update_row_property` always returned for this case pre-extraction."""


class RowNotFoundError(Exception):
    """`note_id` doesn't exist under this `data_source_id` (or isn't `user_id`'s),
    discovered when the UPDATE itself returns no row — including the original inline
    handler's concurrent-delete race (a row deleted between the property lookup above and
    the UPDATE below). Router wrapper maps this to a 404."""


class RowPropertyValueError(ValueError):
    """400-mapped config/shape problems, preserved byte-identical (same message text) from
    `update_row_property`'s pre-extraction inline `HTTPException`s: a relation-typed
    `property_key` (write it via the relations endpoints instead), a non-JSONB-backed
    property, or a value wrapper whose `"type"` tag doesn't match the property's declared
    type."""


def _parse_date_start(value: Any) -> "datetime | None":
    """Extracts just the `start` instant from a spec §3.3 date wrapper
    (`{"type": "date", "date": {"start": ..., "end": ..., "time_zone": ...}}`) — the seam
    where `update_row_property_core` computes the delta Milestone 7's dependency cascade
    needs (task-21-brief.md §4). `None` for anything that isn't a usable start (a clear, a
    wrapper missing `start`, a malformed value) — the caller treats that as "no cascade is
    possible here", the same "no date -> not part of the shift graph" stance
    `services.db.relations.cascade_dependency_shift`'s own docstring takes (task-20-
    report.md judgement call 8). Moved here verbatim from `routers/databases.py` (task-38
    extraction, decision 5) — same ISO normalisation as `services/db/relations.py`'s
    private `_parse_iso`, duplicated rather than imported, per that module's own stated
    discipline against reaching into another module's underscore-prefixed helpers."""
    if not isinstance(value, dict):
        return None
    date = value.get("date")
    if not isinstance(date, dict):
        return None
    start = date.get("start")
    if not isinstance(start, str):
        return None
    normalised = start[:-1] + "+00:00" if start.endswith("Z") else start
    try:
        parsed = datetime.fromisoformat(normalised)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


async def create_row_core(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    *,
    title: str = "Untitled",
    properties: dict[str, Any] | None = None,
    content: list[Any] | None = None,
    trigger_automations: bool = True,
) -> RowResponse:
    """Create one row (a `notes` row + its `db_row_props` companion, spec Q2: "a database
    row IS a note") in one transaction, then recompute its formula/rollup properties inside
    the SAME transaction — copied verbatim from `create_row`'s previous inline body
    (`routers/databases.py`, pre-task-37), not reimplemented.

    `properties`/`content` default to `{}`/`[]` — the plain "+ New row" path (no template)
    passes neither, so this reproduces `create_row`'s exact pre-task-37 INSERTs (an
    explicit `properties = {}`/`content = []` write is byte-identical to relying on the
    columns' own defaults, since that IS both columns' default — `supabase/migrations/
    001_initial_schema.sql`'s `notes.content` and `db_row_props.properties`).

    Title / title-property sync (task-37-brief.md decision 4): a caller (template
    instantiation) MAY capture a `title`-typed property inside `properties` — when it
    does, `notes.title` reflects that captured value, same as `update_row_property`'s
    existing title<->`notes.title` sync convention (`routers/databases.py`'s
    `update_row_property`, the `if prop_row["type"] == "title":` block) — reused here
    rather than reinvented, since the wrapper's own `"type"` tag (spec §3.3) already
    says "title" without needing a `db_properties` lookup. The explicit `title` kwarg
    (still `"Untitled"` for the ordinary no-template path) is the fallback when
    `properties` carries no title value.
    """
    properties = properties if properties is not None else {}
    content = content if content is not None else []

    for value in properties.values():
        if isinstance(value, dict) and value.get("type") == "title":
            title = value.get("title") or title
            break

    async with conn.transaction():
        note_row = await conn.fetchrow(
            """
            INSERT INTO notes (user_id, title, content)
            VALUES ($1, $2, $3)
            RETURNING id
            """,
            user_id,
            title,
            content,
        )
        # Without an explicit position, every created row defaults to 0 (migration
        # 014), so list_rows's `ORDER BY position` is an unbroken tie among them and
        # rows can visibly reshuffle between GETs once 2+ exist. Append to the end.
        row = await conn.fetchrow(
            """
            INSERT INTO db_row_props (note_id, data_source_id, user_id, properties, position)
            VALUES ($1, $2, $3, $4,
                    COALESCE(
                        (SELECT MAX(position) + 1 FROM db_row_props
                         WHERE data_source_id = $2 AND user_id = $3),
                        0))
            RETURNING note_id, properties
            """,
            note_row["id"],
            data_source_id,
            user_id,
            properties,
        )
        # Milestone 8 (task-28-brief.md §3): "row write (update_row_property, create_row)
        # -> incremental recompute of that row" -- inside the same transaction as the
        # insert. If recompute raises, the write rolls back.
        await recompute.recompute_row(conn, user_id, data_source_id, str(row["note_id"]))

        # Milestone 12 (task-38-brief.md decision 4): `page_added` automations fire
        # synchronously, inside this same transaction, right after this row's own
        # transactional work -- see this module's docstring for `trigger_automations`.
        if trigger_automations:
            from services.db import automations as automations_service

            await automations_service.run_automations_for_trigger(
                conn, user_id, data_source_id, {"type": "page_added"}, str(row["note_id"])
            )
    return RowResponse(id=str(row["note_id"]), properties=row["properties"])


async def update_row_property_core(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    note_id: str,
    property_key: str,
    value: Any,
    *,
    trigger_automations: bool = True,
) -> RowResponse:
    """Write a single property's value on a single row — extracted verbatim (task-38-
    brief.md decision 5) from `routers/databases.py`'s `update_row_property`, which is now
    a thin wrapper: parse/404 the path params, check data-source ownership, call this, map
    its typed exceptions to HTTP. See this module's docstring for the extraction's error-
    handling convention and the `trigger_automations` kwarg.

    `value` is the full spec §3.3 wrapper (e.g. `{"type": "status", "status": "done"}`,
    matching what `GET .../rows` returns and what's actually stored) or `None` to
    clear/unset the property (spec §3.3: "Absent key ≡ empty" — never a bare scalar).

    Ordinary data sources only — the All Notes virtual-source rejection stays in the
    router (it never reaches this function; that check needs no `conn` access and every
    other `*_core` caller is never routing through All Notes in the first place).
    """
    # Milestone 7: widened to also pull the row's pre-write value for this key in the same
    # round trip (task-21-brief.md §4). The LEFT JOIN means `old_value` is SQL NULL (not an
    # error) whenever the row has no db_row_props value yet for this key, or no
    # db_row_props row at all -- both mean "no old date to diff against" to the cascade
    # logic below, and (task-38) "no old value to diff against" to the property_edited
    # trigger-matching logic.
    prop_row = await conn.fetchrow(
        """
        SELECT dp.storage, dp.type, drp.properties -> dp.key AS old_value
        FROM db_properties dp
        LEFT JOIN db_row_props drp
          ON drp.note_id = $2 AND drp.data_source_id = $1 AND drp.user_id = $3
        WHERE dp.data_source_id = $1 AND dp.user_id = $3 AND dp.key = $4
        """,
        data_source_id,
        note_id,
        user_id,
        property_key,
    )
    if prop_row is None:
        raise PropertyNotFoundError(f"property not found: {property_key!r}")
    if prop_row["type"] == "relation":
        # task-21-brief.md §1: writing any key into db_row_props.properties for a
        # relation-typed property would create exactly the second copy migration 015's
        # whole design forbids (its header: "the JSONB is not the source of truth for
        # relations"). `db_relation_links`, via the relations endpoints, is the only legal
        # way to change a relation's value.
        raise RowPropertyValueError(
            "relation properties are not writable through this endpoint -- use "
            f"GET/PUT /db/data-sources/{data_source_id}/rows/{note_id}/relations/"
            f"{property_key} (and its /links sub-paths) instead"
        )
    if prop_row["storage"] != "jsonb":
        raise RowPropertyValueError("property is not JSONB-backed")

    # task-10 review finding 2: every stored value is a discriminated wrapper
    # (`{"type": <type>, <type>: <value>}`) matching its property's declared type --
    # Milestone 3's filter/sort compiler assumes that invariant holds. `None` (clear-
    # property) is exempt. Deliberately shallow: only the wrapper's `type` tag is checked,
    # not that the inner value is well-formed for that type.
    if value is not None:
        if not isinstance(value, dict) or value.get("type") != prop_row["type"]:
            raise RowPropertyValueError(
                f"value must be a {prop_row['type']!r} wrapper, e.g. "
                f'{{"type": "{prop_row["type"]}", ...}}'
            )
        # Fix 2 (task-51, M14 final cross-cutting review): unlike the agent-tools/
        # internal-API write path (`services/agent/brain_tools.py`'s
        # `coerce_property_write` -> `REGISTRY[type].coerce_write`, which now guards
        # this in `scalar.py`'s `Number.coerce_write`), this function -- the shared
        # core BOTH the PATCH cell-edit endpoint and every automation action handler
        # write through -- accepts `value` as an already-built wrapper with no
        # per-type coercion/validation at all. A too-large Python int (unbounded, so
        # `isinstance(raw, (int, float))`-shaped checks never catch it) sails
        # through as a "well-formed" number wrapper, gets written, then raises an
        # unhandled `OverflowError` (not a `ValueError`, so nothing here or in the
        # router's exception mapping would otherwise catch it) the moment
        # `recompute_row` below decodes it. Guarded narrowly here (just the number-
        # overflow class this fix round is about, not a general coerce_write
        # integration for every property type -- that's a bigger, separate scope).
        if prop_row["type"] == "number":
            raw_number = value.get("number")
            if isinstance(raw_number, (int, float)) and not isinstance(raw_number, bool):
                try:
                    float(raw_number)
                except OverflowError as exc:
                    raise RowPropertyValueError(
                        f"number value out of range: {raw_number!r}"
                    ) from exc

    # Milestone 7: the write and the (possible) dependency cascade it triggers must commit
    # or roll back together (task-21-brief.md §4) -- both live inside one transaction.
    old_start = _parse_date_start(prop_row["old_value"])
    shifted_rows: list[ShiftedRow] | None = None
    async with conn.transaction():
        if value is None:
            # A top-level `null` means "clear/unset this property", not "set its value to
            # SQL NULL" -- `db_row_props.properties` is NOT NULL (migration 014), and
            # `jsonb_set(properties, path, NULL, true)` would set the *entire column* to
            # NULL, not just this key. `properties - key` drops just the one key; spec
            # §3.3: "Absent key ≡ empty."
            row = await conn.fetchrow(
                """
                UPDATE db_row_props
                SET properties = properties - $1, updated_at = now()
                WHERE note_id = $2 AND data_source_id = $3 AND user_id = $4
                RETURNING note_id, properties
                """,
                property_key,
                note_id,
                data_source_id,
                user_id,
            )
        else:
            row = await conn.fetchrow(
                """
                UPDATE db_row_props
                SET properties = jsonb_set(properties, $1, $2, true), updated_at = now()
                WHERE note_id = $3 AND data_source_id = $4 AND user_id = $5
                RETURNING note_id, properties
                """,
                [property_key],
                value,
                note_id,
                data_source_id,
                user_id,
            )
        if row is None:
            raise RowNotFoundError(f"row not found: {note_id!r}")

        # A database row IS a note, and its human-readable name lives in TWO places -- the
        # `title`-typed property in `db_row_props.properties` and `notes.title` (what every
        # OTHER surface renders: the sidebar, search, relation chips). Kept inside the same
        # transaction as the property write: the two copies of the title must not be able
        # to disagree. A cleared title (`value is None`) falls back to 'Untitled', matching
        # what `create_row_core` seeds a fresh note with.
        if prop_row["type"] == "title":
            new_title = (value or {}).get("title") or "Untitled"
            await conn.execute(
                """
                UPDATE notes SET title = $1, updated_at = now()
                WHERE id = $2 AND user_id = $3
                """,
                new_title,
                note_id,
                user_id,
            )

        # Milestone 7 dependency date-shift cascade (task-21-brief.md §4). Only considered
        # for a successful write to a `date` property where both the old and the new value
        # have a usable `start`. Deliberately NOT gated on `new_start != old_start`: a
        # write that only changes `end` must still reach cascade_dependency_shift, since
        # SHIFT_WHEN_OVERLAP depends on the blocker's *end*, not its start.
        if prop_row["type"] == "date":
            new_start = _parse_date_start(value)
            if old_start is not None and new_start is not None:
                dep_row = await conn.fetchrow(
                    """
                    SELECT config FROM db_properties
                    WHERE data_source_id = $1 AND user_id = $2 AND type = 'relation'
                      AND config->>'system' = 'dependency' AND config->>'side' = 'forward'
                    """,
                    data_source_id,
                    user_id,
                )
                if (
                    dep_row is not None
                    and dep_row["config"].get("date_property_key") == property_key
                ):
                    dep_ref = relation_ref_from_config(dep_row["config"])
                    if dep_ref is not None:
                        # RelationError/ValueError propagate uncaught -- this module is
                        # framework-free (see docstring); the router's own mapping seam
                        # (`_relation_error_to_http`) catches them.
                        changes = await cascade_dependency_shift(
                            conn,
                            user_id,
                            dep_ref,
                            changed_row_id=note_id,
                            delta=new_start - old_start,
                            mode=dep_row["config"].get("date_shift_mode") or SHIFT_NEVER,
                            avoid_weekends=bool(dep_row["config"].get("avoid_weekends", False)),
                            date_property_key=property_key,
                        )
                        if changes:
                            shifted_rows = [
                                ShiftedRow(
                                    id=shifted_id,
                                    properties={
                                        property_key: {
                                            "type": "date",
                                            "date": {
                                                "start": window.start.isoformat(),
                                                "end": (
                                                    window.end.isoformat()
                                                    if window.end is not None
                                                    else None
                                                ),
                                                "time_zone": None,
                                            },
                                        }
                                    },
                                )
                                for shifted_id, window in changes.items()
                            ]

        # Milestone 8 (task-28-brief.md §3): recompute this row -- and, if the M7 cascade
        # above moved any OTHER rows, each of those too -- inside THIS SAME transaction.
        written = await recompute.recompute_row(conn, user_id, data_source_id, note_id)
        for shifted in shifted_rows or []:
            await recompute.recompute_row(conn, user_id, data_source_id, shifted.id)

        # Milestone 12 (task-38-brief.md decision 4): `property_edited` automations fire
        # synchronously, right after this row's own transactional work (including the M7
        # cascade/recompute above), inside the SAME transaction -- see this module's
        # docstring for `trigger_automations`. Reuses the `old_value` this function already
        # fetched for the M7 cascade rather than a second read (decision 6).
        if trigger_automations:
            from services.db import automations as automations_service

            await automations_service.run_automations_for_trigger(
                conn,
                user_id,
                data_source_id,
                {"type": "property_edited", "property_key": property_key},
                note_id,
                old_value=prop_row["old_value"],
                new_value=value,
            )

    # `written` (this row's own freshly materialised formula/rollup values) merges into the
    # response the same way `_merge_computed_into_rows` does for a listing/query. A `None`
    # entry (the value is now EMPTY, spec §3.3's "absent key" convention) is omitted.
    merged_properties = {
        **row["properties"],
        **{k: v for k, v in written.items() if v is not None},
    }
    return RowResponse(
        id=str(row["note_id"]), properties=merged_properties, shifted_rows=shifted_rows
    )
