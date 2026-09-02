// Client-side tree builder for TableView's sub-item "show" (nested)
// display mode (task-22-brief.md §3, research §3.4). Pure and separately
// testable from any rendering concerns.
//
// task-21's originally committed router exposed no bulk relation-links
// endpoint — `services/db/relations.py`'s own `list_links_bulk` existed
// (its docstring even anticipated exactly this "one row's tree" use case)
// but no `routers/databases.py` handler called it, so building a tree for
// N visible rows cost N requests. The M7 combined review caught this
// (Important finding 3) and it was fixed in the same review's fix wave:
// `POST .../relations/{property_key}/links/bulk` now exists, and
// `TableView`'s pre-fetch effect calls it (via `useDatabaseView`'s
// `ensureRelationLinksBulk`) instead of looping — see task-22-report.md
// (reconstructed after the fact, since task 22's own implementer never
// wrote one) for the full writeup, including this finding. This function
// itself takes the already-fetched answers (`childIdsOf`) rather than
// fetching anything, so it doesn't care how many requests it took to
// assemble them.
import type { DatabaseRow } from "./types";

export interface SubItemTreeEntry {
  row: DatabaseRow;
  depth: number;
  hasChildren: boolean;
}

// Mirrors services/db/relations.py's SubItemDepthError cap (task-20) — a
// render-time guard, not a *reliance* on the backend never sending a
// deeper structure (task-22-brief.md §3: "do not rely on that for
// correctness; guard the render too").
export const MAX_SUBITEM_DEPTH = 10;

/**
 * Orders `rows` into a depth-first, indentable list: each root row
 * (nothing in `rows` lists it as a child) followed by its descendants,
 * skipping any row inside `collapsed`'s subtree (its own entry still
 * appears — the expand/collapse toggle's data-side counterpart — just not
 * its descendants). `childIdsOf(rowId)` returns that row's sub-item
 * relation links — `undefined` while still loading (treated as "no
 * children yet"; the caller re-renders once the fetch resolves and this
 * function runs again with a populated cache).
 *
 * A child id that doesn't resolve to a row in `rows` (outside the current
 * page, or its parent's link is stale) is silently dropped rather than
 * rendered as a dangling node — the same "don't surface a link to
 * something not really there" spirit as the router's own trashed-row
 * filtering (task-21-report.md).
 *
 * Guards against both a cycle and runaway depth defensively (a `visited`
 * set per root-to-node path, and `MAX_SUBITEM_DEPTH`) even though the
 * backend's own `SubItemDepthError`/cycle checks should make both
 * impossible in practice — see this file's header.
 */
export function buildSubItemTree(
  rows: DatabaseRow[],
  childIdsOf: (rowId: string) => string[] | undefined,
  collapsed: Set<string> = new Set()
): SubItemTreeEntry[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const allChildIds = new Set<string>();
  for (const row of rows) {
    for (const childId of childIdsOf(row.id) ?? []) {
      if (byId.has(childId)) allChildIds.add(childId);
    }
  }
  const roots = rows.filter((r) => !allChildIds.has(r.id));

  const result: SubItemTreeEntry[] = [];

  function visit(row: DatabaseRow, depth: number, visited: Set<string>) {
    const childIds = (childIdsOf(row.id) ?? []).filter((id) => byId.has(id));
    result.push({ row, depth, hasChildren: childIds.length > 0 });
    if (collapsed.has(row.id)) return;
    if (depth >= MAX_SUBITEM_DEPTH) return;
    for (const childId of childIds) {
      if (visited.has(childId)) continue;
      const child = byId.get(childId);
      if (!child) continue;
      visit(child, depth + 1, new Set(visited).add(childId));
    }
  }

  for (const root of roots) visit(root, 0, new Set([root.id]));
  return result;
}
