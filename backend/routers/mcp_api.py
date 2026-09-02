"""GET/POST/PATCH/DELETE /mcp-servers — user-facing CRUD for MCP server configurations.

Also: GET /mcp-servers/{server_id}/tools — live tool discovery for the settings UI.
      GET /mcp-audit-log — recent audit log entries.
"""
from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from routers.ingest import get_user_id
from services.agent.mcp_client import McpServerConfig, discover_tools
from services.database import get_supabase

router = APIRouter(tags=["mcp"])


class ServerPayload(BaseModel):
    name: str
    transport: str
    command: str | None = None
    url: str | None = None
    trust_level: str = "read_only"


@router.get("/mcp-servers")
def list_servers(authorization: str = Header()):
    user_id = get_user_id(authorization)
    rows = (
        get_supabase()
        .table("mcp_servers")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at")
        .execute()
        .data
        or []
    )
    return {"servers": rows}


@router.post("/mcp-servers", status_code=201)
def add_server(payload: ServerPayload, authorization: str = Header()):
    user_id = get_user_id(authorization)
    try:
        McpServerConfig(
            name=payload.name,
            transport=payload.transport,
            command=payload.command,
            url=payload.url,
            enabled=True,
            trust_level=payload.trust_level,
        )
    except ValueError as e:
        raise HTTPException(400, detail=str(e))

    row = (
        get_supabase()
        .table("mcp_servers")
        .insert({
            "user_id": user_id,
            "name": payload.name,
            "transport": payload.transport,
            "command": payload.command,
            "url": payload.url,
            "trust_level": payload.trust_level,
        })
        .execute()
        .data[0]
    )
    return row


@router.patch("/mcp-servers/{server_id}")
def toggle_server(server_id: str, body: dict, authorization: str = Header()):
    user_id = get_user_id(authorization)
    allowed_keys = {"enabled", "trust_level"}
    update = {k: v for k, v in body.items() if k in allowed_keys}
    if not update:
        raise HTTPException(400, detail="Nothing to update")
    rows = (
        get_supabase()
        .table("mcp_servers")
        .update(update)
        .eq("id", server_id)
        .eq("user_id", user_id)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(404, detail="Server not found")
    return rows[0]


@router.delete("/mcp-servers/{server_id}", status_code=204)
def delete_server(server_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    get_supabase().table("mcp_servers").delete().eq("id", server_id).eq("user_id", user_id).execute()


@router.get("/mcp-servers/{server_id}/tools")
async def list_server_tools(server_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    row = (
        get_supabase()
        .table("mcp_servers")
        .select("*")
        .eq("id", server_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
        .data
    )
    if not row:
        raise HTTPException(404, detail="Server not found")
    config = McpServerConfig(**row)
    tools = await discover_tools(config)
    return {"tools": [t.to_llm_schema() for t in tools]}


@router.get("/mcp-audit-log")
def get_audit_log(authorization: str = Header(), limit: int = 50):
    user_id = get_user_id(authorization)
    rows = (
        get_supabase()
        .table("mcp_audit_log")
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
        .data
        or []
    )
    return {"entries": rows}
