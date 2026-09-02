"""Generate a 2-3 sentence AI descriptor for a note.

Used to populate notes.descriptor + notes.descriptor_embedding so the
two-pass retriever can find notes by topic before drilling into blocks.
"""
from __future__ import annotations

import httpx

from models.agent import Mode
from services.agent.model import get_endpoint

_PROMPT = """\
You are summarizing a personal knowledge note for use in an AI retrieval system.
Write 2-3 sentences that describe what this note is about.
Be specific: mention the main topic, key concepts, and what a reader would learn.
Do not use phrases like "this note" or "this document".

Title: {title}
Content (first 2000 chars):
{content}

Descriptor:"""


def generate(note_title: str, blocks: list[str]) -> str:
    """Return a 2-3 sentence descriptor string for the note.

    Falls back to "{title}. {first_block[:200]}" if the LLM is unreachable.
    """
    content = "\n\n".join(blocks)[:2000]

    try:
        endpoint = get_endpoint(mode=Mode.API, task="chat")
    except RuntimeError:
        return _fallback(note_title, blocks)

    payload = {
        "model": endpoint["model"],
        "messages": [{"role": "user", "content": _PROMPT.format(title=note_title, content=content)}],
        "max_tokens": 120,
        "stream": False,
    }

    try:
        with httpx.Client(timeout=30) as client:
            resp = client.post(endpoint["url"], headers=endpoint["headers"], json=payload)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception:
        return _fallback(note_title, blocks)


def _fallback(title: str, blocks: list[str]) -> str:
    first = blocks[0][:200] if blocks else ""
    if first:
        return f"{title}. {first}"
    return f"{title}."
