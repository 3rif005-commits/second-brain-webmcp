"""Tests for services/db/views.py: sweeping a deleted property's references
out of every view's filter/sorts/config.properties[] (spec §10).

`strip_property_key` is pure (no I/O) and tested directly with plain dicts/
lists mirroring spec §8.1's filter AST and §10's view config shape.
`sweep_property_from_views` is tested against the local pgtest harness
(db_conn fixture, transaction rolled back — see tests/conftest.py). NEVER
touches the real Supabase database.
"""
from services.db.views import strip_property_key, sweep_property_from_views


# ---------------------------------------------------------------------------
# strip_property_key — pure JSONB-walk tests
# ---------------------------------------------------------------------------

def test_strip_removes_matching_condition_from_flat_group():
    filter_json = {
        "type": "group", "op": "and",
        "children": [
            {"type": "condition", "property": "a7Kd9x", "operator": "greater_than", "value": 10},
            {"type": "condition", "property": "p2Lm4q", "operator": "equals", "value": "x"},
        ],
    }
    new_filter, _, _ = strip_property_key(filter_json, [], {}, "a7Kd9x")
    assert new_filter == {
        "type": "group", "op": "and",
        "children": [
            {"type": "condition", "property": "p2Lm4q", "operator": "equals", "value": "x"},
        ],
    }


def test_strip_recurses_into_nested_groups():
    filter_json = {
        "type": "group", "op": "and", "children": [
            {"type": "condition", "property": "a7Kd9x", "operator": "greater_than", "value": 10},
            {"type": "group", "op": "or", "children": [
                {"type": "condition", "property": "p2Lm4q", "operator": "contains", "value": "opt_a1"},
                {"type": "condition", "property": "z8Rt0v", "operator": "past_week", "value": {}},
            ]},
        ],
    }
    new_filter, _, _ = strip_property_key(filter_json, [], {}, "p2Lm4q")
    assert new_filter == {
        "type": "group", "op": "and", "children": [
            {"type": "condition", "property": "a7Kd9x", "operator": "greater_than", "value": 10},
            {"type": "group", "op": "or", "children": [
                {"type": "condition", "property": "z8Rt0v", "operator": "past_week", "value": {}},
            ]},
        ],
    }


def test_strip_drops_the_whole_filter_when_root_is_the_matching_condition():
    filter_json = {"type": "condition", "property": "a7Kd9x", "operator": "is_empty", "value": None}
    new_filter, _, _ = strip_property_key(filter_json, [], {}, "a7Kd9x")
    assert new_filter is None


def test_strip_removes_matching_sort_entry():
    sorts = [
        {"property": "a7Kd9x", "direction": "asc"},
        {"property": "p2Lm4q", "direction": "desc"},
    ]
    _, new_sorts, _ = strip_property_key(None, sorts, {}, "a7Kd9x")
    assert new_sorts == [{"property": "p2Lm4q", "direction": "desc"}]


def test_strip_removes_matching_config_properties_entry():
    config = {
        "frozen_column_index": 0,
        "properties": [
            {"property": "a7Kd9x", "visible": True, "width": 200},
            {"property": "p2Lm4q", "visible": True, "width": 150},
        ],
    }
    _, _, new_config = strip_property_key(None, [], config, "a7Kd9x")
    assert new_config == {
        "frozen_column_index": 0,
        "properties": [{"property": "p2Lm4q", "visible": True, "width": 150}],
    }


def test_strip_is_a_noop_when_key_is_absent():
    filter_json = {"type": "condition", "property": "p2Lm4q", "operator": "equals", "value": "x"}
    sorts = [{"property": "p2Lm4q", "direction": "asc"}]
    config = {"properties": [{"property": "p2Lm4q", "visible": True}]}
    new_filter, new_sorts, new_config = strip_property_key(filter_json, sorts, config, "a7Kd9x")
    assert new_filter == filter_json
    assert new_sorts == sorts
    assert new_config == config


def test_strip_handles_none_filter():
    new_filter, new_sorts, new_config = strip_property_key(None, [], {}, "a7Kd9x")
    assert new_filter is None
    assert new_sorts == []
    assert new_config == {}


def test_strip_handles_depth_up_to_the_spec_sanity_cap():
    # spec §8.1: filter nesting is sanity-capped at 10 levels.
    key = "deep0001"
    node = {"type": "condition", "property": key, "operator": "is_empty", "value": None}
    for _ in range(10):
        node = {"type": "group", "op": "and", "children": [node]}
    new_filter, _, _ = strip_property_key(node, [], {}, key)

    # The innermost condition is gone; walking back out just leaves nested
    # empty groups, never a leftover reference to the deleted key.
    import json
    assert key not in json.dumps(new_filter)


def test_strip_nulls_group_by_when_it_directly_matches():
    # spec §10: the sweep covers "filter, sorts, config.properties[] and
    # group_by" — group_by is documented as `object | null`, i.e. a
    # dict-valued field, not a list element like the other three.
    config = {
        "group_by": {"property": "a7Kd9x", "direction": "asc"},
        "properties": [{"property": "p2Lm4q", "visible": True}],
    }
    _, _, new_config = strip_property_key(None, [], config, "a7Kd9x")
    assert new_config == {
        "group_by": None,
        "properties": [{"property": "p2Lm4q", "visible": True}],
    }


def test_strip_leaves_group_by_untouched_when_it_does_not_match():
    config = {"group_by": {"property": "p2Lm4q", "direction": "asc"}}
    _, _, new_config = strip_property_key(None, [], config, "a7Kd9x")
    assert new_config == config


# ---------------------------------------------------------------------------
# sweep_property_from_views — integration against the local pgtest harness
# ---------------------------------------------------------------------------

async def _make_database_chain(db_conn, user_id):
    """Insert one db_databases + db_data_sources row, return the data
    source id."""
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'T') RETURNING id",
        user_id,
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, 'Default') RETURNING id",
        db_row["id"], user_id,
    )
    return str(ds_row["id"])


async def test_sweep_rewrites_only_views_that_reference_the_key(db_conn, test_user):
    data_source_id = await _make_database_chain(db_conn, test_user)

    referencing = await db_conn.fetchrow(
        """
        INSERT INTO db_views (data_source_id, user_id, name, type, filter, sorts, config)
        VALUES ($1, $2, 'V1', 'table', $3, $4, $5)
        RETURNING id
        """,
        data_source_id, test_user,
        {"type": "condition", "property": "a7Kd9x", "operator": "is_empty", "value": None},
        [{"property": "a7Kd9x", "direction": "asc"}],
        {"properties": [{"property": "a7Kd9x", "visible": True}]},
    )
    untouched = await db_conn.fetchrow(
        """
        INSERT INTO db_views (data_source_id, user_id, name, type, filter, sorts, config)
        VALUES ($1, $2, 'V2', 'table', $3, $4, $5)
        RETURNING id
        """,
        data_source_id, test_user,
        {"type": "condition", "property": "p2Lm4q", "operator": "is_empty", "value": None},
        [{"property": "p2Lm4q", "direction": "asc"}],
        {"properties": [{"property": "p2Lm4q", "visible": True}]},
    )

    changed = await sweep_property_from_views(db_conn, test_user, data_source_id, "a7Kd9x")
    assert changed == 1

    row1 = await db_conn.fetchrow("SELECT filter, sorts, config FROM db_views WHERE id = $1", referencing["id"])
    assert row1["filter"] is None
    assert row1["sorts"] == []
    assert row1["config"] == {"properties": []}

    row2 = await db_conn.fetchrow("SELECT filter, sorts, config FROM db_views WHERE id = $1", untouched["id"])
    assert row2["filter"] == {"type": "condition", "property": "p2Lm4q", "operator": "is_empty", "value": None}
    assert row2["sorts"] == [{"property": "p2Lm4q", "direction": "asc"}]
    assert row2["config"] == {"properties": [{"property": "p2Lm4q", "visible": True}]}
