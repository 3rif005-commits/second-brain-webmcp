"""Materialisation orchestration: turning saved formula/rollup properties
into `db_row_props.computed` values (Milestone 8e, Task 27).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.3
(materialisation and the dependency graph), §7.4 (volatile formulas), §9
(rollups share the dependency graph and depth limits).
Research: docs/research/notion-databases-research.md §4.1-4.6 (evaluation
model, cross-formula/rollup depth, "unsupported" sentinel), §B.1 (the
2026-08-05 Notion changelog entry this sentinel copies).
Brief: .superpowers/sdd/2026-08-08-notion-databases/task-27-brief.md §2.

Built on `services/db/formula/` (Tasks 23-26, complete: parser, type
checker, dependency graph, evaluator, all 93 builtins) and `services/db/
rollup.py` (this task's sibling module, committed first).

The five things this module exists to get right (each documented again at
its own call site, restated here as an index):
1. Writes ONLY to `db_row_props.computed`, never `properties` --
   `_write_computed_batch` is the ONE function in this module (indeed, in
   this whole codebase outside test fixtures) that touches that column.
2. Topological order (Task 24's `deps.topological_order`) drives both
   "on property save, reject cycles with the path" (`validate_save`) and
   "on row write, recompute topologically" (`_materialise_node`, called in
   `order` sequence by both `recompute_full` and `recompute_row`).
3. The three limits -- formula depth 15 (`FORMULA_DEPTH_LIMIT`, via Task
   24's `deps.max_reference_depth`), relation traversal depth 3
   (`EvalContext.depth_budget`, Task 26's contract, genuinely reachable
   through a real formula since the M8 combined-review fix wave --
   `_build_related_properties` supplies the data, `evaluator._eval_prop_
   dot` consumes it), propagation/fan-out 10,000 rows
   (`ROLLUP_FANOUT_LIMIT`) -- each produce `UNSUPPORTED` with no partial
   value.
4. Volatile formulas (`db_properties.is_volatile`) are skipped entirely by
   every pass in this module -- never evaluated here at all, per spec §7.4
   ("evaluated in Python over the rows being returned instead", a
   request-time concern for a later task, not this one).
5. `RecomputeLivenessError` (Grist's borrowed liveness assertion) fires
   only from `recompute_full` -- `recompute_row`'s docstring explains why
   an incremental pass legitimately computes zero cells.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import asyncpg

from . import relations
from . import rollup
from .formula import ast as A
from .formula import evaluator, values as fvalues
from .formula.deps import GraphNode, Graph, PropertyDef, build_graph, max_reference_depth, topological_order
from .formula.parser import parse
from .formula.types import FType, PROPERTY_TYPE_TO_FTYPE

__all__ = [
    "FORMULA_DEPTH_LIMIT",
    "ROLLUP_FANOUT_LIMIT",
    "ROW_BATCH_SIZE",
    "UNSUPPORTED",
    "RecomputeStats",
    "RecomputeLivenessError",
    "validate_save",
    "recompute_full",
    "recompute_row",
]


# ---------------------------------------------------------------------------
# 1. Limits and the sentinel
# ---------------------------------------------------------------------------

# Research §4.3/§4.5, official: "Notion formulas can only be 15 layers
# deep. Every time a formula references another formula or rollup, it adds
# a layer." Depth is computed by Task 24's `deps.max_reference_depth` --
# the number of EDGES on the longest outgoing reference chain -- and a
# property AT OR BEYOND this depth is never evaluated at all (no partial
# value), matching research §B.1's 2026-08-05 changelog sentinel exactly.
FORMULA_DEPTH_LIMIT = 15

# Research gives NO published number for either "related pages/rollups a
# single cell may aggregate over" or "rows one write may cascade to" --
# §4.5 states plainly "no threshold published" for the `"unsupported"`
# trigger, and spec §7.3 calls 10,000 out as OUR OWN choice ("following
# Notion" in spirit, not in the literal number). Applied at TWO points in
# this module, deliberately sharing one constant (a judgment call, flagged
# in this task's report): (a) a rollup whose relation links more than this
# many target rows FOR ONE OWNER ROW is not aggregated at all -- the
# per-cell "unsupported" reading, matching Notion's own quoted trigger
# text ("depends on excessive related pages") and producing a per-cell
# sentinel the same SHAPE as the depth-15/relation-depth-3 limits do; (b)
# `recompute_row`'s propagation BFS stops once it has touched this many
# rows total, a pure cascade-size safety cap (this second use does not, by
# itself, write any `unsupported` value -- it just stops recursing).
ROLLUP_FANOUT_LIMIT = 10_000

# Mirrors routers/databases.py's `_ROWS_LIMIT` (500) -- "reuse the concept"
# per the brief, not the literal constant (that one lives in the routers
# layer, which services/ must not import). Used only to chunk the SIZE of
# each batched multi-row `computed` UPDATE, not to page the compute step
# itself (this codebase's own "one enthusiastic single user" scale
# envelope, restated throughout Milestones 4-7, makes holding one data
# source's rows in memory during a recompute pass a non-issue; chunking the
# WRITE avoids one gigantic UPDATE statement regardless).
ROW_BATCH_SIZE = 500

# Research §B.1: Notion's own 2026-08-05 API sentinel for a value that
# "depend[s] on excessive related pages or nested formulas [and rollups]",
# "with no partial value". Copied, not invented -- migration 016's own
# column comment on `db_row_props.computed` names this exact shape too.
UNSUPPORTED: dict[str, Any] = {"type": "unsupported"}


class RecomputeLivenessError(Exception):
    """Grist's `depend.py` liveness assertion (spec §7.3), stolen
    outright: a FULL recompute pass that computed zero cells despite the
    graph containing at least one non-volatile formula/rollup property
    with at least one row to compute it over. The point, worth restating
    since it looks like a bug at first glance: a graph that silently
    computes nothing returns stale `computed` data forever and looks
    perfectly healthy (no exception, no error row) -- this converts that
    silent stall into a loud, immediate failure. Scoped to FULL passes
    only (`recompute_full`) -- `recompute_row`'s own docstring explains why
    an incremental single-row recompute legitimately computes zero cells
    routinely (nothing downstream of the edited row), and asserting there
    would fire constantly on ordinary, correct behaviour."""


@dataclass
class RecomputeStats:
    """`cells_computed` counts (row, formula/rollup property) pairs this
    pass ATTEMPTED to materialise -- incremented for every row a
    non-volatile formula/rollup property was evaluated/aggregated for,
    regardless of whether the resulting value was a real value, `EMPTY`
    (omitted from `computed`), or `UNSUPPORTED`. This is deliberate: the
    liveness assertion needs to know whether the graph DID ANYTHING, not
    whether it produced non-null output -- a data source whose every
    formula legitimately evaluates to `empty()` for every row is healthy
    and must not trip the assertion."""

    cells_computed: int = 0


# ---------------------------------------------------------------------------
# 2. Loading the graph
# ---------------------------------------------------------------------------


async def _load_all_properties(conn: asyncpg.Connection, user_id: str) -> list[asyncpg.Record]:
    """Every `db_properties` row for this user, across every data source --
    a rollup's target property (research §9/§4.2) can live in a DIFFERENT
    data source than the rollup itself, and a correct dependency graph (and
    a correct materialisation ORDER) has to span all of them. Scoped by
    `user_id` alone (this app has exactly one tenant boundary; every other
    query in this module additionally scopes by `data_source_id` once it
    has one)."""
    return await conn.fetch(
        """
        SELECT id, data_source_id, key, name, type, config, result_type, is_volatile
        FROM db_properties WHERE user_id = $1
        """,
        user_id,
    )


def _property_defs(records: list[asyncpg.Record]) -> list[PropertyDef]:
    """`deps.PropertyDef` per record -- config field names are THIS
    codebase's own (not yet exercised by any router; Task 28 owns writing
    them): a formula property's config is `{"expression": "<source>"}`
    (research §4.1's own `formula.expression` field name, reused for
    forward consistency); a rollup property's config is
    `{"relation_key", "target_data_source_id", "target_key", "function"}`."""
    defs: list[PropertyDef] = []
    for r in records:
        ds_id = str(r["data_source_id"])
        cfg = r["config"] or {}
        kwargs: dict[str, Any] = dict(data_source_id=ds_id, key=r["key"], name=r["name"], type=r["type"])
        if r["type"] == "formula":
            kwargs["formula_source"] = cfg.get("expression")
        elif r["type"] == "rollup":
            kwargs["rollup_relation_key"] = cfg.get("relation_key")
            target_ds = cfg.get("target_data_source_id")
            kwargs["rollup_target_data_source_id"] = str(target_ds) if target_ds else None
            kwargs["rollup_target_key"] = cfg.get("target_key")
        defs.append(PropertyDef(**kwargs))
    return defs


def _names_by_ds(records: list[asyncpg.Record]) -> dict[str, dict[str, str]]:
    """`{data_source_id: {key: name}}` -- needed both for `parse()`'s
    `property_names` argument (bare-token resolution, Task 23) and for
    resolving a rollup's declared relation/target KEYS back to db_properties
    rows via `by_node`."""
    out: dict[str, dict[str, str]] = {}
    for r in records:
        out.setdefault(str(r["data_source_id"]), {})[r["key"]] = r["name"]
    return out


@dataclass(frozen=True)
class _GraphState:
    records: list[asyncpg.Record]
    graph: Graph
    order: list[GraphNode]
    by_node: dict[GraphNode, asyncpg.Record]
    names_by_ds: dict[str, dict[str, str]]


async def _load_graph_state(conn: asyncpg.Connection, user_id: str) -> _GraphState:
    """The one place `deps.build_graph`/`topological_order` are called from
    in this module. `topological_order` raises `FormulaCycleError` (with
    the exact cycle path) the moment it finds one -- this function does not
    catch it; both `validate_save` (deliberately) and every materialisation
    entrypoint (defensively -- a cycle should already have been rejected at
    save time, so reaching one here means save-time validation was
    bypassed, and failing loudly is correct, not a silent skip) let it
    propagate."""
    records = await _load_all_properties(conn, user_id)
    defs = _property_defs(records)
    graph = build_graph(defs)
    order = topological_order(graph)
    by_node = {(str(r["data_source_id"]), r["key"]): r for r in records}
    return _GraphState(records, graph, order, by_node, _names_by_ds(records))


async def validate_save(conn: asyncpg.Connection, user_id: str) -> list[GraphNode]:
    """Call this from the property-save path (Task 28's router seam),
    AFTER the candidate formula/rollup property's config has been staged
    (e.g. inside the same transaction, before COMMIT) so the graph it
    builds includes the edit being validated. Raises `deps.
    FormulaCycleError` (with the exact cycle path, spec §7.3) if the save
    would close a dependency loop -- rejected outright, the property is
    never persisted.

    Deliberately does NOT reject a merely over-deep (but acyclic) chain --
    that is materialisation's problem (`FORMULA_DEPTH_LIMIT`, enforced in
    `_materialise_node` below), not save-time's. This is the exact
    distinction Task 24's brief drew and this task's brief repeats: **a
    cycle is rejected at save time; an over-deep formula still saves and
    materialises as `unsupported`.** Conflating the two here (e.g. also
    checking `max_reference_depth` and rejecting past 15) would reject
    formulas Notion's own documented behaviour allows to save."""
    state = await _load_graph_state(conn, user_id)
    return state.order


# ---------------------------------------------------------------------------
# 3. Formula value <-> FValue <-> JSON
# ---------------------------------------------------------------------------


def _parse_iso(raw: str) -> datetime:
    """Same normalisation as every other ISO-8601 parser duplicated across
    this codebase (query/operators.py's `_coerce_date`, services/db/
    relations.py's `_parse_iso`, query/aggregations.py's `_parse_instant`)
    -- five lines, deliberately not shared, matching that established
    precedent."""
    from datetime import UTC

    normalised = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    parsed = datetime.fromisoformat(normalised)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _decode_stored(prop_type: str, wrapper: dict[str, Any] | None) -> fvalues.FValue:
    """A STORED (user-authored) property's §3.3 wrapper -> the formula
    evaluator's `FValue`. Type-driven via `PROPERTY_TYPE_TO_FTYPE` (Task
    24), so this stays in lockstep with the checker's own property-type ->
    formula-type mapping rather than re-deriving it. `formula`/`rollup`
    properties never reach this function (they are handled by
    `_materialise_node`, reading `computed`, not `properties`) --
    `relation` never reaches it either (`_stored_values_for_rows` batches
    it separately via `list_links_bulk`, since a relation has no value in
    `properties` at all, M7). `place`/`verification`/`button` -- like
    `formula`/`rollup` in `PROPERTY_TYPE_TO_FTYPE`, but for a different
    reason (no formula-visible value documented at all, not "handled
    elsewhere") -- fall through to `EMPTY`."""
    if not wrapper:
        return fvalues.EMPTY
    raw = wrapper.get(prop_type)
    if raw is None:
        return fvalues.EMPTY
    ftype = PROPERTY_TYPE_TO_FTYPE.get(prop_type, FType.UNKNOWN)
    if ftype is FType.STRING:
        return raw if isinstance(raw, str) else fvalues.EMPTY
    if ftype is FType.NUMBER:
        return float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else fvalues.EMPTY
    if ftype is FType.BOOLEAN:
        return bool(raw) if isinstance(raw, bool) else fvalues.EMPTY
    if ftype is FType.DATE:
        if not isinstance(raw, dict) or raw.get("start") is None:
            return fvalues.EMPTY
        end = raw.get("end")
        return fvalues.Date(start=_parse_iso(raw["start"]), end=_parse_iso(end) if end else None)
    if ftype is FType.LIST:
        if prop_type == "multi_select":
            return list(raw) if isinstance(raw, list) else fvalues.EMPTY
        if prop_type == "people":
            return [_decode_person(p) for p in raw] if isinstance(raw, list) else fvalues.EMPTY
        if prop_type == "files":
            # research §F.1's own "List of Text (URLs)" [P2] -- best-effort,
            # not separately researched by this task: a files entry may be
            # a bare string or an object with a "url"/"name" field
            # depending on how it was written; both are coerced to a bare
            # string so `length()`/`join()` on the result still work.
            return [f if isinstance(f, str) else str(f.get("url") or f.get("name") or f) for f in raw] if isinstance(raw, list) else fvalues.EMPTY
        return fvalues.EMPTY  # `relation` never reaches here, see docstring
    if ftype is FType.PERSON:
        return _decode_person(raw) if isinstance(raw, dict) else fvalues.EMPTY
    return fvalues.EMPTY  # UNKNOWN: formula/rollup (never reach here)/place/verification/button


def _decode_person(raw: Any) -> fvalues.FValue:
    if not isinstance(raw, dict) or not raw.get("id"):
        return fvalues.EMPTY
    return fvalues.Person(id=str(raw["id"]), name=raw.get("name"), email=raw.get("email"))


def _encode_fvalue(value: fvalues.FValue) -> Any:
    """`FValue` -> a JSON-serialisable Python value, for the inside of
    `rollup.computed_wrapper`. Never called with `EMPTY` at the top level
    (callers omit the key entirely instead, spec §3.3's "absent key ≡
    empty" convention) -- `EMPTY` inside a `List` element is defensive
    (no builtin can currently put one there, since every list-producing
    builtin already filters/maps to a real value) and encodes to JSON
    `null`."""
    if value is fvalues.EMPTY:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, str):
        return value
    if isinstance(value, fvalues.Date):
        return {"start": value.start.isoformat(), "end": value.end.isoformat() if value.end else None}
    if isinstance(value, list):
        return [_encode_fvalue(v) for v in value]
    if isinstance(value, fvalues.Person):
        return {"id": value.id, "name": value.name, "email": value.email}
    if isinstance(value, fvalues.Page):
        return {"id": value.id}
    raise TypeError(f"cannot encode formula value of type {type(value)!r}")  # pragma: no cover


def _json_to_fvalue(raw: Any) -> fvalues.FValue:
    """Best-effort, shape-driven JSON -> `FValue` coercion, used ONLY for
    feeding a rollup's OWN raw output back into another row's context as a
    reference-by-name value (a formula reading `prop("SomeRollup")`) --
    there is no `db_properties.type` to dispatch on at that point, only a
    Python value. Handles the shapes this module's own encoders/`rollup.py`
    actually produce (float/str/bool, `{"start", "end"}` for Date,
    `{"id", ...}` for Page/Person, list -- recursively); anything else
    (should not occur, since every rollup/stored value flows through the
    same §3.3 wrapper convention) is `EMPTY` rather than a guess. Not
    separately researched -- research gives no guidance on formulas
    referencing `show_original`/`show_unique` rollups by name at all, and
    this is this task's own pragmatic reading, flagged in its report."""
    if raw is None:
        return fvalues.EMPTY
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        return [_json_to_fvalue(v) for v in raw]
    if isinstance(raw, dict):
        if "start" in raw:
            end = raw.get("end")
            return fvalues.Date(start=_parse_iso(raw["start"]), end=_parse_iso(end) if end else None)
        if "id" in raw:
            return fvalues.Person(id=str(raw["id"]), name=raw.get("name"), email=raw.get("email"))
    return fvalues.EMPTY


def _rollup_raw_to_fvalue(function: str, raw: Any) -> fvalues.FValue:
    """A rollup's own M4-shaped output (`services/db/rollup.py`'s
    `compute_rollup` return value: a float, an ISO date string, `None`, or
    a list of raw target values) -> `FValue`, so a LATER formula that
    references this rollup property by name (`prop("Total")`) gets a
    usable value from the in-memory context this module accumulates, not
    just a JSON blob written to `computed`. Dispatches on `ROLLUP_RESULT_
    TYPE[function]` (NUMBER/DATE/LIST are the only three reachable, see
    `rollup.py`)."""
    if raw is None:
        return fvalues.EMPTY
    result_type = rollup.ROLLUP_RESULT_TYPE[function]
    if result_type is FType.NUMBER:
        return float(raw)
    if result_type is FType.DATE:
        # earliest_date/latest_date (aggregations.py) return a bare ISO
        # string, matching the "date"/`created_time` stored-value shape.
        return fvalues.Date(start=_parse_iso(raw)) if isinstance(raw, str) else fvalues.EMPTY
    if result_type is FType.LIST:
        return [_json_to_fvalue(v) for v in raw] if isinstance(raw, list) else fvalues.EMPTY
    return fvalues.EMPTY  # pragma: no cover -- no rollup function has any other result type


# ---------------------------------------------------------------------------
# 4. Building a row's evaluation context (stored values + relation hops)
# ---------------------------------------------------------------------------


async def _stored_values_for_rows(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    row_ids: list[str],
    stored_props: list[asyncpg.Record],
    relation_props: list[asyncpg.Record],
) -> dict[str, dict[str, fvalues.FValue]]:
    """`{row_id: {property_name: FValue}}` for every row in `row_ids`,
    covering every STORED (non-formula/rollup) property, INCLUDING
    relation properties (each surfaced as `list[Page]`, one relation hop,
    batched via `relations.list_links_bulk` -- never per-row). This is the
    BASE LAYER `_materialise_node` starts from; formula/rollup values
    computed later in topological order are merged into the same dict by
    the caller, so a dependent formula sees them too."""
    ctx: dict[str, dict[str, fvalues.FValue]] = {rid: {} for rid in row_ids}
    if not row_ids:
        return ctx

    rows = await conn.fetch(
        "SELECT note_id, properties FROM db_row_props "
        "WHERE user_id = $1 AND data_source_id = $2 AND note_id = ANY($3::uuid[])",
        user_id, data_source_id, row_ids,
    )
    props_by_row = {str(r["note_id"]): (r["properties"] or {}) for r in rows}

    for p in stored_props:
        for rid in row_ids:
            wrapper = props_by_row.get(rid, {}).get(p["key"])
            ctx[rid][p["name"]] = _decode_stored(p["type"], wrapper)

    for p in relation_props:
        ref = relations.relation_ref_from_config(p["config"])
        if ref is None:
            for rid in row_ids:
                ctx[rid][p["name"]] = []
            continue
        links = await relations.list_links_bulk(conn, user_id, ref, row_ids)
        for rid in row_ids:
            ctx[rid][p["name"]] = [fvalues.Page(id=x) for x in links.get(rid, [])]

    return ctx


async def _build_related_properties(
    conn: asyncpg.Connection,
    user_id: str,
    row_ids: list[str],
    stored_ctx: dict[str, dict[str, fvalues.FValue]],
    relation_props: list[asyncpg.Record],
    all_records: list[asyncpg.Record],
) -> dict[str, dict[str, fvalues.FValue]]:
    """`{page_id: {property_name: FValue}}` for every page `row_ids`
    reaches through ONE of this data source's relation properties -- the
    exact map `evaluator.EvalContext.related_properties` needs so a
    `.prop()` dot-form call whose receiver evaluates to a `Page`
    (`current.prop("Status")` inside `prop("Tasks").filter(...)`, research
    §3.8's own documented idiom) can resolve against the RELATED row's
    values instead of `ctx.properties` (see evaluator.py's `_eval_prop_dot`
    -- the fix this function's caller exists to feed).

    Reuses `_stored_values_for_rows` -- the SAME batched-fetch primitive
    `_ensure_ds_loaded`/`_recompute_row_with_state` already call for a
    row's OWN properties -- once per TARGET data source. `relation_props`'
    own `config["target_data_source_id"]` (set at relation-creation time by
    `relations.create_relation_pair`/`_insert_relation_property`, never
    re-derived here) is what makes a genuinely cross-data-source relation
    work identically to a self-relation, with no special-casing: `stored_
    ctx` already holds each relation property's linked pages (as
    `list[Page]`, decoded by `_stored_values_for_rows` itself) for
    `row_ids`, grouped here by which data source they belong to, then
    fetched with one `_stored_values_for_rows` call per target data source
    -- `all_records` (== `_GraphState.records`, spanning every data source
    this user owns, per `_load_all_properties`'s own docstring) supplies
    that target data source's own stored/relation property DEFINITIONS,
    so decoding its rows needs no separate schema-lookup path either.

    A DELIBERATE, narrower-than-`depth_budget=3` scope, not an oversight:
    only pages ONE hop away from `row_ids` are populated. A `.prop()` dot
    chain that hops a SECOND relation on an already-related page
    (`current.prop("OtherRelation").prop("X")`) finds no entry for that
    third page in the returned map and `_eval_prop_dot` degrades to EMPTY
    for it -- gracefully, per its own contract, never wrong data, just
    absent for a hop this pass did not pre-fetch. Always fresh (never
    reused from an already-built `stored_ctx`, even for a self-relation
    where that might sometimes already hold the answer): `recompute_row`'s
    incremental pass only ever loads ONE row's own `stored_ctx` entry, so
    an optimisation that special-cased "self-relation reuses the caller's
    stored_ctx" would behave differently between a full pass (where it
    might coincidentally see a related row's already-computed formula
    value) and an incremental one (where it never could) -- a confusing,
    hard-to-reason-about inconsistency avoided here by always doing one
    fresh, STORED-properties-only fetch, uniformly. The corollary, an
    honest documented limitation: a related row's own COMPUTED
    (formula/rollup) property is never visible through a dot-hop, in
    either pass -- `_stored_values_for_rows` decodes STORED properties
    only (its own docstring), by construction."""
    if not row_ids or not relation_props:
        return {}

    records_by_ds: dict[str, list[asyncpg.Record]] = {}
    for r in all_records:
        records_by_ds.setdefault(str(r["data_source_id"]), []).append(r)

    page_ids_by_target_ds: dict[str, set[str]] = {}
    for p in relation_props:
        target_ds = (p["config"] or {}).get("target_data_source_id")
        if not target_ds:
            continue
        target_ds = str(target_ds)
        for rid in row_ids:
            for pg in stored_ctx.get(rid, {}).get(p["name"], []) or []:
                if isinstance(pg, fvalues.Page):
                    page_ids_by_target_ds.setdefault(target_ds, set()).add(pg.id)

    related: dict[str, dict[str, fvalues.FValue]] = {}
    for target_ds, page_ids in page_ids_by_target_ds.items():
        target_records = records_by_ds.get(target_ds, [])
        target_stored = [r for r in target_records if r["type"] not in ("formula", "rollup", "relation")]
        target_relation = [r for r in target_records if r["type"] == "relation"]
        fetched = await _stored_values_for_rows(
            conn, user_id, target_ds, sorted(page_ids), target_stored, target_relation
        )
        related.update(fetched)
    return related


# ---------------------------------------------------------------------------
# 5. Materialising one property, for a batch of its own rows
# ---------------------------------------------------------------------------


async def _compute_formula(
    rec: asyncpg.Record,
    data_source_id: str,
    row_ids: list[str],
    stored_ctx: dict[str, dict[str, fvalues.FValue]],
    related_properties: dict[str, dict[str, fvalues.FValue]],
    names_by_ds: dict[str, dict[str, str]],
    now: datetime,
) -> tuple[dict[str, fvalues.FValue], dict[str, dict[str, Any] | None]]:
    """Evaluates ONE formula property for every row in `row_ids`, using
    `stored_ctx[row_id]` (already merged with every dependency's value,
    since the caller processes properties in topological order) and
    `related_properties` (`_build_related_properties`'s own return value --
    every page ONE relation hop away from `row_ids`, own docstring for the
    full contract). Returns `(values, writes)`: `values` are `FValue`s for
    merging back into `stored_ctx` (so a LATER formula referencing this one
    gets a real value, not a re-parse); `writes[row_id] is None` means
    "omit the key" (the row's value is `EMPTY`, spec §3.3's absent-key
    convention), otherwise it is a ready-to-write `computed` wrapper.

    The relation-traversal-depth-3 contract (`EvalContext.depth_budget`/
    `with_relation_hop`/`depth_exceeded`) is honoured exactly as before --
    every `EvalContext` built here still gets the default `depth_budget=3`
    and `ctx.depth_exceeded` is still checked after evaluating, turning it
    into `UNSUPPORTED` exactly like the other two limits (formula depth 15,
    rollup fan-out 10,000). What changed (M8 combined-review fix wave): the
    evaluator's `.prop()` dot-form now genuinely calls `with_relation_hop()`
    for a `Page`-typed receiver, so this limit is reachable through a real
    formula for the first time -- see `evaluator._eval_prop_dot`'s own
    docstring for the fix, and `_build_related_properties`'s for how this
    function now supplies the data that fix reads."""
    source = (rec["config"] or {}).get("expression") or ""
    property_names = names_by_ds.get(data_source_id, {}).values()
    values: dict[str, fvalues.FValue] = {}
    writes: dict[str, dict[str, Any] | None] = {}
    try:
        tree: A.Node = parse(source, property_names=property_names)
    except Exception:
        # A formula that no longer parses (corrupt config, or a save-time
        # check that was bypassed) degrades to `unsupported` for every row
        # rather than raising and aborting the whole pass -- the same
        # "fail this one cell, not the batch" posture the depth/fan-out
        # limits already take. Broad `except Exception` deliberately: any
        # of `FormulaSyntaxError`/`FormulaTypeError` (a config carrying an
        # expression that no longer type-checks against a since-changed
        # schema) should be caught identically.
        for rid in row_ids:
            values[rid] = fvalues.EMPTY
            writes[rid] = dict(UNSUPPORTED)
        return values, writes

    result_type = rec["result_type"]
    for rid in row_ids:
        eval_ctx = evaluator.EvalContext(
            properties=stored_ctx[rid], now=now, page_id=rid, related_properties=related_properties,
        )
        fv = evaluator.evaluate(tree, eval_ctx)
        if eval_ctx.depth_exceeded:
            values[rid] = fvalues.EMPTY
            writes[rid] = dict(UNSUPPORTED)
            continue
        values[rid] = fv
        writes[rid] = None if fv is fvalues.EMPTY else rollup.computed_wrapper(result_type, _encode_fvalue(fv))
    return values, writes


async def _compute_rollup_property(
    conn: asyncpg.Connection,
    user_id: str,
    rec: asyncpg.Record,
    data_source_id: str,
    row_ids: list[str],
    by_node: dict[GraphNode, asyncpg.Record],
) -> tuple[dict[str, fvalues.FValue], dict[str, dict[str, Any] | None]]:
    """Evaluates ONE rollup property for every row in `row_ids`. Resolves
    the rollup's declared relation/target (`db_properties.config`, see
    `_property_defs`'s docstring for the field names) into a
    `relations.RelationRef` and a `rollup.RollupTarget`, applies the
    per-owner-row fan-out cap (`ROLLUP_FANOUT_LIMIT`) BEFORE calling
    `rollup.compute_rollup` at all (no partial aggregation for a row over
    the cap), then delegates the actual aggregation to `rollup.py`
    entirely -- this function's only job is resolving config into typed
    arguments and applying the two limits `rollup.py` itself has no
    concept of (fan-out; depth-15 is applied one level up, in
    `_materialise_node`, uniformly for formula and rollup alike)."""
    cfg = rec["config"] or {}
    function = cfg.get("function")
    relation_key = cfg.get("relation_key")
    target_ds = cfg.get("target_data_source_id")
    target_key = cfg.get("target_key")

    def _all_empty() -> tuple[dict, dict]:
        return {rid: fvalues.EMPTY for rid in row_ids}, {rid: None for rid in row_ids}

    if not (function and relation_key and target_ds and target_key):
        return _all_empty()  # malformed config -- never crash a pass over it

    rel_rec = by_node.get((data_source_id, relation_key))
    ref = relations.relation_ref_from_config(rel_rec["config"]) if rel_rec is not None else None
    if ref is None:
        return _all_empty()

    target_ds = str(target_ds)
    target_rec = by_node.get((target_ds, target_key))
    is_computed = target_rec is not None and target_rec["type"] in ("formula", "rollup")
    target = rollup.RollupTarget(
        key=target_key,
        type=target_rec["type"] if target_rec is not None else "rich_text",
        is_computed=is_computed,
        result_type=target_rec["result_type"] if (target_rec is not None and is_computed) else None,
    )

    links = await relations.list_links_bulk(conn, user_id, ref, row_ids)
    over_cap = {rid for rid in row_ids if len(links.get(rid, [])) > ROLLUP_FANOUT_LIMIT}
    ok_rows = [rid for rid in row_ids if rid not in over_cap]

    values: dict[str, fvalues.FValue] = {rid: fvalues.EMPTY for rid in over_cap}
    writes: dict[str, dict[str, Any] | None] = {rid: dict(UNSUPPORTED) for rid in over_cap}

    if ok_rows:
        try:
            raw_by_row = await rollup.compute_rollup(
                conn, user_id, relation=ref, owner_row_ids=ok_rows,
                target_data_source_id=target_ds, target=target, function=function,
            )
        except ValueError:
            # A misconfigured rollup (e.g. target-type family mismatch) --
            # degrade to EMPTY for these rows rather than aborting the pass.
            raw_by_row = {rid: None for rid in ok_rows}
        for rid in ok_rows:
            raw = raw_by_row.get(rid)
            values[rid] = _rollup_raw_to_fvalue(function, raw)
            writes[rid] = None if raw is None else rollup.computed_wrapper(
                rollup.ROLLUP_RESULT_TYPE[function].value, raw
            )
    return values, writes


async def _materialise_node(
    conn: asyncpg.Connection,
    user_id: str,
    rec: asyncpg.Record,
    data_source_id: str,
    row_ids: list[str],
    graph: Graph,
    stored_ctx: dict[str, dict[str, fvalues.FValue]],
    related_properties: dict[str, dict[str, fvalues.FValue]],
    by_node: dict[GraphNode, asyncpg.Record],
    names_by_ds: dict[str, dict[str, str]],
    now: datetime,
) -> tuple[dict[str, fvalues.FValue], dict[str, dict[str, Any] | None]] | None:
    """One dependency-graph NODE (one formula or rollup property), applied
    to `row_ids` (all belonging to `data_source_id`). Returns `None` for a
    volatile formula (never materialised at all, spec §7.4 -- no write, no
    liveness credit) or an empty `row_ids`. Applies `FORMULA_DEPTH_LIMIT`
    UNIFORMLY for both formula and rollup properties (spec §9: "rollups ...
    are capped by the same depth limits") before ever calling
    `_compute_formula`/`_compute_rollup_property` -- an over-depth property
    gets NO evaluation attempt at all, matching "no partial value".
    `related_properties` (`_build_related_properties`'s return value, own
    docstring) is threaded through to `_compute_formula` only -- a rollup's
    own evaluation never touches `evaluator.EvalContext` at all, it goes
    straight through `rollup.py`."""
    if not row_ids:
        return None
    if rec["type"] == "formula" and rec["is_volatile"]:
        return None

    node = (data_source_id, rec["key"])
    if max_reference_depth(graph, node) >= FORMULA_DEPTH_LIMIT:
        values = {rid: fvalues.EMPTY for rid in row_ids}
        writes = {rid: dict(UNSUPPORTED) for rid in row_ids}
    elif rec["type"] == "formula":
        values, writes = await _compute_formula(
            rec, data_source_id, row_ids, stored_ctx, related_properties, names_by_ds, now
        )
    else:
        values, writes = await _compute_rollup_property(conn, user_id, rec, data_source_id, row_ids, by_node)

    for rid, fv in values.items():
        stored_ctx.setdefault(rid, {})[rec["name"]] = fv
    return values, writes


# ---------------------------------------------------------------------------
# 6. Writing `computed` -- the ONLY place this module writes to the DB
# ---------------------------------------------------------------------------


async def _write_computed_batch(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    key: str,
    writes: dict[str, dict[str, Any] | None],
) -> None:
    """ONE (or two, see below) SQL statement(s) for up to `ROW_BATCH_SIZE`
    rows -- never a per-row round trip (the brief's explicit warning: "a
    per-row round trip over 10,000 rows on the pooler will time out").
    Writes ONLY `db_row_props.computed`, scoped by `user_id` AND
    `data_source_id`, matching every other write in this codebase (spec
    §7.3's stated reason: `properties` never gets touched here, so
    recompute can never corrupt user-authored data).

    Split into two statements (rows getting a real value vs. rows whose
    value is `EMPTY`, i.e. the key must be REMOVED, not set to a JSON
    `null`) because `jsonb_set` and `-` (key deletion) aren't expressible
    in one `CASE` without smuggling a sentinel through the VALUES list --
    two plain statements are clearer and no slower (each is still exactly
    one round trip). The `wrapper` payload travels as `text[]` cast to
    `::jsonb` inline (`json.dumps` + `::jsonb`), sidestepping any question
    of whether asyncpg's scalar jsonb codec (services/db/connection.py's
    `_init_connection`) round-trips cleanly through a `jsonb[]` array
    parameter -- text is unambiguous either way.
    """
    if not writes:
        return
    set_rows = [(rid, w) for rid, w in writes.items() if w is not None]
    unset_rows = [rid for rid, w in writes.items() if w is None]

    if set_rows:
        note_ids = [rid for rid, _ in set_rows]
        wrapper_json = [json.dumps(w) for _, w in set_rows]
        await conn.execute(
            """
            UPDATE db_row_props AS r
            SET computed = jsonb_set(r.computed, ARRAY[$1], v.wrapper::jsonb, true),
                updated_at = now()
            FROM (SELECT * FROM unnest($2::uuid[], $3::text[]) AS t(note_id, wrapper)) AS v
            WHERE r.note_id = v.note_id AND r.user_id = $4 AND r.data_source_id = $5
            """,
            key, note_ids, wrapper_json, user_id, data_source_id,
        )
    if unset_rows:
        await conn.execute(
            """
            UPDATE db_row_props
            SET computed = computed - $1, updated_at = now()
            WHERE user_id = $2 AND data_source_id = $3 AND note_id = ANY($4::uuid[])
            """,
            key, user_id, data_source_id, unset_rows,
        )


async def _flush(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    key: str,
    writes: dict[str, dict[str, Any] | None],
) -> None:
    """Chunks `writes` into pages of `ROW_BATCH_SIZE` before handing each
    page to `_write_computed_batch` -- bounds the size of any single SQL
    statement this module emits, regardless of how many rows one property
    touches (a full-pass rebuild over a large data source)."""
    items = list(writes.items())
    for i in range(0, len(items), ROW_BATCH_SIZE):
        await _write_computed_batch(conn, user_id, data_source_id, key, dict(items[i : i + ROW_BATCH_SIZE]))


# ---------------------------------------------------------------------------
# 7. recompute_full -- the FULL pass (Grist liveness assertion applies)
# ---------------------------------------------------------------------------


async def recompute_full(
    conn: asyncpg.Connection, user_id: str, *, now: datetime | None = None
) -> RecomputeStats:
    """A full, WORKSPACE-WIDE materialisation pass (every data source this
    user owns, not just one) -- the right scope for "full", since a
    rollup's target property (research §9/§4.2) can live in a different
    data source than the rollup, and correctness of a rebuild depends on
    processing every property in ONE global topological order regardless
    of which data source it happens to live in. Call this after creating
    (or editing the expression/config of) a formula/rollup property, to
    materialise it across all existing rows, or as a scheduled/manual full
    rebuild.

    Raises `RecomputeLivenessError` if the graph contains at least one
    non-volatile formula/rollup property with at least one row to compute
    it over, and the pass computed zero cells anyway (spec §7.3's Grist-
    borrowed liveness assertion) -- see that exception's own docstring for
    why this is scoped to full passes only.
    """
    now = now or evaluator.make_now()
    state = await _load_graph_state(conn, user_id)

    stored_ctx: dict[str, dict[str, fvalues.FValue]] = {}
    related_ctx_by_ds: dict[str, dict[str, dict[str, fvalues.FValue]]] = {}
    row_ids_by_ds: dict[str, list[str]] = {}
    stats = RecomputeStats()

    async def _ensure_ds_loaded(ds_id: str) -> None:
        if ds_id in row_ids_by_ds:
            return
        rows = await conn.fetch(
            "SELECT note_id FROM db_row_props WHERE user_id = $1 AND data_source_id = $2 ORDER BY note_id",
            user_id, ds_id,
        )
        row_ids = [str(r["note_id"]) for r in rows]
        row_ids_by_ds[ds_id] = row_ids
        stored_props = [
            r for r in state.records
            if str(r["data_source_id"]) == ds_id and r["type"] not in ("formula", "rollup", "relation")
        ]
        relation_props = [
            r for r in state.records if str(r["data_source_id"]) == ds_id and r["type"] == "relation"
        ]
        stored_ctx.update(await _stored_values_for_rows(conn, user_id, ds_id, row_ids, stored_props, relation_props))
        # Built AFTER stored_ctx.update() above -- _build_related_properties
        # reads each relation property's already-decoded list[Page] values
        # out of stored_ctx (own docstring).
        related_ctx_by_ds[ds_id] = await _build_related_properties(
            conn, user_id, row_ids, stored_ctx, relation_props, state.records
        )

    for node in state.order:
        ds_id, key = node
        rec = state.by_node.get(node)
        if rec is None or rec["type"] not in ("formula", "rollup"):
            continue
        if rec["type"] == "formula" and rec["is_volatile"]:
            continue  # never materialised -- no DB touch, no liveness credit

        await _ensure_ds_loaded(ds_id)
        row_ids = row_ids_by_ds[ds_id]
        result = await _materialise_node(
            conn, user_id, rec, ds_id, row_ids, state.graph, stored_ctx, related_ctx_by_ds[ds_id],
            state.by_node, state.names_by_ds, now,
        )
        if result is None:
            continue
        _values, writes = result
        await _flush(conn, user_id, ds_id, key, writes)
        stats.cells_computed += len(row_ids)

    # The liveness check DELIBERATELY does not reuse any flag derived from
    # the loop above (e.g. "did we ever see a non-volatile formula/rollup
    # node") -- `stats.cells_computed` and such a flag would always agree
    # by construction in THIS implementation (`_materialise_node` returns
    # non-None, incrementing `cells_computed`, for every non-volatile node
    # with a non-empty `row_ids`), which would make the assertion
    # structurally unable to ever fire -- useless as a defence against
    # exactly the class of bug it exists to catch (the traversal silently
    # skipping work it should have done). `_has_materialisable_opportunity`
    # is a SEPARATE, independent query -- re-deriving "is there really
    # something to compute" from scratch, not from this function's own
    # bookkeeping -- so a bug that makes the loop above skip real work
    # (wrong node keying, a broken `by_node` lookup, ...) still gets
    # caught. Only run when `cells_computed == 0` (the common case never
    # pays for the extra query).
    if stats.cells_computed == 0 and await _has_materialisable_opportunity(conn, user_id):
        raise RecomputeLivenessError(
            "recompute_full computed zero cells despite at least one "
            "non-volatile formula/rollup property existing with at least "
            "one row in its data source -- the dependency graph may be "
            "stalled (spec §7.3's liveness assertion; see "
            "RecomputeLivenessError's docstring)"
        )
    return stats


async def _has_materialisable_opportunity(conn: asyncpg.Connection, user_id: str) -> bool:
    """Independent of `recompute_full`'s own traversal (see the liveness
    check's comment above for why that independence is the whole point):
    a single SQL query answering "does this user have at least one
    non-volatile formula/rollup property in a data source that has at
    least one row" -- re-derived from the same two tables `recompute_full`
    reads, but via a fresh statement, not via `_GraphState`/`row_ids_by_ds`."""
    return bool(
        await conn.fetchval(
            """
            SELECT EXISTS (
                SELECT 1 FROM db_properties p
                JOIN db_row_props r
                  ON r.data_source_id = p.data_source_id AND r.user_id = p.user_id
                WHERE p.user_id = $1 AND p.type IN ('formula', 'rollup')
                  AND NOT (p.type = 'formula' AND p.is_volatile)
                LIMIT 1
            )
            """,
            user_id,
        )
    )


# ---------------------------------------------------------------------------
# 8. recompute_row -- the INCREMENTAL pass (row write -> propagate)
# ---------------------------------------------------------------------------


async def _recompute_row_with_state(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    row_id: str,
    state: _GraphState,
    now: datetime,
    visited: set[str],
    budget: list[int],
) -> dict[str, dict[str, Any] | None]:
    """The shared body `recompute_row` and propagation both call, given an
    ALREADY-LOADED `_GraphState` (avoids re-fetching every `db_properties`
    row on every hop of a propagation cascade). `visited`/`budget` are
    shared, mutable, across the WHOLE cascade -- `budget[0]` is the
    remaining `ROLLUP_FANOUT_LIMIT` row budget for this entire triggering
    write (not per-hop), so a wide or deep cascade cannot silently exceed
    it."""
    if row_id in visited or budget[0] <= 0:
        return {}
    visited.add(row_id)
    budget[0] -= 1

    stored_props = [
        r for r in state.records
        if str(r["data_source_id"]) == data_source_id and r["type"] not in ("formula", "rollup", "relation")
    ]
    relation_props = [
        r for r in state.records if str(r["data_source_id"]) == data_source_id and r["type"] == "relation"
    ]
    stored_ctx = await _stored_values_for_rows(
        conn, user_id, data_source_id, [row_id], stored_props, relation_props
    )
    # Built AFTER _stored_values_for_rows above -- reads this row's
    # already-decoded relation-property list[Page] values out of stored_ctx
    # (_build_related_properties's own docstring). Re-derived per row here
    # (rather than cached across the cascade like recompute_full's
    # `related_ctx_by_ds`) -- an incremental pass only ever touches a
    # handful of rows per write, and `visited`/`budget` already bound the
    # cascade's total size; the per-row cost of one extra fetch is not
    # worth a second cache to keep in sync with `stored_ctx`'s.
    related_properties = await _build_related_properties(
        conn, user_id, [row_id], stored_ctx, relation_props, state.records
    )

    written: dict[str, dict[str, Any] | None] = {}
    for node in state.order:
        ds_id, key = node
        if ds_id != data_source_id:
            continue
        rec = state.by_node.get(node)
        if rec is None or rec["type"] not in ("formula", "rollup"):
            continue
        result = await _materialise_node(
            conn, user_id, rec, ds_id, [row_id], state.graph, stored_ctx, related_properties,
            state.by_node, state.names_by_ds, now,
        )
        if result is None:
            continue
        _values, writes = result
        await _write_computed_batch(conn, user_id, ds_id, key, writes)
        written[key] = writes[row_id]

    await _propagate(conn, user_id, data_source_id, row_id, state, now, visited, budget)
    return written


async def _propagate(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    row_id: str,
    state: _GraphState,
    now: datetime,
    visited: set[str],
    budget: list[int],
) -> None:
    """Spec §7.3: "propagate to rows that reference it through
    db_relation_links." For every ROLLUP property anywhere whose declared
    target is `(data_source_id, ...)` (i.e. it rolls up INTO the data
    source `row_id` just changed in), find the OWNER rows linked TO
    `row_id` -- by flipping the relation's own `side` (`RelationRef` with
    the opposite side reads the SAME `db_relation_links` rows from the
    other direction, M7's own two-way-sync-is-structural design) and
    calling `relations.list_links` on `row_id` -- and recompute each of
    them too, recursively (a rollup-of-a-rollup chain propagates through
    exactly this same call). `visited`/`budget` (shared across the whole
    cascade, see `_recompute_row_with_state`) make this BFS/DFS-shaped
    walk terminate even over a diamond or a long chain."""
    for rec in state.records:
        if rec["type"] != "rollup" or budget[0] <= 0:
            continue
        cfg = rec["config"] or {}
        if str(cfg.get("target_data_source_id") or "") != data_source_id:
            continue
        rel_rec = state.by_node.get((str(rec["data_source_id"]), cfg.get("relation_key")))
        if rel_rec is None:
            continue
        ref = relations.relation_ref_from_config(rel_rec["config"])
        if ref is None:
            continue
        reversed_ref = relations.RelationRef(
            relation_id=ref.relation_id, side="reverse" if ref.side == "forward" else "forward"
        )
        owner_ids = await relations.list_links(conn, user_id, reversed_ref, row_id)
        for oid in owner_ids:
            if budget[0] <= 0:
                return
            await _recompute_row_with_state(
                conn, user_id, str(rec["data_source_id"]), oid, state, now, visited, budget
            )


async def recompute_row(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    row_id: str,
    *,
    now: datetime | None = None,
) -> dict[str, dict[str, Any] | None]:
    """The row-write path (spec §7.3): recompute `row_id`'s own formula/
    rollup properties (in topological order, restricted to its own data
    source -- cross-data-source dependencies are read directly from
    `db_row_props`, assumed already fresh), then PROPAGATE to every row
    that references `row_id` through `db_relation_links` via a rollup.
    Returns `{property_key: wrapper_or_None}` for `row_id`'s OWN
    properties only (not the propagated rows' -- callers that need to know
    what else changed should treat this as best-effort; the propagation
    exists for correctness of stored data, not as an API surface for
    "everything that changed").

    Deliberately carries NO liveness assertion (`RecomputeLivenessError`)
    -- an incremental single-row recompute legitimately computes zero
    cells constantly and correctly: a row edit to a data source with no
    formula/rollup properties at all, or a change to a stored property no
    formula actually references, both produce zero materialised cells with
    nothing wrong. Asserting here would fire on completely ordinary
    writes, defeating the whole point of scoping the check to FULL passes
    (`recompute_full`)."""
    now = now or evaluator.make_now()
    state = await _load_graph_state(conn, user_id)
    visited: set[str] = set()
    budget = [ROLLUP_FANOUT_LIMIT]
    return await _recompute_row_with_state(conn, user_id, data_source_id, row_id, state, now, visited, budget)
