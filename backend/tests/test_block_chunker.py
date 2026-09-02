"""Tests for BlockNote JSON → chunk list parser."""
import pytest
from services.block_chunker import parse


def test_heading_block_is_indexed():
    content = [
        {
            "id": "b1",
            "type": "heading",
            "content": [{"type": "text", "text": "Introduction to ML"}],
            "children": [],
        }
    ]
    result = parse(content)
    assert len(result) == 1
    assert result[0]["block_id"] == "b1"
    assert result[0]["chunk_text"] == "Introduction to ML"
    assert result[0]["chunk_index"] == 0


def test_paragraph_block_is_indexed():
    content = [
        {
            "id": "p1",
            "type": "paragraph",
            "content": [{"type": "text", "text": "Hello world"}],
            "children": [],
        }
    ]
    result = parse(content)
    assert result[0]["block_id"] == "p1"
    assert result[0]["chunk_text"] == "Hello world"


def test_empty_block_is_skipped():
    content = [
        {"id": "b1", "type": "paragraph", "content": [], "children": []},
        {"id": "b2", "type": "paragraph", "content": [{"type": "text", "text": "real text"}], "children": []},
    ]
    result = parse(content)
    assert len(result) == 1
    assert result[0]["block_id"] == "b2"


def test_horizontal_rule_is_skipped():
    content = [
        {"id": "d1", "type": "horizontalRule", "content": [], "children": []},
        {"id": "p1", "type": "paragraph", "content": [{"type": "text", "text": "after divider"}], "children": []},
    ]
    result = parse(content)
    assert len(result) == 1
    assert result[0]["block_id"] == "p1"


def test_nested_children_are_traversed():
    content = [
        {
            "id": "b1",
            "type": "bulletListItem",
            "content": [{"type": "text", "text": "Parent item"}],
            "children": [
                {
                    "id": "b2",
                    "type": "bulletListItem",
                    "content": [{"type": "text", "text": "Child item"}],
                    "children": [],
                }
            ],
        }
    ]
    result = parse(content)
    assert len(result) == 2
    assert result[0]["block_id"] == "b1"
    assert result[0]["chunk_text"] == "Parent item"
    assert result[1]["block_id"] == "b2"
    assert result[1]["chunk_text"] == "Child item"


def test_chunk_index_reflects_traversal_order():
    content = [
        {"id": "a", "type": "paragraph", "content": [{"type": "text", "text": "first"}], "children": []},
        {"id": "b", "type": "paragraph", "content": [{"type": "text", "text": "second"}], "children": []},
        {"id": "c", "type": "paragraph", "content": [{"type": "text", "text": "third"}], "children": []},
    ]
    result = parse(content)
    assert [r["chunk_index"] for r in result] == [0, 1, 2]


def test_multiple_inline_texts_concatenated():
    content = [
        {
            "id": "b1",
            "type": "paragraph",
            "content": [
                {"type": "text", "text": "Hello"},
                {"type": "text", "text": "world"},
            ],
            "children": [],
        }
    ]
    result = parse(content)
    # text parts joined by " " separator
    assert "Hello" in result[0]["chunk_text"]
    assert "world" in result[0]["chunk_text"]


def test_empty_content_returns_empty_list():
    assert parse([]) == []
    assert parse(None) == []


def test_deep_nesting_traversed():
    content = [
        {
            "id": "top",
            "type": "toggle",
            "content": [{"type": "text", "text": "Toggle heading"}],
            "children": [
                {
                    "id": "mid",
                    "type": "bulletListItem",
                    "content": [{"type": "text", "text": "bullet"}],
                    "children": [
                        {
                            "id": "leaf",
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "deep"}],
                            "children": [],
                        }
                    ],
                }
            ],
        }
    ]
    result = parse(content)
    ids = [r["block_id"] for r in result]
    assert "top" in ids
    assert "mid" in ids
    assert "leaf" in ids
