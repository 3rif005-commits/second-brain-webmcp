"""Database automations (Milestone 12, task-38) — trigger/action CRUD, the shared
action-chain executor, its 6 database-automation action kinds, synchronous
`page_added`/`property_edited` firing, and the `every_frequency` half of the scheduler
tick.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §1, §3.2.
Research: docs/research/notion-databases-research.md §J.6.4-6.7 (~line 5827).
Migration: supabase/migrations/017_templates_automations.sql.

**File structure note for Task 39 (buttons):** `execute_action_chain` + its
module-level `ACTION_HANDLERS` dispatch table are surface-agnostic on purpose (task-38-
brief.md decision 1) — Task 39 registers 3 more action kinds
(`show_confirmation`/`open_page_or_url`/`insert_blocks`) into the SAME dict from its own
module, and calls `execute_action_chain` with its own, wider `allowed` set. Nothing in
this file needs to change for that to work.

This task builds exactly 6 action kinds — `edit_property`, `add_page_to`,
`edit_pages_in`, `send_notification`, `send_webhook`, `define_variables` — the set
`DATABASE_AUTOMATION_ACTIONS` below names. `send_mail_to`/`send_slack_notification_to`
are never registered at all (spec §1's non-goals table) — not stubbed, not reachable,
per task-38-brief.md's "Out of scope" section.
"""
from __future__ import annotations

import asyncio
import uuid as uuid_lib
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Awaitable, Callable

import asyncpg
import httpx

from models.database import AutomationCreate, AutomationResponse, AutomationUpdate
from services.db import notifications as notifications_service
from services.db import recompute
from services.db import rollup
from services.db.formula import evaluator, values as fvalues
from services.db.formula.parser import parse as parse_formula
from services.db.templates import seed_next_run_at, next_occurrence
from services.indexer import try_index_note


# ---------------------------------------------------------------------------
# Errors — "raise a typed exception in the service layer, map to HTTP in the
# router" (this file's own convention, matching TemplateConfigError/
# DuplicateDefaultTemplateError from Task 37 and RelationError from Task 21).
# ---------------------------------------------------------------------------


class AutomationConfigError(ValueError):
    """Raised for a save-time (create/update) shape problem in `triggers`/`actions` —
    currently just decision 3's every_frequency-exclusivity rule ("a recurring trigger
    ... can't be paired with another type of trigger", research §J.6.5). Migration 017's
    own header: a product rule, not a DDL-enforced invariant, same reasoning as
    `TemplateConfigError`."""


class ActionConfigError(Exception):
    """Raised by `execute_action_chain`/an action handler for a malformed or
    unresolvable action at RUN time (an unknown property_key, a `target` this
    automation has no trigger row for, an invalid `edit_pages_in.target` shape, etc.) —
    never framework-aware. Caught by `run_automations_for_trigger`/`_tick_automations`
    the same way any other action-chain exception is (decision 10): recorded into
    `db_automations.last_error`, never raised past that boundary."""


class ActionNotAllowedError(ActionConfigError):
    """The action's `"type"` isn't in the calling surface's `allowed` set (decision 1) —
    e.g. a button-only action (`show_confirmation`) configured on a database
    automation."""


class UnknownActionError(ActionConfigError):
    """The action's `"type"` isn't registered in `ACTION_HANDLERS` at all (a typo, or a
    kind neither this file nor Task 39's buttons module has ever registered)."""


class UnknownDataSourceError(ActionConfigError):
    """`add_page_to`/`edit_pages_in`'s `data_source_id` doesn't exist or isn't owned by
    `ctx.user_id` — task-38-brief.md's own reference facts name this by example ("an
    unknown target data source") as exactly the kind of clean, typed error this task
    should raise instead of letting an asyncpg.ForeignKeyViolationError surface."""


# ---------------------------------------------------------------------------
# Action-kind vocabulary for THIS calling surface (decision 1). Task 39 defines its
# own, wider set from its own module -- this one never changes for that to work.
# ---------------------------------------------------------------------------

DATABASE_AUTOMATION_ACTIONS: frozenset[str] = frozenset(
    {
        "edit_property",
        "add_page_to",
        "edit_pages_in",
        "send_notification",
        "send_webhook",
        "define_variables",
    }
)


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def _validate_triggers(triggers: list[Any]) -> None:
    """Decision 3a: an `every_frequency` trigger must be the triggers array's ONLY
    entry. `trigger_combinator` needs no special-casing here (decision 3: irrelevant
    when there's exactly one trigger anyway)."""
    kinds = [t.get("type") for t in triggers if isinstance(t, dict)]
    if "every_frequency" in kinds and len(triggers) > 1:
        raise AutomationConfigError(
            "an every_frequency trigger cannot be paired with any other trigger "
            "(research §J.6.5: \"a recurring trigger ... can't be paired with another "
            "type of trigger\")"
        )


def _seed_automation_next_run_at(triggers: list[Any]) -> datetime | None:
    """Decision 3b: `next_run_at` is seeded/reseeded the same way Task 37's row
    templates do (`seed_next_run_at`, exported from `services/db/templates.py` for
    exactly this reuse — see task-38-report.md's judgment-call section for why this was
    exported rather than forked). The `every_frequency` trigger dict IS a valid
    `repeat_config` for `seed_next_run_at`/`next_occurrence`'s purposes — it carries the
    same `frequency`/`interval`/`weekdays`/`start_date`/`time_of_day`/`timezone` keys,
    plus `end_date`, which both functions simply ignore (they only read the keys they
    need). `None` when there is no `every_frequency` entry (the common case — a
    `page_added`/`property_edited` automation never runs on a schedule)."""
    for t in triggers:
        if isinstance(t, dict) and t.get("type") == "every_frequency":
            return seed_next_run_at(t)
    return None


def _to_response(row: asyncpg.Record) -> AutomationResponse:
    return AutomationResponse(
        **{k: (str(v) if isinstance(v, uuid_lib.UUID) else v) for k, v in dict(row).items()}
    )


async def create_automation(
    conn: asyncpg.Connection, user_id: str, data_source_id: str, body: AutomationCreate
) -> AutomationResponse:
    _validate_triggers(body.triggers)
    next_run_at = _seed_automation_next_run_at(body.triggers)
    row = await conn.fetchrow(
        """
        INSERT INTO db_automations
            (data_source_id, user_id, name, is_active, trigger_combinator, triggers,
             view_id, actions, next_run_at, position)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                COALESCE(
                    (SELECT MAX(position) + 1 FROM db_automations
                     WHERE data_source_id = $1 AND user_id = $2),
                    0))
        RETURNING *
        """,
        data_source_id,
        user_id,
        body.name,
        body.is_active,
        body.trigger_combinator,
        body.triggers,
        body.view_id,
        body.actions,
        next_run_at,
    )
    return _to_response(row)


async def list_automations(
    conn: asyncpg.Connection, user_id: str, data_source_id: str
) -> list[AutomationResponse]:
    rows = await conn.fetch(
        """
        SELECT * FROM db_automations WHERE data_source_id = $1 AND user_id = $2 ORDER BY position
        """,
        data_source_id,
        user_id,
    )
    return [_to_response(r) for r in rows]


async def get_automation(
    conn: asyncpg.Connection, user_id: str, automation_id: str
) -> AutomationResponse | None:
    row = await conn.fetchrow(
        """
        SELECT * FROM db_automations WHERE id = $1 AND user_id = $2
        """,
        automation_id,
        user_id,
    )
    return _to_response(row) if row is not None else None


_AUTOMATION_UPDATABLE_FIELDS = (
    "name",
    "is_active",
    "trigger_combinator",
    "triggers",
    "view_id",
    "actions",
)
# view_id is migration 017's only nullable column among these -- same
# explicit-null-clears-a-nullable-column convention as
# `templates.py`'s `_TEMPLATE_NULLABLE_FIELDS`.
_AUTOMATION_NULLABLE_FIELDS = frozenset({"view_id"})


async def update_automation(
    conn: asyncpg.Connection, user_id: str, automation_id: str, body: AutomationUpdate
) -> AutomationResponse | None:
    """Partial update. When `triggers` is part of the update, it's re-validated
    (exclusivity) and `next_run_at` is reseeded from the NEW triggers array in the same
    statement -- a schedule change starts counting from its own anchor, same reasoning
    as `templates.py`'s `update_template`."""
    updates = {
        field_name: value
        for field_name, value in body.model_dump(exclude_unset=True).items()
        if field_name in _AUTOMATION_UPDATABLE_FIELDS
        and (value is not None or field_name in _AUTOMATION_NULLABLE_FIELDS)
    }
    if "triggers" in updates:
        _validate_triggers(updates["triggers"])
        updates["next_run_at"] = _seed_automation_next_run_at(updates["triggers"])

    if not updates:
        row = await conn.fetchrow(
            """
            SELECT * FROM db_automations WHERE id = $1 AND user_id = $2
            """,
            automation_id,
            user_id,
        )
    else:
        set_sql = ", ".join(f"{f} = ${i + 3}" for i, f in enumerate(updates))
        row = await conn.fetchrow(
            f"""
            UPDATE db_automations SET {set_sql}, updated_at = now()
            WHERE id = $1 AND user_id = $2
            RETURNING *
            """,
            automation_id,
            user_id,
            *updates.values(),
        )
    return _to_response(row) if row is not None else None


async def delete_automation(conn: asyncpg.Connection, user_id: str, automation_id: str) -> bool:
    row = await conn.fetchrow(
        """
        DELETE FROM db_automations WHERE id = $1 AND user_id = $2 RETURNING id
        """,
        automation_id,
        user_id,
    )
    return row is not None


# ---------------------------------------------------------------------------
# Action-chain executor (decision 1)
# ---------------------------------------------------------------------------


@dataclass
class ActionContext:
    """Task-38-brief.md decision 2's small, non-Pydantic dataclass — internal
    action-chain plumbing, not an API shape. `variables` is mutated in place as
    `define_variables` actions run (decision 2: "consumable by later actions in the
    same chain"). `now` is captured ONCE per chain execution by the caller (`run_
    automations_for_trigger`/`_tick_automations`), never re-read per action (reference
    facts' "one instant per pass" rule, mirroring `EvalContext`'s own docstring).
    `trigger_row_id` is `None` for an `every_frequency`-fired chain — there is no
    triggering page for a schedule-based run (research §J.6.5: "the Every {frequency}
    trigger works with all automation actions except for Edit property" is exactly this
    gap; every trigger-row-dependent action/formula raises a clean `ActionConfigError`
    when it's `None` rather than crashing).

    `source` is NOT one of decision 2's own listed fields — added because
    `send_notification` (decision 9) needs a `db_notifications.source` tag
    (`"automation:<id>"` here; Task 39's button surfaces will need their own, e.g.
    `"button:<property_key>"`) and nothing else in this dataclass says which. Flagged in
    task-38-report.md as a necessary addition beyond decision 2's literal field list.

    Task 39 (buttons) widens this dataclass three ways, all purely additive --
    every existing caller in THIS file (`run_automations_for_trigger`/`_tick_automations`)
    always sets a real `str` for `trigger_data_source_id` and never touches the two new
    fields, so it gets `confirmed=False`/`client_actions=[]` by default, unaffected:
    `trigger_data_source_id` widens from `str` to `str | None` (a button BLOCK can live
    on a plain note that is not a database row at all, task-39-brief.md decision 4 --
    every existing action handler in this file that reads it was individually checked
    against `None`, see task-39-report.md); `confirmed: bool` (decision 6, the two-phase
    `show_confirmation` flow -- `services/db/buttons.py`'s own handler); `client_actions:
    list[dict]` (decision 7, mutated in place the same way `variables` is, collecting
    `open_page_or_url`/`insert_blocks`'s resolve-only results for the caller to return to
    a future frontend).

    `allow_triggering_automations` (post-M12 live-check fix, controller-added): the 3
    action handlers that write rows (`edit_property`/`add_page_to`/`edit_pages_in`)
    pass this straight through to `create_row_core`/`update_row_property_core`'s own
    `trigger_automations` kwarg -- previously hardcoded `False` there unconditionally,
    which correctly stopped an AUTOMATION's own actions from re-firing automations
    (the documented recursion guard, `rows.py`'s module docstring), but ALSO silently
    suppressed automations for BUTTONS routing through these same shared handlers --
    contradicting research's own explicit, cited distinction: "Buttons can trigger
    database automations -- unlike automations themselves ... A user clicking a button
    that creates a page WILL trigger a database automation" (research §J.6.7). Verified
    live against the running app before this fix: clicking a button configured with
    `add_page_to` targeting a data source with its own `page_added` automation created
    the row but never fired the automation (row count 2->3, notification count
    unchanged). Defaults `False` so `run_automations_for_trigger`/`_tick_automations`
    (this file's own two callers, both automation-initiated) are completely unaffected
    -- neither sets this field, so the recursion guard holds exactly as before.
    `services/db/buttons.py`'s `run_button_actions` sets it `True`."""

    conn: asyncpg.Connection
    user_id: str
    trigger_data_source_id: str | None
    trigger_row_id: str | None
    now: datetime
    variables: dict[str, Any] = field(default_factory=dict)
    source: str = ""
    confirmed: bool = False
    client_actions: list[dict[str, Any]] = field(default_factory=list)
    allow_triggering_automations: bool = False


@dataclass(frozen=True)
class ActionChainResult:
    """Returned by `execute_action_chain`. Kept minimal (decision 1 doesn't ask for
    more) -- callers/tests assert on the real side effects the actions perform (a
    property changed, a row created, a notification row exists), not on this value.

    `client_actions` (task-39-brief.md decision 7) is purely additive -- populated from
    `ctx.client_actions` at the end of a chain run; every Task 38 caller's chain never
    populates `ctx.client_actions` (no button-only handler is ever in `allowed` for a
    database automation), so it stays `[]` for them, unaffected."""

    actions_run: int
    client_actions: list[dict[str, Any]] = field(default_factory=list)


ActionHandler = Callable[[dict[str, Any], ActionContext], Awaitable[None]]

# Module-level plain dict (decision 1: "an importer can extend, not a closure only this
# module can populate") -- Task 39 imports this dict directly and adds its own 3 button-
# only entries from its own module, with no edit to this file required.
ACTION_HANDLERS: dict[str, ActionHandler] = {}


def _register(name: str) -> Callable[[ActionHandler], ActionHandler]:
    def decorator(fn: ActionHandler) -> ActionHandler:
        ACTION_HANDLERS[name] = fn
        return fn

    return decorator


async def execute_action_chain(
    conn: asyncpg.Connection,
    ctx: ActionContext,
    actions: list[dict[str, Any]],
    *,
    allowed: frozenset[str],
) -> ActionChainResult:
    """Runs `actions` in order (research §J.6.4: "actions run as an ordered list"),
    dispatching each on its own `"type"` via `ACTION_HANDLERS`. An action whose type
    isn't in `allowed` for this calling surface raises `ActionNotAllowedError`; a type
    that isn't registered anywhere raises `UnknownActionError` -- both framework-free,
    per this file's error-handling convention. `conn` is accepted per decision 1's exact
    signature; every action handler actually reads/writes through `ctx.conn`, which
    every caller below constructs as the SAME connection passed here."""
    executed = 0
    for action in actions:
        kind = action.get("type") if isinstance(action, dict) else None
        if kind not in allowed:
            raise ActionNotAllowedError(f"action type {kind!r} is not allowed on this surface")
        handler = ACTION_HANDLERS.get(kind)
        if handler is None:
            raise UnknownActionError(f"unknown action type: {kind!r}")
        await handler(action, ctx)
        executed += 1
    return ActionChainResult(actions_run=executed, client_actions=ctx.client_actions)


# ---------------------------------------------------------------------------
# Dynamic (formula-resolvable) action fields (decision 7)
# ---------------------------------------------------------------------------


def _is_formula_ref(value: Any) -> bool:
    """True only for the exact `{"formula": "<source>"}` shape decision 7 defines --
    never for an ordinary property wrapper (which always carries a `"type"` key too) or
    a `define_variables` literal string."""
    return (
        isinstance(value, dict)
        and set(value.keys()) == {"formula"}
        and isinstance(value["formula"], str)
    )


async def _build_eval_context(
    conn: asyncpg.Connection, user_id: str, data_source_id: str, row_id: str
) -> tuple[dict[str, Any], dict[str, dict[str, Any]], list[str]]:
    """`(properties, related_properties, property_names)` for `row_id` -- the exact
    shape `evaluator.EvalContext` needs, built by calling `recompute.py`'s own private
    helpers (`_load_all_properties`/`_stored_values_for_rows`/`_build_related_
    properties`) rather than a second, forked JSONB-wrapper<->FValue codec.

    task-38-brief.md's own reference facts name `_stored_values_for_rows` and say to
    reuse it "or its exact pattern ... rather than re-deriving how to turn stored JSONB
    wrappers into FValues." Reusing the functions directly (instead of copying ~150
    lines of per-property-type decode/encode logic into this module) keeps that codec in
    exactly one place, at the cost of reaching across a module-private ("_"-prefixed)
    boundary. `routers/databases.py`'s `_parse_date_start` docstring states a discipline
    against this ("a router must not reach into a service module's underscore-prefixed
    helpers") -- that rule is about a ROUTER reaching into a service module; this is one
    service module (automations.py) reusing another's (recompute.py), which the brief
    itself explicitly sanctions with "or its exact pattern." Flagged in
    task-38-report.md as the judgment call it is."""
    all_records = await recompute._load_all_properties(conn, user_id)
    ds_records = [r for r in all_records if str(r["data_source_id"]) == data_source_id]
    stored_props = [r for r in ds_records if r["type"] not in ("formula", "rollup", "relation")]
    relation_props = [r for r in ds_records if r["type"] == "relation"]
    stored_ctx = await recompute._stored_values_for_rows(
        conn, user_id, data_source_id, [row_id], stored_props, relation_props
    )
    related_properties = await recompute._build_related_properties(
        conn, user_id, [row_id], stored_ctx, relation_props, all_records
    )
    property_names = [r["name"] for r in ds_records]
    return stored_ctx[row_id], related_properties, property_names


async def _resolve(value: Any, ctx: ActionContext) -> Any:
    """Decision 7's shared resolver: `value` is either a literal (returned unchanged)
    or `{"formula": "<source>"}`, parsed+evaluated against the trigger row's properties
    merged with `ctx.variables` (decision 2/8: a chain-local variable is referenceable
    by bare name exactly like a property, and shadows a same-named stored property if
    any) and `ctx.now`. Returns the raw `FValue` for a formula reference -- the caller
    decides how to turn that into text / a property wrapper / a stored variable."""
    if not _is_formula_ref(value):
        return value
    if ctx.trigger_row_id is None:
        raise ActionConfigError(
            "this action references a formula, but this automation run has no trigger "
            "row to evaluate it against (an every_frequency-triggered automation has no "
            "page context)"
        )
    # task-39-brief.md decision 4: a button BLOCK's trigger_row_id can be set (a real
    # note) while trigger_data_source_id is None (that note isn't a database row) --
    # unlike a database automation, where trigger_row_id and trigger_data_source_id are
    # always both-or-neither. Without this explicit guard, `_build_eval_context` below
    # would still run (data_source_id=None matches no db_properties/db_row_props rows,
    # so no asyncpg error), but would silently resolve the formula against an empty
    # property set instead of raising -- correct-ish for a formula that only references
    # `ctx.variables`, but silently wrong/confusing for one that references a real
    # property name, and inconsistent with `edit_property`'s own clean ActionConfigError
    # in the identical situation. Raising here uniformly, before that ambiguity can
    # arise, keeps "no data source for a formula to resolve against" a single clean
    # error rather than a data-dependent behavior.
    if ctx.trigger_data_source_id is None:
        raise ActionConfigError(
            "this action references a formula, but this automation run has no data "
            "source for its trigger row (a button block on a note that is not a "
            "database row has no property context to evaluate a formula against)"
        )
    properties, related_properties, property_names = await _build_eval_context(
        ctx.conn, ctx.user_id, ctx.trigger_data_source_id, ctx.trigger_row_id
    )
    merged_properties = {**properties, **ctx.variables}
    names = set(property_names) | set(ctx.variables)
    tree = parse_formula(value["formula"], property_names=names)
    eval_ctx = evaluator.EvalContext(
        properties=merged_properties,
        now=ctx.now,
        page_id=ctx.trigger_row_id,
        related_properties=related_properties,
    )
    return evaluator.evaluate(tree, eval_ctx)


async def _resolve_text(value: Any, ctx: ActionContext) -> str:
    """`send_notification.message`: a formula result renders via `stringify()` (the
    same "plain, unstyled stringification" `format()`/`+` use elsewhere in this
    engine); a literal is coerced to `str` defensively."""
    if _is_formula_ref(value):
        fv = await _resolve(value, ctx)
        return fvalues.stringify(fv)
    return "" if value is None else str(value)


async def _resolve_property_value(value: Any, ctx: ActionContext, prop_type: str) -> Any:
    """`edit_property.value` / `edit_pages_in.value` / `add_page_to.properties.*`: a
    literal is ALREADY a spec §3.3 wrapper, passed through unchanged; a formula result
    is converted back into one via `rollup.computed_wrapper` (the identical
    `{"type": X, X: value}` shape recompute.py's own formula materialisation writes)
    with `recompute._encode_fvalue` turning the FValue into a JSON-safe inner value --
    same reuse-not-refork reasoning as `_build_eval_context`."""
    if _is_formula_ref(value):
        fv = await _resolve(value, ctx)
        return rollup.computed_wrapper(prop_type, recompute._encode_fvalue(fv))
    return value


async def _property_type(
    conn: asyncpg.Connection, user_id: str, data_source_id: str, property_key: str
) -> str | None:
    row = await conn.fetchrow(
        """
        SELECT type FROM db_properties WHERE data_source_id = $1 AND user_id = $2 AND key = $3
        """,
        data_source_id,
        user_id,
        property_key,
    )
    return row["type"] if row is not None else None


def _target_row_ids(target: Any, ctx: ActionContext) -> list[str]:
    """`edit_pages_in.target` (decision 8, narrowed scope): `"trigger_row"` (Notion's
    "This page") or `{"variable_ref": "<name>"}` naming a variable a prior
    `define_variables` action populated with a `Page` or `list[Page]` (research
    §J.6.4's worked example: `Trigger page.Sub-item`). NOT a general filter-driven bulk
    edit across an arbitrary data source (decision 8)."""
    if target == "trigger_row":
        if ctx.trigger_row_id is None:
            raise ActionConfigError(
                "edit_pages_in target 'trigger_row' has no row for this automation run "
                "(an every_frequency-triggered automation has no trigger row)"
            )
        return [ctx.trigger_row_id]
    if isinstance(target, dict) and set(target.keys()) == {"variable_ref"}:
        name = target["variable_ref"]
        value = ctx.variables.get(name)
        if isinstance(value, fvalues.Page):
            return [value.id]
        if isinstance(value, list) and value and all(isinstance(v, fvalues.Page) for v in value):
            return [v.id for v in value]
        if isinstance(value, list) and not value:
            return []
        raise ActionConfigError(f"edit_pages_in: variable {name!r} is not a page/page-list value")
    raise ActionConfigError(f"edit_pages_in: invalid target: {target!r}")


# ---------------------------------------------------------------------------
# The 6 database-automation actions (decisions 1, 7, 8, 9)
# ---------------------------------------------------------------------------


@_register("edit_property")
async def _action_edit_property(action: dict[str, Any], ctx: ActionContext) -> None:
    """research §J.6.6: "edit the properties of pages in the database you are
    currently in" -- always the TRIGGER row, no `target` field (unlike `edit_pages_in`,
    documented separately as acting on "a database of your choosing")."""
    if ctx.trigger_row_id is None:
        raise ActionConfigError(
            "edit_property has no page to act on for this automation run (research "
            "§J.6.5: \"the Every {frequency} trigger works with all automation actions "
            "except for Edit property\")"
        )
    property_key = action.get("property_key")
    if not property_key:
        raise ActionConfigError("edit_property requires property_key")
    prop_type = await _property_type(
        ctx.conn, ctx.user_id, ctx.trigger_data_source_id, property_key
    )
    if prop_type is None:
        raise ActionConfigError(f"edit_property: unknown property_key {property_key!r}")
    value = await _resolve_property_value(action.get("value"), ctx, prop_type)

    from services.db.rows import update_row_property_core

    await update_row_property_core(
        ctx.conn,
        ctx.user_id,
        ctx.trigger_data_source_id,
        ctx.trigger_row_id,
        property_key,
        value,
        trigger_automations=ctx.allow_triggering_automations,
    )


@_register("add_page_to")
async def _action_add_page_to(action: dict[str, Any], ctx: ActionContext) -> None:
    """research §J.6.6: "add a page to a database of your choosing, and edit the
    properties of that page." `data_source_id` is validated against `ctx.user_id` up
    front (`UnknownDataSourceError`) rather than letting `create_row_core`'s INSERT
    surface a raw `asyncpg.ForeignKeyViolationError`."""
    target_ds = action.get("data_source_id")
    if not target_ds:
        raise ActionConfigError("add_page_to requires data_source_id")
    owned = await ctx.conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        target_ds,
        ctx.user_id,
    )
    if owned is None:
        raise UnknownDataSourceError(f"add_page_to: no such data source: {target_ds!r}")

    raw_properties = action.get("properties") or {}
    resolved: dict[str, Any] = {}
    for key, raw in raw_properties.items():
        prop_type = await _property_type(ctx.conn, ctx.user_id, target_ds, key)
        if prop_type is None:
            raise ActionConfigError(
                f"add_page_to: unknown property_key {key!r} on target data source"
            )
        resolved[key] = await _resolve_property_value(raw, ctx, prop_type)

    from services.db.rows import create_row_core

    result = await create_row_core(
        ctx.conn, ctx.user_id, target_ds, properties=resolved,
        trigger_automations=ctx.allow_triggering_automations,
    )
    # Fix 6 (task-51, M14 final cross-cutting review): best-effort, non-fatal
    # property-preamble refresh -- see `services/indexer.py`'s `try_index_note`
    # docstring. This can write into a DIFFERENT data source than the one whose
    # automation triggered it -- the triggering row getting indexed elsewhere (its
    # own write path) says nothing about THIS newly created row in `target_ds`,
    # which was permanently unsearchable by property value without this. Called
    # right after `create_row_core` returns, i.e. after ITS OWN transactional work
    # is done -- `create_row_core` opens `conn.transaction()` internally (a nested
    # SAVEPOINT here, since this action chain already runs inside one), so by the
    # time `await` above returns, that inner transaction has already exited.
    try_index_note(result.id, ctx.user_id)


@_register("edit_pages_in")
async def _action_edit_pages_in(action: dict[str, Any], ctx: ActionContext) -> None:
    """research §J.6.6: "edit pages and properties in a database of your choosing."
    Narrowed (decision 8) to ONE property_key/value pair per action -- symmetric with
    `edit_property`'s own shape and sufficient for research's own worked example
    (§J.6.4: one `Edit a property -> Status -> Complete` step) rather than an arbitrary
    properties dict. This one-property-at-a-time shape is this task's own
    simplification beyond decision 8's text, flagged in task-38-report.md."""
    data_source_id = action.get("data_source_id")
    if not data_source_id:
        raise ActionConfigError("edit_pages_in requires data_source_id")
    property_key = action.get("property_key")
    if not property_key:
        raise ActionConfigError("edit_pages_in requires property_key")
    row_ids = _target_row_ids(action.get("target"), ctx)
    prop_type = await _property_type(ctx.conn, ctx.user_id, data_source_id, property_key)
    if prop_type is None:
        raise ActionConfigError(f"edit_pages_in: unknown property_key {property_key!r}")
    value = await _resolve_property_value(action.get("value"), ctx, prop_type)

    from services.db.rows import update_row_property_core

    for row_id in row_ids:
        result = await update_row_property_core(
            ctx.conn,
            ctx.user_id,
            data_source_id,
            row_id,
            property_key,
            value,
            trigger_automations=ctx.allow_triggering_automations,
        )
        # Fix 6 (task-51, M14 final cross-cutting review): best-effort, non-fatal
        # property-preamble refresh -- see `_action_add_page_to`'s identical comment
        # just above and `services/indexer.py`'s `try_index_note` docstring. Same
        # cross-data-source subtlety: `data_source_id` here is "a database of your
        # choosing" (research §J.6.6), not necessarily the automation's own
        # triggering data source.
        #
        # Controller catch (post-task-51 verification, same class as scheduler.py's
        # _tick_templates): this is a `for row_id in row_ids:` LOOP -- `target` can
        # resolve to multiple rows (`_target_row_ids`) -- so a direct, unawaited call
        # to the synchronous, blocking `try_index_note` here reintroduces the exact
        # event-loop-starvation bug Fix 1 (same task-51 commit) closed for
        # `db_import.py`'s per-row loop, one function away in the same fix round.
        # `_action_add_page_to` just above is a single call (one row per action
        # invocation), so it doesn't need this -- only the loop does.
        await asyncio.to_thread(try_index_note, result.id, ctx.user_id)


@_register("send_notification")
async def _action_send_notification(action: dict[str, Any], ctx: ActionContext) -> None:
    """Decision 9: one `db_notifications` row, `link=None` for now (no "jump to the row
    that triggered this" deep link in this task -- flagged as a cheap future
    addition)."""
    message = await _resolve_text(action.get("message"), ctx)
    await notifications_service.create_notification(
        ctx.conn, ctx.user_id, message=message, source=ctx.source or None, link=None
    )


@_register("send_webhook")
async def _action_send_webhook(action: dict[str, Any], ctx: ActionContext) -> None:
    """Decision 7: `url` is literal-only, NEVER formula-resolved -- a user-configured
    chain that could compute an arbitrary outbound URL from row data is a needless
    self-inflicted risk surface for one line of research-documented behavior nothing in
    the plan's test list requires. `payload`, if present, is passed through as the POST
    body verbatim (not in decision 7's own enumerated dynamic-field list, so literal-
    only here too). Follows `services/ai/client.py`'s one outbound-httpx precedent in
    this codebase (a fresh `httpx.AsyncClient` per call, no retry/circuit-breaker
    wrapper) with a short, request-appropriate timeout (10s, not that module's 300s
    streaming-tuned one)."""
    url = action.get("url")
    if not isinstance(url, str) or not url:
        raise ActionConfigError("send_webhook requires a literal url")
    payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(url, json=payload)
        resp.raise_for_status()


@_register("define_variables")
async def _action_define_variables(action: dict[str, Any], ctx: ActionContext) -> None:
    """Decision 8: stores whatever the formula evaluates to -- a scalar `FValue`, or
    (research's own relation-traversal worked example) a `list[Page]` -- directly in
    `ctx.variables`, consumable by later actions in the SAME chain (mutated in place,
    decision 2). Decision 7: `formula` MAY itself be a literal (str/float/bool) instead
    of `{"formula": ...}` -- used AS the FValue directly, since Python str/float/bool
    ARE valid FValues (services/db/formula/values.py's own FValue union)."""
    name = action.get("name")
    if not name:
        raise ActionConfigError("define_variables requires a name")
    raw = action.get("formula")
    if _is_formula_ref(raw):
        fv = await _resolve(raw, ctx)
    elif isinstance(raw, bool):
        fv = raw
    elif isinstance(raw, (int, float)):
        fv = float(raw)
    elif isinstance(raw, str):
        fv = raw
    else:
        raise ActionConfigError(f"define_variables: unsupported formula value: {raw!r}")
    ctx.variables[name] = fv


# ---------------------------------------------------------------------------
# Synchronous trigger firing (decision 4) + property_edited condition matching
# (decision 6)
# ---------------------------------------------------------------------------


def _inner_value(wrapper: Any) -> Any:
    """A spec §3.3 wrapper's inner value, or `None` for anything that isn't one
    (including a genuine top-level `None` -- both mean "no value" for comparison
    purposes here)."""
    if not isinstance(wrapper, dict) or "type" not in wrapper:
        return None
    return wrapper.get(wrapper["type"])


def _trigger_entry_matches(
    entry: Any, event_type: str, event: dict[str, Any], old_value: Any, new_value: Any
) -> bool:
    """One `triggers[i]` entry against the (event_type, property_key, old_value,
    new_value) this single write represents. `page_added` always matches once its type
    matches. `property_edited` additionally requires the SAME `property_key`, then
    decision 6's 4-condition set (a small, explicit set -- NOT Notion's full per-type
    operator catalogue like "a phone number starting with 732", explicitly out of scope,
    see task-38-report.md). `every_frequency` never matches here -- it only ever fires
    from `_tick_automations`, never from this synchronous path."""
    if not isinstance(entry, dict) or entry.get("type") != event_type:
        return False
    if event_type == "page_added":
        return True
    if event_type == "property_edited":
        if entry.get("property_key") != event.get("property_key"):
            return False
        condition = entry.get("condition", "any_change")
        if condition == "any_change":
            return old_value != new_value
        if condition == "became_empty":
            return old_value is not None and new_value is None
        if condition == "became_non_empty":
            return old_value is None and new_value is not None
        if condition == "set_to":
            return _inner_value(new_value) == _inner_value(entry.get("value"))
        return False
    return False


async def _execute_and_record_error(
    conn: asyncpg.Connection,
    ctx: ActionContext,
    actions: list[Any],
    automation_id: str,
    user_id: str,
) -> None:
    """Runs one automation's action chain inside its own transaction. Since every
    caller below is already inside an ambient transaction (the row write that
    triggered this, or `_tick_automations`'s own per-automation transaction), asyncpg
    turns this `conn.transaction()` into a SAVEPOINT/ROLLBACK TO SAVEPOINT (the same
    nested-transaction behavior `routers/databases.py`'s `create_property` key-retry
    loop already relies on) -- so a mid-chain failure undoes only THIS automation's own
    partial writes, never the row write that triggered it, and never another due
    automation in the same pass.

    The exception is then caught and logged into `last_error` (decision 10: "any
    action-chain exception is caught, logged ... always, for visibility/debugging, but
    is_active is left untouched") -- never re-raised, so this automation's failure
    can't roll back the caller's own, already-good transaction, and can't stop the next
    due automation in the same run.

    A SUCCESSFUL run clears a stale `last_error` from some earlier failed run --
    decision 10 doesn't rule on this explicitly, but "last_error" naming the error from
    the automation's most recent run (not "the most recent error it ever had, even
    three successful runs ago") is the only reading that keeps the field meaningful as
    a live health signal rather than a permanent, increasingly-stale scar. Flagged in
    task-38-report.md as a judgment call beyond decision 10's own text."""
    try:
        async with conn.transaction():
            await execute_action_chain(
                conn, ctx, actions, allowed=DATABASE_AUTOMATION_ACTIONS
            )
    except Exception as exc:  # noqa: BLE001 -- decision 10: ANY action-chain exception
        await conn.execute(
            """
            UPDATE db_automations SET last_error = $1, updated_at = now()
            WHERE id = $2 AND user_id = $3
            """,
            str(exc)[:2000],
            automation_id,
            user_id,
        )
    else:
        await conn.execute(
            """
            UPDATE db_automations SET last_error = NULL, updated_at = now()
            WHERE id = $1 AND user_id = $2 AND last_error IS NOT NULL
            """,
            automation_id,
            user_id,
        )


async def run_automations_for_trigger(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    trigger: dict[str, Any],
    ctx_row_id: str,
    old_value: Any = None,
    new_value: Any = None,
) -> None:
    """Decision 4: fires every active automation on `data_source_id` whose `triggers`
    array has an entry matching `trigger` (`{"type": "page_added"}` or
    `{"type": "property_edited", "property_key": "..."}`), called from `rows.py`'s
    `create_row_core`/`update_row_property_core` right after their own transactional
    work, inside the SAME transaction (an automation failure never leaves a half-
    applied trigger write and a half-run automation in two different commit states --
    see `_execute_and_record_error`'s docstring for how that's reconciled with decision
    10's "log and continue").

    The `triggers @> $3` JSONB containment predicate is a coarse PRE-filter (any
    automation with AT LEAST ONE entry of this event's type) -- the real per-entry
    match (property_key + condition for `property_edited`) happens in Python via
    `_trigger_entry_matches`, since a JSONB containment query cannot express "a phone
    number starting with 732"-style condition logic (and this task doesn't attempt that
    catalogue either, decision 6).

    `view_id` scoping is NOT enforced here (decision 4, explicit scope cut) -- every
    automation on this data source fires regardless of its configured `view_id`;
    `view_id` is stored/returned by the CRUD endpoints but this function never checks
    row-in-view membership.

    `trigger_combinator == "all"` is evaluated against THIS SINGLE event only (no
    cross-event state is tracked) -- an "all" automation whose entries can't all be
    satisfied by one write (e.g. two different property_key conditions) will therefore
    functionally never fire from this synchronous path. A real gap beyond decision 4's
    own view_id cut, flagged in task-38-report.md."""
    event_type = trigger["type"]
    rows = await conn.fetch(
        """
        SELECT id, actions, trigger_combinator, triggers
        FROM db_automations
        WHERE data_source_id = $1 AND user_id = $2 AND is_active
          AND triggers @> $3::jsonb
        """,
        data_source_id,
        user_id,
        [{"type": event_type}],
    )
    now = datetime.now(timezone.utc)
    for row in rows:
        entries = row["triggers"] or []
        results = [
            _trigger_entry_matches(e, event_type, trigger, old_value, new_value)
            for e in entries
        ]
        satisfied = any(results) if row["trigger_combinator"] == "any" else (bool(results) and all(results))
        if not satisfied:
            continue
        automation_id = str(row["id"])
        ctx = ActionContext(
            conn=conn,
            user_id=user_id,
            trigger_data_source_id=data_source_id,
            trigger_row_id=ctx_row_id,
            now=now,
            variables={},
            source=f"automation:{automation_id}",
        )
        await _execute_and_record_error(conn, ctx, row["actions"] or [], automation_id, user_id)


# ---------------------------------------------------------------------------
# Scheduler tick — every_frequency half (decision 3)
# ---------------------------------------------------------------------------


async def _tick_automations(conn: asyncpg.Connection) -> int:
    """One pass over every ACTIVE automation due to run (`WHERE next_run_at <= now()
    AND is_active`, migration 017's own `db_automations_due_idx` covers exactly this).
    Not scoped to one `user_id` -- a system-wide background job, same reasoning
    `scheduler.py`'s `_tick_templates` already documents, and the same documented
    exception `tests/test_db_automations.py`'s own scope-predicate sweep carves out.

    For each due automation: run its action chain (no `trigger_row_id` -- an
    `every_frequency` trigger has no page, decision 2/research §J.6.5), catching/
    logging any failure into `last_error` the same way `run_automations_for_trigger`
    does (`_execute_and_record_error`, decision 10) -- a chain failure does NOT prevent
    `next_run_at` from advancing. Then computes the next occurrence via
    `next_occurrence`; if `end_date` is set and that computed occurrence's date is past
    it, `next_run_at` is cleared to `NULL` (the trigger stops firing -- `is_active`/the
    automation record itself is untouched, decision 3). Returns the number of
    automations fired (tests assert on this, mirroring `_tick_templates`)."""
    due = await conn.fetch(
        """
        SELECT id, user_id, data_source_id, triggers, actions, next_run_at
        FROM db_automations
        WHERE next_run_at IS NOT NULL AND is_active AND next_run_at <= now()
        """
    )
    fired = 0
    for row in due:
        automation_id = str(row["id"])
        user_id = str(row["user_id"])
        data_source_id = str(row["data_source_id"])
        trigger_entry = next(
            (
                t
                for t in (row["triggers"] or [])
                if isinstance(t, dict) and t.get("type") == "every_frequency"
            ),
            None,
        )
        async with conn.transaction():
            if trigger_entry is not None:
                ctx = ActionContext(
                    conn=conn,
                    user_id=user_id,
                    trigger_data_source_id=data_source_id,
                    trigger_row_id=None,
                    now=datetime.now(timezone.utc),
                    variables={},
                    source=f"automation:{automation_id}",
                )
                await _execute_and_record_error(
                    conn, ctx, row["actions"] or [], automation_id, user_id
                )
                new_next_run_at: datetime | None = next_occurrence(
                    trigger_entry, row["next_run_at"]
                )
                end_date = trigger_entry.get("end_date")
                if end_date and new_next_run_at.date() > date.fromisoformat(end_date):
                    new_next_run_at = None
            else:
                # Defensive: next_run_at somehow set with no every_frequency trigger
                # (shouldn't happen -- application code is the only writer of
                # next_run_at, and only ever sets it alongside such an entry) -- clear
                # it rather than looping on a tick that could never advance it.
                new_next_run_at = None
            await conn.execute(
                """
                UPDATE db_automations SET next_run_at = $1, updated_at = now()
                WHERE id = $2 AND user_id = $3
                """,
                new_next_run_at,
                automation_id,
                user_id,
            )
        fired += 1
    return fired
