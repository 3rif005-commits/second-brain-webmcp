"""Model router — two modes (Local / API). User toggles which is active.

Local mode reuses the existing SmartRouter (tablet primary, llama.cpp fallback).
API mode picks the user's configured cloud provider.
"""
from __future__ import annotations

from typing import Any, Literal

from core.config import settings
from models.agent import Mode
from services.router import smart_router


def get_endpoint(mode: Mode, task: Literal["chat", "classify"] = "chat") -> dict[str, Any]:
    """Return endpoint config: {url, headers, model, source}.

    Raises RuntimeError if the chosen mode is unusable (missing API key,
    no local backend reachable).
    """
    if mode == Mode.LOCAL:
        return smart_router.get_endpoint()

    # API mode
    provider = settings.api_provider
    if provider == "openrouter":
        if not settings.openrouter_api_key:
            raise RuntimeError("OpenRouter API key not configured")
        return {
            "url": "https://openrouter.ai/api/v1/chat/completions",
            "headers": {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.openrouter_api_key}",
            },
            "model": settings.api_model_openrouter,
            "source": "openrouter",
        }
    if provider == "anthropic":
        if not settings.anthropic_api_key:
            raise RuntimeError("Anthropic API key not configured")
        return {
            "url": "https://api.anthropic.com/v1/messages",
            "headers": {
                "Content-Type": "application/json",
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": "2023-06-01",
            },
            "model": settings.api_model_anthropic,
            "source": "anthropic",
        }
    if provider == "openai":
        if not settings.openai_api_key:
            raise RuntimeError("OpenAI API key not configured")
        return {
            "url": "https://api.openai.com/v1/chat/completions",
            "headers": {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.openai_api_key}",
            },
            "model": settings.api_model_openai,
            "source": "openai",
        }
    raise RuntimeError(f"Unknown api_provider: {provider}")
