"""POST /agent/ingest — multipart endpoint for agentic PDF/URL ingestion.

Accepts either a file upload or a url form field. Extracts the source text,
creates an empty note, then streams the agent loop (with note-author skill
auto-loaded) as SSE. Emits ingest_created {note_id} before the LLM call so
the frontend can navigate to the note immediately.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import AsyncIterator

from fastapi import APIRouter, Form, Header, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse

from models.agent import AgentRequest, ChatMessage, Mode
from routers.ingest import get_user_id
from services.agent.engine import run_ingest_turn
from services.agent.skills import SkillRegistry
from services.database import get_supabase
from services.file_extractor import extract_file
from services.indexer import index_note
from services.url_extractor import extract_url

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])

_BUNDLED_SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
_USER_SKILLS_DIR = Path.home() / ".secondbrain" / "skills"

SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".rst", ".csv", ".pptx", ".docx"}


def _get_registry() -> SkillRegistry:
    return SkillRegistry.load([_BUNDLED_SKILLS_DIR, _USER_SKILLS_DIR])


def _create_stub_note(user_id: str, title: str) -> str:
    """Insert an empty note and return its ID."""
    row = (
        get_supabase()
        .table("notes")
        .insert({"user_id": user_id, "title": title, "content": []})
        .execute()
        .data[0]
    )
    return row["id"]


@router.post("/ingest")
async def agent_ingest(
    authorization: str = Header(),
    file: UploadFile | None = File(default=None),
    url: str | None = Form(default=None),
    mode: str = Form(default="api"),
):
    user_id = get_user_id(authorization)

    # --- Source extraction ---
    if file is not None:
        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext not in SUPPORTED_EXTENSIONS:
            raise HTTPException(
                400,
                detail=f"Unsupported file type '{ext}'. Accepted: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
            )
        suffix = ext or ".bin"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(await file.read())
            tmp_path = tmp.name
        try:
            source_text = extract_file(tmp_path, file.filename or "")
        except ValueError as e:
            raise HTTPException(422, detail=str(e))
        finally:
            os.unlink(tmp_path)
        title = file.filename or "Untitled"
    elif url and url.strip():
        try:
            title, source_text = extract_url(url.strip())
        except ValueError as e:
            raise HTTPException(422, detail=str(e))
    else:
        raise HTTPException(400, detail="Provide either a file or a url field.")

    if not source_text.strip():
        raise HTTPException(422, detail="Could not extract text from source.")

    # --- Create stub note ---
    note_id = _create_stub_note(user_id, title)
    ingest_mode = Mode.API if mode == "api" else Mode.LOCAL
    registry = _get_registry()

    async def stream() -> AsyncIterator[bytes]:
        yield ("data: " + json.dumps({"type": "ingest_created", "note_id": note_id}) + "\n\n").encode()

        request = AgentRequest(
            thread_id=None,
            messages=[
                ChatMessage(
                    role="user",
                    content=(
                        f"Create a structured mastery-guide note from the following source "
                        f"material. Note title: \"{title}\". Note ID (use with brain.update_note): "
                        f"{note_id}\n\n---\n\n{source_text[:12000]}"
                    ),
                )
            ],
            query=f"Ingest: {title}",
            mode=ingest_mode,
            current_note_id=note_id,
            surface="ingest",
        )

        async for ev in run_ingest_turn(request, user_id=user_id, skill_registry=registry):
            yield ("data: " + json.dumps(ev) + "\n\n").encode()

        # Index note content after agent has written it
        try:
            index_note(note_id, user_id)
        except Exception:
            logger.exception("post-ingest indexing failed for note %s", note_id)

        yield b"data: [DONE]\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")
