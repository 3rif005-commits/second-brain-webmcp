"""The formula-language AST: one frozen-dataclass node type per grammar
production, plus `walk()`, the shared depth-first traversal primitive.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.2 — "one tree,
three visitors". The evaluator (later task), the type checker (Task 24) and the
dependency extractor (Task 24's `deps.py`) must all derive from this one tree so they
cannot disagree about what a formula references. `walk()` is what makes that cheap:
every future visitor can be `for node in walk(tree): ...` instead of writing its own
traversal and risking drift from the others.

This module holds no parsing or evaluation logic — see `lexer.py` / `parser.py` for
that. Nodes are frozen (immutable) so a tree, once built, can be safely shared and
cached across the three visitors without defensive copying.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterator, Union


@dataclass(frozen=True)
class Node:
    """Common base. Every node carries `pos` (0-based character offset into the
    source) so any visitor's errors can point at the offending character."""

    pos: int


@dataclass(frozen=True)
class Literal(Node):
    """A string, number, or boolean constant. There is no null/None literal in the
    formula language (research §1.4) — `empty()` is a call, not a literal, and stays
    a `Call` node; it is not modelled here."""

    value: Union[str, float, bool]


@dataclass(frozen=True)
class ListLiteral(Node):
    """`[a, b, c]` — heterogeneous, nestable (research §1.5/§2.11)."""

    items: list["Node"]


@dataclass(frozen=True)
class PropertyRef(Node):
    """A reference to a property of the row the formula is attached to, resolved at
    parse time from either `prop("Name")`'s... no — see parser.py's module
    docstring. `prop("Name")` itself stays a `Call` node (it is syntactically an
    ordinary call); `PropertyRef` exists only for the bare-token surface form
    (research §2.6 form 2), resolved against the caller-supplied `property_names`
    set. See parser.py for the full reasoning — this is the one place the parser
    must be schema-aware to parse at all."""

    name: str


@dataclass(frozen=True)
class Variable(Node):
    """A bare identifier that is not a resolved property reference: a `let`/`lets`
    binding use, or the implicit `current`/`index` list-function variables (research
    §2.12 — parsed as ordinary variables, bound by the evaluator, not the parser)."""

    name: str


@dataclass(frozen=True)
class Unary(Node):
    """`op` is `'not'` or `'-'`. `!` is lexed as an alias for `not` (research §2.1)."""

    op: str
    operand: "Node"


@dataclass(frozen=True)
class Binary(Node):
    """`op` is one of the operator tokens in `parser.PRECEDENCE`, plus `'and'`/`'or'`
    (the word forms are normalised to the same op string as `&&`/`||` — see
    parser.py)."""

    op: str
    left: "Node"
    right: "Node"


@dataclass(frozen=True)
class Conditional(Node):
    """`if(cond, then, otherwise)` and the ternary `cond ? then : otherwise` are the
    same construct (official docs: the ternary "is equivalent to `if(X, Y, Z)`") and
    are normalised to this one node in the parser so downstream visitors see one
    shape. `ifs(...)` is a different, variable-arity construct and is *not*
    normalised here — it stays a `Call` node (see parser.py)."""

    cond: "Node"
    then: "Node"
    otherwise: "Node"


@dataclass(frozen=True)
class Call(Node):
    """A plain function call, `name(args...)`. Covers all ~97 callable names
    (research §3), including `prop(...)`, `context(...)`, `ifs(...)`, and `empty()`
    — none of those get special AST nodes; only `if`/ternary (-> `Conditional`) and
    `let`/`lets` (-> `Let`) do, because those are the only two forms the spec
    requires a shared shape for."""

    name: str
    args: list["Node"]


@dataclass(frozen=True)
class MethodCall(Node):
    """`receiver.name(args...)`, e.g. `prop("Title").length()`. Deliberately kept
    distinct from `Call` even though research §2.5 documents `receiver.f(a, b)` as a
    mechanical, reversible rewrite of `f(receiver, a, b)` — see parser.py for why
    the rewrite is intentionally *not* applied here (error messages and the
    dependency extractor want to know which surface form the user wrote; the
    rewrite is trivial to apply later in the evaluator and impossible to undo once
    applied at parse time)."""

    receiver: "Node"
    name: str
    args: list["Node"]


@dataclass(frozen=True)
class Lambda(Node):
    """Notion formulas have no lambda syntax (research §2.12: higher-order list
    functions take a bare expression, evaluated once per element with the implicit
    `current`/`index` variables — parsed as ordinary `Variable` nodes, per this
    task's brief §3). This node type is declared for AST completeness/forward
    compatibility (it is in the brief's node list verbatim) but `parser.py` never
    constructs one — there is no syntax that produces it. Flagged in this task's
    report."""

    params: list[str]
    body: "Node"


@dataclass(frozen=True)
class Let(Node):
    """`let`/`lets` unified (research §2.4: `let` gained multi-binding in April
    2025 and is now functionally identical to `lets`, which the community
    reference calls an alias). `bindings` is `[(name, value), ...]` in source
    order; per this task's brief §0, bindings are sequential (each sees the ones
    before it) and an inner `Let` may shadow an outer binding's name — both are
    parser-neutral facts for the evaluator, recorded here only because the research
    marked them `UNRESOLVED` and the brief's ruling needs a citation trail."""

    bindings: list[tuple[str, "Node"]]
    body: "Node"


AnyNode = Union[
    Literal,
    ListLiteral,
    PropertyRef,
    Variable,
    Unary,
    Binary,
    Conditional,
    Call,
    MethodCall,
    Lambda,
    Let,
]


def _children(node: Node) -> Iterator[Node]:
    if isinstance(node, (Literal, PropertyRef, Variable)):
        return iter(())
    if isinstance(node, ListLiteral):
        return iter(node.items)
    if isinstance(node, Unary):
        return iter((node.operand,))
    if isinstance(node, Binary):
        return iter((node.left, node.right))
    if isinstance(node, Conditional):
        return iter((node.cond, node.then, node.otherwise))
    if isinstance(node, Call):
        return iter(node.args)
    if isinstance(node, MethodCall):
        return iter((node.receiver, *node.args))
    if isinstance(node, Lambda):
        return iter((node.body,))
    if isinstance(node, Let):
        children: list[Node] = [value for _name, value in node.bindings]
        children.append(node.body)
        return iter(children)
    raise TypeError(f"walk(): unhandled node type {type(node).__name__}")


def walk(node: Node) -> Iterator[Node]:
    """Depth-first, pre-order traversal yielding `node` itself and then every
    descendant. The shared primitive Task 24's `deps.py` (dependency extractor) and
    the type checker build on — see this module's docstring."""
    yield node
    for child in _children(node):
        yield from walk(child)
