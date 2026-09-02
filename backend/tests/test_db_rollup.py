"""Tests for `services/db/rollup.py` (Milestone 8e, Task 27).

Runs against the local pgtest harness (localhost:55432, migrations 001-019
applied) through the transaction-wrapped `db_conn`/`test_user` fixtures
(tests/conftest.py), rolled back on teardown. NEVER touches
`core.config.settings.database_url` (the real Supabase project).
"""
from __future__ import annotations

import pytest

from services.db import relations
from services.db.query.aggregations import _VALID_AGGREGATORS
from services.db.rollup import (
    ROLLUP_FUNCTIONS,
    ROLLUP_RESULT_TYPE,
    RollupTarget,
    compute_rollup,
    computed_raw,
    computed_wrapper,
)


# ===========================================================================
# 1. Pure, DB-free: the function table itself
# ===========================================================================


def test_rollup_functions_count_is_22():
    # Research §17's API enum has 24 values; count_per_group/
    # percent_per_group are excluded (its own UNRESOLVED note -- see
    # rollup.py's module comment). 22 matches the brief's stated count.
    assert len(ROLLUP_FUNCTIONS) == 22


def test_rollup_function_names_reconcile_with_m4_aggregations():
    # 20 of the 22 are IDENTICALLY NAMED entries in aggregations.py's own
    # private aggregator set -- pinned directly so a rename on either side
    # fails loudly instead of silently drifting apart.
    assert ROLLUP_FUNCTIONS - {"show_original", "show_unique"} == _VALID_AGGREGATORS


def test_result_type_covers_every_function():
    assert set(ROLLUP_RESULT_TYPE) == ROLLUP_FUNCTIONS


def test_date_range_result_type_is_number_not_date():
    # A real, worth-flagging divergence: research's UI table groups
    # "Date range" under "Date properties only" alongside earliest/latest,
    # but M4's own date_range implementation returns a day-count float, not
    # a Date -- see rollup.py's _NUMBER_RESULT_FUNCTIONS comment.
    from services.db.formula.types import FType

    assert ROLLUP_RESULT_TYPE["date_range"] is FType.NUMBER
    assert ROLLUP_RESULT_TYPE["earliest_date"] is FType.DATE
    assert ROLLUP_RESULT_TYPE["show_original"] is FType.LIST


def test_computed_wrapper_and_raw_round_trip():
    wrapper = computed_wrapper("number", 42.0)
    assert wrapper == {"type": "number", "number": 42.0}
    assert computed_raw(wrapper, "number") == 42.0
    assert computed_raw(None, "number") is None
    assert computed_raw({"type": "number"}, "number") is None


async def test_unknown_function_raises_value_error():
    with pytest.raises(ValueError, match="unknown rollup function"):
        await compute_rollup(
            None, "u",
            relation=None, owner_row_ids=["r1"],
            target_data_source_id="ds", target=RollupTarget(key="k", type="number"),
            function="not_a_real_function",
        )


async def test_computed_target_without_result_type_raises():
    with pytest.raises(ValueError, match="result_type"):
        await compute_rollup(
            None, "u",
            relation=None, owner_row_ids=["r1"],
            target_data_source_id="ds",
            target=RollupTarget(key="k", type="rollup", is_computed=True),
            function="sum",
        )


async def test_empty_owner_row_ids_returns_empty_dict_without_touching_conn():
    # No `conn`/`relation` needed at all -- the empty-input short circuit
    # must fire before either is touched.
    result = await compute_rollup(
        None, "u",
        relation=None, owner_row_ids=[],
        target_data_source_id="ds", target=RollupTarget(key="k", type="number"),
        function="sum",
    )
    assert result == {}


# ===========================================================================
# 2. Harness-backed: real relation links, real db_row_props
# ===========================================================================


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


async def _insert_row(db_conn, user_id, data_source_id, note_id, *, properties=None, computed=None):
    await db_conn.execute(
        """
        INSERT INTO db_row_props (note_id, data_source_id, user_id, properties, computed)
        VALUES ($1, $2, $3, $4, $5)
        """,
        note_id, data_source_id, user_id, properties or {}, computed or {},
    )


async def _make_relation(db_conn, user_id, owner_ds, target_ds, *, system=None, reverse_name=None):
    forward, _reverse = await relations.create_relation_pair(
        db_conn, user_id,
        data_source_id=owner_ds, name="Rel", target_data_source_id=target_ds,
        two_way=bool(system), reverse_name=reverse_name or "Rel (rev)", system=system,
    )
    ref = relations.relation_ref_from_config(forward["config"])
    assert ref is not None
    return ref


NUM_KEY = "numTarget"  # fake, non-minted key -- fine, this module never validates key shape
DATE_KEY = "dateTarget"
CHK_KEY = "chkTarget"
TXT_KEY = "txtTarget"
MSEL_KEY = "mselTarget"


# --- numeric family ----------------------------------------------------------


async def test_numeric_family_over_stored_number_target(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user, name="Owners")
    target_ds = await _make_data_source(db_conn, test_user, name="Targets")
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)

    owner_with_links = await _insert_note(db_conn, test_user)
    owner_no_links = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner_with_links)
    await _insert_row(db_conn, test_user, owner_ds, owner_no_links)

    t1 = await _insert_note(db_conn, test_user)
    t2 = await _insert_note(db_conn, test_user)
    t3 = await _insert_note(db_conn, test_user)
    for tid, val in ((t1, 10.0), (t2, 20.0), (t3, 30.0)):
        await _insert_row(
            db_conn, test_user, target_ds, tid,
            properties={NUM_KEY: {"type": "number", "number": val}},
        )
    await relations.set_links(db_conn, test_user, ref, owner_with_links, [t1, t2, t3])

    target = RollupTarget(key=NUM_KEY, type="number")
    owners = [owner_with_links, owner_no_links]

    async def _rollup(fn):
        return await compute_rollup(
            db_conn, test_user, relation=ref, owner_row_ids=owners,
            target_data_source_id=target_ds, target=target, function=fn,
        )

    assert await _rollup("sum") == {owner_with_links: 60.0, owner_no_links: 0.0}
    assert await _rollup("average") == {owner_with_links: 20.0, owner_no_links: None}
    assert await _rollup("median") == {owner_with_links: 20.0, owner_no_links: None}
    assert await _rollup("min") == {owner_with_links: 10.0, owner_no_links: None}
    assert await _rollup("max") == {owner_with_links: 30.0, owner_no_links: None}
    assert await _rollup("range") == {owner_with_links: 20.0, owner_no_links: None}


async def test_sum_over_non_number_target_raises_value_error(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user)
    target_ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)
    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)

    target = RollupTarget(key=TXT_KEY, type="rich_text")
    with pytest.raises(ValueError, match="rollup function 'sum'"):
        await compute_rollup(
            db_conn, test_user, relation=ref, owner_row_ids=[owner],
            target_data_source_id=target_ds, target=target, function="sum",
        )


# --- checkbox family ----------------------------------------------------------


async def test_checkbox_family_over_stored_checkbox_target(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user)
    target_ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)
    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)

    t1 = await _insert_note(db_conn, test_user)
    t2 = await _insert_note(db_conn, test_user)
    t3 = await _insert_note(db_conn, test_user)
    for tid, val in ((t1, True), (t2, True), (t3, False)):
        await _insert_row(
            db_conn, test_user, target_ds, tid,
            properties={CHK_KEY: {"type": "checkbox", "checkbox": val}},
        )
    await relations.set_links(db_conn, test_user, ref, owner, [t1, t2, t3])

    target = RollupTarget(key=CHK_KEY, type="checkbox")

    async def _rollup(fn):
        return (await compute_rollup(
            db_conn, test_user, relation=ref, owner_row_ids=[owner],
            target_data_source_id=target_ds, target=target, function=fn,
        ))[owner]

    assert await _rollup("checked") == 2.0
    assert await _rollup("unchecked") == 1.0
    assert await _rollup("percent_checked") == pytest.approx(200 / 3)
    assert await _rollup("percent_unchecked") == pytest.approx(100 / 3)


# --- date family ----------------------------------------------------------


async def test_date_family_over_stored_date_target(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user)
    target_ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)
    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)

    t1 = await _insert_note(db_conn, test_user)
    t2 = await _insert_note(db_conn, test_user)
    await _insert_row(
        db_conn, test_user, target_ds, t1,
        properties={DATE_KEY: {"type": "date", "date": {"start": "2026-01-01", "end": None, "time_zone": None}}},
    )
    await _insert_row(
        db_conn, test_user, target_ds, t2,
        properties={DATE_KEY: {"type": "date", "date": {"start": "2026-01-11", "end": None, "time_zone": None}}},
    )
    await relations.set_links(db_conn, test_user, ref, owner, [t1, t2])

    target = RollupTarget(key=DATE_KEY, type="date")

    async def _rollup(fn):
        return (await compute_rollup(
            db_conn, test_user, relation=ref, owner_row_ids=[owner],
            target_data_source_id=target_ds, target=target, function=fn,
        ))[owner]

    assert await _rollup("earliest_date") == "2026-01-01"
    assert await _rollup("latest_date") == "2026-01-11"
    assert await _rollup("date_range") == pytest.approx(10.0)


# --- universal family + multi_select flatten -------------------------------


async def test_universal_family_over_multi_select_target_flattens_tags(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user)
    target_ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)
    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)

    t1 = await _insert_note(db_conn, test_user)
    t2 = await _insert_note(db_conn, test_user)
    await _insert_row(
        db_conn, test_user, target_ds, t1,
        properties={MSEL_KEY: {"type": "multi_select", "multi_select": ["a", "b"]}},
    )
    await _insert_row(
        db_conn, test_user, target_ds, t2,
        properties={MSEL_KEY: {"type": "multi_select", "multi_select": ["b", "c"]}},
    )
    await relations.set_links(db_conn, test_user, ref, owner, [t1, t2])

    target = RollupTarget(key=MSEL_KEY, type="multi_select")
    counts = await compute_rollup(
        db_conn, test_user, relation=ref, owner_row_ids=[owner],
        target_data_source_id=target_ds, target=target, function="count_values",
    )
    uniques = await compute_rollup(
        db_conn, test_user, relation=ref, owner_row_ids=[owner],
        target_data_source_id=target_ds, target=target, function="unique",
    )
    # 4 total tags across both rows ("a","b","b","c"), 3 distinct.
    assert counts[owner] == 4.0
    assert uniques[owner] == 3.0


# --- count (link count, no target read) -------------------------------------


async def test_count_is_pure_link_count_and_ignores_target_type(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user)
    target_ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)
    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)
    t1 = await _insert_note(db_conn, test_user)
    t2 = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, target_ds, t1)
    await _insert_row(db_conn, test_user, target_ds, t2)
    await relations.set_links(db_conn, test_user, ref, owner, [t1, t2])

    # A "relation" target type would normally be rejected -- `count` is the
    # one function that never even looks at the target, so it must not be.
    target = RollupTarget(key="whatever", type="relation")
    result = await compute_rollup(
        db_conn, test_user, relation=ref, owner_row_ids=[owner],
        target_data_source_id=target_ds, target=target, function="count",
    )
    assert result == {owner: 2.0}


# --- show_original / show_unique --------------------------------------------


async def test_show_original_and_show_unique(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user)
    target_ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)
    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)

    t1 = await _insert_note(db_conn, test_user)
    t2 = await _insert_note(db_conn, test_user)
    t3 = await _insert_note(db_conn, test_user)
    for tid, val in ((t1, "x"), (t2, "y"), (t3, "x")):
        await _insert_row(
            db_conn, test_user, target_ds, tid,
            properties={TXT_KEY: {"type": "rich_text", "rich_text": val}},
        )
    await relations.set_links(db_conn, test_user, ref, owner, [t1, t2, t3])

    target = RollupTarget(key=TXT_KEY, type="rich_text")
    original = await compute_rollup(
        db_conn, test_user, relation=ref, owner_row_ids=[owner],
        target_data_source_id=target_ds, target=target, function="show_original",
    )
    unique = await compute_rollup(
        db_conn, test_user, relation=ref, owner_row_ids=[owner],
        target_data_source_id=target_ds, target=target, function="show_unique",
    )
    assert original[owner] == ["x", "y", "x"]
    assert unique[owner] == ["x", "y"]


# --- relation-typed target rejected (except for count) ----------------------


async def test_relation_typed_target_rejected_for_non_count_functions(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user)
    target_ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)
    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)

    target = RollupTarget(key="whatever", type="relation")
    with pytest.raises(ValueError, match="relation"):
        await compute_rollup(
            db_conn, test_user, relation=ref, owner_row_ids=[owner],
            target_data_source_id=target_ds, target=target, function="not_empty",
        )


# --- rollup over a computed (formula/rollup) target: "rollups over rollups" -


async def test_rollup_over_a_computed_target_reads_the_computed_column(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user)
    target_ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(db_conn, test_user, owner_ds, target_ds)
    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)

    inner_key = "innerRollup"
    t1 = await _insert_note(db_conn, test_user)
    t2 = await _insert_note(db_conn, test_user)
    # Simulates an already-materialised INNER rollup (as recompute.py would
    # have written it, in topological order, before this OUTER rollup ever
    # runs) -- proves this module reads `computed`, never `properties`, for
    # a computed target.
    await _insert_row(
        db_conn, test_user, target_ds, t1,
        properties={inner_key: {"type": "number", "number": 999.0}},  # must be IGNORED
        computed={inner_key: computed_wrapper("number", 5.0)},
    )
    await _insert_row(
        db_conn, test_user, target_ds, t2,
        properties={},
        computed={inner_key: computed_wrapper("number", 7.0)},
    )
    await relations.set_links(db_conn, test_user, ref, owner, [t1, t2])

    target = RollupTarget(key=inner_key, type="rollup", is_computed=True, result_type="number")
    result = await compute_rollup(
        db_conn, test_user, relation=ref, owner_row_ids=[owner],
        target_data_source_id=target_ds, target=target, function="sum",
    )
    assert result[owner] == 12.0  # 5 + 7, not 999 -- confirms `properties` was never read


# --- rollups over sub-items (an ordinary self-relation, proved not asserted)-


async def test_rollup_over_sub_items_works_because_it_is_an_ordinary_self_relation(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    ref = await _make_relation(
        db_conn, test_user, ds, ds, system=relations.SYSTEM_SUB_ITEM, reverse_name="Parent",
    )
    parent = await _insert_note(db_conn, test_user, title="Parent")
    child1 = await _insert_note(db_conn, test_user, title="Child 1")
    child2 = await _insert_note(db_conn, test_user, title="Child 2")
    await _insert_row(db_conn, test_user, ds, parent)
    await _insert_row(
        db_conn, test_user, ds, child1, properties={NUM_KEY: {"type": "number", "number": 3.0}}
    )
    await _insert_row(
        db_conn, test_user, ds, child2, properties={NUM_KEY: {"type": "number", "number": 4.0}}
    )
    await relations.link_checked(db_conn, test_user, ref, parent, child1, system=relations.SYSTEM_SUB_ITEM)
    await relations.link_checked(db_conn, test_user, ref, parent, child2, system=relations.SYSTEM_SUB_ITEM)

    target = RollupTarget(key=NUM_KEY, type="number")
    result = await compute_rollup(
        db_conn, test_user, relation=ref, owner_row_ids=[parent],
        target_data_source_id=ds, target=target, function="sum",
    )
    assert result[parent] == 7.0


# --- rollup-over-rollup within depth 3 (multi-hop materialisation chain) ----


async def test_rollup_over_rollup_two_layers_deep(db_conn, test_user):
    """A -> B -> C, each hop a relation + rollup, computed strictly in the
    order a topological recompute pass would produce (innermost first) --
    proves the chain composes without this module doing any recursion of
    its own (spec §9: "Rollups over rollups are permitted within depth
    3")."""
    ds_a = await _make_data_source(db_conn, test_user, name="A")
    ds_b = await _make_data_source(db_conn, test_user, name="B")
    ds_c = await _make_data_source(db_conn, test_user, name="C")
    ref_bc = await _make_relation(db_conn, test_user, ds_b, ds_c)
    ref_ab = await _make_relation(db_conn, test_user, ds_a, ds_b)

    a = await _insert_note(db_conn, test_user)
    b = await _insert_note(db_conn, test_user)
    c1 = await _insert_note(db_conn, test_user)
    c2 = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds_a, a)
    await _insert_row(db_conn, test_user, ds_b, b)
    await _insert_row(
        db_conn, test_user, ds_c, c1, properties={NUM_KEY: {"type": "number", "number": 1.0}}
    )
    await _insert_row(
        db_conn, test_user, ds_c, c2, properties={NUM_KEY: {"type": "number", "number": 2.0}}
    )
    await relations.set_links(db_conn, test_user, ref_bc, b, [c1, c2])
    await relations.set_links(db_conn, test_user, ref_ab, a, [b])

    # Layer 1: B's rollup over C (sum) -- computed first, as a topological
    # pass would.
    b_rollup_key = "bRollup"
    b_values = await compute_rollup(
        db_conn, test_user, relation=ref_bc, owner_row_ids=[b],
        target_data_source_id=ds_c, target=RollupTarget(key=NUM_KEY, type="number"),
        function="sum",
    )
    assert b_values[b] == 3.0
    await db_conn.execute(
        "UPDATE db_row_props SET computed = $1 WHERE note_id = $2",
        {b_rollup_key: computed_wrapper("number", b_values[b])}, b,
    )

    # Layer 2: A's rollup over B's ALREADY-MATERIALISED rollup (average, to
    # prove it isn't just re-summing).
    a_values = await compute_rollup(
        db_conn, test_user, relation=ref_ab, owner_row_ids=[a],
        target_data_source_id=ds_b,
        target=RollupTarget(key=b_rollup_key, type="rollup", is_computed=True, result_type="number"),
        function="average",
    )
    assert a_values[a] == 3.0
