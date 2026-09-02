"""Tests for GET/POST/PUT/DELETE /skills."""
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path):
    user_dir = tmp_path / "user_skills"
    user_dir.mkdir()
    bundled_dir = tmp_path / "bundled_skills"
    bundled_dir.mkdir()
    (bundled_dir / "cite-everything.md").write_text(
        "---\nname: cite-everything\ndescription: Always cite sources\n---\nCite every claim.\n",
        encoding="utf-8",
    )
    with (
        patch("routers.skills_api.get_user_id", return_value="user-1"),
        patch("routers.skills_api._BUNDLED_SKILLS_DIR", bundled_dir),
        patch("routers.skills_api._USER_SKILLS_DIR", user_dir),
    ):
        from main import app
        yield TestClient(app), user_dir


def test_list_skills_includes_bundled(client):
    tc, _ = client
    res = tc.get("/skills", headers={"Authorization": "Bearer fake"})
    assert res.status_code == 200
    names = [s["name"] for s in res.json()["skills"]]
    assert "cite-everything" in names
    bundled = next(s for s in res.json()["skills"] if s["name"] == "cite-everything")
    assert bundled["source"] == "bundled"
    assert bundled["readonly"] is True


def test_create_user_skill(client):
    tc, user_dir = client
    payload = {"name": "my-style", "description": "My custom style",
               "body": "Write friendly.", "tools": None, "priority": 0}
    res = tc.post("/skills", headers={"Authorization": "Bearer fake"}, json=payload)
    assert res.status_code == 201
    assert (user_dir / "my-style.md").exists()


def test_update_user_skill(client):
    tc, user_dir = client
    (user_dir / "my-style.md").write_text(
        "---\nname: my-style\ndescription: Old\n---\nOld body.\n", encoding="utf-8"
    )
    res = tc.put("/skills/my-style", headers={"Authorization": "Bearer fake"},
                 json={"description": "New desc", "body": "New body.", "tools": None, "priority": 0})
    assert res.status_code == 200
    content = (user_dir / "my-style.md").read_text(encoding="utf-8")
    assert "New desc" in content


def test_delete_user_skill(client):
    tc, user_dir = client
    (user_dir / "my-style.md").write_text(
        "---\nname: my-style\ndescription: Desc\n---\nBody.\n", encoding="utf-8"
    )
    res = tc.delete("/skills/my-style", headers={"Authorization": "Bearer fake"})
    assert res.status_code == 204
    assert not (user_dir / "my-style.md").exists()


def test_cannot_delete_bundled_skill(client):
    tc, _ = client
    res = tc.delete("/skills/cite-everything", headers={"Authorization": "Bearer fake"})
    assert res.status_code == 403
