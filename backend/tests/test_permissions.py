"""Permission gate tests — see spec §3.7 and §3.5 (tool matrix)."""
import pytest

from models.agent import Tier
from services.agent.permissions import (
    Allow,
    Deny,
    check,
)


def _is_allowed(decision):
    return isinstance(decision, Allow)


def test_external_can_read():
    assert _is_allowed(check("brain.search_brain", Tier.EXTERNAL,
                             args={"query": "x"}, note_meta=None))


def test_external_cannot_write():
    decision = check("brain.create_note", Tier.EXTERNAL,
                     args={"title": "t", "blocks": []}, note_meta=None)
    assert isinstance(decision, Deny)
    assert "external" in decision.reason.lower()


def test_external_get_note_denied_for_local_only():
    decision = check("brain.get_note", Tier.EXTERNAL,
                     args={"id": "n1"}, note_meta={"local_only": True})
    assert isinstance(decision, Deny)
    assert "local_only" in decision.reason


def test_external_get_note_allowed_for_normal():
    assert _is_allowed(check("brain.get_note", Tier.EXTERNAL,
                             args={"id": "n1"},
                             note_meta={"local_only": False}))


def test_internal_api_get_note_denied_for_local_only():
    decision = check("brain.get_note", Tier.INTERNAL_API,
                     args={"id": "n1"}, note_meta={"local_only": True})
    assert isinstance(decision, Deny)


def test_internal_api_update_denied_for_local_only():
    decision = check("brain.update_note", Tier.INTERNAL_API,
                     args={"id": "n1", "blocks": []},
                     note_meta={"local_only": True})
    assert isinstance(decision, Deny)


def test_internal_api_can_create_note():
    assert _is_allowed(check("brain.create_note", Tier.INTERNAL_API,
                             args={"title": "t", "blocks": []},
                             note_meta=None))


def test_internal_local_allows_everything_on_local_only_notes():
    assert _is_allowed(check("brain.get_note", Tier.INTERNAL_LOCAL,
                             args={"id": "n1"},
                             note_meta={"local_only": True}))
    assert _is_allowed(check("brain.update_note", Tier.INTERNAL_LOCAL,
                             args={"id": "n1", "blocks": []},
                             note_meta={"local_only": True}))


def test_delete_requires_confirm_flag_in_args():
    decision = check("brain.delete_note", Tier.INTERNAL_API,
                     args={"id": "n1"}, note_meta=None)
    assert isinstance(decision, Deny)
    assert "confirm" in decision.reason.lower()
    # With confirm flag set, allowed
    assert _is_allowed(check("brain.delete_note", Tier.INTERNAL_API,
                             args={"id": "n1", "confirm": True},
                             note_meta=None))


def test_unknown_tool_denied_by_default():
    decision = check("brain.unknown_tool", Tier.INTERNAL_LOCAL,
                     args={}, note_meta=None)
    assert isinstance(decision, Deny)


def test_editor_insert_block_requires_internal():
    from models.agent import Tier
    from services.agent.permissions import Allow, Deny, check
    assert isinstance(check("editor.insert_block", Tier.INTERNAL_API, {}, None), Allow)
    assert isinstance(check("editor.insert_block", Tier.EXTERNAL, {}, None), Deny)


def test_mcp_tool_allowed_at_internal_tier():
    assert _is_allowed(check("mcp.websearch.search", Tier.INTERNAL_API, {}, None))
    assert _is_allowed(check("mcp.calendar.list_events", Tier.INTERNAL_LOCAL, {}, None))


def test_mcp_tool_denied_at_external_tier():
    decision = check("mcp.websearch.search", Tier.EXTERNAL, {}, None)
    assert isinstance(decision, Deny)
    assert "external" in decision.reason.lower()
