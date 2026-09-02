"""Resolves a filter/sort request's property **keys** into SQL, using Task
11's `ast.py` (shape) and `operators.py` (the type x operator matrix) as
pure building blocks. This module is the first thing that knows anything
about *where* a property lives (jsonb vs. column) — `ast.py`/`operators.py`
never do (spec §8.2 layer 1: the AST only ever carries a key).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §8.2/§8.3.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from fastapi import HTTPException, status

from services.db.properties.base import REGISTRY, SqlContext, SqlFragment
from services.db.relations import RelationRef
from .ast import FilterCondition, FilterGroup, FilterNode, SortSpec
from .operators import FilterValidationError, compile_condition

__all__ = [
    "PropertyLookup",
    "compile_filter",
    "compile_sorts",
    "filter_validation_error_to_http",
    "renumber",
]


@dataclass(frozen=True)
class PropertyLookup:
    """Everything the compiler needs about one property, independent of where it came
    from (an ordinary data source's db_properties rows, or the All Notes virtual
    source's COLUMN_BACKED dict) — callers build a dict[key -> PropertyLookup] and hand
    it to compile_filter/compile_sorts. This module never queries the database itself."""

    type: str
    storage: Literal["jsonb", "column"]
    key: str
    # Milestone 7: only set (by Task 21's router, from db_properties.config
    # via relation_ref_from_config) when `type == "relation"`. `None` for
    # every other type, and for a relation property whose config is
    # malformed/pre-015 -- compile_condition's relation branch and
    # Relation.sql_order both treat that as "unusable", never "fall back to
    # JSONB" (there is no JSONB copy to fall back to).
    relation: RelationRef | None = None
    # Milestone 8 (Task 27): only meaningful when `type` is "formula"/
    # "rollup" -- `db_properties.result_type`, threaded into `SqlContext`
    # so `properties/computed.py`'s `Formula`/`Rollup` descriptors and
    # `operators.py`'s `RESULT_TYPE_OPERATORS` can dispatch on it. `None`
    # for every other type, and for a formula/rollup property that hasn't
    # been type-checked/saved yet.
    result_type: str | None = None
    # Milestone 8 (Task 27): `db_properties.is_volatile` -- a formula
    # referencing now()/today() is never materialised (spec §7.4), so it
    # has no SQL-filterable/sortable value at all; `_compile_node`/
    # `compile_sorts` reject a filter/sort attempt on one with a clear
    # `FilterValidationError` naming volatility as the reason (see their
    # own docstrings for why the compute-then-filter path spec §7.4
    # describes is a DEFERRED half of this task, not implemented here).
    # Always `False` for a non-formula property (rollups are never
    # volatile -- only a formula's own expression can reference
    # now()/today()).
    is_volatile: bool = False


def _resolve_alias(lookup: PropertyLookup, row_alias: str) -> str:
    """A `storage='column'` property's real home is always `notes n` —
    never `row_alias` — even in ordinary mode, where `row_alias` is `"p"`
    (`db_row_props`). `db_row_props` happens to have its own `created_at`/
    `updated_at` columns (migration 014), and `COLUMN_BACKED` exposes
    `notes` columns under those exact names, so a column-backed lookup
    naively given the mode's row alias compiles to syntactically valid but
    *wrong-table* SQL (`p.created_at` instead of `n.created_at`) — silent
    wrong answers, no error, exactly the failure class spec §8.2 exists to
    prevent (final M3 review, Important finding 1). `create_property`
    hardcodes `storage='jsonb'` today so this is unreachable via the
    current write path, but PropertyLookup/QueryBuilder don't structurally
    forbid it, so every SqlContext this module builds resolves its alias
    per-lookup rather than trusting the single mode-wide alias callers pass
    in. In All Notes mode `row_alias` is already `"n"`, so this is a no-op
    there — only ordinary mode's behaviour changes."""
    return "n" if lookup.storage == "column" else row_alias


def filter_validation_error_to_http(exc: FilterValidationError) -> HTTPException:
    """spec §8.2 layer 2: "Unknown key -> HTTP 400, never a silently dropped
    clause." Callers (eventually a router, not this task) translate the
    FilterValidationError this module raises through this helper."""
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


_PLACEHOLDER_RE = re.compile(r"\$(\d+)")


def renumber(fragment: SqlFragment, start: int) -> SqlFragment:
    """Shift `fragment`'s $-placeholders so the first one becomes `$start`,
    preserving their relative order — `fragment.sql` numbers placeholders
    contiguously from $1 against `fragment.params` in order (SqlFragment's
    own contract); this is the one function every other seam of correctness
    here (including the injection suite) depends on getting right once.

    A single `re.sub` pass over the *original* text means every replacement
    reads its old index from the unmodified source string — no substitution
    can be re-matched by a later one, so this is safe even when shifting
    into the range of another placeholder (e.g. $1 -> $11).
    """
    if not fragment.params:
        return fragment
    shift = start - 1

    def _shift(m: re.Match[str]) -> str:
        return f"${int(m.group(1)) + shift}"

    return SqlFragment(sql=_PLACEHOLDER_RE.sub(_shift, fragment.sql), params=fragment.params)


def _combine(fragments: list[SqlFragment], sql_op: str) -> SqlFragment:
    """Renumber each child fragment's placeholders into one contiguous,
    correctly-ordered sequence and join them with `sql_op`, wrapped in one
    parenthesised group (a FilterGroup's own atomicity contract — see
    operators.py's date-window comment on why an unparenthesized multi-clause
    fragment is dangerous next to a sibling AND/OR)."""
    parts: list[str] = []
    params: list = []
    offset = 1
    for frag in fragments:
        shifted = renumber(frag, offset)
        parts.append(shifted.sql)
        params.extend(shifted.params)
        offset += len(frag.params)
    return SqlFragment(sql=f"({f' {sql_op} '.join(parts)})", params=tuple(params))


def _compile_node(
    node: FilterNode,
    properties: dict[str, PropertyLookup],
    *,
    user_id: str,
    alias: str,
) -> SqlFragment:
    if isinstance(node, FilterGroup):
        children = [
            _compile_node(child, properties, user_id=user_id, alias=alias)
            for child in node.children
        ]
        return _combine(children, "AND" if node.op == "and" else "OR")

    if not isinstance(node, FilterCondition):
        # Load-bearing, not a sanity check: FilterNode is only ever
        # FilterGroup | FilterCondition (ast.py's discriminated union), so
        # this branch should be unreachable — but `assert` is stripped
        # under `python -O`, and columns.py's own guard against exposing an
        # engine-state column deliberately uses `raise RuntimeError` for
        # exactly this reason (a correctness guard must not be strippable).
        raise RuntimeError(f"unreachable: FilterNode was neither a group nor a condition: {node!r}")
    lookup = properties.get(node.property)
    if lookup is None:
        raise FilterValidationError(f"unknown property key: {node.property!r}")
    _reject_volatile(lookup, node.property)
    ctx = SqlContext(
        key=lookup.key,
        alias=_resolve_alias(lookup, alias),
        storage=lookup.storage,
        relation=lookup.relation,
        user_id=user_id,
        result_type=lookup.result_type,
    )
    return compile_condition(lookup.type, ctx, node.operator, node.value, user_id=user_id)


def _reject_volatile(lookup: PropertyLookup, property_key: str) -> None:
    """Milestone 8 (Task 27), spec §7.4: a volatile formula (`now()`/
    `today()`) is never materialised, so it has NO value in `computed` for
    SQL to read at all -- filtering/sorting by one cannot use an index "by
    construction" (spec's own wording). Spec §7.4 describes a compute-
    then-filter fallback path (evaluate in Python over the rows being
    returned, capped at the 10,000-row query limit, `request_status:
    "incomplete"` past it) -- **deliberately NOT implemented here**,
    flagged loudly rather than silently guessed at: this task's brief
    offers rejection as the acceptable fallback when the compute-then-
    filter path is more than one task can carry, and explicitly prefers a
    clean error over ever silently returning wrong rows. A caller that
    needs the real spec §7.4 behaviour has to build it on top of this
    rejection (a future task) -- what happens here is a correct, honest
    400, not a correct-looking-but-wrong result set."""
    if lookup.type in ("formula", "rollup") and lookup.is_volatile:
        raise FilterValidationError(
            f"property {property_key!r} is a volatile formula (references now()/today()) "
            "and cannot be filtered or sorted in SQL -- its value is never materialised "
            "(spec §7.4). The compute-then-filter fallback spec §7.4 describes is not "
            "implemented; see task-27-report.md."
        )


def compile_filter(
    node: FilterNode | None,
    properties: dict[str, PropertyLookup],
    *,
    user_id: str,
    alias: str,
) -> SqlFragment:
    """Walks the AST (ast.py's FilterCondition/FilterGroup), resolving each
    condition's `property` key against `properties`. `node is None` -> a
    trivial `TRUE` fragment (spec's implicit default: no filter, matches
    list_rows's current unfiltered behaviour).

    Never call this directly to assemble a query — it has no opinion on
    tenancy at all. `QueryBuilder.build()` (builder.py) is the only thing
    that guarantees the mandatory `_scope()` predicate (spec §8.3) actually
    ends up in the final SQL; this function alone produces a `WHERE`
    sub-fragment, not a safe, executable query."""
    if node is None:
        return SqlFragment("TRUE", ())
    return _compile_node(node, properties, user_id=user_id, alias=alias)


def compile_sorts(
    sorts: list[SortSpec], properties: dict[str, PropertyLookup], *, user_id: str, alias: str
) -> SqlFragment:
    """Same unknown-key handling as compile_filter (HTTP 400, never
    dropped). Calls REGISTRY[lookup.type].sql_order(ctx, sort.direction) per
    entry — already implemented, handles ASC NULLS LAST / DESC NULLS FIRST
    (spec §5.1) — and joins the results with ', '.

    An empty `sorts` list yields an empty fragment (legal: builder.py
    always appends its own row-identity tiebreaker regardless).

    Milestone 7 update: `sql_order` was previously guaranteed to never emit
    a bound param (every pre-M7 type only ever orders by a computed
    expression, never compares against a request-supplied value) — that
    invariant no longer holds. `relation`'s `sql_order` (properties/
    relation.py) binds `relation_id`/`user_id` into a count subquery, so
    each sort's fragment is renumbered (the same `renumber` helper
    compile_filter's `_combine` uses) into one contiguous sequence before
    being joined, and its params are collected in order. `user_id` is a
    new required kwarg for exactly that: `ctx.user_id` is the only channel
    a `sql_order(self, ctx, direction)` implementation has to reach a bound
    user_id (see `SqlContext.user_id`'s docstring).

    Deliberately checks `REGISTRY`, not `TYPE_OPERATORS` (unlike
    compile_condition's type check): TYPE_OPERATORS deliberately excludes
    formula/rollup/place/button (Milestone 8 dispatch, or "not filterable"),
    but every one of those 4 still has a REGISTRY entry with a working
    sql_order — there's no operator concept for a sort, so there's no
    reason to reject a type here just because it can't be *filtered* yet.
    A type key absent from REGISTRY entirely (corrupt data, a typo) is the
    actual failure mode this guards against — without it, that case raises
    a bare KeyError -> HTTP 500 instead of the FilterValidationError -> 400
    every other unknown-input path in this module gives.

    Never call this directly to assemble a query — same caveat as
    compile_filter: it has no opinion on tenancy, only `QueryBuilder.build()`
    guarantees `_scope()` ends up in the final SQL (and, as of M7, is also
    responsible for splicing this function's params into the right
    position — see builder.py's `build()`)."""
    parts: list[str] = []
    params: list[Any] = []
    offset = 1
    for sort in sorts:
        lookup = properties.get(sort.property)
        if lookup is None:
            raise FilterValidationError(f"unknown property key: {sort.property!r}")
        if lookup.type not in REGISTRY:
            raise FilterValidationError(f"{lookup.type!r} is not a sortable property type")
        _reject_volatile(lookup, sort.property)
        ctx = SqlContext(
            key=lookup.key,
            alias=_resolve_alias(lookup, alias),
            storage=lookup.storage,
            relation=lookup.relation,
            user_id=user_id,
            result_type=lookup.result_type,
        )
        try:
            frag = REGISTRY[lookup.type].sql_order(ctx, sort.direction)
        except ValueError as exc:
            # Milestone 8 (Task 27): a formula/rollup with no SQL-shaped
            # result_type (unset, or List/Person/Page -- research §4.6/
            # §4.7) has no `RESULT_TYPE_OPERATORS`-style PRE-check the way
            # compile_condition's formula/rollup branch does (there is no
            # "operator" concept for a bare sort), so `Formula`/`Rollup.
            # sql_order` is the first thing that notices and raises a
            # plain `ValueError`. Re-raised as `FilterValidationError` here
            # so it reaches a router as a 400, not an uncaught 500 -- the
            # same "every bad-input path in this module gives the same
            # exception type" contract every other branch already keeps.
            raise FilterValidationError(
                f"property {sort.property!r} cannot be sorted: {exc}"
            ) from exc
        shifted = renumber(frag, offset)
        parts.append(shifted.sql)
        params.extend(shifted.params)
        offset += len(frag.params)
    return SqlFragment(sql=", ".join(parts), params=tuple(params))
