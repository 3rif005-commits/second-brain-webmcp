"""Number and UniqueId: Milestone 5's richer descriptors for the two scalar
numeric types (task-14-brief.md §1).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §5.
Research: docs/research/notion-databases-research.md §F.1 items 4 (Number,
~line 494) and 22 (Unique ID, ~line 1411).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

import asyncpg
from pydantic import BaseModel, ConfigDict, Field

from .base import Operator, SqlContext, SqlFragment, _GenericProperty

__all__ = ["Number", "NumberConfig", "UniqueId", "UniqueIdConfig", "next_unique_id"]


# Research §F.1 item 4: the property schema object's `format` enum, "copy
# verbatim" per task-14-brief.md. The brief's own prose claims "40 values"
# and the research doc repeats that claim ("That is 40 values.") right
# above its own enumerated list -- but the enumerated list in both places
# is 39 items, not 40 (counted twice). This is copied verbatim as
# enumerated (39), not padded to match the prose count; flagged in
# task-14-report.md for the reviewer rather than silently "fixed" by
# guessing a 40th format that appears nowhere in either source.
NumberFormat = Literal[
    "number", "number_with_commas", "percent", "dollar", "canadian_dollar",
    "singapore_dollar", "hong_kong_dollar", "new_zealand_dollar",
    "new_taiwan_dollar", "euro", "pound", "yen", "yuan", "won", "ruble",
    "rupee", "rupiah", "real", "lira", "franc", "krona", "norwegian_krone",
    "danish_krone", "mexican_peso", "chilean_peso", "philippine_peso",
    "colombian_peso", "argentine_peso", "uruguayan_peso", "rand", "zloty",
    "baht", "forint", "koruna", "shekel", "dirham", "riyal", "ringgit", "leu",
]


class NumberConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Display-only (research: "API number config contains only format", and
    # format itself doesn't change the stored value) -- so this field never
    # touches sql_extract/sql_order/coerce_write, only carried through for a
    # future frontend cell editor (out of this task's scope per the brief).
    format: NumberFormat = "number"

    # The rest of the `Edit property` panel, captured live from Notion on
    # 2026-08-31 (docs/ui-specs/raw-dom/20-edit-property-panel.md): the panel
    # has three controls, not one -- `Number format`, `Decimal places` and a
    # `Show as` card row, and choosing Bar or Ring reveals Color / Divide by /
    # Show number. Every one of these is display-only in exactly the sense
    # `format` already is: none touch sql_extract, sql_order or coerce_write,
    # and none change the stored value.
    #
    # Declared here because this model is the written-down schema for
    # `db_properties.config` on a number property. Nothing validates
    # `config_model` at write time (see base.py / button.py's note on that
    # same fact), so PATCH /db/properties/{key} would have accepted these
    # keys with or without this change -- but leaving the model at one field
    # while the UI writes five would make it a stale description of the data.
    decimal_places: int | None = Field(default=None, ge=0, le=5)
    show_as: Literal["number", "bar", "ring"] = "number"
    # Notion's bar/ring palette is a subset of the 10 option colors; kept a
    # plain str for the same reason SelectOption.color is (choice.py) --
    # narrowing it to a Literal would reject already-stored values.
    bar_color: str = "green"
    # None means "no divisor configured yet". Notion pre-fills the input with
    # 100 the moment Bar or Ring is chosen; that default belongs to the UI,
    # not to the stored config, so an unset value stays unset here.
    divide_by: float | None = None
    show_number: bool = True


class UniqueIdConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prefix: str | None = None


_NUMBER_OPS: tuple[Operator, ...] = (
    Operator(name="equals", arg_type="num"),
    Operator(name="does_not_equal", arg_type="num"),
    Operator(name="greater_than", arg_type="num"),
    Operator(name="less_than", arg_type="num"),
    Operator(name="greater_than_or_equal_to", arg_type="num"),
    Operator(name="less_than_or_equal_to", arg_type="num"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)


def _is_empty(value: Any) -> bool:
    # Same rule as _GenericProperty.is_empty (base.py) -- duplicated here
    # rather than imported, matching this codebase's own precedent of
    # small, sibling-module duplication over a shared private helper (see
    # query/grouping.py and query/aggregations.py both defining their own
    # `_parse_instant`).
    return value is None or value == "" or value == [] or value == {}


@dataclass(frozen=True)
class Number:
    """Research: "Default: empty (null), not 0" -- explicit, so `default()`
    is `None`, never `0`."""

    key: str = "number"
    config_model: type[BaseModel] = NumberConfig

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return _is_empty(value)

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        # Delegate to `_GenericProperty` rather than re-deriving the JSONB
        # hop: this is the strongest possible guarantee that the swap
        # doesn't change M3/M4's compiled SQL shape at all (task-14-brief.md
        # "must not change" requirement) -- it isn't merely tested to match,
        # it *is* the same call.
        return _GenericProperty(key=self.key).sql_extract(ctx)

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_order(ctx, direction)

    def operators(self) -> dict[str, Operator]:
        return {op.name: op for op in _NUMBER_OPS}

    def aggregations(self) -> set[str]:
        return {
            "count_all", "count_empty", "count_not_empty",
            "sum", "average", "median", "min", "max", "range",
        }

    def coerce_write(self, raw: Any) -> Any:
        if raw is None:
            return None
        # bool is a subclass of int (isinstance(True, int) is True) -- the
        # same trap query/operators.py's coerce_value already documents for
        # this exact type. Must be checked before the int/float check.
        if isinstance(raw, bool):
            raise ValueError(f"number value cannot be a bool, got: {raw!r}")
        if isinstance(raw, (int, float)):
            # Fix 2 (task-51, M14 final cross-cutting review): a plain Python `int`
            # is unbounded, but this value is later read back through
            # `services/db/recompute.py`'s `_decode_stored` (`float(raw)` for ANY
            # `FType.NUMBER` dependency -- run on EVERY row write, not just formula/
            # rollup dependents) and `_encode_fvalue`'s own `float`/JSON round trip.
            # A too-large int (e.g. a 400+-digit CSV cell) sails through the
            # `isinstance` check above, gets stored, then raises an unhandled
            # `OverflowError` (NOT a `ValueError`, so no existing catch-all here or
            # in any caller's exception mapping covers it) the next time anything
            # recomputes this row. Guarding here, at write time, turns that into a
            # clean, immediate `ValueError` -- the same "fail loud at the write,
            # not the next unrelated read" standard this function already applies
            # to bools.
            try:
                float(raw)
            except OverflowError as exc:
                raise ValueError(f"number value out of range: {raw!r}") from exc
            return raw
        # No `float(raw)` data-cleaning attempt on e.g. a numeric string --
        # spec's "fail loud" standard (same reasoning query/operators.py's
        # module docstring applies to filter values applies here to writes).
        raise ValueError(f"number value must be int/float/None, got: {type(raw).__name__}")


@dataclass(frozen=True)
class UniqueId:
    """Research: "created_time, created_by, ... unique_id are read-only
    values" -- assigned only by `next_unique_id`'s counter, never by a
    direct write."""

    key: str = "unique_id"
    config_model: type[BaseModel] = UniqueIdConfig

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return _is_empty(value)

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_extract(ctx)

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_order(ctx, direction)

    def operators(self) -> dict[str, Operator]:
        # research/operators.py decision: "unique_id gets the full 8 numeric
        # operators (schema is permissive)" -- same family as Number.
        return {op.name: op for op in _NUMBER_OPS}

    def aggregations(self) -> set[str]:
        # query/aggregations.py deliberately excludes unique_id from the
        # numeric aggregators ("unique_id is numeric too but deliberately
        # out of scope... do not extend it") -- mirrored here so this
        # method doesn't advertise a capability M4 doesn't actually honour.
        return {"count_all", "count_empty", "count_not_empty"}

    def coerce_write(self, raw: Any) -> Any:
        # `None` is accepted as a no-op/absent-value case (matches every
        # other type's coerce_write(None) and the generic protocol test in
        # test_db_property_registry.py that calls it on every REGISTRY
        # entry) -- but any real value is rejected: there is no valid
        # direct write to a unique_id cell.
        if raw is None:
            return None
        raise ValueError(
            "unique_id is read-only; its value is assigned by next_unique_id(), never written directly"
        )


async def next_unique_id(conn: asyncpg.Connection, property_id: str) -> int:
    """Atomically increments and returns this property's next counter value, persisted in
    `db_properties.config->>'next_value'` (no migration needed -- `config` is already a
    flexible JSONB column from migration 014; storing counter state there avoids a schema
    change for a single integer). Starts at 1 if absent. Research: "unique_id counters
    consume numbers for deleted rows (gaps permanent)" -- this function never reads or
    considers existing row values, only ever increments its own persisted counter, so a
    deleted row's number is never reused. Single atomic UPDATE...RETURNING, no read-then-
    write race.
    """
    row = await conn.fetchrow(
        """
        UPDATE db_properties
        SET config = jsonb_set(
            config,
            '{next_value}',
            to_jsonb(COALESCE((config->>'next_value')::int, 0) + 1)
        )
        WHERE id = $1
        RETURNING (config->>'next_value')::int AS next_value
        """,
        property_id,
    )
    if row is None:
        raise ValueError(f"no db_properties row with id={property_id!r}")
    return row["next_value"]
