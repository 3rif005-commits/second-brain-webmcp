"""Tests for mcp_server.py's 5 new database-tool call_tool() branches (Milestone 14,
task 49).

No test file existed for mcp_server.py before this task (grepped tests/ to confirm --
test_mcp_client.py tests a different thing, the app's own client config for connecting
TO external MCP servers, not this repo's own stdio server). The pre-existing
search_brain/get_note/list_notes branches are also untested; this file's bar is "cover
what this task added," not "backfill the whole module."

Mocks httpx.AsyncClient (the `@server.call_tool()` decorator returns the undecorated
function unchanged -- `mcp.server.Server.call_tool`'s own source confirms this, so
`mcp_server.call_tool(name, arguments)` is directly awaitable here) so no live FastAPI
process is needed -- each test asserts the right /internal/db/* endpoint + payload is
hit and the response is formatted as readable Markdown-ish text, not raw JSON dumped at
the LLM (same bar the 3 pre-existing branches already hold themselves to).
"""
from __future__ import annotations

import os

# mcp_server.py sys.exit(1)s at import time if this is unset (no user session --
# it's read once at module load, see that module's own top-level guard) -- set
# before the `import mcp_server` below, which is this file's only import site of it.
os.environ.setdefault("SECOND_BRAIN_USER_ID", "test-mcp-user")

from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

import pytest  # noqa: E402

import mcp_server  # noqa: E402


def _fake_client(json_response: dict):
    """A fake httpx.AsyncClient usable as `async with httpx.AsyncClient(...) as
    client`, whose one `.post()` call returns a response with a no-op
    `.raise_for_status()` and `.json()` -> json_response. Returns (context_manager,
    client) so tests can assert on `client.post.call_args`."""
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = MagicMock(return_value=json_response)

    client = MagicMock()
    client.post = AsyncMock(return_value=resp)

    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=client)
    cm.__aexit__ = AsyncMock(return_value=False)
    return cm, client


@pytest.mark.asyncio
async def test_list_databases_hits_internal_endpoint_and_formats_text():
    cm, client = _fake_client(
        {"databases": [{"database": {"id": "db1", "title": "My DB"}, "data_source": {"id": "ds1"}}]}
    )
    with patch.object(mcp_server.httpx, "AsyncClient", return_value=cm):
        result = await mcp_server.call_tool("list_databases", {})

    client.post.assert_awaited_once()
    args, kwargs = client.post.call_args
    assert args[0] == "/internal/db/list_databases"
    assert kwargs["json"] == {"user_id": mcp_server.USER_ID}
    assert "My DB" in result[0].text
    assert "ds1" in result[0].text


@pytest.mark.asyncio
async def test_list_databases_empty():
    cm, _client = _fake_client({"databases": []})
    with patch.object(mcp_server.httpx, "AsyncClient", return_value=cm):
        result = await mcp_server.call_tool("list_databases", {})
    assert "No databases" in result[0].text


@pytest.mark.asyncio
async def test_get_database_schema_hits_internal_endpoint_and_formats_properties():
    cm, client = _fake_client(
        {
            "database": {"id": "db1", "title": "My DB"},
            "data_source": {"id": "ds1"},
            "properties": [{"key": "abc123", "name": "Title", "type": "title"}],
            "views": [],
        }
    )
    with patch.object(mcp_server.httpx, "AsyncClient", return_value=cm):
        result = await mcp_server.call_tool("get_database_schema", {"database_id": "db1"})

    args, kwargs = client.post.call_args
    assert args[0] == "/internal/db/get_database_schema"
    assert kwargs["json"] == {"database_id": "db1", "user_id": mcp_server.USER_ID}
    assert "My DB" in result[0].text
    assert "abc123" in result[0].text


@pytest.mark.asyncio
async def test_query_database_sends_filter_and_sorts_and_formats_rows():
    cm, client = _fake_client({"rows": [{"id": "row1", "properties": {"title": "x"}}]})
    with patch.object(mcp_server.httpx, "AsyncClient", return_value=cm):
        result = await mcp_server.call_tool(
            "query_database",
            {
                "data_source_id": "ds1",
                "filter": {"type": "condition", "property": "abc", "operator": "equals", "value": 1},
                "sorts": [{"property": "abc", "direction": "asc"}],
            },
        )

    args, kwargs = client.post.call_args
    assert args[0] == "/internal/db/query_database"
    assert kwargs["json"]["data_source_id"] == "ds1"
    assert kwargs["json"]["user_id"] == mcp_server.USER_ID
    assert kwargs["json"]["filter"]["property"] == "abc"
    assert kwargs["json"]["sorts"] == [{"property": "abc", "direction": "asc"}]
    assert "row1" in result[0].text


@pytest.mark.asyncio
async def test_query_database_formats_groups_when_grouped():
    cm, _client = _fake_client({"groups": [{"key": "g1", "label": "Group 1", "row_count": 3}]})
    with patch.object(mcp_server.httpx, "AsyncClient", return_value=cm):
        result = await mcp_server.call_tool("query_database", {"data_source_id": "ds1"})
    assert "1 group" in result[0].text
    assert "Group 1" in result[0].text


@pytest.mark.asyncio
async def test_query_database_no_rows():
    cm, _client = _fake_client({"rows": []})
    with patch.object(mcp_server.httpx, "AsyncClient", return_value=cm):
        result = await mcp_server.call_tool("query_database", {"data_source_id": "ds1"})
    assert "No rows matched" in result[0].text


@pytest.mark.asyncio
async def test_create_row_hits_internal_endpoint_with_flat_properties():
    cm, client = _fake_client({"id": "row1", "properties": {"abc": {"type": "number", "number": 42}}})
    with patch.object(mcp_server.httpx, "AsyncClient", return_value=cm):
        result = await mcp_server.call_tool(
            "create_row", {"data_source_id": "ds1", "properties": {"abc": 42}}
        )

    args, kwargs = client.post.call_args
    assert args[0] == "/internal/db/create_row"
    assert kwargs["json"] == {
        "data_source_id": "ds1",
        "user_id": mcp_server.USER_ID,
        "properties": {"abc": 42},
    }
    assert "row1" in result[0].text


@pytest.mark.asyncio
async def test_update_row_hits_internal_endpoint_with_raw_value():
    cm, client = _fake_client({"id": "row1", "properties": {"abc": {"type": "number", "number": 7}}})
    with patch.object(mcp_server.httpx, "AsyncClient", return_value=cm):
        result = await mcp_server.call_tool(
            "update_row",
            {"data_source_id": "ds1", "note_id": "row1", "property_key": "abc", "value": 7},
        )

    args, kwargs = client.post.call_args
    assert args[0] == "/internal/db/update_row"
    assert kwargs["json"] == {
        "data_source_id": "ds1",
        "user_id": mcp_server.USER_ID,
        "note_id": "row1",
        "property_key": "abc",
        "value": 7,
    }
    assert "row1" in result[0].text


@pytest.mark.asyncio
async def test_list_tools_includes_the_5_database_tools():
    tools = await mcp_server.list_tools()
    names = {t.name for t in tools}
    assert {
        "list_databases",
        "get_database_schema",
        "query_database",
        "create_row",
        "update_row",
    } <= names
