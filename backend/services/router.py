"""SmartRouter — routes generation requests: LiteRT tablet → llama.cpp laptop → OpenRouter.

Priority:
  1. LiteRT tablet  (if LITERT_URL set and tablet responds within 2 s)
  2. llama.cpp local (if LLM_PROVIDER=llamacpp)
  3. OpenRouter      (always available cloud fallback)

Health status is cached for 30 s so we don't ping the tablet on every token request.
"""

import time
import logging
import httpx
from core.config import settings

logger = logging.getLogger(__name__)

HEALTH_TTL = 30          # seconds between tablet health re-checks
HEALTH_TIMEOUT = 2.0     # seconds to wait for tablet health response

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"


class SmartRouter:
    def __init__(self) -> None:
        self._tablet_alive: bool = False
        self._last_check: float = 0.0

    def _probe_tablet(self) -> bool:
        """Synchronous health probe — called at most once per HEALTH_TTL seconds."""
        url = settings.litert_url
        if not url:
            return False
        try:
            resp = httpx.get(f"{url}/health", timeout=HEALTH_TIMEOUT)
            alive = resp.status_code == 200
        except Exception:
            alive = False
        logger.info(f"smartrouter | tablet_probe | alive={alive} | url={url}")
        return alive

    def _tablet_ok(self) -> bool:
        now = time.monotonic()
        if now - self._last_check >= HEALTH_TTL:
            self._tablet_alive = self._probe_tablet()
            self._last_check = now
        return self._tablet_alive

    def get_endpoint(self) -> dict:
        """Return the best available generation endpoint.

        Returns a dict with:
          url      — full completions URL
          headers  — HTTP headers (auth included)
          model    — model name string for the payload
          source   — 'tablet' | 'llamacpp' | 'openrouter'
        """
        # 1. LiteRT tablet
        if self._tablet_ok():
            logger.info("smartrouter | routing → tablet")
            return {
                "url": f"{settings.litert_url}/v1/chat/completions",
                "headers": {"Content-Type": "application/json"},
                "model": settings.llamacpp_model,
                "source": "tablet",
            }

        # 2. Local llama.cpp (llama.cpp prize path)
        if settings.llm_provider == "llamacpp":
            logger.info("smartrouter | routing → llamacpp")
            return {
                "url": f"{settings.llamacpp_base_url}/v1/chat/completions",
                "headers": {"Content-Type": "application/json"},
                "model": settings.llamacpp_model,
                "source": "llamacpp",
            }

        # 3. OpenRouter fallback
        logger.info("smartrouter | routing → openrouter")
        return {
            "url": OPENROUTER_URL,
            "headers": {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {settings.openrouter_api_key}",
            },
            "model": OPENROUTER_MODEL,
            "source": "openrouter",
        }

    def invalidate(self) -> None:
        """Force a fresh health probe on the next request (e.g. after a timeout)."""
        self._last_check = 0.0


smart_router = SmartRouter()
