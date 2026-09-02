"""View-JSONB maintenance for `db_views`.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §10.

"Deleted-property handling, both halves: on property delete, a sweep
strips references from every view's `filter`, `sorts`, `config.
properties[]` and `group_by`. [...] The sweep keeps data clean." This
module is the sweep half. (View hydration tolerating unknown property
keys at read is the other half, and needs no code here — a dangling key
in `filter`/`sorts`/`config` that's never swept just gets skipped by
whatever reads it, which is a Milestone 3+ concern.)

Property references in `filter` (spec §8.1's AST), `sorts` and
`config.properties[]` (spec §10) are all identified by the property's
`key` — the same short opaque base62 string used everywhere else, not
the `db_properties.id` UUID. This module's own `key` parameter is that
`key`, and callers (routers/databases.py's property-delete endpoint) are
responsible for passing the deleted property's `key`, not its `id`.
"""
from __future__ import annotations

from typing import Any

import asyncpg


def _strip_key(node: Any, key: str) -> Any:
    """Recursively remove any object that references `key`
    (`{"property": key, ...}`) from `node`, wherever nested.

    Handles two shapes, per spec §10 ("filter, sorts, config.properties[]
    and group_by"):

    - **List membership** (a filter group's `children`, a `sorts` array,
      `config.properties[]`): a matching element is dropped from the list
      entirely.
    - **Dict-valued field** (`config.group_by`, documented in spec §10 as
      `object | null`): a matching value is replaced with `None` rather
      than the key being removed — consistent with how a matching *root*
      filter becomes `None` in `strip_property_key` below, and simpler for
      a reader to reason about than "the key vanished".

    Recursion terminates naturally on scalars; arbitrary nesting is
    supported (spec §8.1 sanity-caps filter depth at 10, but this walk
    doesn't need to know that cap to be correct).
    """
    if isinstance(node, list):
        kept = []
        for item in node:
            if isinstance(item, dict) and item.get("property") == key:
                continue  # the condition/sort/properties[] entry itself is dropped
            kept.append(_strip_key(item, key))
        return kept
    if isinstance(node, dict):
        result = {}
        for k, v in node.items():
            if isinstance(v, dict) and v.get("property") == key:
                result[k] = None  # e.g. config.group_by directly matching
            else:
                result[k] = _strip_key(v, key)
        return result
    return node


def strip_property_key(
    filter_json: Any, sorts_json: Any, config_json: Any, key: str
) -> tuple[Any, Any, Any]:
    """Pure function: given a view's current `filter`/`sorts`/`config` and
    a deleted property's `key`, return the swept versions. Split out from
    `sweep_property_from_views` so the JSONB-walk logic is testable
    without a database connection.
    """
    new_filter = filter_json
    if isinstance(filter_json, dict) and filter_json.get("property") == key:
        # The filter's root is itself the single matching condition (no
        # enclosing group to drop it from) — the whole filter goes.
        new_filter = None
    elif filter_json is not None:
        new_filter = _strip_key(filter_json, key)

    new_sorts = _strip_key(sorts_json, key) if sorts_json is not None else sorts_json
    new_config = _strip_key(config_json, key) if config_json is not None else config_json
    return new_filter, new_sorts, new_config


async def sweep_property_from_views(
    conn: asyncpg.Connection, user_id: str, data_source_id: str, key: str
) -> int:
    """Strip every reference to the deleted property (`key`) from every
    view belonging to `data_source_id`, scoped to `user_id` (tenancy
    guard — see `test_databases_router.py`'s scope-predicate test).

    Returns the number of views actually rewritten; a view with no
    reference to `key` is left untouched (no write issued).
    """
    rows = await conn.fetch(
        """
        SELECT id, filter, sorts, config FROM db_views
        WHERE data_source_id = $1 AND user_id = $2
        """,
        data_source_id, user_id,
    )
    changed = 0
    for row in rows:
        new_filter, new_sorts, new_config = strip_property_key(
            row["filter"], row["sorts"], row["config"], key
        )
        if (
            new_filter == row["filter"]
            and new_sorts == row["sorts"]
            and new_config == row["config"]
        ):
            continue
        await conn.execute(
            """
            UPDATE db_views SET filter = $1, sorts = $2, config = $3
            WHERE id = $4 AND user_id = $5
            """,
            new_filter, new_sorts, new_config, row["id"], user_id,
        )
        changed += 1
    return changed
