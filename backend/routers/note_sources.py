"""Note sources router — one note, many attached sources.

Replaces routers/workspaces.py. A source attaches directly to a note (created
lazily on the first attach, so the first drop is one request rather than
create-then-attach), synthesis is per note, chat is grounded in that note's
sources. The canvas concepts — workspaces, pages, positions, per-resource
summaries — are gone.
"""
from __future__ import annotations

import json
import logging
import os
import uuid
from datetime import datetime, timezone

from fastapi import (APIRouter, BackgroundTasks, File, Form, Header,
                     HTTPException, UploadFile)
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from routers.ingest import get_user_id
from services.database import get_supabase
from services.url_extractor import _youtube_video_id as youtube_video_id
from services.workspace import storage
from services.workspace.chat import run_note_chat
from services.workspace.media import CaptureError, capture, formula_to_latex
from services.workspace.processor import process_resource
from services.workspace.synthesis import run_synthesis

logger = logging.getLogger(__name__)

router = APIRouter(tags=["note-sources"])

_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".m4v"}
_DOC_EXTS = {".pdf", ".md", ".txt"}
_NOTE_SOURCE_TYPE = {"pdf": "pdf", "document": "text", "youtube": "video",
                     "video": "video", "website": "url"}


# ── models ───────────────────────────────────────────────────────────────────

class CaptureRequest(BaseModel):
    type: str  # frame | clip | audio
    start: float
    end: float | None = None


class FormulaRequest(BaseModel):
    element_id: str


class SynthesizeRequest(BaseModel):
    mode: str = "replace"  # replace | append (a client-side apply strategy)


class AnchorRow(BaseModel):
    block_id: str
    resource_id: str
    anchor_type: str
    anchor_start: float
    anchor_end: float = 0


class ChatRequest(BaseModel):
    messages: list[dict]


class ProviderCreate(BaseModel):
    provider: str
    api_key: str
    label: str = ""
    base_url: str | None = None
    chat_model: str | None = None


class ProviderPatch(BaseModel):
    enabled: bool | None = None
    api_key: str | None = None
    chat_model: str | None = None


# ── helpers ──────────────────────────────────────────────────────────────────

def _own_note(note_id: str, user_id: str) -> dict:
    rows = (get_supabase().table("notes").select("id,user_id,title,content")
            .eq("id", note_id).eq("user_id", user_id).execute().data)
    if not rows:
        raise HTTPException(status_code=404, detail={"error": "Note not found"})
    return rows[0]


def _own_source(source_id: str, user_id: str) -> dict:
    rows = (get_supabase().table("note_resources").select("*")
            .eq("id", source_id).eq("user_id", user_id).execute().data)
    if not rows:
        raise HTTPException(status_code=404, detail={"error": "Source not found"})
    return rows[0]


def _source_public(r: dict) -> dict:
    out = dict(r)
    meta = r.get("meta") or {}
    if meta.get("thumbnail_path"):
        try:
            out["thumbnail_url"] = storage.signed_url(meta["thumbnail_path"], 3600)
        except Exception:
            pass
    return out


def _discard_lazy_note(note_id: str, created: bool) -> None:
    """A note created for this attach is meaningless if the attach failed —
    drop it rather than leaving the user an empty, sourceless note they never
    asked for and cannot find."""
    if not created:
        return
    try:
        get_supabase().table("notes").delete().eq("id", note_id).execute()
    except Exception:
        logger.warning(f"could not discard lazily-created note {note_id}")


def _discard_orphan_upload(storage_path: str) -> None:
    """Best-effort: an uploaded blob with no row pointing at it is unreachable."""
    try:
        storage.remove([storage_path])
    except Exception:
        logger.warning(f"could not remove orphaned upload {storage_path}")


def _classify(file: UploadFile | None, url: str | None) -> tuple[str, str, str]:
    """→ (kind, title, ext). Raises 400 on an unsupported or empty input."""
    if file is not None and file.filename:
        ext = os.path.splitext(file.filename)[1].lower()
        if ext in _VIDEO_EXTS:
            kind = "video"
        elif ext in _DOC_EXTS:
            kind = "pdf" if ext == ".pdf" else "document"
        else:
            raise HTTPException(status_code=400, detail={
                "error": f"Unsupported file type '{ext}'. Accepted: "
                         f"{', '.join(sorted(_DOC_EXTS | _VIDEO_EXTS))}"})
        return kind, os.path.splitext(os.path.basename(file.filename))[0], ext
    if url:
        kind = "youtube" if youtube_video_id(url) else "website"
        return kind, ("YouTube video" if kind == "youtube" else url), ""
    raise HTTPException(status_code=400,
                        detail={"error": "Provide a file or a url."})


# ── attach / list / detach ───────────────────────────────────────────────────

@router.post("/sources")
async def attach_source(
    background: BackgroundTasks,
    authorization: str = Header(),
    file: UploadFile | None = File(default=None),
    url: str | None = Form(default=None),
    note_id: str | None = Form(default=None),
    defer: bool = Form(default=False),
):
    """Attach a source. With no note_id, the note is created first — the first
    drop is one request, not create-then-attach."""
    user_id = get_user_id(authorization)
    db = get_supabase()
    url = url.strip() if url else None
    kind, title, ext = _classify(file, url)

    created_note = False
    if note_id:
        _own_note(note_id, user_id)
    else:
        note_id = db.table("notes").insert({
            "user_id": user_id, "title": title, "content": [], "content_text": "",
            "source_type": _NOTE_SOURCE_TYPE.get(kind, "text"),
            "source_url": url,
            "source_filename": (file.filename if file is not None else None),
        }).execute().data[0]["id"]
        created_note = True

    attached = (db.table("note_resources").select("id")
                .eq("note_id", note_id).execute().data or [])
    order_index = len(attached)

    if file is not None and file.filename:
        sid = str(uuid.uuid4())
        spath = f"{user_id}/{sid}/source{ext}"
        data = await file.read()
        try:
            storage.upload(spath, data, file.content_type or "application/octet-stream")
        except Exception as e:
            _discard_lazy_note(note_id, created_note)
            raise HTTPException(status_code=502, detail={"error": f"Upload failed: {e}"})
        try:
            row = db.table("note_resources").insert({
                "id": sid, "note_id": note_id, "user_id": user_id, "kind": kind,
                "title": title, "storage_path": spath, "mime_type": file.content_type,
                "order_index": order_index,
            }).execute().data[0]
        except Exception as e:
            _discard_orphan_upload(spath)
            _discard_lazy_note(note_id, created_note)
            raise HTTPException(status_code=502,
                                detail={"error": f"Could not attach the source: {e}"})
    else:
        try:
            row = db.table("note_resources").insert({
                "note_id": note_id, "user_id": user_id, "kind": kind, "title": title,
                "source_url": url, "order_index": order_index,
            }).execute().data[0]
        except Exception as e:
            _discard_lazy_note(note_id, created_note)
            raise HTTPException(status_code=502,
                                detail={"error": f"Could not attach the source: {e}"})

    # A multi-source drop attaches every source before any processing starts, so
    # the settle guard cannot fire on the first one while the rest are still
    # uploading. The client kicks the batch off with /process-sources.
    if not defer:
        background.add_task(process_resource, row["id"])
    return {"note_id": note_id, "source": _source_public(row), "deferred": defer}


@router.get("/notes/{note_id}/sources")
async def list_sources(note_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    _own_note(note_id, user_id)
    rows = (get_supabase().table("note_resources").select("*")
            .eq("note_id", note_id).order("order_index").execute().data or [])
    return [_source_public(r) for r in rows]


@router.post("/notes/{note_id}/process-sources")
async def process_queued_sources(note_id: str, background: BackgroundTasks,
                                 authorization: str = Header()):
    """Start processing every source on this note that is still queued — the
    second half of a deferred multi-source drop."""
    user_id = get_user_id(authorization)
    _own_note(note_id, user_id)
    rows = (get_supabase().table("note_resources").select("id")
            .eq("note_id", note_id).eq("status", "queued").execute().data or [])
    for r in rows:
        background.add_task(process_resource, r["id"])
    return {"ok": True, "queued": len(rows)}


@router.delete("/sources/{source_id}")
async def detach_source(source_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    r = _own_source(source_id, user_id)
    # best-effort storage cleanup; the note always survives
    try:
        prefix = f"{user_id}/{source_id}"
        objs = get_supabase().storage.from_(storage.BUCKET).list(prefix) or []
        storage.remove([f"{prefix}/{o['name']}" for o in objs])
    except Exception:
        pass
    get_supabase().table("note_resources").delete().eq("id", source_id).execute()
    return {"ok": True, "note_id": r.get("note_id")}


# ── single source ────────────────────────────────────────────────────────────

@router.get("/sources/{source_id}")
async def get_source(source_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    r = _own_source(source_id, user_id)
    elements = (get_supabase().table("resource_elements").select("*")
                .eq("resource_id", source_id)
                .order("page").order("order_index").execute().data or [])
    for el in elements:
        if el.get("image_path"):
            try:
                el["image_url"] = storage.signed_url(el["image_path"], 3600)
            except Exception:
                pass
    out = _source_public(r)
    out["elements"] = elements
    return out


@router.get("/sources/{source_id}/file")
async def source_file_url(source_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    r = _own_source(source_id, user_id)
    if not r.get("storage_path"):
        raise HTTPException(status_code=404,
                            detail={"error": "Source has no stored file"})
    try:
        return {"url": storage.signed_url(r["storage_path"], 3600)}
    except Exception as e:
        raise HTTPException(status_code=502, detail={"error": f"Could not sign URL: {e}"})


@router.post("/sources/{source_id}/reprocess")
async def reprocess_source(source_id: str, background: BackgroundTasks,
                           authorization: str = Header()):
    user_id = get_user_id(authorization)
    _own_source(source_id, user_id)
    get_supabase().table("note_resources").update(
        {"status": "queued", "error": None}).eq("id", source_id).execute()
    background.add_task(process_resource, source_id)
    return {"ok": True}


@router.post("/sources/{source_id}/capture")
async def capture_media(source_id: str, body: CaptureRequest,
                        authorization: str = Header()):
    user_id = get_user_id(authorization)
    r = _own_source(source_id, user_id)
    if r["kind"] not in ("video", "youtube"):
        raise HTTPException(status_code=400,
                            detail={"error": "Capture only works on video sources"})
    try:
        return capture(r, body.type, body.start, body.end)
    except CaptureError as e:
        raise HTTPException(status_code=422, detail={"error": str(e)})


@router.post("/sources/{source_id}/formula-latex")
async def formula_latex(source_id: str, body: FormulaRequest,
                        authorization: str = Header()):
    user_id = get_user_id(authorization)
    _own_source(source_id, user_id)
    rows = (get_supabase().table("resource_elements").select("*")
            .eq("id", body.element_id).eq("user_id", user_id).execute().data)
    if not rows:
        raise HTTPException(status_code=404, detail={"error": "Element not found"})
    el = rows[0]
    if not el.get("image_path"):
        raise HTTPException(status_code=422, detail={"error": "Element has no image crop"})
    try:
        image_bytes = storage.download(el["image_path"])
        return {"latex": formula_to_latex(image_bytes, user_id)}
    except CaptureError as e:
        raise HTTPException(status_code=422, detail={"error": str(e)})
    except Exception as e:
        raise HTTPException(status_code=502, detail={"error": f"Formula OCR failed: {e}"})


# ── synthesis ────────────────────────────────────────────────────────────────

@router.post("/notes/{note_id}/synthesize")
async def synthesize(note_id: str, body: SynthesizeRequest,
                     background: BackgroundTasks, authorization: str = Header()):
    user_id = get_user_id(authorization)
    _own_note(note_id, user_id)
    if body.mode not in ("replace", "append"):
        raise HTTPException(status_code=400,
                            detail={"error": "mode must be 'replace' or 'append'"})
    get_supabase().table("note_synthesis").upsert({
        "note_id": note_id, "user_id": user_id, "status": "queued", "error": None,
        "applied_at": None,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="note_id").execute()
    background.add_task(run_synthesis, note_id, body.mode)
    return {"ok": True, "status": "queued"}


@router.get("/notes/{note_id}/synthesis")
async def get_synthesis(note_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    _own_note(note_id, user_id)
    rows = (get_supabase().table("note_synthesis").select("*")
            .eq("note_id", note_id).eq("user_id", user_id).execute().data)
    if not rows:
        return {"status": "none", "source_ids": []}
    r = rows[0]
    return {"status": r.get("status"), "html": r.get("html"),
            "source_ids": r.get("source_ids") or [],
            "title_suggestion": r.get("title_suggestion"),
            "error": r.get("error"), "applied_at": r.get("applied_at"),
            "updated_at": r.get("updated_at")}


@router.post("/notes/{note_id}/synthesis/applied")
async def mark_synthesis_applied(note_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    _own_note(note_id, user_id)
    now = datetime.now(timezone.utc).isoformat()
    get_supabase().table("note_synthesis").update(
        {"applied_at": now, "updated_at": now}).eq("note_id", note_id).eq(
        "user_id", user_id).execute()
    return {"ok": True, "applied_at": now}


# ── note anchors (note block ↔ source position sync) ─────────────────────────

@router.put("/notes/{note_id}/anchors")
async def put_anchors(note_id: str, body: list[AnchorRow],
                      authorization: str = Header()):
    user_id = get_user_id(authorization)
    _own_note(note_id, user_id)
    db = get_supabase()
    # Only anchors pointing at THIS note's own sources may be stored: a stale id
    # would otherwise fail the insert after the delete has already committed and
    # take every anchor with it, and an unvalidated id is a cross-user reference
    # (this client uses the service role and bypasses RLS).
    own = {str(r["id"]) for r in (db.table("note_resources").select("id")
                                 .eq("note_id", note_id).eq("user_id", user_id)
                                 .execute().data or [])}
    rows = [a for a in body if str(a.resource_id) in own]
    dropped = len(body) - len(rows)
    if dropped:
        logger.warning(f"note {note_id}: dropped {dropped} anchor(s) whose source "
                       f"is not attached to this note")
    db.table("note_anchors").delete().eq("note_id", note_id).execute()
    if rows:
        db.table("note_anchors").insert([
            {"note_id": note_id, "user_id": user_id,
             "resource_id": a.resource_id, "block_id": a.block_id,
             "anchor_type": a.anchor_type,
             "anchor_start": a.anchor_start, "anchor_end": a.anchor_end}
            for a in rows
        ]).execute()
    return {"ok": True, "count": len(rows), "dropped": dropped}


@router.get("/notes/{note_id}/anchors")
async def get_anchors(note_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    return (get_supabase().table("note_anchors").select("*")
            .eq("note_id", note_id).eq("user_id", user_id).execute().data or [])


# ── grounded chat ────────────────────────────────────────────────────────────

@router.post("/notes/{note_id}/chat")
async def note_chat(note_id: str, body: ChatRequest, authorization: str = Header()):
    user_id = get_user_id(authorization)
    _own_note(note_id, user_id)

    async def stream():
        async for ev in run_note_chat(note_id, user_id, body.messages):
            yield "data: " + json.dumps(ev) + "\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


# ── recent sessions (the empty shell's recents strip) ────────────────────────

@router.get("/sessions/recent")
async def recent_sessions(authorization: str = Header(), limit: int = 12):
    user_id = get_user_id(authorization)
    db = get_supabase()
    srcs = (db.table("note_resources").select("note_id,kind,title,order_index")
            .eq("user_id", user_id).order("created_at", desc=True)
            .limit(200).execute().data or [])
    by_note: dict[str, dict] = {}
    for s in srcs:
        entry = by_note.setdefault(s["note_id"], {
            "note_id": s["note_id"], "source_count": 0, "kinds": []})
        entry["source_count"] += 1
        if s["kind"] not in entry["kinds"]:
            entry["kinds"].append(s["kind"])
    if not by_note:
        return []
    notes = (db.table("notes").select("id,title,updated_at,deleted_at")
             .in_("id", list(by_note)).execute().data or [])
    out = []
    for n in notes:
        if n.get("deleted_at"):
            continue
        out.append({**by_note[n["id"]], "title": n.get("title") or "Untitled",
                    "updated_at": n.get("updated_at")})
    out.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return out[:limit]


# ── AI providers ─────────────────────────────────────────────────────────────

@router.get("/ai-providers")
async def list_ai_providers(authorization: str = Header()):
    user_id = get_user_id(authorization)
    rows = (get_supabase().table("ai_providers").select("*")
            .eq("user_id", user_id).order("created_at").execute().data or [])
    for r in rows:
        key = r.pop("api_key", "") or ""
        r["api_key_hint"] = ("…" + key[-4:]) if len(key) >= 8 else "set"
    return rows


@router.post("/ai-providers")
async def create_ai_provider(body: ProviderCreate, authorization: str = Header()):
    user_id = get_user_id(authorization)
    if body.provider not in ("gemini", "anthropic", "openai", "openai_compatible"):
        raise HTTPException(status_code=400, detail={"error": "Unknown provider"})
    if body.provider == "openai_compatible" and not body.base_url:
        raise HTTPException(status_code=400,
                            detail={"error": "openai_compatible needs base_url"})
    row = get_supabase().table("ai_providers").insert({
        "user_id": user_id, "provider": body.provider,
        "label": body.label or body.provider, "api_key": body.api_key,
        "base_url": body.base_url, "chat_model": body.chat_model,
    }).execute().data[0]
    row.pop("api_key", None)
    return row


@router.patch("/ai-providers/{provider_id}")
async def patch_ai_provider(provider_id: str, body: ProviderPatch,
                            authorization: str = Header()):
    user_id = get_user_id(authorization)
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        return {"ok": True}
    rows = (get_supabase().table("ai_providers").update(patch)
            .eq("id", provider_id).eq("user_id", user_id).execute().data)
    if not rows:
        raise HTTPException(status_code=404, detail={"error": "Provider not found"})
    out = rows[0]
    out.pop("api_key", None)
    return out


@router.delete("/ai-providers/{provider_id}")
async def delete_ai_provider(provider_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    get_supabase().table("ai_providers").delete().eq("id", provider_id).eq(
        "user_id", user_id).execute()
    return {"ok": True}
