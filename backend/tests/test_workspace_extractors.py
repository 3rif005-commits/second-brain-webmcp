"""Tests for workspace extraction helpers: page/transcript/section chunking,
math-density heuristics, and website extraction (trafilatura mocked)."""
from unittest.mock import MagicMock, patch

from services.workspace.pdf_elements import _math_density, chunk_pages
from services.workspace.youtube import chunk_transcript, transcript_text, _fmt_ts
from services.workspace.website import chunk_sections


# ── PDF page chunking ─────────────────────────────────────────────────────────

def test_chunk_pages_anchors_pages():
    pages = ["[page 1]\nIntro text about gradients.", "[page 2]\nMore depth here."]
    chunks = chunk_pages(pages)
    assert len(chunks) == 2
    assert chunks[0]["anchor_type"] == "page"
    assert chunks[0]["anchor_start"] == 1
    assert chunks[1]["anchor_start"] == 2
    assert "gradients" in chunks[0]["chunk_text"]
    assert "[page" not in chunks[0]["chunk_text"]


def test_chunk_pages_splits_long_pages():
    long_page = "[page 1]\n" + "\n".join(f"Paragraph {i} " + "x" * 300 for i in range(10))
    chunks = chunk_pages([long_page], max_chars=800)
    assert len(chunks) > 1
    assert all(c["anchor_start"] == 1 for c in chunks)
    # chunk_index strictly increasing
    assert [c["chunk_index"] for c in chunks] == list(range(len(chunks)))


def test_chunk_pages_skips_empty_pages():
    chunks = chunk_pages(["[page 1]\n", "[page 2]\nContent."])
    assert len(chunks) == 1
    assert chunks[0]["anchor_start"] == 2


def test_math_density_flags_symbolic_text():
    assert _math_density("∫∑√α = β ± ∞") > 0.15
    assert _math_density("Plain prose about history.") < 0.05
    assert _math_density("") == 0.0


# ── YouTube transcript chunking ───────────────────────────────────────────────

def _snippets(n, step=10.0):
    return [{"text": f"snippet {i}", "start": i * step, "duration": step} for i in range(n)]


def test_chunk_transcript_windows_by_time():
    chunks = chunk_transcript(_snippets(20, step=10.0), window_seconds=75.0)
    assert len(chunks) >= 2
    first = chunks[0]
    assert first["anchor_type"] == "time"
    assert first["anchor_start"] == 0.0
    assert first["anchor_end"] >= 75.0
    # windows don't overlap and are ordered
    for a, b in zip(chunks, chunks[1:]):
        assert b["anchor_start"] >= a["anchor_start"]


def test_chunk_transcript_flushes_tail():
    chunks = chunk_transcript(_snippets(3, step=10.0), window_seconds=75.0)
    assert len(chunks) == 1
    assert "snippet 2" in chunks[0]["chunk_text"]


def test_transcript_text_prefixes_timestamps():
    text = transcript_text([
        {"text": "hello", "start": 0, "duration": 5},
        {"text": "world", "start": 65, "duration": 5},
        {"text": "later", "start": 3700, "duration": 5},
    ])
    lines = text.split("\n")
    assert lines[0].startswith("[00:00]")
    assert lines[1].startswith("[01:05]")
    assert lines[2].startswith("[1:01:40]")


def test_fmt_ts():
    assert _fmt_ts(0) == "00:00"
    assert _fmt_ts(75) == "01:15"
    assert _fmt_ts(3661) == "1:01:01"


# ── Website section chunking ─────────────────────────────────────────────────

def test_chunk_sections_anchors_section_indices():
    sections = [
        {"index": 0, "kind": "heading", "content": "Title"},
        {"index": 1, "kind": "text", "content": "First paragraph. " * 10},
        {"index": 2, "kind": "image", "content": "https://img"},
        {"index": 3, "kind": "text", "content": "Second paragraph. " * 10},
    ]
    chunks = chunk_sections(sections, max_chars=100)
    assert all(c["anchor_type"] == "section" for c in chunks)
    assert chunks[0]["anchor_start"] == 0
    # image sections never enter chunks
    assert all("https://img" not in c["chunk_text"] for c in chunks)


def test_extract_website_parses_sections_and_tags():
    doc = {
        "title": "My Article",
        "text": "# Heading One\nBody paragraph here.\n![alt](https://example.com/pic.png)\nAnother paragraph.",
        "author": "Jane",
        "image": "https://example.com/thumb.png",
    }
    fake_traf = MagicMock()
    fake_traf.fetch_url.return_value = "<html>raw</html>"
    fake_traf.bare_extraction.return_value = doc
    with patch("services.workspace.website.trafilatura", fake_traf):
        from services.workspace.website import extract_website
        data = extract_website("https://example.com/a")

    assert data["title"] == "My Article"
    kinds = [s["kind"] for s in data["sections"]]
    assert kinds == ["heading", "text", "image", "text"]
    assert data["sections"][0]["content"] == "Heading One"
    assert data["sections"][2]["content"] == "https://example.com/pic.png"
    assert "[section 1] Body paragraph here." in data["tagged_text"]
    assert data["meta"]["author"] == "Jane"
