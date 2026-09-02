"""The property system: the `PropertyType` protocol every property-type
descriptor implements, and the `REGISTRY` of all of them.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §5.

`db_properties.type` (Milestone 2 onward) drives everything through a
per-type descriptor registered here. Adding a property type is one
implementation of `PropertyType` plus a `REGISTRY` entry — the 24 real,
addressable Notion property types (research §F.1, items 1-24) are 24
implementations of one interface, not 24 special cases scattered through
the compiler.

This module ships every key from Milestone 1 onward as a deliberately
minimal, generic descriptor (both storage backends — JSONB and §6's
column-backed — an empty/not-empty filter pair, count-only aggregations)
so the registry is complete and satisfies the protocol immediately. Milestone 5 replaces individual entries with richer,
type-specific descriptors (40 number formats, status groups, relation
traversal, formula evaluation, ...) without changing this module's public
shape: `PropertyType`, `REGISTRY`, `SqlFragment`, `SqlContext`, `Operator`.

Note on "24, not 25": earlier drafts of the design spec and plan said "25
types". Research §F.1 ("Complete property type inventory") enumerates
exactly 24 real, addressable property types (items 1-24) and explicitly
resolves its own item 25 -- AI autofill -- as **not** a property type: "a
configuration layer applied to an existing property," never a schema
entry. REGISTRY holds those 24 keys; the spec and plan prose were corrected
to match (confirmed by the user during Milestone 1 review — see
task-2-report.md).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

from services.db.relations import RelationRef

from .columns import COLUMN_BACKED_NAMES


@dataclass(frozen=True)
class SqlFragment:
    """A parameterised SQL expression fragment.

    `sql` uses asyncpg-style positional placeholders (`$1`, `$2`, ...)
    numbered relative to `params`; the query compiler (Milestone 3) is
    responsible for renumbering them into the final, assembled query. No
    property-type implementation ever interpolates a **value** into `sql` —
    values always travel through `params`.

    The one thing that is written into `sql` literally is the property's
    *identity*: its `db_properties.key` (8-char base62, server-minted by
    `keys.mint_key`, validated again by `_jsonb_key` on the way out) or its
    allow-listed `notes` column name. Both are schema, not data. The key
    must be a literal rather than a parameter for a load-bearing reason:
    Postgres can only match a B-tree **expression index** when the indexed
    expression appears verbatim in the query, and a `properties -> $1` hop
    is not verbatim once the plan cache switches from custom to generic
    plans (which asyncpg's pooled prepared statements reach after five
    executions — see `docs/research/storage-benchmark-results.md`,
    "Plan-caching investigation"). A parameterised key silently loses the
    index that Milestone 0's GO verdict depends on.
    """

    sql: str
    params: tuple[Any, ...] = ()


@dataclass(frozen=True)
class SqlContext:
    """Everything a property-type descriptor needs to emit SQL for itself.

    `key` is the property's opaque JSONB key (`db_properties.key`) when
    `storage="jsonb"`, or the `notes` column name (`db_properties.
    column_name`, §6) when `storage="column"`.

    `storage` mirrors `db_properties.storage` and decides which of the two
    backends a descriptor emits for: a JSONB path into
    `db_row_props.properties`, or a direct column reference. It is not
    inferable from `key` alone, which is why it lives here — the "All
    Notes" virtual source (§6) has no `db_row_props` rows at all, so
    emitting a JSONB path for it would reference a `notes.properties`
    column that does not exist.

    `alias` is the SQL table alias for the row source: `notes` for the
    built-in "All Notes" virtual source (§6), `p` (or similar) for
    `db_row_props` otherwise. The query compiler (Milestone 3) constructs
    this; property types only ever read it.

    `relation` (Milestone 7) is the relation-pair identity a `type=
    "relation"` property resolves to (`services.db.relations.
    RelationRef`), or `None` for every other type and for a malformed/
    pre-015 relation property. `row_id_expr` is the SQL expression for
    *this row's own id*, and it is `n.id` in both builder.py modes -- All
    Notes selects `FROM notes n`, and ordinary mode always `JOIN notes n
    ON n.id = p.note_id` (`_scope()` needs `n.deleted_at` regardless).
    It cannot be derived from `alias`, which is `p` in ordinary mode and
    would give `p.id`, a column that does not exist on `db_row_props` --
    the same class of wrong-table trap `_resolve_alias` in
    query/compiler.py guards against for column-backed properties.

    `user_id` (Milestone 7) is the tenancy value a relation's EXISTS/count
    SQL binds as `rl.user_id = $n` -- mandatory even though the outer query
    is already scoped, because `db_relation_links.user_id` is not
    structurally tied to the row's owner (the same gap migration 019's
    header documents for `db_row_props`). It has no effect on any
    non-relation descriptor. Not part of the brief's enumerated SqlContext
    fields (`relation`/`row_id_expr` only) -- added because `sql_order`'s
    fixed `(self, ctx, direction)` signature has no other channel to reach
    a bound user_id into the count subquery `query/compiler.py`'s
    `compile_sorts` must build for a relation sort (task-20-report.md's
    judgement-call list).

    `result_type` (Milestone 8, Task 27) is the FType string (`"number"`,
    `"string"`, ...) a `type == "formula"`/`"rollup"` property's
    `db_properties.result_type` carries -- the one piece of per-PROPERTY
    identity `properties/computed.py`'s `Formula`/`Rollup` descriptors need
    that `key`/`alias`/`storage` alone can't supply, mirroring exactly why
    `relation` was added in Milestone 7 (Relation's SQL also depends on
    per-property identity, not just its type key). `None` for every other
    type, and for a formula/rollup property whose `result_type` hasn't been
    set yet (not yet type-checked/saved) -- `Formula`/`Rollup`'s own
    `_value_sql` treats that as "no SQL shape", the same as an
    unfilterable List/Person/Page result.
    """

    key: str
    alias: str = "notes"
    storage: Literal["jsonb", "column"] = "jsonb"
    relation: RelationRef | None = None
    row_id_expr: str = "n.id"
    user_id: str = ""
    result_type: str | None = None


# `keys.mint_key` mints 8 base62 characters; the bound is loose so a test or
# a future key scheme can't trip it, but the character class is strict —
# with no quote, backslash or whitespace possible, the literal below cannot
# escape its string context.
_JSONB_KEY_RE = re.compile(r"[0-9A-Za-z]{1,32}")


def _jsonb_key(key: str) -> str:
    if not _JSONB_KEY_RE.fullmatch(key):
        raise ValueError(
            f"property key must be base62 (see keys.mint_key), got: {key!r}"
        )
    return key


def _column_reference(ctx: SqlContext) -> str:
    """`alias.column` for a `storage='column'` property.

    The column name is checked against the fixed Python allow-list in
    `columns.py` — never against the request and never against the database
    catalogue (spec §6). This is the entire defence against column
    injection, so it is a hard failure, not a fallback.
    """
    if ctx.key not in COLUMN_BACKED_NAMES:
        raise ValueError(
            f"{ctx.key!r} is not an allow-listed column-backed property "
            f"(services/db/properties/columns.py: COLUMN_BACKED)"
        )
    return f"{ctx.alias}.{ctx.key}"


@dataclass(frozen=True)
class _ValueShape:
    """How to reach a type's **actual value** inside its §3.3 wrapper.

    `properties -> 'key'` yields the discriminated wrapper object
    (`{"type": "number", "number": 42}`), which is the wrong thing to
    filter or sort on twice over: it can't use the expression indexes
    Milestone 0 validated (they are built on the extracted scalar), and
    ordering it uses jsonb's key-ordering collation rather than the value's
    own ordering.

    `hop` is the SQL appended after `properties -> '<key>'`, `cast` the
    cast applied to the result, and `order_hop` an override used only by
    `ORDER BY` where sorting needs a different projection than reading.
    """

    hop: str
    cast: str = ""
    order_hop: str | None = None


def _text_shape(type_key: str) -> _ValueShape:
    """Default: the value is a scalar stored under its own type name, read
    as text. Correct for title/rich_text/select/status/url/email/phone,
    and for ISO-8601 timestamps, which sort chronologically as text (and,
    unlike `::timestamptz`, stay immutable enough to be indexed)."""
    return _ValueShape(f"->> '{type_key}'")


# Types whose value is not a plain string under its own type name. Milestone
# 5 replaces the generic descriptor with real per-type descriptors; these
# shapes exist now so the SQL Milestone 1 ships is index-compatible and not
# actively wrong, not because they are the final word.
#
# "relation" is deliberately NOT here (Milestone 7 removed it): it was a
# Milestone-1/3 placeholder written before `db_relation_links` existed.
# `db_row_props.properties->'<relation key>'` must never be treated as the
# link list -- migration 015's header and services/db/relations.py are the
# single source of truth now. properties/relation.py's `Relation` descriptor
# replaces `_GenericProperty` for this type entirely (REGISTRY, below).
_ARRAY_VALUED = ("multi_select", "people", "files")

_VALUE_SHAPES: dict[str, _ValueShape] = {
    # `::double precision` (not `::numeric`) is deliberate: it is the exact
    # cast Milestone 0's validated expression index was built on
    # (scripts/bench/storage_bench.py, bench_jsonb_indexed_hotnum). The
    # migration that adds the production index and this expression must
    # keep matching, or the index goes unused.
    "number": _ValueShape("->> 'number'", cast="::double precision"),
    "checkbox": _ValueShape("->> 'checkbox'", cast="::boolean"),
    # A date value is an object: {"start", "end", "time_zone"}. Ordering the
    # object would order by jsonb key collation, which places `end` before
    # `start` — i.e. it would silently sort by end date. Always project
    # `start`. (Spec §5.1's end-date and time-zone handling: Milestone 5.)
    "date": _ValueShape("-> 'date' ->> 'start'"),
    **{
        # Arrays of option ids. jsonb array comparison orders by length
        # first, which contradicts spec §5.1 ("by the first option in the
        # property's option order, then by count"), so sorting projects the
        # first element instead. TODO(M5): rank that element by the
        # property's configured *option order* rather than by its id — that
        # needs `db_properties.config`, which the generic descriptor here
        # has no access to.
        key: _ValueShape(f"-> '{key}'", order_hop=f"-> '{key}' ->> 0")
        for key in _ARRAY_VALUED
    },
}


class Operator(BaseModel):
    """A single filter operator a property type supports, plus the shape
    of argument it expects (compiler/validation concern, Milestone 3)."""

    model_config = ConfigDict(frozen=True)

    name: str
    arg_type: str  # "str" | "num" | "bool" | "date" | "uuid" | "none" | ...


@runtime_checkable
class PropertyType(Protocol):
    """Spec §5. Every property type is one implementation of this."""

    key: str
    config_model: type[BaseModel]

    def default(self) -> Any: ...
    def is_empty(self, value: Any) -> bool: ...
    def sql_extract(self, ctx: SqlContext) -> SqlFragment: ...
    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment: ...
    def operators(self) -> dict[str, Operator]: ...
    def aggregations(self) -> set[str]: ...
    def coerce_write(self, raw: Any) -> Any: ...


class _EmptyConfig(BaseModel):
    """Placeholder `config_model` for the generic Milestone-1 descriptors.
    Milestone 5 gives each type its own validated config (40 number
    formats, select option lists, etc.)."""

    model_config = ConfigDict(extra="forbid")


@dataclass(frozen=True)
class _GenericProperty:
    """Minimal `PropertyType` implementation shared by every type key until
    its dedicated, richer descriptor lands in Milestone 5 (spec §5 lists
    `scalar.py`, `choice.py`, `temporal.py`, `people.py`, `files.py`,
    `computed.py` as the eventual homes). It provides just enough
    behaviour to satisfy the protocol: extraction/ordering of the actual
    value (from either storage backend), an empty/not-empty operator pair,
    and count-only aggregations.
    """

    key: str
    config_model: type[BaseModel] = field(default=_EmptyConfig)

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return value is None or value == "" or value == [] or value == {}

    def _value_sql(self, ctx: SqlContext, *, for_order: bool) -> str:
        if ctx.storage == "column":
            return _column_reference(ctx)

        shape = _VALUE_SHAPES.get(self.key) or _text_shape(self.key)
        hop = shape.order_hop if (for_order and shape.order_hop) else shape.hop
        expr = f"{ctx.alias}.properties -> '{_jsonb_key(ctx.key)}' {hop}"
        # Spec §8.2 / research §K.7 call for this `::double precision` cast
        # to be *guarded* (`CASE WHEN ... THEN ...::double precision ELSE
        # NULL END`) so one malformed legacy `number` value can't 500 an
        # entire filtered query. M3 (Task 11) deliberately does NOT apply
        # that guard: it was implemented, found to break Milestone 0's
        # validated B-tree expression index (a CASE-wrapped expression
        # doesn't match the bare-cast expression the index was built on
        # syntactically, so number/unique_id filter/sort would silently
        # fall onto the unindexed ~450ms-p95 NO-GO path instead of the
        # ~90ms-p95 GO path), and was reverted after that tradeoff was
        # escalated to and decided by the human partner: there is currently
        # no legacy/malformed `number` data in production for this
        # brand-new feature, so the hazard the guard protects against is
        # hypothetical today, and trading away an empirically-validated,
        # gate-passing index for it isn't worth it yet (task-11-report.md
        # has the full history). Revisit this cast when either (a)
        # Milestone 5's `coerce_write` is fully authoritative and the guard
        # becomes pure defense-in-depth, or (b) real malformed data risk
        # actually materialises — and ship a matching functional/partial
        # index alongside the guard at that point, not after it.
        return f"({expr}){shape.cast}" if shape.cast else expr

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return SqlFragment(self._value_sql(ctx, for_order=False))

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        # Decided unknown (spec §5.1): empties always sort to the bottom.
        order = "ASC NULLS LAST" if direction == "asc" else "DESC NULLS FIRST"
        return SqlFragment(f"{self._value_sql(ctx, for_order=True)} {order}")

    def operators(self) -> dict[str, Operator]:
        return {
            "is_empty": Operator(name="is_empty", arg_type="none"),
            "is_not_empty": Operator(name="is_not_empty", arg_type="none"),
        }

    def aggregations(self) -> set[str]:
        return {"count_all", "count_empty", "count_not_empty"}

    def coerce_write(self, raw: Any) -> Any:
        return raw


# The 24 real, addressable Notion property types (research §F.1, items
# 1-24). Item 25 in that inventory, AI autofill, is explicitly resolved as
# not a property type and is deliberately absent here.
_REAL_TYPE_KEYS = (
    "title", "rich_text", "number", "select", "multi_select", "status",
    "date", "people", "files", "checkbox", "url", "email", "phone_number",
    "formula", "relation", "rollup", "created_time", "created_by",
    "last_edited_time", "last_edited_by", "unique_id", "place",
    "verification", "button",
)

# Milestone 5 (task-14-brief.md): richer, type-specific descriptors for the
# 8 keys the plan's own M5 test cases name (40 number formats, status
# groups, date ranges + timezone, unique_id counters). Milestone 7
# (task-20-brief.md) adds `relation`'s (its SQL is genuinely different from
# every other type -- see properties/relation.py). The remaining keys stay
# on `_GenericProperty` until a milestone needs their richness (formula/
# rollup need M8's engine).
#
# Imported here, at the bottom of the module rather than at the top: these
# four submodules import `_GenericProperty`/`Operator`/`SqlContext`/
# `SqlFragment` back from this module (`from .base import ...`), so this
# module must finish *defining* those names before importing the
# submodules that need them, or Python raises ImportError on a partially
# initialised module. `_GenericProperty`/`Operator`/`SqlContext`/
# `SqlFragment` are unchanged above this point; only the import's position
# in the file is new.
from .scalar import Number, UniqueId  # noqa: E402
from .choice import Select, MultiSelect, Status  # noqa: E402
from .temporal import Date, CreatedTime, LastEditedTime  # noqa: E402
from .relation import Relation  # noqa: E402
from .computed import Formula, Rollup  # noqa: E402
from .button import Button  # noqa: E402

_RICH_OVERRIDES: dict[str, PropertyType] = {
    "number": Number(),
    "unique_id": UniqueId(),
    "select": Select(),
    "multi_select": MultiSelect(),
    "status": Status(),
    "date": Date(),
    "created_time": CreatedTime(),
    "last_edited_time": LastEditedTime(),
    "relation": Relation(),
    # Milestone 8 (Task 27): result-type-dispatched SQL extraction/ordering
    # over `computed`, replacing `_GenericProperty`'s placeholder handling
    # (which pointed at `properties` under a literal "formula"/"rollup"
    # key -- wrong column, wrong key, never exercised until this task).
    "formula": Formula(),
    "rollup": Rollup(),
    # Milestone 12 (task-39): a real, deliberately narrowed descriptor (empty
    # operators()/aggregations(), unconditional is_empty, hard-failing coerce_write) --
    # see properties/button.py's own docstring.
    "button": Button(),
}

REGISTRY: dict[str, PropertyType] = {
    key: _RICH_OVERRIDES.get(key, _GenericProperty(key=key)) for key in _REAL_TYPE_KEYS
}
