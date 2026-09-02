"""Ingest router — PDF, URL, and audio/video ingestion pipeline."""

import logging
import os
import tempfile
import time
import uuid
from fastapi import APIRouter, Header, HTTPException, Request, UploadFile, File, Form, status
from pydantic import BaseModel

from core.config import settings
from services.database import get_supabase
from services.embedder import embed, embed_batch
from services.chunker import split as split_chunks
from services.file_extractor import extract_file
from services.url_extractor import extract_url
from services.llm import generate_mastery_guide, extract_metadata

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", str(uuid.uuid4())[:8])


def get_user_id(authorization: str) -> str:
    """Validate the Supabase JWT via the Supabase auth API."""
    token = authorization.removeprefix("Bearer ").strip()
    try:
        response = get_supabase().auth.get_user(token)
        if not response.user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail={"error": "Invalid or expired token.", "error_code": "AUTH_INVALID"},
            )
        return response.user.id
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": f"Token validation failed: {e}", "error_code": "AUTH_ERROR"},
        )


class UrlIngestRequest(BaseModel):
    url: str


def _try_index_note(note_id: str, user_id: str, content_text: str, topics: list[str], rid: str) -> None:
    """Embed note and upsert into note_index. Silently skipped if embedder is unreachable."""
    try:
        embedding = embed(content_text)
        vec_literal = "[" + ",".join(str(v) for v in embedding) + "]"
        db = get_supabase()
        db.table("note_index").upsert({
            "note_id": note_id,
            "user_id": user_id,
            "embedding": vec_literal,
            "summary": content_text[:500],
            "topics": topics,
            "prerequisites": [],
            "deep_link": f"/brain/{note_id}",
        }, on_conflict="note_id").execute()
        db.table("notes").update({"is_indexed": True}).eq("id", note_id).execute()
        logger.info(f"rid={rid} | step=index_note | note_id={note_id} | indexed=True")
    except Exception as e:
        logger.warning(f"rid={rid} | step=index_note | skipped (embedder unavailable): {e}")


def _try_chunk_note(note_id: str, user_id: str, content_text: str, rid: str) -> None:
    """Split note into chunks, embed each, upsert into note_chunks. Silent on failure."""
    try:
        chunks = split_chunks(content_text)
        if not chunks:
            return
        texts = [c["chunk_text"] for c in chunks]
        embeddings = embed_batch(texts)
        db = get_supabase()
        # Remove stale chunks before reinserting
        db.table("note_chunks").delete().eq("note_id", note_id).execute()
        rows = [
            {
                "note_id": note_id,
                "user_id": user_id,
                "chunk_index": c["chunk_index"],
                "chunk_text": c["chunk_text"],
                "embedding": "[" + ",".join(str(v) for v in emb) + "]",
            }
            for c, emb in zip(chunks, embeddings)
        ]
        db.table("note_chunks").insert(rows).execute()
        logger.info(f"rid={rid} | step=chunk_note | note_id={note_id} | chunks={len(rows)}")
    except Exception as e:
        logger.warning(f"rid={rid} | step=chunk_note | skipped: {e}")


SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".rst", ".csv", ".pptx", ".docx"}


@router.post("/pdf")
async def ingest_pdf(
    request: Request,
    file: UploadFile = File(...),
    authorization: str = Header(),
    x_llm_model: str | None = Header(default=None),
):
    rid = _request_id(request)
    t_total = time.perf_counter()
    logger.info(f"rid={rid} | ingest_file_start | file={file.filename} | model={x_llm_model or 'default'}")

    user_id = get_user_id(authorization)

    filename = file.filename or ""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail={
                "error": f"Unsupported file type '{ext}'. Accepted: PDF, TXT, MD, RST, CSV, PPTX, DOCX.",
                "error_code": "INVALID_FILE_TYPE",
            },
        )

    suffix = ext if ext else ".bin"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        t0 = time.perf_counter()
        source_text = extract_file(tmp_path, filename)
        logger.info(f"rid={rid} | step=extract_file | ext={ext} | {int((time.perf_counter()-t0)*1000)}ms | chars={len(source_text)}")
    except ValueError as e:
        raise HTTPException(status_code=422, detail={"error": str(e), "error_code": "EXTRACT_FAILED"})
    finally:
        os.unlink(tmp_path)

    if not source_text.strip():
        raise HTTPException(
            status_code=422,
            detail={"error": "Could not extract text from file.", "error_code": "PDF_NO_TEXT"},
        )

    t0 = time.perf_counter()
    html_content = generate_mastery_guide(source_text, title=file.filename, model_override=x_llm_model, request_id=rid)
    logger.info(f"rid={rid} | step=generate_guide | {int((time.perf_counter()-t0)*1000)}ms")

    title = file.filename or "Untitled"
    topics: list[str] = []
    if x_llm_model != "llamacpp" and settings.llm_provider != "llamacpp":
        try:
            t0 = time.perf_counter()
            meta = extract_metadata(source_text, model_override=x_llm_model, request_id=rid)
            title = meta.get("title") or title
            topics = meta.get("topics") or []
            logger.info(f"rid={rid} | step=extract_metadata | {int((time.perf_counter()-t0)*1000)}ms")
        except Exception as e:
            logger.warning(f"rid={rid} | step=extract_metadata | skipped: {e}")

    source_type = "pdf" if ext == ".pdf" else "file"
    db = get_supabase()
    result = (
        db.table("notes")
        .insert({
            "user_id": user_id,
            "title": title,
            "content": [],
            "content_text": source_text[:10000],
            "source_type": source_type,
            "source_filename": file.filename,
            "topics": topics,
        })
        .execute()
    )
    note = result.data[0]
    logger.info(
        f"rid={rid} | ingest_pdf_done | note_id={note['id']} | {int((time.perf_counter()-t_total)*1000)}ms"
    )

    _try_index_note(note["id"], user_id, source_text[:10000], topics, rid)
    _try_chunk_note(note["id"], user_id, source_text[:10000], rid)
    return {"note_id": note["id"], "title": title, "html": html_content, "topics": topics}


@router.post("/url")
async def ingest_url(
    request: Request,
    body: UrlIngestRequest,
    authorization: str = Header(),
    x_llm_model: str | None = Header(default=None),
):
    rid = _request_id(request)
    t_total = time.perf_counter()
    logger.info(f"rid={rid} | ingest_url_start | url={body.url[:80]} | model={x_llm_model or 'default'}")

    user_id = get_user_id(authorization)

    try:
        t0 = time.perf_counter()
        title, source_text = extract_url(body.url)
        logger.info(f"rid={rid} | step=extract_url | {int((time.perf_counter()-t0)*1000)}ms | chars={len(source_text)}")
    except ValueError as e:
        raise HTTPException(
            status_code=422,
            detail={"error": str(e), "error_code": "URL_EXTRACT_FAILED"},
        )

    t0 = time.perf_counter()
    html_content = generate_mastery_guide(source_text, title=title, model_override=x_llm_model, request_id=rid)
    logger.info(f"rid={rid} | step=generate_guide | {int((time.perf_counter()-t0)*1000)}ms")

    topics: list[str] = []
    if x_llm_model != "llamacpp" and settings.llm_provider != "llamacpp":
        try:
            t0 = time.perf_counter()
            meta = extract_metadata(source_text, model_override=x_llm_model, request_id=rid)
            topics = meta.get("topics") or []
            logger.info(f"rid={rid} | step=extract_metadata | {int((time.perf_counter()-t0)*1000)}ms")
        except Exception as e:
            logger.warning(f"rid={rid} | step=extract_metadata | skipped: {e}")

    db = get_supabase()
    result = (
        db.table("notes")
        .insert({
            "user_id": user_id,
            "title": title,
            "content": [],
            "content_text": source_text[:10000],
            "source_type": "url",
            "source_url": body.url,
            "topics": topics,
        })
        .execute()
    )
    note = result.data[0]
    logger.info(
        f"rid={rid} | ingest_url_done | note_id={note['id']} | {int((time.perf_counter()-t_total)*1000)}ms"
    )

    _try_index_note(note["id"], user_id, source_text[:10000], topics, rid)
    _try_chunk_note(note["id"], user_id, source_text[:10000], rid)
    return {"note_id": note["id"], "title": title, "html": html_content, "topics": topics}


@router.post("/")
async def ingest_auto(
    request: Request,
    authorization: str = Header(),
    x_llm_model: str | None = Header(default=None),
):
    content_type = request.headers.get("content-type", "")

    if "application/json" in content_type:
        body = await request.json()
        url = body.get("url", "").strip()
        if url:
            return await ingest_url(
                request=request,
                body=UrlIngestRequest(url=url),
                authorization=authorization,
                x_llm_model=x_llm_model,
            )

    elif "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        url = (form.get("url") or "").strip()
        if file and hasattr(file, "filename"):
            return await ingest_pdf(
                request=request,
                file=file,  # type: ignore[arg-type]
                authorization=authorization,
                x_llm_model=x_llm_model,
            )
        if url:
            return await ingest_url(
                request=request,
                body=UrlIngestRequest(url=url),
                authorization=authorization,
                x_llm_model=x_llm_model,
            )

    raise HTTPException(
        status_code=400,
        detail={"error": "Provide either a file or a url.", "error_code": "MISSING_INPUT"},
    )

