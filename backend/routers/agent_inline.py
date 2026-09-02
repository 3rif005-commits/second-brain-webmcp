"""POST /agent/inline — OpenAI-compatible streaming proxy for xl-ai.

xl-ai's ClientSideTransport sends an OpenAI chat-completions request with
toolChoice: "required", forcing the model to call applyDocumentOperations.
Free models do not support forced tool-calling, so we route inline AI through
a dedicated model (settings.inline_model) that reliably supports it.

Error handling: if the upstream returns a non-200 status we emit a proper SSE
error event so xl-ai can display it rather than silently writing nothing.
"""
from __future__ import annotations

import json

import httpx
from fastapi import APIRouter, Header
from fastapi.responses import StreamingResponse

from core.config import settings
from routers.ingest import get_user_id

router = APIRouter(prefix="/agent", tags=["agent"])

_OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def _inline_endpoint() -> dict:
    """Return the endpoint config for the inline AI model.

    Always uses OpenRouter + settings.inline_model, regardless of the
    global api_provider.  The inline model must support tool_choice=required.
    """
    if not settings.openrouter_api_key:
        raise RuntimeError("OPENROUTER_API_KEY is not set — inline AI requires it")
    return {
        "url": _OPENROUTER_URL,
        "headers": {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.openrouter_api_key}",
        },
        "model": settings.inline_model,
    }


@router.post("/inline")
async def agent_inline(
    body: dict,
    authorization: str = Header(),
):
    """OpenAI-compatible streaming endpoint for xl-ai inline editor AI."""
    get_user_id(authorization)

    endpoint = _inline_endpoint()

    payload = {
        **body,
        "model": endpoint["model"],
        "stream": True,
    }

    async def stream():
        async with httpx.AsyncClient(timeout=120) as client:
            async with client.stream(
                "POST",
                endpoint["url"],
                headers=endpoint["headers"],
                json=payload,
            ) as resp:
                if resp.status_code != 200:
                    # Surface the upstream error as an SSE error event so
                    # xl-ai can display it instead of silently writing nothing.
                    raw = await resp.aread()
                    try:
                        detail = json.loads(raw).get("error", {})
                        msg = detail.get("message", raw.decode()) if isinstance(detail, dict) else str(detail)
                    except Exception:
                        msg = raw.decode()
                    yield f"data: {json.dumps({'type': 'error', 'content': f'Inline AI error ({resp.status_code}): {msg}'})}\n\n".encode()
                    return
                async for chunk in resp.aiter_bytes():
                    yield chunk

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )
