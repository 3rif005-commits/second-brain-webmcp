"""Router for Notion-style databases: database/data-source/property/view
CRUD, plus the built-in "All Notes" virtual source (spec §6).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §3, §6, §10.
Plan: docs/plans/2026-08-08-notion-databases.md, Milestone 2.

Tenancy: asyncpg connects with the service role (RLS does not apply on this
path — spec §8.3), so every query below carries an explicit `user_id = $N`
predicate as the enforcement boundary. `tests/test_databases_router.py`'s
guard test scans this file's source for exactly that.

"All Notes" (spec §6): addressed by the fixed slug `"all-notes"` rather
than a UUID. It is virtual — no `db_databases`/`db_data_sources`/
`db_properties`/`db_views` row exists for it — so every endpoint here
special-cases that slug *before* touching the database, and synthesizes
the response in memory from `COLUMN_BACKED` (services/db/properties/
columns.py) instead.
"""
from __future__ import annotations

import csv
import uuid as uuid_lib
from datetime import datetime, timedelta, timezone
from io import StringIO
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import ValidationError

from models.database import (
    AggregationSpec,
    AutomationCreate,
    AutomationResponse,
    AutomationUpdate,
    ButtonBlockClickRequest,
    ButtonClickRequest,
    ButtonClickResponse,
    DatabaseCreate,
    DatabaseDetailResponse,
    DatabaseResponse,
    DatabaseUpdate,
    DataSourceResponse,
    DependencySettingsUpdate,
    FormulaValidateRequest,
    FormulaValidateResponse,
    FormulaValidationIssue,
    GroupResult,
    NoteRowInfo,
    NotificationResponse,
    PropertyCreate,
    PropertyUpdate,
    PropertyResponse,
    QueryRequest,
    QueryResponse,
    RelatedRow,
    RelationCreate,
    RelationLinkAdd,
    RelationLinksBulkRequest,
    RelationLinksBulkResponse,
    RelationLinksResponse,
    RelationLinksSet,
    RelationPairResponse,
    RowPropertyUpdate,
    RowResponse,
    RowTemplateCreate,
    RowTemplateResponse,
    RowTemplateUpdate,
    RowsResponse,
    ViewCreate,
    ViewResponse,
    ViewUpdate,
    DatabaseListResponse,
    DatabaseSummary,
)
from routers.notes import get_user_id
from services.db import automations as automations_service
from services.db import buttons as buttons_service
from services.db import notifications as notifications_service
from services.db import recompute
from services.db import rollup as rollup_service
from services.db.automations import (
    ActionConfigError,
    ActionContext,
    AutomationConfigError,
)
from services.db.connection import get_conn
from services.db.formula import FormulaCycleError, FormulaSyntaxError
from services.db.formula import check as check_formula
from services.db.formula import parse as parse_formula
from services.db.keys import mint_key
from services.db.properties.base import REGISTRY
from services.db.properties.columns import COLUMN_BACKED
from services.db.properties.computed import ComputedConfig
from services.db.properties.format import format_property_value
from services.db.query import aggregations
from services.db.query import ast
from services.db.query import grouping
from services.db.query.builder import QueryBuilder
from services.db.query.compiler import PropertyLookup
from services.db.relations import (
    DATE_SHIFT_MODES,
    RelationError,
    SYSTEM_DEPENDENCY,
    SYSTEM_SUB_ITEM,
    create_relation_pair,
    delete_relation_pair,
    link_checked,
    list_links,
    list_links_bulk,
    relation_ref_from_config,
    unlink,
)
from services.db.rows import (
    PropertyNotFoundError,
    RowNotFoundError,
    RowPropertyValueError,
    create_row_core,
    update_row_property_core,
)
from services.db import templates as templates_service
from services.db.templates import DuplicateDefaultTemplateError, TemplateConfigError
from services.db.properties.convert import ConversionError, convert_value, is_legal
from services.db.views import sweep_property_from_views
from services.indexer import try_index_note

router = APIRouter(prefix="/db", tags=["databases"])

# The well-known slug for the virtual "All Notes" data source (spec §6).
# Never a real UUID, so every path below checks for it first.
ALL_NOTES_ID = "all-notes"

# db_properties.key collisions are astronomically unlikely (8-char base62,
# ~2.2e14 keyspace — spec §4.2) but not impossible; retry a few times with a
# freshly minted key rather than ever surfacing a collision as a user-facing
# 500.
_KEY_MINT_ATTEMPTS = 5

# task-10 review finding 1: list_rows had no LIMIT anywhere in the pipeline,
# so a user with hundreds/thousands of notes fetched every matching row
# unconditionally on the one page Milestone 2 ships (/brain/db/all-notes).
# 500 is generous for a personal single-user knowledge base and keeps the
# query and the JSON payload bounded. Real pagination (cursor/offset, query
# params, "load more" UI) is explicitly Milestone 3+ scope — this is just a
# hard cap, not a feature.
_ROWS_LIMIT = 500

# Milestone 8 (task-28-brief.md §1): "a malformed expression is the NORMAL
# case for the validate endpoint (a formula editor calls it per keystroke)...
# protect the server anyway: cap expression length." Task 23's own
# `MAX_PARSE_DEPTH` already bounds *nesting*, but a hostile/pathological flat
# expression (e.g. a single 10MB string literal, or a wide `sum(1,1,1,...)`
# call) costs lexer/parser/checker time proportional to length regardless of
# nesting depth — this is the second, independent guard the brief asks for.
# 5,000 characters is generous for anything a formula EDITOR would produce
# (Notion's own formula UI has no documented length cap, but no real formula
# in research's own worked examples approaches even 500 chars) while keeping
# a single validate call's cost bounded and constant-ish.
_MAX_FORMULA_EXPRESSION_LENGTH = 5_000

# M7 combined-review Important finding 3: caps `POST .../relations/
# {property_key}/links/bulk`'s `row_ids` body -- a distinct limit from
# `_ROWS_LIMIT` above (that one bounds rows *returned from a data source
# query*; this one bounds row ids a single client request may ask about in
# one go) even though both currently land on 500, the same generous-for-a-
# personal-knowledge-base reasoning `_ROWS_LIMIT`'s own comment gives.
_BULK_RELATION_ROW_IDS_LIMIT = 500


def _jsonify(value: Any) -> Any:
    """Coerce a raw `notes`-column value to a JSON-safe primitive for the
    All Notes rows endpoint (`asyncpg` returns `datetime`/`uuid.UUID` for
    those column types, neither of which is a plain JSON scalar)."""
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, uuid_lib.UUID):
        return str(value)
    return value




def _wrap_column_value(prop_type: str, raw: Any) -> dict[str, Any]:
    """Apply spec §3.3's discriminated-value wrapper
    (`{"type": <type>, <type>: <value>}`) to a raw `notes` column value, so
    an All Notes row has the same per-property value *shape* as an
    ordinary data source's `db_row_props.properties` entry — task-5 review
    finding 2: the frontend must not need a virtual-source branch for cell
    value shape, only for whether writes are possible at all."""
    return {"type": prop_type, prop_type: raw}


def _decode_all_notes_row(record: asyncpg.Record) -> dict[str, Any]:
    """Shapes one `notes` row -- a bare `SELECT id, <COLUMN_BACKED cols> ...` record
    (`list_rows`) or a `QueryBuilder`-produced `n.id, <cols>` record (`query_rows` below,
    task-15) -- into the wire shape both endpoints promise: spec §3.3's discriminated
    wrapper per property, keyed by each COLUMN_BACKED property's `notes` column name.
    Extracted here (task-15-brief.md §1.4) so the two callers stay byte-identical rather
    than duplicating and silently drifting.

    `cover_image_url` (task-17) rides alongside `properties` as its own field, read with
    `record.get(...)` rather than `record[...]` on purpose: `query_rows`'s QueryBuilder-
    produced SQL always selects `n.cover_image_url` now, but `list_rows`'s own hand-rolled
    SQL below does not -- `.get()` returns `None` for that caller instead of a KeyError,
    which is the deliberate, documented asymmetry (see the `# ---` block above
    `test_query_returns_real_cover_image_url_ordinary_mode` in
    tests/test_databases_query_endpoint.py): `list_rows` has no live frontend caller left
    (task-16 moved everything to `POST .../query`), so it doesn't need the real value."""
    return {
        "id": str(record["id"]),
        "properties": {
            prop.column: _wrap_column_value(prop.type, _jsonify(record[prop.column]))
            for prop in COLUMN_BACKED.values()
        },
        "cover_image_url": record.get("cover_image_url"),
    }


def _decode_ordinary_row(record: asyncpg.Record) -> dict[str, Any]:
    """Same purpose as `_decode_all_notes_row`, for an ordinary data source's
    `db_row_props` record (`note_id`, `properties`). The JSONB is already spec
    §3.3-shaped by construction (every write path enforces the wrapper -- see
    `update_row_property`), so this is a straight field rename, not a re-shaping.

    `cover_image_url`: same `.get()`-not-`[]` reasoning as `_decode_all_notes_row` above --
    `list_rows`'s ordinary-mode SQL doesn't join `notes` at all, let alone select the
    column, so this is `None` for that caller and the real value for `query_rows`."""
    return {
        "id": str(record["note_id"]),
        "properties": record["properties"],
        "cover_image_url": record.get("cover_image_url"),
    }


async def _fetch_computed_by_row(
    conn: asyncpg.Connection, user_id: str, data_source_id: str, note_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Bulk-fetches `db_row_props.computed` for exactly the rows a listing/
    query endpoint is about to return (task-28-brief.md §4). Neither
    `list_rows`'s own hand-rolled SQL nor `services/db/query/builder.py`'s
    `QueryBuilder._columns()` (Task 27, outside this task's file scope --
    `services.db.query.builder`/`compiler` are listed among the "committed
    code you build on," not code to modify) ever selects `computed` -- so
    without this, a materialised formula/rollup value would filter and sort
    correctly (Task 27's own end-to-end tests prove that) but never actually
    reach a client to render at all, which would make `FormulaCell` a
    component with nothing real to ever display in a live pass. A second
    bulk query -- not a join spliced into `QueryBuilder`'s fragment -- keeps
    this entirely inside this router's own file, and mirrors the same
    "N+1 killer, one extra round trip" shape `get_relation_links_bulk`
    already established here.

    Returns `{}` for `note_ids == []` without a round trip. A row absent
    from the result, or present with an empty dict, both mean "no
    materialised formula/rollup values for this row" -- `_merge_computed_
    into_rows` treats them identically."""
    if not note_ids:
        return {}
    rows = await conn.fetch(
        """
        SELECT note_id, computed FROM db_row_props
        WHERE user_id = $1 AND data_source_id = $2 AND note_id = ANY($3::uuid[])
        """,
        user_id, data_source_id, note_ids,
    )
    return {str(r["note_id"]): (r["computed"] or {}) for r in rows}


def _merge_computed_into_rows(
    rows: list[dict[str, Any]], computed_by_id: dict[str, dict[str, Any]]
) -> None:
    """Merges each row's materialised formula/rollup values (already §3.3-
    wrapper-shaped, `rollup.computed_wrapper`'s own output) into its
    `properties` dict, keyed by property key exactly like every stored
    property -- `RowsResponse`'s own docstring promises a generic renderer
    can always do `row["properties"][property.key]`, and this is what makes
    that promise true for formula/rollup keys too, not just stored ones. A
    key collision with a stored property is structurally impossible (`db_
    properties.key` is unique per data source -- migration 014's `UNIQUE
    (data_source_id, key)` -- and a computed value is only ever written
    under a formula/rollup property's OWN key), so this is a plain dict
    merge, never a conflict to resolve. A volatile formula's key is simply
    never a key of `computed_by_id[row_id]` at all (`recompute.py` never
    writes one) -- there is nothing to merge for it, which is exactly "what
    Task 27's query path actually returns" for one (task-28-brief.md §4):
    nothing. `FormulaCell` renders a distinct muted state for that case
    client-side rather than this endpoint inventing a live value spec
    §7.4's per-request evaluation path (still unbuilt -- inherited flagged
    gap from Task 27's own report) would be needed to compute correctly."""
    for row in rows:
        extra = computed_by_id.get(row["id"])
        if extra:
            row["properties"] = {**row["properties"], **extra}


def _row(record: asyncpg.Record) -> dict[str, Any]:
    """`dict(record)` with every `uuid.UUID` value stringified — asyncpg
    decodes `uuid` columns to `uuid.UUID` objects, but every `*Response`
    model in `models/database.py` declares id/fk fields as plain `str`
    (matching the rest of this app's convention — see `models/note.py`),
    so every `Model(**_row(record))` call needs this rather than the bare
    `dict(record)`."""
    return {
        k: (str(v) if isinstance(v, uuid_lib.UUID) else v) for k, v in dict(record).items()
    }


def _parse_uuid_or_404(value: str, what: str) -> str:
    """Validate a path param looks like a UUID before it ever reaches
    asyncpg — an unparseable UUID sent straight to asyncpg raises
    `DataError`, not a clean 404. Returns `value` unchanged (asyncpg
    accepts a plain `str` for a `uuid` parameter); this only guards the
    format."""
    try:
        uuid_lib.UUID(value)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")
    return value


def _is_uuid(value: Any) -> bool:
    """Same format check as `_parse_uuid_or_404`, but for a value nested
    inside a request BODY (a rollup's `config.target_data_source_id`) rather
    than a path param — a bad body value is a 400 (the request itself is
    malformed), never a 404 (which means "well-formed request, nothing
    there")."""
    if not isinstance(value, str):
        return False
    try:
        uuid_lib.UUID(value)
    except ValueError:
        return False
    return True


def _line_col(source: str, pos: int) -> tuple[int, int]:
    """0-based character offset -> 1-based `(line, col)`, matching exactly
    `services/db/formula/lexer.py`'s own `_Scanner` convention (`col` resets
    to 1 right after a newline) — `FormulaSyntaxError` already carries
    line/col computed this way; `FormulaTypeError` (typecheck.py) carries
    only `pos`, so `validate_formula` derives the same pair here rather than
    inventing a second, possibly-divergent convention. `pos` is clamped into
    `[0, len(source)]` first — a `pos` one past the end of the source (e.g.
    an error at EOF) is legitimate and must not `IndexError`."""
    pos = max(0, min(pos, len(source)))
    line = source.count("\n", 0, pos) + 1
    last_newline = source.rfind("\n", 0, pos)
    col = pos - last_newline if last_newline != -1 else pos + 1
    return line, col


async def _validate_and_prepare_computed_property(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    prop_type: str,
    config: dict[str, Any],
) -> tuple[str | None, bool]:
    """Save-time validation for a `formula`/`rollup` property's `config`,
    shared by `create_property` and `update_property` (task-28-brief.md §2).
    Returns `(result_type, is_volatile)` to store on `db_properties` —
    raises `HTTPException(400, ...)` for exactly the things the brief calls
    a hard rejection (a malformed rollup definition), and NEVER for a
    formula that merely fails to parse or type-check.

    That asymmetry is deliberate, not an oversight: research §1.9, quoted
    verbatim in the brief, "a formula with errors can still be saved... the
    property will display nothing" — `recompute.py`'s own `_compute_formula`
    already has to handle an unparseable/mistyped SAVED expression (a schema
    change after the fact can invalidate a previously-fine formula) by
    degrading every row to `{"type":"unsupported"}` rather than crashing a
    recompute pass, so a save-time reject here would only be enforcing, at
    the front door, an invariant the engine already has to tolerate being
    violated everywhere else. Only a dependency **cycle** (`FormulaCycleError`,
    checked by the caller via `recompute.validate_save`, not here — this
    function has no view of the whole graph, only one property's config) and
    a malformed **rollup** definition (no AST, no "still displays something
    sensible" fallback the way an unparseable formula has) are hard
    rejections.
    """
    try:
        parsed_config = ComputedConfig(**config)
    except ValidationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid {prop_type} config: {exc}") from exc

    if prop_type == "formula":
        expression = parsed_config.expression
        if not expression or not expression.strip():
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, "formula property requires a non-empty config.expression"
            )
        if len(expression) > _MAX_FORMULA_EXPRESSION_LENGTH:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"expression exceeds the {_MAX_FORMULA_EXPRESSION_LENGTH}-character limit",
            )
        prop_rows = await conn.fetch(
            "SELECT name, type FROM db_properties WHERE data_source_id = $1 AND user_id = $2",
            data_source_id, user_id,
        )
        names_to_types = {r["name"]: r["type"] for r in prop_rows}
        try:
            tree = parse_formula(expression, property_names=names_to_types.keys())
        except FormulaSyntaxError:
            # Save-time reject is deliberately NOT done here -- see this
            # function's own docstring. `result_type`/`is_volatile` are
            # simply unknown for an expression that never parsed.
            return None, False
        result = check_formula(tree, properties=names_to_types)
        return result.type.value, result.is_volatile

    if prop_type == "rollup":
        relation_key = parsed_config.relation_key
        target_ds_id = parsed_config.target_data_source_id
        target_key = parsed_config.target_key
        function = parsed_config.function
        if not (relation_key and target_ds_id and target_key and function):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "rollup requires config.relation_key, config.target_data_source_id, "
                "config.target_key, and config.function",
            )
        if function not in rollup_service.ROLLUP_FUNCTIONS:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"unknown rollup function: {function!r} (must be one of the 22 documented "
                "functions -- research §3.7)",
            )
        if not _is_uuid(target_ds_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "config.target_data_source_id is not a valid id")

        rel_row = await conn.fetchrow(
            "SELECT type, config FROM db_properties WHERE data_source_id = $1 AND user_id = $2 AND key = $3",
            data_source_id, user_id, relation_key,
        )
        if rel_row is None or rel_row["type"] != "relation":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"config.relation_key {relation_key!r} is not a relation property on this data source",
            )
        rel_config = rel_row["config"] or {}
        if str(rel_config.get("target_data_source_id") or "") != str(target_ds_id):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"config.target_data_source_id must match relation {relation_key!r}'s own target "
                f"({rel_config.get('target_data_source_id')!r})",
            )
        target_row = await conn.fetchrow(
            "SELECT type, result_type FROM db_properties WHERE data_source_id = $1 AND user_id = $2 AND key = $3",
            target_ds_id, user_id, target_key,
        )
        if target_row is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"config.target_key {target_key!r} does not exist on the target data source",
            )
        # rollup.py's own decided-here scope boundary (task-27-report.md
        # judgement call 5): a relation target has no single materialised
        # value to aggregate over, except for `count`, which never reads a
        # target value at all.
        if target_row["type"] == "relation" and function != "count":
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "a rollup cannot target a relation property, except with function='count'",
            )
        return rollup_service.ROLLUP_RESULT_TYPE[function].value, False

    return None, False


def _all_notes_database(user_id: str) -> DatabaseDetailResponse:
    """Synthesize the "All Notes" virtual source's response in memory —
    spec §6: "no db_row_props rows, no backfill migration at all." Same
    reasoning applies one level up: no db_databases/db_data_sources/
    db_properties/db_views rows either. Properties come straight from
    COLUMN_BACKED, in its declared order.
    """
    now = datetime.now(timezone.utc)
    database = DatabaseResponse(
        id=ALL_NOTES_ID,
        user_id=user_id,
        title="All Notes",
        description=[],
        icon="🧠",
        cover_url=None,
        is_inline=False,
        parent_note_id=None,
        is_locked=True,
        position=0,
        created_at=now,
        updated_at=now,
        deleted_at=None,
    )
    data_source = DataSourceResponse(
        id=ALL_NOTES_ID,
        database_id=ALL_NOTES_ID,
        user_id=user_id,
        name="All Notes",
        system_kind="notes",
        position=0,
        created_at=now,
        is_virtual=True,
    )
    properties = [
        PropertyResponse(
            id=f"col_{name}",
            data_source_id=ALL_NOTES_ID,
            user_id=user_id,
            key=prop.column,
            name=name.replace("_", " ").title(),
            type=prop.type,
            config={},
            description=None,
            storage="column",
            column_name=prop.column,
            result_type=None,
            is_volatile=False,
            position=i,
            created_at=now,
        )
        for i, (name, prop) in enumerate(COLUMN_BACKED.items())
    ]
    views = [
        ViewResponse(
            id=f"{ALL_NOTES_ID}-table",
            data_source_id=ALL_NOTES_ID,
            user_id=user_id,
            name="All Notes",
            icon=None,
            type="table",
            config={},
            filter=None,
            sorts=[],
            is_locked=False,
            position=0,
        )
    ]
    return DatabaseDetailResponse(
        database=database, data_source=data_source, properties=properties, views=views
    )


@router.post(
    "/databases", response_model=DatabaseDetailResponse, status_code=status.HTTP_201_CREATED
)
async def create_database(
    body: DatabaseCreate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> DatabaseDetailResponse:
    """One database + one (ordinary, `system_kind=NULL`) data source + one
    default table view + one default "Title" property, all in one
    transaction — spec §3.1: "The UI initially creates exactly one data
    source per database." The Title property matches Notion's own
    behaviour (every database starts with a title column) and means a
    freshly created database is immediately usable rather than inert with
    zero columns."""
    parent_note_id = body.parent_note_id
    if parent_note_id is not None:
        parent_note_id = _parse_uuid_or_404(parent_note_id, "note")
        note_row = await conn.fetchrow(
            "SELECT id FROM notes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            parent_note_id,
            user_id,
        )
        if note_row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "note not found")

    async with conn.transaction():
        db_row = await conn.fetchrow(
            """
            INSERT INTO db_databases (user_id, title, icon, is_inline, parent_note_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            user_id,
            body.title,
            body.icon,
            parent_note_id is not None,
            parent_note_id,
        )
        ds_row = await conn.fetchrow(
            """
            INSERT INTO db_data_sources (database_id, user_id, name)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            db_row["id"],
            user_id,
            "Default",
        )
        view_row = await conn.fetchrow(
            """
            INSERT INTO db_views (data_source_id, user_id, name, type)
            VALUES ($1, $2, $3, 'table')
            RETURNING *
            """,
            ds_row["id"],
            user_id,
            "Default view",
        )
        # A fresh data source has no existing keys, so a single mint (no
        # collision-retry loop, unlike create_property below) is safe here.
        prop_row = await conn.fetchrow(
            """
            INSERT INTO db_properties (data_source_id, user_id, key, name, type, storage, position)
            VALUES ($1, $2, $3, 'Title', 'title', 'jsonb', 0)
            RETURNING *
            """,
            ds_row["id"],
            user_id,
            mint_key(),
        )
    return DatabaseDetailResponse(
        database=DatabaseResponse(**_row(db_row)),
        data_source=DataSourceResponse(**_row(ds_row), is_virtual=False),
        properties=[PropertyResponse(**_row(prop_row))],
        views=[ViewResponse(**_row(view_row))],
    )


@router.get("/databases", response_model=DatabaseListResponse)
async def list_databases(
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> DatabaseListResponse:
    """Every database this user owns, newest first, each with the one data
    source Milestone 2 creates for it.

    This endpoint was missing until now, and its absence was load-bearing in
    two places rather than merely inconvenient: a relation property's target
    picker and a rollup's source picker both have to offer "which database?",
    and neither could be built without a way to enumerate them. It is also
    why a database was previously only reachable by remembering its URL --
    `POST /db/databases` navigated straight to the new one and nothing ever
    listed them again.

    The built-in All Notes virtual source (spec §6) is deliberately NOT
    included: it has no `db_databases` row, it cannot be a relation target
    (it has no `db_row_props` rows to link to, and `create_property` already
    rejects it outright), and a picker offering it would only produce a
    guaranteed 400. Callers that want it address it by its well-known
    `all-notes` id, exactly as they do today.

    One query, not one-per-database: the join is what keeps a workspace with
    fifty databases from becoming fifty round trips, the same N+1 reasoning
    `list_links_bulk` exists for on the relations side.
    """
    rows = await conn.fetch(
        """
        SELECT
            d.id            AS d_id,
            d.user_id       AS d_user_id,
            d.title         AS d_title,
            d.description   AS d_description,
            d.icon          AS d_icon,
            d.cover_url     AS d_cover_url,
            d.is_inline     AS d_is_inline,
            d.parent_note_id AS d_parent_note_id,
            d.is_locked     AS d_is_locked,
            d.position      AS d_position,
            d.created_at    AS d_created_at,
            d.updated_at    AS d_updated_at,
            d.deleted_at    AS d_deleted_at,
            s.id            AS s_id,
            s.database_id   AS s_database_id,
            s.user_id       AS s_user_id,
            s.name          AS s_name,
            s.system_kind   AS s_system_kind,
            s.position      AS s_position,
            s.created_at    AS s_created_at
        FROM db_databases d
        JOIN LATERAL (
            SELECT * FROM db_data_sources
            WHERE database_id = d.id AND user_id = d.user_id
            ORDER BY position, created_at
            LIMIT 1
        ) s ON TRUE
        WHERE d.user_id = $1 AND d.deleted_at IS NULL
        ORDER BY d.updated_at DESC, d.created_at DESC
        LIMIT $2
        """,
        user_id,
        _ROWS_LIMIT,
    )
    return DatabaseListResponse(
        databases=[
            DatabaseSummary(
                database=DatabaseResponse(
                    **{k[2:]: _jsonify(v) for k, v in r.items() if k.startswith("d_")}
                ),
                data_source=DataSourceResponse(
                    **{k[2:]: _jsonify(v) for k, v in r.items() if k.startswith("s_")}
                ),
            )
            for r in rows
        ]
    )


@router.get("/databases/{database_id}", response_model=DatabaseDetailResponse)
async def get_database(
    database_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> DatabaseDetailResponse:
    if database_id == ALL_NOTES_ID:
        return _all_notes_database(user_id)

    database_id = _parse_uuid_or_404(database_id, "database")

    db_row = await conn.fetchrow(
        """
        SELECT * FROM db_databases
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        """,
        database_id,
        user_id,
    )
    if db_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "database not found")

    # M2 always creates exactly one data source per database (spec §3.1);
    # take the first by position for the (future) multi-data-source case.
    ds_row = await conn.fetchrow(
        """
        SELECT * FROM db_data_sources
        WHERE database_id = $1 AND user_id = $2
        ORDER BY position, created_at
        LIMIT 1
        """,
        db_row["id"],
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    prop_rows = await conn.fetch(
        """
        SELECT * FROM db_properties
        WHERE data_source_id = $1 AND user_id = $2
        ORDER BY position, created_at
        """,
        ds_row["id"],
        user_id,
    )
    view_rows = await conn.fetch(
        """
        SELECT * FROM db_views
        WHERE data_source_id = $1 AND user_id = $2
        ORDER BY position
        """,
        ds_row["id"],
        user_id,
    )
    return DatabaseDetailResponse(
        database=DatabaseResponse(**_row(db_row)),
        data_source=DataSourceResponse(**_row(ds_row), is_virtual=False),
        properties=[PropertyResponse(**_row(r)) for r in prop_rows],
        views=[ViewResponse(**_row(r)) for r in view_rows],
    )


# Phase 0b (B2). Until these existed a database could be created and read but
# never changed or removed: `create_database` set a title once and nothing
# could rename it, give it an icon, or delete it. That made the whole database
# header surface unbuildable, which is why M8 is gated on this.
_DATABASE_UPDATABLE_FIELDS = frozenset(
    {"title", "description", "icon", "cover_url", "is_locked"}
)
# `icon`/`cover_url` are the only nullable columns among those, so only they
# can be cleared by sending an explicit `null`. A `null` for `title`,
# `description` or `is_locked` (all NOT NULL) is dropped rather than raising a
# NotNullViolationError -- the same contract, and the same reasoning, as
# `_VIEW_NULLABLE_FIELDS` above.
_DATABASE_NULLABLE_FIELDS = frozenset({"icon", "cover_url"})


@router.patch("/databases/{database_id}", response_model=DatabaseResponse)
async def update_database(
    database_id: str,
    body: DatabaseUpdate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> DatabaseResponse:
    """Partial update. Mirrors `update_view`'s shape deliberately, including
    binding `database_id`/`user_id` to the fixed `$1`/`$2` placeholders no
    matter how many optional fields are set, so the WHERE clause's scope
    predicate is always the same literal text even though the SET clause
    varies.

    Already-trashed databases are invisible here (`deleted_at IS NULL`), so a
    PATCH against one 404s rather than silently resurrecting it."""
    database_id = _parse_uuid_or_404(database_id, "database")
    updates = {
        field: value
        for field, value in body.model_dump(exclude_unset=True).items()
        if field in _DATABASE_UPDATABLE_FIELDS
        and (value is not None or field in _DATABASE_NULLABLE_FIELDS)
    }

    if not updates:
        row = await conn.fetchrow(
            "SELECT * FROM db_databases WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
            database_id,
            user_id,
        )
    else:
        set_sql = ", ".join(f"{field} = ${i + 3}" for i, field in enumerate(updates))
        row = await conn.fetchrow(
            f"""
            UPDATE db_databases SET {set_sql}, updated_at = NOW()
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            RETURNING *
            """,
            database_id,
            user_id,
            *updates.values(),
        )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "database not found")
    return DatabaseResponse(**_row(row))


@router.delete("/databases/{database_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_database(
    database_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> None:
    """SOFT delete -- sets `deleted_at`, matching Notion's own wording ("Move
    to Trash", not "Delete") and this schema's existing shape: `db_databases`
    has a `deleted_at` column and every read path already filters on
    `deleted_at IS NULL`, including the data-source lookups that reach rows.
    So one UPDATE makes the database, its data sources, properties and views
    all unreachable without touching a single other table.

    Deliberately does NOT trash the database's ROWS. A row is a `notes` row
    with its own `deleted_at` and its own trash UI; cascading into notes from
    here would delete user content that is reachable and restorable elsewhere.

    Idempotent-ish: a second delete 404s rather than succeeding silently, so a
    double-click surfaces rather than looking like it worked twice."""
    database_id = _parse_uuid_or_404(database_id, "database")
    row = await conn.fetchrow(
        """
        UPDATE db_databases SET deleted_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
        RETURNING id
        """,
        database_id,
        user_id,
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "database not found")


@router.get("/data-sources/{data_source_id}/rows", response_model=RowsResponse)
async def list_rows(
    data_source_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RowsResponse:
    """Milestone 2 ships no filter/sort compiler (Milestone 3) — this is a
    plain "list everything" query for both the virtual and ordinary case.
    """
    if data_source_id == ALL_NOTES_ID:
        # Column list is built from COLUMN_BACKED itself (task-5 review
        # finding 3) rather than duplicated as a hardcoded literal list —
        # those two lists silently drifting apart would KeyError below
        # (r[prop.column]) with nothing catching it if COLUMN_BACKED ever
        # grows a new entry. Safe to interpolate: every name in
        # COLUMN_BACKED is a fixed, already-validated Python literal (see
        # services/db/properties/columns.py's own module-level guard), not
        # request-influenced.
        _all_notes_columns = ", ".join(prop.column for prop in COLUMN_BACKED.values())
        note_rows = await conn.fetch(
            f"""
            SELECT id, {_all_notes_columns}
            FROM notes
            WHERE user_id = $1 AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT $2
            """,
            user_id,
            _ROWS_LIMIT,
        )
        rows = [_decode_all_notes_row(r) for r in note_rows]
        return RowsResponse(rows=rows)

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    row_rows = await conn.fetch(
        """
        SELECT note_id, properties FROM db_row_props
        WHERE data_source_id = $1 AND user_id = $2
        ORDER BY position
        LIMIT $3
        """,
        data_source_id,
        user_id,
        _ROWS_LIMIT,
    )
    rows = [_decode_ordinary_row(r) for r in row_rows]
    computed_by_id = await _fetch_computed_by_row(
        conn, user_id, data_source_id, [r["id"] for r in rows]
    )
    _merge_computed_into_rows(rows, computed_by_id)
    return RowsResponse(rows=rows)


def _resolve_group_label(
    key: str, default_label: str, prop_type: str, config: dict[str, Any]
) -> str:
    """Milestone 4's `grouping.py` has no config access (it only ever sees already-fetched
    rows + a `PropertyLookup`), so a select/status `Group`'s key AND label are both the
    raw stored option id (`_group_by_values`'s `_bucket(buckets, value, value, row)`) --
    the "group labels are opaque ids" gap the M4+M5 combined review flagged as a Minor
    (task-15-brief.md §1.6). Resolved here, the one place in this endpoint with both the
    grouped rows AND `db_properties.config`'s real option list: look up `key` against
    `config["options"]` by id, use that option's `name` if found. Falls back to
    `default_label` (== the raw id, from grouping.py) for every other property type, an
    unconfigured property (`config` has no "options" key or an empty one), or a
    stale/deleted option id no longer in the list -- including the implicit
    "__no_value__" bucket, which never matches any real option id and so always falls
    through here by construction, not via a special case."""
    if prop_type not in ("select", "status"):
        return default_label
    for option in config.get("options", []):
        if option.get("id") == key:
            return option.get("name", default_label)
    return default_label


def _resolve_aggregates(
    rows: list[dict[str, Any]],
    properties: dict[str, PropertyLookup],
    specs: list[AggregationSpec],
) -> dict[str, Any]:
    """Milestone 10 (task-32): the first HTTP caller of Milestone 4's `aggregations.
    aggregate(rows, lookup, aggregator)` -- one `{spec.key: value}` entry per
    `AggregationSpec`, computed over `rows` (a group's own rows, a subgroup's own rows, or
    (ungrouped) the whole filtered/sorted result set -- callers decide which `rows` this
    is, this function never re-derives it).

    `property_key` existence against this request's `properties` lookup is checked here
    (not inside `aggregate()`, which only ever receives an already-resolved `PropertyLookup
    | None` and has no dict to check against) -- same "unknown property key -> 400" message
    shape `group_by`/`sub_group_by` already use a few lines below in `query_rows`, reused
    verbatim rather than inventing a new one. `aggregate()`'s own `ValueError`s (unknown
    aggregator name, an aggregator that requires a `property_key` but got none, or a
    aggregator applied to the wrong property type) are converted to the same
    `HTTPException(400, str(exc))` pattern -- never a silently-dropped clause or a 500,
    the same standard `filter`/`sorts`/`group_by` already enforce in this handler."""
    result: dict[str, Any] = {}
    for spec in specs:
        lookup: PropertyLookup | None = None
        if spec.property_key is not None:
            lookup = properties.get(spec.property_key)
            if lookup is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"unknown property key: {spec.property_key!r}"
                )
        try:
            result[spec.key] = aggregations.aggregate(rows, lookup, spec.aggregator)
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return result


def _group_to_result(
    group: grouping.Group,
    prop_type: str,
    config: dict[str, Any],
    sub_lookup: PropertyLookup | None,
    sub_config: dict[str, Any],
    properties: dict[str, PropertyLookup],
    agg_specs: list[AggregationSpec],
) -> GroupResult:
    """`grouping.Group` -> the JSON-serializable `GroupResult` (models/database.py),
    resolving this group's label and -- one level down, per task-15-brief.md §1.6 -- every
    subgroup's label too. Never recurses past that: `sub_group()` itself only ever
    produces two levels (a subgroup's own `.subgroups` is always `None`), so a subgroup is
    built inline here rather than through a second call to this function.

    `aggregates` (task-32) is computed the same way at both levels -- `_resolve_aggregates`
    against *this* group's/subgroup's own `rows`, never the parent's -- and left `None`
    (not `{}`) whenever `agg_specs` is empty, so `response_model_exclude_none=True` on the
    route drops the key entirely and every pre-existing grouped-query test that never sends
    `aggregations` keeps a byte-identical response."""
    subgroups = None
    if group.subgroups is not None:
        assert sub_lookup is not None  # sub_group_by was set whenever subgroups exist
        subgroups = [
            GroupResult(
                key=sg.key,
                label=_resolve_group_label(sg.key, sg.label, sub_lookup.type, sub_config),
                row_count=len(sg.rows),
                rows=sg.rows,
                subgroups=None,
                aggregates=_resolve_aggregates(sg.rows, properties, agg_specs) if agg_specs else None,
            )
            for sg in group.subgroups
        ]
    return GroupResult(
        key=group.key,
        label=_resolve_group_label(group.key, group.label, prop_type, config),
        row_count=len(group.rows),
        rows=group.rows,
        subgroups=subgroups,
        aggregates=_resolve_aggregates(group.rows, properties, agg_specs) if agg_specs else None,
    )


@router.post(
    "/data-sources/{data_source_id}/query",
    response_model=QueryResponse,
    response_model_exclude_none=True,
)
async def query_rows(
    data_source_id: str,
    body: QueryRequest,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> QueryResponse:
    """Milestone 6 (task-15): the filtered/sorted/grouped superset of `list_rows` above --
    wires Milestone 3's filter/sort compiler (`services.db.query.compiler`/`builder`) and
    Milestone 4's grouping (`services.db.query.grouping`) into an HTTP endpoint for the
    first time (neither ever had a live caller before this). `list_rows` stays unmodified
    for any caller that doesn't need filtering/sorting/grouping.

    Same two-mode split as `list_rows`/`QueryBuilder` throughout: All Notes
    (`data_source_id == ALL_NOTES_ID`, properties built from `COLUMN_BACKED`) or an
    ordinary data source (properties from `db_properties`). Every row this endpoint can
    possibly return passes through `QueryBuilder.build()`, which always splices in
    `_scope()`'s mandatory `user_id`/`data_source_id`/`deleted_at` predicate (spec §8.3) --
    there is no code path here that queries `db_row_props`/`notes` directly.
    """
    all_notes = data_source_id == ALL_NOTES_ID
    configs: dict[str, dict[str, Any]] = {}

    if all_notes:
        properties = {
            prop.column: PropertyLookup(type=prop.type, storage="column", key=prop.column)
            for prop in COLUMN_BACKED.values()
        }
    else:
        data_source_id = _parse_uuid_or_404(data_source_id, "data source")
        ds_row = await conn.fetchrow(
            """
            SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
            """,
            data_source_id,
            user_id,
        )
        if ds_row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

        prop_rows = await conn.fetch(
            """
            SELECT key, type, storage, config, result_type, is_volatile
            FROM db_properties
            WHERE data_source_id = $1 AND user_id = $2
            """,
            data_source_id,
            user_id,
        )
        properties = {
            r["key"]: PropertyLookup(
                type=r["type"],
                storage=r["storage"],
                key=r["key"],
                # Milestone 7: without this, every relation filter/sort 400s
                # with "relation property is not configured" (the safe
                # failure, per compile_condition's/Relation.sql_order's own
                # ctx.relation is None guard) but is still broken —
                # task-21-brief.md §2. relation_ref_from_config already
                # returns None for a non-relation property's config (no
                # relation_id/side keys), so this is safe to call
                # unconditionally rather than gating on `r["type"] ==
                # "relation"` first.
                relation=relation_ref_from_config(r["config"]),
                # Milestone 8 combined review, Critical: the exact same
                # omission as the Milestone 7 one above, one milestone later
                # and at this same construction site. Task 27 built
                # `PropertyLookup.result_type`/`is_volatile`,
                # `properties/computed.py`'s Formula/Rollup descriptors and
                # `operators.py`'s RESULT_TYPE_OPERATORS, and all of it works
                # — but this dict never populated the two fields, so every
                # formula/rollup property arrived here with the dataclass
                # defaults (result_type=None, is_volatile=False) and every
                # filter or sort naming one 400'd with "has no filterable
                # operators"/"has no SQL shape". That made spec §7.3's whole
                # stated payoff ("formulas and rollups filter and sort in SQL
                # exactly like stored values") unreachable through
                # POST .../query — the only endpoint that compiles filters —
                # for every formula and rollup property, while passing every
                # test beneath it, because the service-layer tests build
                # PropertyLookup by hand.
                result_type=r["result_type"],
                is_volatile=r["is_volatile"],
            )
            for r in prop_rows
        }
        # Group-label resolution (below) needs each property's configured option list
        # too -- task-15-brief.md §1's own `SELECT key, type, storage` doesn't carry it,
        # so this widens that one query rather than issuing a second round-trip per group.
        configs = {r["key"]: (r["config"] or {}) for r in prop_rows}

    if body.aggregations:
        # Validate every spec up front, before the DB round trip below -- same
        # fail-fast-on-a-malformed-request spirit as parsing filter/sorts/group_by in the
        # try block right after this. Calling with `rows=[]` still exercises
        # `_resolve_aggregates`'s property-key-existence check AND `aggregate()`'s own
        # unknown-aggregator / needs-a-property-key / wrong-property-type ValueErrors --
        # every one of those guards runs before touching row content (aggregations.py's
        # own guard-clause-first structure), so an empty row list validates exactly the
        # same specs a real row list would, without a second, differently-shaped
        # validation path to keep in sync. This also 400s a bad spec on a grouped query
        # that happens to produce zero groups, which the per-group computation below
        # would otherwise never reach.
        _resolve_aggregates([], properties, body.aggregations)

    # Any query with aggregations must reflect the whole filtered/sorted result set, not
    # the one page `rows` returns (task-32-brief.md §2) -- so this fetch is *not* clipped
    # to `body.page_size`/`body.offset` the way every other query on this endpoint is.
    # Originally this only fired for the ungrouped case (`body.group_by is None`), but a
    # grouped Chart (column/bar/line/donut -- every Chart type except the ungrouped
    # "Number" mode) needs its per-group aggregate computed over ALL of that group's rows
    # too, not just whichever of them happened to land in the first `page_size`-bound page
    # -- fix-wave-1 finding 1. Grouped queries *without* aggregations are unaffected and
    # keep today's page_size-bounded fetch; grouping itself was never meant to page.
    compute_full_set = bool(body.aggregations)

    try:
        filter_node = ast.parse_filter(body.filter)
        sorts = [ast.SortSpec(**s) for s in body.sorts]
        # Always validated (ge=1/le=200 on page_size, ge=0 on offset) regardless of which
        # `pagination` actually drives the SQL fetch below -- `compute_full_set` changes
        # what gets fetched, never whether `body.page_size`/`body.offset` themselves are
        # still range-checked the same as every other request through this endpoint.
        requested_pagination = ast.Pagination(page_size=body.page_size, offset=body.offset)
        pagination = (
            # bypasses `ast.Pagination`'s own `Field(le=200)` (a per-request UI-page
            # ceiling, not a "give me everything for a chart" one) via `model_construct`
            # -- deliberate here: the value is our own trusted constant, not user input, so
            # skipping validation is safe. Reuses `_ROWS_LIMIT` (this file's existing
            # "generous cap for a personal single-user KB" fetch bound, defined above)
            # rather than inventing a second, near-duplicate cap with the same rationale.
            ast.Pagination.model_construct(page_size=_ROWS_LIMIT, offset=0)
            if compute_full_set
            else requested_pagination
        )
        builder = QueryBuilder(
            user_id=user_id,
            data_source_id=None if all_notes else data_source_id,
            properties=properties,
        )
        frag = builder.build(filter_node, sorts, pagination)
    except (ast.FilterValidationError, ValidationError) as exc:
        # spec §8.2 layer 2's "unknown key -> HTTP 400, never a silently dropped clause",
        # now reachable over HTTP for the first time -- both parse-time shape errors
        # (parse_filter/SortSpec/Pagination) and compile-time unknown-property-key errors
        # (raised deep inside builder.build() -> compile_filter/compile_sorts) are the
        # *same* FilterValidationError class (operators.py imports it from ast.py rather
        # than defining its own), so one except clause here genuinely covers both.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    records = await conn.fetch(frag.sql, *frag.params)
    decode = _decode_all_notes_row if all_notes else _decode_ordinary_row
    rows = [decode(r) for r in records]
    if not all_notes:
        # Milestone 8 (task-28-brief.md §4): merged in BEFORE grouping below,
        # not after -- a Board view's `group_by`/`sub_group_by` can itself
        # name a formula/rollup key (`grouping.group_rows` only ever sees
        # this already-built `rows` list), so a materialised value has to be
        # present here for that to group correctly too, not just for the
        # ungrouped response shape.
        computed_by_id = await _fetch_computed_by_row(
            conn, user_id, data_source_id, [r["id"] for r in rows]
        )
        _merge_computed_into_rows(rows, computed_by_id)

    if body.group_by is None:
        if not body.aggregations:
            return QueryResponse(rows=rows)
        # `rows` here is the full filtered/sorted set (up to `_ROWS_LIMIT`), fetched with
        # `compute_full_set`'s unbounded pagination above -- aggregate over all of it, then
        # slice out the page the client actually asked for in Python, reproducing exactly
        # what `LIMIT body.page_size OFFSET body.offset` would have produced in SQL (same
        # deterministic `ORDER BY ..., n.id ASC` either way) so `rows`' own shape in the
        # response is unchanged by this branch existing.
        aggregates = _resolve_aggregates(rows, properties, body.aggregations)
        page_rows = rows[body.offset : body.offset + body.page_size]
        return QueryResponse(rows=page_rows, aggregates=aggregates)

    group_key = body.group_by.get("property_key")
    group_lookup = properties.get(group_key) if group_key is not None else None
    if group_lookup is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown property key: {group_key!r}")
    try:
        group_spec = grouping.GroupBySpec(**body.group_by)
        groups = grouping.group_rows(rows, group_lookup, group_spec)
    except TypeError as exc:
        # GroupBySpec is a plain dataclass (grouping.py), not Pydantic -- an
        # unexpected/missing keyword raises TypeError, not ValidationError. Same "bad
        # input -> 400, not 500" standard as every other malformed-request path here.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except (ValueError, NotImplementedError) as exc:
        # group_rows's own "fail loud" contract for a non-groupable type or an
        # unsupported/missing mode (grouping.py's docstring) -- surfaced as a 400, not
        # left to bubble up as a 500.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    sub_lookup: PropertyLookup | None = None
    sub_config: dict[str, Any] = {}
    if body.sub_group_by is not None:
        sub_key = body.sub_group_by.get("property_key")
        sub_lookup = properties.get(sub_key) if sub_key is not None else None
        if sub_lookup is None:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown property key: {sub_key!r}")
        sub_config = configs.get(sub_key, {})
        try:
            sub_spec = grouping.GroupBySpec(**body.sub_group_by)
            groups = grouping.sub_group(groups, sub_lookup, sub_spec)
        except TypeError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        except (ValueError, NotImplementedError) as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    group_config = configs.get(group_key, {})
    return QueryResponse(
        groups=[
            _group_to_result(
                g, group_lookup.type, group_config, sub_lookup, sub_config,
                properties, body.aggregations,
            )
            for g in groups
        ]
    )


# `ast.Pagination`'s own `Field(le=200)` (task-15's per-request UI-page ceiling,
# validated inside `query_rows` on every call, `compute_full_set` or not) means a
# single `query_rows(...)` call can never itself return more than 200 rows unless
# `body.aggregations` is set -- and that branch re-slices `rows` straight back down
# to one `body.page_size`-sized page afterward (see the `page_rows = rows[...]`
# line and its comment inside `query_rows`), so it doesn't actually help reach an
# unbounded fetch either. Rather than touch `query_rows`'s internals for this (the
# brief's stated preference is to reuse it exactly as-is), `_fetch_all_export_rows`
# below loops page-sized (`_EXPORT_PAGE_SIZE`-row) calls to that same unmodified
# function up to `_ROWS_LIMIT` total rows -- filter/sort/tenancy stay 100%
# `query_rows`'s own logic, unre-derived; only the "ask for more than one page"
# orchestration is new, and it's the one departure from the brief's literal
# single-call suggestion (documented here and in task-48-report.md).
_EXPORT_PAGE_SIZE = 200


async def _fetch_all_export_rows(
    data_source_id: str,
    filter_dict: dict[str, Any] | None,
    sorts_list: list[dict[str, Any]],
    user_id: str,
    conn: asyncpg.Connection,
) -> tuple[list[dict[str, Any]], bool]:
    """Returns `(rows, truncated)` -- Fix 5 (task-51, M14 final cross-cutting review):
    `_ROWS_LIMIT` silently capped the export with a plain `200 OK` and no signal that
    more rows exist, while Task 50's Fix 7 caps CSV *import* at 10 MiB (easily tens of
    thousands of rows for a typical row shape) -- so a user could legitimately import
    far more than they could ever export back out, with zero warning. `truncated` is
    only ever `True` when the cap genuinely bit; the caller (`export_rows_csv`) turns
    that into an `X-Export-Truncated` response header.

    The loop's own exit condition mostly distinguishes the two cases: an underfull
    page (`len(page_rows) < _EXPORT_PAGE_SIZE`) proves there is nothing left to
    fetch beyond what's now in `all_rows`. But that alone is NOT the same as "not
    truncated" -- `_EXPORT_PAGE_SIZE` (200) does not evenly divide `_ROWS_LIMIT`
    (500) in production, and a caller-supplied `_ROWS_LIMIT` (tests) can be smaller
    than one page outright, so a single page can legitimately contain MORE rows
    than the remaining cap allows while still itself being underfull (e.g. exactly
    501 rows total: the 3rd page, at offset 400, returns the last 101 rows -- an
    underfull page, since 101 < 200 -- but `all_rows` is now 501, one over the
    500-row cap). The correct test is whether `all_rows` (before slicing) exceeds
    `_ROWS_LIMIT`, not merely whether the page was underfull. The *other* loop exit
    (the `while` condition itself going false because `len(all_rows)` reached
    `_ROWS_LIMIT` exactly on a FULL page) is genuinely ambiguous on its own: the
    data source might have exactly `_ROWS_LIMIT` rows (nothing missing) or it might
    have more (genuinely truncated) -- indistinguishable without one more look,
    resolved with a single cheap probe (`page_size=1` at `offset=_ROWS_LIMIT`)
    rather than guessed at.
    """
    all_rows: list[dict[str, Any]] = []
    offset = 0
    while len(all_rows) < _ROWS_LIMIT:
        query_body = QueryRequest(
            filter=filter_dict, sorts=sorts_list,
            page_size=_EXPORT_PAGE_SIZE, offset=offset,
        )
        result = await query_rows(data_source_id, query_body, user_id=user_id, conn=conn)
        page_rows = result.rows or []
        all_rows.extend(page_rows)
        if len(page_rows) < _EXPORT_PAGE_SIZE:
            # Ran out of rows naturally -- there is nothing beyond what's already
            # been fetched. Still truncated if this last (possibly oversized
            # relative to the remaining cap) page pushed `all_rows` past
            # `_ROWS_LIMIT` -- see the docstring's 501-row example.
            return all_rows[:_ROWS_LIMIT], len(all_rows) > _ROWS_LIMIT
        offset += _EXPORT_PAGE_SIZE

    probe_body = QueryRequest(
        filter=filter_dict, sorts=sorts_list, page_size=1, offset=_ROWS_LIMIT,
    )
    probe = await query_rows(data_source_id, probe_body, user_id=user_id, conn=conn)
    truncated = bool(probe.rows)
    return all_rows[:_ROWS_LIMIT], truncated


@router.get("/data-sources/{data_source_id}/export")
async def export_rows_csv(
    data_source_id: str,
    view_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> Response:
    """Milestone 14 (task-48): CSV export honouring the CURRENTLY OPEN view's
    filter/sort (spec §12, research §7.2/§10 "Markdown & CSV"; plan test case, line
    471: "export honours the current view's filters and sorts"). Deliberately does
    NOT reimplement filtering: builds a `QueryRequest` from the named view's own
    `filter`/`sorts` and calls `query_rows` directly, repeatedly, via
    `_fetch_all_export_rows` above (a plain `async def` under FastAPI's decorator,
    callable with explicit args exactly like `create_row`/`create_property` already
    are elsewhere in this file) so tenancy scoping (`QueryBuilder`/`compile_filter`/
    `compile_sorts`'s mandatory `_scope()` splice) and the AST compiler are reused
    unchanged, not re-derived. Fetches up to `_ROWS_LIMIT` rows total (not just the
    request-facing `QueryRequest` default of one 50-row page) so export isn't
    silently clipped to one UI page -- see `_fetch_all_export_rows`'s own docstring
    for why that takes a paging loop rather than one call.

    All Notes (`data_source_id == ALL_NOTES_ID`) is explicitly NOT a supported
    export target: it has no `db_views` rows at all (`create_view` already 400s
    attempts to create one, for the identical "virtual source" reason), so no
    `view_id` could ever legitimately name one -- 400 here rather than let an
    unresolvable `view_id` fall through to a generic-looking 404.

    Response shape: a buffered `text/csv` body (not `StreamingResponse`, not a
    JSON-wrapped `{csv: "..."}`) -- see task-48-report.md for why (in short: this
    app's own file-producing precedents don't establish a stronger convention
    either way, this is a personal-KB-scale export the brief itself says neither
    approach would meaningfully differ on, and the frontend's `/api/db/[...path]`
    proxy only forwards the `Content-Type` header, not `Content-Disposition`, so
    the filename is built client-side from the view's own name it already has --
    a plain text body is the simplest shape that works unchanged through that
    proxy).
    """
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot export the built-in All Notes source",
        )

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    view_id = _parse_uuid_or_404(view_id, "view")

    view_row = await conn.fetchrow(
        """
        SELECT filter, sorts, name FROM db_views
        WHERE id = $1 AND data_source_id = $2 AND user_id = $3
        """,
        view_id,
        data_source_id,
        user_id,
    )
    if view_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "view not found")

    # `config` is fetched alongside `key`/`name`/`type` -- a deliberate widening
    # beyond the brief's literal example query, same reasoning as Task 46's own
    # identical widening in `indexer.py`'s property-preamble lookup (task-46-
    # report.md judgment call 1): without it, `format_property_value` can't
    # resolve a select/status/multi_select option id to its configured display
    # name, so the export would show raw opaque ids where a label is knowable.
    prop_rows = await conn.fetch(
        """
        SELECT key, name, type, config FROM db_properties
        WHERE data_source_id = $1 AND user_id = $2
        ORDER BY position, created_at
        """,
        data_source_id,
        user_id,
    )

    rows, truncated = await _fetch_all_export_rows(
        data_source_id, view_row["filter"], list(view_row["sorts"] or []), user_id, conn
    )

    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["id"] + [p["name"] for p in prop_rows])
    for row in rows:
        wrapper_by_key = row.get("properties") or {}
        cells = [row["id"]]
        for p in prop_rows:
            wrapper = wrapper_by_key.get(p["key"])
            if p["type"] in ("formula", "rollup") and isinstance(wrapper, dict):
                # Fix 4 (task-51, M14 final cross-cutting review): `query_rows`
                # already merges this row's MATERIALISED formula/rollup result into
                # `row["properties"][key]` (`_merge_computed_into_rows`, the same
                # merge `TableView` renders from) -- but that merged wrapper is
                # tagged with the computed RESULT's own type (e.g. `{"type":
                # "number", "number": 42.0}` for a formula that produces a number),
                # never literally `"formula"`/`"rollup"` (`rollup.computed_wrapper`'s
                # own docstring/shape). Unwrapping via `p["type"]` (the PROPERTY's
                # declared type) below looks up a key ("formula"/"rollup") that was
                # never set on this wrapper -- always `None` -- and
                # `format_property_value` separately hard-codes `None` for these two
                # types regardless (by design, per Task 46: its caller, indexer.py,
                # never has a computed value available at all). Neither limitation
                # applies here, where the value genuinely is present -- resolve
                # using the WRAPPER'S OWN "type" tag (the result type) instead, and
                # format with THAT type's own rendering rules.
                actual_type = wrapper.get("type")
                cell = ""
                if actual_type:
                    raw_value = wrapper.get(actual_type)
                    cell = format_property_value(actual_type, raw_value, p["config"] or {}) or ""
                cells.append(cell)
                continue
            # §3.3 wrapper shape: {"type": <prop_type>, "<prop_type>": <value>} --
            # unwrap here (the one place that has both the wrapper and the
            # property's declared type), exactly as format.py's own module
            # docstring says the caller must, then hand the raw domain value to
            # Task 46's formatter unchanged.
            raw_value = wrapper.get(p["type"]) if isinstance(wrapper, dict) else None
            cells.append(format_property_value(p["type"], raw_value, p["config"] or {}) or "")
        writer.writerow(cells)

    safe_name = (view_row["name"] or "export").replace('"', "'")
    headers = {"Content-Disposition": f'attachment; filename="{safe_name}.csv"'}
    if truncated:
        # Fix 5 (task-51): signal truncation rather than silently handing back a
        # partial file. The frontend's `/api/db/[...path]` proxy only forwards
        # `Content-Type` today (see this function's own docstring) -- widened
        # alongside this to also forward this one header through.
        headers["X-Export-Truncated"] = "true"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers=headers,
    )


@router.get("/notes/{note_id}/row", response_model=NoteRowInfo)
async def get_note_row(
    note_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> NoteRowInfo:
    """RowPeek follow-up: lets `/brain/{noteId}` (the plain note page,
    `frontend/components/editor/NoteEditorPage.tsx`) discover whether the note it's
    showing is a database row and, if so, render its properties too -- previously
    only TableView/RowPeek (which have a data source's rows bulk-loaded already)
    could show property values at all; a directly-navigated-to note page had no way
    to ask "is this a row, and what's its schema" from a bare note id.

    404 (not a 200 with `properties: []`) for an ordinary, non-database note --
    `NoteEditorPage.tsx` must treat that as "render nothing extra," not "this row
    has zero properties," and a 404 is the unambiguous signal for that, matching
    every other "this id doesn't resolve to what the path implies" case in this
    router (`_parse_uuid_or_404` and friends).
    """
    note_id = _parse_uuid_or_404(note_id, "note")

    row_row = await conn.fetchrow(
        """
        SELECT data_source_id, properties, computed FROM db_row_props
        WHERE note_id = $1 AND user_id = $2
        """,
        note_id,
        user_id,
    )
    if row_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not a database row")

    ds_row = await conn.fetchrow(
        """
        SELECT ds.database_id, db.title AS database_title
        FROM db_data_sources ds
        JOIN db_databases db ON db.id = ds.database_id
        WHERE ds.id = $1 AND ds.user_id = $2 AND db.deleted_at IS NULL
        """,
        row_row["data_source_id"],
        user_id,
    )
    if ds_row is None:
        # The row's own data source/database was deleted out from under it --
        # structurally rare (both FKs cascade-delete db_row_props itself), kept
        # as a defensive 404 rather than an assert, same posture this router
        # takes everywhere else a "should be impossible" join comes up empty.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not a database row")

    prop_rows = await conn.fetch(
        """
        SELECT * FROM db_properties
        WHERE data_source_id = $1 AND user_id = $2
        ORDER BY position, created_at
        """,
        row_row["data_source_id"],
        user_id,
    )

    # Merge computed (formula/rollup) values into the same flat properties dict --
    # same merge `_merge_computed_into_rows` does for the bulk query path, just for
    # one row: `computed` is already keyed by property key, §3.3-wrapper-shaped, and
    # a key collision with a stored value is structurally impossible (a computed
    # value is only ever written under its own formula/rollup property's key).
    values = {**(row_row["properties"] or {}), **(row_row["computed"] or {})}

    return NoteRowInfo(
        data_source_id=str(row_row["data_source_id"]),
        database_id=str(ds_row["database_id"]),
        database_title=ds_row["database_title"],
        properties=[PropertyResponse(**_row(r)) for r in prop_rows],
        values=values,
    )


@router.post(
    "/data-sources/{data_source_id}/rows",
    response_model=RowResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_row(
    data_source_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RowResponse:
    """Create a new row on an ordinary (non-virtual) data source (review
    finding 3, fix round 2: without this, `update_row_property` above was
    unreachable end-to-end — there was no way to get a row into existence
    in the first place, so ordinary databases had zero rows, permanently).

    A database row *is* a note (spec Q2) — `db_row_props.note_id` is a FK
    to `notes.id` — so this creates the underlying `notes` row first, then
    the `db_row_props` companion row referencing it, in one transaction:
    both succeed or neither does, the same pattern as `create_database`.
    The transactional core lives in `services/db/rows.py`'s
    `create_row_core` (task-37 extraction) — this handler is now just the
    data-source ownership check plus a thin dispatch.

    Minimal version: an untitled note with empty `properties` (`{}`, the
    column default — spec §3.3: "Absent key ≡ empty," so an empty
    properties object is a fully valid row, not a placeholder state).
    Per-property default values (spec §5's `PropertyType.default()`) are
    Milestone 3+ scope — not needed to unblock "a row exists to edit."

    Milestone 12 (task-37-brief.md decision 3): if the data source has a
    default template (`db_row_templates.is_default`), the new row is
    instantiated FROM that template instead of created blank — this is
    entirely server-side behavior enrichment, no request-shape change and
    still a `RowResponse`. No default template -> today's exact blank-row
    behavior, unchanged (that path is `create_row_core` with no
    properties/content overrides, same as before this task).
    """
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "rows on the All Notes virtual source are notes themselves — create a note directly",
        )

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    default_template = await conn.fetchrow(
        """
        SELECT id FROM db_row_templates
        WHERE data_source_id = $1 AND user_id = $2 AND is_default
        """,
        data_source_id,
        user_id,
    )
    if default_template is not None:
        result = await templates_service.instantiate_template(
            conn, user_id, str(default_template["id"])
        )
        # instantiate_template only returns None for a template id that
        # doesn't exist/isn't user_id's -- impossible here, since the id
        # just came from a user_id-scoped SELECT on the very same
        # connection one line above (no request boundary in between for a
        # concurrent delete to land in).
        assert result is not None
        try_index_note(result.id, user_id)
        return result

    result = await create_row_core(conn, user_id, data_source_id)
    # Fix 4.1 (task-50, M14 combined review): best-effort, non-fatal property-preamble
    # refresh -- see `services/indexer.py`'s `try_index_note` docstring. Without this,
    # a row created via "+ New row" (this exact path) never got any preamble chunks
    # until someone happened to edit its body text.
    try_index_note(result.id, user_id)
    return result


@router.patch("/data-sources/{data_source_id}/rows/{note_id}", response_model=RowResponse)
async def update_row_property(
    data_source_id: str,
    note_id: str,
    body: RowPropertyUpdate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RowResponse:
    """Write a single property's value on a single row (task-5 review
    finding 1 — the milestone's own frontend test cases, "TableView
    renders 8 property types read-only, then editable" and "optimistic
    edit rolls back and toasts on a 500", aren't buildable without this).

    Ordinary data sources only: this endpoint writes into `db_row_props.
    properties`, a JSONB column keyed by minted property keys.
    `body.value` is the full spec §3.3 wrapper (e.g. `{"type": "status",
    "status": "done"}`), matching what `GET .../rows` returns and what's
    actually stored — never a bare scalar.

    All Notes (the virtual source, `data_source_id == "all-notes"`) is
    deliberately NOT handled here: each column-backed property has a
    genuinely different write-side coercion (an array for `topics`, an
    enum-constrained scalar for `mastery_status` with a `notes` CHECK
    constraint, a `rich_text`-typed wrapper for `icon` despite the column
    being a plain string, `created_at`/`updated_at` being read-only
    computed timestamps that should reject writes rather than silently
    accept them) rather than one generic JSONB merge. Building that
    correctly for all 9 columns is real, separate scope; shipping it
    rushed risks a wrong-coercion bug that's worse than not having the
    endpoint yet. Deferred, not forgotten — flagged again in the task-5
    report.

    Task 38 (Milestone 12, decision 5): the actual write — relation-type
    rejection, the wrapper-shape check, the Milestone 7 date-shift cascade,
    the title-sync block, and now the `property_edited` automation hook —
    all live in `services/db/rows.py`'s `update_row_property_core`. This
    handler is a thin HTTP seam: parse/404 the path params, check
    data-source ownership, call the core function, map its framework-free
    typed exceptions to HTTP the same way `_relation_error_to_http` already
    does for `RelationError` elsewhere in this file.
    """
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "row writes on the All Notes virtual source are not yet implemented",
        )

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    note_id = _parse_uuid_or_404(note_id, "row")

    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    try:
        result = await update_row_property_core(
            conn, user_id, data_source_id, note_id, body.property_key, body.value
        )
    except PropertyNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "property not found") from exc
    except RowNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "row not found") from exc
    except RelationError as exc:
        # Same seam as every other relations.py call site in this file --
        # `cascade_dependency_shift` (called from inside the core function)
        # raises this for a cycle/depth-cap failure reached at cascade time.
        raise _relation_error_to_http(exc) from exc
    except RowPropertyValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except ValueError as exc:
        # Anything else framework-free from the core function (e.g. an
        # unknown `date_shift_mode` string surfacing from
        # `cascade_dependency_shift`) -- same "never a 500" bar the
        # pre-extraction inline handler held.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    # Fix 4.2 (task-50, M14 combined review): best-effort, non-fatal property-preamble
    # refresh -- see `services/indexer.py`'s `try_index_note` docstring. Editing a
    # property cell is the entire point of spec §12 item 1 ("a query like 'what's
    # blocked on the compiler' can match on property values"), so this is the single
    # most important call site of the 6 this fix touches.
    try_index_note(result.id, user_id)
    return result


@router.post(
    "/data-sources/{data_source_id}/properties",
    response_model=PropertyResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_property(
    data_source_id: str,
    body: PropertyCreate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> PropertyResponse:
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot add properties to the built-in All Notes source",
        )

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    if body.type not in REGISTRY:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unknown property type: {body.type!r}")

    # Milestone 8 (task-28-brief.md §2): formula/rollup need real validation
    # at save time -- computed BEFORE the key-mint loop below since neither
    # depends on the (not yet minted) key, and there's no reason to redo it
    # on a UniqueViolationError retry. Raises HTTPException(400) itself for
    # the things that are genuine hard rejections (see this function's own
    # docstring); a formula that merely fails to parse/typecheck returns
    # `(None, False)` rather than raising, and still saves.
    result_type: str | None = None
    is_volatile = False
    if body.type in ("formula", "rollup"):
        result_type, is_volatile = await _validate_and_prepare_computed_property(
            conn, user_id, data_source_id, body.type, body.config
        )

    for _ in range(_KEY_MINT_ATTEMPTS):
        key = mint_key()
        try:
            # Each attempt gets its own transaction (a SAVEPOINT if `conn`
            # is already inside one, e.g. a test's rolled-back wrapper —
            # see tests/conftest.py's db_conn fixture). Without this, a
            # UniqueViolationError aborts the *entire* enclosing Postgres
            # transaction (not just this statement), and every subsequent
            # attempt — including ones with a fresh, non-colliding key —
            # would fail with "current transaction is aborted" instead of
            # actually retrying. The cycle check and full recompute below
            # (Milestone 8) also live inside this same per-attempt
            # transaction: a save that turns out to close a dependency
            # cycle must undo the INSERT that revealed it, and a recompute
            # that somehow raised must not leave a property behind whose
            # config and materialised values disagree (task-28-brief.md §3's
            # "if recompute raises, the write rolls back," applied here to
            # a property save instead of a row write).
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    INSERT INTO db_properties
                        (data_source_id, user_id, key, name, type, config, description,
                         storage, position, result_type, is_volatile)
                    VALUES
                        ($1, $2, $3, $4, $5, $6, $7, 'jsonb',
                         COALESCE(
                            (SELECT MAX(position) + 1 FROM db_properties
                             WHERE data_source_id = $1 AND user_id = $2),
                            0),
                         $8, $9)
                    RETURNING *
                    """,
                    data_source_id,
                    user_id,
                    key,
                    body.name,
                    body.type,
                    body.config,
                    body.description,
                    result_type,
                    is_volatile,
                )
                if body.type in ("formula", "rollup"):
                    try:
                        await recompute.validate_save(conn, user_id)
                    except FormulaCycleError as exc:
                        raise HTTPException(
                            status.HTTP_400_BAD_REQUEST,
                            f"saving this {body.type} would create a dependency cycle: {exc}",
                        ) from exc
                    # A brand-new formula/rollup has no materialised values
                    # at all yet -- without this it would show empty until
                    # an unrelated row write happened to touch it
                    # (task-28-brief.md §2).
                    await recompute.recompute_full(conn, user_id)
        except asyncpg.UniqueViolationError:
            continue
        return PropertyResponse(**_row(row))
    raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "could not mint a unique property key")


@router.patch("/properties/{property_id}", response_model=PropertyResponse)
async def update_property(
    property_id: str,
    body: PropertyUpdate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> PropertyResponse:
    """`name` alone is metadata-only (spec §4.2: "Rename is metadata-only") --
    never touches `key`, and — since it never touches `db_row_props` at all
    for a name-only edit — every row's JSONB is byte-identical before and
    after.

    `config` (Milestone 8, task-28-brief.md §2's "creating AND updating"):
    the only way to edit an existing formula's expression or an existing
    rollup's relation/target/function after creation. Applies the exact same
    `_validate_and_prepare_computed_property` + `recompute.validate_save`
    (cycle rejection) + `recompute.recompute_full` sequence `create_property`
    uses — a changed expression's old materialised values are exactly as
    stale the instant the expression changes as a brand-new property's are.
    `config` is a silent pass-through, unvalidated, for every other property
    type (this endpoint has never validated `config` shape for non-computed
    types and doesn't start now — matches `ViewUpdate`'s identical stance
    for its own JSONB columns)."""
    property_id = _parse_uuid_or_404(property_id, "property")
    current = await conn.fetchrow(
        """
        SELECT data_source_id, type, config, result_type, is_volatile
        FROM db_properties WHERE id = $1 AND user_id = $2
        """,
        property_id,
        user_id,
    )
    if current is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "property not found")

    config = current["config"]
    result_type = current["result_type"]
    is_volatile = current["is_volatile"]
    needs_recompute = False

    # Phase 0b (B5): a type change rewrites every stored value, or is refused.
    new_type = body.type if body.type is not None else current["type"]
    type_changed = new_type != current["type"]
    if type_changed:
        if not is_legal(current["type"], new_type):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"cannot convert a {current['type']} property to {new_type}",
            )
        # The old config describes the old type (a select's options mean
        # nothing to a number), so it is dropped unless the same request
        # supplies a replacement.
        if body.config is None:
            config = {}

    if body.config is not None:
        config = body.config
        if current["type"] in ("formula", "rollup"):
            result_type, is_volatile = await _validate_and_prepare_computed_property(
                conn, user_id, str(current["data_source_id"]), current["type"], body.config
            )
            needs_recompute = True

    # Phase 0b (B3). `description` is nullable and an explicit `null` must
    # CLEAR it, so COALESCE (which `name` uses) would be wrong -- it cannot
    # distinguish "not sent" from "sent as null". `model_fields_set` is the
    # only thing that can, hence the boolean flag threaded into the CASE.
    description_provided = "description" in body.model_fields_set

    async with conn.transaction():
        row = await conn.fetchrow(
            """
            UPDATE db_properties
            SET name = COALESCE($1, name),
                config = $2,
                result_type = $3,
                is_volatile = $4,
                description = CASE WHEN $5 THEN $6 ELSE description END,
                type = $7
            WHERE id = $8 AND user_id = $9
            RETURNING *
            """,
            body.name,
            config,
            result_type,
            is_volatile,
            description_provided,
            body.description,
            new_type,
            property_id,
            user_id,
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "property not found")

        if type_changed:
            # Same transaction as the column write: a half-converted data
            # source — new type, old wrappers — is exactly the invalid state
            # this whole mechanism exists to avoid.
            key = row["key"]
            existing_rows = await conn.fetch(
                """
                SELECT note_id, properties FROM db_row_props
                WHERE data_source_id = $1 AND user_id = $2
                """,
                row["data_source_id"],
                user_id,
            )
            for existing in existing_rows:
                props = dict(existing["properties"] or {})
                if key not in props:
                    continue
                try:
                    converted = convert_value(props[key], current["type"], new_type)
                except ConversionError as exc:  # pragma: no cover - guarded above
                    raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
                if converted is None:
                    # An absent key and an empty wrapper are different states
                    # elsewhere in this codebase, so drop rather than blank.
                    props.pop(key)
                else:
                    props[key] = converted
                await conn.execute(
                    """
                    UPDATE db_row_props SET properties = $1
                    WHERE note_id = $2 AND user_id = $3
                    """,
                    props,
                    existing["note_id"],
                    user_id,
                )

        if needs_recompute:
            try:
                await recompute.validate_save(conn, user_id)
            except FormulaCycleError as exc:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"saving this {current['type']} would create a dependency cycle: {exc}",
                ) from exc
            await recompute.recompute_full(conn, user_id)
    return PropertyResponse(**_row(row))


@router.delete("/properties/{property_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_property(
    property_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> None:
    """Deletes the property, then sweeps its `key` out of every view
    belonging to the same data source (spec §10)."""
    property_id = _parse_uuid_or_404(property_id, "property")
    async with conn.transaction():
        row = await conn.fetchrow(
            """
            DELETE FROM db_properties
            WHERE id = $1 AND user_id = $2
            RETURNING data_source_id, key
            """,
            property_id,
            user_id,
        )
        if row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "property not found")
        await sweep_property_from_views(conn, user_id, str(row["data_source_id"]), row["key"])


@router.post(
    "/data-sources/{data_source_id}/formulas/validate",
    response_model=FormulaValidateResponse,
)
async def validate_formula(
    data_source_id: str,
    body: FormulaValidateRequest,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> FormulaValidateResponse:
    """Spec §7.1's exact, deliberately narrow contract: parse errors, the
    inferred result type, and the referenced properties -- nothing else.
    There is no evaluate-this-formula-for-me endpoint (a second evaluator,
    in TS, in the browser, is exactly the divergence spec §7.1 rejects at
    length) -- `FormulaEditor` calls only this.

    **A malformed expression is the NORMAL case here, not an error**: a
    formula editor calls this on every keystroke, so a syntax error is
    always a 200 with `valid: false`, never a 400 (task-28-brief.md §1). A
    missing/unknown data source is still a 404 -- that's a genuinely
    different kind of wrong request (there's no schema to check the
    expression's property references against at all), not something a
    formula editor would ever hit by typing.
    """
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "formulas are not supported on the All Notes virtual source",
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2", data_source_id, user_id
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    # Debounce is the client's job (task-28-brief.md §1), but the server is
    # protected anyway: cap expression length (a hostile/pathological flat
    # expression costs lexer/parser/checker time proportional to length
    # regardless of nesting depth) and reuse Task 23's own `MAX_PARSE_DEPTH`
    # (enforced inside `parse_formula` itself, not duplicated here) -- "a 200
    # that takes 30 seconds is a denial vector."
    if len(body.expression) > _MAX_FORMULA_EXPRESSION_LENGTH:
        return FormulaValidateResponse(
            valid=False,
            errors=[
                FormulaValidationIssue(
                    message=f"expression exceeds the {_MAX_FORMULA_EXPRESSION_LENGTH}-character limit",
                    pos=0,
                    line=1,
                    col=1,
                )
            ],
        )

    prop_rows = await conn.fetch(
        "SELECT key, name, type FROM db_properties WHERE data_source_id = $1 AND user_id = $2",
        data_source_id,
        user_id,
    )
    names_to_types = {r["name"]: r["type"] for r in prop_rows}
    names_to_keys = {r["name"]: r["key"] for r in prop_rows}

    try:
        tree = parse_formula(body.expression, property_names=names_to_types.keys())
    except FormulaSyntaxError as exc:
        # `parse()`'s own docstring: "raises FormulaSyntaxError for any
        # malformed input and nothing else" -- exactly the contract this
        # endpoint depends on to never 500 on bad input.
        return FormulaValidateResponse(
            valid=False,
            errors=[
                FormulaValidationIssue(message=exc.message, pos=exc.pos, line=exc.line, col=exc.col)
            ],
        )

    result = check_formula(tree, properties=names_to_types)
    referenced_keys = sorted(
        names_to_keys[name] for name in result.referenced if name in names_to_keys
    )
    errors = []
    for e in result.errors:
        line, col = _line_col(body.expression, e.pos)
        errors.append(FormulaValidationIssue(message=e.message, pos=e.pos, line=line, col=col))

    return FormulaValidateResponse(
        valid=not errors,
        errors=errors,
        result_type=result.type.value,
        referenced_properties=referenced_keys,
        is_volatile=result.is_volatile,
    )


@router.post(
    "/data-sources/{data_source_id}/views",
    response_model=ViewResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_view(
    data_source_id: str,
    body: ViewCreate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> ViewResponse:
    """The first way to create a non-default view (task-15): `create_database` mints
    exactly one table view per data source, and there was previously no other path to a
    second one -- every M6 view type (Board/Gallery/List/Feed) was unreachable through the
    UI regardless of how good its frontend component was.

    All Notes cannot have views created on it -- it's virtual, no `db_views` row is
    possible (spec §6) -- same 400 pattern `create_property` already uses for the same
    reason on the same virtual source. `type` is deliberately unvalidated beyond being a
    non-empty string (`ViewCreate`'s own Pydantic `str` requirement) -- see
    `models/database.py`'s `ViewCreate` docstring for why no closed enum lives here.
    """
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot add views to the built-in All Notes source",
        )

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    # Position default: same COALESCE(MAX(position)+1, 0) pattern create_property already
    # uses for db_properties, copied rather than reinvented (task-15-brief.md §2).
    row = await conn.fetchrow(
        """
        INSERT INTO db_views (data_source_id, user_id, name, type, icon, position)
        VALUES ($1, $2, $3, $4, $5,
                COALESCE(
                    (SELECT MAX(position) + 1 FROM db_views
                     WHERE data_source_id = $1 AND user_id = $2),
                    0))
        RETURNING *
        """,
        data_source_id,
        user_id,
        body.name,
        body.type,
        body.icon,
    )
    return ViewResponse(**_row(row))


# task-45-brief.md: research §13.2's hard limits on a `dashboard` view's
# widget grid.
_DASHBOARD_MAX_WIDGETS_PER_ROW = 4
_DASHBOARD_MAX_WIDGETS_TOTAL = 12


async def _validate_dashboard_config(
    conn: asyncpg.Connection,
    user_id: str,
    data_source_id: str,
    config: dict[str, Any],
) -> None:
    """Validates a `dashboard` view's `config.rows[].widgets[]` shape (research §13.2,
    §13's structure table) before it's persisted — `update_view`'s `config` column is
    otherwise a completely unvalidated JSONB pass-through (task-45-brief.md: "the
    widget-count limits below are enforceable NOWHERE right now"). Follows the same
    inline `HTTPException(400, ...)` convention as `_validate_and_prepare_computed_property`
    above, rather than a typed exception + a `_x_error_to_http` mapper — there's exactly
    one caller shape here (a single router function), not several services sharing one
    error taxonomy the way `RelationError` is shared.

    Called from `update_view`, whenever a PATCH sets `config` on a view whose
    already-stored `type` is `"dashboard"`. NOT called from `create_view`: `ViewCreate`
    (models/database.py) has no `config` field at all, so a freshly created dashboard
    always starts at `config: {}` (empty `rows`) and every widget is added through a
    subsequent PATCH, which always goes through this same check. If `ViewCreate` ever
    grows a `config` field, `create_view` must call this too — it does not today because
    there is nothing for it to validate yet.

    Widget self-reference (a dashboard whose own widget points back at itself) is a
    special case of the nested-dashboard rule below, not a separate check: the view being
    edited already has stored `type = "dashboard"`, so if a widget's `view_id` is that
    same id, the query below finds it with `type = "dashboard"` and the nested-dashboard
    branch rejects it — no extra id-exclusion logic needed.
    """
    if not isinstance(config, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "config must be an object")

    rows = config.get("rows", [])
    if not isinstance(rows, list):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "config.rows must be a list")

    total_widgets = 0
    view_ids: set[str] = set()

    for row in rows:
        if not isinstance(row, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "each config.rows entry must be an object")
        widgets = row.get("widgets", [])
        if not isinstance(widgets, list):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "config.rows[].widgets must be a list")
        if len(widgets) > _DASHBOARD_MAX_WIDGETS_PER_ROW:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"a dashboard row cannot have more than {_DASHBOARD_MAX_WIDGETS_PER_ROW} "
                "widgets (research §13.2)",
            )
        total_widgets += len(widgets)
        for widget in widgets:
            if not isinstance(widget, dict):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "each widget must be an object")
            widget_view_id = widget.get("view_id")
            width = widget.get("width")
            if not _is_uuid(widget_view_id):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "widget.view_id is not a valid id")
            if not isinstance(width, int) or isinstance(width, bool) or not (1 <= width <= 12):
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, "widget.width must be between 1 and 12"
                )
            view_ids.add(widget_view_id)

    if total_widgets > _DASHBOARD_MAX_WIDGETS_TOTAL:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"a dashboard cannot have more than {_DASHBOARD_MAX_WIDGETS_TOTAL} widgets "
            "total (research §13.2)",
        )

    if not view_ids:
        return

    found_rows = await conn.fetch(
        """
        SELECT id, type FROM db_views
        WHERE id = ANY($1::uuid[]) AND user_id = $2 AND data_source_id = $3
        """,
        list(view_ids),
        user_id,
        data_source_id,
    )
    # A widget's view_id that doesn't come back here is either nonexistent, owned by a
    # different user, or from a different data_source_id -- all three collapse to the
    # same tenancy-scoped WHERE clause and the same rejection reason, matching how every
    # other cross-entity FK check in this file (e.g. the rollup target checks above)
    # scopes by user_id in the same query rather than checking existence and ownership
    # as two separate round trips.
    found = {str(r["id"]): r["type"] for r in found_rows}

    missing = view_ids - found.keys()
    if missing:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "widget.view_id must reference an existing view belonging to this dashboard's "
            f"own data source: {sorted(missing)[0]} not found",
        )

    nested = sorted(vid for vid in view_ids if found[vid] == "dashboard")
    if nested:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "dashboard views cannot be nested -- widget.view_id "
            f"{nested[0]} is itself a dashboard view (research §13.2)",
        )


# `ViewUpdate`'s own declared field names — never request-supplied, so
# building a SET clause from them (below) isn't a SQL-injection surface,
# the same reasoning as the column allow-list in
# services/db/properties/columns.py.
_VIEW_UPDATABLE_FIELDS = ("name", "icon", "config", "filter", "sorts", "is_locked", "position")

# Migration 014's `db_views`: `icon` and `filter` are the only nullable
# columns among _VIEW_UPDATABLE_FIELDS — the other five (`name`, `config`,
# `sorts`, `is_locked`, `position`) are NOT NULL. Sending an explicit
# `null` for one of those five must not reach the database (review
# finding 2, fix round 2 — verified end-to-end as a real
# NotNullViolationError, not a theoretical concern).
_VIEW_NULLABLE_FIELDS = frozenset({"icon", "filter"})


@router.patch("/views/{view_id}", response_model=ViewResponse)
async def update_view(
    view_id: str,
    body: ViewUpdate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> ViewResponse:
    """Partial update (task-5 review finding 1: column width/visibility/
    sort persistence "has nowhere to go" without this). Only fields
    actually present in the request body are touched
    (`model_dump(exclude_unset=True)`): `{"filter": null}` or
    `{"icon": null}` clears them (the only two nullable columns among the
    updatable fields), but an explicit `null` for any of the other five
    fields (`name`/`config`/`sorts`/`is_locked`/`position`, all `NOT
    NULL`) is dropped — a no-op for that one field, not a write — while
    the rest of the same request's fields still apply.

    `view_id`/`user_id` are always bound to the fixed placeholders `$1`/
    `$2`, regardless of how many optional fields are being set — so the
    WHERE clause's scope predicate is always the same literal text (see
    `tests/test_databases_router.py`'s guard test, which greps for exactly
    that), even though the SET clause's shape varies.

    task-45-brief.md: when `config` is one of the touched fields, a
    pre-check SELECT (`type`, `data_source_id`) runs first -- the request
    body never carries `type`, so this is the only way to know whether the
    view being patched is a `dashboard` before deciding whether
    `_validate_dashboard_config` applies. That pre-check deliberately does
    NOT 404 on its own when the view is missing; it lets control fall
    through to the UPDATE's own `RETURNING` -> `row is None` -> 404 below,
    so "view not found" keeps exactly one wording regardless of which
    field triggered the lookup.
    """
    view_id = _parse_uuid_or_404(view_id, "view")
    updates = {
        field: value
        for field, value in body.model_dump(exclude_unset=True).items()
        if field in _VIEW_UPDATABLE_FIELDS
        and (value is not None or field in _VIEW_NULLABLE_FIELDS)
    }

    if not updates:
        row = await conn.fetchrow(
            """
            SELECT * FROM db_views WHERE id = $1 AND user_id = $2
            """,
            view_id,
            user_id,
        )
    else:
        if "config" in updates:
            # task-45-brief.md: the request body doesn't carry `type`, so a
            # pre-check is needed to know whether this PATCH is touching a
            # dashboard view -- only dashboards get widget-grid validation.
            # A missing view here (existing is None) is deliberately NOT a
            # 404 by itself: it falls through to the UPDATE below, whose own
            # `RETURNING` -> `row is None` -> 404 stays the single source of
            # truth for "view not found", so the 404 wording never depends on
            # which branch noticed the view was missing.
            existing = await conn.fetchrow(
                "SELECT type, data_source_id FROM db_views WHERE id = $1 AND user_id = $2",
                view_id,
                user_id,
            )
            if existing is not None and existing["type"] == "dashboard":
                await _validate_dashboard_config(
                    conn, user_id, str(existing["data_source_id"]), updates["config"]
                )

        set_sql = ", ".join(f"{field} = ${i + 3}" for i, field in enumerate(updates))
        row = await conn.fetchrow(
            f"""
            UPDATE db_views SET {set_sql}
            WHERE id = $1 AND user_id = $2
            RETURNING *
            """,
            view_id,
            user_id,
            *updates.values(),
        )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "view not found")
    return ViewResponse(**_row(row))


@router.delete("/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_view(
    view_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> None:
    """Phase 0b (B1). Hard delete -- a view is pure configuration (name, type,
    filter, sorts, config); deleting one destroys no user data, so unlike a
    database it needs no trash.

    *** THE LAST VIEW CANNOT BE DELETED. *** Captured from live Notion: a
    database with one view has no "Delete view" row in its view menu at all,
    and the row appears only once a second view exists
    (docs/ui-specs/view-tab-bar.md). That is not cosmetic -- a data source
    with zero views has nothing to render, and `useDatabaseView` falls back to
    `views[0]`, which would be `undefined`. Enforced here as well as in the UI
    because the UI is not the only caller.

    The count and the delete run in one transaction so two concurrent deletes
    cannot each see two views and both succeed, leaving zero."""
    view_id = _parse_uuid_or_404(view_id, "view")
    async with conn.transaction():
        existing = await conn.fetchrow(
            "SELECT data_source_id FROM db_views WHERE id = $1 AND user_id = $2",
            view_id,
            user_id,
        )
        if existing is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "view not found")

        remaining = await conn.fetchval(
            """
            SELECT count(*) FROM db_views
            WHERE data_source_id = $1 AND user_id = $2
            """,
            existing["data_source_id"],
            user_id,
        )
        if remaining <= 1:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "cannot delete the only view of a data source",
            )

        await conn.execute(
            "DELETE FROM db_views WHERE id = $1 AND user_id = $2",
            view_id,
            user_id,
        )


# ---------------------------------------------------------------------------
# Milestone 12 (task-37): row templates. `services/db/templates.py` owns the
# actual queries and the clean-400-on-duplicate-default handling; these
# endpoints are thin HTTP seams over it, following this file's own
# conventions (`_parse_uuid_or_404`, an explicit data-source ownership
# check before `create_template`, `DuplicateDefaultTemplateError` mapped to
# a 400 the same way `_relation_error_to_http` maps `RelationError`).
# ---------------------------------------------------------------------------


def _template_error_to_http(exc: Exception) -> HTTPException:
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.post(
    "/data-sources/{data_source_id}/templates",
    response_model=RowTemplateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_template(
    data_source_id: str,
    body: RowTemplateCreate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RowTemplateResponse:
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot add templates to the built-in All Notes source",
        )

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    try:
        return await templates_service.create_template(conn, user_id, data_source_id, body)
    except (DuplicateDefaultTemplateError, TemplateConfigError) as exc:
        raise _template_error_to_http(exc) from exc


@router.get(
    "/data-sources/{data_source_id}/templates",
    response_model=list[RowTemplateResponse],
)
async def list_templates(
    data_source_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> list[RowTemplateResponse]:
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    return await templates_service.list_templates(conn, user_id, data_source_id)


@router.patch("/templates/{template_id}", response_model=RowTemplateResponse)
async def update_template(
    template_id: str,
    body: RowTemplateUpdate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RowTemplateResponse:
    template_id = _parse_uuid_or_404(template_id, "template")
    try:
        result = await templates_service.update_template(conn, user_id, template_id, body)
    except (DuplicateDefaultTemplateError, TemplateConfigError) as exc:
        raise _template_error_to_http(exc) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    return result


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> None:
    template_id = _parse_uuid_or_404(template_id, "template")
    deleted = await templates_service.delete_template(conn, user_id, template_id)
    if not deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")


@router.post(
    "/templates/{template_id}/instantiate",
    response_model=RowResponse,
    status_code=status.HTTP_201_CREATED,
)
async def instantiate_template(
    template_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RowResponse:
    """Applying a template at row-creation time only (task-37-brief.md's
    "Out of scope": no "apply this template to an existing row" endpoint —
    this app has no Notion-style erase_content/append distinction for
    that)."""
    template_id = _parse_uuid_or_404(template_id, "template")
    result = await templates_service.instantiate_template(conn, user_id, template_id)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    # Fix 6 (task-51, M14 final cross-cutting review): best-effort, non-fatal
    # property-preamble refresh -- see `services/indexer.py`'s `try_index_note`
    # docstring. This is a SEPARATE, standalone endpoint from `create_row`'s own
    # default-template branch above (already wired since task-50) -- explicitly
    # picking a non-default template from the real TableView template picker UI,
    # not the "+ New row" default path. Missed by task-50's own sweep; a row
    # created this way was permanently unsearchable by property value until
    # someone happened to edit its body.
    try_index_note(result.id, user_id)
    return result


# ---------------------------------------------------------------------------
# Milestone 12 (task-38): database automations. `services/db/automations.py` owns the
# actual queries, the action-chain executor and the every_frequency-exclusivity
# validation; these endpoints are thin HTTP seams over it, following this file's own
# conventions (`_parse_uuid_or_404`, an explicit data-source ownership check before
# `create_automation`, `AutomationConfigError` mapped to a 400 the same way
# `_template_error_to_http` maps templates.py's own config errors).
# ---------------------------------------------------------------------------


def _automation_error_to_http(exc: Exception) -> HTTPException:
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.post(
    "/data-sources/{data_source_id}/automations",
    response_model=AutomationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_automation(
    data_source_id: str,
    body: AutomationCreate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> AutomationResponse:
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot add automations to the built-in All Notes source",
        )

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    try:
        return await automations_service.create_automation(conn, user_id, data_source_id, body)
    except AutomationConfigError as exc:
        raise _automation_error_to_http(exc) from exc


@router.get(
    "/data-sources/{data_source_id}/automations",
    response_model=list[AutomationResponse],
)
async def list_automations(
    data_source_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> list[AutomationResponse]:
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    return await automations_service.list_automations(conn, user_id, data_source_id)


@router.patch("/automations/{automation_id}", response_model=AutomationResponse)
async def update_automation(
    automation_id: str,
    body: AutomationUpdate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> AutomationResponse:
    automation_id = _parse_uuid_or_404(automation_id, "automation")
    try:
        result = await automations_service.update_automation(conn, user_id, automation_id, body)
    except AutomationConfigError as exc:
        raise _automation_error_to_http(exc) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "automation not found")
    return result


@router.delete("/automations/{automation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_automation(
    automation_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> None:
    automation_id = _parse_uuid_or_404(automation_id, "automation")
    deleted = await automations_service.delete_automation(conn, user_id, automation_id)
    if not deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "automation not found")


# ---------------------------------------------------------------------------
# Milestone 12 (task-38): notifications -- the `send_notification` action's target
# (decision 9). Minimal on purpose (decision 11): list + mark-one-read, no
# bulk-mark-all-read.
# ---------------------------------------------------------------------------


@router.get("/notifications", response_model=list[NotificationResponse])
async def list_notifications(
    unread: bool = False,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> list[NotificationResponse]:
    return await notifications_service.list_notifications(conn, user_id, unread_only=unread)


@router.patch("/notifications/{notification_id}", response_model=NotificationResponse)
async def mark_notification_read(
    notification_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> NotificationResponse:
    notification_id = _parse_uuid_or_404(notification_id, "notification")
    result = await notifications_service.mark_read(conn, user_id, notification_id)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "notification not found")
    return result


# ---------------------------------------------------------------------------
# Milestone 12 (task-39): the two button click endpoints -- button PROPERTY and
# button BLOCK, decision 5. `services/db/buttons.py` owns `BUTTON_ACTIONS`/
# `BUTTON_BLOCK_ACTIONS`/`run_button_actions`; these handlers are thin HTTP seams:
# parse/404 path params, look up whatever this surface needs to build an
# `ActionContext`, call `run_button_actions`, map its typed exceptions to a 400 the
# same way `_automation_error_to_http` does for `AutomationConfigError` above. Neither
# endpoint uses task-38's `_execute_and_record_error`/SAVEPOINT/`last_error` machinery
# (decision 5: a button click is a single, synchronous, user-initiated request with
# no sibling actions in the same pass to protect) -- a real failure propagates as a
# clean 400 the normal way.
# ---------------------------------------------------------------------------


def _button_error_to_http(exc: Exception) -> HTTPException:
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.post(
    "/data-sources/{data_source_id}/rows/{note_id}/buttons/{property_key}/click",
    response_model=ButtonClickResponse,
)
async def click_button_property(
    data_source_id: str,
    note_id: str,
    property_key: str,
    body: ButtonClickRequest,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> ButtonClickResponse:
    """Decision 5: `trigger_data_source_id` is always real here -- a button property
    only exists on an actual data source, never on the All Notes virtual source (no
    `db_properties` row exists for it at all). `allowed = BUTTON_ACTIONS` (8 -- no
    `insert_blocks`: research §J.6.2/§25, a button PROPERTY has no "page" of its own
    to insert blocks into the way a button BLOCK's host note does).

    The row-ownership check below (`note_id` actually belongs to this data source and
    user) is not literally named by decision 5's own text but mirrors
    `update_row_property`'s identical check just above -- without it, a foreign/stale
    `note_id` would only surface once an action in the chain that happens to touch the
    row (e.g. `edit_property`) raised `services.db.rows.RowNotFoundError`, a type this
    endpoint doesn't otherwise map, which would 500 instead of 404. Flagged in
    task-39-report.md as a judgment call beyond decision 5's literal text.
    """
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "buttons are not supported on the All Notes virtual source",
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    note_id = _parse_uuid_or_404(note_id, "row")

    ds_row = await conn.fetchrow(
        """
        SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2
        """,
        data_source_id,
        user_id,
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    prop_row = await conn.fetchrow(
        """
        SELECT type, config FROM db_properties
        WHERE data_source_id = $1 AND user_id = $2 AND key = $3
        """,
        data_source_id,
        user_id,
        property_key,
    )
    if prop_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "property not found")
    if prop_row["type"] != "button":
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, f"property {property_key!r} is not a button"
        )

    row_exists = await conn.fetchrow(
        """
        SELECT note_id FROM db_row_props
        WHERE note_id = $1 AND data_source_id = $2 AND user_id = $3
        """,
        note_id,
        data_source_id,
        user_id,
    )
    if row_exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "row not found")

    actions = (prop_row["config"] or {}).get("actions") or []
    ctx = ActionContext(
        conn=conn,
        user_id=user_id,
        trigger_data_source_id=data_source_id,
        trigger_row_id=note_id,
        now=datetime.now(timezone.utc),
        source=f"button:{property_key}",
    )
    try:
        result = await buttons_service.run_button_actions(
            conn, ctx, actions, allowed=buttons_service.BUTTON_ACTIONS, confirmed=body.confirmed,
        )
    except ActionConfigError as exc:
        raise _button_error_to_http(exc) from exc

    return ButtonClickResponse(
        actions_run=result.actions_run,
        requires_confirmation=result.requires_confirmation,
        confirmation_message=result.confirmation_message,
        client_actions=result.client_actions,
    )


@router.post("/buttons/block-click", response_model=ButtonClickResponse)
async def click_button_block(
    body: ButtonBlockClickRequest,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> ButtonClickResponse:
    """Decision 5: a button BLOCK's action chain lives entirely in the block's own
    BlockNote props (decision 3) -- no server-side storage to look up, so `actions`
    travels in the request body directly. This is safe (not "client controls arbitrary
    server execution") because the acting user is always the same user who authored
    those actions into their own note's content in the first place -- the same trust
    boundary this whole app already operates under (decision 3's own text).

    `trigger_data_source_id` is resolved via decision 4's lookup
    (`buttons_service.resolve_trigger_data_source_id`) -- `None` when `note_id` isn't a
    database row at all. `allowed = BUTTON_BLOCK_ACTIONS` (9, includes
    `insert_blocks`).
    """
    note_id = _parse_uuid_or_404(body.note_id, "note")

    note_row = await conn.fetchrow(
        """
        SELECT id FROM notes WHERE id = $1 AND user_id = $2
        """,
        note_id,
        user_id,
    )
    if note_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "note not found")

    trigger_data_source_id = await buttons_service.resolve_trigger_data_source_id(
        conn, user_id, note_id
    )
    ctx = ActionContext(
        conn=conn,
        user_id=user_id,
        trigger_data_source_id=trigger_data_source_id,
        trigger_row_id=note_id,
        now=datetime.now(timezone.utc),
        source=f"button:block:{note_id}",
    )
    try:
        result = await buttons_service.run_button_actions(
            conn,
            ctx,
            body.actions,
            allowed=buttons_service.BUTTON_BLOCK_ACTIONS,
            confirmed=body.confirmed,
        )
    except ActionConfigError as exc:
        raise _button_error_to_http(exc) from exc

    return ButtonClickResponse(
        actions_run=result.actions_run,
        requires_confirmation=result.requires_confirmation,
        confirmation_message=result.confirmation_message,
        client_actions=result.client_actions,
    )


# ---------------------------------------------------------------------------
# Milestone 7 (task-21): relation, sub-item and dependency endpoints.
#
# `services/db/relations.py` (task-20) is the whole service layer; every
# endpoint below is a thin HTTP seam over it -- parse/404 path params,
# resolve a `RelationRef` from `db_properties.config`, call the one
# relations.py function that does the actual work, map its framework-free
# exceptions to a 400. None of these write `db_row_props.properties` for a
# relation key directly -- `db_relation_links`, via relations.py, is the
# only source of truth (migration 015's header).
# ---------------------------------------------------------------------------


def _relation_error_to_http(exc: RelationError) -> HTTPException:
    """Task 21's mapping seam for `services.db.relations`'s deliberately
    framework-free exceptions -- the same layering `query/compiler.py`'s
    `filter_validation_error_to_http` gives the filter compiler's
    `FilterValidationError`. One function handles all three rows of the
    brief's error table (`RelationCycleError`/`SubItemDepthError`/the base
    `RelationError`), not three branches: `RelationCycleError.__str__`
    already renders the cycle path (`"a -> b -> a"`) and
    `SubItemDepthError`'s message already embeds the depth and the cap
    (both classes, `services/db/relations.py`), so `str(exc)` alone
    satisfies "message includes the cycle path" / "message includes the
    depth and the cap" for every subtype -- Python's `except RelationError`
    at each call site below also catches both subclasses for free."""
    return HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


async def _get_relation_property(
    conn: asyncpg.Connection, user_id: str, data_source_id: str, property_key: str
) -> asyncpg.Record:
    """Fetches one property row by key, requiring `type = 'relation'` --
    404 if the key doesn't exist at all, 400 (not 404) if it exists but is
    some other type, the same "exists but wrong shape" -> 400 distinction
    `update_row_property` already makes for `storage != 'jsonb'`."""
    row = await conn.fetchrow(
        """
        SELECT * FROM db_properties
        WHERE data_source_id = $1 AND user_id = $2 AND key = $3
        """,
        data_source_id,
        user_id,
        property_key,
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "property not found")
    if row["type"] != "relation":
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "property is not a relation property")
    return row


async def _require_row(
    conn: asyncpg.Connection, user_id: str, data_source_id: str, note_id: str
) -> None:
    """404s unless `note_id` is an actual row (`db_row_props`) of
    `data_source_id` -- every relation-links endpoint below reads/writes
    `db_relation_links` keyed by bare note ids, which has no
    `data_source_id` column of its own (migration 015's header, note 4), so
    this is the one place that stops a caller reaching a relation through a
    note id that was never actually a row of *this* data source."""
    exists = await conn.fetchval(
        """
        SELECT 1 FROM db_row_props
        WHERE note_id = $1 AND data_source_id = $2 AND user_id = $3
        """,
        note_id,
        data_source_id,
        user_id,
    )
    if exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "row not found")


async def _require_relation_target_row(
    conn: asyncpg.Connection, user_id: str, target_data_source_id: str | None, row_id: str
) -> None:
    """M7 combined-review Important finding 1: `add_relation_link` and
    `set_relation_links` used to verify only that the *other*-side row was
    some `notes` row owned by this user and not trashed -- never that it
    belonged to the relation property's own declared
    `config.target_data_source_id`, and since that check queried `notes`
    directly, the other row didn't even need to be a database row at all.
    Reproduced live by the reviewer: a link from a Tasks row to a row in a
    third, unrelated data source returned 201.

    This is `_require_row` above, widened one step: `_require_row` proves
    `note_id` is a `db_row_props` member of `data_source_id` (the *primary*
    row, from the URL path); this proves `row_id` is a `db_row_props`
    member of `target_data_source_id` (the *other* row, from the request
    body) -- same query shape, same `deleted_at IS NULL` exclusion of
    trashed rows `_fetch_related_rows` already applies on the read path, so
    a trashed row is treated as "not found" here too rather than silently
    linkable. For a self-relation (sub-item/dependency, where
    `target_data_source_id == data_source_id`) this is exactly the same
    membership `_require_row` already proved for the primary row -- the
    self-relation case is not a special case here, it falls out of the
    predicate being the same shape with a different data_source_id.

    404 when `row_id` doesn't resolve to a live row anywhere for this user
    (the existing "unknown row" contract, unchanged) -- 400, not 404 or
    500, when it resolves to a live row but in the *wrong* data source,
    naming both ids so the mismatch is diagnosable from the response body
    alone."""
    if target_data_source_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "relation property has no configured target_data_source_id",
        )
    own_data_source = await conn.fetchval(
        """
        SELECT drp.data_source_id FROM db_row_props drp
        JOIN notes n ON n.id = drp.note_id
        WHERE drp.note_id = $1 AND drp.user_id = $2 AND n.deleted_at IS NULL
        """,
        row_id,
        user_id,
    )
    if own_data_source is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "row not found")
    if str(own_data_source) != str(target_data_source_id):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"row {row_id!r} belongs to data source {str(own_data_source)!r}, "
            f"not this relation's target data source {target_data_source_id!r}",
        )


async def _require_relation_target_rows(
    conn: asyncpg.Connection, user_id: str, target_data_source_id: str | None, row_ids: list[str]
) -> None:
    """Bulk form of `_require_relation_target_row` above, for
    `set_relation_links`'s whole-list replace -- one query instead of N.
    Same 404 ("doesn't exist/trashed") vs 400 ("exists, wrong data source")
    split, reported as a list so a caller sees every offending id at once
    rather than only the first."""
    if not row_ids:
        return
    if target_data_source_id is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "relation property has no configured target_data_source_id",
        )
    found = await conn.fetch(
        """
        SELECT drp.note_id AS id, drp.data_source_id FROM db_row_props drp
        JOIN notes n ON n.id = drp.note_id
        WHERE drp.note_id = ANY($1::uuid[]) AND drp.user_id = $2 AND n.deleted_at IS NULL
        """,
        row_ids,
        user_id,
    )
    found_map = {str(r["id"]): str(r["data_source_id"]) for r in found}
    missing = [i for i in row_ids if i not in found_map]
    if missing:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"row(s) not found: {missing}")
    mismatched = [i for i in row_ids if found_map[i] != str(target_data_source_id)]
    if mismatched:
        detail = ", ".join(f"{i!r} (belongs to {found_map[i]!r})" for i in mismatched)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"row(s) do not belong to this relation's target data source "
            f"{target_data_source_id!r}: {detail}",
        )


async def _fetch_related_rows(
    conn: asyncpg.Connection, user_id: str, row_ids: list[str]
) -> list[RelatedRow]:
    """`row_ids` (link order, from `services.db.relations.list_links`) ->
    `RelatedRow`s with real titles -- "a list of bare UUIDs is useless to a
    UI" (task-21-brief.md §1). Joins against `notes`, filtering
    `deleted_at IS NULL`: migration 015's header note 5 keeps a trashed
    row's links (restoring the row restores the relationship), but a
    trashed row must not appear as a *live* link, so it is silently
    dropped from the result here rather than surfaced with some
    placeholder title."""
    if not row_ids:
        return []
    records = await conn.fetch(
        """
        SELECT id, title FROM notes
        WHERE id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL
        """,
        row_ids,
        user_id,
    )
    titles = {str(r["id"]): r["title"] for r in records}
    return [RelatedRow(id=rid, title=titles[rid]) for rid in row_ids if rid in titles]


@router.post(
    "/data-sources/{data_source_id}/relations",
    response_model=RelationPairResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_relation(
    data_source_id: str,
    body: RelationCreate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RelationPairResponse:
    """An ordinary (non-system) relation pair -- `system` is never
    accepted from the client here; only `enable_sub_items`/
    `enable_dependencies` below ever pass one, which is what keeps
    migration 015's one-sub-item-pair/one-dependency-pair-per-data-source
    invariant meaningful (a client could otherwise mint an arbitrary
    number of "system" pairs through this endpoint)."""
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot add properties to the built-in All Notes source",
        )
    if body.target_data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot target the built-in All Notes source with a relation",
        )

    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2", data_source_id, user_id
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    target_data_source_id = _parse_uuid_or_404(body.target_data_source_id, "target data source")
    target_row = await conn.fetchrow(
        "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2",
        target_data_source_id,
        user_id,
    )
    if target_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "target data source not found")

    try:
        forward, reverse = await create_relation_pair(
            conn,
            user_id,
            data_source_id=data_source_id,
            name=body.name,
            target_data_source_id=target_data_source_id,
            two_way=body.two_way,
            reverse_name=body.reverse_name,
        )
    except RelationError as exc:
        raise _relation_error_to_http(exc) from exc
    return RelationPairResponse(
        forward=PropertyResponse(**forward),
        reverse=PropertyResponse(**reverse) if reverse is not None else None,
    )


@router.delete("/relations/{relation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_relation(
    relation_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> None:
    """Deletes both properties of the pair and sweeps every
    `db_relation_links` row for it (`services.db.relations.
    delete_relation_pair` -- migration 015's header note 4: there is no FK
    from `db_relation_links.relation_id` to `db_properties`, so this sweep
    is the app's own responsibility). No `data_source_id` in this path --
    All Notes never has a `db_properties` row to match, so it 404s here
    the same way any other nonexistent `relation_id` would, with no
    special case needed."""
    relation_id = _parse_uuid_or_404(relation_id, "relation")
    exists = await conn.fetchval(
        """
        SELECT 1 FROM db_properties
        WHERE user_id = $1 AND type = 'relation' AND config->>'relation_id' = $2
        LIMIT 1
        """,
        user_id,
        relation_id,
    )
    if exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "relation not found")
    await delete_relation_pair(conn, user_id, relation_id)


@router.get(
    "/data-sources/{data_source_id}/rows/{note_id}/relations/{property_key}",
    response_model=RelationLinksResponse,
)
async def get_relation_links(
    data_source_id: str,
    note_id: str,
    property_key: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RelationLinksResponse:
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "the All Notes source has no relation properties"
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    note_id = _parse_uuid_or_404(note_id, "row")

    prop_row = await _get_relation_property(conn, user_id, data_source_id, property_key)
    await _require_row(conn, user_id, data_source_id, note_id)
    ref = relation_ref_from_config(prop_row["config"])
    if ref is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "relation property is not configured")

    other_ids = await list_links(conn, user_id, ref, note_id)
    return RelationLinksResponse(rows=await _fetch_related_rows(conn, user_id, other_ids))


@router.put(
    "/data-sources/{data_source_id}/rows/{note_id}/relations/{property_key}",
    response_model=RelationLinksResponse,
)
async def set_relation_links(
    data_source_id: str,
    note_id: str,
    property_key: str,
    body: RelationLinksSet,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RelationLinksResponse:
    """Replaces the whole link list. Deliberately does NOT delegate to
    `services.db.relations.set_links` (its own bulk delete/insert) --
    `link_checked` is "the only function Task 21's endpoints call to
    create a link" (relations.py's own docstring for it), so a new edge
    added here goes through the same cycle/sub-item-depth guard as the
    single-link POST below, even for a bulk replace. The trade-off (a
    documented judgement call, see the task report): survivors of the
    replace keep their existing `position`; only the *added* ids are
    appended in the request's order, rather than the whole list being
    rewritten to exactly match the caller's order the way `set_links`
    itself would."""
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "the All Notes source has no relation properties"
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    note_id = _parse_uuid_or_404(note_id, "row")

    prop_row = await _get_relation_property(conn, user_id, data_source_id, property_key)
    await _require_row(conn, user_id, data_source_id, note_id)
    ref = relation_ref_from_config(prop_row["config"])
    if ref is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "relation property is not configured")
    system = prop_row["config"].get("system")

    new_ids = list(dict.fromkeys(_parse_uuid_or_404(i, "row") for i in body.row_ids))
    # M7 combined-review Important finding 1: this used to check only that
    # each id was *some* live `notes` row for this user -- not that it
    # belonged to this relation's own `target_data_source_id`, so a link
    # could point at a row in a completely unrelated data source (or one
    # that was never a database row at all). `_require_relation_target_rows`
    # closes that the same way `_require_row` above already validates the
    # primary row against `data_source_id` -- for a self-relation
    # (sub_item/dependency, `target_data_source_id == data_source_id`) this
    # is exactly the membership `_require_row` already proved, so nothing
    # new is rejected there.
    await _require_relation_target_rows(
        conn, user_id, prop_row["config"].get("target_data_source_id"), new_ids
    )

    existing_ids = await list_links(conn, user_id, ref, note_id)
    to_delete = set(existing_ids) - set(new_ids)
    to_add = [i for i in new_ids if i not in existing_ids]
    try:
        async with conn.transaction():
            for other_id in to_delete:
                await unlink(conn, user_id, ref, note_id, other_id)
            for other_id in to_add:
                await link_checked(conn, user_id, ref, note_id, other_id, system=system)
    except RelationError as exc:
        raise _relation_error_to_http(exc) from exc

    other_ids = await list_links(conn, user_id, ref, note_id)
    return RelationLinksResponse(rows=await _fetch_related_rows(conn, user_id, other_ids))


@router.post(
    "/data-sources/{data_source_id}/rows/{note_id}/relations/{property_key}/links",
    response_model=RelationLinksResponse,
    status_code=status.HTTP_201_CREATED,
)
async def add_relation_link(
    data_source_id: str,
    note_id: str,
    property_key: str,
    body: RelationLinkAdd,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RelationLinksResponse:
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "the All Notes source has no relation properties"
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    note_id = _parse_uuid_or_404(note_id, "row")
    other_id = _parse_uuid_or_404(body.row_id, "row")

    prop_row = await _get_relation_property(conn, user_id, data_source_id, property_key)
    await _require_row(conn, user_id, data_source_id, note_id)
    ref = relation_ref_from_config(prop_row["config"])
    if ref is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "relation property is not configured")

    # M7 combined-review Important finding 1: see the identical comment in
    # `set_relation_links` above -- this used to check only that `other_id`
    # was *some* live `notes` row for this user, not that it belonged to
    # this relation's own `target_data_source_id`.
    await _require_relation_target_row(
        conn, user_id, prop_row["config"].get("target_data_source_id"), other_id
    )

    try:
        await link_checked(
            conn, user_id, ref, note_id, other_id, system=prop_row["config"].get("system")
        )
    except RelationError as exc:
        raise _relation_error_to_http(exc) from exc

    other_ids = await list_links(conn, user_id, ref, note_id)
    return RelationLinksResponse(rows=await _fetch_related_rows(conn, user_id, other_ids))


@router.delete(
    "/data-sources/{data_source_id}/rows/{note_id}/relations/{property_key}/links/{other_id}",
    response_model=RelationLinksResponse,
)
async def remove_relation_link(
    data_source_id: str,
    note_id: str,
    property_key: str,
    other_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RelationLinksResponse:
    """Idempotent, like `services.db.relations.unlink` itself: removing a
    link that doesn't exist is not an error (204 isn't used here precisely
    so a client can see the resulting list without a follow-up GET, the
    same reasoning the POST-link endpoint above follows)."""
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "the All Notes source has no relation properties"
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    note_id = _parse_uuid_or_404(note_id, "row")
    other_id = _parse_uuid_or_404(other_id, "row")

    prop_row = await _get_relation_property(conn, user_id, data_source_id, property_key)
    await _require_row(conn, user_id, data_source_id, note_id)
    ref = relation_ref_from_config(prop_row["config"])
    if ref is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "relation property is not configured")

    await unlink(conn, user_id, ref, note_id, other_id)

    other_ids = await list_links(conn, user_id, ref, note_id)
    return RelationLinksResponse(rows=await _fetch_related_rows(conn, user_id, other_ids))


@router.post(
    "/data-sources/{data_source_id}/relations/{property_key}/links/bulk",
    response_model=RelationLinksBulkResponse,
)
async def get_relation_links_bulk(
    data_source_id: str,
    property_key: str,
    body: RelationLinksBulkRequest,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RelationLinksBulkResponse:
    """The N+1 killer, finally wired up (M7 combined-review Important
    finding 3): `services.db.relations.list_links_bulk` was built by task
    20 for exactly this, but task 21 never exposed it -- `TableView.tsx`'s
    sub-item tree pre-fetch and `useDatabaseView`'s relation-cache warming
    both ended up issuing one `GET .../relations/{property_key}` per
    visible row instead of one request for the whole page. This does not
    replace that per-row GET (`get_relation_links` above) -- `RelationCell`
    still uses it for a single cell's own lazy load; this is for "every
    row on the page, one round trip", the shape `list_links_bulk` and
    `TableView`'s sub-item tree both actually need.

    A POST, not a GET-with-body: matches this router's own precedent for a
    read that needs a request body (`query_rows`, task-15's `POST
    .../query`), and avoids the encoding awkwardness of putting a
    potentially-500-long id list on a query string.

    A `path` (not `body`) `property_key`, matching every other relation
    endpoint's URL shape -- only the *ids to ask about* are bulk, not the
    property being asked about, since one call site only ever needs one
    property's worth of links across many rows (`TableView`'s single
    sub-item column, `useDatabaseView`'s per-property cache warm)."""
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "the All Notes source has no relation properties"
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    if len(body.row_ids) > _BULK_RELATION_ROW_IDS_LIMIT:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"at most {_BULK_RELATION_ROW_IDS_LIMIT} row_ids per request, "
            f"got {len(body.row_ids)}",
        )
    row_ids = [_parse_uuid_or_404(i, "row") for i in body.row_ids]

    prop_row = await _get_relation_property(conn, user_id, data_source_id, property_key)
    ref = relation_ref_from_config(prop_row["config"])
    if ref is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "relation property is not configured")

    links = await list_links_bulk(conn, user_id, ref, row_ids)

    # One title lookup for every distinct linked id across the whole batch
    # (not one `_fetch_related_rows` call per owner row) -- that's the
    # entire point of this endpoint existing. Same `deleted_at IS NULL`
    # trashed-row exclusion `_fetch_related_rows` applies on the per-row
    # path, so a trashed row silently drops out of its owner's list here
    # too rather than surfacing with a placeholder title.
    all_other_ids = sorted({other_id for ids in links.values() for other_id in ids})
    title_records = await conn.fetch(
        "SELECT id, title FROM notes WHERE id = ANY($1::uuid[]) AND user_id = $2 AND deleted_at IS NULL",
        all_other_ids,
        user_id,
    )
    titles = {str(r["id"]): r["title"] for r in title_records}
    return RelationLinksBulkResponse(
        links={
            owner_id: [
                RelatedRow(id=other_id, title=titles[other_id])
                for other_id in other_ids
                if other_id in titles
            ]
            for owner_id, other_ids in links.items()
        }
    )


@router.post(
    "/data-sources/{data_source_id}/sub-items",
    response_model=RelationPairResponse,
    status_code=status.HTTP_201_CREATED,
)
async def enable_sub_items(
    data_source_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RelationPairResponse:
    """Sub-items are a self-relation wearing a label (migration 015's
    header; research §3.1) -- `create_relation_pair(system=SYSTEM_SUB_ITEM)`
    with `target_data_source_id == data_source_id`. Names are Notion's own
    documented ones (research §3.1): forward "Sub-item", reverse "Parent
    item". Enabling twice is a clean 400 ("already enabled"), driven by
    `create_relation_pair` catching migration 015's
    `db_properties_system_relation_uniq` violation and raising
    `RelationError` -- not a pre-check race (task-21-brief.md §1)."""
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot add properties to the built-in All Notes source",
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2", data_source_id, user_id
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    try:
        forward, reverse = await create_relation_pair(
            conn,
            user_id,
            data_source_id=data_source_id,
            name="Sub-item",
            target_data_source_id=data_source_id,
            two_way=True,
            reverse_name="Parent item",
            system=SYSTEM_SUB_ITEM,
        )
    except RelationError as exc:
        raise _relation_error_to_http(exc) from exc
    assert reverse is not None  # two_way=True always mints one
    return RelationPairResponse(
        forward=PropertyResponse(**forward), reverse=PropertyResponse(**reverse)
    )


@router.post(
    "/data-sources/{data_source_id}/dependencies",
    response_model=RelationPairResponse,
    status_code=status.HTTP_201_CREATED,
)
async def enable_dependencies(
    data_source_id: str,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> RelationPairResponse:
    """Dependencies are also a self-relation wearing a label (research
    §4.1), enabled the same way sub-items are, one data source, one pair.

    Property names: research §4.1 explicitly records that Notion's help
    centre never names the dependency properties in text -- **UNRESOLVED**
    in the research doc. "Blocking"/"Blocked by" is this task's own choice
    of the commonly-seen labels (task-21-brief.md §1 flags this exact
    gap and mandates the choice, not a discovery from the research doc).
    """
    if data_source_id == ALL_NOTES_ID:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "cannot add properties to the built-in All Notes source",
        )
    data_source_id = _parse_uuid_or_404(data_source_id, "data source")
    ds_row = await conn.fetchrow(
        "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2", data_source_id, user_id
    )
    if ds_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

    try:
        forward, reverse = await create_relation_pair(
            conn,
            user_id,
            data_source_id=data_source_id,
            name="Blocking",
            target_data_source_id=data_source_id,
            two_way=True,
            reverse_name="Blocked by",
            system=SYSTEM_DEPENDENCY,
        )
    except RelationError as exc:
        raise _relation_error_to_http(exc) from exc
    assert reverse is not None  # two_way=True always mints one
    return RelationPairResponse(
        forward=PropertyResponse(**forward), reverse=PropertyResponse(**reverse)
    )


@router.patch("/relations/{relation_id}/dependency-settings", response_model=PropertyResponse)
async def update_dependency_settings(
    relation_id: str,
    body: DependencySettingsUpdate,
    user_id: str = Depends(get_user_id),
    conn: asyncpg.Connection = Depends(get_conn),
) -> PropertyResponse:
    """Partial update of the forward dependency property's `config`
    (migration 015's header: "Dependency behaviour settings ... live in
    the *forward* dependency property's config"). Only fields present in
    the request are touched (`exclude_unset=True`, `ViewUpdate`'s own
    convention); an explicit `null` for a present field *clears* that
    setting rather than being a no-op, because every one of these three
    config keys is optional JSONB, not a NOT NULL column (unlike
    `ViewUpdate`'s five NOT NULL fields)."""
    relation_id = _parse_uuid_or_404(relation_id, "relation")
    prop_row = await conn.fetchrow(
        """
        SELECT * FROM db_properties
        WHERE user_id = $1 AND type = 'relation' AND config->>'relation_id' = $2
          AND config->>'side' = 'forward' AND config->>'system' = 'dependency'
        """,
        user_id,
        relation_id,
    )
    if prop_row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "dependency relation not found")

    updates = body.model_dump(exclude_unset=True)
    config = dict(prop_row["config"] or {})

    if "date_shift_mode" in updates:
        mode = updates["date_shift_mode"]
        if mode is not None and mode not in DATE_SHIFT_MODES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"date_shift_mode must be one of {DATE_SHIFT_MODES}, got: {mode!r}",
            )
        if mode is None:
            config.pop("date_shift_mode", None)
        else:
            config["date_shift_mode"] = mode

    if "avoid_weekends" in updates:
        if updates["avoid_weekends"] is None:
            config.pop("avoid_weekends", None)
        else:
            config["avoid_weekends"] = updates["avoid_weekends"]

    if "date_property_key" in updates:
        key = updates["date_property_key"]
        if key is None:
            config.pop("date_property_key", None)
        else:
            date_prop = await conn.fetchrow(
                """
                SELECT 1 FROM db_properties
                WHERE data_source_id = $1 AND user_id = $2 AND key = $3 AND type = 'date'
                """,
                prop_row["data_source_id"],
                user_id,
                key,
            )
            if date_prop is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    f"{key!r} is not a date property on this data source",
                )
            config["date_property_key"] = key

    row = await conn.fetchrow(
        "UPDATE db_properties SET config = $1 WHERE id = $2 AND user_id = $3 RETURNING *",
        config,
        prop_row["id"],
        user_id,
    )
    return PropertyResponse(**_row(row))
