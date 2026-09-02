"use client";

// Renders a relation property's linked rows as chips showing their
// *titles* (task-21's GET returns titles for exactly this reason — a chip
// reading a bare UUID is useless, task-22-brief.md §1). Doesn't implement
// `CellProps<V>` (value/editable/onChange) like the other 8 cells: a
// relation's value never travels through `updateCell`/`onChange` at all
// (migration 015 — `db_relation_links` is the only source of truth, and
// `update_row_property` rejects a relation key outright), so it needs its
// own props shape, wired up by `renderCellValue`'s optional 5th argument.
//
// No drag-to-reorder here (a documented, deliberate scope cut): `PUT
// .../relations/{property_key}` diffs the requested list via
// `link_checked`/`unlink` to preserve the sub-item/dependency cycle+depth
// guards (task-21-report.md judgement call 1), and as a consequence does
// NOT rewrite surviving links' `position` to match the caller's order — a
// caller-supplied ordering doesn't round-trip. Add/remove only.
import { useEffect, useState } from "react";
import type { PropertyResponse, RelatedRow } from "@/lib/database/types";
import { RelationPicker } from "../RelationPicker";

export interface RelationCellProps {
  property: PropertyResponse;
  /** All Notes (and any other non-editable context) passes false — chips
   * render, but with no "×" and no "+", not merely disabled controls
   * (task-22-brief.md §0: "must not render at all... not merely be
   * disabled", verified here at the component level). */
  editable: boolean;
  /** `undefined` = not fetched yet (renders a small loading placeholder,
   * distinct from "fetched, zero links" which renders "—"). */
  links: RelatedRow[] | undefined;
  /** Triggers `useDatabaseView`'s `ensureRelationLinks` cache warm — called
   * once on mount, since this component has no way to fetch its own data
   * without a `dataSourceId`/`rowId` (deliberately not props here; the
   * caller already has them from the table row it's rendering, so passing
   * bound closures avoids threading both through a second prop pair). */
  onEnsureLoaded: () => void;
  onLinksChange: (rows: RelatedRow[]) => void | Promise<void>;
}

export function RelationCell({ property, editable, links, onEnsureLoaded, onLinksChange }: RelationCellProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    onEnsureLoaded();
    // Run once per mount (one RelationCell instance = one fixed row/
    // property pair) — not on every `onEnsureLoaded` identity change,
    // which happens whenever *any* cell's fetch resolves (see
    // useDatabaseView.ts's own comment on why `ensureRelationLinks` isn't
    // stable across cache updates).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function removeLink(id: string) {
    if (!links) return;
    onLinksChange(links.filter((r) => r.id !== id));
  }

  const targetDataSourceId =
    typeof property.config?.target_data_source_id === "string"
      ? (property.config.target_data_source_id as string)
      : undefined;

  return (
    <div className="relative flex flex-wrap items-center gap-1">
      {links === undefined ? (
        <span className="text-gray-400 text-xs">…</span>
      ) : links.length === 0 ? (
        <span className="text-gray-400">—</span>
      ) : (
        links.map((row) => (
          <span
            key={row.id}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300"
          >
            {row.title}
            {editable && (
              <button
                type="button"
                aria-label={`Remove ${row.title}`}
                onClick={() => removeLink(row.id)}
                className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-100"
              >
                ×
              </button>
            )}
          </span>
        ))
      )}
      {editable && targetDataSourceId && (
        <button
          type="button"
          aria-label="Link a row"
          onClick={() => setPickerOpen(true)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-xs px-1"
        >
          +
        </button>
      )}
      {editable && pickerOpen && targetDataSourceId && (
        <RelationPicker
          targetDataSourceId={targetDataSourceId}
          selected={links ?? []}
          onCommit={(rows) => {
            setPickerOpen(false);
            onLinksChange(rows);
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
