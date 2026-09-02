"""Tests for brain tool dispatch — read tools."""
from unittest.mock import MagicMock, patch

import pytest

from services.agent.brain_tools import (
    BRAIN_TOOL_SCHEMAS,
    execute_brain_tool,
)


def test_schemas_include_read_tools():
    names = {s["name"] for s in BRAIN_TOOL_SCHEMAS}
    assert {"brain.search_brain", "brain.get_note",
            "brain.list_notes", "brain.get_backlinks"} <= names


def test_search_brain_schema_has_query_param():
    schema = next(s for s in BRAIN_TOOL_SCHEMAS
                  if s["name"] == "brain.search_brain")
    assert "query" in schema["input_schema"]["properties"]
    assert schema["input_schema"]["required"] == ["query"]


@patch("services.agent.brain_tools.embed")
@patch("services.agent.brain_tools.retrieve")
async def test_search_brain_runs_retrieve(mock_retrieve, mock_embed):
    mock_embed.return_value = [0.1, 0.2, 0.3]
    mock_retrieve.return_value = [
        {"id": "n1", "title": "Note 1", "content_text": "x",
         "deep_link": "/brain/n1", "similarity": 0.9}
    ]
    result = await execute_brain_tool(
        "brain.search_brain", args={"query": "chain rule"},
        user_id="u1"
    )
    assert result["matches"][0]["id"] == "n1"
    mock_embed.assert_called_once_with("chain rule")
    mock_retrieve.assert_called_once()


@patch("services.agent.brain_tools.get_supabase")
async def test_get_note_returns_row(mock_supa):
    mock_table = MagicMock()
    mock_supa.return_value.table.return_value = mock_table
    mock_table.select.return_value.eq.return_value.eq.return_value.single.return_value.execute.return_value.data = {
        "id": "n1", "title": "T", "content": [], "local_only": False,
    }
    result = await execute_brain_tool("brain.get_note", args={"id": "n1"},
                                      user_id="u1")
    assert result["id"] == "n1"
    assert result["local_only"] is False


async def test_unknown_tool_raises():
    with pytest.raises(ValueError):
        await execute_brain_tool("brain.nope", args={}, user_id="u1")


@patch("services.agent.brain_tools.get_supabase")
async def test_create_note_inserts_row(mock_supa):
    mock_table = MagicMock()
    mock_supa.return_value.table.return_value = mock_table
    mock_table.insert.return_value.execute.return_value.data = [
        {"id": "new_id", "title": "T"}
    ]
    result = await execute_brain_tool(
        "brain.create_note",
        args={"title": "T", "blocks": []},
        user_id="u1",
    )
    assert result["id"] == "new_id"
    mock_table.insert.assert_called_once()
    inserted_payload = mock_table.insert.call_args[0][0]
    assert inserted_payload["user_id"] == "u1"
    assert inserted_payload["title"] == "T"


@patch("services.agent.brain_tools.get_supabase")
async def test_update_note_uses_patch_semantics(mock_supa):
    mock_table = MagicMock()
    mock_supa.return_value.table.return_value = mock_table
    mock_table.update.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
        {"id": "n1"}
    ]
    await execute_brain_tool(
        "brain.update_note",
        args={"id": "n1", "blocks": [{"type": "paragraph"}]},
        user_id="u1",
    )
    mock_table.update.assert_called_once()


@patch("services.agent.brain_tools.get_supabase")
async def test_set_mastery_updates_status(mock_supa):
    mock_table = MagicMock()
    mock_supa.return_value.table.return_value = mock_table
    mock_table.update.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
        {"id": "n1"}
    ]
    await execute_brain_tool(
        "brain.set_mastery",
        args={"id": "n1", "status": "mastered"},
        user_id="u1",
    )
    update_call = mock_table.update.call_args[0][0]
    assert update_call["mastery_status"] == "mastered"


@patch("services.agent.brain_tools.get_supabase")
async def test_delete_note_soft_deletes(mock_supa):
    mock_table = MagicMock()
    mock_supa.return_value.table.return_value = mock_table
    mock_table.update.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
        {"id": "n1"}
    ]
    result = await execute_brain_tool(
        "brain.delete_note",
        args={"id": "n1", "confirm": True},
        user_id="u1",
    )
    assert result["id"] == "n1"
    # delete_note should soft-delete by setting deleted_at, not hard-delete
    update_call = mock_table.update.call_args[0][0]
    assert "deleted_at" in update_call
