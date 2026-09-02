"""Agent Engine — the core loop.

run_turn(request) → AsyncIterator[dict] of stream events.

Loop:
  1. retrieve context (semantic search via existing retriever)
  2. classify skills (keyword overlap against skill descriptions)
  3. build system prompt (base + skill bodies + knowledge context)
  4. open SSE stream to the model endpoint (OpenAI-compatible chat-completions)
  5. yield text/tool_call/tool_result/error events
  6. close with a done event
"""
from __future__ import annotations

import json
import uuid
from typing import Any, AsyncIterator

import httpx

from models.agent import AgentRequest, Mode, Tier
from services.agent.brain_tools import BRAIN_TOOL_SCHEMAS, execute_brain_tool
from services.agent.mcp_client import (
    McpServerConfig, discover_tools, call_tool as mcp_call_tool, log_tool_call
)
from services.agent.model import get_endpoint
from services.agent.permissions import Allow, Deny, check as permission_check
from services.agent.skills import SkillRegistry, classify_skills
from services.embedder import embed
from services.retriever import retrieve

MAX_TOOL_CALLS_PER_TURN = 10


BASE_PERSONA = """You are the Second Brain assistant. You help the user think
about, organize, and recall the contents of their personal knowledge base.

You have access to tools that can search and modify the user's notes. Prefer
to use tools rather than guess. When you cite a note, use its deep_link.

Always be concise. Never fabricate note IDs."""


def _tier_for_mode(mode: Mode) -> Tier:
    return Tier.INTERNAL_LOCAL if mode == Mode.LOCAL else Tier.INTERNAL_API


def _build_knowledge_context_xml(notes: list[dict]) -> str:
    if not notes:
        return ""
    parts = ["<knowledge_context>"]
    for n in notes:
        nid = n.get("id", "")
        title = n.get("title", "")
        link = n.get("deep_link", f"/brain/{nid}")
        snippet = (n.get("content_text") or n.get("summary") or "")[:400]
        parts.append(
            f'  <note id="{nid}" title="{title}" deep_link="{link}">\n'
            f'    {snippet}\n'
            f'  </note>'
        )
    parts.append("</knowledge_context>")
    return "\n".join(parts)


def _build_system_prompt(skill_bodies: list[str], knowledge_xml: str) -> str:
    sections = [BASE_PERSONA]
    if skill_bodies:
        sections.append("Active skills:\n\n" + "\n\n---\n\n".join(skill_bodies))
    if knowledge_xml:
        sections.append(knowledge_xml)
    return "\n\n".join(sections)


async def _get_mcp_tools_for_user(user_id: str) -> tuple[list[dict], list[McpServerConfig]]:
    """Return (tool_schemas, server_configs) for enabled MCP servers."""
    try:
        from services.database import get_supabase
        rows = (
            get_supabase()
            .table("mcp_servers")
            .select("*")
            .eq("user_id", user_id)
            .eq("enabled", True)
            .execute()
            .data
            or []
        )
    except Exception:
        return [], []

    configs = [McpServerConfig(**r) for r in rows]
    schemas: list[dict] = []
    for cfg in configs:
        tools = await discover_tools(cfg)
        schemas.extend(t.to_llm_schema() for t in tools)
    return schemas, configs


def _ev(payload: dict) -> dict:
    """Identity helper — exists so callers can grep for event creation sites."""
    return payload


async def run_turn(
    request: AgentRequest,
    user_id: str,
    skill_registry: SkillRegistry,
) -> AsyncIterator[dict[str, Any]]:
    thread_id = request.thread_id or str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    tier = _tier_for_mode(request.mode)

    # 1. Retrieve context
    try:
        embedding = embed(request.query)
        notes = retrieve(embedding, user_id)
    except Exception as e:
        notes = []
        yield _ev({"type": "error", "content": f"retrieval failed: {e}"})

    yield _ev({"type": "context", "notes": notes})

    # 2. Skill activation
    matched = classify_skills(
        query=request.query,
        skills=skill_registry.all(),
        limit=3,
    )
    for s in matched:
        yield _ev({"type": "skill_active", "name": s.name})

    # 3. Build system prompt + tool schemas
    knowledge_xml = _build_knowledge_context_xml(notes)
    system_prompt = _build_system_prompt(
        skill_bodies=[s.body for s in matched],
        knowledge_xml=knowledge_xml,
    )

    # Restrict tool list per active-skill whitelists. If no skill restricts,
    # all brain tools are offered.
    whitelisted_names: set[str] | None = None
    for s in matched:
        if s.tools is not None:
            namespaced = {f"brain.{t}" if not t.startswith("brain.") else t
                          for t in s.tools}
            whitelisted_names = (
                whitelisted_names & namespaced
                if whitelisted_names is not None
                else namespaced
            )

    tool_schemas = (
        [t for t in BRAIN_TOOL_SCHEMAS if t["name"] in whitelisted_names]
        if whitelisted_names is not None
        else BRAIN_TOOL_SCHEMAS
    )

    # Fetch live MCP tools (best-effort; empty if no servers configured)
    mcp_tool_schemas, mcp_configs = await _get_mcp_tools_for_user(user_id)
    all_tool_schemas = tool_schemas + mcp_tool_schemas

    # 4. Open the endpoint
    try:
        endpoint = get_endpoint(request.mode, task="chat")
    except RuntimeError as e:
        yield _ev({"type": "error", "content": str(e)})
        yield _ev({"type": "done", "thread_id": thread_id,
                  "message_id": message_id})
        return

    messages_payload = [{"role": "system", "content": system_prompt}]
    messages_payload += [m.model_dump() for m in request.messages]

    payload = {
        "model": endpoint["model"],
        "messages": messages_payload,
        "stream": True,
        "max_tokens": 2048,
        "tools": [{"type": "function", "function": t} for t in all_tool_schemas],
    }

    # 5. Drive the streaming loop
    tool_calls_made = 0
    async with httpx.AsyncClient(timeout=240) as client:
        async for ev in _stream_loop(
            client, endpoint, payload,
            messages_payload=messages_payload,
            tool_schemas=all_tool_schemas,
            tier=tier,
            user_id=user_id,
            tool_calls_made=tool_calls_made,
            mcp_configs=mcp_configs,
        ):
            yield ev

    # 6. Done
    yield _ev({"type": "done", "thread_id": thread_id, "message_id": message_id})


async def run_ingest_turn(
    request: AgentRequest,
    user_id: str,
    skill_registry: SkillRegistry,
) -> AsyncIterator[dict[str, Any]]:
    """Variant of run_turn for surface='ingest'.

    Always activates note-author skill (no classifier overhead).
    No semantic search. No thread persistence. Brain write tools allowed.
    """
    message_id = str(uuid.uuid4())
    thread_id = request.thread_id or str(uuid.uuid4())
    tier = _tier_for_mode(request.mode)

    note_author = skill_registry.get("note-author")
    active_skills = [note_author] if note_author else []
    for s in active_skills:
        yield _ev({"type": "skill_active", "name": s.name})

    yield _ev({"type": "context", "notes": []})

    skill_bodies = [s.body for s in active_skills]
    system_prompt = _build_system_prompt(
        skill_bodies=skill_bodies,
        knowledge_xml="",
    )

    try:
        endpoint = get_endpoint(request.mode, task="chat")
    except RuntimeError as e:
        yield _ev({"type": "error", "content": str(e)})
        yield _ev({"type": "done", "thread_id": thread_id, "message_id": message_id})
        return

    messages_payload = [{"role": "system", "content": system_prompt}]
    messages_payload += [m.model_dump() for m in request.messages]

    payload = {
        "model": endpoint["model"],
        "messages": messages_payload,
        "stream": True,
        "max_tokens": 4096,
        "tools": [{"type": "function", "function": t} for t in BRAIN_TOOL_SCHEMAS],
    }

    async with httpx.AsyncClient(timeout=300) as client:
        async for ev in _stream_loop(
            client, endpoint, payload,
            messages_payload=messages_payload,
            tool_schemas=BRAIN_TOOL_SCHEMAS,
            tier=tier,
            user_id=user_id,
            tool_calls_made=0,
        ):
            yield ev

    yield _ev({"type": "done", "thread_id": thread_id, "message_id": message_id})


async def run_interactive_turn(
    request: AgentRequest,
    user_id: str,
    skill_registry: SkillRegistry,
) -> AsyncIterator[dict[str, Any]]:
    """surface='interactive': auto-loads interactive-block-author, text-only output."""
    message_id = str(uuid.uuid4())
    thread_id = str(uuid.uuid4())

    skill = skill_registry.get("interactive-block-author")
    active = [skill] if skill else []
    for s in active:
        yield _ev({"type": "skill_active", "name": s.name})

    skill_bodies = [s.body for s in active]
    system_prompt = (
        "You generate self-contained interactive HTML/CSS/JS blocks.\n\n"
        + ("\n\n".join(skill_bodies))
    )

    try:
        endpoint = get_endpoint(request.mode, task="chat")
    except RuntimeError as e:
        yield _ev({"type": "error", "content": str(e)})
        yield _ev({"type": "done", "thread_id": thread_id, "message_id": message_id})
        return

    messages_payload = [{"role": "system", "content": system_prompt}]
    messages_payload += [m.model_dump() for m in request.messages]

    payload = {
        "model": endpoint["model"],
        "messages": messages_payload,
        "stream": True,
        "max_tokens": 2048,
    }

    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream(
            "POST", endpoint["url"], headers=endpoint["headers"], json=payload
        ) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                yield _ev({"type": "error",
                           "content": f"LLM error {resp.status_code}: {body.decode()[:200]}"})
            else:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    raw = line[6:]
                    if raw == "[DONE]":
                        break
                    try:
                        data = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    text = (data.get("choices") or [{}])[0].get("delta", {}).get("content")
                    if text:
                        yield _ev({"type": "text", "content": text})

    yield _ev({"type": "done", "thread_id": thread_id, "message_id": message_id})


async def _stream_loop(
    client: httpx.AsyncClient,
    endpoint: dict[str, Any],
    payload: dict[str, Any],
    messages_payload: list[dict],
    tool_schemas: list[dict],
    tier: Tier,
    user_id: str,
    tool_calls_made: int,
    mcp_configs: list[McpServerConfig] | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Inner streaming loop — handles a single LLM call. Re-entered after
    each tool call to continue generation."""
    pending_tool_calls: list[dict[str, Any]] = []

    async with client.stream(
        "POST", endpoint["url"], headers=endpoint["headers"], json=payload
    ) as resp:
        if resp.status_code != 200:
            body = await resp.aread()
            yield _ev({"type": "error",
                       "content": f"LLM error {resp.status_code}: {body.decode()[:400]}"})
            return

        async for line in resp.aiter_lines():
            if not line.startswith("data: "):
                continue
            raw = line[6:]
            if raw == "[DONE]":
                break
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue
            delta = data.get("choices", [{}])[0].get("delta", {})

            # Text content
            text = delta.get("content")
            if text:
                yield _ev({"type": "text", "content": text})

            # Tool calls (OpenAI streaming format — accumulate by index)
            for tc in delta.get("tool_calls", []) or []:
                idx = tc.get("index", 0)
                while len(pending_tool_calls) <= idx:
                    pending_tool_calls.append({"id": "", "name": "", "args_buf": ""})
                slot = pending_tool_calls[idx]
                if tc.get("id"):
                    slot["id"] = tc["id"]
                fn = tc.get("function") or {}
                if fn.get("name"):
                    slot["name"] = fn["name"]
                if fn.get("arguments"):
                    slot["args_buf"] += fn["arguments"]

    # After stream finishes, execute any tool calls (one round in Phase 1;
    # multi-round will follow once we wire continue-on-tool-result).
    for slot in pending_tool_calls:
        if tool_calls_made >= MAX_TOOL_CALLS_PER_TURN:
            yield _ev({"type": "error",
                       "content": "tool call budget exhausted"})
            return
        tool = slot["name"]
        try:
            args = json.loads(slot["args_buf"] or "{}")
        except json.JSONDecodeError:
            yield _ev({"type": "tool_denied", "id": slot["id"], "tool": tool,
                       "reason": "invalid JSON arguments"})
            continue

        yield _ev({"type": "tool_call", "id": slot["id"],
                   "tool": tool, "args": args})

        # Permission check — note-targeted tools need note_meta
        note_meta: dict[str, Any] | None = None
        target_id = args.get("id") or args.get("note_id")
        if target_id and tool != "brain.search_brain":
            try:
                note_meta = await execute_brain_tool(
                    "brain.get_note", args={"id": target_id}, user_id=user_id
                )
            except Exception:
                note_meta = None

        decision = permission_check(tool, tier, args, note_meta)
        if isinstance(decision, Deny):
            yield _ev({"type": "tool_denied", "id": slot["id"],
                       "tool": tool, "reason": decision.reason})
            continue

        if tool.startswith("mcp."):
            parts = tool.split(".", 2)
            if len(parts) != 3:
                yield _ev({"type": "tool_denied", "id": slot["id"], "tool": tool,
                           "reason": "invalid mcp tool name format"})
                continue
            _, server_name, bare_tool = parts
            cfg = next((c for c in (mcp_configs or []) if c.name == server_name), None)
            if cfg is None:
                yield _ev({"type": "tool_denied", "id": slot["id"], "tool": tool,
                           "reason": f"MCP server '{server_name}' not found or disabled"})
                continue
            mcp_result = await mcp_call_tool(cfg, bare_tool, args)
            result_code = "error" if mcp_result.get("error") else "ok"
            log_tool_call(user_id, server_name, bare_tool, args, result_code)
            if mcp_result.get("error"):
                yield _ev({"type": "tool_denied", "id": slot["id"], "tool": tool,
                           "reason": mcp_result["error"]})
                continue
            result = {"content": mcp_result["content"]}
        else:
            try:
                result = await execute_brain_tool(tool, args=args, user_id=user_id)
            except Exception as e:
                yield _ev({"type": "tool_denied", "id": slot["id"],
                           "tool": tool, "reason": f"execution error: {e}"})
                continue

        tool_calls_made += 1
        summary = _summarize_result(tool, result)
        yield _ev({"type": "tool_result", "id": slot["id"],
                   "summary": summary, "data": result})


def _summarize_result(tool: str, result: dict[str, Any]) -> str:
    """Compact human-readable summary used in the inline tool-event UI."""
    if tool == "brain.search_brain":
        n = len(result.get("matches", []))
        return f"{n} notes matched"
    if tool == "brain.list_notes":
        n = len(result.get("notes", []))
        return f"{n} notes"
    if tool in ("brain.create_note", "brain.update_note"):
        return f"note {result.get('id', '?')} {'created' if 'create' in tool else 'updated'}"
    if tool == "brain.delete_note":
        return f"note {result.get('id', '?')} moved to trash"
    return tool.split(".")[-1] + " ok"
