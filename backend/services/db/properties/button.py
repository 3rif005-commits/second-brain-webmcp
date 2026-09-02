"""Button (Milestone 12, task-39) — a property type that carries no per-row value at
all: research §25, "not a data-carrying property ... every row shows the same button."
Its only real content is the action chain in `db_properties.config.actions` (task-39-
brief.md decision 2), executed by `services/db/buttons.py`'s `run_button_actions`, not
this descriptor — this file only has to make M3/M4's generic machinery (operators,
aggregations, coercion) correctly refuse to treat "button" like an ordinary JSONB-backed
type, the same "framework-free hard failure, the compiler should never reach this" stance
`properties/relation.py`'s own descriptor takes for a different reason (no JSONB copy of
its value at all).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §5.
Research: docs/research/notion-databases-research.md §25 (~line 1623), §J.6.1-6.4
(~line 5756).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from .base import Operator, SqlContext, SqlFragment, _EmptyConfig

__all__ = ["Button"]


@dataclass(frozen=True)
class Button:
    key: str = "button"
    # No dedicated config model (task-39-brief.md decision 2): a button property's
    # `config.actions` is JSONB pass-through, identical in shape to
    # `db_automations.actions` — validated (if at all) by `execute_action_chain`/
    # `ACTION_HANDLERS` at RUN time, not by a Pydantic model at save time. Same
    # "nothing validates config_model at write time today" fact `RelationConfig`'s own
    # docstring names — `_EmptyConfig` here is a placeholder to satisfy the
    # `PropertyType` protocol, not a real constraint on `config`.
    config_model: type[BaseModel] = _EmptyConfig

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        # research §25: "every row shows the same button" — there is no per-row value
        # to be empty/non-empty about, so this is unconditionally True (decision 1),
        # never a `value is None`-style check like _GenericProperty's default.
        return True

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        # Never reached in practice: operators()/aggregations() are both empty, so
        # M3's filter compiler and M4's aggregation compiler have nothing that would
        # ever route a button property here. Raises rather than returning a dummy
        # fragment (mirroring Relation.sql_extract's identical stance) so a future
        # regression in those guards is loud instead of silently wrong.
        raise ValueError(
            "button properties have no JSONB value to extract — operators()/"
            "aggregations() are both empty, so the filter/sort/aggregation compiler "
            "should never reach this"
        )

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        raise ValueError(
            "button properties have no JSONB value to order by — operators()/"
            "aggregations() are both empty, so the sort compiler should never reach this"
        )

    def operators(self) -> dict[str, Operator]:
        # research §25: "Filters: none" — not even is_empty/is_not_empty, a real,
        # deliberate narrowing from _GenericProperty's default pair (decision 1).
        return {}

    def aggregations(self) -> set[str]:
        # Makes M4's "6 non-groupable types" list (files/rollup/unique_id/
        # verification/button/place) true for "button" by construction, not by
        # coincidence of falling through to the generic descriptor.
        return set()

    def coerce_write(self, raw: Any) -> Any:
        # Hard failure, not a silent accept, regardless of `raw` (including None) —
        # `coerce_write` has zero production call sites today (task-39-brief.md
        # reference facts), and a button property's action chain is set via
        # create_property/update_property's `config`, never via a db_row_props write.
        raise ValueError(
            "button values are not written through db_row_props — a button "
            "property's action chain lives in db_properties.config.actions (set via "
            "create_property/update_property); clicking it goes through "
            "POST .../buttons/{property_key}/click, never a row-property write"
        )
