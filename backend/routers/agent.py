"""POST /agent — SSE-streaming endpoint that runs the Agent Engine.

Replaces the old POST /chat endpoint. Saves the assistant message to
chat_threads on completion.
"""
from __future__ import annotations

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Header
from fastapi.responses import StreamingResponse

from models.agent import AgentRequest, Mode
from routers.ingest import get_user_id  # JWT helper, already exists
from services.agent.engine import run_turn
from services.agent.skills import SkillRegistry
from services.database import get_supabase

router = APIRouter(prefix="/agent", tags=["agent"])


_BUNDLED_SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
_USER_SKILLS_DIR = Path.home() / ".secondbrain" / "skills"


def _get_registry() -> SkillRegistry:
    return SkillRegistry.load([_BUNDLED_SKILLS_DIR, _USER_SKILLS_DIR])


@router.post("")
async def agent_endpoint(
    body: AgentRequest,
    authorization: str = Header(),
):
    user_id = get_user_id(authorization)
    registry = _get_registry()

    thread_id = body.thread_id or str(uuid.uuid4())
    # Append user message to thread (or create thread)
    _append_user_message_to_thread(thread_id, user_id, body)

    async def stream():
        last_assistant_text = ""
        async for ev in run_turn(body, user_id=user_id, skill_registry=registry):
            # Override thread_id with our own so the row matches the SSE
            if ev.get("type") == "done":
                ev = {**ev, "thread_id": thread_id}
            if ev.get("type") == "text":
                last_assistant_text += ev["content"]
            yield "data: " + json.dumps(ev) + "\n\n"

        # Persist assistant message after stream completes
        _append_assistant_message_to_thread(thread_id, last_assistant_text)
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


def _append_user_message_to_thread(
    thread_id: str, user_id: str, body: AgentRequest
) -> None:
    """Either update an existing thread's messages or create a new one."""
    supabase = get_supabase()
    _res = (
        supabase.table("chat_threads")
        .select("id, messages")
        .eq("id", thread_id)
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    existing = _res.data if _res is not None else None
    new_message = {"role": "user", "content": body.query}
    if existing:
        messages = existing["messages"] + [new_message]
        supabase.table("chat_threads").update({"messages": messages}).eq(
            "id", thread_id
        ).execute()
    else:
        supabase.table("chat_threads").insert({
            "id": thread_id,
            "user_id": user_id,
            "messages": [new_message],
            "model_mode": body.mode.value,
            "title": body.query[:60],  # placeholder; replaced after first reply
        }).execute()


def _append_assistant_message_to_thread(thread_id: str, content: str) -> None:
    if not content:
        return
    supabase = get_supabase()
    _res = (
        supabase.table("chat_threads")
        .select("id, messages, title")
        .eq("id", thread_id)
        .maybe_single()
        .execute()
    )
    existing = _res.data if _res is not None else None
    if not existing:
        return
    messages = existing["messages"] + [{"role": "assistant", "content": content}]
    update: dict = {"messages": messages}
    # First assistant reply → set a short auto-title if the title was the
    # truncated user query.
    if existing["title"] and len(existing["messages"]) == 1:
        first_user = existing["messages"][0]["content"]
        if existing["title"] == first_user[:60]:
            update["title"] = _auto_title(first_user)
    supabase.table("chat_threads").update(update).eq("id", thread_id).execute()


def _auto_title(first_user_msg: str) -> str:
    """Fast deterministic title from the first user message.

    Phase 1: take the first sentence (or ≤6 words). A small-LLM title is a
    nice-to-have in Phase 2.
    """
    head = first_user_msg.strip().split(".")[0]
    words = head.split()
    return " ".join(words[:6]) + ("…" if len(words) > 6 else "")
