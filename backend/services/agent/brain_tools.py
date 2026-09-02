"""Brain tool definitions + dispatch.

Each tool has:
  - a JSON schema (for LLM tool-use)
  - an implementation (Python callable)

The Agent Engine calls execute_brain_tool() to dispatch by name.
Write tools (create/update/etc.) live alongside the read tools below.
"""
from __future__ import annotations

import uuid
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError

from models.database import QueryRequest
from services.database import get_supabase
from services.db import rows as rows_service
from services.db.connection import get_pool
from services.db.properties.base import REGISTRY
from services.db.properties.choice import SelectOption, StatusOption
from services.db.relations import RelationError
from services.embedder import embed
from services.indexer import try_index_note
from services.retriever import retrieve


# --- Tool schemas (advertised to the LLM as tool-use definitions) ---

BRAIN_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "brain.search_brain",
        "description": "Semantic search across the user's notes. Returns up to "
                       "6 best matching chunks with deep links.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural-language query"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 12, "default": 6},
            },
            "required": ["query"],
        },
    },
    {
        "name": "brain.get_note",
        "description": "Fetch a single note's full content by ID. Returns title, "
                       "blocks, content_text, mastery, topics, local_only.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string"}},
            "required": ["id"],
        },
    },
    {
        "name": "brain.list_notes",
        "description": "List the user's notes, optionally filtered by collection "
                       "or mastery status. Excludes notes in trash. Use to browse.",
        "input_schema": {
            "type": "object",
            "properties": {
                "collection_id": {"type": "string"},
                "mastery": {
                    "type": "string",
                    "enum": ["not_started", "learning", "reviewing", "mastered"],
                },
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
            },
        },
    },
    {
        "name": "brain.get_backlinks",
        "description": "Return notes that reference a given note via @-mentions.",
        "input_schema": {
            "type": "object",
            "properties": {"note_id": {"type": "string"}},
            "required": ["note_id"],
        },
    },
    {
        "name": "brain.create_note",
        "description": "Create a new note. Returns the new note ID. "
                       "Use when the user asks to make a note about something.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "blocks": {"type": "array", "items": {"type": "object"}},
                "collection_id": {"type": "string"},
                "topics": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["title", "blocks"],
        },
    },
    {
        "name": "brain.update_note",
        "description": "Replace the entire content of an existing note. "
                       "Prefer brain.patch_note for partial changes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "blocks": {"type": "array", "items": {"type": "object"}},
                "title": {"type": "string"},
            },
            "required": ["id", "blocks"],
        },
    },
    {
        "name": "brain.set_mastery",
        "description": "Update a note's mastery status.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "status": {
                    "type": "string",
                    "enum": ["not_started", "learning", "reviewing", "mastered"],
                },
            },
            "required": ["id", "status"],
        },
    },
    {
        "name": "brain.move_note",
        "description": "Move a note to a different collection.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "collection_id": {"type": "string"},
            },
            "required": ["id", "collection_id"],
        },
    },
    {
        "name": "brain.link_notes",
        "description": "Create a typed link between two notes "
                       "(prereq / related / backlink).",
        "input_schema": {
            "type": "object",
            "properties": {
                "from_id": {"type": "string"},
                "to_id": {"type": "string"},
                "type": {"type": "string",
                         "enum": ["prereq", "related", "backlink"]},
            },
            "required": ["from_id", "to_id", "type"],
        },
    },
    {
        "name": "brain.delete_note",
        "description": "Soft-delete a note (moves to trash). Requires "
                       "confirm=true to execute.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "confirm": {"type": "boolean"},
            },
            "required": ["id", "confirm"],
        },
    },
    # --- Database tools (Milestone 14, task 49) --- these reuse
    # routers/databases.py's own handlers / services/db/rows.py's *_core
    # functions directly (see the implementations below) rather than
    # re-deriving SQL, so the agent inherits the same filter/sort compiler
    # and tenancy scoping the UI gets.
    {
        "name": "brain.list_databases",
        "description": "List every database (Notion-style table) the user "
                       "owns, each with its default data source id. Use to "
                       "discover which databases exist before querying or "
                       "writing rows.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "brain.get_database_schema",
        "description": "Fetch a database's data source, properties, and "
                       "views by database id. Use before "
                       "brain.query_database/brain.create_row/"
                       "brain.update_row to learn the data source id and "
                       "each property's key/type (and, for select/status, "
                       "its valid option ids).",
        "input_schema": {
            "type": "object",
            "properties": {"database_id": {"type": "string"}},
            "required": ["database_id"],
        },
    },
    {
        "name": "brain.query_database",
        "description": "Query a data source's rows with an optional "
                       "filter/sort. `filter`/`sorts` are the same filter-"
                       "AST shapes the UI sends -- a condition is "
                       '{"type":"condition","property":<key>,"operator":'
                       '<op>,"value":...}, a group is {"type":"group",'
                       '"op":"and"|"or","children":[...]}. Runs through the '
                       "same compiler as the UI, so it only ever returns "
                       "rows the caller owns.",
        "input_schema": {
            "type": "object",
            "properties": {
                "data_source_id": {"type": "string"},
                "filter": {"type": "object"},
                "sorts": {"type": "array", "items": {"type": "object"}},
                "page_size": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
            },
            "required": ["data_source_id"],
        },
    },
    {
        "name": "brain.create_row",
        "description": "Create a new row on a data source. `properties` is "
                       "a flat {property_key: raw_value} map (e.g. "
                       '{"XJnFZop1": "My title", "abc123": 42}) -- never '
                       "the internal wrapper shape. Look up property keys/"
                       "types with brain.get_database_schema first. Rejects "
                       "unknown keys and read-only/computed property types "
                       "(relation, formula, rollup, button, created_time/"
                       "created_by, last_edited_time/last_edited_by, "
                       "unique_id).",
        "input_schema": {
            "type": "object",
            "properties": {
                "data_source_id": {"type": "string"},
                "properties": {"type": "object"},
            },
            "required": ["data_source_id"],
        },
    },
    {
        "name": "brain.update_row",
        "description": "Update a single property's value on an existing "
                       "row (a row is a note; note_id is the row's id, "
                       "e.g. from brain.query_database). `value` is the raw "
                       "value (not the internal wrapper), or null to clear "
                       "the property. Triggers the same title-sync/"
                       "automation behavior as a human editing that cell.",
        "input_schema": {
            "type": "object",
            "properties": {
                "data_source_id": {"type": "string"},
                "note_id": {"type": "string"},
                "property_key": {"type": "string"},
                "value": {},
            },
            "required": ["data_source_id", "note_id", "property_key"],
        },
    },
]


async def execute_brain_tool(
    tool: str,
    args: dict[str, Any],
    user_id: str,
) -> dict[str, Any]:
    """Dispatch a brain.* tool call. Raises ValueError for unknown tools.

    `async def` since Milestone 14 (task 49): the 5 database tools below
    live entirely behind asyncpg (`services/db/connection.get_pool()`),
    unlike the 10 read/write-note tools above, which stay on the
    synchronous `get_supabase()` client and need no `await` at all --
    calling a plain sync function from inside an `async def` runs it
    exactly as before. `engine.py`'s two call sites (the only callers of
    this function -- confirmed by grep, see task-49-report.md) now `await`
    this call accordingly.
    """
    if tool == "brain.search_brain":
        return _search_brain(args, user_id)
    if tool == "brain.get_note":
        return _get_note(args, user_id)
    if tool == "brain.list_notes":
        return _list_notes(args, user_id)
    if tool == "brain.get_backlinks":
        return _get_backlinks(args, user_id)
    if tool == "brain.create_note":
        return _create_note(args, user_id)
    if tool == "brain.update_note":
        return _update_note(args, user_id)
    if tool == "brain.set_mastery":
        return _set_mastery(args, user_id)
    if tool == "brain.move_note":
        return _move_note(args, user_id)
    if tool == "brain.link_notes":
        return _link_notes(args, user_id)
    if tool == "brain.delete_note":
        return _delete_note(args, user_id)
    if tool == "brain.list_databases":
        return await _list_databases(args, user_id)
    if tool == "brain.get_database_schema":
        return await _get_database_schema(args, user_id)
    if tool == "brain.query_database":
        return await _query_database(args, user_id)
    if tool == "brain.create_row":
        return await _create_row(args, user_id)
    if tool == "brain.update_row":
        return await _update_row(args, user_id)
    raise ValueError(f"Unknown brain tool: {tool}")


def _search_brain(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    query = args["query"]
    embedding = embed(query)
    matches = retrieve(embedding, user_id)
    return {"matches": matches[: args.get("limit", 6)]}


def _get_note(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    row = (
        get_supabase()
        .table("notes")
        .select("id, title, content, content_text, topics, mastery_status, local_only")
        .eq("id", args["id"])
        .eq("user_id", user_id)
        .single()
        .execute()
        .data
    )
    return row or {}


def _list_notes(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    q = (
        get_supabase()
        .table("notes")
        .select("id, title, icon, mastery_status, updated_at")
        .eq("user_id", user_id)
    )
    if args.get("collection_id"):
        q = q.eq("collection_id", args["collection_id"])
    if args.get("mastery"):
        q = q.eq("mastery_status", args["mastery"])
    rows = q.limit(args.get("limit", 20)).order("updated_at", desc=True).execute().data or []
    return {"notes": rows}


def _get_backlinks(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    # @-mention backlinks are stored in note content JSONB as inline content
    # blocks of type "mention" with props.noteId. We do a text-level search
    # over content_text for the deep link pattern as a fast approximation
    # (RPC-backed precise version comes in Phase 2 when editor tools land).
    target = args["note_id"]
    rows = (
        get_supabase()
        .table("notes")
        .select("id, title")
        .eq("user_id", user_id)
        .ilike("content_text", f"%/brain/{target}%")
        .limit(20)
        .execute()
        .data
        or []
    )
    return {"backlinks": rows}


def _create_note(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    payload = {
        "user_id": user_id,
        "title": args["title"],
        "content": args["blocks"],
        "topics": args.get("topics", []),
    }
    if args.get("collection_id"):
        payload["collection_id"] = args["collection_id"]
    rows = get_supabase().table("notes").insert(payload).execute().data or []
    return rows[0] if rows else {}


def _update_note(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    update: dict[str, Any] = {"content": args["blocks"]}
    if "title" in args:
        update["title"] = args["title"]
    rows = (
        get_supabase()
        .table("notes")
        .update(update)
        .eq("id", args["id"])
        .eq("user_id", user_id)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else {}


def _set_mastery(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    rows = (
        get_supabase()
        .table("notes")
        .update({"mastery_status": args["status"]})
        .eq("id", args["id"])
        .eq("user_id", user_id)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else {}


def _move_note(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    rows = (
        get_supabase()
        .table("notes")
        .update({"collection_id": args["collection_id"]})
        .eq("id", args["id"])
        .eq("user_id", user_id)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else {}


def _link_notes(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    # Phase 1: implement via a typed note_links table that ships with
    # migration 009. The table is asserted to exist by the migration.
    payload = {
        "user_id": user_id,
        "from_note_id": args["from_id"],
        "to_note_id": args["to_id"],
        "link_type": args["type"],
    }
    rows = (
        get_supabase()
        .table("note_links")
        .insert(payload)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else {}


def _delete_note(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    from datetime import datetime, timezone
    rows = (
        get_supabase()
        .table("notes")
        .update({"deleted_at": datetime.now(timezone.utc).isoformat()})
        .eq("id", args["id"])
        .eq("user_id", user_id)
        .execute()
        .data
        or []
    )
    return rows[0] if rows else {}


# ---------------------------------------------------------------------------
# Database tools (Milestone 14, task 49).
#
# Every tool below reuses the exact router/service-layer logic
# routers/databases.py's own HTTP endpoints call -- `list_databases`,
# `get_database`, `query_rows` (imported lazily, below, to avoid a needless
# module-load-time cost for callers that never touch the 5 database tools;
# there is no import cycle either way -- routers/databases.py imports
# nothing from services.agent), and `services/db/rows.py`'s
# `create_row_core`/`update_row_property_core` -- never a second,
# hand-rolled SQL path. This means the agent inherits the same tenancy
# scoping, filter/sort compiler, and write-side coercion the UI gets: the
# LLM never sees SQL (spec §12 Q10).
#
# Each tool acquires its own connection from the shared pool
# (`services/db/connection.get_pool()`), mirroring `get_conn()`'s own body
# (`services/db/connection.py:99-108`) exactly -- there is no FastAPI
# request here to hang a `Depends(get_conn)` off of.
#
# `coerce_property_write`/`require_uuid` are exported (no leading
# underscore) rather than kept private: `routers/internal.py`'s MCP mirror
# needs the identical write-side coercion/format-guard logic (see that
# router's own new /internal/db/* routes) and importing these two here
# avoids a second, drifting copy of that logic -- a deliberate, narrow
# exception to "don't reach into another module's underscore-prefixed
# helpers" (services/db/rows.py's own docstring states that convention),
# made by naming these two specific helpers public instead of reaching into
# private ones.


def require_uuid(value: str, what: str) -> None:
    """Same format guard as `routers/databases.py`'s `_parse_uuid_or_404`,
    but raising `ValueError` -- this layer has no HTTP response to 404
    with. Without this, a malformed id reaches asyncpg raw and surfaces as
    a confusing `DataError` instead of a clear tool-level error."""
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        raise ValueError(f"{what} must be a UUID, got: {value!r}") from None


# Property types whose `coerce_write` is a bare `_GenericProperty`
# pass-through (never rejects anything) despite being read-only in
# practice: `created_by`/`last_edited_by` have no dedicated descriptor
# (`properties/base.py`'s `_RICH_OVERRIDES` doesn't cover them) unlike
# `created_time`/`last_edited_time`, `unique_id`, `relation`, `formula`,
# `rollup`, and `button`, which already raise from inside their own
# `coerce_write` (confirmed by reading each module: scalar.py, temporal.py,
# relation.py, computed.py, button.py). These two need an explicit reject
# here; every other type falls through to `REGISTRY[type].coerce_write`'s
# own guard.
_EXPLICIT_READ_ONLY_TYPES = {"created_by", "last_edited_by"}

# Fix round (task-50, M14 combined review Critical finding): 10 of the 24
# real property types have no dedicated descriptor in `_RICH_OVERRIDES`
# (properties/base.py) and are not in `_EXPLICIT_READ_ONLY_TYPES` above, so
# they fall through to `_GenericProperty.coerce_write`, which is a bare
# `return raw` -- no validation at all. Two concrete, reproduced failure
# modes this closes: (1) `checkbox` accepting e.g. `"maybe"`, stored as
# `{"type": "checkbox", "checkbox": "maybe"}`, then 500ing the FIRST query
# that filters/sorts on it (`properties/base.py`'s `_VALUE_SHAPES` does an
# unguarded `->> 'checkbox' ::boolean` cast -- see that module's own
# comment on the tradeoff); (2) a non-str `title` (e.g. `12345`) reaching
# `create_row_core`/`update_row_property_core` and crashing with
# `asyncpg.exceptions.DataError` when bound to a `text` column, unhandled
# by `/internal/db/create_row`/`update_row` (routers/internal.py has no
# catch-all the way `engine.py`'s agent loop does).
#
# `None` is deliberately exempt from every check below -- it is the
# universal "no-op/absent value" case every rich descriptor's own
# `coerce_write(None)` already honours (see e.g. `scalar.py`'s `Number`/
# `UniqueId`), and `_create_row` (below) calls `coerce_property_write` even
# for a key whose value is explicitly `None`, so preserving that pass-
# through here (rather than rejecting it) keeps existing create-with-null
# behavior unchanged -- only a real, non-None, wrong-shaped value is new
# territory.
_CHECKBOX_TYPE = "checkbox"
_STR_TYPES = {"title", "rich_text", "url", "email", "phone_number"}
_LIST_TYPES = {"people", "files"}
_DICT_TYPES = {"place", "verification"}


def _check_generic_property_shape(prop_type: str, raw: Any) -> None:
    """Real type-checks for the 10 types named above. Checked BEFORE
    dispatch to `REGISTRY[type].coerce_write` so a bad shape never reaches
    `_GenericProperty`'s no-op pass-through, regardless of which caller
    (`_create_row`, `_update_row`, or the `/internal/db/*` mirror in
    `routers/internal.py`, which all funnel through `coerce_property_write`)
    is asking."""
    if raw is None:
        return
    if prop_type == _CHECKBOX_TYPE:
        # `isinstance(True, int)` is `True` in Python -- bool must be
        # checked as its own case, not folded into an int-exclusion check
        # meant for something else. There is no int-exclusion check here
        # (people/files check `list`, not `int`), but the explicit
        # `isinstance(raw, bool)` (not e.g. `type(raw) is bool`) is still
        # the correct, first check for this type on its own terms.
        if not isinstance(raw, bool):
            raise ValueError(
                f"checkbox value must be a bool, got: {type(raw).__name__}"
            )
    elif prop_type in _STR_TYPES:
        if not isinstance(raw, str):
            raise ValueError(
                f"{prop_type} value must be a string, got: {type(raw).__name__}"
            )
    elif prop_type in _LIST_TYPES:
        if not isinstance(raw, list):
            raise ValueError(
                f"{prop_type} value must be a list, got: {type(raw).__name__}"
            )
    elif prop_type in _DICT_TYPES:
        if not isinstance(raw, dict):
            raise ValueError(
                f"{prop_type} value must be an object, got: {type(raw).__name__}"
            )


def coerce_property_write(prop_type: str, config: dict[str, Any] | None, raw: Any) -> Any:
    """`raw` (a flat, unwrapped value an LLM would naturally emit, e.g. `42`
    or `"My title"`) -> `REGISTRY[prop_type].coerce_write`'s validated/
    normalised value, ready to be wrapped as the spec §3.3
    `{"type": prop_type, prop_type: <this return value>}` shape (every
    `_VALUE_SHAPES` entry in `properties/base.py` extracts under a JSONB key
    matching the property's own type name, `date` included, so this wrapper
    shape is uniform across all 24 types).

    Raises `ValueError` for an unknown property type, one of
    `_EXPLICIT_READ_ONLY_TYPES` above, or any value `coerce_write` itself
    rejects (e.g. a bool where a number is expected, an unknown select
    option id, a malformed date) -- always a clear tool-level error, never
    a 500.
    """
    if prop_type in _EXPLICIT_READ_ONLY_TYPES:
        raise ValueError(f"{prop_type} is read-only and cannot be written directly")
    prop_impl = REGISTRY.get(prop_type)
    if prop_impl is None:
        raise ValueError(f"unknown property type: {prop_type!r}")
    _check_generic_property_shape(prop_type, raw)
    config = config or {}
    if prop_type == "select":
        options = tuple(SelectOption(**o) for o in config.get("options", []))
        return prop_impl.coerce_write(raw, options=options)
    if prop_type == "multi_select":
        options = tuple(SelectOption(**o) for o in config.get("options", []))
        return prop_impl.coerce_write(raw, options=options)
    if prop_type == "status":
        options = tuple(StatusOption(**o) for o in config.get("options", []))
        return prop_impl.coerce_write(raw, options=options)
    return prop_impl.coerce_write(raw)


async def _list_databases(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    from routers.databases import list_databases as _endpoint

    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await _endpoint(user_id=user_id, conn=conn)
    # mode="json" -- not the bare dataclass-ish .model_dump() -- so
    # `created_at`/`updated_at` (real `datetime` objects on these response
    # models) come out as ISO-8601 strings: routers/agent.py's SSE stream
    # does a plain `json.dumps(ev)` with no `default=str`, and a raw
    # `datetime` in this dict would raise TypeError and crash the stream.
    return result.model_dump(mode="json")


async def _get_database_schema(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    from routers.databases import get_database as _endpoint

    database_id = args["database_id"]
    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            result = await _endpoint(database_id, user_id=user_id, conn=conn)
        except HTTPException as exc:
            # get_database raises HTTPException (404) directly for both a
            # malformed id and a real-but-not-owned one -- there is no HTTP
            # response at this layer to re-raise it as, so it becomes a
            # plain ValueError (execute_brain_tool's own convention, see
            # its "Unknown brain tool" raise above).
            raise ValueError(str(exc.detail)) from exc
    return result.model_dump(mode="json")


async def _query_database(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    """The tool the spec's tenancy claim is about (§12 Q10: "brain.
    query_database runs through the same compiler as the UI, so the agent
    inherits the tenancy scope... automatically"). `query_rows` is called
    directly, unmodified, with a real `QueryRequest` built from the LLM's
    raw filter/sorts -- the exact same reuse-not-reimplement approach task
    48 uses for CSV export. A filter naming a `data_source_id`/property key
    the caller doesn't own is rejected exactly the way the HTTP endpoint
    already rejects it (a 404/400 HTTPException from inside `query_rows`,
    converted to a ValueError below), because it IS that endpoint's
    function body running -- there is no second code path here that could
    reach a different conclusion.
    """
    from routers.databases import query_rows as _endpoint

    data_source_id = args["data_source_id"]
    try:
        body = QueryRequest(
            filter=args.get("filter"),
            sorts=args.get("sorts") or [],
            page_size=args.get("page_size", 50),
            offset=args.get("offset", 0),
        )
    except ValidationError as exc:
        raise ValueError(str(exc)) from exc

    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            result = await _endpoint(data_source_id, body, user_id=user_id, conn=conn)
        except HTTPException as exc:
            # Covers both a not-found/not-owned data source (404) and a
            # filter the compiler rejects -- unknown property key, bad
            # operator/value shape, over-deep nesting (400, from
            # ast.FilterValidationError/pydantic ValidationError, already
            # caught and converted to HTTPException inside query_rows
            # itself).
            raise ValueError(str(exc.detail)) from exc
    return result.model_dump(mode="json", exclude_none=True)


async def _create_row(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    data_source_id = args["data_source_id"]
    raw_properties = args.get("properties") or {}
    require_uuid(data_source_id, "data_source_id")

    pool = await get_pool()
    async with pool.acquire() as conn:
        ds_row = await conn.fetchrow(
            "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2",
            data_source_id,
            user_id,
        )
        if ds_row is None:
            raise ValueError(f"data source not found: {data_source_id!r}")

        prop_rows = await conn.fetch(
            "SELECT key, type, config FROM db_properties "
            "WHERE data_source_id = $1 AND user_id = $2",
            data_source_id,
            user_id,
        )
        prop_by_key = {r["key"]: r for r in prop_rows}

        wrapped: dict[str, Any] = {}
        for key, raw_value in raw_properties.items():
            prop_row = prop_by_key.get(key)
            if prop_row is None:
                raise ValueError(f"unknown property key: {key!r}")
            prop_type = prop_row["type"]
            try:
                coerced = coerce_property_write(prop_type, prop_row["config"], raw_value)
            except ValueError as exc:
                raise ValueError(f"property {key!r}: {exc}") from exc
            wrapped[key] = {"type": prop_type, prop_type: coerced}

        result = await rows_service.create_row_core(
            conn, user_id, data_source_id, properties=wrapped
        )
    # Fix 4.3 (task-50, M14 combined review): best-effort, non-fatal property-preamble
    # refresh -- see `services/indexer.py`'s `try_index_note` docstring.
    try_index_note(result.id, user_id)
    return result.model_dump(mode="json")


async def _update_row(args: dict[str, Any], user_id: str) -> dict[str, Any]:
    data_source_id = args["data_source_id"]
    note_id = args["note_id"]
    property_key = args["property_key"]
    raw_value = args.get("value")
    require_uuid(data_source_id, "data_source_id")
    require_uuid(note_id, "note_id")

    pool = await get_pool()
    async with pool.acquire() as conn:
        ds_row = await conn.fetchrow(
            "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2",
            data_source_id,
            user_id,
        )
        if ds_row is None:
            raise ValueError(f"data source not found: {data_source_id!r}")

        prop_row = await conn.fetchrow(
            "SELECT type, config FROM db_properties "
            "WHERE data_source_id = $1 AND user_id = $2 AND key = $3",
            data_source_id,
            user_id,
            property_key,
        )
        if prop_row is None:
            raise ValueError(f"unknown property key: {property_key!r}")

        if raw_value is None:
            # Top-level null means "clear/unset this property" (spec §3.3),
            # the same convention `RowPropertyUpdate.value` documents --
            # never coerced, passed straight through to
            # update_row_property_core's own clear-property branch.
            wrapped_value = None
        else:
            try:
                coerced = coerce_property_write(prop_row["type"], prop_row["config"], raw_value)
            except ValueError as exc:
                raise ValueError(f"property {property_key!r}: {exc}") from exc
            wrapped_value = {"type": prop_row["type"], prop_row["type"]: coerced}

        try:
            result = await rows_service.update_row_property_core(
                conn, user_id, data_source_id, note_id, property_key, wrapped_value
            )
        except (
            rows_service.PropertyNotFoundError,
            rows_service.RowNotFoundError,
            rows_service.RowPropertyValueError,
            RelationError,
        ) as exc:
            raise ValueError(str(exc)) from exc
    # Fix 4.4 (task-50, M14 combined review): best-effort, non-fatal property-preamble
    # refresh -- see `services/indexer.py`'s `try_index_note` docstring.
    try_index_note(result.id, user_id)
    return result.model_dump(mode="json")
