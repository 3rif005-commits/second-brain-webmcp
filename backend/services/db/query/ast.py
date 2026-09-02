"""The filter AST, plus the sort and pagination request shapes.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §8.1.

This module is pure, DB-free Python: it validates the *shape* of a filter
request and nothing more. `operators.py` owns the per-(type, operator)
allow-list and SQL generation; Task 12's compiler is the only thing that
ever imports both and turns a `FilterNode` into SQL.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field, TypeAdapter, ValidationError


class FilterCondition(BaseModel):
    type: Literal["condition"]
    property: str
    operator: str
    value: Any = None


class FilterGroup(BaseModel):
    type: Literal["group"]
    op: Literal["and", "or"]
    children: list["FilterNode"] = Field(min_length=1)  # empty group: malformed request


FilterNode = Annotated[Union[FilterCondition, FilterGroup], Field(discriminator="type")]

# Forward ref (`FilterGroup.children: list["FilterNode"]`) resolves only once
# `FilterNode` itself is defined below the class — Pydantic v2 needs an
# explicit rebuild to pick it up.
FilterGroup.model_rebuild()

_FilterNodeAdapter = TypeAdapter(FilterNode)

# Spec §8.1: "we impose no limit beyond a sanity cap of 10 to bound
# recursion." A *group* at depth 10 containing another group is the
# violation: 10 nested levels of groups are allowed, an 11th is not.
MAX_FILTER_DEPTH = 10


class FilterValidationError(ValueError):
    """Raised by ast.py/operators.py for any filter-shape problem the caller (Task 12's
    compiler) must turn into HTTP 400. Never raises HTTPException here — this module has
    no FastAPI dependency, matching properties/base.py's own framework-agnostic style."""


def _check_depth(node: FilterNode, depth: int) -> None:
    if isinstance(node, FilterGroup):
        if depth > MAX_FILTER_DEPTH:
            raise FilterValidationError(
                f"filter nesting exceeds MAX_FILTER_DEPTH={MAX_FILTER_DEPTH}"
            )
        for child in node.children:
            _check_depth(child, depth + 1)


def parse_filter(raw: dict | None) -> FilterNode | None:
    """`None`/absent -> `None` (no filter — matches every row). Otherwise: `FilterNode.
    validate(raw)` (via a `TypeAdapter`), then walk the tree and raise
    `FilterValidationError` if any group's nesting exceeds MAX_FILTER_DEPTH, or if a
    Pydantic `ValidationError` occurred (wrap it — callers should only ever have to catch
    `FilterValidationError` from this module)."""
    if raw is None:
        return None
    try:
        node = _FilterNodeAdapter.validate_python(raw)
    except ValidationError as exc:
        raise FilterValidationError(str(exc)) from exc
    _check_depth(node, depth=1)
    return node


class SortSpec(BaseModel):
    property: str
    direction: Literal["asc", "desc"] = "asc"


class Pagination(BaseModel):
    # This task's own decided defaults (no page-size decision exists
    # elsewhere in the plan or spec) — same documentation convention as
    # `_ROWS_LIMIT = 500` in `routers/databases.py`.
    page_size: int = Field(default=50, ge=1, le=200)
    offset: int = Field(default=0, ge=0)
