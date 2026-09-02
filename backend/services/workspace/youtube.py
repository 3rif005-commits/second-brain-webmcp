"""YouTube resource extraction — transcript with timestamps + metadata.

Reuses the video-id parsing from services/url_extractor.py. Transcript comes
from youtube-transcript-api (no download). Metadata from the keyless oEmbed
endpoint, with yt-dlp --dump-json as the richer fallback.
"""
from __future__ import annotations

import httpx

from services.url_extractor import _youtube_video_id as youtube_video_id


def fetch_metadata(url: str) -> dict:
    """Best-effort {title, author, thumbnail, duration}."""
    meta: dict = {}
    try:
        resp = httpx.get(
            "https://www.youtube.com/oembed",
            params={"url": url, "format": "json"},
            timeout=15,
        )
        if resp.status_code == 200:
            d = resp.json()
            meta = {
                "title": d.get("title"),
                "author": d.get("author_name"),
                "thumbnail": d.get("thumbnail_url"),
            }
    except Exception:
        pass
    return meta


def fetch_transcript(video_id: str) -> list[dict]:
    """[{text, start, duration}] — raises ValueError when captions unavailable."""
    from youtube_transcript_api import YouTubeTranscriptApi

    api = YouTubeTranscriptApi()
    fetched = None
    try:
        fetched = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
    except Exception:
        try:
            tl = api.list(video_id)
            transcript = next(iter(
                list(tl._manually_created_transcripts.values())
                + list(tl._generated_transcripts.values())
            ))
            fetched = transcript.fetch()
        except Exception:
            raise ValueError(
                "No captions available for this YouTube video. "
                "Configure a video-capable provider (Gemini) or pick a captioned video."
            )
    return fetched.to_raw_data()


def _fmt_ts(seconds: float) -> str:
    s = int(seconds)
    if s >= 3600:
        return f"{s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}"
    return f"{s // 60:02d}:{s % 60:02d}"


def transcript_text(snippets: list[dict]) -> str:
    """Timestamp-prefixed transcript for the summary prompt."""
    lines = []
    for s in snippets:
        text = (s.get("text") or "").strip().replace("\n", " ")
        if text:
            lines.append(f"[{_fmt_ts(s.get('start', 0))}] {text}")
    return "\n".join(lines)


def chunk_transcript(snippets: list[dict], window_seconds: float = 75.0) -> list[dict]:
    """Time-anchored chunks: consecutive snippets grouped into ~75s windows."""
    chunks: list[dict] = []
    buf: list[str] = []
    win_start = None
    last_end = 0.0
    idx = 0

    def flush():
        nonlocal idx, buf, win_start
        if buf and win_start is not None:
            chunks.append({
                "chunk_index": idx,
                "chunk_text": " ".join(buf).strip(),
                "anchor_type": "time",
                "anchor_start": round(win_start, 2),
                "anchor_end": round(last_end, 2),
            })
            idx += 1
        buf, win_start = [], None

    for s in snippets:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        start = float(s.get("start", 0))
        dur = float(s.get("duration", 0))
        if win_start is None:
            win_start = start
        buf.append(text)
        last_end = start + dur
        if last_end - win_start >= window_seconds:
            flush()
    flush()
    return chunks
