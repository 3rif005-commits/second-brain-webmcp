"""Web article and YouTube extraction.

- YouTube URLs  → youtube-transcript-api (captions, no download needed)
- Everything else → trafilatura (article text)
"""

import re
import trafilatura


def _youtube_video_id(url: str) -> str | None:
    """Return the video ID if the URL is a YouTube watch/short URL, else None."""
    patterns = [
        r"(?:youtube\.com/watch\?.*v=)([A-Za-z0-9_-]{11})",
        r"(?:youtu\.be/)([A-Za-z0-9_-]{11})",
        r"(?:youtube\.com/shorts/)([A-Za-z0-9_-]{11})",
        r"(?:youtube\.com/embed/)([A-Za-z0-9_-]{11})",
    ]
    for pat in patterns:
        m = re.search(pat, url)
        if m:
            return m.group(1)
    return None


def _extract_youtube(video_id: str, url: str) -> tuple[str, str]:
    from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled

    api = YouTubeTranscriptApi()

    # Try English first via direct fetch, then fall back to listing all available
    fetched = None
    try:
        fetched = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
    except Exception:
        pass

    if fetched is None:
        try:
            tl = api.list(video_id)
            try:
                transcript = tl.find_manually_created_transcript(["en", "en-US", "en-GB"])
            except NoTranscriptFound:
                transcript = tl.find_generated_transcript(["en", "en-US", "en-GB"])
            fetched = transcript.fetch()
        except (NoTranscriptFound, TranscriptsDisabled):
            # last resort: grab whatever language is available
            try:
                tl = api.list(video_id)
                transcript = next(iter(tl._manually_created_transcripts.values() or
                                       tl._generated_transcripts.values()))
                fetched = transcript.fetch()
            except Exception:
                raise ValueError(
                    "No captions available for this YouTube video. "
                    "Try a video that has auto-generated or manual subtitles."
                )

    snippets = fetched.to_raw_data()
    body = " ".join(s["text"].strip() for s in snippets if s.get("text", "").strip())

    if not body:
        raise ValueError("Transcript was empty.")

    # best-effort title from YouTube page
    title = f"YouTube – {video_id}"
    try:
        downloaded = trafilatura.fetch_url(url)
        if downloaded:
            meta = trafilatura.extract_metadata(downloaded)
            if meta and meta.title:
                title = meta.title
    except Exception:
        pass

    return title, body


def extract_url(url: str) -> tuple[str, str]:
    """
    Fetch and extract the main content of a URL.
    Returns (title, body_text).
    Raises ValueError if extraction fails.
    """
    video_id = _youtube_video_id(url)
    if video_id:
        return _extract_youtube(video_id, url)

    # Generic web article via trafilatura
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise ValueError(f"Could not fetch URL: {url}")

    result = trafilatura.extract(
        downloaded,
        include_comments=False,
        include_tables=True,
        no_fallback=False,
        output_format="txt",
    )
    if not result:
        raise ValueError("Could not extract readable content from the page.")

    metadata = trafilatura.extract_metadata(downloaded)
    title = (metadata.title if metadata and metadata.title else "") or url

    return title, result
