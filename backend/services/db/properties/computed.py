"""Formula / Rollup: Milestone 8's result-type-dispatched descriptors,
replacing `_GenericProperty`'s placeholder handling (task-27-brief.md §3).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.3
("Because results are materialised, formulas and rollups filter and sort
in SQL exactly like stored values").
Research: docs/research/notion-databases-research.md §4.6 ("This is a
lossy projection of the seven-type language... List, Person, and Page have
no dedicated API result type") and §4.7 ("There is no `formula.list`,
`formula.people`, or `formula.relation` filter") -- both cited at length
below, since they are the reason this module covers only 4 of the formula
language's 7 value types.

Unlike every other type in this package, a formula/rollup property's SQL
shape depends on a PER-PROPERTY value (`db_properties.result_type`), not
just its `db_properties.type` ("formula"/"rollup" -- the same for every
property of that type). `SqlContext.result_type` carries that in (added by
this task, mirroring exactly why Milestone 7 added `SqlContext.relation`:
`Relation`'s SQL also depends on per-property identity, not just its type
key). The FILTER-OPERATOR side of the dispatch lives in `query/
operators.py`'s `RESULT_TYPE_OPERATORS`, not here, and deliberately does
NOT extend `TYPE_OPERATORS` (see that module's own docstring): a flat
`dict[str, Operator]` keyed by property TYPE cannot represent an operator
set that depends on `result_type`, a per-PROPERTY value -- `Formula`/
`Rollup` staying out of `TYPE_OPERATORS` is therefore still correct after
this task, for an evolved reason (it used to be "M3 couldn't know their
type at all"; now it is "even knowing the type, a flat dict can't express
a per-property-conditional operator set").

Reads `db_row_props.computed`, NEVER `properties` -- migration 016's own
column comment: "Written ONLY by ... recompute.py". An `unsupported` cell
(`{"type":"unsupported"}`, no `result_type`-named key inside it) reads as
SQL `NULL` through this module's own extraction hop (`computed -> 'key' ->>
'<result_type>'` finds no such key), so it sorts/filters exactly like any
other empty/NULL value -- no special-casing needed.

`List`/`Person`/`Page` result types have NO SQL shape here at all
(`_value_sql` raises `ValueError` for them, and `query/operators.py`
rejects a filter on them with `FilterValidationError` before ever reaching
this module) -- not an oversight. Research §4.6, verbatim: *"Only four
result types cross the API boundary... `formula.type` ∈ `"boolean"` |
`"date"` | `"number"` | `"string"` | `"unsupported"`. This is a lossy
projection of the seven-type language. `List`, `Person`, and `Page` have
no dedicated API result type."* And §4.7: *"There is **no** `formula.list`,
`formula.people`, or `formula.relation` filter."* This module's 4-of-7
restriction matches that reading exactly, rather than inventing an
arbitrary SQL ordering for a JSON array/object Notion itself never made
queryable at all.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ConfigDict

from .base import Operator, SqlContext, SqlFragment, _jsonb_key

__all__ = ["Formula", "Rollup", "ComputedConfig", "COMPUTED_VALUE_SHAPES"]


class ComputedConfig(BaseModel):
    """Documents the `config` shape `services/db/recompute.py`'s
    `_property_defs` docstring defines (this codebase's own field names,
    not yet exercised by any router -- Task 28 owns writing them): a
    formula property's config is `{"expression": "<source>"}` (research
    §4.1's own `formula.expression` field name, reused for forward
    consistency); a rollup property's config is `{"relation_key",
    "target_data_source_id", "target_key", "function"}` (research §17's
    `relation_property_id`/`rollup_property_id`/`function`, renamed to
    this codebase's own key-based property references). Nothing in this
    codebase currently validates `db_properties.config` against a
    `config_model` at write time -- matches `RelationConfig`'s identical
    documentation-only role (`properties/relation.py`)."""

    model_config = ConfigDict(extra="forbid")

    expression: str | None = None  # formula only
    relation_key: str | None = None  # rollup only
    target_data_source_id: str | None = None  # rollup only
    target_key: str | None = None  # rollup only
    function: str | None = None  # rollup only


@dataclass(frozen=True)
class _ComputedValueShape:
    """The `computed`-column analogue of `base.py`'s `_ValueShape` --
    kept as a separate, smaller type rather than reusing `_ValueShape`
    directly, since this module has no `order_hop` concept (every shape
    here orders by the same expression it filters on -- no array-valued
    result type reaches this module at all, see the module docstring)."""

    hop: str
    cast: str = ""


# Keyed by RESULT_TYPE (an FType string -- "number", not "number_format"
# or any property-type string), not by property type -- the whole point of
# this module. Only the 4 types Notion's own formula API can filter/sort
# by at all (research §4.6/§4.7, quoted at length in the module docstring)
# get a shape; List/Person/Page deliberately have none.
COMPUTED_VALUE_SHAPES: dict[str, _ComputedValueShape] = {
    # Same `::double precision` cast as `base.py`'s own `_VALUE_SHAPES`
    # entry for `number` -- kept identical so a hot-property expression
    # index (migration 016 §2's recipe, "A materialised formula or
    # rollup") matches this exact expression verbatim.
    "number": _ComputedValueShape("->> 'number'", cast="::double precision"),
    "boolean": _ComputedValueShape("->> 'boolean'", cast="::boolean"),
    # A materialised Date's value is `{"start", "end"}` (recompute.py's
    # `_encode_fvalue` -- no `time_zone` key, unlike a STORED date
    # property's wrapper, since a formula/rollup Date carries none).
    # Always project `start`, matching `base.py`'s identical reasoning for
    # why a stored date property orders by `start` and not the whole
    # object (jsonb key-collation would sort by `end` first).
    "date": _ComputedValueShape("-> 'date' ->> 'start'"),
    "string": _ComputedValueShape("->> 'string'"),
}


@dataclass(frozen=True)
class _Computed:
    """Shared base for `Formula`/`Rollup` -- their SQL behaviour is
    IDENTICAL (both read `computed`, both dispatch on `ctx.result_type`
    the exact same way); only `key` differs, and only for REGISTRY
    identity / error messages, mirroring `CreatedTime`/`LastEditedTime`
    sharing one implementation in `properties/temporal.py`."""

    key: str
    config_model: type[BaseModel] = field(default=ComputedConfig)

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return value is None or value == "" or value == [] or value == {}

    def _value_sql(self, ctx: SqlContext) -> str:
        if ctx.result_type not in COMPUTED_VALUE_SHAPES:
            raise ValueError(
                f"{self.key} property with result_type={ctx.result_type!r} has no SQL "
                "shape -- only string/number/boolean/date results are filterable/"
                "sortable in SQL (research §4.6/§4.7: Notion's own formula API has "
                "no list/person/page result type either); query/operators.py's "
                "RESULT_TYPE_OPERATORS rejects a filter on one of those before "
                "ever reaching this method, but sql_order (compile_sorts) has no "
                "equivalent pre-check, so this raises rather than emitting SQL "
                "that would silently reference a JSONB key that never exists."
            )
        shape = COMPUTED_VALUE_SHAPES[ctx.result_type]
        # The property's own JSONB key is a SQL LITERAL, never a bound
        # parameter -- `SqlFragment`'s own docstring explains why at
        # length (Postgres can only match a B-tree expression index when
        # the indexed expression appears verbatim), and that reasoning
        # applies identically to `computed` as it does to `properties`
        # (migration 016 §2's hot-property recipe indexes `computed` by
        # the exact same literal-key convention).
        expr = f"{ctx.alias}.computed -> '{_jsonb_key(ctx.key)}' {shape.hop}"
        return f"({expr}){shape.cast}" if shape.cast else expr

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return SqlFragment(self._value_sql(ctx))

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        # Same NULLS LAST/FIRST convention as `_GenericProperty.sql_order`
        # -- an `unsupported`/absent (EMPTY) cell sorts to the bottom
        # either direction, same as any other empty value.
        order = "ASC NULLS LAST" if direction == "asc" else "DESC NULLS FIRST"
        return SqlFragment(f"{self._value_sql(ctx)} {order}")

    def operators(self) -> dict[str, Operator]:
        # The filter-operator side of the dispatch lives in query/
        # operators.py's RESULT_TYPE_OPERATORS -- nothing calls this
        # method (query/compiler.py's compile_filter goes through
        # TYPE_OPERATORS, which deliberately still excludes "formula"/
        # "rollup"; see this module's own docstring for why). Kept as an
        # empty dict, not raising, purely to satisfy the `PropertyType`
        # protocol.
        return {}

    def aggregations(self) -> set[str]:
        return {"count_all", "count_empty", "count_not_empty"}

    def coerce_write(self, raw: Any) -> Any:
        # Hard failure, matching `Relation.coerce_write`'s identical
        # posture: there is exactly one legal writer of a formula/rollup
        # value (services/db/recompute.py, into `computed`), and it never
        # goes through this method.
        raise ValueError(
            "formula/rollup values are never written directly -- "
            "services/db/recompute.py is the only writer of db_row_props.computed"
        )


@dataclass(frozen=True)
class Formula(_Computed):
    key: str = "formula"


@dataclass(frozen=True)
class Rollup(_Computed):
    key: str = "rollup"
