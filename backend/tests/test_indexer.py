"""Tests for services/indexer.py — chunk assembly, and Milestone 14 Task 46's
property-preamble chunk for database-row notes.

Mocking convention follows this codebase's established `get_supabase()`
router pattern (see tests/test_synthesis_trigger.py's `_db` helper): one
MagicMock per table name, chains pre-wired per test, no real DB/network I/O.
`embed`/`embed_batch`/`generate_descriptor` are patched out too, since this
module's own job (chunk assembly + the new preamble) is what's under test,
not the embedding/descriptor services themselves.
"""
from unittest.mock import MagicMock, patch

from services import indexer

NOTE_ID = "11111111-1111-1111-1111-111111111111"
USER_ID = "22222222-2222-2222-2222-222222222222"
DATA_SOURCE_ID = "33333333-3333-3333-3333-333333333333"

CONTENT = [
    {"id": "b1", "type": "paragraph",
     "content": [{"type": "text", "text": "First block"}]},
    {"id": "b2", "type": "paragraph",
     "content": [{"type": "text", "text": "Second block"}]},
]


def _db(*, note, db_row_props=None, db_properties=None):
    """get_supabase() double: one MagicMock per table, chains pre-wired.
    `note` is the notes-select payload; `db_row_props`/`db_properties` are
    `None` to simulate "no row"/"no properties" (maybe_single()/select()
    returning no data)."""
    tables: dict = {}
    db = MagicMock()
    db.table.side_effect = lambda name: tables.setdefault(name, MagicMock())

    notes = tables.setdefault("notes", MagicMock())
    notes.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = note

    row_props = tables.setdefault("db_row_props", MagicMock())
    row_props.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = db_row_props

    properties = tables.setdefault("db_properties", MagicMock())
    properties.select.return_value.eq.return_value.eq.return_value.order.return_value.execute.return_value.data = (
        db_properties or []
    )

    # note_chunks delete/insert and notes update: no return-value assertions
    # made on these mocks beyond call inspection, default MagicMock is fine.
    tables.setdefault("note_chunks", MagicMock())

    db.tables = tables
    return db


def _patched(db):
    """Context manager patching every external call `index_note` makes
    besides `get_supabase()` reads/writes on `db`, so only chunk-assembly
    logic is under test."""
    from contextlib import ExitStack

    stack = ExitStack()
    stack.enter_context(patch.object(indexer, "get_supabase", return_value=db))
    stack.enter_context(patch.object(indexer, "embed_batch", side_effect=lambda texts: [[0.0]] * len(texts)))
    stack.enter_context(patch.object(indexer, "embed", return_value=[0.0]))
    stack.enter_context(patch.object(indexer, "generate_descriptor", return_value="a descriptor"))
    return stack


def _inserted_rows(db):
    insert_call = db.tables["note_chunks"].insert.call_args
    assert insert_call is not None, "note_chunks.insert was never called"
    return insert_call[0][0]


# ── case 1: non-database note -> no regression, no preamble ─────────────

def test_non_database_note_produces_unchanged_chunk_list():
    note = {"id": NOTE_ID, "title": "Plain note", "content": CONTENT}
    db = _db(note=note, db_row_props=None)

    with _patched(db):
        assert indexer.index_note(NOTE_ID, USER_ID) is True

    rows = _inserted_rows(db)
    assert [r["chunk_index"] for r in rows] == [0, 1]
    assert [r["chunk_text"] for r in rows] == ["First block", "Second block"]
    assert [r["block_id"] for r in rows] == ["b1", "b2"]


# ── case 2: database row with 2+ non-empty properties -> preamble at 0 ──

def test_database_row_with_properties_gets_preamble_as_chunk_zero():
    note = {"id": NOTE_ID, "title": "Row note", "content": CONTENT}
    db_row_props = {
        "properties": {
            "statuskey": {"type": "status", "status": "opt-inprog"},
            "topicskey": {"type": "multi_select", "multi_select": ["opt-rust", "opt-async"]},
            "duekey":    {"type": "date", "date": {"start": "2026-09-01"}},
        },
        "data_source_id": DATA_SOURCE_ID,
    }
    db_properties = [
        {"key": "statuskey", "name": "Status", "type": "status", "position": 0,
         "config": {"options": [{"id": "opt-inprog", "name": "In progress"}]}},
        {"key": "topicskey", "name": "Topics", "type": "multi_select", "position": 1,
         "config": {"options": [
             {"id": "opt-rust", "name": "rust"}, {"id": "opt-async", "name": "async"},
         ]}},
        {"key": "duekey", "name": "Due", "type": "date", "position": 2, "config": {}},
    ]
    db = _db(note=note, db_row_props=db_row_props, db_properties=db_properties)

    with _patched(db):
        assert indexer.index_note(NOTE_ID, USER_ID) is True

    rows = _inserted_rows(db)
    assert [r["chunk_index"] for r in rows] == [0, 1, 2]
    assert rows[0]["chunk_text"] == "Status: In progress · Topics: rust, async · Due: 2026-09-01"
    assert rows[0]["block_id"] == indexer.PROPERTY_PREAMBLE_BLOCK_ID
    # Original blocks shifted up by exactly one index, text/block_id intact.
    assert rows[1] == {
        "note_id": NOTE_ID, "user_id": USER_ID, "chunk_index": 1,
        "chunk_text": "First block", "block_id": "b1", "embedding": rows[1]["embedding"],
    }
    assert rows[2]["chunk_index"] == 2
    assert rows[2]["chunk_text"] == "Second block"
    assert rows[2]["block_id"] == "b2"


def test_descriptor_generation_uses_original_blocks_not_the_preamble():
    """Descriptor generation is unchanged by this task (brief's explicit
    scope boundary) -- it must never see the preamble chunk's text."""
    note = {"id": NOTE_ID, "title": "Row note", "content": CONTENT}
    db_row_props = {
        "properties": {"statuskey": {"type": "status", "status": "opt-inprog"}},
        "data_source_id": DATA_SOURCE_ID,
    }
    db_properties = [
        {"key": "statuskey", "name": "Status", "type": "status", "position": 0,
         "config": {"options": [{"id": "opt-inprog", "name": "In progress"}]}},
    ]
    db = _db(note=note, db_row_props=db_row_props, db_properties=db_properties)

    with _patched(db), \
         patch.object(indexer, "generate_descriptor", return_value="a descriptor") as mock_desc:
        indexer.index_note(NOTE_ID, USER_ID)

    mock_desc.assert_called_once_with("Row note", ["First block", "Second block"])


# ── case 3: database row, every property empty -> no preamble chunk ─────

def test_database_row_with_all_empty_properties_produces_no_preamble():
    note = {"id": NOTE_ID, "title": "Row note", "content": CONTENT}
    db_row_props = {
        "properties": {
            "statuskey": {"type": "status", "status": None},
            "topicskey": {"type": "multi_select", "multi_select": []},
        },
        "data_source_id": DATA_SOURCE_ID,
    }
    db_properties = [
        {"key": "statuskey", "name": "Status", "type": "status", "position": 0, "config": {}},
        {"key": "topicskey", "name": "Topics", "type": "multi_select", "position": 1, "config": {}},
    ]
    db = _db(note=note, db_row_props=db_row_props, db_properties=db_properties)

    with _patched(db):
        assert indexer.index_note(NOTE_ID, USER_ID) is True

    rows = _inserted_rows(db)
    assert [r["chunk_index"] for r in rows] == [0, 1]
    assert [r["chunk_text"] for r in rows] == ["First block", "Second block"]
    assert [r["block_id"] for r in rows] == ["b1", "b2"]


def test_database_row_with_no_body_blocks_still_gets_preamble():
    """An empty-body database row (no BlockNote content yet) still indexes
    the preamble as chunk 0 -- `embed_and_insert_chunks` no longer sees an
    empty list, so it must not early-return before inserting it."""
    note = {"id": NOTE_ID, "title": "Row note", "content": []}
    db_row_props = {
        "properties": {"statuskey": {"type": "status", "status": "opt-inprog"}},
        "data_source_id": DATA_SOURCE_ID,
    }
    db_properties = [
        {"key": "statuskey", "name": "Status", "type": "status", "position": 0,
         "config": {"options": [{"id": "opt-inprog", "name": "In progress"}]}},
    ]
    db = _db(note=note, db_row_props=db_row_props, db_properties=db_properties)

    with _patched(db), patch.object(indexer, "generate_descriptor") as mock_desc:
        assert indexer.index_note(NOTE_ID, USER_ID) is True
        # No body blocks -> index_note returns early, same as before this
        # task, and descriptor generation is never invoked.
        mock_desc.assert_not_called()

    rows = _inserted_rows(db)
    assert [r["chunk_index"] for r in rows] == [0]
    assert rows[0]["chunk_text"] == "Status: In progress"
    assert rows[0]["block_id"] == indexer.PROPERTY_PREAMBLE_BLOCK_ID
