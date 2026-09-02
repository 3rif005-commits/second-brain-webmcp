# backend/tests/test_agent_ingest.py
"""Tests for run_ingest_turn and POST /agent/ingest."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from services.agent.engine import run_ingest_turn
from services.agent.skills import Skill, SkillRegistry
from models.agent import AgentRequest, ChatMessage, Mode


def _make_note_author_registry() -> SkillRegistry:
    return SkillRegistry({
        "note-author": Skill(
            name="note-author",
            description="Format notes as mastery guides",
            body="Use H2 sections. Call brain.update_note with structured blocks.",
            tools=None, priority=5, source_path=Path("/fake"),
        )
    })


# --- Fake streaming infrastructure (mirrors test_engine.py pattern) ---

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
        pass


class _FakeClient:
    def __init__(self, resp):
        self._resp = resp

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    def stream(self, *args, **kwargs):
        return _FakeStreamCM(self._resp)


async def _collect(ait):
    return [ev async for ev in ait]


def _text_lines(*pieces):
    out = []
    for p in pieces:
        out.append("data: " + json.dumps({"choices": [{"delta": {"content": p}}]}))
    out.append("data: [DONE]")
    return out


# --- Tests ---

def test_run_ingest_turn_auto_activates_note_author():
    registry = _make_note_author_registry()
    request = AgentRequest(
        messages=[ChatMessage(role="user", content="Note ID: n1\n\nSome text")],
        query="Ingest: test.pdf",
        mode=Mode.API,
        surface="ingest",
        current_note_id="n1",
    )
    with (
        patch("services.agent.engine.get_endpoint", return_value={
            "url": "http://fake", "headers": {}, "model": "test",
        }),
        patch("httpx.AsyncClient", return_value=_FakeClient(
            _FakeStreamResp(_text_lines("Hello"))
        )),
    ):
        events = asyncio.run(_collect(
            run_ingest_turn(request, user_id="u1", skill_registry=registry)
        ))

    types = [e["type"] for e in events]
    assert "skill_active" in types
    assert "text" in types
    assert "done" in types
    skill_names = [e["name"] for e in events if e["type"] == "skill_active"]
    assert "note-author" in skill_names


def test_run_ingest_turn_no_retrieval_context():
    """context event must have empty notes list."""
    registry = _make_note_author_registry()
    request = AgentRequest(
        messages=[ChatMessage(role="user", content="text")],
        query="Ingest",
        mode=Mode.API,
        surface="ingest",
    )
    with (
        patch("services.agent.engine.get_endpoint", return_value={
            "url": "http://fake", "headers": {}, "model": "test",
        }),
        patch("httpx.AsyncClient", return_value=_FakeClient(
            _FakeStreamResp(_text_lines("hi"))
        )),
    ):
        events = asyncio.run(_collect(
            run_ingest_turn(request, user_id="u1", skill_registry=registry)
        ))

    context_events = [e for e in events if e["type"] == "context"]
    assert context_events
    assert context_events[0]["notes"] == []


# --- Endpoint tests ---

from fastapi.testclient import TestClient
from unittest.mock import patch as mock_patch


@pytest.fixture
def test_client():
    from main import app
    return TestClient(app)


def test_endpoint_rejects_unknown_extension(test_client):
    with mock_patch("routers.agent_ingest.get_user_id", return_value="user-1"):
        resp = test_client.post(
            "/agent/ingest",
            headers={"Authorization": "Bearer faketoken"},
            files={"file": ("evil.exe", b"MZ", "application/octet-stream")},
            data={"mode": "api"},
        )
    assert resp.status_code == 400
    assert "Unsupported" in resp.json()["detail"]


def test_endpoint_rejects_missing_source(test_client):
    with mock_patch("routers.agent_ingest.get_user_id", return_value="user-1"):
        resp = test_client.post(
            "/agent/ingest",
            headers={"Authorization": "Bearer faketoken"},
            data={"mode": "api"},
        )
    assert resp.status_code == 400
    assert "file" in resp.json()["detail"].lower() or "url" in resp.json()["detail"].lower()


def test_endpoint_rejects_missing_auth(test_client):
    # No Authorization header — get_user_id raises 401
    with mock_patch("routers.agent_ingest.get_user_id", side_effect=Exception("401")):
        resp = test_client.post("/agent/ingest", data={"mode": "api"})
    assert resp.status_code in (400, 401, 422, 500)
