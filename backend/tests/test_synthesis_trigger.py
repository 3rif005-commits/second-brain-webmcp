"""Tests for the synthesis service: the settle guard (fire exactly once, when
the last source lands) and the run itself (prompt, writes, failure policy)."""
from unittest.mock import MagicMock, patch

from services.workspace import synthesis

READY = {"id": "s1", "status": "ready"}


def _db(sources, synth_rows, note_rows):
    """get_supabase() double: one MagicMock per table, chains pre-wired."""
    tables: dict = {}
    db = MagicMock()
    db.table.side_effect = lambda name: tables.setdefault(name, MagicMock())
    src = tables.setdefault("note_resources", MagicMock())
    src.select.return_value.eq.return_value.execute.return_value.data = sources
    syn = tables.setdefault("note_synthesis", MagicMock())
    syn.select.return_value.eq.return_value.execute.return_value.data = synth_rows
    notes = tables.setdefault("notes", MagicMock())
    notes.select.return_value.eq.return_value.execute.return_value.data = note_rows
    db.tables = tables
    return db


NOTE = [{"id": "n1", "user_id": "u1", "title": "Backprop paper", "content": []}]


# ── settle guard ─────────────────────────────────────────────────────────────

def test_no_fire_while_a_sibling_is_still_processing():
    db = _db([READY, {"id": "s2", "status": "processing"}], [], NOTE)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is False
    run.assert_not_called()


def test_no_fire_while_a_sibling_is_still_queued():
    db = _db([READY, {"id": "s2", "status": "queued"}], [], NOTE)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is False
    run.assert_not_called()


def test_fires_exactly_once_when_the_last_source_lands():
    db = _db([READY, {"id": "s2", "status": "ready"}], [], NOTE)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is True
    run.assert_called_once_with("n1", "replace")


def test_failed_sibling_does_not_block_the_settle_check():
    db = _db([READY, {"id": "s2", "status": "failed"}], [], NOTE)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is True
    run.assert_called_once()


def test_no_refire_when_a_synthesis_row_already_exists():
    db = _db([READY], [{"note_id": "n1"}], NOTE)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is False
    run.assert_not_called()


def test_no_fire_when_the_note_already_has_user_content():
    note = [{"id": "n1", "user_id": "u1", "title": "T",
             "content": [{"type": "paragraph"}]}]
    db = _db([READY], [], note)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is False
    run.assert_not_called()


def test_no_fire_when_the_note_is_gone():
    db = _db([READY], [], [])
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is False
    run.assert_not_called()


def test_the_guard_claims_the_row_before_it_fires():
    db = _db([READY], [], NOTE)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is True
    claim = db.tables["note_synthesis"].insert.call_args[0][0]
    assert claim["note_id"] == "n1"
    assert claim["status"] == "running"
    run.assert_called_once_with("n1", "replace")


def test_losing_the_claim_race_does_not_fire_a_second_synthesis():
    db = _db([READY], [], NOTE)
    (db.tables["note_synthesis"].insert.return_value.execute
     .side_effect) = Exception("duplicate key value violates unique constraint")
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "run_synthesis") as run:
        assert synthesis.maybe_synthesize("n1") is False
    run.assert_not_called()


# ── source text reassembly ───────────────────────────────────────────────────

def test_source_text_is_reassembled_with_anchor_tags():
    db = MagicMock()
    (db.table.return_value.select.return_value.eq.return_value.order.return_value
     .execute.return_value.data) = [
        {"chunk_text": "intro", "anchor_type": "page", "anchor_start": 1},
        {"chunk_text": "more intro", "anchor_type": "page", "anchor_start": 1},
        {"chunk_text": "chapter two", "anchor_type": "page", "anchor_start": 2},
    ]
    with patch.object(synthesis, "get_supabase", return_value=db):
        text = synthesis.source_text_from_chunks("s1")
    assert text == "[page 1]\nintro\nmore intro\n[page 2]\nchapter two"


def test_time_anchored_chunks_get_mmss_tags():
    db = MagicMock()
    (db.table.return_value.select.return_value.eq.return_value.order.return_value
     .execute.return_value.data) = [
        {"chunk_text": "hello", "anchor_type": "time", "anchor_start": 83.4},
    ]
    with patch.object(synthesis, "get_supabase", return_value=db):
        assert synthesis.source_text_from_chunks("s1") == "[01:23]\nhello"


# ── the run ──────────────────────────────────────────────────────────────────

def _run_db(sources, note=None):
    tables: dict = {}
    db = MagicMock()
    db.table.side_effect = lambda name: tables.setdefault(name, MagicMock())
    notes = tables.setdefault("notes", MagicMock())
    notes.select.return_value.eq.return_value.execute.return_value.data = (
        note or NOTE)
    src = tables.setdefault("note_resources", MagicMock())
    (src.select.return_value.eq.return_value.eq.return_value.order.return_value
     .execute.return_value.data) = sources
    db.tables = tables
    return db


SRC_ROWS = [
    {"id": "s1", "note_id": "n1", "user_id": "u1", "kind": "pdf",
     "title": "Backprop paper", "source_url": None, "meta": {}},
    {"id": "s2", "note_id": "n1", "user_id": "u1", "kind": "website",
     "title": "wiki", "source_url": "https://en.wikipedia.org/x", "meta": {}},
]


def test_run_synthesis_writes_ready_with_html_and_source_ids():
    db = _run_db(SRC_ROWS)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value="[page 1]\ntext"), \
         patch.object(synthesis, "complete_with_fallback",
                      return_value="<h1>Backprop</h1><h2 data-anchor=\"1:p:1\">Why</h2>") as ai:
        synthesis.run_synthesis("n1")

    prompt = ai.call_args[0][2][0]["content"]
    assert '=== SOURCE 1: "Backprop paper" (pdf) ===' in prompt
    assert '=== SOURCE 2: "wiki" (website) ===' in prompt
    writes = [c.args[0] for c in db.tables["note_synthesis"].upsert.call_args_list]
    assert writes[0]["status"] == "running"
    assert writes[-1]["status"] == "ready"
    assert writes[-1]["source_ids"] == ["s1", "s2"]
    assert writes[-1]["title_suggestion"] == "Backprop"
    assert "<h2" in writes[-1]["html"]


def test_a_textless_non_video_source_is_declared_not_silently_blank():
    db = _run_db(SRC_ROWS[:1])          # a pdf source
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value=""), \
         patch.object(synthesis, "complete_with_fallback",
                      return_value="<h1>T</h1>") as ai:
        synthesis.run_synthesis("n1")
    prompt = ai.call_args[0][2][0]["content"]
    assert "No text could be extracted" in prompt


def test_run_synthesis_strips_code_fences():
    db = _run_db(SRC_ROWS[:1])
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value="text"), \
         patch.object(synthesis, "complete_with_fallback",
                      return_value="```html\n<h2>Hi</h2>\n```"):
        synthesis.run_synthesis("n1")
    writes = [c.args[0] for c in db.tables["note_synthesis"].upsert.call_args_list]
    assert writes[-1]["html"] == "<h2>Hi</h2>"


def test_run_synthesis_records_failure_without_raising():
    db = _run_db(SRC_ROWS[:1])
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value="text"), \
         patch.object(synthesis, "complete_with_fallback",
                      side_effect=RuntimeError("all providers failed")):
        synthesis.run_synthesis("n1")
    writes = [c.args[0] for c in db.tables["note_synthesis"].upsert.call_args_list]
    assert writes[-1]["status"] == "failed"
    assert "all providers failed" in writes[-1]["error"]


def test_no_ready_sources_releases_the_claim_instead_of_failing():
    db = _run_db([])
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "complete_with_fallback") as ai:
        synthesis.run_synthesis("n1")
    ai.assert_not_called()
    db.tables["note_synthesis"].delete.return_value.eq.return_value.execute.assert_called_once()
    # The whole point: no `failed` row may be left behind, because its existence
    # is what would block a later retry from auto-firing the first draft.
    writes = [c.args[0] for c in db.tables["note_synthesis"].upsert.call_args_list]
    assert not any(w.get("status") == "failed" for w in writes)


def test_every_write_clears_a_stale_applied_at():
    db = _run_db(SRC_ROWS[:1])
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value="text"), \
         patch.object(synthesis, "complete_with_fallback", return_value="<h1>T</h1>"):
        synthesis.run_synthesis("n1")
    writes = [c.args[0] for c in db.tables["note_synthesis"].upsert.call_args_list]
    assert all(w["applied_at"] is None for w in writes)


def test_title_suggestion_applies_over_an_inherited_youtube_placeholder():
    note = [{"id": "n1", "user_id": "u1", "title": "YouTube video", "content": [],
             "source_url": "https://youtu.be/abc12345678", "source_filename": None}]
    src = [{"id": "s1", "note_id": "n1", "user_id": "u1", "kind": "youtube",
            "title": "3Blue1Brown — Backpropagation", "source_url":
            "https://youtu.be/abc12345678", "meta": {}}]
    db = _run_db(src, note=note)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value="[00:01]\ntext"), \
         patch.object(synthesis, "complete_with_fallback",
                      return_value="<h1>How backprop works</h1>"):
        synthesis.run_synthesis("n1")
    assert (db.tables["notes"].update.call_args[0][0]["title"]
            == "How backprop works")


def test_title_suggestion_applied_only_over_the_inherited_source_title():
    db = _run_db(SRC_ROWS)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value="text"), \
         patch.object(synthesis, "complete_with_fallback",
                      return_value="<h1>Three views of backprop</h1>"):
        synthesis.run_synthesis("n1")
    # note.title == first source title ("Backprop paper") → upgraded
    db.tables["notes"].update.assert_called_once()
    assert (db.tables["notes"].update.call_args[0][0]["title"]
            == "Three views of backprop")


def test_title_the_user_typed_is_never_overwritten():
    note = [{"id": "n1", "user_id": "u1", "title": "My own title", "content": []}]
    db = _run_db(SRC_ROWS, note=note)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value="text"), \
         patch.object(synthesis, "complete_with_fallback",
                      return_value="<h1>Three views of backprop</h1>"):
        synthesis.run_synthesis("n1")
    db.tables["notes"].update.assert_not_called()


def test_transcript_less_video_uses_the_video_native_provider():
    src = [{"id": "s1", "note_id": "n1", "user_id": "u1", "kind": "youtube",
            "title": "Lecture", "source_url": "https://youtu.be/abc12345678",
            "meta": {}}]
    db = _run_db(src)
    provider = MagicMock(capabilities=["video_native", "summarize_text"])
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value=""), \
         patch.object(synthesis, "pick", return_value=provider), \
         patch.object(synthesis, "complete", return_value="<h1>Lecture</h1>") as ai, \
         patch.object(synthesis, "complete_with_fallback") as text_ai:
        synthesis.run_synthesis("n1")
    text_ai.assert_not_called()
    parts = ai.call_args[0][1][0]["content"]
    assert parts[0]["type"] == "text"
    assert parts[1] == {"type": "video_url", "url": "https://youtu.be/abc12345678"}


def test_looks_like_a_mastery_guide_rejects_a_reasoning_dump_with_no_h1():
    reasoning = "We need to identify the major conceptual themes first. Let's parse the transcript..."
    assert synthesis._looks_like_a_mastery_guide(reasoning) is False


def test_looks_like_a_mastery_guide_rejects_a_stub_with_only_a_title_and_outline():
    stub = ("<h1>Neural Networks</h1><p><strong>Source:</strong> x</p>"
            "<p><strong>Topic:</strong> y</p><ul><li>Chapter 1</li><li>Chapter 2</li></ul>")
    assert synthesis._looks_like_a_mastery_guide(stub) is False


def test_looks_like_a_mastery_guide_accepts_real_chapter_content():
    guide = ("<h1>Neural Networks</h1><ul><li>Chapter 1</li></ul>"
             "<h2 data-text-color=\"orange\">Chapter 1</h2>"
             + "<p>filler content so the guide clears the minimum length floor.</p>" * 10)
    assert synthesis._looks_like_a_mastery_guide(guide) is True


def test_run_synthesis_passes_the_mastery_guide_validator_to_the_fallback_chain():
    db = _run_db(SRC_ROWS[:1])
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value="text"), \
         patch.object(synthesis, "complete_with_fallback",
                      return_value="<h1>T</h1><h2>C</h2>" + "x" * 500) as ai:
        synthesis.run_synthesis("n1")
    assert ai.call_args.kwargs["validate"] is synthesis._looks_like_a_mastery_guide


def test_textless_source_without_a_video_provider_fails_with_a_clear_message():
    src = [{"id": "s1", "note_id": "n1", "user_id": "u1", "kind": "youtube",
            "title": "Lecture", "source_url": "https://youtu.be/abc12345678",
            "meta": {}}]
    db = _run_db(src)
    with patch.object(synthesis, "get_supabase", return_value=db), \
         patch.object(synthesis, "source_text_from_chunks", return_value=""), \
         patch.object(synthesis, "pick", return_value=None):
        synthesis.run_synthesis("n1")
    writes = [c.args[0] for c in db.tables["note_synthesis"].upsert.call_args_list]
    assert writes[-1]["status"] == "failed"
    assert "video-capable" in writes[-1]["error"]
