"""Tests for the note-sources router — lazy note creation on first attach,
status polling, detach, capture guards, synthesis queueing, anchors, providers."""
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

AUTH = {"Authorization": "Bearer fake"}


def _table_router(tables: dict):
    """get_supabase().table(name) → per-table MagicMock from `tables`."""
    db = MagicMock()
    db.table.side_effect = lambda name: tables.setdefault(name, MagicMock())
    return db


@pytest.fixture
def client():
    with patch("routers.note_sources.get_user_id", return_value="user-1"):
        from main import app
        yield TestClient(app)


def _note_owned(tables, note_id="n1"):
    t = tables.setdefault("notes", MagicMock())
    t.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
        {"id": note_id, "user_id": "user-1", "title": "T", "content": []}]
    return t


def test_attach_url_without_note_id_creates_the_note_first(client):
    tables: dict = {}
    db = _table_router(tables)
    notes = tables.setdefault("notes", MagicMock())
    notes.insert.return_value.execute.return_value.data = [{"id": "n-new"}]
    srcs = tables.setdefault("note_resources", MagicMock())
    srcs.select.return_value.eq.return_value.execute.return_value.data = []
    srcs.insert.return_value.execute.return_value.data = [{
        "id": "s1", "note_id": "n-new", "kind": "youtube",
        "title": "YouTube video", "status": "queued", "meta": {}, "order_index": 0}]

    with patch("routers.note_sources.get_supabase", return_value=db), \
         patch("routers.note_sources.process_resource") as proc:
        res = client.post("/sources", data={
            "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}, headers=AUTH)

    assert res.status_code == 200
    body = res.json()
    assert body["note_id"] == "n-new"
    assert body["source"]["kind"] == "youtube"
    assert body["source"]["status"] == "queued"
    notes.insert.assert_called_once()
    proc.assert_called_once_with("s1")


def test_attach_to_existing_note_does_not_create_a_note(client):
    tables: dict = {}
    db = _table_router(tables)
    notes = _note_owned(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    srcs.select.return_value.eq.return_value.execute.return_value.data = [
        {"id": "s1"}, {"id": "s2"}]           # two already attached
    srcs.insert.return_value.execute.return_value.data = [{
        "id": "s3", "note_id": "n1", "kind": "website", "title": "x",
        "status": "queued", "meta": {}, "order_index": 2}]

    with patch("routers.note_sources.get_supabase", return_value=db), \
         patch("routers.note_sources.process_resource"):
        res = client.post("/sources", data={"url": "https://example.com",
                                            "note_id": "n1"}, headers=AUTH)

    assert res.status_code == 200
    assert res.json()["note_id"] == "n1"
    notes.insert.assert_not_called()
    assert srcs.insert.call_args[0][0]["order_index"] == 2   # appended to the rail


def test_attach_to_a_foreign_note_404s(client):
    tables: dict = {}
    db = _table_router(tables)
    notes = tables.setdefault("notes", MagicMock())
    notes.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.post("/sources", data={"url": "https://example.com",
                                            "note_id": "other"}, headers=AUTH)
    assert res.status_code == 404


def test_a_failed_attach_does_not_leave_an_empty_note_behind(client):
    tables: dict = {}
    db = _table_router(tables)
    notes = tables.setdefault("notes", MagicMock())
    notes.insert.return_value.execute.return_value.data = [{"id": "n-new"}]
    srcs = tables.setdefault("note_resources", MagicMock())
    srcs.select.return_value.eq.return_value.execute.return_value.data = []
    srcs.insert.return_value.execute.side_effect = Exception("insert failed")

    with patch("routers.note_sources.get_supabase", return_value=db), \
         patch("routers.note_sources.process_resource") as proc:
        res = client.post("/sources", data={"url": "https://example.com"}, headers=AUTH)

    assert res.status_code == 502
    notes.delete.return_value.eq.return_value.execute.assert_called_once()
    proc.assert_not_called()


def test_a_failed_attach_to_an_existing_note_leaves_that_note_alone(client):
    tables: dict = {}
    db = _table_router(tables)
    notes = _note_owned(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    srcs.select.return_value.eq.return_value.execute.return_value.data = []
    srcs.insert.return_value.execute.side_effect = Exception("insert failed")

    with patch("routers.note_sources.get_supabase", return_value=db), \
         patch("routers.note_sources.process_resource") as proc:
        res = client.post("/sources", data={"url": "https://example.com",
                                            "note_id": "n1"}, headers=AUTH)

    assert res.status_code == 502
    notes.delete.assert_not_called()
    proc.assert_not_called()


def test_defer_does_not_queue_processing(client):
    tables: dict = {}
    db = _table_router(tables)
    notes = _note_owned(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    srcs.select.return_value.eq.return_value.execute.return_value.data = []
    srcs.insert.return_value.execute.return_value.data = [{
        "id": "s1", "note_id": "n1", "kind": "website", "title": "x",
        "status": "queued", "meta": {}, "order_index": 0}]
    with patch("routers.note_sources.get_supabase", return_value=db), \
         patch("routers.note_sources.process_resource") as proc:
        res = client.post("/sources", data={"url": "https://example.com",
                                            "note_id": "n1", "defer": "true"},
                          headers=AUTH)
    assert res.status_code == 200
    assert res.json()["deferred"] is True
    proc.assert_not_called()


def test_process_sources_queues_every_queued_source(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    (srcs.select.return_value.eq.return_value.eq.return_value
     .execute.return_value.data) = [{"id": "s1"}, {"id": "s2"}]
    with patch("routers.note_sources.get_supabase", return_value=db), \
         patch("routers.note_sources.process_resource") as proc:
        res = client.post("/notes/n1/process-sources", headers=AUTH)
    assert res.status_code == 200
    assert res.json()["queued"] == 2
    assert proc.call_count == 2


def test_attach_rejects_unsupported_file(client):
    with patch("routers.note_sources.get_supabase", return_value=MagicMock()):
        res = client.post("/sources", files={
            "file": ("malware.exe", b"MZ", "application/octet-stream")}, headers=AUTH)
    assert res.status_code == 400


def test_attach_requires_a_file_or_url(client):
    with patch("routers.note_sources.get_supabase", return_value=MagicMock()):
        res = client.post("/sources", data={}, headers=AUTH)
    assert res.status_code == 400


def test_list_sources_is_status_polling(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    (srcs.select.return_value.eq.return_value.order.return_value
     .execute.return_value.data) = [
        {"id": "s1", "status": "ready", "title": "a", "kind": "pdf", "meta": {},
         "order_index": 0},
        {"id": "s2", "status": "processing", "title": "b", "kind": "youtube",
         "meta": {}, "order_index": 1},
    ]
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.get("/notes/n1/sources", headers=AUTH)
    assert res.status_code == 200
    assert [r["status"] for r in res.json()] == ["ready", "processing"]


def test_detach_keeps_the_note(client):
    tables: dict = {}
    db = _table_router(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    srcs.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
        {"id": "s1", "note_id": "n1", "user_id": "user-1", "kind": "pdf"}]
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.delete("/sources/s1", headers=AUTH)
    assert res.status_code == 200
    assert res.json() == {"ok": True, "note_id": "n1"}
    srcs.delete.return_value.eq.return_value.execute.assert_called_once()
    assert "notes" not in tables          # the note is never touched


def test_capture_rejected_for_non_video_sources(client):
    tables: dict = {}
    db = _table_router(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    srcs.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [
        {"id": "s1", "user_id": "user-1", "kind": "pdf"}]
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.post("/sources/s1/capture", json={"type": "frame", "start": 10},
                          headers=AUTH)
    assert res.status_code == 400


def test_synthesize_queues_a_background_run(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    with patch("routers.note_sources.get_supabase", return_value=db), \
         patch("routers.note_sources.run_synthesis") as run:
        res = client.post("/notes/n1/synthesize", json={"mode": "append"}, headers=AUTH)
    assert res.status_code == 200
    assert res.json()["status"] == "queued"
    assert tables["note_synthesis"].upsert.call_args[0][0]["status"] == "queued"
    run.assert_called_once_with("n1", "append")


def test_synthesize_clears_a_previous_applied_at(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    with patch("routers.note_sources.get_supabase", return_value=db), \
         patch("routers.note_sources.run_synthesis"):
        res = client.post("/notes/n1/synthesize", json={"mode": "replace"}, headers=AUTH)
    assert res.status_code == 200
    assert tables["note_synthesis"].upsert.call_args[0][0]["applied_at"] is None


def test_synthesize_rejects_an_unknown_mode(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.post("/notes/n1/synthesize", json={"mode": "merge"}, headers=AUTH)
    assert res.status_code == 400


def test_get_synthesis_reports_none_before_the_first_run(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    syn = tables.setdefault("note_synthesis", MagicMock())
    syn.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = []
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.get("/notes/n1/synthesis", headers=AUTH)
    assert res.status_code == 200
    assert res.json() == {"status": "none", "source_ids": []}


def test_get_synthesis_returns_html_and_applied_at(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    syn = tables.setdefault("note_synthesis", MagicMock())
    syn.select.return_value.eq.return_value.eq.return_value.execute.return_value.data = [{
        "note_id": "n1", "status": "ready", "html": "<h2>Hi</h2>",
        "source_ids": ["s1", "s2"], "title_suggestion": "Topic",
        "error": None, "applied_at": None}]
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.get("/notes/n1/synthesis", headers=AUTH)
    body = res.json()
    assert body["html"] == "<h2>Hi</h2>"
    assert body["source_ids"] == ["s1", "s2"]
    assert body["applied_at"] is None


def test_put_anchors_replaces_rows(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    (srcs.select.return_value.eq.return_value.eq.return_value
     .execute.return_value.data) = [{"id": "r1"}, {"id": "r2"}]
    anchors = tables.setdefault("note_anchors", MagicMock())
    body = [
        {"block_id": "b1", "resource_id": "r1", "anchor_type": "page",
         "anchor_start": 4, "anchor_end": 4},
        {"block_id": "b2", "resource_id": "r2", "anchor_type": "time",
         "anchor_start": 90.0, "anchor_end": 90.0},
    ]
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.put("/notes/n1/anchors", json=body, headers=AUTH)
    assert res.status_code == 200
    assert res.json()["count"] == 2
    anchors.delete.return_value.eq.return_value.execute.assert_called_once()
    inserted = anchors.insert.call_args[0][0]
    assert inserted[0]["user_id"] == "user-1"
    assert {r["resource_id"] for r in inserted} == {"r1", "r2"}   # multi-source


def test_put_anchors_drops_rows_for_sources_not_on_this_note(client):
    tables: dict = {}
    db = _table_router(tables)
    _note_owned(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    (srcs.select.return_value.eq.return_value.eq.return_value
     .execute.return_value.data) = [{"id": "r1"}]
    anchors = tables.setdefault("note_anchors", MagicMock())
    body = [
        {"block_id": "b1", "resource_id": "r1", "anchor_type": "page",
         "anchor_start": 4, "anchor_end": 4},
        {"block_id": "b2", "resource_id": "r-elsewhere", "anchor_type": "page",
         "anchor_start": 9, "anchor_end": 9},
    ]
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.put("/notes/n1/anchors", json=body, headers=AUTH)
    assert res.json() == {"ok": True, "count": 1, "dropped": 1}
    inserted = anchors.insert.call_args[0][0]
    assert [r["resource_id"] for r in inserted] == ["r1"]


def test_recent_sessions_groups_sources_by_note(client):
    tables: dict = {}
    db = _table_router(tables)
    srcs = tables.setdefault("note_resources", MagicMock())
    (srcs.select.return_value.eq.return_value.order.return_value.limit.return_value
     .execute.return_value.data) = [
        {"note_id": "n1", "kind": "pdf", "title": "a", "order_index": 0},
        {"note_id": "n1", "kind": "youtube", "title": "b", "order_index": 1},
        {"note_id": "n2", "kind": "website", "title": "c", "order_index": 0},
    ]
    notes = tables.setdefault("notes", MagicMock())
    notes.select.return_value.in_.return_value.execute.return_value.data = [
        {"id": "n1", "title": "Backprop", "updated_at": "2026-07-30T10:00:00Z",
         "deleted_at": None},
        {"id": "n2", "title": "Trashed", "updated_at": "2026-07-30T11:00:00Z",
         "deleted_at": "2026-07-30T12:00:00Z"},
    ]
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.get("/sessions/recent", headers=AUTH)
    rows = res.json()
    assert len(rows) == 1                     # deleted note excluded
    assert rows[0]["note_id"] == "n1"
    assert rows[0]["source_count"] == 2
    assert set(rows[0]["kinds"]) == {"pdf", "youtube"}


def test_ai_providers_key_never_echoed(client):
    row = {"id": "p1", "user_id": "user-1", "provider": "gemini",
           "label": "Gemini", "api_key": "secret-key-12345", "enabled": True}
    db = MagicMock()
    (db.table.return_value.select.return_value.eq.return_value.order.return_value
     .execute.return_value.data) = [dict(row)]
    with patch("routers.note_sources.get_supabase", return_value=db):
        res = client.get("/ai-providers", headers=AUTH)
    body = res.json()[0]
    assert "api_key" not in body
    assert body["api_key_hint"].endswith("2345")


def test_create_ai_provider_validates(client):
    with patch("routers.note_sources.get_supabase", return_value=MagicMock()):
        assert client.post("/ai-providers", json={"provider": "bogus", "api_key": "k"},
                           headers=AUTH).status_code == 400
        assert client.post("/ai-providers",
                           json={"provider": "openai_compatible", "api_key": "k"},
                           headers=AUTH).status_code == 400   # base_url required
