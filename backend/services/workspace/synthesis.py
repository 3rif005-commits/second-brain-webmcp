"""Multi-source note synthesis — one note per session, never one per source.

maybe_synthesize(note_id)  the settle guard; called by processor.py after each
                           source reaches `ready`. Fires run_synthesis exactly
                           once, when the last source lands.
run_synthesis(note_id, m)  builds the multi-source prompt from every ready
                           source, calls the AI layer, writes note_synthesis.

`mode` ('replace' | 'append') is a client-side apply strategy — the draft is
identical either way — so it is logged, not persisted. A client that reloads
mid-run re-decides via its normal replace/append path.
"""
from __future__ import annotations

import logging
import os
import re
from datetime import datetime, timezone

from prompts.note_synthesis import build_note_synthesis_prompt
from services.ai.client import complete
from services.ai.router import complete_with_fallback, pick
from services.database import get_supabase
from services.workspace.dbretry import with_retry

logger = logging.getLogger(__name__)

_FENCE = re.compile(r"^```(?:html)?\s*|\s*```$", re.MULTILINE)
_H1 = re.compile(r"<h1[^>]*>(.*?)</h1>", re.IGNORECASE | re.DOTALL)
_TAGS = re.compile(r"<[^>]+>")
_PENDING = ("queued", "processing")


def _strip_fences(html: str) -> str:
    return _FENCE.sub("", html or "").strip()


def _anchor_tag(anchor_type: str, start) -> str:
    value = float(start or 0)
    if anchor_type == "time":
        s = int(value)
        return f"[{s // 60:02d}:{s % 60:02d}]"
    if anchor_type == "page":
        return f"[page {int(value)}]"
    return f"[section {int(value)}]"


def source_text_from_chunks(source_id: str) -> str:
    """Rebuild a source's tagged text from its anchored chunks.

    Synthesis runs after every source has settled, so the extracted text is no
    longer in memory the way it was for the old per-resource summary. The chunks
    cover the full text and carry the anchor each passage came from, so the
    `[page N]` / `[mm:ss]` / `[section N]` tagging the prompt relies on is
    reconstructed from anchor_type + anchor_start.
    """
    rows = (get_supabase().table("resource_chunks")
            .select("chunk_text,anchor_type,anchor_start")
            .eq("resource_id", source_id).order("chunk_index")
            .execute().data or [])
    parts: list[str] = []
    last_tag: str | None = None
    for r in rows:
        tag = _anchor_tag(r["anchor_type"], r["anchor_start"])
        if tag != last_tag:
            parts.append(tag)
            last_tag = tag
        parts.append(r["chunk_text"])
    return "\n".join(parts)


def ready_sources(note_id: str) -> list[dict]:
    return (get_supabase().table("note_resources").select("*")
            .eq("note_id", note_id).eq("status", "ready")
            .order("order_index").execute().data or [])


def _write(note_id: str, user_id: str, patch: dict) -> None:
    # `applied_at` belongs to the draft that was applied, so any write that moves
    # this row to a new draft must clear it — a PostgREST upsert only touches the
    # columns it is given, and a stale timestamp makes the client ignore the new
    # draft entirely.
    payload = {"note_id": note_id, "user_id": user_id, "applied_at": None, **patch,
               "updated_at": datetime.now(timezone.utc).isoformat()}
    with_retry(lambda: get_supabase().table("note_synthesis")
               .upsert(payload, on_conflict="note_id").execute())


def _claim(note_id: str, user_id: str) -> bool:
    """Claim the right to synthesize this note. `note_synthesis.note_id` is the
    primary key, so this insert is the mutual-exclusion point: when two sibling
    sources settle at the same moment in two background threads, exactly one
    insert wins and the loser no-ops instead of paying for a second LLM call."""
    try:
        get_supabase().table("note_synthesis").insert({
            "note_id": note_id, "user_id": user_id, "status": "running",
            "source_ids": [], "updated_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        return True
    except Exception as e:
        logger.info(f"note {note_id}: synthesis claim not taken ({e})")
        return False


def maybe_synthesize(note_id: str) -> bool:
    """The settle guard. Proceeds only if no source on this note is still
    pending, no synthesis exists yet, and the note has no user content — so
    dropping 3 sources at once produces exactly one synthesis, fired by
    whichever source finishes last. Returns True if it fired."""
    if not note_id:
        return False
    db = get_supabase()
    sources = (db.table("note_resources").select("id,status")
               .eq("note_id", note_id).execute().data or [])
    if any((s.get("status") or "") in _PENDING for s in sources):
        return False
    if (db.table("note_synthesis").select("note_id")
            .eq("note_id", note_id).execute().data):
        return False
    notes = (db.table("notes").select("id,user_id,title,content")
             .eq("id", note_id).execute().data or [])
    if not notes or notes[0].get("content"):
        return False
    if not _claim(note_id, notes[0]["user_id"]):
        return False
    run_synthesis(note_id, "replace")
    return True


def _looks_like_a_mastery_guide(html: str) -> bool:
    """Reject the two observed failure modes for a reasoning-prone free model:
    a chain-of-thought dump that never reaches HTML at all (no <h1>), and a
    response that starts correctly but stops right after the outline (an
    <h1> with no chapter <h2> ever written). A real guide has both, plus
    enough length to hold actual chapter content."""
    if not html or not _H1.search(html):
        return False
    if "<h2" not in html.lower():
        return False
    return len(html) >= 500


def _title_suggestion(html: str) -> str | None:
    m = _H1.search(html or "")
    if not m:
        return None
    title = _TAGS.sub("", m.group(1)).strip()
    return title[:200] or None


def _inherited_titles(note: dict, first_source: dict) -> set[str]:
    """Titles the note could have been auto-assigned at attach time. The
    processor renames a source once it learns the real video/page title, so the
    source's CURRENT title is not enough to recognise an untouched note."""
    titles = {first_source.get("title"), "YouTube video"}
    if note.get("source_url"):
        titles.add(note["source_url"])
    if note.get("source_filename"):
        titles.add(os.path.splitext(os.path.basename(note["source_filename"]))[0])
    return {t for t in titles if t}


def _complete(prompt: str, video_urls: list[str], has_text: bool,
              user_id: str) -> str:
    """Text path, or the Gemini-native video path when a source has no
    transcript (same capability routing the per-resource summary used)."""
    if video_urls:
        provider = pick("summarize_video", user_id)
        if provider is not None and "video_native" in provider.capabilities:
            content: list[dict] = [{"type": "text", "text": prompt}]
            content += [{"type": "video_url", "url": u} for u in video_urls]
            return _strip_fences(complete(
                provider, [{"role": "user", "content": content}], max_tokens=8192))
        if not has_text:
            raise RuntimeError(
                "No transcript for this source and no video-capable provider "
                "configured — add a Gemini key in Settings → AI Providers.")
    return _strip_fences(complete_with_fallback(
        "summarize_text", user_id, [{"role": "user", "content": prompt}],
        max_tokens=8192, validate=_looks_like_a_mastery_guide))


def run_synthesis(note_id: str, mode: str = "replace") -> None:
    db = get_supabase()
    notes = (db.table("notes").select("id,user_id,title,content,source_url,source_filename")
             .eq("id", note_id).execute().data or [])
    if not notes:
        logger.warning(f"run_synthesis: note {note_id} not found")
        return
    note = notes[0]
    user_id = note["user_id"]
    sources = ready_sources(note_id)
    source_ids = [s["id"] for s in sources]
    logger.info(f"synthesizing note {note_id} from {len(sources)} source(s), "
                f"mode={mode}")
    _write(note_id, user_id,
           {"status": "running", "error": None, "source_ids": source_ids})

    if not sources:
        # Nothing extractable yet: leave no synthesis behind at all, so retrying
        # a failed source can still auto-fire the first draft.
        logger.info(f"note {note_id}: no ready sources, releasing the claim")
        try:
            db.table("note_synthesis").delete().eq("note_id", note_id).execute()
        except Exception:
            logger.warning(f"note {note_id}: could not release the synthesis claim")
        return

    try:
        blocks: list[dict] = []
        video_urls: list[str] = []
        for s in sources:
            text = source_text_from_chunks(s["id"])
            if not text:
                if s["kind"] in ("youtube", "video") and s.get("source_url"):
                    video_urls.append(s["source_url"])
                else:
                    logger.warning(f"note {note_id}: source {s['id']} "
                                   f"({s['kind']}) contributed no text — "
                                   f"chunks missing or extraction empty")
                    text = ("(No text could be extracted from this source.)")
            blocks.append({"title": s["title"], "kind": s["kind"], "text": text,
                           "duration": (s.get("meta") or {}).get("duration")})

        has_text = any(b["text"] for b in blocks)
        prompt = build_note_synthesis_prompt(blocks)
        html = _complete(prompt, video_urls, has_text, user_id)
        if not html.strip():
            raise RuntimeError("The model returned an empty draft.")

        suggestion = _title_suggestion(html)
        _write(note_id, user_id, {"status": "ready", "html": html, "error": None,
                                  "source_ids": source_ids,
                                  "title_suggestion": suggestion})
        # A multi-source session should get a topic title instead of inheriting
        # source #1's filename — but never over a title the user typed.
        if suggestion and note.get("title") in _inherited_titles(note, sources[0]):
            db.table("notes").update({"title": suggestion}).eq("id", note_id).execute()
    except Exception as e:
        logger.warning(f"note {note_id}: synthesis failed: {e}")
        _write(note_id, user_id, {"status": "failed", "source_ids": source_ids,
                                  "error": str(e)[:500]})
