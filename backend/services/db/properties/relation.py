"""Relation: Milestone 7's real descriptor, replacing `_GenericProperty`'s
placeholder JSONB-array handling (task-20-brief.md §2).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §9.
Migration: supabase/migrations/015_relations.sql -- `db_relation_links` is
the single source of truth for relation values; this descriptor exists so
that fact is structural, not a convention someone can forget.

Unlike every other type in this package, Relation's SQL depends on the
relation's *identity* (`relation_id`/`side`), not just its JSONB key --
`SqlContext.relation`/`row_id_expr` (properties/base.py) carry that in, and
`query/operators.py`'s `compile_condition` special-cases `prop_type ==
"relation"` *before* ever calling `sql_extract` (there is nothing in the
JSONB for it to extract). `sql_extract` here exists only to satisfy the
`PropertyType` protocol and to fail loudly if something ever does call it
directly, mirroring `coerce_write`'s hard failure below.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ConfigDict

from .base import Operator, SqlContext, SqlFragment

__all__ = ["Relation", "RelationConfig"]


class RelationConfig(BaseModel):
    """Documents the `config` shape migration 015's header and
    `services/db/relations.py` define; nothing in this codebase currently
    validates `db_properties.config` against a `config_model` at write time
    (routers/databases.py's `create_property` accepts `body.config` as an
    arbitrary dict) -- this exists to satisfy the `PropertyType` protocol
    and as documentation, the same role `DateConfig`/`_EmptyConfig` play
    for their types."""

    model_config = ConfigDict(extra="forbid")

    relation_id: str | None = None
    side: str | None = None
    target_data_source_id: str | None = None
    system: str | None = None
    # Dependency-only (forward property, `system == "dependency"`).
    date_shift_mode: str | None = None
    avoid_weekends: bool | None = None
    date_property_key: str | None = None


_RELATION_OPS: tuple[Operator, ...] = (
    Operator(name="contains", arg_type="uuid"),
    Operator(name="does_not_contain", arg_type="uuid"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)


@dataclass(frozen=True)
class Relation:
    key: str = "relation"
    config_model: type[BaseModel] = RelationConfig

    def default(self) -> Any:
        return []

    def is_empty(self, value: Any) -> bool:
        return not value

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        # Never called on the filter path (operators.py's compile_condition
        # special-cases "relation" before reaching sql_extract) or the sort
        # path (sql_order below doesn't delegate to this). Raises rather
        # than emitting a JSONB path, for the same reason coerce_write
        # raises: there is no JSONB copy of a relation's value to point at.
        raise ValueError(
            "relation values are not stored as JSONB; there is no sql_extract "
            "expression for them -- see services.db.relations and "
            "query/operators.py's EXISTS-based relation filter branch"
        )

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        """Sorts by link count on this side -- a decision, not a quote:
        research documents no relation sort semantics anywhere, and the
        alternatives (first related row's title; the raw id list) are
        respectively expensive and meaningless to a human. Link count is
        cheap (the `(relation_id, {own_column})` shape is covered by
        migration 015's from/to indexes), deterministic, and useful.
        Flagged in task-20-report.md's judgement-call list.

        Needs `ctx.relation` (which pair/side) and `ctx.row_id_expr` (this
        row's own id expression) -- both are `None`/absent-safe defaults on
        `SqlContext`, but a relation sort with `ctx.relation is None` is a
        caller bug (an unconfigured relation property was still handed to
        the sort compiler), so this raises rather than silently sorting by
        nothing.
        """
        if ctx.relation is None:
            raise ValueError("relation property is not configured (missing relation_id/side)")
        own = ctx.relation.own_column
        if own not in ("from_row_id", "to_row_id"):
            raise ValueError(f"invalid relation link column: {own!r}")  # pragma: no cover
        order = "ASC NULLS LAST" if direction == "asc" else "DESC NULLS FIRST"
        sql = (
            f"(SELECT count(*) FROM db_relation_links rl "
            f"WHERE rl.relation_id = $1::uuid AND rl.user_id = $2::uuid "
            f"AND rl.{own} = {ctx.row_id_expr}) {order}"
        )
        return SqlFragment(sql=sql, params=(ctx.relation.relation_id, ctx.user_id))

    def operators(self) -> dict[str, Operator]:
        return {op.name: op for op in _RELATION_OPS}

    def aggregations(self) -> set[str]:
        # Milestone 8 (formula/rollup) is where a relation's aggregations
        # actually get consumed; until then this matches _GenericProperty's
        # default set rather than inventing rollup-specific names nothing
        # calls yet. A judgement call -- see task-20-report.md.
        return {"count_all", "count_empty", "count_not_empty"}

    def coerce_write(self, raw: Any) -> Any:
        # Hard failure, not a silent accept, regardless of `raw` (including
        # None) -- the whole point of migration 015 is that there is no
        # JSONB copy of a relation's value. services.db.relations.set_links
        # (and friends) are the only legal way to change a relation's links.
        raise ValueError(
            "relation values are not written through db_row_props; "
            "use services.db.relations.set_links"
        )
