"""Tests for agent Pydantic models."""
import json
import pytest
from models.agent import (
    StreamEvent,
    TextEvent,
    ToolCallEvent,
    ToolResultEvent,
    SkillActiveEvent,
    DoneEvent,
    ErrorEvent,
    Tier,
)


def test_text_event_roundtrips():
    ev = TextEvent(content="hello")
    payload = ev.model_dump()
    assert payload == {"type": "text", "content": "hello"}


def test_tool_call_event_has_id_tool_and_args():
    ev = ToolCallEvent(id="call_1", tool="brain.search_brain", args={"query": "x"})
    assert ev.type == "tool_call"
    assert ev.model_dump()["args"] == {"query": "x"}


def test_skill_active_event_carries_name():
    ev = SkillActiveEvent(name="exam-prep-coach")
    assert ev.model_dump() == {"type": "skill_active", "name": "exam-prep-coach"}


def test_done_event_carries_ids():
    ev = DoneEvent(thread_id="t1", message_id="m1")
    assert ev.model_dump() == {"type": "done", "thread_id": "t1", "message_id": "m1"}


def test_error_event_carries_message():
    ev = ErrorEvent(content="boom")
    assert ev.model_dump() == {"type": "error", "content": "boom"}


def test_tier_enum_values():
    assert Tier.EXTERNAL.value == "external"
    assert Tier.INTERNAL_API.value == "internal_api"
    assert Tier.INTERNAL_LOCAL.value == "internal_local"


def test_stream_event_union_validates_via_type_field():
    # A raw dict with type=text should parse as TextEvent
    parsed = StreamEvent.validate_python({"type": "text", "content": "hi"})
    assert isinstance(parsed, TextEvent)


def test_ingest_created_event_roundtrip():
    from models.agent import IngestCreatedEvent
    ev = IngestCreatedEvent(note_id="abc-123")
    assert ev.type == "ingest_created"
    assert ev.note_id == "abc-123"


def test_surface_accepts_interactive():
    from models.agent import AgentRequest, ChatMessage
    req = AgentRequest(
        messages=[ChatMessage(role="user", content="hi")],
        query="hi",
        surface="interactive",
    )
    assert req.surface == "interactive"
