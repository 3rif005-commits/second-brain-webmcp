"""Tests for the Agent Engine — covers skill activation, system-prompt build,
tool call handling, and SSE event sequence.

The LLM HTTP call is mocked at the httpx.AsyncClient.stream level.
"""
import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from models.agent import AgentRequest, ChatMessage, Mode, Tier
from services.agent.engine import run_turn
from services.agent.skills import SkillRegistry, Skill


async def _collect(ait):
    """Collect all items from an async iterator into a list."""
    return [item async for item in ait]


def _make_registry() -> SkillRegistry:
    skills = {
        "cite-everything": Skill(
            name="cite-everything",
            description="Use whenever the answer draws on the user's notes",
            body="Cite notes with markdown links.",
            tools=None, priority=5, source_path=Path("/x"),
        ),
    }
    return SkillRegistry(skills)


class _FakeStreamResp:
    def __init__(self, lines):
        self.status_code = 200
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return b""


class _FakeStreamCM:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self._resp

    async def __aexit__(self, *args):
        return None


class _FakeClient:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return None

    def stream(self, *args, **kwargs):
        return _FakeStreamCM(self._resp)


def _openai_chunks(content_pieces, tool_calls=None):
    """Build SSE-shaped data: lines that mimic OpenAI streaming format."""
    out = []
    for piece in content_pieces:
        out.append(
            "data: " + json.dumps({
                "choices": [{"delta": {"content": piece}}]
            })
        )
    if tool_calls:
        for tc in tool_calls:
            out.append("data: " + json.dumps({
                "choices": [{"delta": {"tool_calls": [tc]}}]
            }))
    out.append("data: [DONE]")
    return out


@pytest.mark.asyncio
@patch("services.agent.engine.execute_brain_tool")
@patch("services.agent.engine.retrieve")
@patch("services.agent.engine.embed")
@patch("services.agent.engine.get_endpoint")
@patch("services.agent.engine.httpx.AsyncClient")
async def test_engine_streams_text_event(
    mock_client_cls, mock_endpoint, mock_embed, mock_retrieve, mock_exec,
):
    mock_endpoint.return_value = {
        "url": "http://x/chat/completions",
        "headers": {},
        "model": "fake",
        "source": "openrouter",
    }
    mock_embed.return_value = [0.1] * 768
    mock_retrieve.return_value = []
    chunks = _openai_chunks(["Hello", " world"])
    mock_client_cls.return_value = _FakeClient(_FakeStreamResp(chunks))

    req = AgentRequest(
        messages=[ChatMessage(role="user", content="hi")],
        query="hi",
        mode=Mode.API,
    )
    events = [e async for e in run_turn(req, user_id="u1",
                                        skill_registry=_make_registry())]
    text_events = [e for e in events if e["type"] == "text"]
    assert "".join(e["content"] for e in text_events) == "Hello world"
    # done event must come last and carry IDs
    assert events[-1]["type"] == "done"


@pytest.mark.asyncio
@patch("services.agent.engine.execute_brain_tool")
@patch("services.agent.engine.retrieve")
@patch("services.agent.engine.embed")
@patch("services.agent.engine.get_endpoint")
@patch("services.agent.engine.httpx.AsyncClient")
async def test_engine_activates_matching_skill(
    mock_client_cls, mock_endpoint, mock_embed, mock_retrieve, mock_exec,
):
    mock_endpoint.return_value = {"url": "u", "headers": {}, "model": "m",
                                  "source": "openrouter"}
    mock_embed.return_value = [0.0] * 768
    mock_retrieve.return_value = []
    chunks = _openai_chunks(["ok"])
    mock_client_cls.return_value = _FakeClient(_FakeStreamResp(chunks))

    req = AgentRequest(
        messages=[ChatMessage(role="user", content="cite from my notes")],
        query="cite from my notes",
        mode=Mode.API,
    )
    events = [e async for e in run_turn(req, user_id="u1",
                                        skill_registry=_make_registry())]
    # cite-everything has 'cite' and 'notes' in description; query has both
    skill_events = [e for e in events if e["type"] == "skill_active"]
    assert any(e["name"] == "cite-everything" for e in skill_events)


@pytest.mark.asyncio
@patch("services.agent.engine.execute_brain_tool")
@patch("services.agent.engine.retrieve")
@patch("services.agent.engine.embed")
@patch("services.agent.engine.get_endpoint")
@patch("services.agent.engine.httpx.AsyncClient")
async def test_engine_emits_error_when_endpoint_fails(
    mock_client_cls, mock_endpoint, mock_embed, mock_retrieve, mock_exec,
):
    mock_endpoint.side_effect = RuntimeError("API key not configured")
    req = AgentRequest(
        messages=[ChatMessage(role="user", content="hi")],
        query="hi",
        mode=Mode.API,
    )
    events = [e async for e in run_turn(req, user_id="u1",
                                        skill_registry=_make_registry())]
    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) == 1
    assert "API key" in error_events[0]["content"]


def test_interactive_turn_auto_loads_interactive_skill():
    """run_interactive_turn must auto-load interactive-block-author skill."""
    from services.agent.engine import run_interactive_turn

    registry = SkillRegistry({
        "interactive-block-author": Skill(
            name="interactive-block-author",
            description="Generate interactive HTML blocks",
            body="Output only raw HTML/CSS/JS.",
            tools=None, priority=5, source_path=Path("/fake"),
        )
    })
    request = AgentRequest(
        messages=[ChatMessage(role="user", content="A quiz about photosynthesis")],
        query="A quiz about photosynthesis",
        mode=Mode.API,
        surface="interactive",
    )
    lines = [
        'data: {"choices":[{"delta":{"content":"<html><body>Quiz</body></html>"}}]}',
        "data: [DONE]",
    ]
    with (
        patch("services.agent.engine.get_endpoint", return_value={
            "url": "http://fake", "headers": {}, "model": "test",
        }),
        patch("httpx.AsyncClient", return_value=_FakeClient(_FakeStreamResp(lines))),
    ):
        events = asyncio.run(_collect(
            run_interactive_turn(request, user_id="u1", skill_registry=registry)
        ))

    types = [e["type"] for e in events]
    assert "skill_active" in types
    assert any(e.get("name") == "interactive-block-author"
               for e in events if e["type"] == "skill_active")
    text_events = [e for e in events if e["type"] == "text"]
    assert any("<html>" in e["content"] for e in text_events)
