"""Buttons (Milestone 12, task-39) — the button PROPERTY and button BLOCK surfaces on
top of task-38's shared action-chain executor: their own, wider action vocabularies
(`BUTTON_ACTIONS`/`BUTTON_BLOCK_ACTIONS`), the 3 button-only action kinds
(`show_confirmation`/`open_page_or_url`/`insert_blocks`), and `run_button_actions`, the
two click endpoints' shared entry point (decision 5/6).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §1, §5.
Research: docs/research/notion-databases-research.md §J.6.1-6.4 (~line 5756), §25
(~line 1623).
Builds directly on `services/db/automations.py` (task-38) — imports its
`ACTION_HANDLERS`/`_register`/`execute_action_chain`/`ActionContext`/`ActionChainResult`/
`ActionConfigError` and friends rather than forking them (that file's own header note
invites exactly this).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import asyncpg

from services.db.automations import (
    ActionConfigError,
    ActionContext,
    DATABASE_AUTOMATION_ACTIONS,
    _register,
    execute_action_chain,
)

__all__ = [
    "BUTTON_ACTIONS",
    "BUTTON_BLOCK_ACTIONS",
    "RequiresConfirmationError",
    "ButtonClickResult",
    "resolve_trigger_data_source_id",
    "run_button_actions",
]


# ---------------------------------------------------------------------------
# Action-kind vocabulary for these two calling surfaces (task-39-brief.md reference
# facts: "research §6.2's fuller list minus insert_blocks" for the property surface,
# "+insert_blocks" for the block surface — see task-39-report.md for the "8 vs 4"
# button-property action count judgment call).
# ---------------------------------------------------------------------------

BUTTON_ACTIONS: frozenset[str] = DATABASE_AUTOMATION_ACTIONS | {
    "show_confirmation",
    "open_page_or_url",
}

BUTTON_BLOCK_ACTIONS: frozenset[str] = BUTTON_ACTIONS | {"insert_blocks"}


class RequiresConfirmationError(Exception):
    """Raised by the `show_confirmation` handler when `ctx.confirmed` is False —
    meaningless for a database automation (which never has a confirming user), so this
    lives here, not in `automations.py`. Caught specifically by `run_button_actions`
    (decision 6), never propagated to the router as an HTTP error."""


@dataclass(frozen=True)
class ButtonClickResult:
    """`run_button_actions`'s return value — the framework-free counterpart to
    `automations.py`'s `ActionChainResult`, widened with decision 6/7's two extra
    fields. The router converts this 1:1 into `models.database.ButtonClickResponse`,
    the actual HTTP response body."""

    actions_run: int
    requires_confirmation: bool = False
    confirmation_message: str | None = None
    client_actions: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# The 3 button-only actions (decisions 6, 7). Registered into automations.py's SAME
# module-level ACTION_HANDLERS dict via the SAME _register decorator — nothing in
# automations.py needs to change for this.
# ---------------------------------------------------------------------------


@_register("show_confirmation")
async def _action_show_confirmation(action: dict[str, Any], ctx: ActionContext) -> None:
    """Decision 6: "a confirmation screen before the remaining actions run." Not
    confirmed yet -> raise (stops `execute_action_chain`'s loop exactly here, so
    anything before this action in the array has already run — the correct reading of
    "before the REMAINING actions run", not "before ALL actions run"). Already
    confirmed (this is the second, `confirmed=True` request re-running the same chain)
    -> no-op, let the loop continue past it."""
    if ctx.confirmed:
        return
    message = action.get("message")
    if not isinstance(message, str) or not message:
        message = "Are you sure you want to continue?"
    raise RequiresConfirmationError(message)


def _is_formula_ref_shaped(value: Any) -> bool:
    """A literal-only action field must reject the exact `{"formula": ...}` shape
    decision 7 of task-38-brief.md defines for OTHER actions' dynamic fields — even
    though `open_page_or_url`/`insert_blocks` never resolve it (research §J.6.1/6.4:
    "Formulas cannot be used in ... page/URL opening" / "... block insertion"), a
    formula-shaped value must still be REJECTED, not silently treated as a malformed
    literal that happens to not match the expected shape either way. This mirrors
    `automations._is_formula_ref` structurally without importing that module-private
    helper across a package boundary for a one-line predicate."""
    return (
        isinstance(value, dict)
        and set(value.keys()) == {"formula"}
        and isinstance(value["formula"], str)
    )


@_register("open_page_or_url")
async def _action_open_page_or_url(action: dict[str, Any], ctx: ActionContext) -> None:
    """Decision 7: literal-only, never formula-resolved. Validates `target`'s shape and
    appends a client-facing instruction to `ctx.client_actions` — this backend never
    navigates anything itself."""
    target = action.get("target")
    if _is_formula_ref_shaped(target):
        raise ActionConfigError(
            "open_page_or_url.target is literal-only and cannot be a formula "
            "(research: \"Formulas cannot be used in ... page/URL opening\")"
        )
    if not isinstance(target, dict) or "kind" not in target:
        raise ActionConfigError(
            "open_page_or_url requires a literal target: "
            '{"kind": "url", "url": "..."} or {"kind": "note", "note_id": "..."}'
        )
    kind = target.get("kind")
    if kind == "url":
        if not isinstance(target.get("url"), str) or not target["url"]:
            raise ActionConfigError("open_page_or_url target kind 'url' requires a literal url")
    elif kind == "note":
        if not isinstance(target.get("note_id"), str) or not target["note_id"]:
            raise ActionConfigError(
                "open_page_or_url target kind 'note' requires a literal note_id"
            )
    else:
        raise ActionConfigError(f"open_page_or_url: unknown target kind: {kind!r}")
    ctx.client_actions.append({"type": "open", **target})


_INSERT_BLOCKS_PLACEMENTS: frozenset[str] = frozenset(
    {"above_button", "below_button", "top_of_page", "bottom_of_page"}
)


@_register("insert_blocks")
async def _action_insert_blocks(action: dict[str, Any], ctx: ActionContext) -> None:
    """Decision 7: literal-only, never formula-resolved. `blocks` is an opaque BlockNote
    block array — this backend does not interpret its contents at all (Task 42's
    frontend does the actual `editor.insertBlocks` call); only `placement` is validated
    against the 4 named values."""
    blocks = action.get("blocks")
    if _is_formula_ref_shaped(blocks):
        raise ActionConfigError(
            "insert_blocks.blocks is literal-only and cannot be a formula "
            "(research: \"Formulas cannot be used in ... block insertion\")"
        )
    if not isinstance(blocks, list):
        raise ActionConfigError("insert_blocks requires a literal 'blocks' array")
    placement = action.get("placement")
    if placement not in _INSERT_BLOCKS_PLACEMENTS:
        raise ActionConfigError(
            f"insert_blocks: invalid placement {placement!r}; must be one of "
            f"{sorted(_INSERT_BLOCKS_PLACEMENTS)}"
        )
    ctx.client_actions.append({"type": "insert_blocks", "blocks": blocks, "placement": placement})


# ---------------------------------------------------------------------------
# Decision 4's data-source lookup — the ONE piece of new SQL this module needs. Every
# other lookup the two click endpoints need (property existence/type, note/row
# ownership) stays in the router, per routers/databases.py's own established
# convention of an inline tenancy check before delegating to a service call.
# ---------------------------------------------------------------------------


async def resolve_trigger_data_source_id(
    conn: asyncpg.Connection, user_id: str, note_id: str
) -> str | None:
    """Decision 4: is `note_id` (a button BLOCK's host note) actually a database row?
    `None` when it isn't — plain notes have no `db_row_props` companion row at all."""
    row = await conn.fetchrow(
        """
        SELECT data_source_id FROM db_row_props WHERE note_id = $1 AND user_id = $2
        """,
        note_id,
        user_id,
    )
    return str(row["data_source_id"]) if row is not None else None


# ---------------------------------------------------------------------------
# run_button_actions (decision 5/6) — the two click endpoints' shared entry point.
# ---------------------------------------------------------------------------


async def run_button_actions(
    conn: asyncpg.Connection,
    ctx: ActionContext,
    actions: list[dict[str, Any]],
    *,
    allowed: frozenset[str],
    confirmed: bool,
) -> ButtonClickResult:
    """Decision 5: NOT a bare `execute_action_chain` call, because of decision 6's
    two-phase confirmation handling — `RequiresConfirmationError` is caught here
    specifically and turned into a `requires_confirmation` result rather than
    propagating as an HTTP error. Every OTHER action-chain exception
    (`ActionConfigError`/`ActionNotAllowedError`/`UnknownActionError`/
    `UnknownDataSourceError`) is left to propagate uncaught — the router maps those to
    a clean 400 the same way it already does for every other typed service-layer
    exception in this file (decision 5's own text: "let a real failure propagate as an
    HTTP error the normal way").

    `confirmed` is set onto `ctx` before running — the caller (the router) builds
    `ctx` without needing to know about `confirmed` itself; this is the one seam where
    that request-body field actually reaches the action chain.

    `ctx.allow_triggering_automations = True` (post-M12 live-check fix, controller-
    added): unlike an automation's own action chain (which must never re-trigger
    automations — the recursion guard `ActionContext`'s own docstring documents), a
    BUTTON'S action chain legitimately should — research §J.6.7: "Buttons can trigger
    database automations — unlike automations themselves ... A user clicking a button
    that creates a page WILL trigger a database automation." Live-verified against the
    running app before this fix that it was silently NOT happening (a button's
    `add_page_to` created the row but the target data source's `page_added` automation
    never fired); this is the one-line fix for that, set here so BOTH button surfaces
    (property click, block click) get it for free without either router endpoint
    needing to know about it.
    """
    ctx.confirmed = confirmed
    ctx.allow_triggering_automations = True
    try:
        result = await execute_action_chain(conn, ctx, actions, allowed=allowed)
    except RequiresConfirmationError as exc:
        # Decision 6: exactly this shape, regardless of how many actions ran before
        # show_confirmation raised (their real side effects already happened and are
        # not undone — only the RESPONSE's actions_run/client_actions are zeroed,
        # since nothing about "what already ran" is this response's job to report).
        return ButtonClickResult(
            actions_run=0,
            requires_confirmation=True,
            confirmation_message=str(exc),
            client_actions=[],
        )
    return ButtonClickResult(
        actions_run=result.actions_run,
        client_actions=result.client_actions,
    )
