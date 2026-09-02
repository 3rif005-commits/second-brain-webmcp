"""§H.3.8 Page / Person / relation (3 + traversal patterns): `id`, `name`,
`email`.

The "documented traversal patterns" research §3.8 also lists under this
section (`prop("Relation").first().prop("Created By")`,
`prop("Pioneers").map(name(current)).join(", ")`, ...) are **idioms built
from `prop`/list functions already implemented elsewhere, not separate
builtins** -- nothing to implement for them here. This task's golden-value
table (`test_formula_functions_list.py`) exercises several of research's
own pattern examples verbatim instead, since they are the real proof the
pieces compose correctly together.

**The relation/Milestone-7 seam.** Research §3.8, official: relation/
rollup/person properties yield **lists** -- `prop("Pioneers")` is a
`list[Person]`, `prop("Related Tasks")` is a `list[Page]`. This module's
functions are pure `list[FValue] -> FValue` reads with no opinion on WHERE
`ctx.properties["Pioneers"]` came from -- but whoever builds that mapping
for a real row MUST NOT read `db_row_props.properties` for a relation-typed
value. Migration 015's header (`supabase/migrations/015_relations.sql`)
states at length that `db_relation_links` is the single source of truth
("the JSONB is not the source of truth for relations"), and
`services/db/relations.py`'s `list_links_bulk` is the N+1-safe way to read
it for a batch of rows. Building `EvalContext.properties` for a real row is
a materialisation concern (Task 27's `db_row_props.computed`
recomputation), not this task's -- nothing in this task's four categories
calls `list_links_bulk` itself; this docstring exists so Task 27 finds the
seam documented at the one place someone extending this evaluator would
naturally look, per this task's brief.

**`id()` has a split implementation.** The 1-arg `id(Page)`/`id(Person)`
form is the plain value-read below; the 0-arg `id()` ("If no page is
provided, returns the id of the page the formula is on", research §1.6/
§3.8, official) needs `EvalContext.page_id`, which no `REGISTRY` function
can see -- `evaluator._eval_bare_id` intercepts that call shape before it
ever reaches this module (see its docstring). This module's `id` entry
therefore only ever actually runs for the 1-arg overload in practice; a
0-arg (or otherwise malformed) call landing here anyway returns `EMPTY`
rather than raising, as a defensive fallback, never as the real
implementation of the 0-arg case.
"""
from __future__ import annotations

from ..values import EMPTY, FValue, Page, Person
from . import builtin


@builtin("id")
def _id(args: list[FValue]) -> FValue:
    if len(args) != 1:
        return EMPTY  # see module docstring: the 0-arg case is evaluator._eval_bare_id's job
    (v,) = args
    if isinstance(v, (Page, Person)):
        return v.id.replace("-", "")  # research §1.6, [P2]: ids render without dashes
    return EMPTY


@builtin("name")
def _name(args: list[FValue]) -> FValue:
    """`name(Person) -> Text` (research §1.7/§3.8, official). Research
    §1.6, explicit: "There is no `.name()` on a Page" -- a `Page` argument
    is therefore just as much a type mismatch as a `String`/`Number`/etc.
    one, EMPTY either way, not a special case. `Person.name is None` (a
    `Person` built without a cached display name -- see `values.Person`'s
    own docstring) also yields EMPTY rather than raising."""
    (v,) = args
    if not isinstance(v, Person) or v.name is None:
        return EMPTY
    return v.name


@builtin("email")
def _email(args: list[FValue]) -> FValue:
    """`email(Person) -> Text` -- "returns plain text, not a link"
    (research §1.7, [P2])."""
    (v,) = args
    if not isinstance(v, Person) or v.email is None:
        return EMPTY
    return v.email
