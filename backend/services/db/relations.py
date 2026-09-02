"""Relation service layer: the two-way link store (`db_relation_links`),
relation-pair creation, cycle/depth guards for the two hierarchical system
relations (sub-items, dependencies), and dependency date-shift cascading.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §9.
Migration: supabase/migrations/015_relations.sql — its header is the design
document for this module; every function below implements one piece of it.
Research: docs/research/notion-databases-research.md §3 (sub-items), §4
(dependencies).

Pure service layer over asyncpg, no FastAPI imports — mirrors
`services/db/views.py`'s shape (module-level async functions taking `conn`
first, not a class). Task 21 maps the errors raised here to HTTP 400s at the
router seam, the same way `query/compiler.py`'s
`filter_validation_error_to_http` does for the filter compiler.

THE ONE IDEA (migration 015's header, restated for this module): a link is
stored ONCE, keyed by the relation PAIR (`relation_id`). `db_row_props.
properties -> '<relation key>'` is never written and never read as a link
list here — `db_relation_links` is the only source of truth. Every read/
write below goes through `RelationRef.own_column`/`other_column`, so
"linking from either side produces exactly one row" is structural, not a
rule call sites have to remember.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import asyncpg

from .keys import mint_key

__all__ = [
    "RelationError",
    "RelationCycleError",
    "SubItemDepthError",
    "RELATION_SIDES",
    "SYSTEM_SUB_ITEM",
    "SYSTEM_DEPENDENCY",
    "SUB_ITEM_MAX_DEPTH",
    "RelationRef",
    "relation_ref_from_config",
    "create_relation_pair",
    "list_links",
    "link",
    "unlink",
    "set_links",
    "list_links_bulk",
    "find_cycle",
    "subtree_depth",
    "ancestor_depth",
    "link_checked",
    "delete_relation_pair",
    "SHIFT_WHEN_OVERLAP",
    "SHIFT_MAINTAIN_GAP",
    "SHIFT_NEVER",
    "DATE_SHIFT_MODES",
    "DateWindow",
    "next_weekday",
    "shift_window",
    "resolve_shift",
    "cascade_dependency_shift",
]


# ---------------------------------------------------------------------------
# 1.1 Errors
# ---------------------------------------------------------------------------


class RelationError(Exception):
    """Base class for every error this module raises. Never an
    `HTTPException` -- Task 21's router seam maps these to 400s, the same
    layering `FilterValidationError` uses for the filter compiler."""


class RelationCycleError(RelationError):
    """Linking would close a loop in a hierarchical (sub_item/dependency)
    relation. `.path` is the cycle in traversal order, both ends inclusive
    (`[row_id, ..., row_id]`) -- part of the contract, not debug output:
    the plan's M7 test case is literally "dependency cycles rejected with
    the cycle path"."""

    def __init__(self, path: list[str]) -> None:
        self.path = list(path)
        super().__init__(f"relation cycle: {' -> '.join(self.path)}")

    def __str__(self) -> str:
        return " -> ".join(self.path)


class SubItemDepthError(RelationError):
    """Linking would push a sub-item chain's longest root-to-leaf path (in
    edges) to `.max_depth` or beyond. `.depth` is the depth the link would
    have produced, not the depth before it."""

    def __init__(self, depth: int, max_depth: int) -> None:
        self.depth = depth
        self.max_depth = max_depth
        super().__init__(
            f"sub-item depth {depth} would reach or exceed the max of {max_depth}"
        )


# ---------------------------------------------------------------------------
# 1.2 The relation-property pair
# ---------------------------------------------------------------------------

RELATION_SIDES = ("forward", "reverse")
SYSTEM_SUB_ITEM = "sub_item"
SYSTEM_DEPENDENCY = "dependency"
_SYSTEM_KINDS = (SYSTEM_SUB_ITEM, SYSTEM_DEPENDENCY)

# create_property's own retry budget (routers/databases.py, `_KEY_MINT_
# ATTEMPTS`). Duplicated rather than imported: services must not depend on
# the routers layer, and it's a five-line constant, not shared logic --
# the same duplication discipline properties/temporal.py already uses for
# operators.py's ISO-date parsing (see that module's own docstring on why).
_KEY_MINT_ATTEMPTS = 5

# The three unique constraints/indexes migration 015 (and 014) put on
# db_properties, named explicitly so a UniqueViolationError can be routed
# to the right outcome: a key collision is retried with a fresh key, the
# other two are real invariant violations -> RelationError.
_KEY_COLLISION_CONSTRAINT = "db_properties_data_source_id_key_key"
_PAIR_UNIQ_CONSTRAINT = "db_properties_relation_pair_uniq"
_SYSTEM_UNIQ_CONSTRAINT = "db_properties_system_relation_uniq"


def _record_to_dict(record: asyncpg.Record) -> dict[str, Any]:
    """`dict(record)` with UUID values stringified -- the same shape
    routers/databases.py's `_row()` helper produces, duplicated here rather
    than imported (services must not depend on the routers layer)."""
    return {
        k: (str(v) if isinstance(v, uuid.UUID) else v) for k, v in dict(record).items()
    }


async def _insert_relation_property(
    conn: asyncpg.Connection,
    user_id: str,
    *,
    data_source_id: str,
    name: str,
    relation_id: str,
    side: str,
    target_data_source_id: str,
    system: str | None,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "relation_id": relation_id,
        "side": side,
        "target_data_source_id": target_data_source_id,
    }
    # Omit the "system" key entirely when None, per the brief: migration
    # 015's partial index keys off `config->>'system' IS NOT NULL`, and an
    # absent key is cleaner than an explicit JSON null for the same result.
    if system is not None:
        config["system"] = system

    for _ in range(_KEY_MINT_ATTEMPTS):
        key = mint_key()
        try:
            # Own SAVEPOINT per attempt (create_property's exact pattern,
            # routers/databases.py): a UniqueViolationError aborts the
            # *enclosing* Postgres transaction, not just this statement, so
            # without a nested transaction here, a retry after a key
            # collision would fail with "current transaction is aborted"
            # instead of actually retrying.
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    INSERT INTO db_properties
                        (data_source_id, user_id, key, name, type, config, storage, position)
                    VALUES
                        ($1, $2, $3, $4, 'relation', $5, 'jsonb',
                         COALESCE(
                            (SELECT MAX(position) + 1 FROM db_properties
                             WHERE data_source_id = $1 AND user_id = $2),
                            0))
                    RETURNING *
                    """,
                    data_source_id,
                    user_id,
                    key,
                    name,
                    config,
                )
        except asyncpg.UniqueViolationError as exc:
            cname = exc.constraint_name
            if cname == _PAIR_UNIQ_CONSTRAINT:
                raise RelationError(
                    f"relation_id {relation_id!r} already has a {side!r} property"
                ) from exc
            if cname == _SYSTEM_UNIQ_CONSTRAINT:
                raise RelationError(
                    f"data source {data_source_id!r} already has a {system!r} "
                    f"relation pair (one per data source, per migration 015)"
                ) from exc
            if cname == _KEY_COLLISION_CONSTRAINT:
                continue
            raise  # an unexpected constraint -- do not silently swallow it
        return _record_to_dict(row)
    raise RelationError("could not mint a unique property key")


async def create_relation_pair(
    conn: asyncpg.Connection,
    user_id: str,
    *,
    data_source_id: str,
    name: str,
    target_data_source_id: str,
    two_way: bool,
    reverse_name: str | None = None,
    system: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Creates the forward property (and, if `two_way`, the reverse
    property on `target_data_source_id`) sharing one freshly-minted
    `relation_id`, in a single transaction -- a two-way relation with only
    one side committed is exactly the desync state migration 015's
    one-row-per-pair design exists to prevent."""
    if system is not None and system not in _SYSTEM_KINDS:
        raise RelationError(
            f"system must be one of {_SYSTEM_KINDS} or None, got: {system!r}"
        )
    if two_way and not reverse_name:
        raise RelationError("reverse_name is required when two_way is True")

    relation_id = str(uuid.uuid4())

    async with conn.transaction():
        forward = await _insert_relation_property(
            conn,
            user_id,
            data_source_id=data_source_id,
            name=name,
            relation_id=relation_id,
            side="forward",
            target_data_source_id=target_data_source_id,
            system=system,
        )
        reverse: dict[str, Any] | None = None
        if two_way:
            assert reverse_name is not None  # guarded above
            reverse = await _insert_relation_property(
                conn,
                user_id,
                data_source_id=target_data_source_id,
                name=reverse_name,
                relation_id=relation_id,
                side="reverse",
                target_data_source_id=data_source_id,
                system=system,
            )
    return forward, reverse


async def delete_relation_pair(conn: asyncpg.Connection, user_id: str, relation_id: str) -> int:
    """Deletes both `db_properties` rows for the pair and every
    `db_relation_links` row with this `relation_id`, in one transaction.
    Migration 015 deliberately has no FK from `db_relation_links.
    relation_id` to `db_properties` (a relation_id identifies the pair, not
    either property row), which makes this sweep the app's responsibility.
    Returns the number of links deleted."""
    async with conn.transaction():
        await conn.execute(
            """
            DELETE FROM db_properties
            WHERE user_id = $1 AND type = 'relation' AND config->>'relation_id' = $2
            """,
            user_id,
            relation_id,
        )
        result = await conn.execute(
            "DELETE FROM db_relation_links WHERE user_id = $1 AND relation_id = $2::uuid",
            user_id,
            relation_id,
        )
    # asyncpg's Connection.execute() returns a status tag like "DELETE 3".
    return int(result.split()[-1])


# ---------------------------------------------------------------------------
# 1.3 Resolving a property to its link direction
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RelationRef:
    """Which relation pair a property reads, and which end of it. The
    whole of two-way sync is `own_column`/`other_column`: every read/write
    in this module goes through them, so "creating a link from either side
    produces exactly one row" is structural, not a rule someone has to
    remember."""

    relation_id: str
    side: Literal["forward", "reverse"]

    @property
    def own_column(self) -> str:
        """The `db_relation_links` column holding *this row's* id."""
        return "from_row_id" if self.side == "forward" else "to_row_id"

    @property
    def other_column(self) -> str:
        """The `db_relation_links` column holding the *related* row's id."""
        return "to_row_id" if self.side == "forward" else "from_row_id"


# The only two real column names `own_column`/`other_column` can ever
# produce. They are safe to interpolate into SQL by construction (the
# ternary above can't yield anything else regardless of `side`'s actual
# value), but every call site below still checks membership before doing
# so and raises rather than asserting -- this codebase's standard for a
# correctness guard on interpolated SQL identity, since `assert` is
# stripped under `python -O`. Matches `_column_reference` in
# properties/base.py, which does the identical check on the identical
# class of value with `raise ValueError` (that module's own precedent,
# not the reverse -- an earlier version of this comment mis-cited it as
# using `assert`, which it never did).
_LINK_COLUMNS = ("from_row_id", "to_row_id")


def _own_other(ref: RelationRef) -> tuple[str, str]:
    own, other = ref.own_column, ref.other_column
    if own not in _LINK_COLUMNS or other not in _LINK_COLUMNS:
        raise ValueError(f"invalid relation link column: {(own, other)!r}")
    return own, other


def relation_ref_from_config(config: dict[str, Any] | None) -> RelationRef | None:
    """`None` when `config` has no usable `relation_id`/`side` (a malformed
    or pre-015 relation property, or missing config entirely). Callers
    treat `None` as "this relation property is not usable" -- never as
    "fall back to JSONB": there is no JSONB copy to fall back to."""
    if not isinstance(config, dict):
        return None
    relation_id = config.get("relation_id")
    side = config.get("side")
    if not isinstance(relation_id, str) or not relation_id or side not in RELATION_SIDES:
        return None
    return RelationRef(relation_id=relation_id, side=side)


# ---------------------------------------------------------------------------
# 1.4 Link CRUD
# ---------------------------------------------------------------------------


async def list_links(
    conn: asyncpg.Connection, user_id: str, ref: RelationRef, row_id: str
) -> list[str]:
    own, other = _own_other(ref)
    rows = await conn.fetch(
        f"""
        SELECT {other} AS other_id FROM db_relation_links
        WHERE relation_id = $1 AND user_id = $2 AND {own} = $3
        ORDER BY position, id
        """,
        ref.relation_id,
        user_id,
        row_id,
    )
    return [str(r["other_id"]) for r in rows]


async def link(
    conn: asyncpg.Connection, user_id: str, ref: RelationRef, row_id: str, other_row_id: str
) -> bool:
    """Linking twice is a no-op, not an error -- the pair-unique index is
    the guarantee, the return value (True iff a row was actually inserted)
    is the report."""
    own, other = _own_other(ref)
    row = await conn.fetchrow(
        f"""
        INSERT INTO db_relation_links (user_id, relation_id, {own}, {other}, position)
        VALUES ($1, $2, $3, $4,
                COALESCE(
                    (SELECT MAX(position) + 1 FROM db_relation_links
                     WHERE relation_id = $2 AND user_id = $1 AND {own} = $3),
                    0))
        ON CONFLICT (relation_id, from_row_id, to_row_id) DO NOTHING
        RETURNING id
        """,
        user_id,
        ref.relation_id,
        row_id,
        other_row_id,
    )
    return row is not None


async def unlink(
    conn: asyncpg.Connection, user_id: str, ref: RelationRef, row_id: str, other_row_id: str
) -> bool:
    own, other = _own_other(ref)
    result = await conn.execute(
        f"""
        DELETE FROM db_relation_links
        WHERE relation_id = $1 AND user_id = $2 AND {own} = $3 AND {other} = $4
        """,
        ref.relation_id,
        user_id,
        row_id,
        other_row_id,
    )
    return result.split()[-1] != "0"


async def set_links(
    conn: asyncpg.Connection,
    user_id: str,
    ref: RelationRef,
    row_id: str,
    other_row_ids: list[str],
) -> list[str]:
    """Replaces the whole link list for one row in one transaction: deletes
    the ones no longer present, inserts the new ones, and rewrites
    `position` to the given order (0, 1, 2, ...) so a caller-supplied order
    round-trips. This is what a cell editor calls."""
    own, other = _own_other(ref)
    # De-duplicate while preserving the caller's first-occurrence order --
    # a repeated id in the request shouldn't produce two position values
    # for the same pair (the unique index would reject the second insert
    # anyway; de-duping up front keeps position assignment sane).
    new_ids = list(dict.fromkeys(other_row_ids))

    async with conn.transaction():
        existing = await conn.fetch(
            f"""
            SELECT {other} AS other_id FROM db_relation_links
            WHERE relation_id = $1 AND user_id = $2 AND {own} = $3
            """,
            ref.relation_id,
            user_id,
            row_id,
        )
        existing_ids = {str(r["other_id"]) for r in existing}
        to_delete = existing_ids - set(new_ids)
        if to_delete:
            await conn.execute(
                f"""
                DELETE FROM db_relation_links
                WHERE relation_id = $1 AND user_id = $2 AND {own} = $3
                  AND {other} = ANY($4::uuid[])
                """,
                ref.relation_id,
                user_id,
                row_id,
                list(to_delete),
            )
        for position, other_id in enumerate(new_ids):
            await conn.execute(
                f"""
                INSERT INTO db_relation_links (user_id, relation_id, {own}, {other}, position)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (relation_id, from_row_id, to_row_id)
                DO UPDATE SET position = EXCLUDED.position
                """,
                user_id,
                ref.relation_id,
                row_id,
                other_id,
                float(position),
            )
    return new_ids


async def list_links_bulk(
    conn: asyncpg.Connection, user_id: str, ref: RelationRef, row_ids: list[str]
) -> dict[str, list[str]]:
    """The N+1 killer for rendering a table of rows: one query, grouped in
    Python. Every requested id is a key in the result, even with no links
    (`[]`, not an absent key)."""
    result: dict[str, list[str]] = {rid: [] for rid in row_ids}
    if not row_ids:
        return result
    own, other = _own_other(ref)
    rows = await conn.fetch(
        f"""
        SELECT {own} AS owner_id, {other} AS other_id FROM db_relation_links
        WHERE relation_id = $1 AND user_id = $2 AND {own} = ANY($3::uuid[])
        ORDER BY {own}, position, id
        """,
        ref.relation_id,
        user_id,
        row_ids,
    )
    for r in rows:
        result[str(r["owner_id"])].append(str(r["other_id"]))
    return result


# ---------------------------------------------------------------------------
# 1.5 Cycle detection and depth
# ---------------------------------------------------------------------------

# A recursive CTE with a bug is a hung connection, and this code runs on
# every link write -- this cap is a second belt behind the `NOT (next =
# ANY(path))` termination condition, in case a pre-existing cycle in the
# data (which should be impossible, but "should be" is not a guarantee)
# would otherwise make the query run forever.
_MAX_TRAVERSAL_DEPTH = 1000


async def find_cycle(
    conn: asyncpg.Connection,
    user_id: str,
    ref: RelationRef,
    row_id: str,
    other_row_id: str,
) -> list[str] | None:
    """Answers "if I link `row_id -> other_row_id`, does that close a
    loop?" -- i.e. is `row_id` already reachable *from* `other_row_id` by
    following `ref`'s direction (`own_column -> other_column`) repeatedly?
    Returns the path from `row_id` back to itself (both ends inclusive) or
    `None`."""
    own, other = _own_other(ref)
    row = await conn.fetchrow(
        f"""
        WITH RECURSIVE walk(current_id, path, depth) AS (
            SELECT $3::uuid, ARRAY[$3::uuid]::uuid[], 0
            UNION ALL
            SELECT rl.{other}, walk.path || rl.{other}, walk.depth + 1
            FROM db_relation_links rl
            JOIN walk ON rl.{own} = walk.current_id
            WHERE rl.relation_id = $1 AND rl.user_id = $2
              AND NOT (rl.{other} = ANY(walk.path))
              AND walk.depth < $4
        )
        SELECT path FROM walk WHERE current_id = $5
        LIMIT 1
        """,
        ref.relation_id,
        user_id,
        other_row_id,
        _MAX_TRAVERSAL_DEPTH,
        row_id,
    )
    if row is None:
        return None
    # `row["path"]` is other_row_id -> ... -> row_id (the walk that already
    # exists). Prepending row_id turns it into the full cycle the new edge
    # would create: row_id -> other_row_id -> ... -> row_id.
    return [str(row_id)] + [str(x) for x in row["path"]]


async def _max_chain_depth(
    conn: asyncpg.Connection,
    user_id: str,
    ref: RelationRef,
    row_id: str,
    *,
    downstream: bool,
) -> int:
    """Shared shape for `subtree_depth`/`ancestor_depth`: the longest chain
    of links reachable from `row_id`, in one direction or the other.
    `downstream=True` walks `own_column -> other_column` (subtree_depth's
    direction); `downstream=False` walks the reverse (ancestor_depth's)."""
    own, other = _own_other(ref)
    source, target = (own, other) if downstream else (other, own)
    val = await conn.fetchval(
        f"""
        WITH RECURSIVE walk(current_id, path, depth) AS (
            SELECT $3::uuid, ARRAY[$3::uuid]::uuid[], 0
            UNION ALL
            SELECT rl.{target}, walk.path || rl.{target}, walk.depth + 1
            FROM db_relation_links rl
            JOIN walk ON rl.{source} = walk.current_id
            WHERE rl.relation_id = $1 AND rl.user_id = $2
              AND NOT (rl.{target} = ANY(walk.path))
              AND walk.depth < $4
        )
        SELECT COALESCE(MAX(depth), 0) FROM walk
        """,
        ref.relation_id,
        user_id,
        row_id,
        _MAX_TRAVERSAL_DEPTH,
    )
    return int(val)


async def subtree_depth(
    conn: asyncpg.Connection, user_id: str, ref: RelationRef, row_id: str
) -> int:
    """Longest chain of links downstream of `row_id` (0 for a leaf)."""
    return await _max_chain_depth(conn, user_id, ref, row_id, downstream=True)


async def ancestor_depth(
    conn: asyncpg.Connection, user_id: str, ref: RelationRef, row_id: str
) -> int:
    """Longest chain of links upstream of `row_id` (0 for a root)."""
    return await _max_chain_depth(conn, user_id, ref, row_id, downstream=False)


# ---------------------------------------------------------------------------
# 1.6 The guarded write
# ---------------------------------------------------------------------------

# The plan mandates 10. Research §3.3 is explicit that Notion documents no
# sub-item depth limit, and that the widely-quoted "three levels" belongs to
# database *templates*, a different feature -- this is our own number, not
# a copied constant.
SUB_ITEM_MAX_DEPTH = 10


async def link_checked(
    conn: asyncpg.Connection,
    user_id: str,
    ref: RelationRef,
    row_id: str,
    other_row_id: str,
    *,
    system: str | None,
) -> bool:
    """The only function Task 21's endpoints call to create a link.
    Ordinary (non-system) relations skip the cycle and depth checks
    entirely -- a graph of arbitrary shape between two databases is a
    legitimate thing, and Notion imposes no such limit on them. Only the
    two hierarchical system relations (`sub_item`/`dependency`) are
    constrained, and only when `system` is passed."""
    async with conn.transaction():
        if system is not None and row_id == other_row_id:
            # No `CHECK (from <> to)` in migration 015 on purpose: a
            # length-1 cycle must be reported *with its path*, like any
            # other cycle, which a CHECK constraint can't produce. An
            # ordinary (system=None) relation may legitimately point a row
            # at itself, so this check only fires for the two hierarchical
            # relations.
            raise RelationCycleError([row_id, row_id])

        if system is not None:
            cycle_path = await find_cycle(conn, user_id, ref, row_id, other_row_id)
            if cycle_path is not None:
                raise RelationCycleError(cycle_path)

        if system == SYSTEM_SUB_ITEM:
            # "depth" = number of *edges* on the longest root-to-leaf path
            # through the new link: the edges from the true root down to
            # row_id (ancestor_depth(row_id)), plus this one new edge,
            # plus the edges from other_row_id down to its deepest
            # descendant (subtree_depth(other_row_id)).
            anc = await ancestor_depth(conn, user_id, ref, row_id)
            sub = await subtree_depth(conn, user_id, ref, other_row_id)
            depth = anc + 1 + sub
            if depth >= SUB_ITEM_MAX_DEPTH:
                raise SubItemDepthError(depth, SUB_ITEM_MAX_DEPTH)

        return await link(conn, user_id, ref, row_id, other_row_id)


# ---------------------------------------------------------------------------
# 1.7 Dependency date shifting
# ---------------------------------------------------------------------------

# Verbatim strings, per research §4.4 and the brief: a slug mapping is one
# more place for these to drift from Notion's real UI text, and the plan's
# test case checks the modes "by their real names".
SHIFT_WHEN_OVERLAP = "Shift only when dates overlap"
SHIFT_MAINTAIN_GAP = "Shift & maintain time between items"
SHIFT_NEVER = "Do not automatically shift"
DATE_SHIFT_MODES = (SHIFT_WHEN_OVERLAP, SHIFT_MAINTAIN_GAP, SHIFT_NEVER)


@dataclass(frozen=True)
class DateWindow:
    start: datetime
    end: datetime | None = None  # None => a single-instant date, start == end


def next_weekday(d: datetime) -> datetime:
    """Nudges a Sat/Sun datetime forward to the next Monday, preserving
    time-of-day. Weekdays pass through unchanged. "Forward to Monday" is
    our own choice for `avoid_weekends` -- research §4.4 says Notion
    documents only that it "prevent[s] shifted items from starting or
    ending on weekends," not which direction it nudges in."""
    weekday = d.weekday()  # Mon=0 ... Sun=6
    if weekday == 5:  # Saturday
        return d + timedelta(days=2)
    if weekday == 6:  # Sunday
        return d + timedelta(days=1)
    return d


def shift_window(w: DateWindow, delta: timedelta, *, avoid_weekends: bool) -> DateWindow:
    """Translates `w` by `delta` (both `start` and `end`, rigidly), then --
    if `avoid_weekends` -- nudges each endpoint independently to the next
    Monday when it lands on a weekend. Deliberately does NOT re-flow the
    duration to compensate (research §4.4's `avoid_weekends` scope is
    exactly "shifted items' start and end", nothing about preserving the
    gap between them)."""
    new_start = w.start + delta
    new_end = (w.end + delta) if w.end is not None else None
    if avoid_weekends:
        new_start = next_weekday(new_start)
        if new_end is not None:
            new_end = next_weekday(new_end)
    return DateWindow(start=new_start, end=new_end)


def _effective_end(w: DateWindow) -> datetime:
    """A `None` end is a single-instant date: treated as `end == start`."""
    return w.end if w.end is not None else w.start


def resolve_shift(
    blocker: DateWindow,
    blocked: DateWindow,
    mode: str,
    *,
    avoid_weekends: bool,
    blocker_delta: timedelta,
) -> DateWindow | None:
    """Pure function: what should `blocked`'s new window be, given that
    `blocker` is the window it's blocked by (already at its *new*
    position) and `blocker` moved by `blocker_delta` to get there? Returns
    `None` for "no change".

    `blocker_delta` is a parameter, not inferred from the two windows --
    `resolve_shift` only ever sees `blocker`'s *current* window, not
    where it moved *from*, so the delta has to be handed in (the brief's
    own signature note)."""
    if mode == SHIFT_NEVER:
        return None

    if mode == SHIFT_MAINTAIN_GAP:
        # "If task A is blocking task B and the due date of task A is
        # shifted forward one week, the due date of B will also shift
        # forward one week" -- B translates rigidly by A's own delta,
        # regardless of the current gap between them.
        return shift_window(blocked, blocker_delta, avoid_weekends=avoid_weekends)

    if mode == SHIFT_WHEN_OVERLAP:
        blocker_end = _effective_end(blocker)
        if blocked.start >= blocker_end:
            # "Tasks will only be shifted when their dates start to
            # overlap" -- no overlap, nothing to do. This is also what
            # lets the gap between them shrink over successive shifts,
            # which research §4.4 explicitly calls out as expected.
            return None
        # "The distance between tasks may still be decreased": B moves
        # forward by exactly enough to abut A's end, not by A's full delta.
        overlap_delta = blocker_end - blocked.start
        return shift_window(blocked, overlap_delta, avoid_weekends=avoid_weekends)

    raise ValueError(f"unknown date_shift_mode: {mode!r}")


def _parse_iso(raw: Any) -> datetime:
    """Same normalisation as query/operators.py's `_coerce_date` and
    properties/temporal.py's `_parse_iso` -- duplicated rather than
    imported (this module must not depend on either query/ or
    properties/, and it's five lines)."""
    if not isinstance(raw, str):
        raise ValueError(f"date value must be an ISO-8601 string, got: {raw!r}")
    normalised = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    parsed = datetime.fromisoformat(normalised)
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


async def _read_window(
    conn: asyncpg.Connection, user_id: str, row_id: str, date_property_key: str
) -> DateWindow | None:
    """Reads `date_property_key`'s current value off `row_id`. `None` when
    the row has no value there (nothing to shift)."""
    raw = await conn.fetchval(
        "SELECT properties -> $1 -> 'date' FROM db_row_props WHERE note_id = $2 AND user_id = $3",
        date_property_key,
        row_id,
        user_id,
    )
    if not raw or raw.get("start") is None:
        return None
    start = _parse_iso(raw["start"])
    end = _parse_iso(raw["end"]) if raw.get("end") is not None else None
    return DateWindow(start=start, end=end)


async def _write_window(
    conn: asyncpg.Connection,
    user_id: str,
    row_id: str,
    date_property_key: str,
    window: DateWindow,
) -> None:
    """Writes `window` back as the §3.3 wrapper shape
    (`{"type": "date", "date": {"start", "end", "time_zone"}}`)."""
    date_value = {
        "type": "date",
        "date": {
            "start": window.start.isoformat(),
            "end": window.end.isoformat() if window.end is not None else None,
            "time_zone": None,
        },
    }
    await conn.execute(
        """
        UPDATE db_row_props
        SET properties = jsonb_set(properties, ARRAY[$1], $2::jsonb, true), updated_at = now()
        WHERE note_id = $3 AND user_id = $4
        """,
        date_property_key,
        date_value,
        row_id,
        user_id,
    )


async def cascade_dependency_shift(
    conn: asyncpg.Connection,
    user_id: str,
    ref: RelationRef,
    *,
    changed_row_id: str,
    delta: timedelta,
    mode: str,
    avoid_weekends: bool,
    date_property_key: str,
) -> dict[str, DateWindow]:
    """Walks the blocking chain downstream of `changed_row_id` (via `ref`'s
    `own_column -> other_column` direction -- "this row's dependents"),
    applying `resolve_shift` per edge, breadth-first, and writing each
    moved row's new window back to `db_row_props`. Returns `{row_id:
    new_window}` for every row actually moved.

    A row already moved in this pass is never moved again (a `visited`
    set) -- the graph is acyclic by construction (`link_checked` enforces
    that for `system="dependency"` links), but a diamond (two paths
    converging on one downstream row) is not a cycle, and would otherwise
    double-shift that row.

    A row with no `date_property_key` value is skipped, and the cascade
    does not continue past it: with nothing to shift, there is no
    "realised delta" to propagate to its own dependents, so this is a
    (documented) design decision, not an oversight -- see the task report.
    """
    if mode == SHIFT_NEVER:
        return {}

    changed_window = await _read_window(conn, user_id, changed_row_id, date_property_key)
    if changed_window is None:
        return {}

    changes: dict[str, DateWindow] = {}
    visited: set[str] = {changed_row_id}
    # Each queue entry is (row_id, that row's current window, the delta
    # that got it there) -- the "blocker" for the next hop out.
    queue: list[tuple[str, DateWindow, timedelta]] = [(changed_row_id, changed_window, delta)]

    while queue:
        row_id, window, row_delta = queue.pop(0)
        dependent_ids = await list_links(conn, user_id, ref, row_id)
        for dep_id in dependent_ids:
            if dep_id in visited:
                continue
            dep_window = await _read_window(conn, user_id, dep_id, date_property_key)
            if dep_window is None:
                continue
            new_window = resolve_shift(
                window, dep_window, mode, avoid_weekends=avoid_weekends, blocker_delta=row_delta
            )
            if new_window is None:
                continue
            visited.add(dep_id)
            await _write_window(conn, user_id, dep_id, date_property_key, new_window)
            changes[dep_id] = new_window
            realised_delta = new_window.start - dep_window.start
            queue.append((dep_id, new_window, realised_delta))

    return changes
