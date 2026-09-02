"""Unit tests for routers/notes.py's get_user_id.

Regression coverage for a real production bug: get_user_id used to decode
the Supabase JWT locally with a hardcoded `algorithms=["HS256"]`. Supabase
projects migrated to the newer asymmetric "JWT Signing Keys" feature issue
tokens signed with a different algorithm (e.g. ES256), so the old code
raised `jose.JWTError: 'The specified alg value is not allowed'` on every
authenticated request — surfaced verbatim as an HTTP 401 to the frontend.

Fix: verify remotely via Supabase's own auth API (`auth.get_user(token)`),
the same algorithm-agnostic pattern routers/ingest.py's get_user_id already
uses successfully elsewhere in this codebase, instead of local decoding.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from routers.notes import get_user_id


def _fake_supabase(user_id: str | None):
    client = MagicMock()
    client.auth.get_user.return_value = SimpleNamespace(
        user=SimpleNamespace(id=user_id) if user_id else None
    )
    return client


def test_get_user_id_accepts_a_token_regardless_of_signing_algorithm():
    # The whole point of the fix: no local alg allow-list, so this works
    # identically whether Supabase signed the token with the legacy HS256
    # shared secret or the newer asymmetric JWT Signing Keys.
    with patch("routers.notes.get_supabase", return_value=_fake_supabase("user-123")):
        assert get_user_id("Bearer any-token-shape") == "user-123"


def test_get_user_id_rejects_when_supabase_reports_no_user():
    with patch("routers.notes.get_supabase", return_value=_fake_supabase(None)):
        with pytest.raises(HTTPException) as exc_info:
            get_user_id("Bearer expired-or-invalid")
    assert exc_info.value.status_code == 401


def test_get_user_id_rejects_when_supabase_call_raises():
    client = MagicMock()
    client.auth.get_user.side_effect = RuntimeError("network error")
    with patch("routers.notes.get_supabase", return_value=client):
        with pytest.raises(HTTPException) as exc_info:
            get_user_id("Bearer whatever")
    assert exc_info.value.status_code == 401


def test_get_user_id_strips_the_bearer_prefix_before_verifying():
    client = _fake_supabase("user-456")
    with patch("routers.notes.get_supabase", return_value=client):
        get_user_id("Bearer   raw-jwt-token  ")
    client.auth.get_user.assert_called_once_with("raw-jwt-token")
