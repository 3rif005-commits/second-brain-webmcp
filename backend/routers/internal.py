"""Internal router — used by the MCP server to access retrieval without a user JWT."""

import logging
from typing import Any

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

from core.config import settings
from models.database import QueryRequest
from routers.databases import get_database, list_databases, query_rows
from routers.ingest import get_user_id
from services.agent.brain_tools import coerce_property_write, require_uuid
from services.database import get_supabase
from services.db import rows as rows_service
from services.db.connection import get_pool
from services.db.relations import RelationError
from services.embedder import embed
from services.indexer import index_note, try_index_note
from services.retriever import retrieve

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal", tags=["internal"])


def _check_internal_key(x_internal_key: str):
    if x_internal_key != settings.internal_api_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid internal key")


class SearchRequest(BaseModel):
    query: str
    user_id: str
    top_k: int = 5


class NoteRequest(BaseModel):
    note_id: str
    user_id: str


class ReindexNoteRequest(BaseModel):
    note_id: str


@router.post("/search")
def internal_search(body: SearchRequest, x_internal_key: str = Header()):
    """Embed query and return top-K notes. Called by MCP server."""
    _check_internal_key(x_internal_key)
    try:
        query_embedding = embed(body.query)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Embedding failed: {e}")

    results = retrieve(query_embedding, body.user_id)
    return {"results": results[: body.top_k]}


@router.post("/note")
def internal_get_note(body: NoteRequest, x_internal_key: str = Header()):
    """Fetch a single note by ID. Called by MCP server."""
    _check_internal_key(x_internal_key)
    db = get_supabase()
    _res = (
        db.table("notes")
        .select("id, title, content_text, topics, mastery_status, source_type, created_at")
        .eq("id", body.note_id)
        .eq("user_id", body.user_id)
        .maybe_single()
        .execute()
    )
    if _res is None or not _res.data:
        raise HTTPException(status_code=404, detail="Note not found")
    return _res.data


@router.post("/notes")
def internal_list_notes(user_id: str, x_internal_key: str = Header()):
    """List all notes for a user. Called by MCP server."""
    _check_internal_key(x_internal_key)
    db = get_supabase()
    result = (
        db.table("notes")
        .select("id, title, topics, mastery_status, source_type, created_at, updated_at")
        .eq("user_id", user_id)
        .order("updated_at", desc=True)
        .limit(100)
        .execute()
    )
    return {"notes": result.data or []}


@router.post("/reindex-note")
def reindex_note(body: ReindexNoteRequest, authorization: str = Header()):
    """Re-chunk and re-describe a single note. Auth: user JWT."""
    user_id = get_user_id(authorization)
    success = index_note(body.note_id, user_id)
    if not success:
        raise HTTPException(status_code=404, detail="Note not found")
    return {"reindexed": 1}


@router.post("/reindex")
def reindex_all(authorization: str = Header()):
    """Re-chunk and re-describe all notes for the authenticated user."""
    user_id = get_user_id(authorization)

    db = get_supabase()
    notes_res = (
        db.table("notes")
        .select("id")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .execute()
    )
    note_ids = [r["id"] for r in (notes_res.data or [])]

    reindexed = 0
    failed = 0
    for nid in note_ids:
        try:
            if index_note(nid, user_id):
                reindexed += 1
            else:
                failed += 1
        except Exception:
            logger.exception("reindex failed for note %s", nid)
            failed += 1

    return {"reindexed": reindexed, "failed": failed}


# ---------------------------------------------------------------------------
# Database tools mirror (Milestone 14, task 49).
#
# The MCP stdio server (mcp_server.py) is a wholly separate process from the
# in-app agent engine (services/agent/engine.py + brain_tools.py) -- it has
# no user JWT and no asyncpg access of its own, only an x-internal-key and
# an explicit user_id in the body, the same trust model `internal_search`/
# `internal_get_note`/`internal_list_notes` above already establish. These
# 5 routes are its mirror of brain_tools.py's 5 database tools: same
# reuse-the-router-logic approach (acquire get_pool(), call
# list_databases/get_database/query_rows/create_row_core/
# update_row_property_core directly), same write-side coercion
# (`coerce_property_write`/`require_uuid`, imported from brain_tools.py
# rather than duplicated, so the two mirrors can't silently drift apart on
# what a valid write looks like).
#
# Unlike the 3 existing /internal/* routes above (plain `def`, JWT-based),
# these 5 are `async def` -- they genuinely need `await` for the pool
# acquire/queries the existing three never needed. FastAPI supports both on
# the same router.
# ---------------------------------------------------------------------------


class ListDatabasesRequest(BaseModel):
    user_id: str


class GetDatabaseSchemaRequest(BaseModel):
    database_id: str
    user_id: str


class QueryDatabaseRequest(BaseModel):
    data_source_id: str
    user_id: str
    filter: dict[str, Any] | None = None
    sorts: list[dict[str, Any]] = []
    page_size: int = 50
    offset: int = 0


class CreateRowRequest(BaseModel):
    data_source_id: str
    user_id: str
    properties: dict[str, Any] = {}


class UpdateRowRequest(BaseModel):
    data_source_id: str
    user_id: str
    note_id: str
    property_key: str
    value: Any = None


@router.post("/db/list_databases")
async def internal_list_databases(
    body: ListDatabasesRequest, x_internal_key: str = Header()
):
    """Mirrors brain.list_databases. Called by the MCP server."""
    _check_internal_key(x_internal_key)
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await list_databases(user_id=body.user_id, conn=conn)
    return result.model_dump(mode="json")


@router.post("/db/get_database_schema")
async def internal_get_database_schema(
    body: GetDatabaseSchemaRequest, x_internal_key: str = Header()
):
    """Mirrors brain.get_database_schema. Called by the MCP server.
    `get_database` raises its own HTTPException (404) for a malformed or
    not-owned database_id -- left to propagate as-is, same as any other
    FastAPI route."""
    _check_internal_key(x_internal_key)
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await get_database(body.database_id, user_id=body.user_id, conn=conn)
    return result.model_dump(mode="json")


@router.post("/db/query_database")
async def internal_query_database(
    body: QueryDatabaseRequest, x_internal_key: str = Header()
):
    """Mirrors brain.query_database -- the tool the spec's tenancy claim is
    about. `query_rows` is called directly, unmodified, so a filter naming
    a data_source_id/property key `body.user_id` doesn't own is rejected
    exactly the way the HTTP endpoint already rejects it (its own
    HTTPException propagates unchanged)."""
    _check_internal_key(x_internal_key)
    query_body = QueryRequest(
        filter=body.filter,
        sorts=body.sorts,
        page_size=body.page_size,
        offset=body.offset,
    )
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await query_rows(
            body.data_source_id, query_body, user_id=body.user_id, conn=conn
        )
    return result.model_dump(mode="json", exclude_none=True)


@router.post("/db/create_row")
async def internal_create_row(body: CreateRowRequest, x_internal_key: str = Header()):
    """Mirrors brain.create_row. Called by the MCP server."""
    _check_internal_key(x_internal_key)
    try:
        require_uuid(body.data_source_id, "data_source_id")
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    pool = await get_pool()
    async with pool.acquire() as conn:
        ds_row = await conn.fetchrow(
            "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2",
            body.data_source_id,
            body.user_id,
        )
        if ds_row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

        prop_rows = await conn.fetch(
            "SELECT key, type, config FROM db_properties "
            "WHERE data_source_id = $1 AND user_id = $2",
            body.data_source_id,
            body.user_id,
        )
        prop_by_key = {r["key"]: r for r in prop_rows}

        wrapped: dict[str, Any] = {}
        for key, raw_value in body.properties.items():
            prop_row = prop_by_key.get(key)
            if prop_row is None:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"unknown property key: {key!r}"
                )
            prop_type = prop_row["type"]
            try:
                coerced = coerce_property_write(prop_type, prop_row["config"], raw_value)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"property {key!r}: {exc}"
                ) from exc
            wrapped[key] = {"type": prop_type, prop_type: coerced}

        result = await rows_service.create_row_core(
            conn, body.user_id, body.data_source_id, properties=wrapped
        )
    # Fix 4.5 (task-50, M14 combined review): best-effort, non-fatal property-preamble
    # refresh -- see `services/indexer.py`'s `try_index_note` docstring.
    try_index_note(result.id, body.user_id)
    return result.model_dump(mode="json")


@router.post("/db/update_row")
async def internal_update_row(body: UpdateRowRequest, x_internal_key: str = Header()):
    """Mirrors brain.update_row -- same title-sync/date-shift-cascade/
    property_edited-automation behavior as a human editing this cell,
    since `update_row_property_core` is the same function the HTTP PATCH
    endpoint calls."""
    _check_internal_key(x_internal_key)
    try:
        require_uuid(body.data_source_id, "data_source_id")
        require_uuid(body.note_id, "note_id")
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    pool = await get_pool()
    async with pool.acquire() as conn:
        ds_row = await conn.fetchrow(
            "SELECT id FROM db_data_sources WHERE id = $1 AND user_id = $2",
            body.data_source_id,
            body.user_id,
        )
        if ds_row is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "data source not found")

        prop_row = await conn.fetchrow(
            "SELECT type, config FROM db_properties "
            "WHERE data_source_id = $1 AND user_id = $2 AND key = $3",
            body.data_source_id,
            body.user_id,
            body.property_key,
        )
        if prop_row is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST, f"unknown property key: {body.property_key!r}"
            )

        if body.value is None:
            wrapped_value = None
        else:
            try:
                coerced = coerce_property_write(prop_row["type"], prop_row["config"], body.value)
            except ValueError as exc:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"property {body.property_key!r}: {exc}"
                ) from exc
            wrapped_value = {"type": prop_row["type"], prop_row["type"]: coerced}

        try:
            result = await rows_service.update_row_property_core(
                conn, body.user_id, body.data_source_id, body.note_id,
                body.property_key, wrapped_value,
            )
        except rows_service.PropertyNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "property not found") from exc
        except rows_service.RowNotFoundError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "row not found") from exc
        except RelationError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
        except rows_service.RowPropertyValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    # Fix 4.5 (task-50, M14 combined review): best-effort, non-fatal property-preamble
    # refresh -- see `services/indexer.py`'s `try_index_note` docstring.
    try_index_note(result.id, body.user_id)
    return result.model_dump(mode="json")
