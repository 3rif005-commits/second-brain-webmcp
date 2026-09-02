"""Rollups: aggregating a relation's target-row values into one row's
`db_row_props.computed` entry (Milestone 8e, Task 27).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.3
(materialisation), §9 ("Rollups materialise into `computed` alongside
formulas, share the dependency graph, and are capped by the same depth
limits. Rollups over rollups are permitted within depth 3.").
Research: docs/research/notion-databases-research.md §17 ("Rollup") for the
`function` enum and the config shape (relation property, target property,
function); §4.2-4.5 for the cross-formula/rollup depth rules `recompute.py`
(not this module) enforces.
Brief: .superpowers/sdd/2026-08-08-notion-databases/task-27-brief.md §1.

**Reuses `services/db/query/aggregations.py`'s 20 aggregation functions
wholesale rather than reimplementing them** — Milestone 4 already argued
through every empty-set edge case (`sum` of nothing is `0`, `average`/
`median`/`min`/`max`/`range` of nothing is `null`, `percent_*` of nothing
is `null`) and this module's own brief is explicit that those decisions
win wherever the two lists could be read to disagree. Only 2 of the 22
documented rollup functions have no M4 equivalent at all (`show_original`,
`show_unique` — see `ROLLUP_FUNCTIONS`'s docstring) and are implemented
directly here.

Fetches relation values via `services/db/relations.py`'s `list_links_bulk`
— one query for a whole page of owner rows, never per-row — and fetches
every distinct target row's value with one further bulk query, so a rollup
over N owner rows costs exactly 2 queries regardless of N (plus whatever
`aggregate()` itself does, which is pure Python over already-fetched rows).

This module has no knowledge of `db_properties.config`'s on-disk shape or
of HTTP — Task 28's router resolves a rollup property's config into a
`RelationRef` (`services/db/relations.py`) and a `RollupTarget` (below) and
calls `compute_rollup`; `recompute.py` (this task, sibling module) is the
other real caller, for materialisation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import asyncpg

from . import relations
from .formula.types import FType
from .query.aggregations import aggregate
from .query.compiler import PropertyLookup

__all__ = [
    "ROLLUP_FUNCTIONS",
    "ROLLUP_RESULT_TYPE",
    "RollupTarget",
    "compute_rollup",
    "computed_wrapper",
    "computed_raw",
]


# ---------------------------------------------------------------------------
# 1. The 22 documented rollup functions
# ---------------------------------------------------------------------------

# Research §17's API `function` enum has 24 values. Two of them
# (`count_per_group`, `percent_per_group`) are the research document's own
# `UNRESOLVED:` note ("tied to grouped views... they appear in the API enum
# but not the help center's function list") — there is no grouped-view
# rollup UI in this codebase to give them a trigger, and no documented
# semantics to implement against. Excluded here, per task-27-brief.md's own
# stated count: **22**, not 24. Flagged, not silently followed either way.
ROLLUP_FUNCTIONS = frozenset({
    "average", "checked", "count", "count_values", "date_range",
    "earliest_date", "empty", "latest_date", "max", "median", "min",
    "not_empty", "percent_checked", "percent_empty", "percent_not_empty",
    "percent_unchecked", "range", "show_original", "show_unique", "sum",
    "unchecked", "unique",
})

# 20 of the 22 are IDENTICALLY NAMED, identical-semantics entries in
# aggregations.py's own `_VALID_AGGREGATORS` -- the mapping is the name
# itself, not a translation table (test_rollup.py pins this equality
# directly against that module's private set, so a future rename on either
# side fails loudly instead of silently drifting).
#
# The 2 genuine extras, with no M4 equivalent: `show_original` ("the actual
# property values from the related items", research §17's "Any property
# type" UI group) and `show_unique` ("Show unique values", the same,
# deduplicated) -- both LIST-valued. Not to be confused with M4's own
# `unique` aggregator, which answers a completely different documented UI
# question ("Count unique values", a NUMBER) despite the name-adjacency --
# two real, distinct, both-documented functions, not a collision to
# resolve.
_SHOW_FUNCTIONS = frozenset({"show_original", "show_unique"})


# ---------------------------------------------------------------------------
# 2. Result type per function (what `db_properties.result_type` becomes for
#    a property whose `config.function` is this name)
# ---------------------------------------------------------------------------

# M4's own return shapes decide this, not a fresh reading of research: every
# numeric-family/checkbox-family/universal-family aggregator in
# aggregations.py returns a Python int/float (a count, a sum, a percentage,
# ...), INCLUDING `date_range` -- whose M4 implementation is a plain
# day-count float ("what a frontend needs to render 'X days' without
# parsing a duration format", aggregations.py's own comment), not an
# ISO-8601 interval or a Date. This is despite research's UI table listing
# "Date range" alongside "Earliest date"/"Latest date" under "Date
# properties only" -- a real, worth-flagging divergence between the UI
# grouping (by which property types can produce the input) and the actual
# output type (by what the function returns), which only `earliest_date`/
# `latest_date` genuinely share (a DATE result).
_NUMBER_RESULT_FUNCTIONS = frozenset({
    "average", "checked", "count", "count_values", "date_range", "empty",
    "max", "median", "min", "not_empty", "percent_checked", "percent_empty",
    "percent_not_empty", "percent_unchecked", "range", "sum", "unchecked",
    "unique",
})
_DATE_RESULT_FUNCTIONS = frozenset({"earliest_date", "latest_date"})
_LIST_RESULT_FUNCTIONS = _SHOW_FUNCTIONS

ROLLUP_RESULT_TYPE: dict[str, FType] = {
    **{fn: FType.NUMBER for fn in _NUMBER_RESULT_FUNCTIONS},
    **{fn: FType.DATE for fn in _DATE_RESULT_FUNCTIONS},
    **{fn: FType.LIST for fn in _LIST_RESULT_FUNCTIONS},
}


# ---------------------------------------------------------------------------
# 3. The `computed` column's wrapper shape (shared with `recompute.py`)
# ---------------------------------------------------------------------------


def computed_wrapper(result_type: str, value: Any) -> dict[str, Any]:
    """The `{"type": X, X: value}` wrapper both `db_row_props.properties`
    (spec §3.3) and `db_row_props.computed` (migration 016's column
    comment: "in the §3.3 wrapper shape") use, applied to a materialised
    formula/rollup result. `recompute.py` (this task's sibling module, the
    only writer of `computed`) is the primary caller; this module also
    reads it back when a rollup's TARGET property is itself a formula/
    rollup (`RollupTarget.is_computed`)."""
    return {"type": result_type, result_type: value}


def computed_raw(wrapper: dict[str, Any] | None, type_field: str) -> Any:
    """The inverse of `computed_wrapper` -- also works on an ordinary
    `properties` wrapper (identical shape, spec §3.3), since both columns
    use the same convention. `wrapper is None` (the key was entirely
    absent) and a wrapper present but missing `type_field` both answer
    `None` -- "no value", the uniform signal `aggregations.py`'s own
    `_raw_value` already treats every absent/null cell as."""
    if not wrapper:
        return None
    return wrapper.get(type_field)


# ---------------------------------------------------------------------------
# 4. The rollup target
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RollupTarget:
    """The rollup's target property (research §17: "which property on the
    target [database]"). `key` is its `db_properties.key`.

    For a STORED (user-authored) target property, `type` is its real
    `db_properties.type` (e.g. `"number"`) and `is_computed` is `False` --
    its value lives in `db_row_props.properties`.

    For a target property that is ITSELF a formula or rollup,
    `is_computed=True` and `result_type` carries Task 24's `FType` string
    (e.g. `"number"`) -- `type` in this case is just `"formula"`/
    `"rollup"` (informational; not used for dispatch), and the value lives
    in `db_row_props.computed` instead. This is how "rollups over rollups
    are permitted within depth 3" (spec §9) and "formulas can reference
    rollups" (research §4.2) both work without this module recursing at
    all: `recompute.py` computes properties in TOPOLOGICAL order (Task
    24's `deps.topological_order`), so by the time it asks this module to
    compute a rollup whose target is another rollup/formula, that target's
    `computed` entry is already fresh. Depth enforcement (formula depth 15,
    relation traversal depth 3) is entirely `recompute.py`'s job, using
    Task 24's `deps.max_reference_depth` -- this module has no depth
    concept of its own.
    """

    key: str
    type: str
    is_computed: bool = False
    result_type: str | None = None  # required (asserted) when is_computed


# ---------------------------------------------------------------------------
# 5. Translating a target into what `aggregate()` needs
# ---------------------------------------------------------------------------


def _lookup_type_for(target: RollupTarget) -> str:
    """The `PropertyLookup.type` this module presents to `aggregate()` so
    that M4's own per-family validation, empty-set results, and `is_empty`
    dispatch run COMPLETELY UNCHANGED -- this function is the entire
    translation layer, not a parallel reimplementation.

    A STORED target needs no translation at all: `target.type` IS already
    one of the real `db_properties.type` strings `aggregate()` already
    knows how to handle (this is exactly why M4 designed `aggregate()`
    around real property types in the first place).

    A COMPUTED target (the target property is itself a formula/rollup) has
    no `db_properties.type` to hand over -- only an `FType` result_type.
    Translated to the nearest `aggregate()`-recognised stand-in:
    - NUMBER / DATE map onto themselves (`aggregate()`'s numeric and date
      families are keyed by exactly the strings `"number"`/`"date"`
      already, and this module's own `computed_wrapper` encodes a
      computed Date exactly as `{"start", "end"}`, byte-for-byte matching
      the stored `date` property's own value shape -- see
      `_decode_raw`/`recompute.py`).
    - BOOLEAN maps onto `"checkbox"` (`aggregate()`'s checkbox-family key).
    - LIST maps onto `"multi_select"`, so `count_values`/`unique`'s
      flatten-and-dedupe special case (research §I.5.3, already decided by
      M4) applies to a List-typed formula/rollup result the same way it
      already does to a stored multi_select -- a decision, not a
      documented fact (research never discusses rollups over List-typed
      formulas at all), flagged in this task's report.
    - STRING / PERSON / PAGE have no family-specific handling in
      `aggregate()` at all -- only `_universal_aggregate`'s `is_empty`
      call ever touches `lookup.type` for them, and EVERY `is_empty`
      override in `services/db/properties/*.py` implements the identical
      rule (`value is None or value == "" or value == [] or value == {}`
      -- verified by reading every one of them while building this
      module). Any REGISTRY key is therefore a safe stand-in; `"rich_text"`
      is picked for readability, not because it is otherwise special.
    """
    if not target.is_computed:
        return target.type
    rt = target.result_type
    if rt == FType.NUMBER.value:
        return "number"
    if rt == FType.BOOLEAN.value:
        return "checkbox"
    if rt == FType.DATE.value:
        return "date"
    if rt == FType.LIST.value:
        return "multi_select"
    return "rich_text"  # STRING / PERSON / PAGE -- see docstring


def _decode_raw(fetched: dict[str, Any] | None, target: RollupTarget) -> Any:
    """The bare value inside `fetched` (a `properties`- or `computed`-
    column wrapper for ONE target row), or `None` if the row has no value
    there at all. The extraction key is the target's OWN type tag (real
    `db_properties.type` for a stored target, `result_type` for a computed
    one) -- deliberately NOT `_lookup_type_for`'s translated stand-in,
    which exists only for handing a value BACK to `aggregate()`, not for
    reading one out of the row that was actually fetched."""
    type_field = target.result_type if target.is_computed else target.type
    return computed_raw(fetched, type_field)


# ---------------------------------------------------------------------------
# 6. show_original / show_unique (the 2 genuine extras)
# ---------------------------------------------------------------------------


def _is_empty_raw(value: Any) -> bool:
    """Same rule as every `is_empty` override in `properties/*.py`
    (verified identical across all of them -- see `_lookup_type_for`'s
    docstring) -- duplicated here rather than reaching into a REGISTRY
    entry for it, since there is no natural per-target-type REGISTRY key
    to reach for at exactly this call site (matching this codebase's own
    documented precedent for this exact class of small duplication --
    `properties/scalar.py`'s `_is_empty`)."""
    return value is None or value == "" or value == [] or value == {}


def _hashable(value: Any) -> Any:
    """A canonical, hashable stand-in for `value` so `show_unique` can
    dedupe list/dict-shaped values (a stored multi_select/people/files/date
    target's raw value) the same as any scalar -- duplicated from
    `aggregations.py`'s own private `_hashable` rather than imported (that
    name is module-private there; this is the identical small-duplication
    precedent noted throughout this module)."""
    if isinstance(value, list):
        return tuple(_hashable(v) for v in value)
    if isinstance(value, dict):
        return tuple(sorted((k, _hashable(v)) for k, v in value.items()))
    return value


def _show_values(
    target_ids: list[str],
    values_by_target_id: dict[str, dict[str, Any] | None],
    target: RollupTarget,
    *,
    unique: bool,
) -> list[Any]:
    """`show_original` (every non-empty linked row's raw target value, one
    entry per link, in link order, duplicates kept) / `show_unique` (the
    same, deduplicated, first-occurrence order kept). Empty values are
    skipped for both -- undocumented either way by research, decided by
    analogy with `count_values`'/`not_empty`'s own "non-empty only" rule
    (the immediately adjacent functions in the same "Any property type" UI
    group), flagged in this task's report as a brief-uncovered decision."""
    values: list[Any] = []
    for tid in target_ids:
        raw = _decode_raw(values_by_target_id.get(tid), target)
        if _is_empty_raw(raw):
            continue
        values.append(raw)
    if not unique:
        return values
    seen: set[Any] = set()
    out: list[Any] = []
    for v in values:
        h = _hashable(v)
        if h in seen:
            continue
        seen.add(h)
        out.append(v)
    return out


def _apply_m4(
    function: str,
    target_ids: list[str],
    values_by_target_id: dict[str, dict[str, Any] | None],
    target: RollupTarget,
) -> Any:
    """Every rollup function except `count`/`show_original`/`show_unique`
    goes through here: rebuild the `{"id", "properties"}` row shape
    `aggregate()` expects (task-13-brief.md's own decided shape), wrapped
    under a throwaway key (`"_v"` -- never a real property key, never
    persisted, exists only for this one call), and hand it to
    `aggregate()` UNCHANGED. `aggregate()`'s own `ValueError` (wrong
    target-type family, e.g. `sum` over a non-Number target) is re-raised
    with rollup-specific context rather than swallowed."""
    lookup_type = _lookup_type_for(target)
    fake_rows: list[dict[str, Any]] = []
    for tid in target_ids:
        raw = _decode_raw(values_by_target_id.get(tid), target)
        props = {} if raw is None else {"_v": {lookup_type: raw}}
        fake_rows.append({"id": tid, "properties": props})
    lookup = PropertyLookup(type=lookup_type, storage="jsonb", key="_v")
    try:
        return aggregate(fake_rows, lookup, function)
    except ValueError as exc:
        raise ValueError(f"rollup function {function!r}: {exc}") from exc


# ---------------------------------------------------------------------------
# 7. The public entrypoint
# ---------------------------------------------------------------------------


async def compute_rollup(
    conn: asyncpg.Connection,
    user_id: str,
    *,
    relation: relations.RelationRef,
    owner_row_ids: list[str],
    target_data_source_id: str,
    target: RollupTarget,
    function: str,
) -> dict[str, Any]:
    """Computes `function` over `target` for every row in `owner_row_ids`,
    via `relation`. Returns `{owner_row_id: value}` for EVERY id in
    `owner_row_ids` (never a missing key, mirroring `list_links_bulk`'s own
    contract), `value` being whatever `aggregate()`/`show_original`/
    `show_unique` produce -- `None` for an empty-set aggregate M4 decided
    should be null, `0.0` for `sum` of nothing, `[]` for `show_original`/
    `show_unique` of nothing, `[]`-free of empties otherwise.

    Exactly 2 queries regardless of `len(owner_row_ids)` (plus zero for
    `function == "count"`, which never reads a target value at all --
    research §17's "Count all" is a pure link count): one
    `list_links_bulk` call, one bulk fetch of every distinct linked target
    row's `properties` or `computed` column (whichever `target.is_computed`
    says). Never a per-row round trip -- task-27-brief.md's explicit N+1
    warning, restated from M7's own `list_links_bulk` docstring.

    Raises `ValueError` for: an unknown `function`; `target.type ==
    "relation"` (a relation has no single materialised value to
    aggregate -- `services/db/relations.py` is the only source of truth
    for ITS links, and rolling up a relation would mean traversing a
    SECOND relation hop, which this module deliberately does not do --
    see `RollupTarget`'s docstring on why depth is entirely `recompute.py`'s
    concern); `target.is_computed` with no `result_type`; or whatever
    `aggregate()` itself raises for a target-type family mismatch (e.g.
    `sum` over a non-Number target), re-raised with added context by
    `_apply_m4`.
    """
    if function not in ROLLUP_FUNCTIONS:
        raise ValueError(f"unknown rollup function: {function!r}")
    if target.is_computed and target.result_type is None:
        raise ValueError("target.result_type is required when target.is_computed is True")
    if function != "count" and target.type == "relation":
        raise ValueError(
            "rollup target property is itself a relation -- not supported: a "
            "relation has no single materialised value to aggregate "
            "(services/db/relations.py is the only source of truth for its "
            "links). Roll up a stored or formula/rollup property on the "
            "target data source instead."
        )

    if not owner_row_ids:
        return {}

    links = await relations.list_links_bulk(conn, user_id, relation, owner_row_ids)

    if function == "count":
        # research §17: "Count all" -- a pure link count, no target read.
        return {rid: float(len(ids)) for rid, ids in links.items()}

    all_target_ids = sorted({tid for ids in links.values() for tid in ids})
    values_by_target_id: dict[str, dict[str, Any] | None] = {}
    if all_target_ids:
        column = "computed" if target.is_computed else "properties"
        rows = await conn.fetch(
            f"""
            SELECT note_id, {column} AS blob FROM db_row_props
            WHERE user_id = $1 AND data_source_id = $2 AND note_id = ANY($3::uuid[])
            """,
            user_id,
            target_data_source_id,
            all_target_ids,
        )
        for r in rows:
            values_by_target_id[str(r["note_id"])] = r["blob"].get(target.key)

    result: dict[str, Any] = {}
    is_number_result = ROLLUP_RESULT_TYPE[function] is FType.NUMBER
    for rid, target_ids in links.items():
        if function in _SHOW_FUNCTIONS:
            value = _show_values(
                target_ids, values_by_target_id, target, unique=(function == "show_unique")
            )
        else:
            value = _apply_m4(function, target_ids, values_by_target_id, target)
        if is_number_result and isinstance(value, (int, float)) and not isinstance(value, bool):
            # Normalise every NUMBER-result function to `float` -- FValue's
            # own "Number is always float" invariant (formula/values.py),
            # kept for a rollup's result too since it materialises into the
            # identical `computed` wrapper shape a NUMBER-typed formula
            # does. `sum([])`/`count_values`/etc. can come back as a plain
            # Python `int` from `aggregate()`; `None` (an empty-set null)
            # is left alone by the `isinstance` guard.
            value = float(value)
        result[rid] = value
    return result
