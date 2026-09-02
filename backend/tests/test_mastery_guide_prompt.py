"""The mastery guide prompt must speak the callout dialect the BlockNote
schema now understands, and must no longer ask for blocks that don't exist
(data-importance headings, the quiz block, the metadata block)."""
from prompts.mastery_guide import SYSTEM_PROMPT, build_mastery_guide_prompt


def test_uses_callout_divs_not_the_broken_callout_syntax():
    assert 'data-type="callout"' in SYSTEM_PROMPT
    assert 'data-callout-type=' in SYSTEM_PROMPT
    assert 'data-color="blue"' not in SYSTEM_PROMPT  # the old, non-functional attribute


def test_defines_the_nine_callout_types():
    for callout_type in ["OVERVIEW", "NOTE", "TIP", "IMPORTANT", "WARNING",
                          "CAUTION", "FORMULA", "ANALOGY", "EXAM"]:
        assert callout_type in SYSTEM_PROMPT


def test_uses_text_color_not_the_broken_importance_attribute():
    assert "data-importance" not in SYSTEM_PROMPT
    assert "data-text-color" in SYSTEM_PROMPT


def test_defines_the_four_heading_levels():
    assert "<h2" in SYSTEM_PROMPT and "Chapter" in SYSTEM_PROMPT
    assert "<h3" in SYSTEM_PROMPT and "Section" in SYSTEM_PROMPT
    assert "<h5" in SYSTEM_PROMPT and "Concept" in SYSTEM_PROMPT
    assert "<h6" in SYSTEM_PROMPT and "Sub-case" in SYSTEM_PROMPT


def test_toggles_use_details_summary():
    assert "<details>" in SYSTEM_PROMPT and "<summary>" in SYSTEM_PROMPT


def test_drops_the_quiz_and_metadata_blocks():
    assert "data-type=\"interactive\"" not in SYSTEM_PROMPT
    assert "data-type=\"metadata\"" not in SYSTEM_PROMPT
    assert "Knowledge Check" not in SYSTEM_PROMPT


def test_states_the_color_hard_limits():
    assert "red" in SYSTEM_PROMPT and "2" in SYSTEM_PROMPT  # red ≤ 2 stated somewhere
    assert "orange" in SYSTEM_PROMPT


def test_build_mastery_guide_prompt_still_truncates_and_titles():
    prompt = build_mastery_guide_prompt("x" * 30000, title="My Lecture")
    assert SYSTEM_PROMPT in prompt
    assert "My Lecture" in prompt
    # Verify truncation: count x's in SYSTEM_PROMPT, then add 20k from source
    system_x_count = SYSTEM_PROMPT.count("x")
    assert prompt.count("x") <= 20000 + system_x_count + 1
