"""The formula language's type checker: one visitor over Task 23's AST that
assigns every node an `FType`, collects every type error (not just the
first), and reports whether the tree is volatile.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.2
("one tree, three visitors"), §7.4 (volatility).
Research: docs/research/notion-databases-research.md §H.1 (type system),
§H.1.8 (coercion), §H.1.9 (errors), §H.2.3/2.4/2.5/2.12 (conditionals,
let/lets, dot notation, implicit list-function variables), §H.3.1-3.8
(function signatures -- SHAPES only; behaviour is Task 25/26's job).
Brief: .superpowers/sdd/2026-08-08-notion-databases/task-24-brief.md §2.

Out of scope, deliberately: evaluating a formula (Task 25/26) and deciding
runtime error semantics for things like `divide(1, 0)` (research §1.9's own
`UNRESOLVED:` list -- explicitly *not* this module's problem; `divide(1, 0)`
type-checks fine here because it type-checks fine in Notion too).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal as PyLiteral

from . import ast as A
from .deps import referenced_properties
from .types import FType, PROPERTY_TYPE_TO_FTYPE, unify

__all__ = [
    "FormulaTypeError",
    "CheckResult",
    "check",
    "FUNCTION_SIGNATURES",
]


# ---------------------------------------------------------------------------
# 1. Errors and the result shape
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FormulaTypeError:
    """One type error. Named `FormulaTypeError`, not `TypeError` (brief §2 --
    that name is a Python builtin and shadowing it invites exactly the kind
    of confusing traceback this module exists to prevent for *users*)."""

    message: str
    pos: int


@dataclass(frozen=True)
class CheckResult:
    """`check()`'s full output. `errors` is **every** error found, not the
    first -- brief §2: "a formula editor showing one error at a time is
    miserable, and research §1.9 says Notion's editor shows an error
    *list*." `referenced` is computed by literally calling `deps.
    referenced_properties()` on the same tree (see `check()`), not by a
    second, parallel walk -- spec §7.2's "one tree, three visitors ... so
    they cannot disagree about what a formula references" is enforced
    structurally here, not by convention."""

    type: FType
    errors: list[FormulaTypeError]
    referenced: set[str]
    is_volatile: bool


# ---------------------------------------------------------------------------
# 2. Function signature table (research §H.3.1-3.8 -- signatures only)
# ---------------------------------------------------------------------------
#
# A parameter slot of `None` means "Any" (research's own notation: "`Any` =
# any of the seven value types"). This is a signature-table-only sentinel,
# never a node's actual inferred type -- an expression's real type is always
# one of the nine `FType` members. `Any` accepts `EMPTY`/`UNKNOWN` too (they
# are the universal acceptors by design, see types.py), which matches how
# `if`/`ifs`/`equal` are documented to behave with `empty()`.
#
# `Signature.variadic`, when set, is a *tuple* of the types every argument
# beyond `params`/`optional` may independently be (a small union, e.g.
# `sum(...Number | List<Number>)`), not a single type -- the brief is
# explicit that a genuinely polymorphic function like `sum` needs "a small
# set of accepted overloads rather than falling back to `Any`", and the
# variadic union is the same idea applied to a variadic position instead of
# a fixed one.
#
# Functions whose *last* argument is a bare `current`/`index`-scoped
# expression rather than an ordinary typed value (research §2.12: `map`,
# `filter`, `find`, `findIndex`, `some`, `every`, `count`, `sort`) are
# marked `current_expr` instead of describing that argument in `params` --
# see `_check_higher_order_call` for why an ordinary type slot cannot
# describe it (the expression's own type is never checked -- `current` is
# `UNKNOWN`, honestly, per types.py's LIST-is-unparameterised comment).

_S = FType.STRING
_N = FType.NUMBER
_B = FType.BOOLEAN
_D = FType.DATE
_L = FType.LIST
_P = FType.PERSON
_PG = FType.PAGE
_ANY = None  # sentinel: matches every type, see module comment above


@dataclass(frozen=True)
class Signature:
    """One accepted call shape. `params` are fixed positional parameters;
    `optional` are trailing optional ones (every documented optional-arg
    function -- `round`, `substring`, `slice`, `formatDate`, `formatNumber`,
    `splice`, `unstyle` -- has its optionals as a trailing run, so this is
    sufficient and matches research's own `T?` notation exactly); `variadic`
    (a type union, or `None` for "not variadic") is what every argument
    beyond that accepts."""

    params: tuple[FType | None, ...] = ()
    optional: tuple[FType | None, ...] = ()
    variadic: tuple[FType | None, ...] | None = None
    returns: FType = FType.UNKNOWN


@dataclass(frozen=True)
class FunctionSpec:
    """One builtin's full signature. Most functions have exactly one
    `Signature`; genuinely polymorphic ones (`length`, `empty`, `sum`/`min`/
    `max`/`median`/`mean`, `id`, `sort`, `count`) list a small, closed set
    instead of degrading to `Any` -- the brief's explicit instruction: "an
    `Any` here silently deletes the type checking this task exists to
    provide." `current_expr` is `"required"` (exactly one list arg plus the
    expr: `map`/`filter`/`find`/`findIndex`/`some`/`every`) or `"optional"`
    (`sort`/`count`, which also work with just the list)."""

    overloads: tuple[Signature, ...] = field(default_factory=tuple)
    current_expr: PyLiteral["required", "optional"] | None = None


def _fn(*overloads: Signature) -> FunctionSpec:
    return FunctionSpec(overloads=overloads)


def _higher_order(mode: PyLiteral["required", "optional"], returns: FType) -> FunctionSpec:
    # `params=(_L,)` documents the one real typed parameter (the list) for
    # readability/introspection; the expr argument is deliberately not
    # described here (see module comment) and `_check_higher_order_call`
    # never consults `params`/`optional`/`variadic` for these -- arity and
    # the list-typedness of arg 0 are checked by dedicated code instead.
    return FunctionSpec(overloads=(Signature(params=(_L,), returns=returns),), current_expr=mode)


# Every callable name gets exactly one entry. `prop`, `context`, `let`,
# `lets` are NOT here -- `prop`/`context` are reference forms resolved
# against the caller's schema/context-variable table (not a fixed
# signature), and `let`/`lets` never reach `Call` at all (Task 23 always
# normalises them to `ast.Let`; see `_check_method_call` for the one case
# where a bare `Let`-less `lets(...)` dot-form *does* still reach here).
# `if`/`ifs` DO get entries, for the function-count test and for informative
# introspection, even though their actual branch-unification behaviour is
# special-cased in code (`_check_if_call`/`_check_ifs_call`) rather than
# driven by this table -- neither has a single fixed `returns` type (their
# result is whichever type their branches unify to).
FUNCTION_SIGNATURES: dict[str, FunctionSpec] = {
    # -- §3.1 Conditional / logic (8) -----------------------------------
    "if": _fn(Signature(params=(_B, _ANY, _ANY), returns=FType.UNKNOWN)),
    "ifs": _fn(Signature(variadic=(_ANY,), returns=FType.UNKNOWN)),
    "and": _fn(Signature(params=(_B, _B), returns=_B)),
    "or": _fn(Signature(params=(_B, _B), returns=_B)),
    "not": _fn(Signature(params=(_B,), returns=_B)),
    "equal": _fn(Signature(params=(_ANY, _ANY), returns=_B)),
    "unequal": _fn(Signature(params=(_ANY, _ANY), returns=_B)),
    "empty": _fn(
        Signature(params=(), returns=FType.EMPTY),
        Signature(params=(_ANY,), returns=_B),
    ),
    # -- §3.2 Numeric / math (25) ----------------------------------------
    "add": _fn(Signature(params=(_N, _N), returns=_N)),
    "subtract": _fn(Signature(params=(_N, _N), returns=_N)),
    "multiply": _fn(Signature(params=(_N, _N), returns=_N)),
    "divide": _fn(Signature(params=(_N, _N), returns=_N)),
    "mod": _fn(Signature(params=(_N, _N), returns=_N)),
    "pow": _fn(Signature(params=(_N, _N), returns=_N)),
    "abs": _fn(Signature(params=(_N,), returns=_N)),
    "round": _fn(Signature(params=(_N,), optional=(_N,), returns=_N)),
    "ceil": _fn(Signature(params=(_N,), returns=_N)),
    "floor": _fn(Signature(params=(_N,), returns=_N)),
    "sqrt": _fn(Signature(params=(_N,), returns=_N)),
    "cbrt": _fn(Signature(params=(_N,), returns=_N)),
    "exp": _fn(Signature(params=(_N,), returns=_N)),
    "ln": _fn(Signature(params=(_N,), returns=_N)),
    "log10": _fn(Signature(params=(_N,), returns=_N)),
    "log2": _fn(Signature(params=(_N,), returns=_N)),
    "sign": _fn(Signature(params=(_N,), returns=_N)),
    "min": _fn(Signature(variadic=(_N, _L), returns=_N)),
    "max": _fn(Signature(variadic=(_N, _L), returns=_N)),
    "sum": _fn(Signature(variadic=(_N, _L), returns=_N)),
    "median": _fn(Signature(variadic=(_N, _L), returns=_N)),
    "mean": _fn(Signature(variadic=(_N, _L), returns=_N)),
    "pi": _fn(Signature(params=(), returns=_N)),
    "e": _fn(Signature(params=(), returns=_N)),
    "toNumber": _fn(Signature(params=(_ANY,), returns=_N)),
    # -- §3.3 String (16, incl. padStart/padEnd per research's own count) -
    "length": _fn(
        Signature(params=(_S,), returns=_N),
        Signature(params=(_L,), returns=_N),
    ),
    "substring": _fn(Signature(params=(_S, _N), optional=(_N,), returns=_S)),
    "contains": _fn(Signature(params=(_S, _S), returns=_B)),
    "lower": _fn(Signature(params=(_S,), returns=_S)),
    "upper": _fn(Signature(params=(_S,), returns=_S)),
    "repeat": _fn(Signature(params=(_S, _N), returns=_S)),
    "trim": _fn(Signature(params=(_S,), returns=_S)),
    "padStart": _fn(Signature(params=(_S, _N, _S), returns=_S)),
    "padEnd": _fn(Signature(params=(_S, _N, _S), returns=_S)),
    "split": _fn(Signature(params=(_S, _S), returns=_L)),
    "join": _fn(Signature(params=(_L, _S), returns=_S)),
    "format": _fn(Signature(params=(_ANY,), returns=_S)),
    "formatNumber": _fn(Signature(params=(_N,), optional=(_S, _N), returns=_S)),
    "link": _fn(Signature(params=(_S, _S), returns=_S)),
    "style": _fn(Signature(params=(_S,), variadic=(_S,), returns=_S)),
    "unstyle": _fn(Signature(params=(_S,), variadic=(_S,), returns=_S)),
    # -- §3.4 Regex (4) ----------------------------------------------------
    "test": _fn(Signature(params=(_S, _S), returns=_B)),
    "match": _fn(Signature(params=(_S, _S), returns=_L)),
    "replace": _fn(Signature(params=(_S, _S, _S), returns=_S)),
    "replaceAll": _fn(Signature(params=(_S, _S, _S), returns=_S)),
    # -- §3.6 Date & time (19) ----------------------------------------------
    "now": _fn(Signature(params=(), returns=_D)),
    "today": _fn(Signature(params=(), returns=_D)),
    "minute": _fn(Signature(params=(_D,), returns=_N)),
    "hour": _fn(Signature(params=(_D,), returns=_N)),
    "day": _fn(Signature(params=(_D,), returns=_N)),
    "date": _fn(Signature(params=(_D,), returns=_N)),
    "week": _fn(Signature(params=(_D,), returns=_N)),
    "month": _fn(Signature(params=(_D,), returns=_N)),
    "year": _fn(Signature(params=(_D,), returns=_N)),
    "dateAdd": _fn(Signature(params=(_D, _N, _S), returns=_D)),
    "dateSubtract": _fn(Signature(params=(_D, _N, _S), returns=_D)),
    "dateBetween": _fn(Signature(params=(_D, _D, _S), returns=_N)),
    "dateRange": _fn(Signature(params=(_D, _D), returns=_D)),
    "dateStart": _fn(Signature(params=(_D,), returns=_D)),
    "dateEnd": _fn(Signature(params=(_D,), returns=_D)),
    "timestamp": _fn(Signature(params=(_D,), returns=_N)),
    "fromTimestamp": _fn(Signature(params=(_N,), returns=_D)),
    "formatDate": _fn(Signature(params=(_D, _S), optional=(_S,), returns=_S)),
    "parseDate": _fn(Signature(params=(_S,), returns=_D)),
    # -- §3.7 List (18, incl. count/splice per research's own count) -------
    "at": _fn(Signature(params=(_L, _N), returns=FType.UNKNOWN)),  # UNKNOWN: unparameterised list, see types.py
    "first": _fn(Signature(params=(_L,), returns=FType.UNKNOWN)),
    "last": _fn(Signature(params=(_L,), returns=FType.UNKNOWN)),
    "slice": _fn(Signature(params=(_L, _N), optional=(_N,), returns=_L)),
    "concat": _fn(Signature(variadic=(_L,), returns=_L)),
    "sort": _higher_order("optional", _L),
    "reverse": _fn(Signature(params=(_L,), returns=_L)),
    "unique": _fn(Signature(params=(_L,), returns=_L)),
    "includes": _fn(Signature(params=(_L, _ANY), returns=_B)),
    "find": _higher_order("required", FType.UNKNOWN),
    "findIndex": _higher_order("required", _N),
    "filter": _higher_order("required", _L),
    "some": _higher_order("required", _B),
    "every": _higher_order("required", _B),
    "map": _higher_order("required", _L),
    "flat": _fn(Signature(params=(_L,), returns=_L)),
    "count": _higher_order("optional", _N),
    "splice": _fn(Signature(params=(_L, _N), optional=(_N,), variadic=(_ANY,), returns=_L)),
    # -- §3.8 Page / Person / relation (3) ----------------------------------
    "id": _fn(
        Signature(params=(), returns=_S),
        Signature(params=(_PG,), returns=_S),
        Signature(params=(_P,), returns=_S),
    ),
    "name": _fn(Signature(params=(_P,), returns=_S)),
    "email": _fn(Signature(params=(_P,), returns=_S)),
}


# `context()` (research §2.6): the automation-only analogue of `prop()`.
# Second Brain has no automations feature yet (design spec's Q4 section
# covers only formula *properties*), so this table exists for language
# completeness/forward-compatibility rather than because anything wires up
# to it today -- flagged in this task's report. Values per research §2.6's
# documented list; "Page added" ("a page created by a prior automation
# step") is given `PAGE` here since research states its *value* is a page
# without ever spelling out a formula-type name for it explicitly -- a
# judgment call, not a documented fact, flagged in the report.
CONTEXT_VARIABLES: dict[str, FType] = {
    "Whoever triggered": FType.PERSON,
    "Page creator": FType.PERSON,
    "Time triggered": FType.DATE,
    "Date triggered": FType.DATE,
    "Trigger page": FType.PAGE,
    "Page added": FType.PAGE,
}

# Research §7.4 / brief §2: a formula is volatile (never materialised) if it
# references `now()` or `today()` *anywhere* in its tree, by name only --
# regardless of call shape (bare `Call` or, defensively, a `MethodCall`
# named `now`/`today`, even though research §2.5's own `UNRESOLVED:` #17
# doubts nullary functions have a documented dot-form at all). Over-detecting
# volatility here is the safe direction: it would at worst skip
# materialising a formula that could have been materialised, never the
# reverse (silently caching a formula whose value moves every second).
_VOLATILE_FUNCTIONS = frozenset({"now", "today"})


# ---------------------------------------------------------------------------
# 3. Comparison/arithmetic helper tables
# ---------------------------------------------------------------------------

# Types accepted by `>`/`>=`/`<`/`<=` (research §1.8's "Booleans compare as
# 1/0" plus the official `now() > Due Date` example (§2.6) extending
# comparison to `Date`). String/List/Person/Page ordering via these
# operators is not documented anywhere (only `sort()` orders strings, a
# different function with its own documented rules) and is deliberately NOT
# extended to here -- flagged in this task's report as a boundary decided,
# not found.
_COMPARABLE = frozenset({FType.NUMBER, FType.BOOLEAN, FType.DATE})

# M8 combined-review finding (fix wave, "Important"): research §1.8's own
# worked example -- `1932.substring(0,2) == "19"` -- is a documented Number-
# receiver-on-a-string-method coercion, and `functions/string.py`'s
# `_as_string_receiver` (Task 25) already implements it at RUNTIME. This
# checker never agreed: `substring`'s signature declares its first
# parameter `STRING`, `_matches`/`unify` has no NUMBER->STRING path, so
# `1932.substring(0,2)` failed type-checking despite being legal, documented
# behaviour. Fixed here by mirroring Task 25's runtime EXACTLY rather than
# inventing a second rule: the exact set of names that call
# `_as_string_receiver` on their first (dot-notation RECEIVER) argument --
# `join`'s first argument is a List, not a receiver-coerced String (its
# separator, position 1, is coerced too, but see the scope note below), and
# `length`/`format`/`formatNumber` never call `_as_string_receiver` at all.
#
# Deliberately NARROW, matching this finding's own instruction: only the
# RECEIVER (argument 0) coerces here, and only Number/Boolean -> String --
# NOT a blanket coercion. `functions/string.py` also happens to coerce a
# handful of OTHER positions for a few of these names (`contains`'s needle,
# `padStart`/`padEnd`'s fill, `split`'s separator, `link`'s url) -- those
# are left type-strict here, same as before this fix: research documents
# exactly one worked example, on the receiver, and extending further would
# be inventing coverage nothing asks for. `functions/regex.py`'s
# `test`/`match`/`replace`/`replaceAll` implement a SEPARATE, already-
# distinct coercion rule (research's own different table row) and are
# intentionally untouched by this fix.
_STRING_RECEIVER_COERCIBLE = frozenset({
    "substring", "contains", "lower", "upper", "repeat", "trim",
    "padStart", "padEnd", "split", "link", "style", "unstyle",
})


def _accepts(t: FType, allowed: frozenset[FType]) -> bool:
    """`t` satisfies a fixed set of allowed types if it is literally one of
    them, or if it is `EMPTY`/`UNKNOWN` (the universal acceptors -- see
    types.py)."""
    return t in allowed or t in (FType.EMPTY, FType.UNKNOWN)


def _matches(actual: FType, expected: FType | None) -> bool:
    """Does an argument of type `actual` satisfy a signature slot of type
    `expected`? `expected is None` means the slot is `Any` (always
    satisfied). Otherwise this is exactly `unify()` -- an `expected=NUMBER`
    slot accepts a real `NUMBER`, and also accepts `EMPTY`/`UNKNOWN` (an
    unresolved property or an already-reported error must not cascade into
    a second, redundant argument-type error here)."""
    if expected is None:
        return True
    return unify(actual, expected) is not None


def _arity_range(sig: Signature) -> tuple[int, int | None]:
    lo = len(sig.params)
    if sig.variadic is not None:
        return lo, None
    return lo, lo + len(sig.optional)


def _arity_matches(sig: Signature, n: int) -> bool:
    lo, hi = _arity_range(sig)
    return n >= lo and (hi is None or n <= hi)


def _overload_mismatches(sig: Signature, arg_types: list[FType]) -> list[tuple[int, str]]:
    """Every (0-based argument index, human-readable expected-type) pair
    where `arg_types[i]` does not satisfy `sig`'s slot for position `i`.
    Empty return means a full match. Caller has already confirmed arity."""
    mismatches: list[tuple[int, str]] = []
    i = 0
    for expected in sig.params:
        if not _matches(arg_types[i], expected):
            mismatches.append((i, "Any" if expected is None else expected.value))
        i += 1
    for expected in sig.optional:
        if i >= len(arg_types):
            break
        if not _matches(arg_types[i], expected):
            mismatches.append((i, "Any" if expected is None else expected.value))
        i += 1
    if sig.variadic is not None:
        union = sig.variadic
        label = "/".join("Any" if u is None else u.value for u in union)
        while i < len(arg_types):
            if not any(_matches(arg_types[i], u) for u in union):
                mismatches.append((i, label))
            i += 1
    return mismatches


# ---------------------------------------------------------------------------
# 4. The checker
# ---------------------------------------------------------------------------


class _Checker:
    """Recursive tree walker. `scope` (a plain `dict[str, FType]`, threaded
    by value -- copied on entry to a new binding scope, never mutated in
    place across branches) carries `let`/`lets` bindings and the implicit
    `current`/`index` variables. One `_Checker` instance per `check()` call;
    `errors` accumulates across the whole tree."""

    def __init__(self, properties: dict[str, str]):
        self.properties = properties
        self.errors: list[FormulaTypeError] = []

    def _error(self, message: str, pos: int) -> FType:
        self.errors.append(FormulaTypeError(message, pos))
        return FType.UNKNOWN

    # -- dispatch -----------------------------------------------------------

    def check(self, node: A.Node, scope: dict[str, FType]) -> FType:
        if isinstance(node, A.Literal):
            return self._check_literal(node)
        if isinstance(node, A.ListLiteral):
            for item in node.items:
                self.check(item, scope)
            return FType.LIST
        if isinstance(node, A.PropertyRef):
            return self._resolve_property(node.name, node.pos)
        if isinstance(node, A.Variable):
            return self._check_variable(node, scope)
        if isinstance(node, A.Unary):
            return self._check_unary(node, scope)
        if isinstance(node, A.Binary):
            return self._check_binary(node, scope)
        if isinstance(node, A.Conditional):
            return self._check_conditional(node, scope)
        if isinstance(node, A.Let):
            return self._check_let(node, scope)
        if isinstance(node, A.MethodCall):
            return self._check_method_call(node, scope)
        if isinstance(node, A.Call):
            return self._check_call(node.name, node.args, node.pos, scope)
        if isinstance(node, A.Lambda):
            # Never constructed by the parser (ast.Lambda's own docstring
            # and Task 23's report: "there is no formula-language syntax
            # that would produce it"). Handled defensively rather than
            # falling through to an unreachable-node crash, in case that
            # ever changes.
            return self._error(
                "lambda nodes are not supported by this language", node.pos
            )
        raise TypeError(f"typecheck: unhandled node type {type(node).__name__}")

    # -- leaves ---------------------------------------------------------------

    def _check_literal(self, node: A.Literal) -> FType:
        if isinstance(node.value, bool):
            return FType.BOOLEAN
        if isinstance(node.value, str):
            return FType.STRING
        return FType.NUMBER

    def _check_variable(self, node: A.Variable, scope: dict[str, FType]) -> FType:
        if node.name in scope:
            return scope[node.name]
        return self._error(f"unbound variable {node.name!r}", node.pos)

    def _resolve_property(self, name: str, pos: int) -> FType:
        """Shared by bare `PropertyRef` and `prop("Name")` (Call or
        MethodCall form) -- see `_check_prop_call`'s docstring for why a
        `receiver.prop("Name")` reference resolves the name against the
        *current* data source's schema exactly like a bare `prop("Name")`
        does, rather than staying unconditionally UNKNOWN."""
        db_type = self.properties.get(name)
        if db_type is None:
            # Ruling (brief §2/§3, not separately re-derived here): an
            # unresolved property name IS reported as an error at this
            # occurrence -- a formula editor validating a fresh edit should
            # flag a typo'd property name -- but the resulting type is
            # UNKNOWN, not a guess, so nothing downstream cascades into a
            # second, redundant error. This does not contradict research
            # §1.9's "a formula with errors can still be saved": whether
            # `.errors` being non-empty blocks a save is a later layer's
            # decision (the router/materialisation task), not this
            # function's.
            return self._error(f"unknown property {name!r}", pos)
        return PROPERTY_TYPE_TO_FTYPE.get(db_type, FType.UNKNOWN)

    # -- operators ------------------------------------------------------------

    def _check_unary(self, node: A.Unary, scope: dict[str, FType]) -> FType:
        operand_t = self.check(node.operand, scope)
        if node.op == "not":
            if unify(operand_t, FType.BOOLEAN) is None:
                return self._error(
                    f"'not' requires a Boolean operand, got {operand_t.value}", node.pos
                )
            return FType.BOOLEAN
        if node.op == "-":
            if unify(operand_t, FType.NUMBER) is None:
                return self._error(
                    f"unary '-' requires a Number operand, got {operand_t.value}", node.pos
                )
            return FType.NUMBER
        raise TypeError(f"typecheck: unknown unary op {node.op!r}")  # pragma: no cover

    def _check_binary(self, node: A.Binary, scope: dict[str, FType]) -> FType:
        left_t = self.check(node.left, scope)
        right_t = self.check(node.right, scope)
        op = node.op

        if op in ("and", "or"):
            if unify(left_t, FType.BOOLEAN) is None or unify(right_t, FType.BOOLEAN) is None:
                return self._error(
                    f"'{op}' requires Boolean operands, got {left_t.value} and {right_t.value}",
                    node.pos,
                )
            return FType.BOOLEAN

        if op in ("==", "!="):
            # Strict equality (research §1.8): cross-type comparison is
            # ALWAYS legal and always evaluates to false; never a type
            # error. Do not "helpfully" reject `"1" == 1` (brief §2,
            # explicit).
            return FType.BOOLEAN

        if op == "+":
            # `+` is overloaded (research §1.8/§2.1, brief §2): if EITHER
            # operand is definitely a String, the result is String
            # (concatenation, stringifying the other operand -- any type,
            # per "`+ prop("Members").length() +` works"). Checked by exact
            # equality (`== FType.STRING`), not `unify`, because an
            # EMPTY/UNKNOWN operand should not itself force the
            # string-concatenation reading -- it falls through to the
            # number branch below, which is the more informative default
            # when neither side is *known* to be a string.
            if left_t is FType.STRING or right_t is FType.STRING:
                return FType.STRING
            if unify(left_t, FType.NUMBER) is not None and unify(right_t, FType.NUMBER) is not None:
                return FType.NUMBER
            return self._error(
                f"'+' requires two numbers, or at least one string operand; "
                f"got {left_t.value} and {right_t.value}",
                node.pos,
            )

        if op in ("-", "*", "/", "%", "^"):
            # Every other arithmetic operator requires numbers on both
            # sides -- no string-concatenation overload, unlike `+` (brief
            # §2, explicit).
            if unify(left_t, FType.NUMBER) is None or unify(right_t, FType.NUMBER) is None:
                return self._error(
                    f"'{op}' requires Number operands, got {left_t.value} and {right_t.value}",
                    node.pos,
                )
            return FType.NUMBER

        if op in (">", ">=", "<", "<="):
            if not (_accepts(left_t, _COMPARABLE) and _accepts(right_t, _COMPARABLE)):
                return self._error(
                    f"'{op}' requires Number, Boolean, or Date operands, "
                    f"got {left_t.value} and {right_t.value}",
                    node.pos,
                )
            return FType.BOOLEAN

        raise TypeError(f"typecheck: unknown binary op {op!r}")  # pragma: no cover

    # -- conditionals and let -------------------------------------------------

    def _check_conditional(self, node: A.Conditional, scope: dict[str, FType]) -> FType:
        # The condition slot accepts ANY type (research §2.3/§1.8's own
        # `if(Date, ...)` and list-condition examples are official; brief
        # §2 explicit: truthiness of non-Boolean conditions is a *runtime*
        # question, out of scope here). Still checked, for its own nested
        # errors -- just not type-restricted.
        self.check(node.cond, scope)
        then_t = self.check(node.then, scope)
        else_t = self.check(node.otherwise, scope)
        unified = unify(then_t, else_t)
        if unified is None:
            return self._error(
                "if/ternary branches must have the same type: "
                f"got {then_t.value} and {else_t.value} "
                "(use empty() for a branch with no value, not \"\")",
                node.pos,
            )
        return unified

    def _check_let(self, node: A.Let, scope: dict[str, FType]) -> FType:
        # Sequential bindings, inner shadows outer (Task 23's ruling,
        # inherited per this task's brief §2): each binding's value is
        # checked against a scope that already includes every binding
        # before it, and immediately extends that same scope for the next
        # one and for the body.
        local = dict(scope)
        for name, value_node in node.bindings:
            local[name] = self.check(value_node, local)
        return self.check(node.body, local)

    # -- calls: dispatch, dot-notation rewrite --------------------------------

    def _check_method_call(self, node: A.MethodCall, scope: dict[str, FType]) -> FType:
        """Dot-notation (research §2.5, brief §2): `a.f(b)` type-checks
        exactly as `f(a, b)` -- **except** for `prop`/`context`/`let`/
        `lets`, whose dot forms are not a mechanical `f(receiver, *args)`
        rewrite (see each branch below for why). Errors are reported
        against `node.pos` -- the position of the *written* dot-call -- in
        every branch, per brief §2: "point where the user typed"."""
        if node.name == "prop":
            return self._check_prop_call(node.args, node.pos, scope, receiver=node.receiver)
        if node.name == "context":
            # No documented dot-form for `context` (it is not page-relative
            # the way `prop` is), but the parser will happily build this
            # node for `x.context("Y")` since dot-notation is mechanically
            # available on any receiver. Treated leniently: the receiver is
            # still checked (for its own nested errors) and ignored
            # semantically, rather than invented-rejected -- low-stakes
            # syntax nobody is likely to write on purpose.
            self.check(node.receiver, scope)
            return self._check_context_call(node.args, node.pos, scope)
        if node.name in ("let", "lets"):
            # Task 23's ruling (report #7): `variable.lets(...)` stays a
            # plain MethodCall, never normalised to `ast.Let` -- research
            # §2.4 flags what it would even MEAN as `UNRESOLVED:`
            # ("probably a documentation artefact"). This task inherits
            # that non-decision and resolves it here (brief-uncovered,
            # flagged in the report): reject with a clear, located error
            # rather than inventing a receiver-bound scoping rule with no
            # source to check it against. Sub-expressions are still
            # checked, for their own nested errors.
            self.check(node.receiver, scope)
            for a in node.args:
                self.check(a, scope)
            return self._error(
                f"{node.name}(...) has no defined meaning in dot-notation form "
                f"(research §2.4 flags this as unresolved/likely a documentation "
                f"artefact); use {node.name}(name, value, ..., expr) instead",
                node.pos,
            )
        combined = [node.receiver, *node.args]
        return self._check_call(node.name, combined, node.pos, scope)

    def _check_call(
        self, name: str, args: list[A.Node], pos: int, scope: dict[str, FType]
    ) -> FType:
        if name == "prop":
            return self._check_prop_call(args, pos, scope, receiver=None)
        if name == "context":
            return self._check_context_call(args, pos, scope)
        if name == "if":
            # Only reached for a wrong-arity `if(...)` -- Task 23 normalises
            # every exactly-3-arg `if` (and every ternary) to `ast.
            # Conditional` at parse time, so a plain `Call("if", ...)` node
            # only exists here when `len(args) != 3` OR via this method's
            # own dot-form rewrite above (`x.if(a, b)` -> combined 3 args,
            # which DOES produce a well-formed conditional here, by design
            # -- the dot-rewrite equivalence applies to `if` even though
            # the parser's own bare-call normalisation doesn't reach dot
            # calls; see ast.Conditional's docstring for why the two forms
            # are the same construct).
            return self._check_if_call(args, pos, scope)
        if name == "ifs":
            return self._check_ifs_call(args, pos, scope)
        if name in ("let", "lets"):
            # Unreachable via the parser's own contract for a *bare* call
            # (Task 23's `_normalize_call` always rewrites `let`/`lets` to
            # `ast.Let`) -- handled defensively for the same reason as
            # `ast.Lambda` above, not because real input reaches it.
            for a in args:
                self.check(a, scope)
            return self._error(f"{name}(...) with no defined shape here", pos)

        spec = FUNCTION_SIGNATURES.get(name)
        if spec is None:
            for a in args:
                self.check(a, scope)
            return self._error(f"unknown function {name!r}", pos)
        if spec.current_expr is not None:
            return self._check_higher_order_call(name, args, spec, pos, scope)
        return self._check_overloaded_call(name, args, spec, pos, scope)

    # -- special-cased call forms ----------------------------------------------

    def _check_prop_call(
        self,
        args: list[A.Node],
        pos: int,
        scope: dict[str, FType],
        *,
        receiver: A.Node | None,
    ) -> FType:
        """`prop("Name")` (bare) and `receiver.prop("Name")` (dot form,
        e.g. `prop("Relation").first().prop("Created By")`, or the
        bare-token dot-desugar for `current.Status` -- see parser.py's
        `_parse_dot_access`).

        Both resolve "Name" against `self.properties` -- the *current* data
        source's schema -- identically. For the bare form this is exactly
        right (`prop("Name")` always means "this row's Name"). For the dot
        form it is a deliberate, brief-uncovered simplification (flagged in
        this task's report): `receiver` is, in general, a `Page` value that
        may belong to an entirely different data source (e.g. reached
        through a relation), and this type system has no dependent typing
        to know *which* database's schema to resolve "Name" against. Rather
        than inventing cross-database schema tracking with nothing in
        research to check it against, this resolves every `.prop("Name")`
        the same way a bare `prop("Name")` would: against the CURRENT data
        source. This is correct for the common case research itself
        documents most (`current.Status` inside a self-relation traversal,
        e.g. `Parent Task.Sub-item.every(current.Status == "Done")`, where
        the related rows share the same schema) and silently wrong only
        when a differently-typed property happens to share the name across
        two unrelated databases -- a real but narrow limitation, not
        invented rigor. `deps.py`'s `referenced_properties()` makes the
        identical choice, for the identical reason, and the two are kept
        structurally unable to disagree (see `check()`)."""
        if receiver is not None:
            self.check(receiver, scope)
        for a in args:
            self.check(a, scope)
        if len(args) != 1 or not isinstance(args[0], A.Literal) or not isinstance(
            args[0].value, str
        ):
            return self._error("prop() requires exactly one string literal argument", pos)
        return self._resolve_property(args[0].value, args[0].pos)

    def _check_context_call(
        self, args: list[A.Node], pos: int, scope: dict[str, FType]
    ) -> FType:
        """`context("...")` (research §2.6): the automation-only analogue
        of `prop()`. Not added to any "referenced properties" set --
        context variables are not stored properties, and `deps.
        referenced_properties()` does not collect them either (see that
        module)."""
        for a in args:
            self.check(a, scope)
        if len(args) != 1 or not isinstance(args[0], A.Literal) or not isinstance(
            args[0].value, str
        ):
            return self._error("context() requires exactly one string literal argument", pos)
        name = args[0].value
        if name not in CONTEXT_VARIABLES:
            return self._error(f"unknown context variable {name!r}", args[0].pos)
        return CONTEXT_VARIABLES[name]

    def _check_if_call(self, args: list[A.Node], pos: int, scope: dict[str, FType]) -> FType:
        arg_types = [self.check(a, scope) for a in args]
        if len(args) != 3:
            return self._error(
                "if() requires exactly 3 arguments (condition, then, otherwise); "
                f"got {len(args)}",
                pos,
            )
        unified = unify(arg_types[1], arg_types[2])
        if unified is None:
            return self._error(
                "if() branches must have the same type: "
                f"got {arg_types[1].value} and {arg_types[2].value}",
                pos,
            )
        return unified

    def _check_ifs_call(self, args: list[A.Node], pos: int, scope: dict[str, FType]) -> FType:
        arg_types = [self.check(a, scope) for a in args]
        # `ifs` needs an odd argument count: N condition/value pairs plus
        # one trailing default (research §2.3; Task 23 deliberately left
        # this shape check to this task -- brief §2, explicit).
        if len(args) < 1 or len(args) % 2 == 0:
            return self._error(
                "ifs() requires an odd number of arguments "
                f"(condition/value pairs plus a default); got {len(args)}",
                pos,
            )
        # Condition slots (even 0-based indices, excluding the final
        # default) accept any type, mirroring `if`'s condition slot.
        value_types = [arg_types[i] for i in range(1, len(args) - 1, 2)]
        value_types.append(arg_types[-1])
        unified = value_types[0]
        for t in value_types[1:]:
            nxt = unify(unified, t)
            if nxt is None:
                return self._error("ifs() branches must have the same type", pos)
            unified = nxt
        return unified

    def _check_higher_order_call(
        self,
        name: str,
        args: list[A.Node],
        spec: FunctionSpec,
        pos: int,
        scope: dict[str, FType],
    ) -> FType:
        """`map`/`filter`/`find`/`findIndex`/`some`/`every`/`count`/`sort`
        (research §2.12): the first argument is the list; every argument
        after it is a bare expression checked with `current`/`index` bound
        -- and, per this task's brief, bound for ALL of these (only `map`
        has a documented `index` example, but binding it more widely is a
        superset that cannot reject a valid formula; see this task's
        report for the citation). `current`'s type is `UNKNOWN` (LIST is
        unparameterised, types.py), so those per-element expressions are
        honestly, deliberately under-checked -- almost anything unifies
        against `UNKNOWN`. This is a real, documented limitation of a
        `List<Any>` type system, not a bug: the alternative would be
        pretending to a rigor this type system cannot deliver."""
        child_scope = dict(scope)
        child_scope["current"] = FType.UNKNOWN
        child_scope["index"] = FType.NUMBER
        arg_types: list[FType] = []
        for i, a in enumerate(args):
            arg_types.append(self.check(a, child_scope if i >= 1 else scope))

        n = len(args)
        ok_arity = (n == 2) if spec.current_expr == "required" else n in (1, 2)
        if not ok_arity:
            expected = "exactly 2 arguments" if spec.current_expr == "required" else "1 or 2 arguments"
            return self._error(f"{name}() expects {expected}; got {n}", pos)
        if unify(arg_types[0], FType.LIST) is None:
            return self._error(
                f"{name}() requires a List as its first argument, got {arg_types[0].value}",
                pos,
            )
        return spec.overloads[0].returns

    def _check_overloaded_call(
        self,
        name: str,
        args: list[A.Node],
        spec: FunctionSpec,
        pos: int,
        scope: dict[str, FType],
    ) -> FType:
        arg_types = [self.check(a, scope) for a in args]
        if (
            name in _STRING_RECEIVER_COERCIBLE
            and arg_types
            and arg_types[0] in (FType.NUMBER, FType.BOOLEAN)
        ):
            # The Number/Boolean-receiver-on-a-string-method coercion
            # (`_STRING_RECEIVER_COERCIBLE`'s own docstring) -- rewrite the
            # CHECKED type of the receiver position to STRING, matching
            # what `_as_string_receiver` actually produces at runtime,
            # before running the normal overload match below. Works
            # identically for the dot form (`1932.substring(...)`, where
            # `_check_method_call` already folded the receiver into
            # position 0) and the bare-call form
            # (`substring(1932, ...)`), since both reach this function with
            # the receiver-equivalent argument at index 0.
            arg_types = [FType.STRING, *arg_types[1:]]
        candidates = [ov for ov in spec.overloads if _arity_matches(ov, len(args))]
        if not candidates:
            ranges = ", ".join(
                f"{lo}" if hi == lo else (f"{lo}-{hi}" if hi is not None else f"{lo}+")
                for lo, hi in (_arity_range(ov) for ov in spec.overloads)
            )
            return self._error(
                f"{name}() got {len(args)} argument(s), expected {ranges}", pos
            )
        first_problems: list[tuple[int, str]] | None = None
        for ov in candidates:
            problems = _overload_mismatches(ov, arg_types)
            if not problems:
                return ov.returns
            if first_problems is None:
                first_problems = problems
        detail = "; ".join(
            f"argument {i + 1} expected {expected}, got {arg_types[i].value}"
            for i, expected in first_problems  # type: ignore[union-attr]
        )
        return self._error(f"{name}(): {detail}", pos)


# ---------------------------------------------------------------------------
# 5. Volatility (spec §7.4)
# ---------------------------------------------------------------------------


def _is_volatile(node: A.Node) -> bool:
    """A formula is volatile if it references `now()`/`today()` ANYWHERE in
    its tree -- computed with `walk()` over the same tree everything else
    uses, per brief §2 ("not by grepping the source text"), so it catches a
    `now()` nested arbitrarily deep inside a `let` body, a list literal, or
    a function argument, not just a top-level call."""
    for n in A.walk(node):
        if isinstance(n, A.Call) and n.name in _VOLATILE_FUNCTIONS:
            return True
        if isinstance(n, A.MethodCall) and n.name in _VOLATILE_FUNCTIONS:
            return True
    return False


# ---------------------------------------------------------------------------
# 6. Entry point
# ---------------------------------------------------------------------------


def check(node: A.Node, *, properties: dict[str, str]) -> CheckResult:
    """Type-check `node`. `properties` maps property **name** -> `db_properties
    .type` (brief §2: formulas reference properties by name; the graph and
    everything downstream key off `key`, but that resolution is `deps.
    build_graph`'s job, not this function's)."""
    checker = _Checker(properties)
    result_type = checker.check(node, {})
    # Computed by calling deps.py's own function on the SAME tree, not a
    # second, hand-rolled walk -- see CheckResult's docstring for why this
    # is structural, not just consistent by coincidence.
    referenced = referenced_properties(node)
    return CheckResult(
        type=result_type,
        errors=checker.errors,
        referenced=referenced,
        is_volatile=_is_volatile(node),
    )
