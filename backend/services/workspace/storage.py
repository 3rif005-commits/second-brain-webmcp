"""Supabase Storage helpers for the workspace-resources bucket.

Object paths are always prefixed with the owning user id
(`{user_id}/{resource_id}/...`) to match the bucket RLS policies.
"""
from __future__ import annotations

from services.database import get_supabase

BUCKET = "workspace-resources"


def upload(path: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    """Upload bytes; returns the object path."""
    get_supabase().storage.from_(BUCKET).upload(
        path, data, file_options={"content-type": content_type, "upsert": "true"}
    )
    return path


def download(path: str) -> bytes:
    return get_supabase().storage.from_(BUCKET).download(path)


def signed_url(path: str, expires_in: int = 3600) -> str:
    res = get_supabase().storage.from_(BUCKET).create_signed_url(path, expires_in)
    return res.get("signedURL") or res.get("signedUrl") or ""


def remove(paths: list[str]) -> None:
    if paths:
        get_supabase().storage.from_(BUCKET).remove(paths)
