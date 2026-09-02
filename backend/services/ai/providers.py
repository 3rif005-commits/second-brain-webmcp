"""Provider registry for the provider-agnostic AI layer.

A provider = a configured way to reach a model API, with a capability set.
Sources, in priority order:
  1. rows in the ai_providers table for this user (user-configured keys)
  2. .env fallbacks (google_api_key → gemini, anthropic/openai/openrouter keys)
  3. the local Gemma endpoint via SmartRouter (always present, text-only)

Capabilities:
  text          — chat/completion over text
  vision        — image inputs
  video_native  — native video understanding (file or YouTube URL)
  long_context  — ≥100K token context
"""
from __future__ import annotations

from dataclasses import dataclass, field

from core.config import settings

DEFAULT_MODELS = {
    "gemini": "gemini-2.0-flash",
    "anthropic": "claude-sonnet-4-6",
    "openai": "gpt-4o-mini",
    "openai_compatible": settings.api_model_openrouter,
}

CAPABILITIES = {
    "gemini": {"text", "vision", "video_native", "long_context"},
    "anthropic": {"text", "vision", "long_context"},
    "openai": {"text", "vision", "long_context"},
    "openai_compatible": {"text"},   # conservative: unknown gateway models
    "local": {"text"},
}


@dataclass
class Provider:
    provider: str                    # gemini | anthropic | openai | openai_compatible | local
    api_key: str = ""
    base_url: str = ""               # openai_compatible only
    chat_model: str = ""
    label: str = ""
    capabilities: set[str] = field(default_factory=set)

    @property
    def model(self) -> str:
        return self.chat_model or DEFAULT_MODELS.get(self.provider, "")


def _env_providers() -> list[Provider]:
    """Providers derived from .env settings (server-level configuration)."""
    out: list[Provider] = []
    if settings.google_api_key:
        out.append(Provider("gemini", api_key=settings.google_api_key,
                            label="Gemini (.env)", capabilities=set(CAPABILITIES["gemini"])))
    if settings.anthropic_api_key:
        out.append(Provider("anthropic", api_key=settings.anthropic_api_key,
                            chat_model=settings.api_model_anthropic,
                            label="Anthropic (.env)", capabilities=set(CAPABILITIES["anthropic"])))
    if settings.openai_api_key:
        out.append(Provider("openai", api_key=settings.openai_api_key,
                            chat_model=settings.api_model_openai,
                            label="OpenAI (.env)", capabilities=set(CAPABILITIES["openai"])))
    if settings.openrouter_api_key:
        out.append(Provider("openai_compatible", api_key=settings.openrouter_api_key,
                            base_url="https://openrouter.ai/api/v1",
                            chat_model=settings.api_model_openrouter,
                            label="OpenRouter (.env)",
                            capabilities=set(CAPABILITIES["openai_compatible"])))
    return out


def _user_providers(user_id: str) -> list[Provider]:
    from services.database import get_supabase
    try:
        rows = (
            get_supabase()
            .table("ai_providers")
            .select("*")
            .eq("user_id", user_id)
            .eq("enabled", True)
            .execute()
            .data
            or []
        )
    except Exception:
        return []
    out = []
    for r in rows:
        p = r["provider"]
        out.append(Provider(
            provider=p,
            api_key=r.get("api_key") or "",
            base_url=r.get("base_url") or "",
            chat_model=r.get("chat_model") or "",
            label=r.get("label") or p,
            capabilities=set(CAPABILITIES.get(p, {"text"})),
        ))
    return out


def local_provider() -> Provider:
    return Provider("local", label="Local (Gemma)", capabilities=set(CAPABILITIES["local"]))


def list_providers(user_id: str) -> list[Provider]:
    """All usable providers for a user: user-configured first, then env, then local."""
    return _user_providers(user_id) + _env_providers() + [local_provider()]
