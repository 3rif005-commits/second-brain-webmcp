"""Unit tests for `services.db.properties.format.format_property_value` —
decoupled from indexer plumbing (Milestone 14, Task 46).

Value shapes here mirror what `frontend/lib/database/types.ts`'s
`PropertyValue` union documents (the wrapper is `{"type": ..., "<type>":
value}`) — this module takes the already-unwrapped `value` half, per its
own docstring.
"""
from services.db.properties.format import format_property_value


# ── absent / empty -> None, regardless of type ───────────────────────────

def test_none_value_is_none_for_every_type():
    for prop_type in ("rich_text", "number", "checkbox", "date", "multi_select",
                       "select", "status", "unique_id", "people", "files",
                       "relation", "formula", "rollup", "button"):
        assert format_property_value(prop_type, None) is None


def test_empty_string_is_none():
    assert format_property_value("rich_text", "") is None
    assert format_property_value("rich_text", "   ") is None


def test_empty_list_is_none():
    assert format_property_value("multi_select", []) is None


def test_empty_dict_is_none():
    assert format_property_value("date", {}) is None


# ── scalar text: rich_text / url / email / phone_number / title ─────────

def test_rich_text_renders_stripped_text():
    assert format_property_value("rich_text", "  hello world  ") == "hello world"


def test_url_renders_as_is():
    assert format_property_value("url", "https://example.com") == "https://example.com"


def test_title_renders_as_is():
    assert format_property_value("title", "My Note") == "My Note"


def test_non_string_scalar_is_none():
    assert format_property_value("rich_text", 42) is None


# ── number ────────────────────────────────────────────────────────────────

def test_number_integer_float_renders_without_decimal():
    assert format_property_value("number", 42.0) == "42"


def test_number_fractional_float_renders_with_decimal():
    assert format_property_value("number", 3.5) == "3.5"


def test_number_int_renders_as_is():
    assert format_property_value("number", 7) == "7"


def test_number_bool_is_none():
    # bool is a subclass of int -- must not be mistaken for a real number.
    assert format_property_value("number", True) is None


# ── checkbox ──────────────────────────────────────────────────────────────

def test_checkbox_true_renders_yes():
    assert format_property_value("checkbox", True) == "Yes"


def test_checkbox_false_renders_no():
    # False is a real, meaningful value (unchecked) -- not "empty".
    assert format_property_value("checkbox", False) == "No"


def test_checkbox_non_bool_is_none():
    assert format_property_value("checkbox", "true") is None


# ── date ──────────────────────────────────────────────────────────────────

def test_date_start_only():
    assert format_property_value("date", {"start": "2026-09-01"}) == "2026-09-01"


def test_date_start_with_full_timestamp_truncates_to_date():
    assert format_property_value("date", {"start": "2026-09-01T10:30:00+00:00"}) == "2026-09-01"


def test_date_start_and_end_range():
    value = {"start": "2026-09-01", "end": "2026-09-10"}
    assert format_property_value("date", value) == "2026-09-01 → 2026-09-10"


def test_date_same_start_and_end_renders_once():
    value = {"start": "2026-09-01", "end": "2026-09-01"}
    assert format_property_value("date", value) == "2026-09-01"


def test_date_missing_start_is_none():
    assert format_property_value("date", {"end": "2026-09-01"}) is None


# ── array type: multi_select ─────────────────────────────────────────────

def test_multi_select_resolves_ids_to_configured_names():
    config = {"options": [
        {"id": "opt1", "name": "rust", "color": "blue"},
        {"id": "opt2", "name": "async", "color": "green"},
    ]}
    assert format_property_value("multi_select", ["opt1", "opt2"], config) == "rust, async"


def test_multi_select_falls_back_to_raw_id_without_config_match():
    assert format_property_value("multi_select", ["opt1", "opt2"], {}) == "opt1, opt2"


def test_multi_select_empty_list_is_none():
    assert format_property_value("multi_select", [], {"options": []}) is None


# ── select / status: single option, same resolution as multi_select ─────

def test_select_resolves_id_to_configured_name():
    config = {"options": [{"id": "opt1", "name": "In progress", "color": "yellow"}]}
    assert format_property_value("select", "opt1", config) == "In progress"


def test_status_resolves_id_to_configured_name():
    config = {"options": [{"id": "opt9", "name": "Done", "group": "Complete"}]}
    assert format_property_value("status", "opt9", config) == "Done"


def test_select_without_config_falls_back_to_raw_id():
    assert format_property_value("select", "opt1") == "opt1"


# ── unique_id ─────────────────────────────────────────────────────────────

def test_unique_id_without_prefix():
    assert format_property_value("unique_id", 42) == "42"


def test_unique_id_with_prefix():
    assert format_property_value("unique_id", 42, {"prefix": "TASK"}) == "TASK-42"


# ── people / files: raw-render (documented, no directory/name resolution) ─

def test_people_raw_renders_ids():
    assert format_property_value("people", ["u1", "u2"]) == "u1, u2"


def test_files_renders_names_when_present():
    value = [{"name": "spec.pdf", "url": "https://x/spec.pdf"}, {"name": "notes.txt"}]
    assert format_property_value("files", value) == "spec.pdf, notes.txt"


# ── documented skip: relation (no fetched target title available here) ──

def test_relation_is_always_skipped():
    assert format_property_value("relation", ["note-id-1", "note-id-2"]) is None


def test_formula_and_rollup_are_skipped():
    assert format_property_value("formula", 42) is None
    assert format_property_value("rollup", "anything") is None


def test_button_is_always_skipped():
    assert format_property_value("button", {"anything": True}) is None


def test_created_by_and_last_edited_by_are_skipped():
    assert format_property_value("created_by", "user-uuid") is None
    assert format_property_value("last_edited_by", "user-uuid") is None


def test_place_and_verification_are_skipped():
    assert format_property_value("place", {"lat": 1, "lng": 2}) is None
    assert format_property_value("verification", {"state": "verified"}) is None
