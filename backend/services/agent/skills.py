"""Skill loader — reads .md files with YAML frontmatter from bundled + user dirs.

A skill = name + description + optional tools whitelist + body (the instructions).
Activation = keyword-overlap classifier picks top-N matching skills per turn.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    body: str
    tools: list[str] | None       # None = allow all permitted by tier
    priority: int                 # tiebreak; higher wins
    source_path: Path


_FRONTMATTER_RE = re.compile(
    r"^---\s*\n(?P<yaml>.*?)\n---\s*\n(?P<body>.*)$",
    re.DOTALL,
)


def parse_frontmatter(raw: str, source_path: Path) -> Skill:
    match = _FRONTMATTER_RE.match(raw)
    if not match:
        raise ValueError(f"{source_path}: missing frontmatter delimiters")
    meta = yaml.safe_load(match.group("yaml")) or {}
    body = match.group("body").strip()
    if not meta.get("name"):
        raise ValueError(f"{source_path}: 'name' is required in frontmatter")
    if not meta.get("description"):
        raise ValueError(f"{source_path}: 'description' is required")
    return Skill(
        name=meta["name"],
        description=meta["description"],
        body=body,
        tools=meta.get("tools"),
        priority=int(meta.get("priority", 0)),
        source_path=source_path,
    )


class SkillRegistry:
    def __init__(self, skills: dict[str, Skill]):
        self._skills = skills

    @classmethod
    def load(cls, dirs: list[Path]) -> "SkillRegistry":
        """Load skills from each dir in order. Later dirs override earlier
        (so user dir wins over bundled)."""
        skills: dict[str, Skill] = {}
        for d in dirs:
            if not d.exists():
                continue
            for path in sorted(d.glob("*.md")):
                raw = path.read_text(encoding="utf-8")
                skill = parse_frontmatter(raw, path)
                skills[skill.name] = skill
        return cls(skills)

    def names(self) -> list[str]:
        return list(self._skills.keys())

    def get(self, name: str) -> "Skill | None":
        return self._skills.get(name)

    def all(self) -> list[Skill]:
        return list(self._skills.values())


_WORD_RE = re.compile(r"[a-zA-Z0-9]+")


def _tokenize(s: str) -> set[str]:
    return {w.lower() for w in _WORD_RE.findall(s)}


def classify_skills(
    query: str,
    skills: list[Skill],
    limit: int = 3,
) -> list[Skill]:
    """Pick top-N skills whose description shares keywords with the query.

    Phase 1: simple keyword overlap. Future: small-LLM classifier.
    Skills with zero overlap are excluded entirely.
    """
    query_tokens = _tokenize(query)
    scored: list[tuple[int, int, Skill]] = []
    for skill in skills:
        desc_tokens = _tokenize(skill.description)
        overlap = len(query_tokens & desc_tokens)
        if overlap == 0:
            continue
        scored.append((overlap, skill.priority, skill))
    # Sort: higher overlap first, then higher priority
    scored.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return [s for (_, _, s) in scored[:limit]]
