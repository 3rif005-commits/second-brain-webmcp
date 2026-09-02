"""Semantic retrieval — two-pass cosine similarity via Supabase RPC.

Pass 1: match notes by descriptor_embedding (notes must have been indexed).
Pass 2: within the top notes, find the best matching blocks.

Falls back to legacy match_chunks RPC for notes that haven't been re-indexed
(no descriptor_embedding set).
"""
from __future__ import annotations

from services.database import get_supabase

_TOP_NOTES    = 5
_TOP_BLOCKS   = 15   # total across all top notes
_LEGACY_THRESHOLD = 0.50
_LEGACY_CHUNKS    = 12


def retrieve(query_embedding: list[float], user_id: str) -> list[dict]:
    if not query_embedding:
        return []

    vec = "[" + ",".join(str(v) for v in query_embedding) + "]"
    db  = get_supabase()

    # ── Pass 1: note descriptor search ───────────────────────────────────────
    pass1 = db.rpc(
        "match_note_descriptors",
        {"query_embedding": vec, "match_user_id": user_id, "match_count": _TOP_NOTES},
    ).execute()

    note_rows = pass1.data or []

    if not note_rows:
        return _legacy_fallback(db, vec, user_id)

    note_ids = [r["id"] for r in note_rows]
    note_meta = {r["id"]: r for r in note_rows}

    # ── Pass 2: block search within top notes ─────────────────────────────────
    pass2 = db.rpc(
        "match_blocks_in_notes",
        {
            "query_embedding": vec,
            "match_user_id":   user_id,
            "note_ids":        note_ids,
            "match_count":     _TOP_BLOCKS,
        },
    ).execute()

    block_rows = pass2.data or []

    if not block_rows:
        return _legacy_fallback(db, vec, user_id)

    results = []
    for row in block_rows:
        nid      = str(row["note_id"])
        block_id = row.get("block_id") or ""
        meta     = note_meta.get(nid, {})
        score    = max(0.0, 1.0 - float(row["dist"]))
        deep_link = f"/brain/{nid}#{block_id}" if block_id else f"/brain/{nid}"
        results.append({
            "id":           nid,
            "title":        meta.get("title", ""),
            "deep_link":    deep_link,
            "content_text": row.get("chunk_text", "")[:300],
            "similarity":   score,
        })

    return results


def _legacy_fallback(db, vec: str, user_id: str) -> list[dict]:
    """Fall back to old single-pass chunk retrieval for un-indexed notes."""
    res = db.rpc(
        "match_chunks",
        {
            "query_embedding": vec,
            "match_user_id":   user_id,
            "match_threshold": _LEGACY_THRESHOLD,
            "match_count":     _LEGACY_CHUNKS,
        },
    ).execute()
    rows = res.data or []
    rows = [r for r in rows if r.get("deleted_at") is None]

    if not rows:
        return []

    seen: dict[str, dict] = {}
    for row in rows:
        nid = str(row["note_id"])
        if nid not in seen or row["similarity"] > seen[nid]["similarity"]:
            seen[nid] = row

    best = sorted(seen.values(), key=lambda r: r["similarity"], reverse=True)[:_TOP_NOTES]
    return [
        {
            "id":           str(r["note_id"]),
            "title":        r.get("title", ""),
            "content_text": r.get("chunk_text", "")[:300],
            "deep_link":    r.get("deep_link", f"/brain/{r['note_id']}"),
            "similarity":   r.get("similarity", 0.0),
        }
        for r in best
    ]
