"""On-demand media capture: frames, clips, audio segments, formula → LaTeX.

Uploaded videos: ffmpeg over the stored file.
YouTube: yt-dlp --download-sections fetches only the needed range, then ffmpeg.
Captures land back in the workspace-resources bucket; callers get a storage path.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
import uuid

from services.workspace import storage
from services.workspace.video import ffmpeg_available

logger = logging.getLogger(__name__)


class CaptureError(Exception):
    pass


def _require_ffmpeg():
    if not ffmpeg_available():
        raise CaptureError("ffmpeg is not installed on the server.")


def _ytdlp_section(url: str, start: float, end: float, out_dir: str) -> str:
    """Download only [start, end] of a YouTube video; returns local file path."""
    if shutil.which("yt-dlp") is None:
        raise CaptureError("yt-dlp is not installed on the server.")
    out_tpl = os.path.join(out_dir, "clip.%(ext)s")
    cmd = [
        "yt-dlp", "--quiet", "--no-warnings",
        "-f", "best[height<=720]/best",
        "--download-sections", f"*{max(0, start)}-{end}",
        "--force-keyframes-at-cuts",
        "-o", out_tpl, url,
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=300, check=True)
    except subprocess.CalledProcessError as e:
        raise CaptureError(f"yt-dlp failed: {e.stderr.decode()[:300]}")
    except subprocess.TimeoutExpired:
        raise CaptureError("yt-dlp timed out.")
    for f in os.listdir(out_dir):
        if f.startswith("clip."):
            return os.path.join(out_dir, f)
    raise CaptureError("yt-dlp produced no output file.")


def _local_source(resource: dict, start: float, end: float, tmp: str) -> tuple[str, float]:
    """Return (local video path, offset of `start` within that file)."""
    if resource["kind"] == "youtube":
        path = _ytdlp_section(resource["source_url"], start, end, tmp)
        return path, 0.0
    if not resource.get("storage_path"):
        raise CaptureError("Resource has no stored file.")
    local = os.path.join(tmp, "source" + os.path.splitext(resource["storage_path"])[1])
    with open(local, "wb") as f:
        f.write(storage.download(resource["storage_path"]))
    return local, start


def capture(resource: dict, capture_type: str, start: float, end: float | None) -> dict:
    """capture_type: frame | clip | audio. Returns {path, url, mime}."""
    _require_ffmpeg()
    user_id = resource["user_id"]
    rid = resource["id"]
    uid = uuid.uuid4().hex[:8]

    with tempfile.TemporaryDirectory() as tmp:
        if capture_type == "frame":
            src, offset = _local_source(resource, start, start + 2.0, tmp)
            out = os.path.join(tmp, "frame.jpg")
            args = ["ffmpeg", "-v", "quiet", "-ss", str(offset), "-i", src,
                    "-frames:v", "1", "-q:v", "3", out]
            dest = f"{user_id}/{rid}/captures/frame-{uid}.jpg"
            mime = "image/jpeg"
        elif capture_type == "clip":
            if end is None or end <= start:
                raise CaptureError("clip capture needs end > start")
            src, offset = _local_source(resource, start, end, tmp)
            out = os.path.join(tmp, "clip.mp4")
            args = ["ffmpeg", "-v", "quiet", "-ss", str(offset), "-i", src,
                    "-t", str(end - start), "-c:v", "libx264", "-preset", "veryfast",
                    "-c:a", "aac", "-movflags", "+faststart", out]
            dest = f"{user_id}/{rid}/captures/clip-{uid}.mp4"
            mime = "video/mp4"
        elif capture_type == "audio":
            if end is None or end <= start:
                raise CaptureError("audio capture needs end > start")
            src, offset = _local_source(resource, start, end, tmp)
            out = os.path.join(tmp, "audio.mp3")
            args = ["ffmpeg", "-v", "quiet", "-ss", str(offset), "-i", src,
                    "-t", str(end - start), "-vn", "-acodec", "libmp3lame", out]
            dest = f"{user_id}/{rid}/captures/audio-{uid}.mp3"
            mime = "audio/mpeg"
        else:
            raise CaptureError(f"Unknown capture type: {capture_type}")

        try:
            subprocess.run(args, capture_output=True, timeout=300, check=True)
        except subprocess.CalledProcessError as e:
            raise CaptureError(f"ffmpeg failed: {(e.stderr or b'').decode()[:300]}")
        except subprocess.TimeoutExpired:
            raise CaptureError("ffmpeg timed out.")

        with open(out, "rb") as f:
            data = f.read()

    storage.upload(dest, data, mime)
    return {"path": dest, "url": storage.signed_url(dest, 86400), "mime": mime}


FORMULA_OCR_PROMPT = (
    "Transcribe the mathematical formula in this image to LaTeX. "
    "Return ONLY the LaTeX code, no surrounding $ delimiters, no explanation."
)


def formula_to_latex(image_bytes: bytes, user_id: str) -> str:
    """Vision-provider OCR of a formula crop → LaTeX. Raises when no vision provider."""
    from services.ai.router import candidates, complete_with_fallback

    if not candidates("formula_ocr", user_id):
        raise CaptureError(
            "No vision-capable AI provider configured. Add a Gemini/OpenAI/Anthropic "
            "key in Settings → AI Providers to enable formula → LaTeX."
        )
    try:
        latex = complete_with_fallback("formula_ocr", user_id, [{
            "role": "user",
            "content": [
                {"type": "text", "text": FORMULA_OCR_PROMPT},
                {"type": "image", "data": image_bytes, "mime": "image/png"},
            ],
        }], max_tokens=1024)
    except RuntimeError as e:
        raise CaptureError(str(e))
    return latex.strip().strip("$").strip()
