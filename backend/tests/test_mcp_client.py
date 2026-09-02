"""Tests for MCP client — tool discovery and call dispatch."""
from __future__ import annotations

from unittest.mock import MagicMock
import pytest
from services.agent.mcp_client import McpServerConfig, McpToolSchema


def _fake_tool(name: str, description: str) -> MagicMock:
    t = MagicMock()
    t.name = name
    t.description = description
    t.inputSchema = {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}
    return t


def test_mcp_tool_schema_namespace():
    tool = _fake_tool("search", "Search the web")
    schema = McpToolSchema.from_mcp_tool("websearch", tool)
    assert schema.name == "mcp.websearch.search"
    assert schema.description == "Search the web"
    assert schema.input_schema["properties"]["query"]["type"] == "string"


def test_mcp_server_config_validation():
    cfg = McpServerConfig(
        name="websearch",
        transport="http",
        url="http://localhost:3001",
        enabled=True,
        trust_level="read_only",
    )
    assert cfg.name == "websearch"


def test_mcp_server_config_stdio_requires_command():
    with pytest.raises(ValueError, match="command"):
        McpServerConfig(name="local", transport="stdio", url=None, command=None,
                        enabled=True, trust_level="read_only")
