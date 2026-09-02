"""Uploaded video processing — ffprobe metadata + optional faster-whisper transcript.

faster-whisper is an OPTIONAL dependency (PyTorch-free but still ~1 GB of
CTranslate2 models on first run). When it isn't installed the resource degrades
gracefully: no transcript → summary is generated from whatever is available
(title-only stub note in the worst case). ffmpeg/ffprobe are system binaries.
"""
from __future__ import annotations

import json
import logging
import shutil
import subprocess

logger = logging.getLogger(__name__)


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


def probe(path: str) -> dict:
    """{duration, width, height} via ffprobe. Empty dict on failure."""
    if not ffmpeg_available():
        return {}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", path],
            capture_output=True, timeout=60, check=True,
        ).stdout
        data = json.loads(out)
        meta: dict = {}
        fmt = data.get("format", {})
        if fmt.get("duration"):
            meta["duration"] = float(fmt["duration"])
        for s in data.get("streams", []):
            if s.get("codec_type") == "video":
                meta["width"] = s.get("width")
                meta["height"] = s.get("height")
                break
        return meta
    except Exception as e:
        logger.warning(f"ffprobe failed: {e}")
        return {}


def whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except ImportError:
        return False


def transcribe(path: str, model_size: str = "base") -> list[dict]:
    """[{text, start, duration}] via faster-whisper (CPU int8).

    Raises RuntimeError when faster-whisper is not installed.
    """
    if not whisper_available():
        raise RuntimeError(
            "faster-whisper not installed — pip install faster-whisper to enable "
            "local transcription of uploaded videos."
        )
    from faster_whisper import WhisperModel

    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(path, beam_size=5, vad_filter=True)
    out = []
    for seg in segments:
        out.append({
            "text": seg.text.strip(),
            "start": float(seg.start),
            "duration": float(seg.end - seg.start),
        })
    return out


def extract_keyframes(path: str, duration: float, count: int = 6) -> list[bytes]:
    """Evenly spaced JPEG keyframes — vision-model fallback when no transcript."""
    if not ffmpeg_available() or duration <= 0:
        return []
    frames = []
    step = duration / (count + 1)
    for i in range(1, count + 1):
        try:
            out = subprocess.run(
                ["ffmpeg", "-ss", str(step * i), "-i", path,
                 "-frames:v", "1", "-f", "image2", "-c:v", "mjpeg", "pipe:1",
                 "-v", "quiet"],
                capture_output=True, timeout=60, check=True,
            ).stdout
            if out:
                frames.append(out)
        except Exception:
            continue
    return frames
