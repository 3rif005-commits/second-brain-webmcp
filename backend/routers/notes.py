from datetime import datetime, timezone
from fastapi import APIRouter, Header, HTTPException, status
from models.note import NoteCreate, NoteUpdate, NoteResponse
from services.database import get_supabase

router = APIRouter(prefix="/notes", tags=["notes"])


def get_user_id(authorization: str = Header()) -> str:
    """Verify the Supabase JWT via Supabase's own auth API rather than
    decoding it locally. Local decoding needs to know the token's signing
    algorithm in advance; Supabase's newer "JWT Signing Keys" projects sign
    with an asymmetric algorithm (e.g. ES256) instead of the legacy shared
    HS256 secret, so a hardcoded `algorithms=["HS256"]` allow-list rejects
    every token from a migrated project with `jose.JWTError: 'The specified
    alg value is not allowed'`. Remote verification is algorithm-agnostic —
    Supabase's own server does the check — matching the pattern
    `routers/ingest.py`'s `get_user_id` already uses.
    """
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


@router.get("/", response_model=list[NoteResponse])
async def list_notes(authorization: str = Header()):
    user_id = get_user_id(authorization)
    db = get_supabase()
    result = (
        db.table("notes")
        .select("*")
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .order("updated_at", desc=True)
        .execute()
    )
    return result.data


@router.get("/trash", response_model=list[NoteResponse])
async def list_trash(authorization: str = Header()):
    user_id = get_user_id(authorization)
    db = get_supabase()
    result = (
        db.table("notes")
        .select("*")
        .eq("user_id", user_id)
        .not_.is_("deleted_at", "null")
        .order("deleted_at", desc=True)
        .execute()
    )
    return result.data


@router.post("/", response_model=NoteResponse, status_code=status.HTTP_201_CREATED)
async def create_note(note: NoteCreate, authorization: str = Header()):
    user_id = get_user_id(authorization)
    db = get_supabase()
    result = (
        db.table("notes")
        .insert({"user_id": user_id, **note.model_dump()})
        .execute()
    )
    return result.data[0]


@router.get("/{note_id}", response_model=NoteResponse)
async def get_note(note_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    db = get_supabase()
    result = (
        db.table("notes")
        .select("*")
        .eq("id", note_id)
        .eq("user_id", user_id)
        .is_("deleted_at", "null")
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Note not found")
    return result.data


@router.patch("/{note_id}", response_model=NoteResponse)
async def update_note(note_id: str, update: NoteUpdate, authorization: str = Header()):
    user_id = get_user_id(authorization)
    db = get_supabase()
    payload = update.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = (
        db.table("notes")
        .update(payload)
        .eq("id", note_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Note not found")
    return result.data[0]


@router.patch("/{note_id}/restore", response_model=NoteResponse)
async def restore_note(note_id: str, authorization: str = Header()):
    user_id = get_user_id(authorization)
    db = get_supabase()
    result = (
        db.table("notes")
        .update({"deleted_at": None})
        .eq("id", note_id)
        .eq("user_id", user_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Note not found")
    return result.data[0]


@router.delete("/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_note(note_id: str, authorization: str = Header()):
    """Soft delete — moves note to Trash."""
    user_id = get_user_id(authorization)
    db = get_supabase()
    db.table("notes").update(
        {"deleted_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", note_id).eq("user_id", user_id).execute()


@router.delete("/{note_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
async def permanent_delete_note(note_id: str, authorization: str = Header()):
    """Hard delete — cannot be undone."""
    user_id = get_user_id(authorization)
    db = get_supabase()
    db.table("notes").delete().eq("id", note_id).eq("user_id", user_id).execute()
