"""MCP client — connects to user-configured external MCP servers.

Discovers tools from each server, namespaces them as mcp.<server>.<tool>,
and dispatches calls. Logs each call to mcp_audit_log.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, model_validator


class McpServerConfig(BaseModel):
    name: str
    transport: str          # 'stdio' | 'http' | 'sse'
    command: str | None = None
    url: str | None = None
    enabled: bool = True
    trust_level: str = "read_only"

    @model_validator(mode="after")
    def _check_transport_fields(self):
        if self.transport == "stdio" and not self.command:
            raise ValueError("stdio transport requires a command")
        if self.transport in ("http", "sse") and not self.url:
            raise ValueError(f"{self.transport} transport requires a url")
        return self


@dataclass
class McpToolSchema:
    name: str              # mcp.<server>.<tool>
    description: str
    input_schema: dict

    @classmethod
    def from_mcp_tool(cls, server_name: str, tool) -> "McpToolSchema":
        return cls(
            name=f"mcp.{server_name}.{tool.name}",
            description=tool.description or "",
            input_schema=tool.inputSchema or {"type": "object", "properties": {}},
        )

    def to_llm_schema(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


async def discover_tools(config: McpServerConfig) -> list[McpToolSchema]:
    """Connect to a server, list its tools, and return namespaced schemas.

    Returns [] if the server is unreachable (non-fatal).
    """
    try:
        tools = await _list_tools(config)
        return [McpToolSchema.from_mcp_tool(config.name, t) for t in tools]
    except Exception:
        return []


async def call_tool(
    config: McpServerConfig,
    tool_name: str,         # bare name (without mcp.<server>. prefix)
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Call a tool on the server and return the result as a dict."""
    try:
        result = await _call_tool(config, tool_name, arguments)
        return {"content": result, "error": None}
    except Exception as e:
        return {"content": None, "error": str(e)}


# ── Transport implementations ──────────────────────────────────────────────


async def _list_tools(config: McpServerConfig):
    if config.transport == "stdio":
        return await _stdio_list_tools(config)
    return await _http_list_tools(config)


async def _call_tool(config: McpServerConfig, name: str, args: dict):
    if config.transport == "stdio":
        return await _stdio_call_tool(config, name, args)
    return await _http_call_tool(config, name, args)


async def _stdio_list_tools(config: McpServerConfig):
    from mcp.client.stdio import stdio_client, StdioServerParameters
    from mcp import ClientSession

    parts = (config.command or "").split()
    params = StdioServerParameters(command=parts[0], args=parts[1:])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return result.tools


async def _stdio_call_tool(config: McpServerConfig, name: str, args: dict):
    from mcp.client.stdio import stdio_client, StdioServerParameters
    from mcp import ClientSession

    parts = (config.command or "").split()
    params = StdioServerParameters(command=parts[0], args=parts[1:])
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(name, arguments=args)
            return [c.text if hasattr(c, "text") else str(c) for c in result.content]


async def _http_list_tools(config: McpServerConfig):
    from mcp.client.sse import sse_client
    from mcp import ClientSession

    url = (config.url or "").rstrip("/") + "/sse"
    async with sse_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return result.tools


async def _http_call_tool(config: McpServerConfig, name: str, args: dict):
    from mcp.client.sse import sse_client
    from mcp import ClientSession

    url = (config.url or "").rstrip("/") + "/sse"
    async with sse_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(name, arguments=args)
            return [c.text if hasattr(c, "text") else str(c) for c in result.content]


# ── Audit log ─────────────────────────────────────────────────────────────


def log_tool_call(
    user_id: str,
    server_name: str,
    tool_name: str,
    args: dict,
    result_code: str,
) -> None:
    """Persist MCP tool call to mcp_audit_log. Silent on failure."""
    try:
        from services.database import get_supabase
        get_supabase().table("mcp_audit_log").insert({
            "user_id": user_id,
            "server_name": server_name,
            "tool_name": tool_name,
            "args_json": args,
            "result_code": result_code,
        }).execute()
    except Exception:
        pass
