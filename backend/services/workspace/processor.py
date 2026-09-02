"""Source processing pipeline — runs in the background after a source attaches.

process_resource(resource_id):
  queued → processing → ready | failed

Steps (per kind): extract content → store selectable elements → anchored chunks
+ embeddings (grounded chat AND the text synthesis reassembles) → meta → ready →
maybe_synthesize(note_id).

There is no per-source summary and no per-source output note: the note already
exists (it is what the source attached to), and the AI draft is one synthesis
across every source on that note (services/workspace/synthesis.py).

Failure policy:
  extraction failure → status=failed (nothing usable)
  embedding failure  → warn, continue; chunk rows still inserted unembedded so
                       synthesis can still read the source text (chat degrades)
  synthesis failure  → recorded on note_synthesis, never fails the source
"""
from __future__ import annotations

import logging
import os
import tempfile

from services.database import get_supabase
from services.embedder import embed_batch
from services.workspace import storage
from services.workspace.dbretry import with_retry
from services.workspace.synthesis import maybe_synthesize

logger = logging.getLogger(__name__)


def _pg_safe(text: str | None) -> str | None:
    """Postgres text columns reject a literal NUL byte outright (error
    22P05, "\\u0000 cannot be converted to text") — a known artifact of
    PDF text extraction on malformed/binary-embedded content streams.
    Strip it before any extracted text reaches an insert."""
    if text is None:
        return None
    return text.replace("\x00", "")


def _set_status(rid: str, status: str, error: str | None = None) -> None:
    patch: dict = {"status": status, "error": error}
    with_retry(lambda: get_supabase().table("note_resources")
               .update(patch).eq("id", rid).execute())


def _save_meta(rid: str, meta: dict) -> None:
    with_retry(lambda: get_supabase().table("note_resources")
               .update({"meta": meta}).eq("id", rid).execute())


def _insert_elements(resource: dict, elements: list[dict]) -> None:
    db = get_supabase()
    db.table("resource_elements").delete().eq("resource_id", resource["id"]).execute()
    rows = []
    for i, el in enumerate(elements):
        image_path = None
        if el.get("image_bytes"):
            image_path = f"{resource['user_id']}/{resource['id']}/elements/{i}.png"
            try:
                storage.upload(image_path, el["image_bytes"], "image/png")
            except Exception as e:
                logger.warning(f"element image upload failed: {e}")
                image_path = None
        rows.append({
            "resource_id": resource["id"],
            "user_id": resource["user_id"],
            "page": el.get("page", 0),
            "element_type": el["element_type"],
            "order_index": el.get("order_index", i),
            "bbox": el.get("bbox"),
            "content": _pg_safe(el.get("content")),
            "image_path": image_path,
        })
    for start in range(0, len(rows), 200):
        db.table("resource_elements").insert(rows[start:start + 200]).execute()


def _insert_chunks(resource: dict, chunks: list[dict]) -> None:
    if not chunks:
        return
    db = get_supabase()
    db.table("resource_chunks").delete().eq("resource_id", resource["id"]).execute()
    embeddings: list | None = None
    try:
        embeddings = embed_batch([c["chunk_text"] for c in chunks])
    except Exception as e:
        # Chat degrades for this source, but the chunk TEXT is what synthesis
        # reassembles the source from — so the rows still go in, unembedded.
        logger.warning(f"resource {resource['id']}: embedding skipped: {e}")
    rows = []
    for i, c in enumerate(chunks):
        row = {
            "resource_id": resource["id"],
            "note_id": resource["note_id"],
            "user_id": resource["user_id"],
            "chunk_index": c["chunk_index"],
            "chunk_text": _pg_safe(c["chunk_text"]),
            "anchor_type": c["anchor_type"],
            "anchor_start": c["anchor_start"],
            "anchor_end": c["anchor_end"],
        }
        if embeddings is not None:
            row["embedding"] = "[" + ",".join(str(v) for v in embeddings[i]) + "]"
        rows.append(row)
    for start in range(0, len(rows), 200):
        db.table("resource_chunks").insert(rows[start:start + 200]).execute()


def process_resource(resource_id: str) -> None:
    db = get_supabase()
    rows = db.table("note_resources").select("*").eq("id", resource_id).execute().data
    if not rows:
        logger.warning(f"process_resource: {resource_id} not found")
        return
    resource = rows[0]
    _set_status(resource_id, "processing")
    meta = dict(resource.get("meta") or {})

    try:
        source_text = ""
        video_url: str | None = None

        if resource["kind"] in ("pdf", "document"):
            from services.workspace.pdf_elements import extract_pdf, chunk_pages
            suffix = os.path.splitext(resource.get("storage_path") or "")[1] or ".pdf"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(storage.download(resource["storage_path"]))
                tmp_path = tmp.name
            try:
                if suffix == ".pdf":
                    data = extract_pdf(tmp_path)
                    meta.update({"pages": data["page_count"],
                                 "page_sizes": data["page_sizes"]})
                    # first-page thumbnail
                    try:
                        import fitz
                        doc = fitz.open(tmp_path)
                        pix = doc[0].get_pixmap(dpi=72)
                        tpath = f"{resource['user_id']}/{resource_id}/thumbnail.png"
                        storage.upload(tpath, pix.tobytes("png"), "image/png")
                        meta["thumbnail_path"] = tpath
                        doc.close()
                    except Exception:
                        pass
                    _insert_elements(resource, data["elements"])
                    _insert_chunks(resource, chunk_pages(data["pages_text"]))
                    source_text = "\n\n".join(data["pages_text"])
                else:
                    # md/txt documents: single text, page = 1
                    with open(tmp_path, encoding="utf-8", errors="replace") as f:
                        raw = f.read()
                    source_text = f"[page 1]\n{raw}"
                    _insert_chunks(resource, chunk_pages([source_text]))
            finally:
                os.unlink(tmp_path)

        elif resource["kind"] == "youtube":
            from services.workspace import youtube
            vid = youtube.youtube_video_id(resource["source_url"] or "")
            if not vid:
                raise ValueError("Not a recognizable YouTube URL.")
            ometa = youtube.fetch_metadata(resource["source_url"])
            meta.update({k: v for k, v in ometa.items() if v})
            if ometa.get("title") and resource["title"].startswith("YouTube"):
                db.table("note_resources").update(
                    {"title": ometa["title"]}).eq("id", resource_id).execute()
                resource["title"] = ometa["title"]
            try:
                snippets = youtube.fetch_transcript(vid)
                source_text = youtube.transcript_text(snippets)
                meta["has_transcript"] = True
                _insert_chunks(resource, youtube.chunk_transcript(snippets))
            except ValueError:
                meta["has_transcript"] = False
                video_url = resource["source_url"]  # gemini-native path

        elif resource["kind"] == "video":
            from services.workspace import video as vsvc
            suffix = os.path.splitext(resource.get("storage_path") or "")[1] or ".mp4"
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
                tmp.write(storage.download(resource["storage_path"]))
                tmp_path = tmp.name
            try:
                meta.update(vsvc.probe(tmp_path))
                try:
                    snippets = vsvc.transcribe(tmp_path)
                    from services.workspace import youtube as yts
                    source_text = yts.transcript_text(snippets)
                    meta["has_transcript"] = True
                    _insert_chunks(resource, yts.chunk_transcript(snippets))
                except RuntimeError as e:
                    logger.warning(f"resource {resource_id}: {e}")
                    meta["has_transcript"] = False
            finally:
                os.unlink(tmp_path)

        elif resource["kind"] == "website":
            from services.workspace.website import extract_website, chunk_sections
            data = extract_website(resource["source_url"])
            meta.update({k: v for k, v in data["meta"].items() if v})
            if data["title"] and resource["title"] in ("Untitled source", resource["source_url"]):
                db.table("note_resources").update(
                    {"title": data["title"]}).eq("id", resource_id).execute()
                resource["title"] = data["title"]
            elements = [
                {"page": 0, "element_type": "image" if s["kind"] == "image"
                 else ("heading" if s["kind"] == "heading" else "text"),
                 "order_index": s["index"], "bbox": None,
                 "content": s["content"], "image_bytes": None}
                for s in data["sections"]
            ]
            _insert_elements(resource, elements)
            _insert_chunks(resource, chunk_sections(data["sections"]))
            source_text = data["tagged_text"]

        else:
            raise ValueError(f"Unknown resource kind: {resource['kind']}")

        _save_meta(resource_id, meta)
        _set_status(resource_id, "ready")
        logger.info(f"source {resource_id} ready (kind={resource['kind']})")

        # One note per session: the last source to settle fires the single
        # synthesis across every source on this note. Never fails the source.
        try:
            maybe_synthesize(resource.get("note_id"))
        except Exception as e:
            logger.warning(f"source {resource_id}: synthesis trigger failed: {e}")

    except Exception as e:
        logger.exception(f"resource {resource_id} processing failed")
        _set_status(resource_id, "failed", str(e)[:500])
