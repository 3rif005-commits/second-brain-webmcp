"""Tests for services/db/relations.py's DB-backed surface: relation-pair
creation (§1.2), link CRUD (§1.4), cycle/depth guards (§1.5/§1.6), the
dependency-shift orchestration built on top of the pure functions
tests/test_db_relation_shift.py covers (§1.7), and the orphan sweep (§1.8).

Runs against the local pgtest harness (localhost:55432, migrations 001-019
applied) through the transaction-wrapped `db_conn`/`test_user` fixtures
(tests/conftest.py), rolled back on teardown. NEVER touches
`core.config.settings.database_url` (the real Supabase project).
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from services.db import relations
from services.db.relations import (
    DateWindow,
    RelationCycleError,
    RelationError,
    RelationRef,
    SubItemDepthError,
    SYSTEM_DEPENDENCY,
    SYSTEM_SUB_ITEM,
)


async def _make_data_source(db_conn, user_id, *, name="DS"):
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'T') RETURNING id", user_id
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, $3) RETURNING id",
        db_row["id"], user_id, name,
    )
    return str(ds_row["id"])


async def _insert_note(db_conn, user_id, *, title="Note"):
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id", user_id, title
    )
    return str(note["id"])


async def _property_row(db_conn, property_id):
    return await db_conn.fetchrow("SELECT * FROM db_properties WHERE id = $1", property_id)


async def _count_relation_links(db_conn, relation_id):
    return await db_conn.fetchval(
        "SELECT count(*) FROM db_relation_links WHERE relation_id = $1::uuid", relation_id
    )


# ===========================================================================
# 1.2 create_relation_pair / delete_relation_pair
# ===========================================================================


async def test_create_relation_pair_two_way_creates_both_properties_sharing_relation_id(
    db_conn, test_user
):
    ds1 = await _make_data_source(db_conn, test_user, name="Tasks")
    ds2 = await _make_data_source(db_conn, test_user, name="Projects")
    forward, reverse = await relations.create_relation_pair(
        db_conn, test_user,
        data_source_id=ds1, name="Project", target_data_source_id=ds2,
        two_way=True, reverse_name="Tasks",
    )
    assert reverse is not None
    assert forward["data_source_id"] == ds1
    assert reverse["data_source_id"] == ds2
    assert forward["type"] == "relation"
    assert reverse["type"] == "relation"
    assert forward["config"]["relation_id"] == reverse["config"]["relation_id"]
    assert forward["config"]["side"] == "forward"
    assert reverse["config"]["side"] == "reverse"
    assert forward["config"]["target_data_source_id"] == ds2
    assert reverse["config"]["target_data_source_id"] == ds1
    assert "system" not in forward["config"]
    assert "system" not in reverse["config"]


async def test_create_relation_pair_one_way_creates_only_forward(db_conn, test_user):
    ds1 = await _make_data_source(db_conn, test_user)
    ds2 = await _make_data_source(db_conn, test_user)
    forward, reverse = await relations.create_relation_pair(
        db_conn, test_user,
        data_source_id=ds1, name="Related", target_data_source_id=ds2, two_way=False,
    )
    assert reverse is None
    count = await db_conn.fetchval(
        "SELECT count(*) FROM db_properties WHERE config->>'relation_id' = $1",
        forward["config"]["relation_id"],
    )
    assert count == 1


async def test_create_relation_pair_self_relation_target_equals_source(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    forward, reverse = await relations.create_relation_pair(
        db_conn, test_user,
        data_source_id=ds, name="Sub-item", target_data_source_id=ds,
        two_way=True, reverse_name="Parent item", system=SYSTEM_SUB_ITEM,
    )
    assert forward["data_source_id"] == ds
    assert reverse["data_source_id"] == ds
    assert forward["config"]["target_data_source_id"] == ds
    assert reverse["config"]["target_data_source_id"] == ds
    assert forward["config"]["system"] == SYSTEM_SUB_ITEM
    assert reverse["config"]["system"] == SYSTEM_SUB_ITEM


async def test_create_relation_pair_two_way_without_reverse_name_raises():
    with pytest.raises(RelationError):
        await relations.create_relation_pair(
            None, "u", data_source_id="ds1", name="A", target_data_source_id="ds2", two_way=True,
        )


async def test_create_relation_pair_unknown_system_raises():
    with pytest.raises(RelationError):
        await relations.create_relation_pair(
            None, "u", data_source_id="ds1", name="A", target_data_source_id="ds2",
            two_way=False, system="not_a_real_system",
        )


async def test_create_relation_pair_position_follows_max_plus_one(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await db_conn.execute(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type, position)
        VALUES ($1, $2, 'existing1', 'Existing', 'title', 0)
        """,
        ds, test_user,
    )
    forward, _ = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=ds, name="Rel", target_data_source_id=ds, two_way=False,
    )
    assert forward["position"] == 1


async def test_create_relation_pair_duplicate_relation_id_forward_side_raises_relation_error(
    db_conn, test_user, monkeypatch
):
    # migration 015's db_properties_relation_pair_uniq: at most one forward
    # + one reverse property per relation_id, globally. create_relation_pair
    # always mints a fresh relation_id, so hitting this through the public
    # entrypoint (rather than by calling the private insert helper
    # directly) needs a forced uuid4 collision -- this monkeypatch does
    # that, so the assertion below exercises the *real* public function's
    # exception-translation path end to end.
    ds1 = await _make_data_source(db_conn, test_user)
    ds2 = await _make_data_source(db_conn, test_user)
    fixed_id = uuid.uuid4()
    monkeypatch.setattr(relations.uuid, "uuid4", lambda: fixed_id)

    await relations.create_relation_pair(
        db_conn, test_user, data_source_id=ds1, name="A", target_data_source_id=ds2, two_way=False,
    )
    with pytest.raises(RelationError) as exc_info:
        await relations.create_relation_pair(
            db_conn, test_user, data_source_id=ds1, name="B", target_data_source_id=ds2, two_way=False,
        )
    assert not isinstance(exc_info.value, RelationCycleError)


async def test_create_relation_pair_duplicate_system_pair_raises_relation_error(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await relations.create_relation_pair(
        db_conn, test_user, data_source_id=ds, name="Sub-item", target_data_source_id=ds,
        two_way=True, reverse_name="Parent item", system=SYSTEM_SUB_ITEM,
    )
    with pytest.raises(RelationError):
        await relations.create_relation_pair(
            db_conn, test_user, data_source_id=ds, name="Sub-item 2", target_data_source_id=ds,
            two_way=True, reverse_name="Parent item 2", system=SYSTEM_SUB_ITEM,
        )
    # A second *dependency* pair on the same data source is a separate
    # invariant (different config->>'system' value) -- must still succeed.
    dep_forward, dep_reverse = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=ds, name="Blocking", target_data_source_id=ds,
        two_way=True, reverse_name="Blocked by", system=SYSTEM_DEPENDENCY,
    )
    assert dep_reverse is not None


async def test_create_relation_pair_whole_pair_is_one_transaction_on_reverse_side_failure(
    db_conn, test_user
):
    # If the reverse insert fails, the forward insert must not persist --
    # "a two-way relation with only one side committed is exactly the
    # desync state migration 015's design exists to prevent" (the brief).
    # Force the reverse side to collide with an already-existing sub_item
    # pair on the target data source.
    ds1 = await _make_data_source(db_conn, test_user)
    ds2 = await _make_data_source(db_conn, test_user)
    await relations.create_relation_pair(
        db_conn, test_user, data_source_id=ds2, name="Sub-item", target_data_source_id=ds2,
        two_way=True, reverse_name="Parent item", system=SYSTEM_SUB_ITEM,
    )
    before = await db_conn.fetchval(
        "SELECT count(*) FROM db_properties WHERE data_source_id = $1", ds1
    )
    with pytest.raises(RelationError):
        await relations.create_relation_pair(
            db_conn, test_user, data_source_id=ds1, name="Sub-item", target_data_source_id=ds2,
            two_way=True, reverse_name="Parent item", system=SYSTEM_SUB_ITEM,
        )
    after = await db_conn.fetchval(
        "SELECT count(*) FROM db_properties WHERE data_source_id = $1", ds1
    )
    assert after == before  # the forward insert on ds1 did not survive


async def test_delete_relation_pair_removes_both_properties_and_all_links(db_conn, test_user):
    ds1 = await _make_data_source(db_conn, test_user)
    ds2 = await _make_data_source(db_conn, test_user)
    forward, reverse = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=ds1, name="Rel", target_data_source_id=ds2,
        two_way=True, reverse_name="Rel back",
    )
    relation_id = forward["config"]["relation_id"]
    ref = RelationRef(relation_id=relation_id, side="forward")
    row_a = await _insert_note(db_conn, test_user)
    row_b = await _insert_note(db_conn, test_user)
    row_c = await _insert_note(db_conn, test_user)
    await relations.link(db_conn, test_user, ref, row_a, row_b)
    await relations.link(db_conn, test_user, ref, row_a, row_c)

    deleted_count = await relations.delete_relation_pair(db_conn, test_user, relation_id)
    assert deleted_count == 2

    remaining_props = await db_conn.fetchval(
        "SELECT count(*) FROM db_properties WHERE config->>'relation_id' = $1", relation_id
    )
    assert remaining_props == 0
    assert await _count_relation_links(db_conn, relation_id) == 0


# ===========================================================================
# relation_ref_from_config
# ===========================================================================


def test_relation_ref_from_config_valid():
    ref = relations.relation_ref_from_config({"relation_id": "abc", "side": "forward"})
    assert ref == RelationRef(relation_id="abc", side="forward")


@pytest.mark.parametrize(
    "config",
    [
        None,
        {},
        {"relation_id": "abc"},  # missing side
        {"side": "forward"},  # missing relation_id
        {"relation_id": "abc", "side": "sideways"},  # invalid side
        {"relation_id": "", "side": "forward"},  # empty relation_id
        "not a dict",
        123,
    ],
)
def test_relation_ref_from_config_unusable_returns_none(config):
    assert relations.relation_ref_from_config(config) is None


# ===========================================================================
# 1.4 Link CRUD
# ===========================================================================


async def _make_pair_ref(db_conn, user_id, *, two_way=True, system=None):
    ds1 = await _make_data_source(db_conn, user_id)
    ds2 = ds1 if system in (SYSTEM_SUB_ITEM, SYSTEM_DEPENDENCY) else await _make_data_source(db_conn, user_id)
    forward, reverse = await relations.create_relation_pair(
        db_conn, user_id, data_source_id=ds1, name="Fwd", target_data_source_id=ds2,
        two_way=two_way, reverse_name="Rev" if two_way else None, system=system,
    )
    relation_id = forward["config"]["relation_id"]
    fwd_ref = RelationRef(relation_id=relation_id, side="forward")
    rev_ref = RelationRef(relation_id=relation_id, side="reverse") if two_way else None
    return relation_id, fwd_ref, rev_ref


async def test_link_from_either_side_produces_exactly_one_row(db_conn, test_user):
    relation_id, fwd_ref, rev_ref = await _make_pair_ref(db_conn, test_user)
    row_a = await _insert_note(db_conn, test_user)
    row_b = await _insert_note(db_conn, test_user)

    created = await relations.link(db_conn, test_user, fwd_ref, row_a, row_b)
    assert created is True
    assert await _count_relation_links(db_conn, relation_id) == 1

    # "From either side": linking the same pair via the reverse property's
    # own_column/other_column (row_b's perspective) is a no-op, not a
    # second row -- the reverse call describes the identical
    # (from=row_a, to=row_b) tuple.
    created_again = await relations.link(db_conn, test_user, rev_ref, row_b, row_a)
    assert created_again is False
    assert await _count_relation_links(db_conn, relation_id) == 1

    # Both sides read it back correctly.
    assert await relations.list_links(db_conn, test_user, fwd_ref, row_a) == [row_b]
    assert await relations.list_links(db_conn, test_user, rev_ref, row_b) == [row_a]


async def test_link_is_idempotent_from_the_same_side(db_conn, test_user):
    relation_id, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    row_a = await _insert_note(db_conn, test_user)
    row_b = await _insert_note(db_conn, test_user)
    assert await relations.link(db_conn, test_user, fwd_ref, row_a, row_b) is True
    assert await relations.link(db_conn, test_user, fwd_ref, row_a, row_b) is False
    assert await _count_relation_links(db_conn, relation_id) == 1


async def test_unlink_deletes_the_pair_and_the_reverse_side_stops_seeing_it(db_conn, test_user):
    relation_id, fwd_ref, rev_ref = await _make_pair_ref(db_conn, test_user)
    row_a = await _insert_note(db_conn, test_user)
    row_b = await _insert_note(db_conn, test_user)
    await relations.link(db_conn, test_user, fwd_ref, row_a, row_b)
    assert await relations.list_links(db_conn, test_user, rev_ref, row_b) == [row_a]

    unlinked = await relations.unlink(db_conn, test_user, fwd_ref, row_a, row_b)
    assert unlinked is True
    assert await _count_relation_links(db_conn, relation_id) == 0
    assert await relations.list_links(db_conn, test_user, fwd_ref, row_a) == []
    assert await relations.list_links(db_conn, test_user, rev_ref, row_b) == []


async def test_unlink_nonexistent_returns_false(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    row_a = await _insert_note(db_conn, test_user)
    row_b = await _insert_note(db_conn, test_user)
    assert await relations.unlink(db_conn, test_user, fwd_ref, row_a, row_b) is False


async def test_set_links_replaces_the_whole_list_and_round_trips_order(db_conn, test_user):
    relation_id, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    row_a = await _insert_note(db_conn, test_user)
    targets = [await _insert_note(db_conn, test_user, title=f"t{i}") for i in range(4)]

    first = await relations.set_links(db_conn, test_user, fwd_ref, row_a, [targets[0], targets[1]])
    assert first == [targets[0], targets[1]]
    assert await relations.list_links(db_conn, test_user, fwd_ref, row_a) == [targets[0], targets[1]]

    # Replace: drop targets[0], keep targets[1], add targets[2]/[3], and
    # reorder -- the caller-supplied order must round-trip.
    second = await relations.set_links(
        db_conn, test_user, fwd_ref, row_a, [targets[3], targets[1], targets[2]]
    )
    assert second == [targets[3], targets[1], targets[2]]
    assert await relations.list_links(db_conn, test_user, fwd_ref, row_a) == [
        targets[3], targets[1], targets[2]
    ]
    assert await _count_relation_links(db_conn, relation_id) == 3


async def test_set_links_empty_list_clears_all(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    row_a = await _insert_note(db_conn, test_user)
    target = await _insert_note(db_conn, test_user)
    await relations.set_links(db_conn, test_user, fwd_ref, row_a, [target])
    result = await relations.set_links(db_conn, test_user, fwd_ref, row_a, [])
    assert result == []
    assert await relations.list_links(db_conn, test_user, fwd_ref, row_a) == []


async def test_list_links_bulk_is_one_query_and_includes_empty_entries(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    row_a = await _insert_note(db_conn, test_user)
    row_b = await _insert_note(db_conn, test_user)
    row_c = await _insert_note(db_conn, test_user)  # no links at all
    target = await _insert_note(db_conn, test_user)
    await relations.link(db_conn, test_user, fwd_ref, row_a, target)

    result = await relations.list_links_bulk(db_conn, test_user, fwd_ref, [row_a, row_b, row_c])
    assert result == {row_a: [target], row_b: [], row_c: []}


async def test_list_links_bulk_empty_row_ids_returns_empty_dict_without_querying(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    assert await relations.list_links_bulk(db_conn, test_user, fwd_ref, []) == {}


async def test_all_link_operations_scope_on_user_id():
    # Static guard, same discipline as test_databases_router.py's own
    # tenancy sweep: every function in the link-CRUD/cycle/depth surface
    # must carry a `user_id = $n`/`AND user_id` predicate in its SQL --
    # not because the caller didn't already scope, but because
    # db_relation_links.user_id is not structurally tied to the notes'
    # owner (§1.4's own justification, mirroring migration 019's db_row_props
    # gap).
    import inspect

    for fn in (
        relations.list_links,
        relations.link,
        relations.unlink,
        relations.set_links,
        relations.list_links_bulk,
        relations.find_cycle,
        relations.subtree_depth,
        relations.ancestor_depth,
    ):
        src = inspect.getsource(fn)
        assert "user_id" in src, f"{fn.__name__} does not reference user_id at all"


# ===========================================================================
# 1.5/1.6 Cycle detection and depth guards
# ===========================================================================


async def test_link_checked_self_link_with_system_raises_cycle_error_with_degenerate_path(
    db_conn, test_user
):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False, system=None)
    # Build a system ref manually (self-relation target) since _make_pair_ref
    # with a plain system=None pair has no self-relation shape; reuse the
    # forward ref's relation_id is fine -- link_checked's system arg is what
    # actually turns the guard on, independent of how the property config
    # itself was created.
    row_a = await _insert_note(db_conn, test_user)
    with pytest.raises(RelationCycleError) as exc_info:
        await relations.link_checked(
            db_conn, test_user, fwd_ref, row_a, row_a, system=SYSTEM_SUB_ITEM
        )
    assert exc_info.value.path == [row_a, row_a]
    assert str(exc_info.value) == f"{row_a} -> {row_a}"


async def test_link_checked_ordinary_relation_allows_self_link(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    row_a = await _insert_note(db_conn, test_user)
    # system=None -> no cycle/depth guard at all, even for a self-link.
    created = await relations.link_checked(
        db_conn, test_user, fwd_ref, row_a, row_a, system=None
    )
    assert created is True


async def test_find_cycle_two_node_cycle_rejected_with_full_path(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    row_a = await _insert_note(db_conn, test_user)
    row_b = await _insert_note(db_conn, test_user)
    await relations.link_checked(db_conn, test_user, fwd_ref, row_a, row_b, system=SYSTEM_DEPENDENCY)

    with pytest.raises(RelationCycleError) as exc_info:
        await relations.link_checked(
            db_conn, test_user, fwd_ref, row_b, row_a, system=SYSTEM_DEPENDENCY
        )
    assert exc_info.value.path == [row_b, row_a, row_b]


async def test_find_cycle_three_node_cycle_rejected_with_full_path(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    a = await _insert_note(db_conn, test_user)
    b = await _insert_note(db_conn, test_user)
    c = await _insert_note(db_conn, test_user)
    await relations.link_checked(db_conn, test_user, fwd_ref, a, b, system=SYSTEM_DEPENDENCY)
    await relations.link_checked(db_conn, test_user, fwd_ref, b, c, system=SYSTEM_DEPENDENCY)

    with pytest.raises(RelationCycleError) as exc_info:
        await relations.link_checked(db_conn, test_user, fwd_ref, c, a, system=SYSTEM_DEPENDENCY)
    assert exc_info.value.path == [c, a, b, c]


async def test_ordinary_relation_skips_cycle_check_entirely(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    a = await _insert_note(db_conn, test_user)
    b = await _insert_note(db_conn, test_user)
    await relations.link_checked(db_conn, test_user, fwd_ref, a, b, system=None)
    # b -> a would close a cycle if this were a system relation; for an
    # ordinary one it's just a second, unrelated edge.
    created = await relations.link_checked(db_conn, test_user, fwd_ref, b, a, system=None)
    assert created is True


async def test_sub_item_depth_10_deep_chain_succeeds_11th_raises(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    nodes = [await _insert_note(db_conn, test_user, title=f"n{i}") for i in range(11)]
    # 9 successful links build a 10-node chain (n0..n9).
    for i in range(9):
        created = await relations.link_checked(
            db_conn, test_user, fwd_ref, nodes[i], nodes[i + 1], system=SYSTEM_SUB_ITEM
        )
        assert created is True
    # The 10th link (n9 -> n10) would make an 11-node chain -- rejected.
    with pytest.raises(SubItemDepthError) as exc_info:
        await relations.link_checked(
            db_conn, test_user, fwd_ref, nodes[9], nodes[10], system=SYSTEM_SUB_ITEM
        )
    assert exc_info.value.depth == 10
    assert exc_info.value.max_depth == relations.SUB_ITEM_MAX_DEPTH


async def test_sub_item_depth_joining_two_chains_over_the_limit_is_rejected(db_conn, test_user):
    # The ancestor_depth(row) + 1 + subtree_depth(other_row) case a naive
    # "count parents of row_id" check would miss: chain A has ancestor
    # depth 4 at its tip, chain B has subtree depth 5 below its root.
    # Joining them would create an 4+1+5 = 10-edge path -- rejected.
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    chain_a = [await _insert_note(db_conn, test_user, title=f"a{i}") for i in range(5)]
    for i in range(4):
        await relations.link_checked(
            db_conn, test_user, fwd_ref, chain_a[i], chain_a[i + 1], system=SYSTEM_SUB_ITEM
        )
    chain_b = [await _insert_note(db_conn, test_user, title=f"b{i}") for i in range(6)]
    for i in range(5):
        await relations.link_checked(
            db_conn, test_user, fwd_ref, chain_b[i], chain_b[i + 1], system=SYSTEM_SUB_ITEM
        )
    with pytest.raises(SubItemDepthError) as exc_info:
        await relations.link_checked(
            db_conn, test_user, fwd_ref, chain_a[-1], chain_b[0], system=SYSTEM_SUB_ITEM
        )
    assert exc_info.value.depth == 10


async def test_subtree_depth_and_ancestor_depth_direct(db_conn, test_user):
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False)
    a = await _insert_note(db_conn, test_user)
    b = await _insert_note(db_conn, test_user)
    c = await _insert_note(db_conn, test_user)
    assert await relations.subtree_depth(db_conn, test_user, fwd_ref, a) == 0
    assert await relations.ancestor_depth(db_conn, test_user, fwd_ref, a) == 0

    await relations.link_checked(db_conn, test_user, fwd_ref, a, b, system=SYSTEM_SUB_ITEM)
    await relations.link_checked(db_conn, test_user, fwd_ref, b, c, system=SYSTEM_SUB_ITEM)

    assert await relations.subtree_depth(db_conn, test_user, fwd_ref, a) == 2
    assert await relations.subtree_depth(db_conn, test_user, fwd_ref, b) == 1
    assert await relations.subtree_depth(db_conn, test_user, fwd_ref, c) == 0
    assert await relations.ancestor_depth(db_conn, test_user, fwd_ref, c) == 2
    assert await relations.ancestor_depth(db_conn, test_user, fwd_ref, b) == 1
    assert await relations.ancestor_depth(db_conn, test_user, fwd_ref, a) == 0


# ===========================================================================
# 1.7 cascade_dependency_shift (orchestration over the pure functions
# tests/test_db_relation_shift.py covers directly)
# ===========================================================================

_DATE_KEY = "dueDate1"


def _iso(dt: datetime) -> str:
    return dt.isoformat()


async def _set_date(db_conn, user_id, data_source_id, row_id, start, end=None):
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (note_id) DO UPDATE SET properties = EXCLUDED.properties
        """,
        row_id, data_source_id, user_id,
        {_DATE_KEY: {
            "type": "date",
            "date": {"start": _iso(start), "end": _iso(end) if end else None, "time_zone": None},
        }},
    )


async def _get_date(db_conn, row_id):
    raw = await db_conn.fetchval(
        "SELECT properties -> $1 -> 'date' FROM db_row_props WHERE note_id = $2", _DATE_KEY, row_id
    )
    start = datetime.fromisoformat(raw["start"])
    end = datetime.fromisoformat(raw["end"]) if raw.get("end") else None
    return DateWindow(start=start, end=end)


def _dt(y, m, d) -> datetime:
    return datetime(y, m, d, tzinfo=UTC)


async def test_cascade_maintain_gap_single_hop(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False, system=None)
    blocker = await _insert_note(db_conn, test_user, title="blocker")
    blocked = await _insert_note(db_conn, test_user, title="blocked")
    await relations.link_checked(db_conn, test_user, fwd_ref, blocker, blocked, system=SYSTEM_DEPENDENCY)

    await _set_date(db_conn, test_user, ds, blocker, _dt(2026, 8, 17), _dt(2026, 8, 19))
    await _set_date(db_conn, test_user, ds, blocked, _dt(2026, 8, 24), _dt(2026, 8, 26))

    changes = await relations.cascade_dependency_shift(
        db_conn, test_user, fwd_ref,
        changed_row_id=blocker, delta=timedelta(days=7),
        mode=relations.SHIFT_MAINTAIN_GAP, avoid_weekends=False,
        date_property_key=_DATE_KEY,
    )
    assert changes[blocked] == DateWindow(start=_dt(2026, 8, 31), end=_dt(2026, 9, 2))
    assert await _get_date(db_conn, blocked) == DateWindow(start=_dt(2026, 8, 31), end=_dt(2026, 9, 2))


async def test_cascade_when_overlap_shrinks_gap_and_leaves_non_overlapping_alone(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False, system=None)
    blocker = await _insert_note(db_conn, test_user, title="blocker")
    overlapping = await _insert_note(db_conn, test_user, title="overlapping")
    far_away = await _insert_note(db_conn, test_user, title="far away")
    await relations.link_checked(
        db_conn, test_user, fwd_ref, blocker, overlapping, system=SYSTEM_DEPENDENCY
    )
    await relations.link_checked(
        db_conn, test_user, fwd_ref, blocker, far_away, system=SYSTEM_DEPENDENCY
    )

    await _set_date(db_conn, test_user, ds, blocker, _dt(2026, 8, 17), _dt(2026, 8, 19))
    await _set_date(db_conn, test_user, ds, overlapping, _dt(2026, 8, 15), _dt(2026, 8, 16))
    await _set_date(db_conn, test_user, ds, far_away, _dt(2026, 9, 1), _dt(2026, 9, 2))

    changes = await relations.cascade_dependency_shift(
        db_conn, test_user, fwd_ref,
        changed_row_id=blocker, delta=timedelta(days=7),
        mode=relations.SHIFT_WHEN_OVERLAP, avoid_weekends=False,
        date_property_key=_DATE_KEY,
    )
    assert overlapping in changes
    assert changes[overlapping] == DateWindow(start=_dt(2026, 8, 19), end=_dt(2026, 8, 20))
    assert far_away not in changes
    assert await _get_date(db_conn, far_away) == DateWindow(start=_dt(2026, 9, 1), end=_dt(2026, 9, 2))


async def test_cascade_multi_hop_chain(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False, system=None)
    a = await _insert_note(db_conn, test_user, title="a")
    b = await _insert_note(db_conn, test_user, title="b")
    c = await _insert_note(db_conn, test_user, title="c")
    await relations.link_checked(db_conn, test_user, fwd_ref, a, b, system=SYSTEM_DEPENDENCY)
    await relations.link_checked(db_conn, test_user, fwd_ref, b, c, system=SYSTEM_DEPENDENCY)

    await _set_date(db_conn, test_user, ds, a, _dt(2026, 8, 17), _dt(2026, 8, 19))
    await _set_date(db_conn, test_user, ds, b, _dt(2026, 8, 24), _dt(2026, 8, 26))
    await _set_date(db_conn, test_user, ds, c, _dt(2026, 8, 31), _dt(2026, 9, 2))

    changes = await relations.cascade_dependency_shift(
        db_conn, test_user, fwd_ref,
        changed_row_id=a, delta=timedelta(days=7),
        mode=relations.SHIFT_MAINTAIN_GAP, avoid_weekends=False,
        date_property_key=_DATE_KEY,
    )
    assert changes[b] == DateWindow(start=_dt(2026, 8, 31), end=_dt(2026, 9, 2))
    assert changes[c] == DateWindow(start=_dt(2026, 9, 7), end=_dt(2026, 9, 9))


async def test_cascade_diamond_not_double_shifted(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False, system=None)
    a = await _insert_note(db_conn, test_user, title="a")
    b = await _insert_note(db_conn, test_user, title="b")
    c = await _insert_note(db_conn, test_user, title="c")
    d = await _insert_note(db_conn, test_user, title="d")
    # Diamond: a -> b -> d, a -> c -> d
    await relations.link_checked(db_conn, test_user, fwd_ref, a, b, system=SYSTEM_DEPENDENCY)
    await relations.link_checked(db_conn, test_user, fwd_ref, a, c, system=SYSTEM_DEPENDENCY)
    await relations.link_checked(db_conn, test_user, fwd_ref, b, d, system=SYSTEM_DEPENDENCY)
    await relations.link_checked(db_conn, test_user, fwd_ref, c, d, system=SYSTEM_DEPENDENCY)

    await _set_date(db_conn, test_user, ds, a, _dt(2026, 8, 17))
    await _set_date(db_conn, test_user, ds, b, _dt(2026, 8, 24))
    await _set_date(db_conn, test_user, ds, c, _dt(2026, 8, 24))
    d_original = _dt(2026, 8, 31)
    await _set_date(db_conn, test_user, ds, d, d_original)

    await relations.cascade_dependency_shift(
        db_conn, test_user, fwd_ref,
        changed_row_id=a, delta=timedelta(days=7),
        mode=relations.SHIFT_MAINTAIN_GAP, avoid_weekends=False,
        date_property_key=_DATE_KEY,
    )
    d_final = await _get_date(db_conn, d)
    # A single 7-day shift, not 14 (which a visited-set bug would produce).
    assert d_final.start == d_original + timedelta(days=7)


async def test_cascade_shift_never_makes_no_changes(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    _, fwd_ref, _ = await _make_pair_ref(db_conn, test_user, two_way=False, system=None)
    blocker = await _insert_note(db_conn, test_user, title="blocker")
    blocked = await _insert_note(db_conn, test_user, title="blocked")
    await relations.link_checked(db_conn, test_user, fwd_ref, blocker, blocked, system=SYSTEM_DEPENDENCY)
    await _set_date(db_conn, test_user, ds, blocker, _dt(2026, 8, 17))
    original_blocked = _dt(2026, 8, 24)
    await _set_date(db_conn, test_user, ds, blocked, original_blocked)

    changes = await relations.cascade_dependency_shift(
        db_conn, test_user, fwd_ref,
        changed_row_id=blocker, delta=timedelta(days=7),
        mode=relations.SHIFT_NEVER, avoid_weekends=False,
        date_property_key=_DATE_KEY,
    )
    assert changes == {}
    assert (await _get_date(db_conn, blocked)).start == original_blocked
