"""Assembles one executable SELECT for either query-builder mode: the
built-in "All Notes" virtual source, or an ordinary data source's
`db_row_props`. Mirrors the two-mode split `routers/databases.py`'s
`list_rows` already uses (Milestone 2) so this builder is a drop-in for
both once a later milestone wires it into that router.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §8.3.
"""
from __future__ import annotations

from dataclasses import dataclass

from services.db.properties.base import SqlFragment
from services.db.properties.columns import COLUMN_BACKED
from .ast import FilterNode, Pagination, SortSpec
from .compiler import PropertyLookup, compile_filter, compile_sorts, renumber


@dataclass(frozen=True)
class QueryBuilder:
    user_id: str
    data_source_id: str | None  # None => the "All Notes" virtual source
    properties: dict[str, PropertyLookup]

    def _alias(self) -> str:
        return "n" if self.data_source_id is None else "p"

    def _scope(self) -> SqlFragment:
        """spec §8.3: "not optional and not a parameter" — the tenancy scope
        for this builder's mode, always spliced into WHERE from `build()`,
        never inlined ad hoc.

        Ordinary mode also requires `n.deleted_at IS NULL` here (on top of
        the mandatory `JOIN notes n` in `_from()`): `db_row_props` has no
        `deleted_at` of its own — trash lives on `notes` (confirmed against
        supabase/migrations/014_databases_core.sql's db_row_props DDL) — so
        without both pieces a trashed note's row would still appear in
        every filtered/sorted query this builder produces (M2 final review
        finding, deferred until this task: see task-12-brief.md). The join
        itself is a primary-key-to-primary-key join on both sides
        (`notes.id` and `db_row_props.note_id` are each other's PK/FK), so
        it costs nothing beyond an index lookup — no B-tree-expression-index
        tradeoff like the one Task 11 hit with the guarded numeric cast.
        """
        if self.data_source_id is None:
            return SqlFragment("n.user_id = $1 AND n.deleted_at IS NULL", (self.user_id,))
        return SqlFragment(
            "p.user_id = $1 AND p.data_source_id = $2 AND n.deleted_at IS NULL",
            (self.user_id, self.data_source_id),
        )

    def _from(self) -> str:
        if self.data_source_id is None:
            return "FROM notes n"
        return "FROM db_row_props p JOIN notes n ON n.id = p.note_id"

    def _columns(self) -> str:
        # task-17: `n.cover_image_url` is appended in both modes, unconditionally --
        # a real `notes` column (migration 005), reachable in ordinary mode too since
        # `_from()` already joins `notes n` there for every query this builder
        # produces (the mandatory `n.deleted_at IS NULL` scope in `_scope()` needs
        # that join regardless). It's deliberately NOT one of `COLUMN_BACKED`'s
        # entries -- routers/databases.py's decode functions lift it into a
        # dedicated `cover_image_url` field on each row dict, not into
        # `properties{}`, so it never becomes a Table/Board column or an editable
        # property (task-17-brief.md's Gallery-view cover-image scope call).
        if self.data_source_id is None:
            # Same pattern routers/databases.py's list_rows already uses —
            # COLUMN_BACKED is the one source of truth for the All Notes
            # column list, never hand-rolled here (see that router's own
            # comment on why a duplicated literal list would silently drift).
            cols = ", ".join(prop.column for prop in COLUMN_BACKED.values())
            return f"n.id, {cols}, n.cover_image_url"
        return "p.note_id, p.properties, n.cover_image_url"

    def build(
        self,
        filter_node: FilterNode | None,
        sorts: list[SortSpec],
        pagination: Pagination,
    ) -> SqlFragment:
        alias = self._alias()
        scope = self._scope()
        params: list = list(scope.params)

        raw_filter = compile_filter(filter_node, self.properties, user_id=self.user_id, alias=alias)
        filter_frag = renumber(raw_filter, start=len(params) + 1)
        params.extend(filter_frag.params)

        # Milestone 7: compile_sorts can now emit bound params too (a
        # relation sort's count subquery) -- renumber into position right
        # after the filter's, same as the filter fragment above. Final
        # param order down the whole query: scope, then filter, then
        # sorts, then limit/offset (get this wrong and the injection suite
        # notices -- task-20-brief.md §3.3).
        raw_sorts = compile_sorts(sorts, self.properties, user_id=self.user_id, alias=alias)
        sorts_frag = renumber(raw_sorts, start=len(params) + 1)
        params.extend(sorts_frag.params)
        # `n.id ASC` is always appended, even when sorts is empty or every
        # requested sort key ties — without it, LIMIT/OFFSET pagination over
        # rows with equal sort keys is nondeterministic between pages (rows
        # can repeat or vanish across two consecutive requests). `n.id` is
        # present in both modes (FROM notes n / the ordinary mode's joined n).
        order_by = f"{sorts_frag.sql}, n.id ASC" if sorts_frag.sql else "n.id ASC"

        limit_idx = len(params) + 1
        offset_idx = len(params) + 2
        params.append(pagination.page_size)
        params.append(pagination.offset)

        sql = (
            f"SELECT {self._columns()} "
            f"{self._from()} "
            f"WHERE {scope.sql} AND ({filter_frag.sql}) "
            f"ORDER BY {order_by} "
            f"LIMIT ${limit_idx} OFFSET ${offset_idx}"
        )
        return SqlFragment(sql=sql, params=tuple(params))
