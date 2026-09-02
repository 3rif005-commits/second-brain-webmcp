"""Milestone 5 (task-14-brief.md §2): Select, MultiSelect, Status."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from services.db.keys import mint_key
from services.db.properties.base import REGISTRY, SqlContext, _GenericProperty
from services.db.properties.choice import (
    MultiSelect,
    MultiSelectConfig,
    Select,
    SelectConfig,
    SelectOption,
    Status,
    StatusConfig,
    StatusOption,
)


def _opt(name: str, **kw) -> SelectOption:
    return SelectOption(id=mint_key(), name=name, **kw)


def _status_opt(name: str, group: str = "To-do") -> StatusOption:
    return StatusOption(id=mint_key(), name=name, group=group)


# ---------------------------------------------------------------------------
# SelectOption / StatusOption
# ---------------------------------------------------------------------------

def test_select_option_defaults_color():
    opt = SelectOption(id="abc12345", name="Red")
    assert opt.color == "default"


def test_select_option_is_frozen():
    opt = SelectOption(id="abc12345", name="Red")
    with pytest.raises(ValidationError):
        opt.name = "Blue"


def test_status_option_defaults_group_to_do():
    opt = StatusOption(id="abc12345", name="Not started")
    assert opt.group == "To-do"


def test_status_option_rejects_unknown_group():
    with pytest.raises(ValidationError):
        StatusOption(id="abc12345", name="X", group="Blocked")


# ---------------------------------------------------------------------------
# Select
# ---------------------------------------------------------------------------

def test_select_default_and_is_empty():
    s = Select()
    assert s.default() is None
    assert s.is_empty(None) is True
    assert s.is_empty("") is True
    assert s.is_empty("optid") is False


def test_select_config_default_options_empty():
    assert SelectConfig().options == []


def test_select_config_holds_typed_options():
    opt = _opt("Red")
    cfg = SelectConfig(options=[opt])
    assert cfg.options == [opt]


def test_select_coerce_write_none_is_valid():
    assert Select().coerce_write(None) is None


def test_select_coerce_write_accepts_known_option_id():
    opt = _opt("Red")
    assert Select().coerce_write(opt.id, options=(opt,)) == opt.id


def test_select_coerce_write_rejects_unknown_option_id():
    opt = _opt("Red")
    with pytest.raises(ValueError):
        Select().coerce_write("not-a-real-id", options=(opt,))


def test_select_coerce_write_rejects_any_value_when_no_options_given():
    # No config wired to this call -- "no options given" must not silently
    # accept an unvalidated id (spec §8.2's whole point).
    with pytest.raises(ValueError):
        Select().coerce_write("some-id")


def test_select_coerce_write_rejects_non_string():
    opt = _opt("Red")
    with pytest.raises(ValueError):
        Select().coerce_write(["not", "a", "string"], options=(opt,))
    with pytest.raises(ValueError):
        Select().coerce_write(123, options=(opt,))


def test_select_operators_and_aggregations():
    ops = Select().operators()
    assert ops["equals"].arg_type == "str_or_list"
    assert set(ops) == {"equals", "does_not_equal", "is_empty", "is_not_empty"}


def test_select_registry_entry_is_the_rich_descriptor():
    assert isinstance(REGISTRY["select"], Select)


# --- sql_extract/sql_order byte-identity ---

def test_select_sql_extract_byte_identical_to_generic():
    ctx = SqlContext(key="selAbc123", alias="p")
    assert Select().sql_extract(ctx).sql == _GenericProperty(key="select").sql_extract(ctx).sql


def test_select_sql_order_byte_identical_to_generic():
    ctx = SqlContext(key="selAbc123", alias="p")
    for direction in ("asc", "desc"):
        assert (
            Select().sql_order(ctx, direction).sql
            == _GenericProperty(key="select").sql_order(ctx, direction).sql
        )


def test_select_sql_extract_byte_identical_for_column_storage():
    ctx = SqlContext(key="mastery_status", alias="notes", storage="column")
    assert (
        REGISTRY["status"].sql_extract(ctx).sql
        == _GenericProperty(key="status").sql_extract(ctx).sql
        == "notes.mastery_status"
    )


# ---------------------------------------------------------------------------
# MultiSelect
# ---------------------------------------------------------------------------

def test_multi_select_default_and_is_empty():
    m = MultiSelect()
    assert m.default() is None
    assert m.is_empty(None) is True
    assert m.is_empty([]) is True
    assert m.is_empty(["a"]) is False


def test_multi_select_config_default_options_empty():
    assert MultiSelectConfig().options == []


def test_multi_select_coerce_write_none_is_valid():
    assert MultiSelect().coerce_write(None) is None


def test_multi_select_coerce_write_empty_list_is_valid_regardless_of_options():
    assert MultiSelect().coerce_write([]) == []


def test_multi_select_coerce_write_accepts_known_option_ids():
    a, b = _opt("Red"), _opt("Blue")
    assert MultiSelect().coerce_write([a.id, b.id], options=(a, b)) == [a.id, b.id]


def test_multi_select_coerce_write_rejects_any_unknown_id_in_the_list():
    a, b = _opt("Red"), _opt("Blue")
    with pytest.raises(ValueError):
        MultiSelect().coerce_write([a.id, "bogus"], options=(a, b))


def test_multi_select_coerce_write_rejects_non_list():
    with pytest.raises(ValueError):
        MultiSelect().coerce_write("not-a-list")


def test_multi_select_operators():
    ops = MultiSelect().operators()
    assert set(ops) == {"contains", "does_not_contain", "is_empty", "is_not_empty"}


def test_multi_select_registry_entry_is_the_rich_descriptor():
    assert isinstance(REGISTRY["multi_select"], MultiSelect)


def test_multi_select_sql_extract_byte_identical_to_generic():
    ctx = SqlContext(key="msAbc1234", alias="p")
    assert (
        MultiSelect().sql_extract(ctx).sql
        == _GenericProperty(key="multi_select").sql_extract(ctx).sql
    )


def test_multi_select_sql_order_byte_identical_to_generic_and_uses_first_element():
    ctx = SqlContext(key="msAbc1234", alias="p")
    for direction in ("asc", "desc"):
        order = MultiSelect().sql_order(ctx, direction)
        assert order.sql == _GenericProperty(key="multi_select").sql_order(ctx, direction).sql
    assert "->> 0" in MultiSelect().sql_order(ctx, "asc").sql


def test_multi_select_sql_extract_byte_identical_for_native_array_column():
    # `topics` is COLUMN_BACKED as multi_select with native_array=True.
    ctx = SqlContext(key="topics", alias="notes", storage="column")
    assert (
        MultiSelect().sql_extract(ctx).sql
        == _GenericProperty(key="multi_select").sql_extract(ctx).sql
        == "notes.topics"
    )


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

def test_status_default_is_none_documented_protocol_limitation():
    """Spec intent (research §7) is that an unconfigured status property's
    default should be the id of a "Not started" option in group "To-do".
    `PropertyType.default()` takes no config parameter, and REGISTRY holds
    one Status instance shared by every status property, so there is no
    per-property option list this method could consult. `None` is the
    documented fallback M5 ships -- this test locks that fallback in and
    exists specifically so a future change silently reintroducing a
    config-carrying default() gets caught."""
    assert Status().default() is None


def test_status_is_empty():
    st = Status()
    assert st.is_empty(None) is True
    assert st.is_empty("") is True
    assert st.is_empty("optid") is False


def test_status_config_default_options_empty():
    assert StatusConfig().options == []


def test_status_config_holds_typed_status_options():
    opt = _status_opt("In progress", group="In progress")
    cfg = StatusConfig(options=[opt])
    assert cfg.options[0].group == "In progress"


def test_status_coerce_write_none_is_valid():
    assert Status().coerce_write(None) is None


def test_status_coerce_write_accepts_known_option_id():
    opt = _status_opt("Done", group="Complete")
    assert Status().coerce_write(opt.id, options=(opt,)) == opt.id


def test_status_coerce_write_rejects_unknown_option_id():
    opt = _status_opt("Done", group="Complete")
    with pytest.raises(ValueError):
        Status().coerce_write("bogus", options=(opt,))


def test_status_operators_same_family_as_select():
    assert set(Status().operators()) == set(Select().operators())


def test_status_registry_entry_is_the_rich_descriptor():
    assert isinstance(REGISTRY["status"], Status)


def test_status_sql_extract_byte_identical_to_generic():
    ctx = SqlContext(key="stAbc1234", alias="p")
    assert Status().sql_extract(ctx).sql == _GenericProperty(key="status").sql_extract(ctx).sql


def test_status_sql_order_byte_identical_to_generic():
    ctx = SqlContext(key="stAbc1234", alias="p")
    for direction in ("asc", "desc"):
        assert (
            Status().sql_order(ctx, direction).sql
            == _GenericProperty(key="status").sql_order(ctx, direction).sql
        )


def test_status_sql_extract_byte_identical_for_column_storage():
    # `mastery_status` is COLUMN_BACKED as status.
    ctx = SqlContext(key="mastery_status", alias="notes", storage="column")
    assert (
        REGISTRY["status"].sql_extract(ctx).sql
        == _GenericProperty(key="status").sql_extract(ctx).sql
        == "notes.mastery_status"
    )
