"""Retrieval router — index a note and retrieve semantically similar notes."""

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

from routers.ingest import get_user_id
from services.database import get_supabase
from services.embedder import embed
from services.retriever import retrieve

router = APIRouter(prefix="/retrieval", tags=["retrieval"])


class IndexRequest(BaseModel):
    note_id: str
    content_text: str   # plain text to embed
    summary: str = ""
    topics: list[str] = []
    prerequisites: list[str] = []


class RetrieveRequest(BaseModel):
    query: str


# ── Index a note ────────────────────────────────────────────────────────────

@router.post("/index")
async def index_note(body: IndexRequest, authorization: str = Header()):
    """Embed a note's text and upsert into note_index."""
    user_id = get_user_id(authorization)

    if not body.content_text.strip():
        raise HTTPException(status_code=422, detail="content_text is empty.")

    try:
        embedding = embed(body.content_text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Embedding failed: {e}")

    deep_link = f"/brain/{body.note_id}"
    vec_literal = "[" + ",".join(str(v) for v in embedding) + "]"

    db = get_supabase()
    # Upsert: insert or update if note_id already indexed
    db.table("note_index").upsert({
        "note_id": body.note_id,
        "user_id": user_id,
        "embedding": vec_literal,
        "summary": body.summary,
        "topics": body.topics,
        "prerequisites": body.prerequisites,
        "deep_link": deep_link,
    }, on_conflict="note_id").execute()

    # Mark note as indexed
    db.table("notes").update({"is_indexed": True}).eq("id", body.note_id).execute()

    return {"indexed": True, "note_id": body.note_id}


# ── Retrieve similar notes ───────────────────────────────────────────────────

@router.post("/retrieve")
def retrieve_notes(body: RetrieveRequest, authorization: str = Header()):
    """Embed query and return top-K semantically similar notes."""
    user_id = get_user_id(authorization)

    if not body.query.strip():
        raise HTTPException(status_code=422, detail="query is empty.")

    try:
        query_embedding = embed(body.query)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Embedding failed: {e}")

    try:
        results = retrieve(query_embedding, user_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Retrieval failed: {e}")

    return {"results": results}
