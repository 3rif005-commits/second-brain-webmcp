"""GET/POST/PUT/DELETE /skills — user-facing CRUD for skill files.

Bundled skills (backend/skills/) are read-only. User skills (~/.secondbrain/skills/)
are fully editable. User skills override bundled when names collide.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from routers.ingest import get_user_id

router = APIRouter(prefix="/skills", tags=["skills"])

_BUNDLED_SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
_USER_SKILLS_DIR = Path.home() / ".secondbrain" / "skills"

_SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9\-]{1,62}$")


def _ensure_user_dir() -> Path:
    _USER_SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    return _USER_SKILLS_DIR


def _parse_skill_file(path: Path, source: str) -> dict:
    raw = path.read_text(encoding="utf-8")
    fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)", raw, re.DOTALL)
    if not fm_match:
        return {}
    meta = yaml.safe_load(fm_match.group(1)) or {}
    return {
        "name": meta.get("name", path.stem),
        "description": meta.get("description", ""),
        "body": fm_match.group(2).strip(),
        "tools": meta.get("tools"),
        "priority": meta.get("priority", 0),
        "source": source,
        "readonly": source == "bundled",
    }


def _write_skill_file(path: Path, name: str, description: str, body: str,
                      tools: list[str] | None, priority: int) -> None:
    meta: dict = {"name": name, "description": description}
    if tools is not None:
        meta["tools"] = tools
    if priority != 0:
        meta["priority"] = priority
    fm = yaml.dump(meta, default_flow_style=False).strip()
    path.write_text(f"---\n{fm}\n---\n\n{body}\n", encoding="utf-8")


@router.get("")
def list_skills(authorization: str = Header()):
    get_user_id(authorization)
    skills: dict[str, dict] = {}
    for path in sorted(_BUNDLED_SKILLS_DIR.glob("*.md")):
        s = _parse_skill_file(path, "bundled")
        if s:
            skills[s["name"]] = s
    user_dir = _USER_SKILLS_DIR
    if user_dir.exists():
        for path in sorted(user_dir.glob("*.md")):
            s = _parse_skill_file(path, "user")
            if s:
                skills[s["name"]] = s
    return {"skills": list(skills.values())}


@router.get("/{name}")
def get_skill(name: str, authorization: str = Header()):
    get_user_id(authorization)
    user_path = _USER_SKILLS_DIR / f"{name}.md"
    if user_path.exists():
        return _parse_skill_file(user_path, "user")
    bundled_path = _BUNDLED_SKILLS_DIR / f"{name}.md"
    if bundled_path.exists():
        return _parse_skill_file(bundled_path, "bundled")
    raise HTTPException(404, detail=f"Skill '{name}' not found")


class SkillPayload(BaseModel):
    description: str
    body: str
    tools: list[str] | None = None
    priority: int = 0


class CreateSkillPayload(SkillPayload):
    name: str


@router.post("", status_code=201)
def create_skill(payload: CreateSkillPayload, authorization: str = Header()):
    get_user_id(authorization)
    if not _SAFE_NAME.match(payload.name):
        raise HTTPException(400, detail="name must be lowercase-kebab-case, 2–63 chars")
    user_dir = _ensure_user_dir()
    path = user_dir / f"{payload.name}.md"
    if path.exists():
        raise HTTPException(409, detail=f"Skill '{payload.name}' already exists")
    _write_skill_file(path, payload.name, payload.description,
                      payload.body, payload.tools, payload.priority)
    return _parse_skill_file(path, "user")


@router.put("/{name}")
def update_skill(name: str, payload: SkillPayload, authorization: str = Header()):
    get_user_id(authorization)
    bundled_path = _BUNDLED_SKILLS_DIR / f"{name}.md"
    if bundled_path.exists() and not (_USER_SKILLS_DIR / f"{name}.md").exists():
        raise HTTPException(403, detail="Bundled skills are read-only. Use POST /skills to clone.")
    user_dir = _ensure_user_dir()
    path = user_dir / f"{name}.md"
    if not path.exists():
        raise HTTPException(404, detail=f"User skill '{name}' not found")
    _write_skill_file(path, name, payload.description,
                      payload.body, payload.tools, payload.priority)
    return _parse_skill_file(path, "user")


@router.delete("/{name}", status_code=204)
def delete_skill(name: str, authorization: str = Header()):
    get_user_id(authorization)
    user_path = _USER_SKILLS_DIR / f"{name}.md"
    if not user_path.exists():
        bundled = _BUNDLED_SKILLS_DIR / f"{name}.md"
        if bundled.exists():
            raise HTTPException(403, detail="Cannot delete bundled skills")
        raise HTTPException(404, detail=f"User skill '{name}' not found")
    user_path.unlink()
