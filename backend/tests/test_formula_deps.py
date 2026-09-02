"""Tests for services/db/formula/deps.py -- Milestone 8b (Task 24): the
dependency graph, cycle rejection with path, and depth-15 measurement.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.3.
Research: docs/research/notion-databases-research.md §H.4.2/§H.4.3.

Pure Python, no database, no fixtures.
"""
from __future__ import annotations

import pytest

from services.db.formula import parse
from services.db.formula.deps import (
    FormulaCycleError,
    PropertyDef,
    build_graph,
    max_reference_depth,
    referenced_properties,
    topological_order,
)

DS = "ds1"


def _formula(key: str, name: str, source: str, *, ds: str = DS) -> PropertyDef:
    return PropertyDef(data_source_id=ds, key=key, name=name, type="formula", formula_source=source)


def _rollup(
    key: str,
    name: str,
    *,
    relation_key: str,
    target_ds: str,
    target_key: str,
    ds: str = DS,
) -> PropertyDef:
    return PropertyDef(
        data_source_id=ds,
        key=key,
        name=name,
        type="rollup",
        rollup_relation_key=relation_key,
        rollup_target_data_source_id=target_ds,
        rollup_target_key=target_key,
    )


def _plain(key: str, name: str, ptype: str = "number", *, ds: str = DS) -> PropertyDef:
    return PropertyDef(data_source_id=ds, key=key, name=name, type=ptype)


# ---------------------------------------------------------------------------
# referenced_properties
# ---------------------------------------------------------------------------


def test_referenced_properties_bare_prop_call():
    tree = parse('prop("A") + prop("B")')
    assert referenced_properties(tree) == {"A", "B"}


def test_referenced_properties_bare_token():
    tree = parse("Start Date + 1", property_names=["Start Date"])
    assert referenced_properties(tree) == {"Start Date"}


def test_referenced_properties_dot_prop_form():
    tree = parse('prop("Relation").first().prop("Created By")')
    assert referenced_properties(tree) == {"Relation", "Created By"}


def test_referenced_properties_does_not_collect_context_vars():
    tree = parse('context("Trigger page")')
    assert referenced_properties(tree) == set()


def test_referenced_properties_nested_deep_in_let():
    tree = parse('let(a, prop("X"), a + 1)')
    assert referenced_properties(tree) == {"X"}


# ---------------------------------------------------------------------------
# build_graph: name -> key resolution, formula and rollup edges
# ---------------------------------------------------------------------------


def test_build_graph_resolves_formula_references_by_name_to_key():
    props = [
        _plain("aaaaaaaa", "A"),
        _formula("bbbbbbbb", "B", 'prop("A") + 1'),
    ]
    g = build_graph(props)
    assert g.nodes == {(DS, "aaaaaaaa"), (DS, "bbbbbbbb")}
    assert g.edges[(DS, "bbbbbbbb")] == frozenset({(DS, "aaaaaaaa")})
    assert g.edges[(DS, "aaaaaaaa")] == frozenset()


def test_build_graph_unresolved_name_produces_no_edge_not_an_error():
    # A formula referencing a property name that isn't in the schema
    # (typo, or a rename that happened after save) resolves to no edge --
    # brief §3's ruling, matching research §1.9's "a formula with errors
    # can still be saved."
    props = [_formula("bbbbbbbb", "B", 'prop("Gone") + 1')]
    g = build_graph(props)  # must not raise
    assert g.edges[(DS, "bbbbbbbb")] == frozenset()


def test_build_graph_accepts_preparsed_tree_to_avoid_reparsing():
    tree = parse('prop("A") + 1', property_names=["A"])
    props = [
        _plain("aaaaaaaa", "A"),
        PropertyDef(
            data_source_id=DS, key="bbbbbbbb", name="B", type="formula", formula_tree=tree
        ),
    ]
    g = build_graph(props)
    assert g.edges[(DS, "bbbbbbbb")] == frozenset({(DS, "aaaaaaaa")})


def test_build_graph_rollup_edges_relation_and_target():
    other_ds = "ds2"
    props = [
        _plain("relnkey1", "Related", "relation"),
        _plain("targkey1", "Target", ds=other_ds),
        _rollup(
            "rollkey1",
            "Rollup",
            relation_key="relnkey1",
            target_ds=other_ds,
            target_key="targkey1",
        ),
    ]
    g = build_graph(props)
    assert g.edges[(DS, "rollkey1")] == frozenset(
        {(DS, "relnkey1"), (other_ds, "targkey1")}
    )


def test_build_graph_is_mixed_formula_and_rollup_edges():
    # research §4.2: formulas may reference rollups and rollups may
    # reference formulas -- one graph, not two separate passes.
    other_ds = "ds2"
    props = [
        _plain("relnkey1", "Related", "relation"),
        _formula("targkey1", "Target", "1 + 1", ds=other_ds),
        _rollup(
            "rollkey1",
            "Rollup",
            relation_key="relnkey1",
            target_ds=other_ds,
            target_key="targkey1",
        ),
        _formula("formkey1", "UsesRollup", 'prop("Rollup") + 1'),
    ]
    g = build_graph(props)
    assert (other_ds, "targkey1") in g.edges[(DS, "rollkey1")]
    assert g.edges[(DS, "formkey1")] == frozenset({(DS, "rollkey1")})


# ---------------------------------------------------------------------------
# topological_order: 3-node chain, diamond, cycles
# ---------------------------------------------------------------------------


def test_topological_order_three_node_chain():
    # C depends on B depends on A.
    props = [
        _plain("aaaaaaaa", "A"),
        _formula("bbbbbbbb", "B", 'prop("A") + 1'),
        _formula("cccccccc", "C", 'prop("B") + 1'),
    ]
    g = build_graph(props)
    order = topological_order(g)
    assert order.index((DS, "aaaaaaaa")) < order.index((DS, "bbbbbbbb"))
    assert order.index((DS, "bbbbbbbb")) < order.index((DS, "cccccccc"))


def test_topological_order_diamond_not_a_cycle():
    # D depends on B and C, both of which depend on A. Not a cycle.
    props = [
        _plain("aaaaaaaa", "A"),
        _formula("bbbbbbbb", "B", 'prop("A") + 1'),
        _formula("cccccccc", "C", 'prop("A") + 2'),
        _formula("dddddddd", "D", 'prop("B") + prop("C")'),
    ]
    g = build_graph(props)
    order = topological_order(g)  # must not raise
    idx = {n: i for i, n in enumerate(order)}
    assert idx[(DS, "aaaaaaaa")] < idx[(DS, "bbbbbbbb")]
    assert idx[(DS, "aaaaaaaa")] < idx[(DS, "cccccccc")]
    assert idx[(DS, "bbbbbbbb")] < idx[(DS, "dddddddd")]
    assert idx[(DS, "cccccccc")] < idx[(DS, "dddddddd")]


def test_topological_order_self_reference_is_cycle_of_length_one():
    props = [_formula("aaaaaaaa", "A", 'prop("A") + 1')]
    g = build_graph(props)
    with pytest.raises(FormulaCycleError) as exc_info:
        topological_order(g)
    assert exc_info.value.path == [(DS, "aaaaaaaa"), (DS, "aaaaaaaa")]


def test_topological_order_two_node_cycle_reports_path():
    props = [
        _formula("aaaaaaaa", "A", 'prop("B") + 1'),
        _formula("bbbbbbbb", "B", 'prop("A") + 1'),
    ]
    g = build_graph(props)
    with pytest.raises(FormulaCycleError) as exc_info:
        topological_order(g)
    path = exc_info.value.path
    assert path[0] == path[-1]
    assert set(path) == {(DS, "aaaaaaaa"), (DS, "bbbbbbbb")}
    assert len(path) == 3


def test_cycle_error_str_names_the_cycle():
    props = [_formula("aaaaaaaa", "A", 'prop("A") + 1')]
    g = build_graph(props)
    with pytest.raises(FormulaCycleError) as exc_info:
        topological_order(g)
    text = str(exc_info.value)
    assert "aaaaaaaa" in text
    assert "->" in text


def test_formula_rollup_cycle():
    # A rollup depends on a target property that is itself a formula
    # referencing back to a formula that depends on the rollup -- a cycle
    # spanning both kinds of node (research §4.2: the graph is genuinely
    # mixed).
    other_ds = "ds2"
    props = [
        _plain("relnkey1", "Related", "relation"),
        _rollup(
            "rollkey1",
            "Rollup",
            relation_key="relnkey1",
            target_ds=other_ds,
            target_key="targkey1",
        ),
        _formula("formkey1", "UsesRollup", 'prop("Rollup") + 1'),
        # The "target" formula, in the OTHER data source, references back
        # to UsesRollup via a relation-property name collision (the
        # dot-prop/bare-token resolution limitation documented in
        # typecheck.py/deps.py: same-name resolution against ITS OWN data
        # source only) -- constructed directly here instead, since the
        # point under test is topological_order's cycle detection, not
        # cross-database name resolution.
        PropertyDef(
            data_source_id=other_ds,
            key="targkey1",
            name="Target",
            type="formula",
            formula_tree=None,
            formula_source='prop("Back") + 1',
        ),
        _plain("backkey1", "Back", ds=other_ds),
    ]
    g = build_graph(props)
    # Manually close the loop: UsesRollup depends on Rollup depends on
    # Target (cross-ds); make Target's dependency ("Back") actually be
    # UsesRollup itself, by rebuilding the graph's edges for this one node
    # (build_graph only resolves same-data-source names, so a genuine
    # cross-database cycle has to be expressed by constructing the Graph
    # object directly for this edge case).
    edges = dict(g.edges)
    edges[(other_ds, "targkey1")] = frozenset({(DS, "formkey1")})
    from services.db.formula.deps import Graph

    cyclic = Graph(nodes=g.nodes, edges=edges)
    with pytest.raises(FormulaCycleError) as exc_info:
        topological_order(cyclic)
    path = exc_info.value.path
    assert (DS, "formkey1") in path
    assert (DS, "rollkey1") in path
    assert (other_ds, "targkey1") in path


# ---------------------------------------------------------------------------
# max_reference_depth
# ---------------------------------------------------------------------------


def test_max_reference_depth_no_dependencies_is_zero():
    props = [_plain("aaaaaaaa", "A")]
    g = build_graph(props)
    assert max_reference_depth(g, (DS, "aaaaaaaa")) == 0


def test_max_reference_depth_direct_reference_is_one():
    props = [
        _plain("aaaaaaaa", "A"),
        _formula("bbbbbbbb", "B", 'prop("A") + 1'),
    ]
    g = build_graph(props)
    assert max_reference_depth(g, (DS, "bbbbbbbb")) == 1


def test_max_reference_depth_15_chain():
    # A chain of 16 properties (P0 <- P1 <- ... <- P15) has depth 15 at the
    # far end -- research §4.3's documented limit, spec §7.3's "formula
    # depth 15". This function measures it; it does not enforce it (that's
    # a materialisation-time decision -- see the function's docstring).
    props = [_plain("p0000000", "P0")]
    for i in range(1, 16):
        key = f"p{i:07d}"
        prev_name = f"P{i - 1}"
        props.append(_formula(key, f"P{i}", f'prop("{prev_name}") + 1'))
    g = build_graph(props)
    assert max_reference_depth(g, (DS, "p0000015")) == 15


def test_max_reference_depth_diamond_takes_longest_path():
    props = [
        _plain("aaaaaaaa", "A"),
        _formula("bbbbbbbb", "B", 'prop("A") + 1'),
        _formula("cccccccc", "C", 'prop("B") + 1'),  # A -> B -> C, depth 2
        _formula("dddddddd", "D", 'prop("A") + prop("C")'),  # via C: depth 3
    ]
    g = build_graph(props)
    assert max_reference_depth(g, (DS, "dddddddd")) == 3


def test_max_reference_depth_does_not_raise_past_15():
    # Explicit contract check (brief §3): depth is a materialisation
    # concern, never a save-time rejection, so this must NOT raise even
    # for a chain far longer than 15.
    props = [_plain("p0000000", "P0")]
    for i in range(1, 20):
        key = f"p{i:07d}"
        prev_name = f"P{i - 1}"
        props.append(_formula(key, f"P{i}", f'prop("{prev_name}") + 1'))
    g = build_graph(props)
    assert max_reference_depth(g, (DS, "p0000019")) == 19
