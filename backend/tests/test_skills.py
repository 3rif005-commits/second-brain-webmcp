"""Tests for the skill loader."""
from pathlib import Path

import pytest

from services.agent.skills import (
    Skill,
    SkillRegistry,
    parse_frontmatter,
    classify_skills,
)


def test_parse_frontmatter_extracts_metadata_and_body():
    raw = """---
name: my-skill
description: Use this when X happens
tools: [search_brain, get_note]
priority: 3
---

Body text here.
Multiple lines.
"""
    skill = parse_frontmatter(raw, source_path=Path("/tmp/my-skill.md"))
    assert skill.name == "my-skill"
    assert skill.description == "Use this when X happens"
    assert skill.tools == ["search_brain", "get_note"]
    assert skill.priority == 3
    assert skill.body == "Body text here.\nMultiple lines."


def test_parse_frontmatter_defaults_when_optional_missing():
    raw = """---
name: minimal
description: bare bones
---

body
"""
    skill = parse_frontmatter(raw, source_path=Path("/tmp/minimal.md"))
    assert skill.tools is None        # None = allow all permitted by tier
    assert skill.priority == 0        # default tiebreak


def test_parse_frontmatter_rejects_missing_name():
    raw = """---
description: bare bones
---
body
"""
    with pytest.raises(ValueError, match="name"):
        parse_frontmatter(raw, source_path=Path("/tmp/x.md"))


def test_registry_loads_files_from_directory(tmp_skills_dir):
    (tmp_skills_dir / "alpha.md").write_text(
        "---\nname: alpha\ndescription: alpha skill\n---\nA"
    )
    (tmp_skills_dir / "beta.md").write_text(
        "---\nname: beta\ndescription: beta skill\n---\nB"
    )
    registry = SkillRegistry.load([tmp_skills_dir])
    assert {"alpha", "beta"} == set(registry.names())


def test_registry_user_dir_overrides_bundled(tmp_path):
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    user = tmp_path / "user"
    user.mkdir()
    (bundled / "shared.md").write_text(
        "---\nname: shared\ndescription: BUNDLED\n---\nbundled body"
    )
    (user / "shared.md").write_text(
        "---\nname: shared\ndescription: USER\n---\nuser body"
    )
    registry = SkillRegistry.load([bundled, user])
    skill = registry.get("shared")
    assert skill.description == "USER"
    assert skill.body == "user body"


def test_classify_picks_skills_by_keyword_overlap():
    skills = [
        Skill(name="exam", description="quiz prep test review",
              body="", tools=None, priority=0, source_path=Path("/x")),
        Skill(name="code", description="programming algorithm code review",
              body="", tools=None, priority=0, source_path=Path("/x")),
    ]
    picked = classify_skills(query="help me prep for my quiz", skills=skills, limit=2)
    assert picked[0].name == "exam"


def test_classify_respects_priority_on_tie():
    skills = [
        Skill(name="a", description="hello", body="", tools=None,
              priority=1, source_path=Path("/x")),
        Skill(name="b", description="hello", body="", tools=None,
              priority=9, source_path=Path("/x")),
    ]
    picked = classify_skills(query="hello", skills=skills, limit=1)
    assert picked[0].name == "b"


def test_classify_returns_empty_when_no_match():
    skills = [
        Skill(name="x", description="completely different topic",
              body="", tools=None, priority=0, source_path=Path("/x")),
    ]
    picked = classify_skills(query="nothing in common at all here",
                             skills=skills, limit=3)
    assert picked == []
