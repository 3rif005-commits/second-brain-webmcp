"""Select, MultiSelect, Status: Milestone 5's richer descriptors for the
three option-list types (task-14-brief.md §2).

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §5.
Research: docs/research/notion-databases-research.md §F.1 item 7 (Status,
~line 701).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from .base import Operator, SqlContext, SqlFragment, _GenericProperty

# `SelectOption.id` is server-minted, same 8-char base62 scheme as property
# keys (services.db.keys.mint_key) -- reused by whichever future endpoint
# mints new options (this task doesn't add option-creation; see module
# docstring), not reimplemented here to avoid a second id scheme existing
# in the codebase even as dead code.

__all__ = [
    "SelectOption", "StatusOption",
    "SelectConfig", "MultiSelectConfig", "StatusConfig",
    "Select", "MultiSelect", "Status",
]


class SelectOption(BaseModel):
    model_config = ConfigDict(frozen=True)

    # Server-minted, same mint_key() 8-char base62 as property keys -- reuse
    # services.db.keys.mint_key, don't invent a second id scheme.
    id: str
    name: str
    color: str = "default"


class StatusOption(SelectOption):
    # Closed 3-group taxonomy (research §7), simplified from Notion's real
    # parallel options[]+groups[] schema (independent group colors/ids) --
    # not needed for a single-user app. Deliberate simplification, not a
    # spec-mandated shape.
    group: Literal["To-do", "In progress", "Complete"] = "To-do"


class SelectConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    options: list[SelectOption] = []


class MultiSelectConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    options: list[SelectOption] = []


class StatusConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    options: list[StatusOption] = []


_SELECT_OPS: tuple[Operator, ...] = (
    Operator(name="equals", arg_type="str_or_list"),
    Operator(name="does_not_equal", arg_type="str_or_list"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)

_MULTI_SELECT_OPS: tuple[Operator, ...] = (
    Operator(name="contains", arg_type="str_or_list"),
    Operator(name="does_not_contain", arg_type="str_or_list"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)


def _is_empty(value: Any) -> bool:
    return value is None or value == "" or value == [] or value == {}


# --- coerce_write's config-access problem --------------------------------
#
# The write-side validation the brief describes ("the written value must be
# one of options' ids") needs the *specific property's* configured option
# list. `PropertyType.coerce_write(self, raw: Any) -> Any` (base.py) takes
# no config parameter -- REGISTRY holds exactly one Select/MultiSelect/
# Status instance shared by every property of that type across every
# database, so there is no per-property state these methods could read
# instead. This is the same root limitation task-14-brief.md calls out for
# `Status.default()` (not adding a config parameter to the protocol is an
# explicit, out-of-scope-for-this-task decision), just not named for
# coerce_write in the brief's own text.
#
# Judgment call (documented in task-14-report.md): give `coerce_write` an
# *optional*, keyword-only `options` parameter. This does not change the
# `PropertyType` protocol -- a method that accepts every call the protocol's
# own `coerce_write(self, raw)` signature makes, plus an optional extra
# keyword, still satisfies it structurally (the existing generic protocol
# test in test_db_property_registry.py calls `prop.coerce_write(None)` with
# no second argument and must keep passing, which it does: `None` is valid
# regardless of `options`). A future write-path caller that *does* have the
# property's real config can pass `options=` explicitly; until then, "no
# options given" is treated as "no option is known valid" (any non-None
# raw is rejected) rather than "skip validation" -- silently accepting an
# unvalidated id is exactly what spec §8.2 rules out.
def _validate_single_option(raw: Any, options: tuple, *, type_label: str) -> Any:
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise ValueError(f"{type_label} value must be an option id (str) or None, got: {raw!r}")
    valid_ids = {opt.id for opt in options}
    if raw not in valid_ids:
        raise ValueError(f"unknown {type_label} option id: {raw!r}")
    return raw


@dataclass(frozen=True)
class Select:
    key: str = "select"
    config_model: type[BaseModel] = SelectConfig

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return _is_empty(value)

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_extract(ctx)

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_order(ctx, direction)

    def operators(self) -> dict[str, Operator]:
        return {op.name: op for op in _SELECT_OPS}

    def aggregations(self) -> set[str]:
        return {"count_all", "count_empty", "count_not_empty"}

    def coerce_write(self, raw: Any, *, options: tuple[SelectOption, ...] = ()) -> Any:
        return _validate_single_option(raw, options, type_label="select")


@dataclass(frozen=True)
class MultiSelect:
    key: str = "multi_select"
    config_model: type[BaseModel] = MultiSelectConfig

    def default(self) -> Any:
        return None

    def is_empty(self, value: Any) -> bool:
        return _is_empty(value)

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_extract(ctx)

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_order(ctx, direction)

    def operators(self) -> dict[str, Operator]:
        return {op.name: op for op in _MULTI_SELECT_OPS}

    def aggregations(self) -> set[str]:
        return {"count_all", "count_empty", "count_not_empty"}

    def coerce_write(self, raw: Any, *, options: tuple[SelectOption, ...] = ()) -> Any:
        if raw is None:
            return None
        if not isinstance(raw, list):
            raise ValueError(f"multi_select value must be a list of option ids, got: {raw!r}")
        if not raw:
            return raw  # empty list is valid: "no tags," not malformed.
        valid_ids = {opt.id for opt in options}
        unknown = [v for v in raw if v not in valid_ids]
        if unknown:
            raise ValueError(f"unknown multi_select option id(s): {unknown!r}")
        return raw


@dataclass(frozen=True)
class Status:
    key: str = "status"
    config_model: type[BaseModel] = StatusConfig

    def default(self) -> Any:
        # Spec intent (research §7): the id of a "Not started" option in
        # group "To-do", auto-created the first time an unconfigured status
        # property is used. Not implementable here: `default()` takes no
        # config parameter (`def default(self) -> Any` in base.py's
        # `PropertyType` protocol), and REGISTRY's single shared `Status`
        # instance has no access to any particular property's real option
        # list to invent a "Not started" id from. Unlike `coerce_write`
        # above, `default()` genuinely cannot take an optional extra
        # parameter and still be useful here -- the *caller* asking for a
        # default has no config to pass either (that's the whole scenario:
        # a property with no configured options yet). Adding a config
        # parameter to the protocol itself is explicitly out of scope
        # (task-14-brief.md) -- it's a shared, load-bearing interface all
        # 24 REGISTRY entries and M3/M4's code depend on. `None` is the
        # documented fallback this milestone ships.
        return None

    def is_empty(self, value: Any) -> bool:
        return _is_empty(value)

    def sql_extract(self, ctx: SqlContext) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_extract(ctx)

    def sql_order(self, ctx: SqlContext, direction: str) -> SqlFragment:
        return _GenericProperty(key=self.key).sql_order(ctx, direction)

    def operators(self) -> dict[str, Operator]:
        # operators.py: `_STATUS_OPS = _SELECT_OPS` -- identical family.
        return {op.name: op for op in _SELECT_OPS}

    def aggregations(self) -> set[str]:
        return {"count_all", "count_empty", "count_not_empty"}

    def coerce_write(self, raw: Any, *, options: tuple[StatusOption, ...] = ()) -> Any:
        # "Same coerce_write/unknown-option-id rejection as Select" (brief).
        return _validate_single_option(raw, options, type_label="status")
