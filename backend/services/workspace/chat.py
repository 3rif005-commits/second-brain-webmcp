"""Note-scoped grounded chat with anchored citations.

run_note_chat(...) → AsyncIterator of SSE-ready event dicts (same grammar as the
agent engine: context / text / citations / error / done).

Grounding: retrieve top-K resource_chunks across ALL sources attached to THIS
note, number them [1]..[K] in a <sources> block, and require bracket citations.
Only markers that map to retrieved chunks become citation chips client-side —
unknown markers are ignored (anti-hallucination guard, same idea as the tutor's
note-id rule). The citation payload already carries resource_id + title, which
is exactly what multi-source attribution needs.
"""
from __future__ import annotations

import logging
from typing import Any, AsyncIterator

from services.database import get_supabase
from services.embedder import embed
from services.ai.client import stream as ai_stream
from services.ai.router import candidates

logger = logging.getLogger(__name__)

_TOP_K = 10

SYSTEM_TEMPLATE = """You are the study assistant for one note in the user's
Second Brain. Answer ONLY from the numbered sources below — they are excerpts
from the sources the user attached to this note.

Rules:
- Every factual claim MUST end with a citation marker like [1] or [2][4],
  where the number is the source excerpt that supports it.
- Only use numbers that appear in <sources>. Never invent citation numbers.
- If the sources do not contain the answer, say so plainly — do not answer
  from general knowledge.
- Be concise and direct.

<sources>
{sources}
</sources>"""


def _anchor_label(c: dict) -> str:
    if c["anchor_type"] == "time":
        s = int(c["anchor_start"])
        return f"t={s // 60:02d}:{s % 60:02d}"
    if c["anchor_type"] == "page":
        return f"page {int(c['anchor_start'])}"
    return f"section {int(c['anchor_start'])}"


def retrieve_chunks(query: str, note_id: str, user_id: str) -> list[dict]:
    embedding = embed(query)
    vec = "[" + ",".join(str(v) for v in embedding) + "]"
    res = get_supabase().rpc("match_note_source_chunks", {
        "query_embedding": vec,
        "match_user_id": user_id,
        "target_note_id": note_id,
        "match_count": _TOP_K,
    }).execute()
    return res.data or []


def build_system_prompt(chunks: list[dict], titles: dict[str, str]) -> str:
    lines = []
    for i, c in enumerate(chunks, start=1):
        title = titles.get(str(c["resource_id"]), "resource")
        lines.append(f'[{i}] ({title}, {_anchor_label(c)}) {c["chunk_text"][:800]}')
    return SYSTEM_TEMPLATE.format(sources="\n\n".join(lines) if lines else "(no sources)")


def citations_payload(chunks: list[dict], titles: dict[str, str]) -> list[dict]:
    return [
        {
            "n": i,
            "resource_id": str(c["resource_id"]),
            "title": titles.get(str(c["resource_id"]), "resource"),
            "anchor_type": c["anchor_type"],
            "anchor_start": c["anchor_start"],
            "anchor_end": c["anchor_end"],
            "snippet": c["chunk_text"][:200],
        }
        for i, c in enumerate(chunks, start=1)
    ]


async def run_note_chat(
    note_id: str,
    user_id: str,
    messages: list[dict],
) -> AsyncIterator[dict[str, Any]]:
    query = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            query = m.get("content") or ""
            break

    # 1. retrieve note-scoped chunks across every attached source
    chunks: list[dict] = []
    try:
        chunks = retrieve_chunks(query, note_id, user_id)
    except Exception as e:
        yield {"type": "error", "content": f"retrieval failed: {e}"}

    titles: dict[str, str] = {}
    if chunks:
        try:
            rids = list({str(c["resource_id"]) for c in chunks})
            rows = (get_supabase().table("note_resources")
                    .select("id,title").in_("id", rids).execute().data or [])
            titles = {str(r["id"]): r["title"] for r in rows}
        except Exception:
            pass

    citations = citations_payload(chunks, titles)
    yield {"type": "context", "citations": citations}

    # 2. stream the grounded answer — fall through the provider chain until
    #    one produces output (a configured key can still 429 at request time)
    providers = candidates("chat", user_id)
    if not providers:
        yield {"type": "error", "content": "No AI provider available."}
        yield {"type": "done"}
        return

    payload = [{"role": "system", "content": build_system_prompt(chunks, titles)}]
    payload += [{"role": m["role"], "content": m["content"]} for m in messages]

    errors: list[str] = []
    for provider in providers:
        streamed_any = False
        try:
            async for text in ai_stream(provider, payload, max_tokens=2048):
                streamed_any = True
                yield {"type": "text", "content": text}
            break
        except Exception as e:
            if streamed_any:
                # mid-stream failure: don't retry (would duplicate output)
                yield {"type": "error", "content": f"LLM error: {e}"}
                break
            errors.append(f"{provider.label or provider.provider}: {str(e)[:120]}")
    else:
        yield {"type": "error", "content": "All providers failed: " + " | ".join(errors)}

    yield {"type": "citations", "citations": citations}
    yield {"type": "done"}
