"""The formula language's evaluator: the third of spec §7.2's "one tree,
three visitors" (the parser produces the tree; `typecheck.py` is the
second visitor; this is the third). Tree-walking, no bytecode, over Task
23's AST -- `evaluate(node, ctx) -> FValue`.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.1
(backend-only), §7.2 (one tree, three visitors).
Research: docs/research/notion-databases-research.md §H.1 (types),
§H.1.4 (empty), §H.1.8 (coercion), §H.1.9 (errors -- the UNRESOLVED
runtime-edge list this module rules on, see `_invoke`'s docstring and this
task's report), §H.2.3-2.5 (conditionals/let/dot-notation), §H.3.1-3.4
(the four categories this task implements).
Brief: .superpowers/sdd/2026-08-08-notion-databases/task-25-brief.md.

Task 26 (date/time §3.6, list §3.7, page/person §3.8) completes this
module: `now()`/`today()` (`_eval_now_today`), the bare `id()` overload
(`_eval_bare_id`), and the 8 `current`/`index`-scoped higher-order list
functions (`_eval_higher_order_call`) all need something a plain
`functions.REGISTRY` entry cannot see (`EvalContext` itself, or an
unevaluated AST node) -- see each function's own docstring below for why
they are intercepted here rather than reached through the ordinary
`_invoke` path every other builtin in this package uses.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Mapping

from . import ast as A
from . import functions
from .values import EMPTY, Date, FValue, Page, as_number, stringify, truthy

__all__ = ["EvalContext", "evaluate", "FormulaEvalError"]


class FormulaEvalError(Exception):
    """Raised only for a genuine implementation gap (a builtin this
    package has not implemented yet -- see module docstring) or an
    unreachable-by-construction AST shape (`ast.Lambda`, mirroring
    `typecheck.py`'s identical defensive handling). NEVER raised for a
    malformed or runtime-edge-case VALUE (`divide(1,0)`,
    `toNumber("abc")`, an out-of-range index, ...) -- every one of those
    returns `EMPTY` instead, per this task's brief and `_invoke`'s
    docstring below. This is therefore a much narrower exception than a
    generic "evaluation failed" -- it should never fire for a formula this
    package's four categories fully cover, however malformed the input
    values are."""


@dataclass(frozen=True)
class EvalContext:
    """Everything `evaluate()` needs beyond the AST node itself (brief
    §2).

    - `properties`: the row's property values, by NAME (matching
      `typecheck.check()`'s `properties: dict[str, str]` being name-keyed
      too, and `deps.referenced_properties()` collecting names -- all
      three visitors agree on "formulas reference properties by name").
    - `now`: captured ONCE per evaluation pass, by the caller, and passed
      in -- never read from `datetime.now()` inside a builtin. Brief,
      explicit: two `now()` calls in one formula must return the same
      instant, and a recompute pass over many rows must not drift across
      them mid-pass. UTC (matching the volatility/materialisation design's
      documented UTC-only decision) -- callers are expected to pass a
      timezone-AWARE UTC `datetime`; not enforced here (no `now()`/
      date builtins exist yet in this task to consume it at all -- Task 26
      is the first real caller of this field).
    - `scope`: `let`/`lets` bindings and (Task 26) the implicit
      `current`/`index` list-function variables, threaded by returning a
      NEW `EvalContext` (via `with_binding`) rather than mutating a shared
      dict -- mirrors `typecheck._Checker`'s identical `dict(scope)`-copy-
      on-extend discipline, for the identical reason (an inner binding
      must never leak into a sibling branch that didn't introduce it).
    - `page_id` (Task 26): the id of the row this formula is attached to,
      for bare `id()` with no argument (research §1.6, official: "If no
      page is provided, returns the id of the page the formula is on") --
      see `_eval_bare_id`. `None` for any caller that doesn't supply it
      (every test in this package that isn't specifically about `id()`),
      in which case `id()` is `EMPTY`, never a fabricated id.
    - `related_properties` (M8 combined review fix wave, Important finding):
      `{page_id: {property_name: FValue}}` for every page this evaluation
      pass might need to resolve a relation-hop `.prop()` call against --
      pre-loaded, SYNCHRONOUSLY, by the caller (`recompute.py`) before
      `evaluate()` ever runs, exactly like `now`. `evaluate()` itself
      stays synchronous and DB-free; this field is how a receiver that
      evaluates to a `Page` gets real data without `_eval_prop` reaching
      out to the database mid-walk. Empty by default (every test in this
      package that isn't specifically about relation-hop `.prop()`).
    - `depth_budget`/relation-hop tracking (Task 26, WIRED UP by this fix):
      the relation-traversal depth cap (spec §7.3, capped at 3).
      `_eval_prop`'s dot form now actually calls `with_relation_hop()` for
      every receiver that evaluates to a `Page` -- see that function's own
      docstring for the fix and why `EvalContext` needed a SHARED, mutable
      hop counter (not just a `replace()`-derived immutable field) to make
      consumption accumulate correctly across a NESTED chain of dot-prop
      calls, which are ordinary recursive `evaluate()` calls over the same
      `ctx` object, not a re-threaded one.
    """

    properties: Mapping[str, FValue]
    now: datetime
    scope: Mapping[str, FValue] = field(default_factory=dict)
    page_id: str | None = None
    related_properties: Mapping[str, Mapping[str, FValue]] = field(default_factory=dict)
    depth_budget: int = 3
    # A one-element-when-tripped mutable box, deliberately NOT a plain
    # `bool` field -- `EvalContext` is frozen, and `with_relation_hop`
    # needs to leave a mark that every OTHER context derived from the same
    # root (via `replace()`, which passes field VALUES through --
    # preserving this list's object identity, not copying it) can still
    # see. Mirrors `typecheck._Checker.errors`'s identical "one shared
    # mutable accumulator, not a copy-on-write field" pattern, adapted for
    # a frozen dataclass instead of a stateful visitor object.
    _depth_exceeded_flag: list[bool] = field(default_factory=list)
    # The SAME "shared mutable box, carried by identity through replace()"
    # idea as `_depth_exceeded_flag` above, applied to the remaining-hop
    # COUNT itself. This is not cosmetic: a chain like
    # `current.prop("A").prop("B").prop("C")` is THREE nested `_eval_prop`
    # calls, each evaluating its own receiver via a plain recursive
    # `evaluate(receiver, ctx)` call over the SAME `ctx` object (no
    # `with_binding`/rebind happens between them) -- if `with_relation_hop`
    # only returned a new, decremented `EvalContext` without a caller ever
    # using it (this evaluator's `_eval_prop` doesn't recurse into
    # `evaluate()` with a hopped context; it resolves the property directly
    # from `related_properties`), every nested call would independently see
    # the SAME starting `depth_budget` and the cap could never actually be
    # reached, no matter how long the chain -- a mutable box, populated
    # once in `__post_init__` from the constructor's `depth_budget` and
    # then decremented in place, is what makes consumption by an INNER call
    # visible to an OUTER one evaluated afterwards on the same `ctx`.
    _hops_remaining: list[int] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self._hops_remaining:  # only on first real construction, see field's own comment
            self._hops_remaining.append(self.depth_budget)

    def with_binding(self, name: str, value: FValue) -> "EvalContext":
        new_scope = dict(self.scope)
        new_scope[name] = value
        return replace(self, scope=new_scope)

    def with_relation_hop(self) -> "EvalContext | None":
        """Called by `_eval_prop` for every relation-hop `.prop()` call
        (a dot-form call whose receiver evaluates to a `Page`). Returns a
        new `EvalContext` reflecting the decremented budget, or `None`
        when the budget is already exhausted -- the brief's own contract:
        "when it hits zero, return EMPTY and set a flag on the context
        that recompute.py turns into the `{"type":"unsupported"}`
        sentinel" (research §1.9/§4.6's own API marker for a formula that
        "depends on too many related pages"). The caller's responsibility,
        not this method's: use `EMPTY` as that hop's contribution when
        this returns `None`, and check `depth_exceeded` once the whole
        pass finishes to decide whether to surface `unsupported` instead
        of a real value. Never raises.

        The returned context's own `depth_budget` field is kept in sync
        with the shared counter purely for readability/introspection (e.g.
        a debugger or a future caller that DOES want to recurse into
        `evaluate()` with it) -- the actual enforcement is the shared
        `_hops_remaining` box, per that field's own comment."""
        if self._hops_remaining[0] <= 0:
            self._depth_exceeded_flag.append(True)
            return None
        self._hops_remaining[0] -= 1
        return replace(self, depth_budget=self._hops_remaining[0])

    @property
    def depth_exceeded(self) -> bool:
        return bool(self._depth_exceeded_flag)


# ---------------------------------------------------------------------------
# The general EMPTY-propagation rule (brief §2: "Make the general rule
# explicit in one place in the evaluator rather than re-deciding it inside
# 53 functions.")
# ---------------------------------------------------------------------------

# Every builtin call funnels through `_invoke`, which enforces "an
# operation on EMPTY yields EMPTY" for every name EXCEPT these five --
# exactly the ones research/the brief document as behaving differently
# when handed EMPTY input:
#   - `empty`: its entire job IS testing for EMPTY; short-circuiting it
#     would make `empty(empty())` itself always EMPTY instead of `true`.
#   - `if`/`ifs`: EMPTY is a legitimate, FALSY condition value (research
#     §2.3's own "likely non-empty => true" hint, `values.truthy`) --
#     propagating would make `if(empty(), 1, 2)` always EMPTY instead of
#     evaluating to `2`.
#   - `equal`/`unequal`: EMPTY must be a comparable VALUE, not swallowed --
#     this is how `x == empty()` works at all as a spelling of "is x
#     empty" (the `empty(x)` predicate is the normal way to ask that, but
#     nothing stops a formula from writing the comparison directly, and it
#     must not always answer EMPTY regardless of `x`).
_EMPTY_AWARE = frozenset({"empty", "if", "ifs", "equal", "unequal"})

# Task 26: the 9 names that need something a plain `functions.REGISTRY`
# entry cannot access, and are therefore intercepted in `_eval_call`/
# `_eval_method_call` BEFORE the generic `_invoke` dispatch below --
# `_eval_now_today`'s and `_eval_higher_order_call`'s own docstrings have
# the full reasoning for each group.
_NULLARY_DATE_FUNCTIONS = frozenset({"now", "today"})
_HIGHER_ORDER_LIST_FNS = frozenset(
    {"map", "filter", "find", "findIndex", "some", "every", "sort", "count"}
)


def _invoke(name: str, arg_values: list[FValue]) -> FValue:
    fn = functions.REGISTRY.get(name)
    if fn is None:
        raise FormulaEvalError(
            f"formula function {name!r} has no REGISTRY entry at all -- "
            "either a genuine typo/unimplemented builtin, or (if it's one "
            "of the 9 names evaluator.py special-cases -- now/today/the "
            "8 higher-order list functions) evaluator.py's own dispatch "
            "failed to intercept it before reaching _invoke"
        )
    if name not in _EMPTY_AWARE and any(v is EMPTY for v in arg_values):
        return EMPTY
    return fn(arg_values)


# ---------------------------------------------------------------------------
# evaluate()
# ---------------------------------------------------------------------------


def evaluate(node: A.Node, ctx: EvalContext) -> FValue:
    if isinstance(node, A.Literal):
        return node.value
    if isinstance(node, A.ListLiteral):
        return [evaluate(item, ctx) for item in node.items]
    if isinstance(node, A.PropertyRef):
        return ctx.properties.get(node.name, EMPTY)
    if isinstance(node, A.Variable):
        # An unbound variable is unreachable for a formula that passed
        # `typecheck.check()` (`_check_variable` already reports this as
        # an error there) -- handled defensively, not because valid input
        # reaches it, per this task's brief-wide "never raise on malformed
        # input" ruling.
        return ctx.scope.get(node.name, EMPTY)
    if isinstance(node, A.Unary):
        return _eval_unary(node, ctx)
    if isinstance(node, A.Binary):
        return _eval_binary(node, ctx)
    if isinstance(node, A.Conditional):
        return _eval_conditional(node, ctx)
    if isinstance(node, A.Let):
        return _eval_let(node, ctx)
    if isinstance(node, A.MethodCall):
        return _eval_method_call(node, ctx)
    if isinstance(node, A.Call):
        return _eval_call(node.name, node.args, ctx)
    if isinstance(node, A.Lambda):
        # Mirrors typecheck.py's identical defensive branch: the parser
        # never constructs one (ast.Lambda's own docstring; Task 23's
        # report), so this is unreachable via real input.
        raise FormulaEvalError("lambda nodes are not supported by this language")
    raise FormulaEvalError(f"evaluate(): unhandled node type {type(node).__name__}")


# -- operators ----------------------------------------------------------------


def _eval_unary(node: A.Unary, ctx: EvalContext) -> FValue:
    operand = evaluate(node.operand, ctx)
    if node.op == "not":
        # Delegates to the SAME registry entry the `not(x)`/function-call
        # spelling uses (`functions.logic._not`) -- one implementation for
        # both of research's documented spellings (§2.1/§3.1), not two
        # that could quietly drift apart.
        return _invoke("not", [operand])
    if node.op == "-":
        if operand is EMPTY:
            return EMPTY
        n = as_number(operand)
        return EMPTY if n is None else -n
    raise FormulaEvalError(f"evaluate(): unknown unary op {node.op!r}")  # pragma: no cover


_BINARY_TO_BUILTIN = {
    "-": "subtract",
    "*": "multiply",
    "/": "divide",
    "%": "mod",
    "^": "pow",
}


def _eval_binary(node: A.Binary, ctx: EvalContext) -> FValue:
    op = node.op
    left = evaluate(node.left, ctx)
    right = evaluate(node.right, ctx)

    if op == "and":
        return _invoke("and", [left, right])
    if op == "or":
        return _invoke("or", [left, right])
    if op == "==":
        return _invoke("equal", [left, right])
    if op == "!=":
        return _invoke("unequal", [left, right])

    if op == "+":
        return _eval_add(left, right)

    if op in _BINARY_TO_BUILTIN:
        # `-`/`*`/`/`/`%`/`^` as operators have IDENTICAL semantics to
        # `subtract`/`multiply`/`divide`/`mod`/`pow` as function calls
        # (unlike `+`, which overloads string concatenation on top of
        # `add`'s pure-arithmetic behaviour -- see `_eval_add`'s
        # docstring) -- delegating avoids a second copy of the same
        # domain-error handling (division/mod by zero, `pow`'s complex-
        # result guard, ...).
        return _invoke(_BINARY_TO_BUILTIN[op], [left, right])

    if op in (">", ">=", "<", "<="):
        return _eval_compare(op, left, right)

    raise FormulaEvalError(f"evaluate(): unknown binary op {op!r}")  # pragma: no cover


def _eval_add(left: FValue, right: FValue) -> FValue:
    """`+`'s overload (research §1.8/§2.1, brief §2): if either operand is
    a `String`, concatenate (stringifying the other side); otherwise, if
    both are numbers, add. This is DELIBERATELY separate from the plain
    `add()` builtin (`functions/numeric.py`), which is pure Number+Number
    arithmetic with NO string-concatenation overload -- research §1.8 is
    explicit that `add(2, "2")` is a type error while `2 + "2"` is legal
    and concatenates. The two spellings are NOT the same operation despite
    `receiver.f(a,b) === f(receiver,a,b)` holding for every OTHER operator
    (research §2.5) -- `+` is the one documented exception, so it gets its
    own function here instead of delegating to `_invoke("add", ...)` the
    way every other arithmetic operator above does.

    EMPTY propagates (general rule) -- `+` is not one of the five
    documented exceptions in `_EMPTY_AWARE`, so `"prefix" + empty()` is
    `EMPTY`, not `"prefix"` or `"prefixEMPTY"`."""
    if left is EMPTY or right is EMPTY:
        return EMPTY
    if isinstance(left, str) or isinstance(right, str):
        return stringify(left) + stringify(right)
    l_num = as_number(left)
    r_num = as_number(right)
    if l_num is not None and r_num is not None:
        return l_num + r_num
    return EMPTY  # malformed post-typecheck input (e.g. a bare List/Date operand)


def _eval_compare(op: str, left: FValue, right: FValue) -> FValue:
    """`>`/`>=`/`<`/`<=` (research §1.8: Number/Boolean/Date, booleans as
    `1`/`0`; `typecheck._COMPARABLE` is the type-check-time mirror of this
    same set). EMPTY propagates (general rule; comparison is not one of
    the five `_EMPTY_AWARE` exceptions -- `x > empty()` is `EMPTY`, not a
    `false`/`true` guess about ordering against "nothing")."""
    if left is EMPTY or right is EMPTY:
        return EMPTY

    def _ordinal(v: FValue) -> float | datetime | None:
        if isinstance(v, bool):
            return 1.0 if v else 0.0  # booleans compare as 1/0, research §1.8
        if isinstance(v, float):
            return v
        if isinstance(v, Date):
            # Ordered by `.start` only -- no documented ordering rule for
            # a RANGED Date's `end` component in a `>`/`<` comparison
            # (research is silent; `sort()`'s own default ordering has the
            # identical "Date earlier->later" rule with no ranged-value
            # carve-out either). Decided, flagged in this task's report.
            return v.start
        return None  # String/List/Person/Page: not comparable, see typecheck._COMPARABLE

    l_ord = _ordinal(left)
    r_ord = _ordinal(right)
    if l_ord is None or r_ord is None or type(l_ord) is not type(r_ord):
        return EMPTY  # malformed post-typecheck input, or a Number-vs-Date mismatch
    if op == ">":
        return l_ord > r_ord
    if op == ">=":
        return l_ord >= r_ord
    if op == "<":
        return l_ord < r_ord
    return l_ord <= r_ord  # "<="


# -- conditionals and let -------------------------------------------------


def _eval_conditional(node: A.Conditional, ctx: EvalContext) -> FValue:
    """`if(cond, then, else)` / ternary (one shared AST node, `ast.
    Conditional` -- see its own docstring). Evaluated LAZILY: only the
    condition and the CHOSEN branch are evaluated, not both (an explicit
    implementation choice, not a semantic requirement -- this language has
    no side effects or exceptions that escape an expression, so eager
    evaluation of both branches would be observably identical; lazy is
    simply the more efficient and more conventional reading for a tree-
    walking `if`, and avoids ever evaluating a branch that references an
    out-of-scope `let` binding from a sibling branch)."""
    cond = evaluate(node.cond, ctx)
    branch = node.then if truthy(cond) else node.otherwise
    return evaluate(branch, ctx)


def _eval_let(node: A.Let, ctx: EvalContext) -> FValue:
    """Sequential bindings, inner shadows outer (Task 23's parser-level
    ruling, reconfirmed by Task 24's checker, applied identically here for
    the third visitor in a row): each binding's value expression is
    evaluated against a context that already includes every binding
    before it."""
    local_ctx = ctx
    for name, value_node in node.bindings:
        value = evaluate(value_node, local_ctx)
        local_ctx = local_ctx.with_binding(name, value)
    return evaluate(node.body, local_ctx)


# -- calls: dispatch, dot-notation rewrite --------------------------------


def _eval_method_call(node: A.MethodCall, ctx: EvalContext) -> FValue:
    """Mirrors `typecheck._check_method_call`'s dispatch exactly (brief:
    the three visitors must not disagree about what a formula means) --
    `prop`/`context`/`let`/`lets` are NOT a mechanical `f(receiver, *args)`
    rewrite; every other name is."""
    if node.name == "prop":
        return _eval_prop_dot(node.receiver, node.args, ctx)
    if node.name == "context":
        evaluate(node.receiver, ctx)  # for any nested side-effect-free evaluation only
        return _eval_context(node.args, ctx)
    if node.name in ("let", "lets"):
        # typecheck.py rejects this shape outright (`_check_method_call`:
        # "has no defined meaning in dot-notation form") -- a formula
        # containing it cannot pass type-checking, but research §1.9
        # documents that a formula WITH errors can still be saved, so this
        # must still evaluate to something rather than crash. EMPTY, this
        # task's standing ruling for a construct with no defined runtime
        # meaning.
        evaluate(node.receiver, ctx)
        for a in node.args:
            evaluate(a, ctx)
        return EMPTY
    if node.name in _NULLARY_DATE_FUNCTIONS:
        # research §2.5's own UNRESOLVED #17: no documented dot-form for a
        # nullary function (mechanically it has no receiver to be "the"
        # argument). Handled leniently, the same way `context`'s dot-form
        # is above: evaluate the receiver for its own nested errors/side
        # effects, then answer with the SAME real `now`/`today` value the
        # bare-call form would -- deliberately NOT falling through to the
        # generic `_invoke` path below, which would silently pass the
        # receiver as now/today's first argument and hit the
        # unreachable-stub's `RuntimeError` (functions.
        # unreachable_via_evaluator) instead of a value. Consistency
        # between `now()` and `x.now()` (should either ever be written) is
        # worth more than strictly rejecting an unlikely form no research
        # example ever exercises either way.
        evaluate(node.receiver, ctx)
        return _eval_now_today(node.name, ctx)
    if node.name in _HIGHER_ORDER_LIST_FNS:
        return _eval_higher_order_call(node.name, [node.receiver, *node.args], ctx)
    arg_values = [evaluate(node.receiver, ctx)] + [evaluate(a, ctx) for a in node.args]
    return _invoke(node.name, arg_values)


def _eval_call(name: str, arg_nodes: list[A.Node], ctx: EvalContext) -> FValue:
    if name == "prop":
        return _eval_prop(arg_nodes, ctx)
    if name == "context":
        return _eval_context(arg_nodes, ctx)
    if name in ("let", "lets"):
        # Unreachable via the parser's own contract for a BARE call
        # (Task 23's `_normalize_call` always rewrites `let`/`lets` to
        # `ast.Let`) -- handled defensively, same reasoning as
        # `ast.Lambda` above.
        for a in arg_nodes:
            evaluate(a, ctx)
        return EMPTY
    if name in _NULLARY_DATE_FUNCTIONS:
        return _eval_now_today(name, ctx)
    if name == "id" and not arg_nodes:
        return _eval_bare_id(ctx)
    if name in _HIGHER_ORDER_LIST_FNS:
        return _eval_higher_order_call(name, arg_nodes, ctx)
    arg_values = [evaluate(a, ctx) for a in arg_nodes]
    return _invoke(name, arg_values)


def _prop_name(args: list[A.Node]) -> str | None:
    """The single string-literal argument every `prop("Name")` call
    (bare or dot form) requires, or `None` for a malformed, post-typecheck
    call shape (wrong arity, a non-literal, a non-string literal) -- never
    raises; the caller turns `None` into `EMPTY`, per this module's
    standing "never raise on malformed input" rule."""
    if len(args) != 1 or not isinstance(args[0], A.Literal) or not isinstance(
        args[0].value, str
    ):
        return None
    return args[0].value


def _eval_prop(args: list[A.Node], ctx: EvalContext) -> FValue:
    """Bare `prop("Name")`: always resolves "Name" against `ctx.
    properties` -- THIS row's own property values. Unaffected by the
    relation-hop fix below (`_eval_prop_dot`) -- a bare call has no
    receiver to chase in the first place."""
    name = _prop_name(args)
    if name is None:
        return EMPTY  # malformed prop() call, post-typecheck; never raise
    return ctx.properties.get(name, EMPTY)


def _eval_prop_dot(receiver_node: A.Node, args: list[A.Node], ctx: EvalContext) -> FValue:
    """`receiver.prop("Name")` (dot form) -- the M8 combined-review fix
    (Important finding): `receiver` IS now evaluated, and when it comes
    back a `Page` (research §3.8's own documented idiom, `prop("Tasks").
    filter(current.prop("Status") != "Done")` -- `current` is bound to
    each related `Page` in turn by `_eval_higher_order_call`), "Name" is
    resolved against `ctx.related_properties[page.id]` -- that RELATED
    row's own values -- not `ctx.properties`, THIS row's.

    This corrects a real bug, not a re-derivation of Task 24's ruling: the
    previous version of this function ignored `receiver` entirely and
    always read `ctx.properties`, so `current.prop("Status")` inside a
    `.filter(...)` silently read the SAME (wrong) row's Status for every
    element instead of each related row's -- reproduced empirically, no
    exception, just a silently wrong answer for the language's own
    documented example. The docstring this function used to carry
    defended that as inherited from `typecheck._check_prop_call`'s
    identical-looking ruling, but the two are NOT the same problem:
    `typecheck.py` operates on the AST alone, before any row exists, and
    genuinely cannot know which data source's *schema* a `Page`-typed
    receiver belongs to (no dependent typing -- a real, still-standing
    static-analysis limit, untouched by this fix). At RUNTIME, by
    contrast, `receiver` has already been evaluated down to a concrete
    `Page(id=...)` -- not a schema, a VALUE, carrying exactly the lookup
    key (`.id`) needed to fetch that row's real data. "Cannot know the
    schema" and "cannot know the value" are different problems; only the
    first is a genuine limitation.

    Every relation hop this resolution takes is METERED via `ctx.
    with_relation_hop()` (spec §7.3's depth-3 cap), consumed regardless of
    whether `related_properties` actually has an entry for `receiver.id`
    (a hop two levels deep, past what the caller pre-loaded, still costs
    budget on its way to an honest EMPTY -- never a silent free pass past
    the cap). When the budget is already exhausted, `with_relation_hop()`
    returns `None`, `ctx.depth_exceeded` flips true (shared across the
    whole evaluation, `EvalContext._hops_remaining`'s own docstring), and
    this returns `EMPTY` -- never raises; `recompute.py` turns
    `depth_exceeded` into the `{"type":"unsupported"}` sentinel once the
    whole pass finishes, exactly like the other two materialisation
    limits.

    For a receiver that evaluates to anything OTHER than a `Page`
    (typecheck.py places no such restriction on the receiver -- see its
    own docstring -- so this is reachable with valid, type-checked input,
    e.g. a `List`/`Number`/`String` receiver from a formula with no real
    relation in it at all): there is no related row to chase, so this
    keeps the OLD behaviour of resolving against `ctx.properties` -- THIS
    row's own values -- unchanged. That old behaviour was only ever wrong
    for the Page case (silently reading the wrong ROW); for a non-Page
    receiver there is no "other row" to have gotten wrong in the first
    place, so nothing here needed fixing, and changing it would only
    invent a new, undocumented meaning for a shape research never
    describes."""
    receiver = evaluate(receiver_node, ctx)
    name = _prop_name(args)
    if name is None:
        return EMPTY  # malformed prop() call, post-typecheck; never raise
    if not isinstance(receiver, Page):
        return ctx.properties.get(name, EMPTY)  # unchanged non-Page fallback, see docstring
    hopped = ctx.with_relation_hop()
    if hopped is None:
        return EMPTY  # budget exhausted; ctx.depth_exceeded is now set
    return ctx.related_properties.get(receiver.id, {}).get(name, EMPTY)


def _eval_context(args: list[A.Node], ctx: EvalContext) -> FValue:
    """`context("...")` (research §2.6): the automation-only analogue of
    `prop()`. Task 24's report (judgment call #6) already flags that
    Second Brain has no automations feature yet -- `CONTEXT_VARIABLES`
    exists in `typecheck.py` purely for language completeness. Carried
    forward here, decided (brief-uncovered, flagged in this task's
    report): `context(...)` always evaluates to `EMPTY` at runtime,
    regardless of whether the name is one of the documented context
    variables, because there is no automation subsystem in this codebase
    supplying a REAL value for any of them yet. This is a genuine,
    temporary limitation (not a research-documented behaviour) that a
    future automations feature will need to revisit -- it is not the same
    kind of decision as the UNRESOLVED-runtime-edge EMPTY ruling elsewhere
    in this module, and is called out separately in this task's report
    for that reason."""
    for a in args:
        evaluate(a, ctx)
    return EMPTY


# -- Task 26: now/today, bare id() -----------------------------------------


def _eval_now_today(name: str, ctx: EvalContext) -> FValue:
    """`now()`/`today()` (research §3.6) -- the first two real callers of
    `EvalContext.now` in this package (Task 25's report: "nothing inside
    this module reads ctx.now" was true until this task). Handled here,
    NOT through the ordinary `functions.REGISTRY`/`_invoke` dispatch every
    other builtin call in this module uses, because neither function can
    be a pure `list[FValue] -> FValue` -- both need `ctx.now`, the ONE
    instant `EvalContext` was built to capture once and thread through an
    entire evaluation pass (`make_now`'s own docstring). `REGISTRY` still
    carries an entry for both names (`functions/datetime.py`, via
    `functions.unreachable_via_evaluator`), but only to satisfy
    `check_registry_consistency()`'s now-unconditional assertion; it is
    unreachable through `evaluate()` -- every `Call`/`MethodCall` node
    named `now`/`today` is intercepted here first, in both
    `_eval_call` and `_eval_method_call`.

    UTC-only decision #2 of 3 (see `functions/datetime.py`'s module
    docstring for all three stated together): research documents `now()`
    as "the viewer's local time zone" -- this codebase has no per-user
    time zone concept, so both return UTC. `today()` truncates `ctx.now`
    to UTC midnight."""
    if name == "today":
        midnight = ctx.now.replace(hour=0, minute=0, second=0, microsecond=0)
        return Date(start=midnight)
    return Date(start=ctx.now)


def _eval_bare_id(ctx: EvalContext) -> FValue:
    """Bare `id()` (research §1.6/§3.8, official: "If no page is
    provided, returns the id of the page the formula is on") -- the one
    `id()` call shape needing `EvalContext` at all. The 1-arg
    `id(Page)`/`id(Person)` overload is a pure value read
    (`functions/page.py`'s ordinary `REGISTRY` entry), reached through the
    generic dispatch in `_eval_call`/`_eval_method_call` exactly like any
    other builtin -- only the 0-arg bare-`Call` shape comes here.
    `ctx.page_id is None` (every test in this task's golden table that
    isn't specifically about `id()`) -> `EMPTY`, never a fabricated id."""
    if ctx.page_id is None:
        return EMPTY
    return ctx.page_id.replace("-", "")  # research §1.6: ids render without dashes


# -- Task 26: current/index-scoped higher-order list functions -------------


def _eval_higher_order_call(name: str, arg_nodes: list[A.Node], ctx: EvalContext) -> FValue:
    """`map`/`filter`/`find`/`findIndex`/`some`/`every`/`sort`/`count`
    (research §2.12, §3.7) -- the ONE place in this module that needs an
    UNEVALUATED AST node (the trailing `current`/`index`-scoped
    expression) rather than an already-evaluated `FValue`. Every other
    builtin call in this file evaluates its arguments eagerly and hands
    plain values to `functions.REGISTRY` through `_invoke`; these eight
    cannot, because the whole point of a `current`-expression is that it
    is evaluated ONCE PER ELEMENT, against a scope that rebinds
    `current`/`index` fresh each time (Task 24's typecheck.py report,
    judgment call #7: `index` is bound in ALL eight, not just `map` --
    this evaluator inherits that already-committed ruling rather than
    re-deriving it). `functions.REGISTRY` therefore carries only
    unreachable, invariant-asserting stubs for these eight names
    (`functions/list_fns.py`, via `functions.unreachable_via_evaluator`)
    -- see `_eval_now_today`'s docstring above for the identical reasoning
    applied to `now`/`today`.

    **Corrects a real error in this task's own brief**, found by Task 23's
    implementer and reconfirmed here: there is NO lambda syntax in this
    language (research §2.12's own first sentence). `current`/`index` are
    ordinary `ast.Variable` nodes bound into a child `EvalContext.scope`
    via `with_binding` -- exactly like a `let` binding -- not a
    closure/lambda object; `ast.Lambda` is never constructed by the parser
    (Task 23's report) and is never consulted anywhere in this function.

    `sort`/`count`'s trailing expr is OPTIONAL (research §3.7's own
    signatures: `sort(List)` / `sort(List, expr)`, `count(List)` /
    `count(List, expr)`) -- `typecheck.FUNCTION_SIGNATURES` already
    encodes this split (`current_expr`: `"required"` for the other six vs.
    `"optional"` for these two). A required expr that's missing anyway
    (malformed post-typecheck input -- research §1.9: "a formula with
    errors can still be saved") is `EMPTY`, never a crash."""
    if not arg_nodes:
        return EMPTY  # malformed arity, post-typecheck; never raise
    lst = evaluate(arg_nodes[0], ctx)
    if lst is EMPTY:
        return EMPTY  # general propagation rule -- none of these 8 are in _EMPTY_AWARE
    if not isinstance(lst, list):
        return EMPTY  # malformed post-typecheck input (e.g. a bare Number)

    expr_node = arg_nodes[1] if len(arg_nodes) > 1 else None
    needs_expr = name not in ("sort", "count")
    if needs_expr and expr_node is None:
        return EMPTY

    def _child_ctx(element: FValue, index: int) -> EvalContext:
        # Rebinds `current`/`index` FRESH from THIS function's own `ctx`
        # parameter for every element -- which is precisely why a NESTED
        # higher-order call's inner `current` correctly shadows an outer
        # one (research §2.12's own "Nesting shadows" paragraph): the
        # inner call's `_eval_higher_order_call` invocation receives
        # whatever `ctx` the OUTER element-iteration already built (with
        # the outer `current` bound), and rebinding `current` again here
        # only affects `_child_ctx`'s own return value, never mutating the
        # outer `ctx` it was built from. This is also exactly why `lets`
        # is documented as the workaround for capturing an outer `current`
        # before it gets shadowed one level deeper: a `lets(outer,
        # current, ...)` binding, evaluated against the OUTER context
        # before the inner call rebinds `current`, is captured under a
        # name the inner rebinding never touches.
        return ctx.with_binding("current", element).with_binding("index", float(index))

    if name == "map":
        return [evaluate(expr_node, _child_ctx(el, i)) for i, el in enumerate(lst)]

    if name == "filter":
        return [
            el for i, el in enumerate(lst) if truthy(evaluate(expr_node, _child_ctx(el, i)))
        ]

    if name == "find":
        # research §1.4/§3.7, official: no match -> Empty.
        for i, el in enumerate(lst):
            if truthy(evaluate(expr_node, _child_ctx(el, i))):
                return el
        return EMPTY

    if name == "findIndex":
        # research §1.4/§3.7, official: no match -> -1 (NOT Empty) -- the
        # deliberate asymmetry with `find` immediately above, this task's
        # brief names it explicitly.
        for i, el in enumerate(lst):
            if truthy(evaluate(expr_node, _child_ctx(el, i))):
                return float(i)
        return -1.0

    if name == "some":
        return any(truthy(evaluate(expr_node, _child_ctx(el, i))) for i, el in enumerate(lst))

    if name == "every":
        # Vacuous truth for an empty list (`every([], ...) == true`) --
        # no research example either way; decided by the standard
        # mathematical convention ("every element of the empty set
        # satisfies any predicate"), flagged in this task's report as
        # brief-uncovered.
        return all(truthy(evaluate(expr_node, _child_ctx(el, i))) for i, el in enumerate(lst))

    if name == "count":
        if expr_node is None:
            return float(len(lst))
        return float(
            sum(1 for i, el in enumerate(lst) if truthy(evaluate(expr_node, _child_ctx(el, i))))
        )

    if name == "sort":
        return _eval_sort(lst, expr_node, ctx)

    raise FormulaEvalError(  # pragma: no cover
        f"evaluate(): unhandled higher-order list function {name!r}"
    )


_NATIVE_SORT_TAGS = frozenset({"bool", "number", "string", "date"})


def _sort_tag(v: FValue) -> str:
    if isinstance(v, bool):
        return "bool"
    if isinstance(v, float):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, Date):
        return "date"
    return "other"  # List / Person / Page / EMPTY -- always string-compared, see _eval_sort


def _native_sort_key(v: FValue, tag: str):
    if tag == "bool":
        return 1 if v else 0
    if tag == "date":
        return v.start
    return v  # number / string: compare directly


def _eval_sort(lst: list[FValue], expr_node: A.Node | None, ctx: EvalContext) -> FValue:
    """`sort(List)` / `sort(List, expr)` (research §3.7). Default ordering
    (no `expr`) is research's own documented rule, cited in this task's
    brief: *"String A->Z; Number ascending; Boolean false then true; Date
    earlier->later... Mixed-type lists are compared entirely as strings,
    but the returned elements keep their original types."*

    Extended here to the 2-arg form (brief-uncovered, flagged in this
    task's report): research calls `expr` a "sort key/comparator" without
    saying which, but this language has no way to bind TWO elements at
    once (only `current`/`index`, research §2.12) -- a JS-style
    two-argument comparator function is not even expressible, so `expr`
    MUST be a per-element KEY extractor (`current` bound to each element
    in turn, exactly like `map`'s own per-element evaluation), and the
    extracted KEYS are then ordered by the IDENTICAL default-ordering rule
    research documents for the no-`expr` form. The result contains the
    ORIGINAL elements in that order, not the keys.

    "Mixed-type... compared as strings" is implemented as: if every KEY
    shares one of the four natively-ordered tags (bool/number/string/
    date), compare natively; otherwise (more than one tag present, or any
    key of some OTHER tag) every key is compared by its `stringify()`.
    List/Person/Page keys are ALWAYS string-compared even in a
    single-type list of just that one kind -- research's default-ordering
    rule has no "native" ordering for those three at all ("nested List
    compared as a comma-joined string," "Page and Person compared as
    strings"), which `stringify()` already produces (comma-joined for
    List, per its own docstring; `.id` for Person/Page -- the one
    identity value this evaluator's wrappers carry, an honest proxy for
    "rendered title" that this evaluator's `Page`/`Person` have no field
    for at all, flagged in this task's report)."""
    if expr_node is not None:
        keys: list[FValue] = [
            evaluate(expr_node, ctx.with_binding("current", el).with_binding("index", float(i)))
            for i, el in enumerate(lst)
        ]
    else:
        keys = list(lst)

    tags = {_sort_tag(k) for k in keys}
    if len(tags) == 1 and next(iter(tags)) in _NATIVE_SORT_TAGS:
        tag = next(iter(tags))
        sort_keys: list = [_native_sort_key(k, tag) for k in keys]
    else:
        sort_keys = [stringify(k) for k in keys]

    order = sorted(range(len(lst)), key=lambda i: sort_keys[i])
    return [lst[i] for i in order]


def make_now() -> datetime:
    """Capture `now()` exactly once, in UTC, for a caller (Task 27's
    materialisation pass, or a `/db/formulas/validate`-adjacent evaluation
    endpoint) to build one `EvalContext` from and reuse across an entire
    evaluation pass -- brief, explicit: "captured once per evaluation pass
    and passed in... a recompute pass over 500 rows must not drift." Not
    itself called by anything inside this module (nothing in this task's
    four categories reads `ctx.now` -- `now()`/`today()` are Task 26), but
    declared here as the one sanctioned place a caller gets a fresh
    timestamp from, rather than every caller reaching for
    `datetime.now()` independently and by accident picking a naive
    (non-UTC) one."""
    return datetime.now(timezone.utc)
