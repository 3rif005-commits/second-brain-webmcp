"""The formula language's type system: the seven value types plus the two
non-value markers the type checker needs internally, the property-type ->
formula-type mapping, and `unify()`.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.2.
Research: docs/research/notion-databases-research.md §H.1 (type system),
§H.1.2 (property-type mapping), §H.1.8 (coercion -- `unify()` is what
enforces the documented branch-unification rule).
Brief: .superpowers/sdd/2026-08-08-notion-databases/task-24-brief.md §1.

This module holds no checking logic (see `typecheck.py`) and no dependency
logic (see `deps.py`) -- just the type vocabulary both are built on.
"""
from __future__ import annotations

from enum import StrEnum


class FType(StrEnum):
    """The seven value types (research §H.1.1 -- "Notion formulas have
    **seven** value types," stated explicitly and cross-checked against
    every type name that appears in the official property->formula-type
    table). This count is deliberate: if a spec or plan document elsewhere
    says eight, the research wins and the discrepancy is flagged (brief
    §1) -- no such discrepancy was found while implementing this module.

    Plus two non-value markers the checker needs internally, appended
    after the seven so `list(FType)[:7]` is exactly the value types if a
    future caller ever needs that slice:

    - `EMPTY` -- the type of `empty()` with no arguments. The polymorphic
      *bottom*: it unifies with everything. Research §1.4/§1.8: `empty()`
      exists precisely so `if(Date, Date.dateAdd(1,"day"), empty())`
      type-checks when `if(Date, Date.dateAdd(1,"day"), "")` (a real
      Date/Text mismatch) does not (§1.8's official example, pinned by a
      test in test_formula_typecheck.py).
    - `UNKNOWN` -- an unresolved property/context reference, an
      already-reported error's result, or (research §1.5's own
      `UNRESOLVED:`) an element read out of a `List` -- lists are
      unparameterised (see below), so indexing/iterating one can only
      ever yield UNKNOWN. Also unifies with everything, for the same
      "don't cascade one mistake into ten error messages" reason the
      brief states outright.

    Neither `EMPTY` nor `UNKNOWN` is ever the type of a *literal* -- there
    is no null literal in this language (research §1.4; see
    `ast.Literal`'s own docstring) and no expression syntactically
    produces `UNKNOWN` on purpose. Both exist only as things the checker
    computes.
    """

    STRING = "string"
    NUMBER = "number"
    BOOLEAN = "boolean"
    DATE = "date"
    LIST = "list"
    PERSON = "person"
    PAGE = "page"
    EMPTY = "empty"
    UNKNOWN = "unknown"


# `LIST` is deliberately **not** parameterised by element type (no
# `List[Number]`). Research §1.5 is explicit that lists are heterogeneous --
# `["Apples", 1, true, now()]` is a documented-legal literal -- so a
# parameterised list type would reject formulas Notion itself accepts. This
# looks like an omission (a "real" type system would want element types for
# `map`/`filter`/etc. to check their bodies against) and it is not one:
# research §1.5's own `UNRESOLVED:` note asks exactly this question ("does
# the type checker track a parameterised element type, or treat all lists as
# `List<Any>`") and finds no documentation either way. This implementation
# takes the conservative, honest reading -- `List<Any>` -- rather than
# inventing element-type tracking with no source to check it against. The
# concrete consequence, spelled out in `typecheck.py`: `current` (the
# implicit per-element variable bound inside `map`/`filter`/etc.) is typed
# `UNKNOWN`, not the list's element type, because there is no element type to
# give it.
#
# The property-type -> formula-type mapping (research §1.2, verbatim from the
# official reference), covering all 24 REGISTRY keys (services/db/properties/
# base.py's `_REAL_TYPE_KEYS`) so a property type gaining a formula meaning
# later is a one-line change here, not a new branch somewhere.
#
# `formula` and `rollup` map to UNKNOWN, not to some inferred type. This is a
# deliberate, brief-uncovered decision (flagged in this task's report): a
# formula referencing *another* formula or rollup property's value cannot
# have its type resolved by this dict alone, because that would require
# resolving the *referenced* property's own formula expression first --
# exactly the cross-property, dependency-ordered type inference `deps.py`'s
# topological sort exists to sequence, and which belongs to a materialisation
# pass (Task 27), not to `check()`'s single-tree, single-property contract.
# UNKNOWN is the correct type here on its own terms too: it is defined above
# as covering exactly "an unresolved property reference," and a
# formula/rollup property, from the point of view of a checker that only
# looks at one tree at a time, is unresolved by construction.
#
# `place`, `verification`, and `button` map to UNKNOWN because research never
# documents a formula-visible value for them at all -- they are the "types
# with no formula representation" the brief's §1 anticipates, not omissions.
PROPERTY_TYPE_TO_FTYPE: dict[str, FType] = {
    "title": FType.STRING,
    "rich_text": FType.STRING,
    "number": FType.NUMBER,
    "select": FType.STRING,
    "multi_select": FType.LIST,  # "Text (list)" -- research §1.2
    "status": FType.STRING,  # "returns a string even if displayed as a Checkbox" [P2]
    "date": FType.DATE,
    "people": FType.LIST,  # "Person (list)" -- LIST is unparameterised, see above
    "files": FType.LIST,  # "List of Text (URLs)" [P2]
    "checkbox": FType.BOOLEAN,
    "url": FType.STRING,
    "email": FType.STRING,
    "phone_number": FType.STRING,
    "formula": FType.UNKNOWN,  # see module comment above
    "relation": FType.LIST,  # "Page (list)" -- research §1.2
    "rollup": FType.UNKNOWN,  # see module comment above ("depends on rollup configuration")
    "created_time": FType.DATE,
    "created_by": FType.PERSON,  # single, not a list -- research §1.2
    "last_edited_time": FType.DATE,
    "last_edited_by": FType.PERSON,
    "unique_id": FType.STRING,
    "place": FType.UNKNOWN,  # no formula representation documented
    "verification": FType.UNKNOWN,  # no formula representation documented
    "button": FType.UNKNOWN,  # no formula representation documented
}


def unify(a: FType, b: FType) -> FType | None:
    """The common type of `a` and `b`, or `None` if they are incompatible.

    `EMPTY` and `UNKNOWN` unify with anything, returning the *other* type
    (research §1.8's polymorphic-bottom rule for `empty()`, extended to
    `UNKNOWN` for the same non-cascading reason -- see `FType`'s
    docstring). Every other pair unifies only with itself.

    This one function is the entire enforcement mechanism behind research
    §1.8's documented rule that `if(Date, Date.dateAdd(1,"day"), "")` is a
    type error ("could either be date or text") while
    `if(Date, Date.dateAdd(1,"day"), empty())` is not -- `typecheck.py`'s
    `if`/`ifs`/ternary handling calls this and nothing else to decide.
    """
    if a is FType.EMPTY or a is FType.UNKNOWN:
        return b
    if b is FType.EMPTY or b is FType.UNKNOWN:
        return a
    if a == b:
        return a
    return None
