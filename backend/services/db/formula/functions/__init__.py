"""The builtin function registry: one decorator-based table so a formula
function's signature (Task 24's `typecheck.FUNCTION_SIGNATURES`, imported
here and never re-declared), its implementation, and its golden tests all
key off the same string name.

Task 25 brief §1: "Add a startup-time consistency assertion... every name
in Task 24's signature table has an implementation, and every
implementation has a signature." That assertion is `check_registry_
consistency()` below -- run once at import time (module-level, so
importing this package at all is enough to catch drift) AND callable
directly by a test (`test_formula_functions_core.py`), per the brief's
explicit "a module-level check, and a test that calls it."

Task 25 introduced `_PENDING_CATEGORIES`, an explicit hatch listing every
function name belonging to a category it didn't implement (date/time
§3.6, list §3.7, page/person §3.8), so the consistency check could assert
"every OTHER name is implemented" without failing on categories that
didn't exist yet. **Task 26 deletes it** (its own brief, explicit: "part
of this task's definition of done") -- every one of Task 24's 93
`FUNCTION_SIGNATURES` names now has a `REGISTRY` entry, and the assertion
below is unconditional.
"""
from __future__ import annotations

from typing import Callable

from ..typecheck import FUNCTION_SIGNATURES
from ..values import FValue

__all__ = ["builtin", "REGISTRY", "check_registry_consistency", "unreachable_via_evaluator"]

BuiltinFn = Callable[[list[FValue]], FValue]

REGISTRY: dict[str, BuiltinFn] = {}


def builtin(name: str) -> Callable[[BuiltinFn], BuiltinFn]:
    """`@builtin("abs")` registers the decorated function under that name.
    Raises at import time (not silently overwrites) if a name is
    registered twice -- two implementations for one name is exactly the
    kind of divergence this registry exists to make impossible."""

    def _register(fn: BuiltinFn) -> BuiltinFn:
        if name in REGISTRY:
            raise RuntimeError(
                f"formula builtin {name!r} registered twice "
                f"(already implemented by {REGISTRY[name]!r})"
            )
        REGISTRY[name] = fn
        return fn

    return _register


def unreachable_via_evaluator(name: str) -> BuiltinFn:
    """A `REGISTRY` stub for a builtin whose REAL implementation needs
    something a plain `list[FValue] -> FValue` function structurally
    cannot access: `EvalContext` itself (`now`/`today` need `ctx.now`), or
    an UNEVALUATED AST node (the 8 `current`/`index`-scoped higher-order
    list functions -- `map`/`filter`/`find`/`findIndex`/`some`/`every`/
    `sort`/`count` -- need the raw expr node plus `ctx`, to evaluate it
    once per element against a freshly rebound scope). `evaluator.py`'s
    `_eval_call`/`_eval_method_call` intercept all 9 of these names BEFORE
    `_invoke`/`REGISTRY` is ever consulted for them (see `evaluator.
    _eval_now_today` and `evaluator._eval_higher_order_call`'s
    docstrings for the full reasoning) -- this function exists only so
    `check_registry_consistency()`'s now-unconditional assertion (Task 26
    deletes `_PENDING_CATEGORIES`) has a `REGISTRY` entry to find for
    every one of Task 24's 93 names, including these 9.

    Raises, rather than returning `EMPTY`, if ever actually invoked --
    deliberately NOT this package's usual "never raise on malformed
    formula input" ruling. Reaching this stub would mean `evaluator.py`'s
    interception broke: a real bug in THIS package's own dispatch code,
    not a runtime edge case in someone's formula, and the brief-wide
    EMPTY-for-UNRESOLVED-edges ruling was never about hiding this
    package's own defects from itself."""

    def _stub(args: list[FValue]) -> FValue:
        raise RuntimeError(
            f"formula builtin {name!r} has no direct REGISTRY implementation "
            "-- it is dispatched exclusively by evaluator.py before reaching "
            "REGISTRY (see functions.unreachable_via_evaluator's docstring); "
            "reaching this stub means evaluator.py's interception broke"
        )

    return _stub


def check_registry_consistency() -> None:
    """Every name in `FUNCTION_SIGNATURES` has a `REGISTRY` implementation
    (`unreachable_via_evaluator`'s stubs count -- they ARE registry
    entries, just ones that raise instead of computing a real value);
    every implemented name has a signature (nothing in `REGISTRY` that
    isn't also in `FUNCTION_SIGNATURES` -- that would mean a builtin
    nothing can ever type-check, i.e. dead or misspelled code). Raises
    `AssertionError` with the exact offending names, not just "mismatch",
    so a failure is immediately actionable."""
    signature_names = set(FUNCTION_SIGNATURES)
    implemented_names = set(REGISTRY)

    missing = signature_names - implemented_names
    assert not missing, (
        f"formula functions with a signature but no evaluator implementation: "
        f"{sorted(missing)}"
    )

    orphaned = implemented_names - signature_names
    assert not orphaned, (
        f"formula builtins implemented with no entry in FUNCTION_SIGNATURES "
        f"(typo, or Task 24's table needs updating): {sorted(orphaned)}"
    )


# Import for side effect: each submodule's `@builtin(...)`-decorated
# functions register themselves into REGISTRY on import. Order does not
# matter (each module is independent; none imports another) -- EXCEPT that
# `list_fns.py` imports `functions.logic._strict_eq` (see its own
# docstring for why that one cross-category import is warranted), which is
# a same-package sibling import, not an ordering dependency on THIS file.
from . import datetime, list_fns, logic, numeric, page, regex, string  # noqa: E402,F401

# Startup-time assertion (brief §1). Runs once, the first time anything
# imports this package -- e.g. `evaluator.py`, or a test importing
# `functions` directly. A category-count or name-drift bug therefore fails
# at import time, not only when a specific formula happens to exercise the
# missing name.
check_registry_consistency()
