"""Retry helper for Supabase writes that sit behind slow work."""
from __future__ import annotations

import time


def with_retry(fn, attempts: int = 3, backoff: float = 0.5):
    """Retry on transient Supabase disconnects (pooled HTTP/2 connections that
    go stale behind a slow ffmpeg/yt-dlp/whisper/LLM step get dropped
    server-side and raise on the next reuse). Without this, a fully-successful
    capture, transcription or synthesis run can get its terminal status write
    lost and end up mismarked `failed`, forcing a needless full reprocess."""
    for attempt in range(attempts):
        try:
            return fn()
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(backoff * (attempt + 1))
