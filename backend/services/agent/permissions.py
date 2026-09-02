"""Permission gate — enforces D6 tiers from the AI substrate spec.

Every tool call passes through check() before execution. Returns Allow or
Deny(reason). Deny is serialized as a tool_denied SSE event.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from models.agent import Tier


@dataclass(frozen=True)
class Allow:
    pass


@dataclass(frozen=True)
class Deny:
    reason: str


# Map each known tool to the minimum tier required. A tool can be present in
# the same tier multiple ways (e.g. denied for local_only); those checks
# happen below.
_TOOL_MIN_TIER: dict[str, Tier] = {
    # Read-only tools — all tiers
    "brain.search_brain":   Tier.EXTERNAL,
    "brain.get_note":       Tier.EXTERNAL,
    "brain.list_notes":     Tier.EXTERNAL,
    "brain.get_backlinks":  Tier.EXTERNAL,
    # Write tools — internal only
    "brain.create_note":    Tier.INTERNAL_API,
    "brain.update_note":    Tier.INTERNAL_API,
    "brain.patch_note":     Tier.INTERNAL_API,
    "brain.link_notes":     Tier.INTERNAL_API,
    "brain.set_mastery":    Tier.INTERNAL_API,
    "brain.move_note":      Tier.INTERNAL_API,
    "brain.delete_note":    Tier.INTERNAL_API,
    # Database tools (Milestone 14, task 49) — read tools are as safe as
    # brain.list_notes/get_note (scoped read-only queries through the same
    # compiler); the two writes sit at the same tier as create_note/
    # update_note above. Without an entry here every one of these 5 would
    # be denied at the gate with "unknown tool" before ever reaching
    # execute_brain_tool, regardless of any dispatch wiring below — the
    # brief's own research didn't name this file, but engine.py's call
    # sequence (permission_check before execute_brain_tool) makes it
    # load-bearing for the in-app agent path.
    "brain.list_databases":      Tier.EXTERNAL,
    "brain.get_database_schema": Tier.EXTERNAL,
    "brain.query_database":      Tier.EXTERNAL,
    "brain.create_row":          Tier.INTERNAL_API,
    "brain.update_row":          Tier.INTERNAL_API,
    # Editor tools — inline and ingest surfaces only
    "editor.insert_block":          Tier.INTERNAL_API,
    "editor.replace_block":         Tier.INTERNAL_API,
    "editor.delete_block":          Tier.INTERNAL_API,
    "editor.generate_interactive":  Tier.INTERNAL_API,
}


_TIER_ORDER: dict[Tier, int] = {
    Tier.EXTERNAL: 0,
    Tier.INTERNAL_API: 1,
    Tier.INTERNAL_LOCAL: 2,
}


def _tier_at_least(actual: Tier, required: Tier) -> bool:
    return _TIER_ORDER[actual] >= _TIER_ORDER[required]


def check(
    tool: str,
    tier: Tier,
    args: dict[str, Any],
    note_meta: dict[str, Any] | None,
) -> Allow | Deny:
    """Decide whether a tool call is permitted.

    Args:
        tool: namespaced tool name, e.g. "brain.search_brain"
        tier: the caller's permission tier
        args: the tool's arguments (used for local_only and confirm checks)
        note_meta: when the tool targets a note, the note's row (or None)
    """
    # MCP tools — allowed at internal tiers, denied externally
    if tool.startswith("mcp."):
        if tier == Tier.EXTERNAL:
            return Deny(reason="MCP tools are not available in external tier")
        return Allow()

    min_tier = _TOOL_MIN_TIER.get(tool)
    if min_tier is None:
        return Deny(reason=f"unknown tool: {tool}")

    if not _tier_at_least(tier, min_tier):
        return Deny(
            reason=f"tool {tool} requires {min_tier.value}, caller is {tier.value}"
        )

    # local_only enforcement (does NOT apply to INTERNAL_LOCAL)
    if tier in (Tier.EXTERNAL, Tier.INTERNAL_API):
        if note_meta and note_meta.get("local_only"):
            return Deny(
                reason=f"note is local_only — tool {tool} cannot be invoked in {tier.value} mode"
            )

    # Destructive ops require explicit confirm flag
    if tool == "brain.delete_note":
        if not args.get("confirm"):
            return Deny(
                reason="brain.delete_note requires confirm=true argument"
            )

    return Allow()
