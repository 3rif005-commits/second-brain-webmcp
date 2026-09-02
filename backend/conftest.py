"""Pytest configuration and fixtures."""
import sys
from pathlib import Path
from unittest.mock import MagicMock

# Add backend directory to Python path for imports
sys.path.insert(0, str(Path(__file__).parent))

# Stub out optional heavy dependencies that are not installed in the test venv.
# Only stub a module if it isn't already importable, so a full install still works.
_OPTIONAL_STUBS = [
    "trafilatura",
    "youtube_transcript_api",
    "pptx",
    "docx",
    "fitz",
    "asyncpg",
    "apscheduler",
    "apscheduler.schedulers",
    "apscheduler.schedulers.asyncio",
    "apscheduler.triggers",
    "apscheduler.triggers.interval",
    "openai",
    "mcp",
    "mcp.server",
    "mcp.server.fastmcp",
    "google",
    "google.genai",
    "google.genai.types",
    "jose",
]
for _mod in _OPTIONAL_STUBS:
    if _mod not in sys.modules:
        try:
            __import__(_mod)
        except ImportError:
            sys.modules[_mod] = MagicMock()
