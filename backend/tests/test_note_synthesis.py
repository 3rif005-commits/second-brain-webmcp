"""Tests for the multi-source note synthesis prompt — every source gets its own
block, anchors are source-indexed, and the character budget is split fairly."""
from prompts.mastery_guide import SYSTEM_PROMPT
from prompts.note_synthesis import (TOTAL_SOURCE_BUDGET,
                                    build_note_synthesis_prompt, split_budget)

SOURCES = [
    {"title": "Backprop paper", "kind": "pdf", "text": "[page 1]\nchain rule", "duration": None},
    {"title": "3Blue1Brown — Backpropagation", "kind": "youtube",
     "text": "[00:12] gradient descent", "duration": 1122.0},
    {"title": "en.wikipedia.org/wiki/Backpropagation", "kind": "website",
     "text": "[section 1]\nhistory", "duration": None},
]


def test_reuses_mastery_guide_prompt_verbatim():
    assert SYSTEM_PROMPT in build_note_synthesis_prompt(SOURCES)


def test_every_source_gets_a_numbered_header():
    prompt = build_note_synthesis_prompt(SOURCES)
    assert '=== SOURCE 1: "Backprop paper" (pdf) ===' in prompt
    assert '=== SOURCE 2: "3Blue1Brown — Backpropagation" (youtube, 18:42) ===' in prompt
    assert '=== SOURCE 3: "en.wikipedia.org/wiki/Backpropagation" (website) ===' in prompt


def test_source_indexed_anchor_instruction_present():
    prompt = build_note_synthesis_prompt(SOURCES)
    assert 'data-anchor="SOURCE:TYPE:VALUE"' in prompt
    assert 'data-anchor="1:p:14"' in prompt      # worked example
    assert "t:SECONDS" in prompt
    assert "p:PAGE" in prompt
    assert "s:INDEX" in prompt


def test_tells_the_model_to_synthesize_not_concatenate():
    prompt = build_note_synthesis_prompt(SOURCES)
    assert "Organize the note by CONCEPT" in prompt
    assert "one <h2> per source" in prompt       # names the failure mode
    assert "<h1>" in prompt                      # topic title for the note


def test_per_kind_tagging_preserved_per_block():
    prompt = build_note_synthesis_prompt(SOURCES)
    assert "[page N]" in prompt
    assert "[mm:ss]" in prompt
    assert "[section N]" in prompt


def test_transcript_less_source_declares_the_attached_video():
    prompt = build_note_synthesis_prompt([
        {"title": "Lecture", "kind": "video", "text": "", "duration": 60.0}])
    assert "No transcript" in prompt
    assert "attached" in prompt


def test_budget_even_split_when_all_sources_are_long():
    assert split_budget([10_000, 10_000], 1_000) == [500, 500]


def test_budget_gives_short_sources_only_what_they_need():
    assert split_budget([100, 100], 1_000) == [100, 100]


def test_budget_redistributes_the_unused_share():
    # 500 each; source 0 only needs 100, so source 1 gets the leftover 400 too
    assert split_budget([100, 10_000], 1_000) == [100, 900]


def test_budget_handles_no_sources():
    assert split_budget([], 1_000) == []


def test_anchor_instruction_targets_h3_not_h2():
    prompt = build_note_synthesis_prompt(SOURCES)
    assert '<h3 data-anchor="SOURCE:TYPE:VALUE">' in prompt
    assert "data-importance" not in prompt  # old broken attribute, must be gone
    assert 'Do not put data-anchor on any element other than <h3>' in prompt


def test_source_text_is_capped_by_the_total_budget():
    # U+2588 appears in no template, so counting it measures exactly the source
    # text that reached the prompt — not an incidental property of other strings.
    prompt = build_note_synthesis_prompt([
        {"title": f"Source {i}", "kind": "pdf", "text": "█" * 50_000,
         "duration": None}
        for i in range(3)
    ])
    used = prompt.count("█")
    assert used <= TOTAL_SOURCE_BUDGET
    assert used > TOTAL_SOURCE_BUDGET - 10   # the budget is actually spent, not silently dropped
