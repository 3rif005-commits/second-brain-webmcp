"""The property-type x filter-operator matrix, value coercion, and
per-operator SQL generation.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §8.2.
Research: docs/research/notion-databases-research.md §F.1 ("Master operator
matrix", ~line 4104) for the per-type operator lists, §K.4.2 for the
ILIKE-escaping prior art, §1.5/§1.6 for status-group and relative-date
detail.

Three explicit decisions this module makes where research flags an
unresolved tension in Notion's own OpenAPI schema vs. prose (see
task-11-report.md for the full reasoning):
  - `unique_id` gets the full 8 numeric operators (schema is permissive).
  - `created_time`/`last_edited_time` get the full 14 date operators
    (identical to `date`), even though both are never actually empty.
  - `formula`/`rollup` (dispatch-by-result-type, Milestone 8) and
    `place`/`button` (not filterable) are absent from `TYPE_OPERATORS`
    entirely — "type not in TYPE_OPERATORS" is Task 12's signal to 400.
"""
from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from services.db.properties.base import Operator, SqlContext, SqlFragment, REGISTRY
from services.db.properties.columns import COLUMN_BACKED
from .ast import FilterValidationError

__all__ = [
    "TYPE_OPERATORS",
    "RESULT_TYPE_OPERATORS",
    "FilterValidationError",
    "coerce_value",
    "compile_condition",
]


# ---------------------------------------------------------------------------
# 2.1 Leaf operators and per-type allow-lists
# ---------------------------------------------------------------------------

_TEXT_OPS: tuple[Operator, ...] = (
    Operator(name="equals", arg_type="str"),
    Operator(name="does_not_equal", arg_type="str"),
    Operator(name="contains", arg_type="str"),
    Operator(name="does_not_contain", arg_type="str"),
    Operator(name="starts_with", arg_type="str"),
    Operator(name="ends_with", arg_type="str"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)

_NUMBER_OPS: tuple[Operator, ...] = (
    Operator(name="equals", arg_type="num"),
    Operator(name="does_not_equal", arg_type="num"),
    Operator(name="greater_than", arg_type="num"),
    Operator(name="less_than", arg_type="num"),
    Operator(name="greater_than_or_equal_to", arg_type="num"),
    Operator(name="less_than_or_equal_to", arg_type="num"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)

_CHECKBOX_OPS: tuple[Operator, ...] = (
    Operator(name="equals", arg_type="bool"),
    Operator(name="does_not_equal", arg_type="bool"),
)

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

_STATUS_OPS: tuple[Operator, ...] = _SELECT_OPS

_DATE_OPS: tuple[Operator, ...] = (
    Operator(name="equals", arg_type="date"),
    Operator(name="before", arg_type="date"),
    Operator(name="after", arg_type="date"),
    Operator(name="on_or_before", arg_type="date"),
    Operator(name="on_or_after", arg_type="date"),
    Operator(name="this_week", arg_type="none"),
    Operator(name="past_week", arg_type="none"),
    Operator(name="past_month", arg_type="none"),
    Operator(name="past_year", arg_type="none"),
    Operator(name="next_week", arg_type="none"),
    Operator(name="next_month", arg_type="none"),
    Operator(name="next_year", arg_type="none"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)

_PEOPLE_OPS: tuple[Operator, ...] = (
    Operator(name="contains", arg_type="uuid_or_me"),
    Operator(name="does_not_contain", arg_type="uuid_or_me"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)

_FILES_OPS: tuple[Operator, ...] = (
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)

_RELATION_OPS: tuple[Operator, ...] = (
    Operator(name="contains", arg_type="uuid"),
    Operator(name="does_not_contain", arg_type="uuid"),
    Operator(name="is_empty", arg_type="none"),
    Operator(name="is_not_empty", arg_type="none"),
)

_VERIFICATION_OPS: tuple[Operator, ...] = (
    Operator(name="status", arg_type="verification_status"),
)

# `equals`/`does_not_equal` are `"num"` on number/unique_id, `"str"` on the
# 5 text-shape types, `"str_or_list"` on select/status, `"bool"` on
# checkbox — arg_type depends on (type, operator), not operator alone, so
# each family keeps its own literal Operator tuple rather than one shared
# by name.
_FAMILIES: dict[tuple[str, ...], tuple[Operator, ...]] = {
    ("title", "rich_text", "url", "email", "phone_number"): _TEXT_OPS,
    ("number",): _NUMBER_OPS,
    ("unique_id",): _NUMBER_OPS,
    ("checkbox",): _CHECKBOX_OPS,
    ("select",): _SELECT_OPS,
    ("multi_select",): _MULTI_SELECT_OPS,
    ("status",): _STATUS_OPS,
    ("date", "created_time", "last_edited_time"): _DATE_OPS,
    ("people", "created_by", "last_edited_by"): _PEOPLE_OPS,
    ("files",): _FILES_OPS,
    ("relation",): _RELATION_OPS,
    ("verification",): _VERIFICATION_OPS,
}

TYPE_OPERATORS: dict[str, dict[str, Operator]] = {
    type_key: {op.name: op for op in ops}
    for type_keys, ops in _FAMILIES.items()
    for type_key in type_keys
}


# ---------------------------------------------------------------------------
# 2.1b Milestone 8 (Task 27): formula/rollup, dispatched by RESULT_TYPE
# ---------------------------------------------------------------------------
#
# `formula`/`rollup` deliberately do NOT become new keys in `TYPE_OPERATORS`
# above (`test_formula_rollup_place_button_excluded` still holds, unchanged,
# after this task) -- a flat `dict[str, Operator]` keyed by PROPERTY TYPE
# cannot represent an operator set that depends on `result_type`, a
# per-PROPERTY value (`db_properties.result_type`), because the SAME
# operator name (`equals`) needs a DIFFERENT `arg_type` depending on it
# ("num" for a number-typed formula, "str" for a string-typed one, ...) --
# a single dict entry can only ever hold one `Operator` per name. This is a
# genuinely different table, keyed by RESULT TYPE (an FType string) instead
# of property type, reusing the EXACT SAME `Operator` tuples every other
# family above already uses -- no new `arg_type`s invented, so a
# number-typed formula gets literally `_NUMBER_OPS`, not a lookalike copy.
#
# Research §4.6/§4.7 (quoted at length in `properties/computed.py`'s module
# docstring) is why exactly these four keys and no others: Notion's own
# formula API only ever surfaces `boolean`/`date`/`number`/`string` as a
# filterable/sortable result type -- List/Person/Page have no dedicated API
# result type and no documented filter object at all. `compile_condition`
# below raises `FilterValidationError` for any other `result_type`
# (including `None`, `"list"`, `"person"`, `"page"`, `"empty"`, `"unknown"`)
# -- the same "type not in operators table -> 400" signal every other
# unfilterable type in this module already gives, never a silent no-op.
RESULT_TYPE_OPERATORS: dict[str, dict[str, Operator]] = {
    "string": {op.name: op for op in _TEXT_OPS},
    "number": {op.name: op for op in _NUMBER_OPS},
    "boolean": {op.name: op for op in _CHECKBOX_OPS},
    "date": {op.name: op for op in _DATE_OPS},
}


# ---------------------------------------------------------------------------
# 2.2 Value coercion
# ---------------------------------------------------------------------------

_RELATIVE_DATE_KEYWORDS = {
    "today", "tomorrow", "yesterday", "one_week_ago", "one_week_from_now",
    "one_month_ago", "one_month_from_now",
}

_VERIFICATION_STATUSES = {"verified", "expired", "none"}


def _resolve_relative_date(keyword: str) -> datetime:
    now = datetime.now(UTC)
    # `date.today()` reads the system-local calendar date; on a non-UTC host
    # that can resolve "today"/"tomorrow"/"yesterday" to the wrong UTC day,
    # contradicting this module's own UTC-only contract (see `_date_scalar_sql`'s
    # `now()`-based window operators, which are always UTC). Derive the
    # calendar day from the UTC clock instead.
    today = datetime.combine(now.date(), datetime.min.time(), tzinfo=UTC)
    return {
        "today": today,
        "tomorrow": today + timedelta(days=1),
        "yesterday": today - timedelta(days=1),
        "one_week_ago": now - timedelta(days=7),
        "one_week_from_now": now + timedelta(days=7),
        "one_month_ago": now - timedelta(days=30),
        "one_month_from_now": now + timedelta(days=30),
    }[keyword]


def _coerce_date(raw_value: Any) -> datetime:
    if not isinstance(raw_value, str):
        raise FilterValidationError(f"date value must be a str, got {type(raw_value).__name__}")
    if raw_value in _RELATIVE_DATE_KEYWORDS:
        return _resolve_relative_date(raw_value)
    normalised = raw_value[:-1] + "+00:00" if raw_value.endswith("Z") else raw_value
    try:
        parsed = datetime.fromisoformat(normalised)
        # A bare date/datetime string with no offset (e.g. "2026-08-10")
        # parses naive; `_resolve_relative_date` always returns UTC-aware.
        # Both branches of this function must return the same kind of
        # datetime — asyncpg binds naive and aware datetimes differently
        # against a `timestamptz` column, and the SQL this module generates
        # always casts to `::timestamptz`. Default the naive case to UTC
        # rather than let it travel as a silently different type.
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)
    except ValueError as exc:
        raise FilterValidationError(
            f"date value must be ISO-8601 or one of {sorted(_RELATIVE_DATE_KEYWORDS)}, "
            f"got: {raw_value!r}"
        ) from exc


def coerce_value(arg_type: str, raw_value: Any) -> Any:
    """Validates `raw_value` against `arg_type` and returns the Python value ready to bind
    as a query parameter. Raises FilterValidationError on any mismatch — a wrong-shaped
    value must fail loudly (spec §8.2's whole point), never be silently coerced into
    something that changes the query's meaning."""
    if arg_type == "none":
        if raw_value is None or raw_value == {}:
            return None
        raise FilterValidationError(f"expected no value (None/{{}}), got: {raw_value!r}")

    if arg_type == "str":
        if isinstance(raw_value, bool) or not isinstance(raw_value, str):
            raise FilterValidationError(f"expected a str, got: {raw_value!r}")
        return raw_value

    if arg_type == "num":
        if isinstance(raw_value, bool) or not isinstance(raw_value, (int, float)):
            raise FilterValidationError(f"expected a number, got: {raw_value!r}")
        return raw_value

    if arg_type == "bool":
        if raw_value is not True and raw_value is not False:
            raise FilterValidationError(f"expected a bool, got: {raw_value!r}")
        return raw_value

    if arg_type == "str_or_list":
        if isinstance(raw_value, str) and not isinstance(raw_value, bool):
            return raw_value
        if isinstance(raw_value, list):
            if not raw_value:
                raise FilterValidationError("empty list is not a valid str_or_list value")
            for element in raw_value:
                if isinstance(element, bool) or not isinstance(element, str):
                    raise FilterValidationError(f"every list element must be a str, got: {element!r}")
            return raw_value
        raise FilterValidationError(f"expected a str or non-empty list[str], got: {raw_value!r}")

    if arg_type == "date":
        return _coerce_date(raw_value)

    if arg_type == "uuid":
        if not isinstance(raw_value, str):
            raise FilterValidationError(f"expected a str uuid, got: {raw_value!r}")
        try:
            uuid.UUID(raw_value)
        except ValueError as exc:
            raise FilterValidationError(f"expected a valid uuid, got: {raw_value!r}") from exc
        return raw_value

    if arg_type == "uuid_or_me":
        if not isinstance(raw_value, str):
            raise FilterValidationError(f"expected 'me' or a str uuid, got: {raw_value!r}")
        if raw_value == "me":
            return raw_value
        try:
            uuid.UUID(raw_value)
        except ValueError as exc:
            raise FilterValidationError(f"expected 'me' or a valid uuid, got: {raw_value!r}") from exc
        return raw_value

    if arg_type == "verification_status":
        if not isinstance(raw_value, str) or raw_value not in _VERIFICATION_STATUSES:
            raise FilterValidationError(
                f"expected one of {sorted(_VERIFICATION_STATUSES)}, got: {raw_value!r}"
            )
        return raw_value

    raise FilterValidationError(f"unknown arg_type: {arg_type!r}")


# ---------------------------------------------------------------------------
# 2.3 Per-operator SQL generation
# ---------------------------------------------------------------------------

def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


_TEXT_SHAPE_TYPES = {"title", "rich_text", "url", "email", "phone_number"}
# `created_by`/`last_edited_by` are single-valued (one person per row), and
# `properties/base.py`'s `_ARRAY_VALUED` deliberately does NOT include them
# (only `multi_select`/`people`/`files`/`relation` are real jsonb arrays) —
# their `sql_extract()` falls through to the plain scalar text shape
# (`->> 'created_by'`), same as `title`/`url`/etc. Routing them through the
# jsonb-array SQL family (`E ? $1`, `E = '[]'::jsonb`, ...) would emit SQL
# that fails at execution: Postgres has no `text ? unknown` or `text =
# jsonb` operator. `people` itself stays in the jsonb-array family below —
# it's the one genuinely multi-valued type in this operator family.
_TEXT_SHAPE_TYPES |= {"created_by", "last_edited_by"}
_NUMBER_SHAPE_TYPES = {"number", "unique_id"}
_CHOICE_SHAPE_TYPES = {"select", "status"}
_DATE_SHAPE_TYPES = {"date", "created_time", "last_edited_time"}
# "relation" is deliberately NOT here (Milestone 7): it has its own branch
# in compile_condition below (EXISTS/NOT EXISTS over db_relation_links),
# not a JSONB path -- see migration 015's header and services/db/
# relations.py. Leaving it in this set was the Milestone-1/3 placeholder
# bug this task exists to fix.
_JSONB_ARRAY_SHAPE_TYPES = {"multi_select", "people", "files"}

# Column-backed keys whose column is a native Postgres array (currently only
# `topics`) rather than JSONB — resolved from COLUMN_BACKED, not hardcoded,
# so a future native-array column doesn't need this module edited again.
_NATIVE_ARRAY_COLUMNS = frozenset(
    prop.column for prop in COLUMN_BACKED.values() if prop.native_array
)


def _is_native_array(prop_type: str, ctx: SqlContext) -> bool:
    return (
        prop_type == "multi_select"
        and ctx.storage == "column"
        and ctx.key in _NATIVE_ARRAY_COLUMNS
    )


def _text_scalar_sql(operator_name: str, e: str, value: Any) -> tuple[str, tuple[Any, ...]]:
    if operator_name == "equals":
        return f"{e} = $1", (value,)
    if operator_name == "does_not_equal":
        return f"({e} IS NULL OR {e} <> $1)", (value,)
    if operator_name == "contains":
        return f"{e} ILIKE '%' || $1 || '%' ESCAPE '\\'", (_escape_like(value),)
    if operator_name == "starts_with":
        return f"{e} ILIKE $1 || '%' ESCAPE '\\'", (_escape_like(value),)
    if operator_name == "ends_with":
        return f"{e} ILIKE '%' || $1 ESCAPE '\\'", (_escape_like(value),)
    if operator_name == "does_not_contain":
        return f"({e} IS NULL OR {e} NOT ILIKE '%' || $1 || '%' ESCAPE '\\')", (_escape_like(value),)
    if operator_name == "is_empty":
        return f"({e} IS NULL OR {e} = '')", ()
    if operator_name == "is_not_empty":
        return f"({e} IS NOT NULL AND {e} <> '')", ()
    raise AssertionError(f"unreachable: {operator_name!r} for text scalar")


def _number_scalar_sql(operator_name: str, e: str, value: Any) -> tuple[str, tuple[Any, ...]]:
    if operator_name == "equals":
        return f"{e} = $1", (value,)
    if operator_name == "does_not_equal":
        return f"({e} IS NULL OR {e} <> $1)", (value,)
    if operator_name == "greater_than":
        return f"{e} > $1", (value,)
    if operator_name == "less_than":
        return f"{e} < $1", (value,)
    if operator_name == "greater_than_or_equal_to":
        return f"{e} >= $1", (value,)
    if operator_name == "less_than_or_equal_to":
        return f"{e} <= $1", (value,)
    if operator_name == "is_empty":
        return f"{e} IS NULL", ()
    if operator_name == "is_not_empty":
        return f"{e} IS NOT NULL", ()
    raise AssertionError(f"unreachable: {operator_name!r} for number scalar")


def _bool_scalar_sql(operator_name: str, e: str, value: Any) -> tuple[str, tuple[Any, ...]]:
    if operator_name == "equals":
        return f"{e} = $1", (value,)
    if operator_name == "does_not_equal":
        return f"{e} <> $1", (value,)
    raise AssertionError(f"unreachable: {operator_name!r} for bool scalar")


def _choice_scalar_sql(operator_name: str, e: str, value: Any) -> tuple[str, tuple[Any, ...]]:
    is_list = isinstance(value, list)
    if operator_name == "equals":
        if is_list:
            return f"{e} = ANY($1::text[])", (value,)
        return f"{e} = $1", (value,)
    if operator_name == "does_not_equal":
        if is_list:
            return f"({e} IS NULL OR NOT ({e} = ANY($1::text[])))", (value,)
        return f"({e} IS NULL OR {e} <> $1)", (value,)
    if operator_name == "is_empty":
        return f"({e} IS NULL OR {e} = '')", ()
    if operator_name == "is_not_empty":
        return f"({e} IS NOT NULL AND {e} <> '')", ()
    raise AssertionError(f"unreachable: {operator_name!r} for choice scalar")


def _guarded_date_expr(ctx: SqlContext, e: str) -> str:
    if ctx.storage == "column":
        return f"{e}::timestamptz"
    # jsonb/text storage: a malformed legacy string must not fail the whole
    # query — same hazard, same guard shape as `properties/base.py`'s
    # numeric cast (see "guarded numeric cast" in this task's report).
    return f"(CASE WHEN {e} ~ '^\\d{{4}}-\\d{{2}}-\\d{{2}}' THEN ({e})::timestamptz ELSE NULL END)"


def _date_scalar_sql(
    operator_name: str, ctx: SqlContext, e: str, value: Any
) -> tuple[str, tuple[Any, ...]]:
    d = _guarded_date_expr(ctx, e)
    if operator_name == "equals":
        return f"{d} = $1", (value,)
    if operator_name == "before":
        return f"{d} < $1", (value,)
    if operator_name == "after":
        return f"{d} > $1", (value,)
    if operator_name == "on_or_before":
        return f"{d} <= $1", (value,)
    if operator_name == "on_or_after":
        return f"{d} >= $1", (value,)
    # These 7 each emit a two-clause `A AND B` — every other multi-clause
    # fragment in this module self-parenthesizes (see does_not_equal,
    # is_empty/is_not_empty patterns above); these must too. compile_condition's
    # contract with Task 12 is that a returned fragment is atomic — an
    # unparenthesized `A AND B` spliced into a sibling `... OR <fragment>`
    # silently mis-binds (AND before OR: SQL precedence, not a syntax error),
    # producing wrong rows with no exception anywhere.
    if operator_name == "this_week":
        return (
            f"({d} >= date_trunc('week', now()) AND "
            f"{d} < date_trunc('week', now()) + interval '7 days')",
            (),
        )
    if operator_name == "past_week":
        return f"({d} >= now() - interval '7 days' AND {d} <= now())", ()
    if operator_name == "next_week":
        return f"({d} >= now() AND {d} <= now() + interval '7 days')", ()
    if operator_name == "past_month":
        return f"({d} >= now() - interval '1 month' AND {d} <= now())", ()
    if operator_name == "next_month":
        return f"({d} >= now() AND {d} <= now() + interval '1 month')", ()
    if operator_name == "past_year":
        return f"({d} >= now() - interval '1 year' AND {d} <= now())", ()
    if operator_name == "next_year":
        return f"({d} >= now() AND {d} <= now() + interval '1 year')", ()
    if operator_name == "is_empty":
        return f"{d} IS NULL", ()
    if operator_name == "is_not_empty":
        return f"{d} IS NOT NULL", ()
    raise AssertionError(f"unreachable: {operator_name!r} for date scalar")


def _jsonb_array_sql(operator_name: str, e: str, value: Any) -> tuple[str, tuple[Any, ...]]:
    is_list = isinstance(value, list)
    if operator_name == "contains":
        if is_list:
            return f"{e} ?| $1::text[]", (value,)
        return f"{e} ? $1", (value,)
    if operator_name == "does_not_contain":
        if is_list:
            return f"({e} IS NULL OR NOT ({e} ?| $1::text[]))", (value,)
        return f"({e} IS NULL OR NOT ({e} ? $1))", (value,)
    if operator_name == "is_empty":
        return f"({e} IS NULL OR {e} = '[]'::jsonb)", ()
    if operator_name == "is_not_empty":
        return f"({e} IS NOT NULL AND {e} <> '[]'::jsonb)", ()
    raise AssertionError(f"unreachable: {operator_name!r} for jsonb array")


def _native_array_sql(operator_name: str, e: str, value: Any) -> tuple[str, tuple[Any, ...]]:
    is_list = isinstance(value, list)
    if operator_name == "contains":
        if is_list:
            return f"{e} && $1::text[]", (value,)
        return f"$1 = ANY({e})", (value,)
    if operator_name == "does_not_contain":
        if is_list:
            return f"({e} IS NULL OR NOT ({e} && $1::text[]))", (value,)
        return f"({e} IS NULL OR NOT ($1 = ANY({e})))", (value,)
    if operator_name == "is_empty":
        return f"({e} IS NULL OR cardinality({e}) = 0)", ()
    if operator_name == "is_not_empty":
        return f"({e} IS NOT NULL AND cardinality({e}) > 0)", ()
    raise AssertionError(f"unreachable: {operator_name!r} for native array")


# The only two real db_relation_links column names RelationRef.own_column/
# other_column can ever produce (see services/db/relations.py). Checked
# before interpolation below via `raise`, not `assert` -- `assert` is
# stripped under `python -O`, and this codebase's standard for a
# correctness guard on interpolated SQL identity is `raise`, the same
# style `_column_reference` in properties/base.py uses for its
# allow-listed column names (and `properties/relation.py`'s `sql_order`
# for this identical check on this identical value). Even though they're
# structurally safe by construction, a bound param is fine here (a real
# B-tree index, not the expression-index literal-key requirement
# SqlFragment's docstring warns about), so relation_id/user_id/value all
# travel as $N, never interpolated.
_RELATION_LINK_COLUMNS = ("from_row_id", "to_row_id")


def _relation_filter_sql(
    operator_name: str, ctx: SqlContext, value: Any, *, user_id: str
) -> tuple[str, tuple[Any, ...]]:
    """Milestone 7: a relation filter compiles to an EXISTS/NOT EXISTS
    subquery over `db_relation_links`, never a JSONB array op -- migration
    015's header is explicit that the JSONB is not the source of truth for
    relations. `ctx.relation is None` means the property's config carries
    no usable relation_id/side (malformed or pre-015) -- a 400, never a
    crash and never a silent JSONB fallback."""
    if ctx.relation is None:
        raise FilterValidationError("relation property is not configured")
    own, other = ctx.relation.own_column, ctx.relation.other_column
    if own not in _RELATION_LINK_COLUMNS or other not in _RELATION_LINK_COLUMNS:
        raise ValueError(f"invalid relation link column: {(own, other)!r}")
    row_id_expr = ctx.row_id_expr

    exists = (
        f"EXISTS (SELECT 1 FROM db_relation_links rl "
        f"WHERE rl.relation_id = $1::uuid AND rl.user_id = $2::uuid "
        f"AND rl.{own} = {row_id_expr}"
    )
    if operator_name in ("contains", "does_not_contain"):
        clause = f"{exists} AND rl.{other} = $3::uuid)"
        params: tuple[Any, ...] = (ctx.relation.relation_id, user_id, value)
    elif operator_name in ("is_empty", "is_not_empty"):
        clause = f"{exists})"
        params = (ctx.relation.relation_id, user_id)
    else:
        raise AssertionError(f"unreachable: {operator_name!r} for relation")

    # does_not_contain/is_empty both negate with a bare `NOT EXISTS`, which
    # is already NULL-safe by construction (unlike the text family's
    # `IS NULL OR ...` dance) -- a row with zero links for this relation_id
    # simply has no matching EXISTS row, no NULL comparison involved. Do
    # not "fix" this into an IS NULL OR form; there is nothing to guard.
    if operator_name in ("does_not_contain", "is_empty"):
        clause = f"NOT {clause}"
    return clause, params


def compile_condition(
    prop_type: str,
    ctx: SqlContext,
    operator_name: str,
    raw_value: Any,
    *,
    user_id: str,
) -> SqlFragment:
    """The single entrypoint Task 12's compiler calls per leaf condition.
    1. `prop_type` must be a key in TYPE_OPERATORS and `operator_name` must be one of its
       operators — else FilterValidationError (Task 12 turns this into HTTP 400; this is
       spec §8.2 layer 3, "the operator is allow-listed against the resolved property's
       type descriptor").
    2. Coerce `raw_value` via `coerce_value(operator.arg_type, raw_value)`.
    3. Resolve the value-expression via `REGISTRY[prop_type].sql_extract(ctx)` — reuse it,
       never re-derive the JSONB hop.
    4. Emit a parameterised SqlFragment. `sql` numbers its own params from $1 relative to
       `params` — same convention as `SqlFragment` itself; Task 12's compiler renumbers.
    """
    if prop_type in ("formula", "rollup"):
        # Milestone 8 (Task 27): dispatch by RESULT_TYPE, not by
        # prop_type -- see RESULT_TYPE_OPERATORS's own module-level
        # comment for why a flat TYPE_OPERATORS entry can't express this.
        type_ops = RESULT_TYPE_OPERATORS.get(ctx.result_type)
        if type_ops is None:
            raise FilterValidationError(
                f"{prop_type!r} property with result_type={ctx.result_type!r} has no "
                "filterable operators -- only string/number/boolean/date results are "
                "filterable (research §4.6/§4.7)"
            )
    else:
        type_ops = TYPE_OPERATORS.get(prop_type)
        if type_ops is None:
            raise FilterValidationError(f"{prop_type!r} has no filterable operators")
    operator = type_ops.get(operator_name)
    if operator is None:
        raise FilterValidationError(
            f"{operator_name!r} is not a valid operator for {prop_type!r}"
        )

    value = coerce_value(operator.arg_type, raw_value)

    # "me" resolves to the bound user_id parameter — never the literal
    # string "me" — before it ever reaches SQL generation. No list case:
    # coerce_value("uuid_or_me", ...) only ever returns a scalar str.
    if operator.arg_type == "uuid_or_me" and value == "me":
        value = user_id

    # Milestone 7: relation has its own branch, ahead of the generic
    # `sql_extract()` call below -- there is no JSONB expression to extract
    # (REGISTRY["relation"].sql_extract raises if reached; see
    # properties/relation.py), and this branch alone needs `user_id` bound
    # into its EXISTS subquery, which the (ctx, operator, value)-only shape
    # every other family uses below has no room for.
    if prop_type == "relation":
        sql, params = _relation_filter_sql(operator_name, ctx, value, user_id=user_id)
        return SqlFragment(sql=sql, params=params)

    if prop_type in ("formula", "rollup"):
        # Milestone 8 (Task 27): reuse the EXACT SAME per-shape SQL
        # builders every other family above uses -- dispatched on
        # `ctx.result_type` instead of `prop_type`, since that's what
        # actually determines the value's shape for a materialised
        # formula/rollup (the top validation above already guarantees
        # `ctx.result_type` is one of these four, or this branch would
        # never have been reached). `properties/computed.py`'s
        # `Formula`/`Rollup.sql_extract` reads `computed`, not
        # `properties` -- the only difference from every other type's
        # extraction hop, and it is entirely inside `sql_extract` itself,
        # invisible here.
        e = REGISTRY[prop_type].sql_extract(ctx).sql
        if ctx.result_type == "string":
            sql, params = _text_scalar_sql(operator_name, e, value)
        elif ctx.result_type == "number":
            sql, params = _number_scalar_sql(operator_name, e, value)
        elif ctx.result_type == "boolean":
            sql, params = _bool_scalar_sql(operator_name, e, value)
        elif ctx.result_type == "date":
            sql, params = _date_scalar_sql(operator_name, ctx, e, value)
        else:
            raise AssertionError(  # pragma: no cover -- RESULT_TYPE_OPERATORS gate above
                f"unreachable: result_type {ctx.result_type!r} passed the operator gate"
            )
        return SqlFragment(sql=sql, params=params)

    e = REGISTRY[prop_type].sql_extract(ctx).sql

    if prop_type in _TEXT_SHAPE_TYPES:
        sql, params = _text_scalar_sql(operator_name, e, value)
    elif prop_type in _NUMBER_SHAPE_TYPES:
        sql, params = _number_scalar_sql(operator_name, e, value)
    elif prop_type == "checkbox":
        sql, params = _bool_scalar_sql(operator_name, e, value)
    elif prop_type in _CHOICE_SHAPE_TYPES:
        sql, params = _choice_scalar_sql(operator_name, e, value)
    elif prop_type in _DATE_SHAPE_TYPES:
        sql, params = _date_scalar_sql(operator_name, ctx, e, value)
    elif prop_type == "verification":
        sql, params = f"{e} = $1", (value,)
    elif _is_native_array(prop_type, ctx):
        sql, params = _native_array_sql(operator_name, e, value)
    elif prop_type in _JSONB_ARRAY_SHAPE_TYPES:
        sql, params = _jsonb_array_sql(operator_name, e, value)
    else:
        raise AssertionError(f"unreachable: no SQL-generation family for {prop_type!r}")

    return SqlFragment(sql=sql, params=params)
