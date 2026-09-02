"""Tests for `services/db/recompute.py` (Milestone 8e, Task 27).

Runs against the local pgtest harness (localhost:55432, migrations 001-019
applied) through the transaction-wrapped `db_conn`/`test_user` fixtures
(tests/conftest.py), rolled back on teardown. NEVER touches
`core.config.settings.database_url` (the real Supabase project).

Since Task 28 (the HTTP layer that would normally write `db_properties.
config`/`result_type`/`is_volatile` after calling the formula type checker)
does not exist yet, these tests construct `db_properties` rows directly,
simulating exactly what that router is expected to persist.
"""
from __future__ import annotations

import pytest

from services.db import recompute, relations
from services.db.formula.deps import FormulaCycleError


# ===========================================================================
# Helpers (deliberately duplicated per-file, matching this codebase's own
# test-file convention -- see test_db_rollup.py's identical helpers).
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


async def _insert_property(
    db_conn, user_id, data_source_id, key, name, type_,
    *, config=None, result_type=None, is_volatile=False,
):
    await db_conn.execute(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type, config, result_type, is_volatile)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        """,
        data_source_id, user_id, key, name, type_, config or {}, result_type, is_volatile,
    )


def _formula_config(expression: str) -> dict:
    return {"expression": expression}


def _rollup_config(relation_key: str, target_data_source_id: str, target_key: str, function: str) -> dict:
    return {
        "relation_key": relation_key,
        "target_data_source_id": target_data_source_id,
        "target_key": target_key,
        "function": function,
    }


async def _row_computed(db_conn, note_id) -> dict:
    return await db_conn.fetchval("SELECT computed FROM db_row_props WHERE note_id = $1", note_id)


async def _row_properties(db_conn, note_id) -> dict:
    return await db_conn.fetchval("SELECT properties FROM db_row_props WHERE note_id = $1", note_id)


# ===========================================================================
# 1. validate_save: cycle rejected at save time; depth is NOT
# ===========================================================================


async def test_validate_save_returns_topological_order_for_acyclic_graph(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Doubled", "formula",
        config=_formula_config('prop("Price") * 2'), result_type="number",
    )
    order = await recompute.validate_save(db_conn, test_user)
    assert (ds, "fKey") in order
    if (ds, "numKey") in order:
        # A dependency, if present as its own node, must precede its
        # dependent in topological order.
        assert order.index((ds, "numKey")) < order.index((ds, "fKey"))


async def test_validate_save_rejects_a_self_referencing_formula_as_a_cycle(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Self", "formula",
        config=_formula_config('prop("Self") + 1'), result_type="number",
    )
    with pytest.raises(FormulaCycleError):
        await recompute.validate_save(db_conn, test_user)


async def test_validate_save_rejects_a_two_property_cycle_with_the_path(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(
        db_conn, test_user, ds, "aKey", "A", "formula",
        config=_formula_config('prop("B") + 1'), result_type="number",
    )
    await _insert_property(
        db_conn, test_user, ds, "bKey", "B", "formula",
        config=_formula_config('prop("A") + 1'), result_type="number",
    )
    with pytest.raises(FormulaCycleError) as exc_info:
        await recompute.validate_save(db_conn, test_user)
    path = exc_info.value.path
    assert (ds, "aKey") in path and (ds, "bKey") in path


async def test_validate_save_does_not_reject_an_over_deep_but_acyclic_chain(db_conn, test_user):
    """The distinction this task's brief (and Task 24's before it) insists
    on: a cycle is rejected at save time; an over-deep formula still
    saves. A 20-layer linear chain (well past FORMULA_DEPTH_LIMIT=15) has
    NO cycle, so `validate_save` must succeed."""
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "k0", "P0", "number")
    for i in range(1, 21):
        await _insert_property(
            db_conn, test_user, ds, f"k{i}", f"P{i}", "formula",
            config=_formula_config(f'prop("P{i - 1}") + 1'), result_type="number",
        )
    order = await recompute.validate_save(db_conn, test_user)
    assert (ds, "k20") in order


# ===========================================================================
# 2. recompute_full: basic materialisation, computed vs properties
# ===========================================================================


async def test_full_pass_materialises_a_simple_formula_and_leaves_properties_untouched(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Doubled", "formula",
        config=_formula_config('prop("Price") * 2'), result_type="number",
    )
    note = await _insert_note(db_conn, test_user)
    original_properties = {"numKey": {"type": "number", "number": 21.0}}
    await _insert_row(db_conn, test_user, ds, note, properties=original_properties)

    stats = await recompute.recompute_full(db_conn, test_user)
    assert stats.cells_computed >= 1

    computed = await _row_computed(db_conn, note)
    assert computed["fKey"] == {"type": "number", "number": 42.0}
    assert await _row_properties(db_conn, note) == original_properties  # byte-identical


async def test_full_pass_formula_result_empty_omits_the_key(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "IfHasPrice", "formula",
        config=_formula_config('if(Price > 0, "has price", empty())'), result_type="string",
    )
    note = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, note, properties={})  # no price -> empty()

    await recompute.recompute_full(db_conn, test_user)
    computed = await _row_computed(db_conn, note)
    assert "fKey" not in computed  # absent key, not a null wrapper


async def test_full_pass_volatile_formula_is_never_materialised(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Now", "formula",
        config=_formula_config("now()"), result_type="date", is_volatile=True,
    )
    note = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, note)

    await recompute.recompute_full(db_conn, test_user)
    computed = await _row_computed(db_conn, note)
    assert "fKey" not in computed  # absent, not merely stale


# ===========================================================================
# 3. Formula depth 15 -> unsupported, no partial value
# ===========================================================================


async def test_formula_depth_15_becomes_unsupported(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "k0", "P0", "number")
    # 20 layers: P1..P20, depth(P_i) = i. depth >= 15 must be unsupported;
    # depth < 15 must be a real value.
    for i in range(1, 21):
        await _insert_property(
            db_conn, test_user, ds, f"k{i}", f"P{i}", "formula",
            config=_formula_config(f'prop("P{i - 1}") + 1'), result_type="number",
        )
    note = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, note, properties={"k0": {"type": "number", "number": 0.0}})

    await recompute.recompute_full(db_conn, test_user)
    computed = await _row_computed(db_conn, note)

    assert computed["k14"] == {"type": "number", "number": 14.0}  # depth 14 -- fine
    assert computed["k15"] == recompute.UNSUPPORTED  # depth 15 -- the limit
    assert computed["k20"] == recompute.UNSUPPORTED  # depth 20 -- also over


# ===========================================================================
# 4. Relation-traversal depth 3: the glue is correct, even though (flagged
#    in the report) nothing in the committed evaluator can trigger it yet.
# ===========================================================================


async def test_depth_exceeded_context_flag_becomes_unsupported(db_conn, test_user, monkeypatch):
    """Directly exercises `_compute_formula`'s handling of `EvalContext.
    depth_exceeded` by simulating (via a monkeypatched `evaluate`) a
    relation hop chain that exhausts the budget -- a fast, deterministic
    unit of `_compute_formula`'s own EMPTY/UNSUPPORTED bookkeeping,
    independent of how many real `.prop()` dot-hops it would actually take
    to exhaust it (since the M8 combined-review fix wave, a real formula
    genuinely can: see test_formula_eval.py's `TestRelationHopDotProp` for
    that, and `test_recompute_row_dot_prop_reads_the_related_rows_value`
    below for one real relation hop resolving correctly end-to-end)."""
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Whatever", "formula",
        config=_formula_config('"placeholder"'), result_type="string",
    )
    note = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, note)

    def _fake_evaluate(tree, ctx):
        # Exhausts the default depth_budget=3 by chaining with_relation_hop()
        # four times -- the 4th call finds the budget already at 0 and
        # flips the shared depth_exceeded flag.
        cur = ctx
        for _ in range(4):
            nxt = cur.with_relation_hop()
            cur = nxt if nxt is not None else cur
        return "this value must be discarded"

    monkeypatch.setattr(recompute.evaluator, "evaluate", _fake_evaluate)
    await recompute.recompute_full(db_conn, test_user)
    computed = await _row_computed(db_conn, note)
    assert computed["fKey"] == recompute.UNSUPPORTED


# ===========================================================================
# 4b. Relation-hop dot-prop (`current.prop("Name")`) reads the RELATED
#     row's value -- the M8 combined-review fix wave, end-to-end through
#     `_build_related_properties` and `evaluator._eval_prop_dot`.
# ===========================================================================


async def test_full_pass_dot_prop_reads_each_related_rows_own_status(db_conn, test_user):
    """research §3.8's own documented idiom: `prop("Tasks").filter(current.
    prop("Status") != "Done")`. The owner row is given its OWN "Status"
    property, deliberately absent from either related row's schema-sharing
    intent (this is a self-relation -- both data sources are literally the
    SAME data source), so the pre-fix bug (every `current.prop("Status")`
    silently reading the OWNER's Status instead of each element's) and the
    fix disagree on the answer: pre-fix, every element compares the SAME
    owner value against "Done" (all-pass or all-fail, regardless of the
    related rows' real Status); fixed, only the genuinely-not-"Done"
    related rows count. Owner has no "Status" property of its own at all
    (EMPTY != "Done" is true, general EMPTY-propagation rule's five
    exceptions -- `unequal` is one -- so the pre-fix bug would count ALL
    THREE related rows as open, not the correct two)."""
    ds = await _make_data_source(db_conn, test_user, name="Tasks")
    forward, _ = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=ds, name="Subtasks",
        target_data_source_id=ds, two_way=False,  # self-relation: the documented common case
    )
    ref = relations.relation_ref_from_config(forward["config"])
    await _insert_property(db_conn, test_user, ds, "statusKey", "Status", "select")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "OpenCount", "formula",
        config=_formula_config(
            'prop("Subtasks").filter(current.prop("Status") != "Done").count()'
        ),
        result_type="number",
    )

    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, owner)  # deliberately no "Status" of its own

    done = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, done, properties={"statusKey": {"type": "select", "select": "Done"}})
    todo1 = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, todo1, properties={"statusKey": {"type": "select", "select": "Todo"}})
    todo2 = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, todo2, properties={"statusKey": {"type": "select", "select": "Todo"}})
    await relations.set_links(db_conn, test_user, ref, owner, [done, todo1, todo2])

    await recompute.recompute_full(db_conn, test_user)
    computed = await _row_computed(db_conn, owner)
    assert computed["fKey"] == {"type": "number", "number": 2.0}  # todo1 + todo2, NOT all 3


async def test_recompute_row_dot_prop_reads_the_related_rows_value(db_conn, test_user):
    """The identical scenario, through the INCREMENTAL path (`recompute_
    row`) instead of a full pass -- `_build_related_properties` is called
    fresh per row there (recompute.py's own docstring on why it is not
    cached across the incremental cascade), a separate code path from
    `recompute_full`'s `related_ctx_by_ds` cache worth covering on its
    own."""
    ds = await _make_data_source(db_conn, test_user, name="Tasks")
    forward, _ = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=ds, name="Subtasks",
        target_data_source_id=ds, two_way=False,
    )
    ref = relations.relation_ref_from_config(forward["config"])
    await _insert_property(db_conn, test_user, ds, "statusKey", "Status", "select")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "OpenCount", "formula",
        config=_formula_config(
            'prop("Subtasks").filter(current.prop("Status") != "Done").count()'
        ),
        result_type="number",
    )

    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, owner)
    done = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, done, properties={"statusKey": {"type": "select", "select": "Done"}})
    todo = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, todo, properties={"statusKey": {"type": "select", "select": "Todo"}})
    await relations.set_links(db_conn, test_user, ref, owner, [done, todo])

    written = await recompute.recompute_row(db_conn, test_user, ds, owner)
    assert written["fKey"] == {"type": "number", "number": 1.0}  # only `todo`


# ===========================================================================
# 5. Rollup fan-out cap (10,000) -> unsupported for that cell
# ===========================================================================


async def test_rollup_fanout_over_cap_becomes_unsupported(db_conn, test_user, monkeypatch):
    monkeypatch.setattr(recompute, "ROLLUP_FANOUT_LIMIT", 2)
    owner_ds = await _make_data_source(db_conn, test_user, name="Owners")
    target_ds = await _make_data_source(db_conn, test_user, name="Targets")
    forward, _ = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=owner_ds, name="Rel",
        target_data_source_id=target_ds, two_way=False,
    )
    ref = relations.relation_ref_from_config(forward["config"])
    await _insert_property(db_conn, test_user, target_ds, "numKey", "Value", "number")
    await _insert_property(
        db_conn, test_user, owner_ds, "rKey", "Sum", "rollup",
        config=_rollup_config(forward["key"], target_ds, "numKey", "sum"), result_type="number",
    )

    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)
    targets = []
    for i in range(3):  # over the monkeypatched cap of 2
        t = await _insert_note(db_conn, test_user)
        await _insert_row(
            db_conn, test_user, target_ds, t, properties={"numKey": {"type": "number", "number": 1.0}}
        )
        targets.append(t)
    await relations.set_links(db_conn, test_user, ref, owner, targets)

    await recompute.recompute_full(db_conn, test_user)
    computed = await _row_computed(db_conn, owner)
    assert computed["rKey"] == recompute.UNSUPPORTED


async def test_rollup_materialises_correctly_under_the_fanout_cap(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user, name="Owners")
    target_ds = await _make_data_source(db_conn, test_user, name="Targets")
    forward, _ = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=owner_ds, name="Rel",
        target_data_source_id=target_ds, two_way=False,
    )
    ref = relations.relation_ref_from_config(forward["config"])
    await _insert_property(db_conn, test_user, target_ds, "numKey", "Value", "number")
    await _insert_property(
        db_conn, test_user, owner_ds, "rKey", "Sum", "rollup",
        config=_rollup_config(forward["key"], target_ds, "numKey", "sum"), result_type="number",
    )

    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)
    t1 = await _insert_note(db_conn, test_user)
    t2 = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, target_ds, t1, properties={"numKey": {"type": "number", "number": 3.0}})
    await _insert_row(db_conn, test_user, target_ds, t2, properties={"numKey": {"type": "number", "number": 4.0}})
    await relations.set_links(db_conn, test_user, ref, owner, [t1, t2])

    await recompute.recompute_full(db_conn, test_user)
    computed = await _row_computed(db_conn, owner)
    assert computed["rKey"] == {"type": "number", "number": 7.0}


# ===========================================================================
# 6. Liveness assertion: full-pass only, independent of the loop's own state
# ===========================================================================


async def test_liveness_assertion_fires_when_a_stalled_traversal_computes_zero_cells(
    db_conn, test_user, monkeypatch
):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Doubled", "formula",
        config=_formula_config('prop("Price") * 2'), result_type="number",
    )
    note = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, note, properties={"numKey": {"type": "number", "number": 1.0}})

    # Simulates the exact bug class the assertion exists to catch: the
    # per-node materialisation step silently does nothing, even though
    # there is clearly a non-volatile formula property with a row to
    # compute it over.
    async def _stalled(*args, **kwargs):
        return None

    monkeypatch.setattr(recompute, "_materialise_node", _stalled)
    with pytest.raises(recompute.RecomputeLivenessError):
        await recompute.recompute_full(db_conn, test_user)


async def test_liveness_assertion_does_not_fire_on_a_genuinely_empty_workspace(db_conn, test_user):
    # No formula/rollup properties at all -- zero cells computed is
    # correct, not a stall.
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    note = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, note)
    stats = await recompute.recompute_full(db_conn, test_user)
    assert stats.cells_computed == 0  # nothing raised


async def test_liveness_assertion_does_not_fire_on_incremental_recompute_row(db_conn, test_user):
    # A data source with formula/rollup properties whose data source has
    # no rows referencing them at all from this ROW's perspective still
    # must not raise -- recompute_row has no liveness assertion at all.
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    note = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, note)
    result = await recompute.recompute_row(db_conn, test_user, ds, note)
    assert result == {}  # no formula/rollup properties -- legitimately nothing


# ===========================================================================
# 7. recompute_row: incremental + propagation to a dependent rollup
# ===========================================================================


async def test_recompute_row_materialises_only_that_row(db_conn, test_user):
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Doubled", "formula",
        config=_formula_config('prop("Price") * 2'), result_type="number",
    )
    note1 = await _insert_note(db_conn, test_user)
    note2 = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, ds, note1, properties={"numKey": {"type": "number", "number": 5.0}})
    await _insert_row(db_conn, test_user, ds, note2, properties={"numKey": {"type": "number", "number": 9.0}})

    written = await recompute.recompute_row(db_conn, test_user, ds, note1)
    assert written["fKey"] == {"type": "number", "number": 10.0}

    computed1 = await _row_computed(db_conn, note1)
    computed2 = await _row_computed(db_conn, note2)
    assert computed1["fKey"] == {"type": "number", "number": 10.0}
    assert computed2 == {}  # untouched


async def test_recompute_row_propagates_to_a_dependent_rollup(db_conn, test_user):
    owner_ds = await _make_data_source(db_conn, test_user, name="Owners")
    target_ds = await _make_data_source(db_conn, test_user, name="Targets")
    forward, _ = await relations.create_relation_pair(
        db_conn, test_user, data_source_id=owner_ds, name="Rel",
        target_data_source_id=target_ds, two_way=False,
    )
    ref = relations.relation_ref_from_config(forward["config"])
    await _insert_property(db_conn, test_user, target_ds, "numKey", "Value", "number")
    await _insert_property(
        db_conn, test_user, owner_ds, "rKey", "Sum", "rollup",
        config=_rollup_config(forward["key"], target_ds, "numKey", "sum"), result_type="number",
    )

    owner = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, owner_ds, owner)
    target = await _insert_note(db_conn, test_user)
    await _insert_row(db_conn, test_user, target_ds, target, properties={"numKey": {"type": "number", "number": 5.0}})
    await relations.set_links(db_conn, test_user, ref, owner, [target])

    # Materialise the owner's rollup once up front (as an initial full
    # pass would have).
    await recompute.recompute_full(db_conn, test_user)
    assert (await _row_computed(db_conn, owner))["rKey"] == {"type": "number", "number": 5.0}

    # Now edit the TARGET row's stored value directly (simulating a normal
    # cell edit) and recompute just that row -- the owner's rollup must be
    # propagated to and refreshed too, via db_relation_links.
    await db_conn.execute(
        "UPDATE db_row_props SET properties = $1 WHERE note_id = $2",
        {"numKey": {"type": "number", "number": 100.0}}, target,
    )
    await recompute.recompute_row(db_conn, test_user, target_ds, target)

    assert (await _row_computed(db_conn, owner))["rKey"] == {"type": "number", "number": 100.0}


# ===========================================================================
# 8. Batched writes across a page boundary
# ===========================================================================


async def test_writes_are_correct_across_a_batch_boundary(db_conn, test_user, monkeypatch):
    monkeypatch.setattr(recompute, "ROW_BATCH_SIZE", 2)
    ds = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds, "numKey", "Price", "number")
    await _insert_property(
        db_conn, test_user, ds, "fKey", "Doubled", "formula",
        config=_formula_config('prop("Price") * 2'), result_type="number",
    )
    notes = []
    for i in range(5):  # 5 rows over a batch size of 2 -> 3 UPDATE statements
        note = await _insert_note(db_conn, test_user)
        await _insert_row(db_conn, test_user, ds, note, properties={"numKey": {"type": "number", "number": float(i)}})
        notes.append(note)

    await recompute.recompute_full(db_conn, test_user)
    for i, note in enumerate(notes):
        computed = await _row_computed(db_conn, note)
        assert computed["fKey"] == {"type": "number", "number": float(i) * 2}
