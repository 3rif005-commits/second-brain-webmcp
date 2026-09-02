"""Column-backed properties: the fixed allow-list that lets existing
`notes` columns (`topics`, `mastery_status`, `source_type`, `source_url`,
...) become `storage='column'` properties instead of being migrated into
generic JSONB storage.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §6.

`db_properties.column_name` (Milestone 2 onward) is validated against this
**fixed Python allow-list** -- never against the request, never against
the database catalogue. This is the entire defence against a
column-injection attack: a `column_name` that doesn't appear as a value
here is rejected outright, so no user input ever reaches a SQL identifier
position.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ColumnProp:
    """One allow-listed `notes` column exposed as a property.

    `column` is the real `notes` column name (validated by
    `test_column_backed_identifiers_are_safe` to be a plain lowercase SQL
    identifier — never derived from user input).

    `type` **is a `REGISTRY` key** (`base.REGISTRY`), so Milestone 2's CRUD
    and view layer can resolve a column-backed property's behaviour with a
    plain `REGISTRY[COLUMN_BACKED[name].type]`. Earlier drafts used loose
    display tags here (`"text"`, `"multi_select_array"`) that were not
    registry keys, which made that lookup a `KeyError` for `icon` and
    `topics` — caught in the Milestone 0/1 final review.

    `native_array` records the separate, physical fact that the column is a
    native Postgres array (`topics TEXT[]`) rather than a scalar: the
    logical property type is still `multi_select`, but the SQL a filter or
    aggregation compiles to differs (`&&`/`@>` on the array, not JSONB
    containment). Milestone 5's real `multi_select` descriptor branches on
    this; nothing before it needs to.
    """

    column: str
    type: str
    native_array: bool = False


# Spec §6, reproduced exactly. This yields the built-in "All Notes" virtual
# data source (`system_kind='notes'`): table/board/gallery views over the
# entire existing brain on day one of Milestone 2, with zero rows migrated.
COLUMN_BACKED: dict[str, ColumnProp] = {
    "title":          ColumnProp("title",          "title"),
    "icon":           ColumnProp("icon",           "rich_text"),
    "topics":         ColumnProp("topics",         "multi_select", native_array=True),
    "mastery_status": ColumnProp("mastery_status", "status"),
    "source_type":    ColumnProp("source_type",    "select"),
    "source_url":     ColumnProp("source_url",     "url"),
    "is_favorited":   ColumnProp("is_favorited",   "checkbox"),
    "created_at":     ColumnProp("created_at",     "created_time"),
    "updated_at":     ColumnProp("updated_at",     "last_edited_time"),
}

# The identifiers a `storage='column'` property may legally name. Anything
# outside this set is rejected before it can reach a SQL identifier
# position (see `base._column_reference`).
COLUMN_BACKED_NAMES: frozenset[str] = frozenset(
    prop.column for prop in COLUMN_BACKED.values()
)

# Spec §6: "What stays hardcoded: content, content_text, fts,
# descriptor_embedding, local_only, is_public, position, collection_id.
# These are engine state, not user-facing properties." Never eligible for
# COLUMN_BACKED, regardless of future changes to this file.
ENGINE_STATE_COLUMNS: frozenset[str] = frozenset({
    "content",
    "content_text",
    "fts",
    "descriptor_embedding",
    "local_only",
    "is_public",
    "position",
    "collection_id",
})

# The guard actually applied to COLUMN_BACKED: spec §6's engine-state list
# plus the row's identity and tenancy columns. Final review, minor finding:
# the old guard was ENGINE_STATE_COLUMNS alone, so a hypothetical
# `ColumnProp("user_id", ...)` — exposing the tenancy column as a
# user-editable property — would have sailed through it. `deleted_at` is
# trash state (owned by the notes engine) and `id` is the row identity that
# `db_row_props.note_id` joins on; neither is a property.
NEVER_COLUMN_BACKED: frozenset[str] = ENGINE_STATE_COLUMNS | frozenset({
    "id",
    "user_id",
    "deleted_at",
})

_overlap = {prop.column for prop in COLUMN_BACKED.values()} & NEVER_COLUMN_BACKED
if _overlap:
    # Not an `assert`: this guard is load-bearing against a column-injection
    # class of bug (spec §6) and must not be strippable by `python -O`.
    raise RuntimeError(
        f"COLUMN_BACKED must never expose an engine-state, identity or tenancy "
        f"column, found: {sorted(_overlap)}"
    )
del _overlap
