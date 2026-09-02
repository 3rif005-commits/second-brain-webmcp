"""The dependency graph: which properties a formula or rollup references,
and the topological order / cycle / depth analysis needed to save and
materialise them safely.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.2
("one tree, three visitors"), §7.3 (materialisation and the dependency
graph).
Research: docs/research/notion-databases-research.md §H.4.2 (formulas <->
rollups), §H.4.3 (depth limits and cycles).
Brief: .superpowers/sdd/2026-08-08-notion-databases/task-24-brief.md §3.

`referenced_properties()` walks Task 23's `ast.walk()` -- the SAME tree the
evaluator (later task) and `typecheck.py` walk -- rather than re-deriving
"what does this formula reference" from the source text a second time. Spec
§7.2 names a regex-over-source-text approach as the exact failure this
structure exists to prevent: a second, divergent notion of "references."
`typecheck.check()` calls this module's `referenced_properties()` directly
for its own `CheckResult.referenced` (see typecheck.py) rather than
re-implementing the walk, so the two visitors are structurally unable to
disagree.
"""
from __future__ import annotations

from dataclasses import dataclass

from . import ast as A
from .lexer import FormulaSyntaxError
from .parser import parse

__all__ = [
    "PropertyDef",
    "Graph",
    "FormulaCycleError",
    "referenced_properties",
    "build_graph",
    "topological_order",
    "max_reference_depth",
]

GraphNode = tuple[str, str]  # (data_source_id, property_key)


# ---------------------------------------------------------------------------
# 1. referenced_properties
# ---------------------------------------------------------------------------


def referenced_properties(node: A.Node) -> set[str]:
    """Every property **name** (not key -- name -> key resolution is
    `build_graph`'s job, since it needs a specific data source's schema to
    do it) this formula tree references.

    Three AST shapes carry a property name (brief §3, research §2.6):
    - `ast.PropertyRef` -- the bare-token surface form the parser resolved
      at parse time.
    - `Call(name="prop", args=[Literal(str)])` -- the canonical
      `prop("Name")` form, and also the wire format (research §2.6:
      `formula.expression` serialises to exactly this).
    - `MethodCall(_, "prop", [Literal(str)])` -- `receiver.prop("Name")`,
      including the bare-token dot-desugar for `current.Status` (parser.py's
      `_parse_dot_access`). Collected identically to the `Call` form,
      **regardless of what `receiver` is** -- this AST alone cannot tell
      whether `receiver` is `page`-typed value belonging to THIS data
      source or some other one reached through a relation, and inventing
      cross-database schema tracking to tell them apart has nothing in
      research to check it against. `build_graph` resolves every collected
      name against ONE data source's schema (the property's own), so a
      dot-prop reference that happens not to share that schema simply
      fails to resolve into an edge (safe, if incomplete) rather than
      resolving to the wrong property. See `typecheck.py`'s
      `_check_prop_call` docstring for the identical reasoning applied to
      typing instead of dependency extraction -- the two are deliberately
      kept in lockstep.

    `context("...")` (automation context variables) is deliberately NOT
    collected here -- a context variable is not a stored property and has
    no place in a property dependency graph."""
    names: set[str] = set()
    for n in A.walk(node):
        if isinstance(n, A.PropertyRef):
            names.add(n.name)
            continue
        is_prop_call = (isinstance(n, A.Call) and n.name == "prop") or (
            isinstance(n, A.MethodCall) and n.name == "prop"
        )
        if is_prop_call and len(n.args) == 1:
            arg = n.args[0]
            if isinstance(arg, A.Literal) and isinstance(arg.value, str):
                names.add(arg.value)
    return names


# ---------------------------------------------------------------------------
# 2. The graph
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PropertyDef:
    """Everything `build_graph` needs about one property to place it in the
    dependency graph. Deliberately minimal / not the full `db_properties`
    row shape (no such shared model exists yet elsewhere in this codebase
    to reuse -- flagged in this task's report) -- just data-source id, key,
    name, `type`, and the two kinds of dependency-bearing configuration
    (brief §3: "a formula's referenced properties, and a rollup's
    definition").

    `formula_tree`: brief §3, "accept an optional pre-parsed tree per
    property to avoid re-parsing" -- callers that already parsed this
    formula (e.g. because they just ran `typecheck.check()` on it) can hand
    the tree straight over instead of `build_graph` re-parsing
    `formula_source`. When neither is given for a `type == "formula"`
    property, that property contributes no edges (an unparseable/absent
    formula has no known references -- `build_graph` does not raise on
    this; a formula failing to parse is a save-time rejection that belongs
    to a different layer, not to graph construction).

    `rollup_relation_key` / `rollup_target_data_source_id` /
    `rollup_target_key`: research §4.2's "rollups are configured against a
    relation property + a target property" (and the target may live in a
    different data source, reached through the relation) -- these three
    fields are this module's minimal encoding of that, since rollups have
    no AST to derive it from (brief §3, explicit)."""

    data_source_id: str
    key: str
    name: str
    type: str  # db_properties.type
    formula_source: str | None = None
    formula_tree: A.Node | None = None
    rollup_relation_key: str | None = None
    rollup_target_data_source_id: str | None = None
    rollup_target_key: str | None = None


@dataclass(frozen=True)
class Graph:
    """`edges[n]` is the set of nodes `n` **depends on** (i.e. `n`'s value
    is computed from theirs) -- so `topological_order` naturally yields
    dependencies before dependents, the order a recompute pass wants to
    walk in (spec §7.3: "recompute that row topologically"). A node absent
    from `edges` (or present with an empty set) has no dependencies."""

    nodes: frozenset[GraphNode]
    edges: dict[GraphNode, frozenset[GraphNode]]


def build_graph(properties: list[PropertyDef]) -> Graph:
    """Nodes are every `(data_source_id, key)` in `properties` (brief §3).
    Edges come from two sources (brief §3, research §4.2 confirms both
    directions are real and the graph is genuinely mixed, not two separate
    passes):
    - a formula property's `referenced_properties()`, name-resolved
      against ITS OWN data source's `properties` (name -> key, built from
      this same list);
    - a rollup property's declared relation property (same data source)
      and target property (the related data source, per its config).

    Name resolution, and what happens when it fails (brief §3): a formula
    referencing a name that doesn't resolve within its own data source
    (typo'd, or a property renamed away after the formula was saved)
    produces NO edge for that reference -- not an exception. This mirrors
    research §1.9's documented behaviour ("a formula with errors can still
    be saved; the property will display nothing") and `typecheck.py`'s own
    UNKNOWN-for-unresolved ruling: the graph stays buildable, the
    unresolved reference simply contributes nothing to it. Concretely this
    means **renaming a property breaks any formula that referenced it by
    that name** -- a real, documented Notion behaviour consequence of
    name-based references, not a bug here (flagged in this task's report,
    per the brief's instruction to note it)."""
    nodes = frozenset((p.data_source_id, p.key) for p in properties)
    names_by_ds: dict[str, dict[str, str]] = {}
    for p in properties:
        names_by_ds.setdefault(p.data_source_id, {})[p.name] = p.key

    edges: dict[GraphNode, frozenset[GraphNode]] = {}
    for p in properties:
        this_node = (p.data_source_id, p.key)
        deps: set[GraphNode] = set()
        if p.type == "formula":
            tree = p.formula_tree
            if tree is None and p.formula_source:
                local_names = names_by_ds.get(p.data_source_id, {})
                try:
                    tree = parse(p.formula_source, property_names=local_names.keys())
                except FormulaSyntaxError:
                    # Task 28 fix (found while wiring recompute.validate_save
                    # into the property-save router): this module's own
                    # docstring already promises "an unparseable... formula
                    # has no known references -- build_graph does not raise
                    # on this," but the code only delivered that for an
                    # ABSENT formula_source (the `and p.formula_source`
                    # guard above) -- a PRESENT-but-garbage source (a
                    # formula that saved despite a syntax error, research
                    # §1.9's own documented behaviour, or a formula that
                    # parsed fine when saved and stopped parsing after some
                    # later, unrelated schema change) reached `parse()`
                    # uncaught and crashed every subsequent
                    # `validate_save`/`recompute_full` pass with a raw
                    # `FormulaSyntaxError` instead of just contributing no
                    # edges for that one property. Bringing the code in line
                    # with its own documented contract, not a new policy.
                    tree = None
            if tree is not None:
                local_names = names_by_ds.get(p.data_source_id, {})
                for ref_name in referenced_properties(tree):
                    key = local_names.get(ref_name)
                    if key is not None:
                        deps.add((p.data_source_id, key))
                    # else: unresolved reference -- no edge, see docstring.
        elif p.type == "rollup":
            if p.rollup_relation_key is not None:
                deps.add((p.data_source_id, p.rollup_relation_key))
            if (
                p.rollup_target_data_source_id is not None
                and p.rollup_target_key is not None
            ):
                deps.add((p.rollup_target_data_source_id, p.rollup_target_key))
        edges[this_node] = frozenset(deps)
    return Graph(nodes=nodes, edges=edges)


# ---------------------------------------------------------------------------
# 3. Cycles and topological order
# ---------------------------------------------------------------------------


class FormulaCycleError(Exception):
    """Saving a formula/rollup would close a loop in the dependency graph.
    `.path` is the cycle in traversal order, both ends inclusive (mirrors
    `services/db/relations.py`'s `RelationCycleError` -- same contract, same
    reason: spec §7.3 "reject cycles with the path", and "there is a cycle"
    is not an actionable error message on its own). A self-reference (a
    property that references itself) is a cycle of length one, reported as
    the same node twice: `[node, node]`."""

    def __init__(self, path: list[GraphNode]) -> None:
        self.path = list(path)
        super().__init__(self._describe())

    def _describe(self) -> str:
        return " -> ".join(f"{ds}:{key}" for ds, key in self.path)

    def __str__(self) -> str:
        return self._describe()


def topological_order(graph: Graph) -> list[GraphNode]:
    """Dependencies before dependents. Raises `FormulaCycleError` (with the
    exact cycle path) the first time a depth-first walk revisits a node
    still on its own current path -- a classic white/gray/black DFS, not
    Kahn's algorithm, specifically because Kahn's leaves you with "some
    nodes remain" on a cycle and no path, and spec §7.3 requires the path.

    Iterates nodes and each node's dependencies in sorted order so the
    result (and any raised cycle path) is deterministic across runs --
    useful for tests and for not producing a different error message on
    every retry of the same bad save."""
    order: list[GraphNode] = []
    state: dict[GraphNode, int] = {}  # 0 unset/unvisited, 1 in-progress, 2 done
    path: list[GraphNode] = []

    def visit(n: GraphNode) -> None:
        s = state.get(n, 0)
        if s == 2:
            return
        if s == 1:
            idx = path.index(n)
            raise FormulaCycleError(path[idx:] + [n])
        state[n] = 1
        path.append(n)
        for dep in sorted(graph.edges.get(n, frozenset())):
            visit(dep)
        path.pop()
        state[n] = 2
        order.append(n)

    for node in sorted(graph.nodes):
        visit(node)
    return order


def max_reference_depth(graph: Graph, node: GraphNode) -> int:
    """The longest chain of formula/rollup references starting at `node`
    -- the number of EDGES on the longest outgoing path (a node with no
    dependencies has depth 0; one directly referencing another has depth
    1). This is research §4.3's "15 layers deep" concept (spec §7.3:
    "formula depth 15").

    Deliberately does NOT raise when the result reaches or exceeds 15, or
    any other threshold -- that decision belongs to Task 27's
    materialisation pass, which turns an over-deep formula into the
    `{"type":"unsupported"}` sentinel (research §1.9/§4.5: the value still
    computes, it just isn't cached/exposed). This is a DIFFERENT limit,
    checked at a DIFFERENT time, from `topological_order`'s cycle
    rejection: a cycle is rejected AT SAVE TIME (you cannot save it at
    all); an over-deep-but-acyclic reference chain still saves and simply
    degrades to `unsupported` later. Conflating the two here -- e.g.
    raising past 15 -- would reject formulas Notion's own documented
    behaviour allows to save.

    Memoized DFS; if `node` participates in a cycle this raises
    `FormulaCycleError` too (depth is undefined on a cycle) -- a defensive
    backstop, since `topological_order` is the primary, path-complete cycle
    gate expected to run first (at save time, before this function would
    ever be reached for materialisation)."""
    memo: dict[GraphNode, int] = {}
    visiting: set[GraphNode] = set()

    def depth_of(n: GraphNode) -> int:
        if n in memo:
            return memo[n]
        if n in visiting:
            raise FormulaCycleError([n, n])
        visiting.add(n)
        best = 0
        for dep in graph.edges.get(n, frozenset()):
            best = max(best, 1 + depth_of(dep))
        visiting.discard(n)
        memo[n] = best
        return best

    return depth_of(node)
