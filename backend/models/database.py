"""Pydantic models for Notion-style databases (Milestone 2).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §3, §6, §10.
Plan: docs/plans/2026-08-08-notion-databases.md, Milestone 2.

Follows this repo's `*Base`/`*Create`/`*Response` naming convention
(`models/note.py`). `*Response` field names are chosen to match their
`db_*` table's column names exactly, so `routers/databases.py` can build
one straight from an `asyncpg.Record` with `Model(**dict(row))` — no
per-field mapping.

The "All Notes" virtual source (spec §6) reuses these same response
models — it is never a real row in `db_databases`/`db_data_sources`/
`db_properties`/`db_views`, but its synthesized in-memory shape is built
from these classes too, so the frontend never needs to special-case its
response shape (only `DataSourceResponse.is_virtual`).
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, computed_field


class DatabaseCreate(BaseModel):
    title: str = "Untitled"
    icon: str | None = None
    # Set by the note editor's inline `/database` slash command (task-36) —
    # the note this database is embedded in. `None` (the default) is the
    # existing full-page-database path, unchanged: `is_inline`/`parent_note_id`
    # both stay at their column defaults (False/NULL).
    parent_note_id: str | None = None


class DatabaseResponse(BaseModel):
    id: str
    user_id: str
    title: str
    description: list[Any] = []
    icon: str | None = None
    cover_url: str | None = None
    is_inline: bool = False
    parent_note_id: str | None = None
    is_locked: bool = False
    position: int = 0
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None = None


class DataSourceResponse(BaseModel):
    id: str
    database_id: str
    user_id: str
    name: str
    system_kind: Literal["notes"] | None = None
    position: int = 0
    created_at: datetime
    # Not a `db_data_sources` column — True only for the synthesized "All
    # Notes" source (spec §6), so the frontend can special-case rendering
    # (e.g. hide "add property"/"rename"/"delete database") with one flag
    # instead of comparing ids against the well-known "all-notes" slug.
    is_virtual: bool = False


class PropertyCreate(BaseModel):
    name: str
    type: str
    config: dict[str, Any] = {}
    description: str | None = None


class PropertyUpdate(BaseModel):
    """`PATCH /db/properties/{property_id}` body. `name` alone is metadata-only
    (spec §4.2: "Rename is metadata-only") — unchanged from this endpoint's
    original `PropertyRename` shape (renamed here, task-28-brief.md §2, since
    it now does more than rename).

    `config` is new (Milestone 8, Task 28): the only way to edit an existing
    formula's expression or an existing rollup's relation/target/function
    after creation — `create_property` accepts `config` only at creation
    time, and until this task nothing let it be changed afterward. Router-side
    (`routers.databases.update_property`) applies the *same* save-time
    validation `create_property` does for a `formula`/`rollup` property
    (parse + typecheck the expression, or validate the rollup's relation/
    target/function; reject a dependency cycle with its path) and the same
    post-save full recompute — a formula's old materialised values are just
    as stale the instant its expression changes as they are on first save.
    `config` is a silent no-op for every other property type (this endpoint
    has never validated `config` shape for non-computed types, matching
    `ViewUpdate`'s identical "pass-through, unvalidated" stance for its own
    JSONB columns, and does not start now)."""

    name: str | None = None
    config: dict[str, Any] | None = None
    # Phase 0b (B3). The column has existed since 014_databases_core.sql and
    # `PropertyResponse` has always returned it, but nothing could ever write
    # it. Notion's UI reaches it through the `ⓘ` beside a property's name in
    # the column header menu, whose tooltip is literally "Add property
    # description" -- so the field is not decorative, it is a first-class
    # affordance on the surface M1 builds.
    #
    # Nullable on purpose: sending `null` CLEARS the description, which is how
    # a user removes one. That is why it is applied with an explicit
    # `exclude_unset` check below rather than `COALESCE`, unlike `name`.
    description: str | None = None
    # Phase 0b (B5). "Change type" is a row in Notion's column header menu,
    # which is milestone M1 — without this the row is dead from the first
    # milestone.
    #
    # NOT a plain column write. Values live as §3.3 discriminated wrappers and
    # `rows.py` rejects a wrapper whose tag does not match the property, so a
    # bare type flip would invalidate every stored value. The router converts
    # them through `services/db/properties/convert.py`, which also decides
    # which conversions are legal at all — illegal ones 400 rather than
    # destroying data. See that module's header for the reasoning.
    type: str | None = None


class PropertyResponse(BaseModel):
    id: str
    data_source_id: str
    user_id: str
    key: str
    name: str
    type: str
    config: dict[str, Any] = {}
    description: str | None = None
    storage: Literal["jsonb", "column"] = "jsonb"
    column_name: str | None = None
    result_type: str | None = None
    is_volatile: bool = False
    position: int = 0
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def convertible_to(self) -> list[str]:
        """Every type this property may be changed into (Phase 0b, B5).

        Served with the property rather than from a separate endpoint so the
        UI's "Change type" list greys the illegal rows using the SAME source
        of truth the PATCH enforces. A hardcoded client-side matrix would be a
        second copy, and it would drift the first time the rules change.

        Cheap: a dict lookup per property, no query."""
        from services.db.properties.convert import legal_targets

        return legal_targets(self.type)


class ViewResponse(BaseModel):
    id: str
    data_source_id: str
    user_id: str
    name: str
    icon: str | None = None
    type: str
    config: dict[str, Any] = {}
    filter: dict[str, Any] | None = None
    sorts: list[Any] = []
    is_locked: bool = False
    position: int = 0


class ViewUpdate(BaseModel):
    """Partial update for `PATCH /db/views/{view_id}`. Only fields present
    in the request body are touched (`model_dump(exclude_unset=True)` in
    the router). Migration 014's `db_views` has two nullable columns
    (`icon`, `filter`) and five `NOT NULL` ones (`name`, `config`, `sorts`,
    `is_locked`, `position`) — sending `null` explicitly for `icon` or
    `filter` clears them, but sending `null` for any of the five `NOT
    NULL` fields is a no-op for that field (the router drops it before it
    ever reaches the database) rather than a `NotNullViolationError` 500;
    the rest of the same request's fields still apply. No validation of
    `config`/`filter`/`sorts` shape here: Milestone 2 has no filter/sort
    UI or compiler yet (Milestone 3), so this is deliberately a JSONB
    pass-through — shape enforcement is future work, not a regression from
    not having it now.
    """

    name: str | None = None
    icon: str | None = None
    config: dict[str, Any] | None = None
    filter: dict[str, Any] | None = None
    sorts: list[Any] | None = None
    is_locked: bool | None = None
    position: int | None = None


class DatabaseUpdate(BaseModel):
    """Partial update for `PATCH /db/databases/{database_id}` (Phase 0b, B2).

    Until this existed a database could never be renamed and could never be
    given an icon or a description -- `create_database` set a title once and
    nothing could change it. Notion edits all three in place in the page
    header, with no rename affordance at all: the title is a textbox, and
    "Add icon"/"Add description" are hover-revealed buttons above it.

    Same partial-update contract as `ViewUpdate`: only fields present in the
    request body are touched. `icon` and `cover_url` are nullable columns, so
    an explicit `null` clears them; `title` and `description` are `NOT NULL`,
    so a `null` for either is dropped rather than raising a
    NotNullViolationError -- the rest of the request still applies.

    `description` is JSONB rich text (a list of blocks), matching the column
    and `DatabaseResponse`, not a plain string.
    """

    title: str | None = None
    description: list[Any] | None = None
    icon: str | None = None
    cover_url: str | None = None
    is_locked: bool | None = None


class DatabaseSummary(BaseModel):
    """One entry in `GET /db/databases` — a database plus the single data
    source Milestone 2 always creates for it (spec §3.1).

    Deliberately NOT `DatabaseDetailResponse`: a picker listing every
    database does not need each one's full property and view lists, and
    fetching them would be N+1 queries for data nothing renders. Callers
    that need the detail already have `GET /db/databases/{id}`.
    """

    database: DatabaseResponse
    data_source: DataSourceResponse


class DatabaseListResponse(BaseModel):
    databases: list[DatabaseSummary]


class DatabaseDetailResponse(BaseModel):
    """The shape returned by `POST /db/databases` and `GET
    /db/databases/{database_id}` for both real and virtual databases."""

    database: DatabaseResponse
    data_source: DataSourceResponse
    properties: list[PropertyResponse]
    views: list[ViewResponse]


class RowsResponse(BaseModel):
    """`GET /db/data-sources/{data_source_id}/rows`.

    `rows[i]["properties"]` is keyed by each property's identifier —
    `db_properties.key` (8-char base62) for an ordinary data source,
    `COLUMN_BACKED[name].column` (a `notes` column name) for the virtual
    "All Notes" source — so a generic renderer can always do
    `row["properties"][property.key]` regardless of which kind of
    database it's looking at. Every value, for both kinds of source, is
    spec §3.3's discriminated wrapper (`{"type": "status", "status":
    "learning"}`), not a bare scalar — so a cell renderer never needs a
    virtual-source branch for the *value* shape either, only for whether
    writes are possible at all (`DataSourceResponse.is_virtual`).
    """

    rows: list[dict[str, Any]]


class ShiftedRow(BaseModel):
    """One row moved by a Milestone 7 dependency date-shift cascade
    (`services.db.relations.cascade_dependency_shift`) — `properties` carries
    only the one date property that moved, wrapped the same §3.3 way as any
    other property value, so the frontend can merge it into its cache with
    the same code path it already uses for an ordinary property write."""

    id: str
    properties: dict[str, Any]


class RowResponse(BaseModel):
    """A single row, same `properties` shape as one entry of
    `RowsResponse.rows` — returned by `PATCH .../rows/{note_id}`.

    `shifted_rows` (Milestone 7, task-21-brief.md §4): non-`None` only when
    this write was to a `date` property whose data source has dependencies
    enabled and configured to watch that exact property — the rows a
    dependency cascade moved as a *side effect* of this write, so the
    client can apply them without a refetch. `None` (not `[]`) for every
    ordinary write, including a date write that triggered a cascade which
    moved zero rows — `[]` there would claim "a cascade ran and touched
    nothing," which is a different, false statement from "no cascade was
    even eligible.\""""

    id: str
    properties: dict[str, Any]
    shifted_rows: list[ShiftedRow] | None = None


class NoteRowInfo(BaseModel):
    """`GET /db/notes/{note_id}/row` (RowPeek follow-up: making `/brain/{noteId}`,
    the plain note page, database-row-aware). Lets a standalone page that only has a
    bare note id discover "is this note a database row, and if so, what's its
    property schema + values" — nothing before this endpoint could answer that
    outside a data source's own bulk `list_rows`/`query_rows`, which TableView/RowPeek
    already have loaded but a directly-navigated-to note page does not.

    `properties`/`values` split mirrors `DatabaseDetailResponse` (schema) vs
    `RowResponse` (data) rather than merging them — the frontend needs both
    independently (iterate `properties` for column order/type, look up `values[key]`
    for each one's current wrapper), same shape contract as every other row-rendering
    call site in this app.
    """

    data_source_id: str
    database_id: str
    database_title: str
    properties: list[PropertyResponse]
    values: dict[str, Any]


class AggregationSpec(BaseModel):
    """One y-axis (or Chart Number-mode) calculation request inside `QueryRequest.
    aggregations` (Milestone 10, task-32): a thin JSON wrapper around Milestone 4's
    `services.db.query.aggregations.aggregate(rows, lookup, aggregator)` -- the 20-function
    calculation engine that until this task had zero HTTP callers. `key` is caller-chosen
    (e.g. "y" for a Chart's single y-axis series) and purely a label: the router never
    inspects it, just echoes it back verbatim as the matching key in `GroupResult.
    aggregates`/`QueryResponse.aggregates`. `aggregator` is deliberately an open `str`, not
    a closed enum -- same reasoning as `ViewCreate.type` elsewhere in this file: the router
    (not Pydantic) rejects a name outside `aggregations._VALID_AGGREGATORS` with a 400, so a
    future 21st aggregator never needs a model change here. `property_key` is `None` only
    when `aggregator == "count"` -- the one property-independent aggregator (`aggregate()`'s
    own contract, research §I.5.1); every other aggregator requires it, and the router
    converts `aggregate()`'s own `ValueError` for a missing/mismatched one into a 400."""

    key: str
    property_key: str | None = None
    aggregator: str


class QueryRequest(BaseModel):
    """`POST /db/data-sources/{data_source_id}/query` body (task-15, wiring up Milestone
    3's filter/sort compiler and Milestone 4's grouping to an HTTP endpoint for the first
    time). `filter`/`sorts`/`group_by`/`sub_group_by` are deliberately permissive
    dict/list-of-dict shapes here, not the `services.db.query.ast`/`grouping` types
    themselves — the router parses them (`ast.parse_filter`, `SortSpec(**s)`,
    `GroupBySpec(**group_by)`) so a malformed filter/group surfaces as the compiler's own
    `FilterValidationError` -> HTTP 400 (spec §8.2's "unknown key -> 400, never dropped"),
    not as a generic 422 from Pydantic validating a nested discriminated union at this
    layer instead.

    `group_by`/`sub_group_by` are raw `grouping.GroupBySpec`-shaped dicts (`property_key`
    required, `mode`/`start_day_of_week`/`range_start`/`range_end`/`range_size`/
    `hide_empty_groups` all optional — see `services/db/query/grouping.py`)."""

    filter: dict[str, Any] | None = None
    sorts: list[dict[str, Any]] = []
    page_size: int = 50
    offset: int = 0
    group_by: dict[str, Any] | None = None
    sub_group_by: dict[str, Any] | None = None
    # Milestone 10 (task-32): zero or more y-axis/Number-mode calculations for a Chart
    # view -- see `AggregationSpec` above and `GroupResult.aggregates`/`QueryResponse.
    # aggregates` below. `[]` (not `None`) matches `sorts`' own "absent means empty list,
    # not a tri-state" convention immediately above.
    aggregations: list[AggregationSpec] = []


class GroupResult(BaseModel):
    """One entry of `QueryResponse.groups` — the JSON-serializable mirror of
    `services.db.query.grouping.Group`, with `row_count` precomputed (`len(rows)`) so the
    frontend never needs to count client-side. `label` is *not* always `Group.label`
    verbatim: for a `select`/`status` group, the router resolves it against the property's
    `db_properties.config.options` list (task-15-brief.md's "group labels are opaque ids"
    fix — see `routers/databases.py`'s `_resolve_group_label`), falling back to
    `Group.label` (itself the raw stored option id) when no configured option matches.

    `subgroups` is `None` whenever no `sub_group_by` was requested, and — same as
    `grouping.Group` — always `None` on a subgroup itself (sub-grouping is exactly two
    levels, never three).

    `aggregates` (Milestone 10, task-32) is `None` — not `{}` — whenever the request's
    `QueryRequest.aggregations` was empty, the load-bearing case for backward
    compatibility: `response_model_exclude_none=True` on the route then drops the key
    entirely (verified empirically, not assumed, to recurse into every nested `GroupResult`
    too — see the task's own test asserting this), so every pre-existing caller that never
    sends `aggregations` gets byte-identical JSON to before this field existed. When
    non-empty, it's one `{spec.key: value}` entry per `QueryRequest.aggregations` entry,
    computed from *this* group's own `rows` (and, for a subgroup entry, that subgroup's own
    `rows` — never the parent group's)."""

    key: str
    label: str
    row_count: int
    rows: list[dict[str, Any]]
    subgroups: list["GroupResult"] | None = None
    aggregates: dict[str, Any] | None = None


GroupResult.model_rebuild()


class QueryResponse(BaseModel):
    """`POST .../query`'s response. Exactly one of `rows`/`groups` is ever populated —
    mirroring the request's own `group_by`/no-`group_by` branch — and the route serializes
    with `response_model_exclude_none=True` so the *other* field is omitted from the JSON
    entirely rather than sent as an explicit `null`: `body.group_by is None` ->
    `{"rows": [...]}` (byte-identical shape to `RowsResponse`, spec's own "this endpoint is
    a superset of list_rows, not a replacement"); `body.group_by` set -> `{"groups":
    [...]}`.

    `aggregates` (Milestone 10, task-32) is the ungrouped-case counterpart of `GroupResult.
    aggregates`: `None` (dropped from the JSON by exclude_none, same as today) whenever
    `QueryRequest.aggregations` was empty or `body.group_by` was set (aggregates then live
    per-group instead, never duplicated up here); otherwise one `{spec.key: value}` dict
    computed over the *entire filtered/sorted row set* the query matched -- Chart's
    Number-type mode (a single scalar, no x-axis) -- not just the one page `rows` returns."""

    rows: list[dict[str, Any]] | None = None
    groups: list[GroupResult] | None = None
    aggregates: dict[str, Any] | None = None


class ViewCreate(BaseModel):
    """`POST /db/data-sources/{data_source_id}/views` body — the first way to create a
    non-default view (`create_database` mints exactly one table view; every other view
    type M6's frontend needs, Board/Gallery/List/Feed, has had nowhere to come from until
    now). `type` is deliberately unvalidated beyond "non-empty string" (Pydantic's own
    `str` requirement) — no closed enum here, same reasoning as `PropertyCreate.type`
    accepting an unknown-but-syntactically-valid type elsewhere in this file: the frontend
    is what actually renders a type-specific component, and a future milestone (Timeline,
    Chart, ...) shouldn't have to come back and extend a closed set."""

    name: str = "New view"
    type: str
    icon: str | None = None


class RowPropertyUpdate(BaseModel):
    """`PATCH /db/data-sources/{data_source_id}/rows/{note_id}` body: write
    one property's value. `value` is the full spec §3.3 wrapper (e.g.
    `{"type": "status", "status": "done"}`), matching what's stored and
    what `RowsResponse`/`RowResponse` return — not a bare scalar.

    `value` is required (no default): a request that omits it is a 422 at
    this layer, not a `NotNullViolationError` 500 once it reaches
    `jsonb_set` (review finding 1, fix round 2 — `db_row_props.properties`
    is `NOT NULL`, and `jsonb_set(properties, path, NULL, true)` sets the
    *entire column* to SQL NULL, not just the targeted key). An explicit
    top-level `null` (`{"property_key": "...", "value": null}`) is still
    legal and is handled by the router as "clear/unset this property"
    (`properties - key`), which is a different operation from a wrapper
    whose *inner* value is null (e.g. `{"type": "number", "number":
    null}`, a normal dict — routed through `jsonb_set` unchanged)."""

    property_key: str
    value: Any


# ---------------------------------------------------------------------------
# Milestone 7 (task-21): relation, sub-item and dependency endpoints.
# ---------------------------------------------------------------------------


class RelationCreate(BaseModel):
    """`POST /db/data-sources/{data_source_id}/relations` body — an
    ordinary (non-system) relation pair. `two_way=True` (the default)
    requires `reverse_name`; `services.db.relations.create_relation_pair`
    itself enforces that (raises `RelationError`, mapped to a 400 at the
    router seam) rather than this model duplicating the check."""

    name: str
    target_data_source_id: str
    two_way: bool = True
    reverse_name: str | None = None


class RelationPairResponse(BaseModel):
    """Both properties of a freshly created relation pair (an ordinary
    relation, or the sub-items/dependencies system pairs) — `reverse` is
    `None` only for a one-way ordinary relation (`two_way=False`); the two
    system pairs are always two-way."""

    forward: PropertyResponse
    reverse: PropertyResponse | None = None


class RelatedRow(BaseModel):
    """One linked row, as returned by every relation-links endpoint.
    `services/db/relations.py` stores only ids (`db_relation_links`); the
    router joins against `notes` for a human-readable `title` — a bare list
    of UUIDs is useless to a UI (task-21-brief.md §1)."""

    id: str
    title: str


class RelationLinksResponse(BaseModel):
    """GET/PUT/POST/DELETE on `.../relations/{property_key}[/links[...]]`
    all return this same shape: the row's *current* full link list after
    the operation, in link order, with trashed (`deleted_at IS NOT NULL`)
    rows excluded (migration 015's header note 5: links to a trashed row
    are kept, but a trashed row must not appear as a live link)."""

    rows: list[RelatedRow]


class RelationLinksSet(BaseModel):
    """`PUT .../relations/{property_key}` body: the whole desired link
    list, in order. Duplicate ids are de-duplicated, first occurrence wins
    — the same convention `services.db.relations.set_links` itself uses."""

    row_ids: list[str]


class RelationLinkAdd(BaseModel):
    """`POST .../relations/{property_key}/links` body: add one link."""

    row_id: str


class RelationLinksBulkRequest(BaseModel):
    """`POST .../relations/{property_key}/links/bulk` body: the row ids to
    fetch links for in one round trip. M7 combined-review Important
    finding 3: `services.db.relations.list_links_bulk` was built by task 20
    explicitly to be the N+1 killer for exactly this ("one query, grouped
    in Python" — its own docstring), but task 21 never exposed it through
    a router, so `TableView.tsx`'s sub-item tree ended up issuing one
    `GET .../relations/{property_key}` per visible row instead. Capped at
    `routers.databases._BULK_RELATION_ROW_IDS_LIMIT` per request."""

    row_ids: list[str]


class RelationLinksBulkResponse(BaseModel):
    """One entry per requested row id, even `[]` for a row with no links
    (mirrors `list_links_bulk`'s own "every requested id is a key" contract
    — an absent key would mean "not asked about", a different thing from
    "asked about, has none"), each hydrated with titles the same way
    `RelationLinksResponse.rows` is."""

    links: dict[str, list[RelatedRow]]


class DependencySettingsUpdate(BaseModel):
    """`PATCH /db/relations/{relation_id}/dependency-settings` body —
    partial update of the forward dependency property's `config`
    (`date_shift_mode` must be one of `services.db.relations.
    DATE_SHIFT_MODES`; `avoid_weekends`; `date_property_key`). Only fields
    present in the request are touched (`model_dump(exclude_unset=True)`
    in the router, matching `ViewUpdate`'s own convention above). Unlike
    `ViewUpdate`'s NOT NULL columns, every one of these three config keys
    is optional, so an explicit `null` for a present field clears that
    setting (removes the key from `config`) rather than being a no-op."""

    date_shift_mode: str | None = None
    avoid_weekends: bool | None = None
    date_property_key: str | None = None


# ---------------------------------------------------------------------------
# Milestone 8 (task-28): formula validate endpoint.
# ---------------------------------------------------------------------------


class FormulaValidateRequest(BaseModel):
    """`POST /db/data-sources/{data_source_id}/formulas/validate` body
    (spec §7.1 — the frontend's *only* formula surface; there is no
    evaluate-this-for-me endpoint, so a formula editor calls this on every
    keystroke). `expression` is capped server-side
    (`routers.databases._MAX_FORMULA_EXPRESSION_LENGTH`) before it ever
    reaches the parser — a malformed OR pathologically long expression is
    the *normal* case here, not an error, so this endpoint always answers
    200; see `FormulaValidateResponse`."""

    expression: str


class FormulaValidationIssue(BaseModel):
    """One parse or type error, positioned the same way `services.db.
    formula.lexer.FormulaSyntaxError`/`typecheck.FormulaTypeError` already
    are — 0-based `pos` plus 1-based `line`/`col` so a `FormulaEditor` can
    underline the exact offending character, matching research §1.9's "a
    formula editor showing one error at a time is miserable" (this is why
    `FormulaValidateResponse.errors` is always the *full* list, not just
    the first)."""

    message: str
    pos: int
    line: int
    col: int


class FormulaValidateResponse(BaseModel):
    """Spec §7.1's exact contract: parse errors, the inferred result type,
    and the referenced properties — nothing else. `valid` is `False` for
    both a syntax error (the parser never produced a tree) and a type
    error (the tree parsed, but `services.db.formula.typecheck.check`
    reported at least one `FormulaTypeError`) — this endpoint's `valid`
    does NOT predict whether a save will succeed: research §1.9 / this
    task's brief §2 draw a hard line between the two, and only a
    dependency CYCLE (which this endpoint cannot detect — cycle detection
    needs the full cross-property graph `create_property`/`update_property`
    build at save time, not one expression in isolation) is a genuine
    save-time rejection. `result_type`/`referenced_properties`/
    `is_volatile` are still populated even when `valid` is `False` (the
    checker keeps going after an error, `deps.referenced_properties()` and
    the volatility walk don't depend on the checker succeeding at all) —
    a formula editor can show "this looks like it'll be a Number" right
    next to the error list.

    `referenced_properties` is **keys**, not names, even though a formula
    itself references properties by name (Task 24's `check()`/`deps.
    referenced_properties()` both work in names) — the frontend deals in
    keys everywhere else (`PropertyResponse.key`, `RowsResponse.rows[i].
    properties`), so this endpoint resolves name -> key before answering,
    the one place that translation happens for this whole feature."""

    valid: bool
    errors: list[FormulaValidationIssue] = []
    result_type: str | None = None
    referenced_properties: list[str] = []
    is_volatile: bool = False


# ---------------------------------------------------------------------------
# Milestone 12 (task-37): row templates. Spec §3.2's `db_row_templates`
# (migration 017) — `properties` captures pre-filled property VALUES (same
# JSONB wrapper shape as `db_row_props.properties`), `content` captures the
# page BODY (same shape as `notes.content`, BlockNote's own block array).
# `repeat_config` is the shape task-37-brief.md decision 5 fixes exactly
# (frequency/interval/weekdays/start_date/time_of_day/timezone) — not its
# own nested Pydantic model, deliberately: same "polymorphic JSONB validated
# by application code, not shape-checked by Pydantic" convention as
# `ViewUpdate.config`/`filter`/`sorts` elsewhere in this file.
# ---------------------------------------------------------------------------


class RowTemplateCreate(BaseModel):
    """`POST /db/data-sources/{data_source_id}/templates` body. `is_default`
    lets a client mint a template as the data source's default in the same
    call as creating it — `services/db/templates.py`'s `create_template`
    turns a second `is_default=True` for the same data source into a clean
    400 (migration 017's partial unique index), not a raw asyncpg 500."""

    name: str = "Untitled template"
    icon: str | None = None
    properties: dict[str, Any] = {}
    content: list[Any] = []
    is_default: bool = False
    repeat_config: dict[str, Any] | None = None


class RowTemplateUpdate(BaseModel):
    """`PATCH /db/templates/{template_id}` body. Only fields actually
    present in the request get patched (`model_dump(exclude_unset=True)` in
    the router) — same convention as `ViewUpdate`. `icon` and
    `repeat_config` are migration 017's only nullable columns among these
    fields, so an explicit `null` for either clears it (a cleared
    `repeat_config` also clears `next_run_at` — no longer repeating); every
    other field here (`name`/`properties`/`content`/`is_default`, all `NOT
    NULL`) drops an explicit `null` as a no-op for that field rather than
    reaching the database, matching `ViewUpdate`'s own
    `_VIEW_NULLABLE_FIELDS` handling of the identical situation."""

    name: str | None = None
    icon: str | None = None
    properties: dict[str, Any] | None = None
    content: list[Any] | None = None
    is_default: bool | None = None
    repeat_config: dict[str, Any] | None = None


class RowTemplateResponse(BaseModel):
    """Mirrors `db_row_templates`'s columns 1:1 (this file's own
    `Model(**_row(record))` convention)."""

    id: str
    data_source_id: str
    user_id: str
    name: str
    icon: str | None = None
    properties: dict[str, Any] = {}
    content: list[Any] = []
    is_default: bool = False
    repeat_config: dict[str, Any] | None = None
    next_run_at: datetime | None = None
    position: int = 0
    created_at: datetime
    updated_at: datetime


class AutomationCreate(BaseModel):
    """`POST /db/data-sources/{data_source_id}/automations` body. `triggers`/`actions`
    stay untyped `list[Any]` JSONB pass-through (task-37's `repeat_config` convention,
    reused here per task-38-brief.md's "What to build" section) — `services/db/
    automations.py` validates the one save-time shape rule that matters (an
    `every_frequency` trigger must be the trigger array's only entry, decision 3), not a
    closed Pydantic model for every trigger/action variant. `next_run_at` is NOT settable
    here — like `RowTemplateResponse.next_run_at`, it's derived from `triggers` by the
    service layer, never accepted from the client."""

    name: str = "Untitled automation"
    is_active: bool = True
    trigger_combinator: str = "any"
    triggers: list[Any] = []
    view_id: str | None = None
    actions: list[Any] = []


class AutomationUpdate(BaseModel):
    """`PATCH /db/automations/{automation_id}` body. Only fields actually present in the
    request get patched (`model_dump(exclude_unset=True)`, same convention as
    `RowTemplateUpdate`). `view_id` is migration 017's only nullable column among these
    fields, so an explicit `null` clears it (widens the automation back to "the whole data
    source" — migration 017's own header comment); every other field here drops an
    explicit `null` as a no-op. `last_error` is deliberately absent — task-38-brief.md
    decision 10: it's system-written only (via a failing action chain), never a field a
    client PATCHes directly."""

    name: str | None = None
    is_active: bool | None = None
    trigger_combinator: str | None = None
    triggers: list[Any] | None = None
    view_id: str | None = None
    actions: list[Any] | None = None


class AutomationResponse(BaseModel):
    """Mirrors `db_automations`'s columns 1:1 (this file's own `Model(**_row(record))`
    convention)."""

    id: str
    data_source_id: str
    user_id: str
    name: str
    is_active: bool = True
    last_error: str | None = None
    trigger_combinator: str = "any"
    triggers: list[Any] = []
    view_id: str | None = None
    actions: list[Any] = []
    next_run_at: datetime | None = None
    position: int = 0
    created_at: datetime
    updated_at: datetime


class NotificationResponse(BaseModel):
    """Mirrors `db_notifications`'s columns 1:1 — the `send_notification` action's
    target (task-38-brief.md decision 9). `source` is free text (e.g.
    `"automation:<id>"`), not an FK (migration 017's header: survives the automation
    being edited/deleted)."""

    id: str
    user_id: str
    message: str
    link: str | None = None
    source: str | None = None
    read_at: datetime | None = None
    created_at: datetime


class ButtonClickRequest(BaseModel):
    """`POST /db/data-sources/{data_source_id}/rows/{note_id}/buttons/{property_key}/
    click` body (task-39-brief.md decision 5). `confirmed` is decision 6's two-phase
    flow: the first click omits it (defaults False); if the response comes back with
    `requires_confirmation=True`, the caller re-POSTs the SAME request with
    `confirmed: true` to actually run the chain past its `show_confirmation` action."""

    confirmed: bool = False


class ButtonBlockClickRequest(BaseModel):
    """`POST /db/buttons/block-click` body (decision 5). A button BLOCK's action chain
    lives entirely in the block's own BlockNote props (decision 3) — there is no
    server-side storage for it to look up by id, so the actions array travels in the
    request body directly. `actions` stays untyped `list[Any]` JSONB pass-through,
    the same convention `AutomationCreate.actions` already uses."""

    note_id: str
    actions: list[Any] = []
    confirmed: bool = False


class ButtonClickResponse(BaseModel):
    """Shared response shape for both click endpoints (decision 7). `client_actions`
    entries (`open_page_or_url`'s `{"type": "open", ...}` / `insert_blocks`'s
    `{"type": "insert_blocks", ...}`) are resolve-only instructions for a future
    frontend (Task 42) to actually enact — this backend only produces them correctly,
    never acts on them itself."""

    actions_run: int
    requires_confirmation: bool = False
    confirmation_message: str | None = None
    client_actions: list[dict[str, Any]] = []
