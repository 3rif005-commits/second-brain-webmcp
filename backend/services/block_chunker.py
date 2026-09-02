"""Parse BlockNote JSON content into indexable block chunks.

Input:  note content — a list of BlockNote block objects (from notes.content).
Output: list of {"block_id": str, "chunk_index": int, "chunk_text": str}
        in depth-first traversal order; empty blocks and dividers excluded.
"""
from __future__ import annotations


def parse(content: list | None) -> list[dict]:
    """Walk the BlockNote block tree and return one dict per non-empty block."""
    if not content:
        return []
    chunks: list[dict] = []
    _walk(content, chunks)
    return chunks


def _walk(blocks: list[dict], out: list[dict]) -> None:
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "horizontalRule":
            continue
        text = _extract_text(block)
        if text:
            out.append({
                "block_id":    block.get("id", ""),
                "chunk_index": len(out),
                "chunk_text":  text,
            })
        children = block.get("children") or []
        if children:
            _walk(children, out)


def _extract_text(block: dict) -> str:
    parts: list[str] = []
    for inline in block.get("content") or []:
        if isinstance(inline, dict) and inline.get("type") == "text":
            parts.append(inline.get("text", ""))
    return " ".join(parts).strip()
