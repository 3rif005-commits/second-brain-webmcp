"use client";

// Research: "the most configuration-poor layout... title on the left,
// properties on the right, one row per page." No cards, no cover, no
// calculations, no grouping — research explicitly flags "UNRESOLVED whether
// list supports group_by," and this plan's standing "flag it, don't
// invent" rule means the safe choice here is not supporting it: there is no
// group-by UI anywhere in this file, and ListView.test.tsx asserts that
// absence directly (not just an absence of code to review).
//
// M12 (row-affordances.md's own "List view" section, live-captured
// 2026-09-02): this used to be a plain always-expanded row (title + every
// OTHER property shown inline, always). That doesn't match Notion — a List
// row shows ONLY its title at rest, REGARDLESS of whether other properties
// have values (confirmed live: a row with a Select value already set still
// showed nothing but its title until Edit was clicked). Rebuilt around
// that: `RowGutter` (checkbox suppressed — List's own gutter has only `+`
// and the drag handle, confirmed by DOM query, no checkbox anywhere), the
// row peek (`useRowPeek`, shared with every other M12 view now, not a
// second copy — a plain click opens it directly since the row link itself
// IS the open control, unlike Table's separate OPEN button), and a new
// per-row "Edit" toggle with no Table equivalent: it turns the title
// inline-editable AND reveals this view's other VISIBLE (Property
// Visibility, `hidden_properties`) properties as quick-fill chips on the
// same line — Table never needs this since every cell there is already
// independently click-to-edit, but List's one-line layout has nowhere to
// show untitled properties at rest.
import { useState } from "react";
import { FileText, Pencil, Plus } from "lucide-react";
import { useToast } from "@/app/providers";
import type { DatabaseRow, PropertyResponse, PropertyValue, TitleValue } from "@/lib/database/types";
import { getHiddenKeys, getShowPageIcon, orderProperties } from "@/lib/database/viewConfig";
import { useRowPeek } from "@/lib/database/useRowPeek";
import { renderCellValue } from "../cells/renderCellValue";
import { RowGutter } from "../RowGutter";
import { RowPeek } from "../RowPeek";

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

export interface ListViewProps {
  properties: PropertyResponse[];
  rows: DatabaseRow[];
  editable: boolean;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  /** `view.config` — needed for `hidden_properties`/`property_order` (which
   * properties Edit reveals, and in what order), `show_page_icon`, and
   * `useRowPeek`'s own "Open pages in" read. Optional only so a stale
   * caller (or a future test that doesn't care about any of this) degrades
   * to "nothing hidden, page icon on, peek defaults to side" rather than
   * crashing — same convention M1's ColumnHeader props already established. */
  config?: Record<string, unknown>;
  /** Row-add (the gutter's `+`, and the bottom "+ New page") needs the data
   * source id the same way every other view's own row-add does. */
  dataSourceId?: string;
  refetchRows?: () => void | Promise<void>;
  /** RowPeek's own "+ Add a property" writes schema — threaded through
   * exactly like TableView's own `refetch` does. */
  refetch?: () => void | Promise<void>;
}

export function ListView({
  properties,
  rows,
  editable,
  onCellChange,
  config = {},
  dataSourceId,
  refetchRows,
  refetch,
}: ListViewProps) {
  const { showToast } = useToast();
  const { peekRowId, peekMode, openRow, closePeek, handleRowAltClick } = useRowPeek(config);
  // Single-row selection, not a `Set` — row-affordances-list-view.txt's own
  // "Not verified" section: multi-row bulk selection was never confirmed to
  // exist in List at all (no checkbox, and never tested with two rows
  // selected at once), so this only tracks what WAS observed — one row
  // visibly tinted after its menu opens — rather than assuming Table's
  // richer shape transfers unverified.
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [rowSubmitting, setRowSubmitting] = useState(false);

  const titleProp = properties.find((p) => p.type === "title");
  const hidden = new Set(getHiddenKeys(config));
  const otherProps = orderProperties(properties, config).filter((p) => p.type !== "title" && !hidden.has(p.key));
  const showPageIcon = getShowPageIcon(config);

  async function handleAddRow() {
    if (!dataSourceId || rowSubmitting) return;
    setRowSubmitting(true);
    try {
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/rows`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      await refetchRows?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add row", "error");
    } finally {
      setRowSubmitting(false);
    }
  }

  function startEdit(row: DatabaseRow) {
    const titleValue = titleProp ? (row.properties[titleProp.key] as TitleValue | undefined)?.title : undefined;
    setTitleDraft(titleValue ?? "");
    setEditingRowId(row.id);
  }

  /** Commits the title draft — does NOT exit edit mode itself. `handleRowBlur`
   * below owns that: this used to close on the title input's own `onBlur`,
   * which fired (and unmounted the row's whole "editing" block, including the
   * quick-fill properties next to it) on every mousedown BEFORE a click
   * landed anywhere else in the same row — the identical "trigger swaps
   * mid-interaction, dismiss logic wins the race" class M11's cell-editing
   * session already found twice (AddPropertyPopover, SelectCell). Live-caught
   * here: clicking a revealed property's own "Empty" placeholder right after
   * typing a title never worked, the row collapsed back to read-only first. */
  function commitTitle(rowId: string) {
    if (!titleProp) return;
    onCellChange(rowId, titleProp.key, { type: "title", title: titleDraft });
  }

  /** Exits edit mode only when focus actually leaves the ROW, not just the
   * title input — `e.relatedTarget` is the element about to receive focus;
   * if it's still inside this row (e.g. a revealed property's own editor),
   * editing stays open. */
  function handleRowBlur(e: React.FocusEvent<HTMLDivElement>, rowId: string) {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (editingRowId === rowId) setEditingRowId(null);
  }

  const peekRow = peekRowId ? rows.find((r) => r.id === peekRowId) : undefined;

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-gray-400 dark:text-gray-500">
        No rows yet.
      </div>
    );
  }

  return (
    <div className="overflow-auto h-full">
      {rows.map((row) => {
        const titleValue = titleProp
          ? (row.properties[titleProp.key] as TitleValue | undefined)?.title
          : undefined;
        const isEditing = editingRowId === row.id;
        return (
          <div
            key={row.id}
            onClick={handleRowAltClick(row.id)}
            onBlur={(e) => handleRowBlur(e, row.id)}
            className={`group flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 ${
              selectedRowId === row.id ? "bg-indigo-50/70 dark:bg-indigo-950/40" : ""
            }`}
          >
            {editable && (
              <RowGutter
                rowId={row.id}
                selected={selectedRowId === row.id}
                onToggleSelected={(id) => setSelectedRowId((prev) => (prev === id ? null : id))}
                onAddRow={handleAddRow}
                onOpenSidePeek={(id) => openRow(id, "side")}
                onTrashed={() => refetchRows?.()}
                showCheckbox={false}
              />
            )}
            {showPageIcon && <FileText size={12} className="shrink-0 text-gray-300 dark:text-gray-600" aria-hidden />}
            {isEditing ? (
              <input
                autoFocus
                aria-label="Title"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={() => commitTitle(row.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitTitle(row.id);
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Escape") setEditingRowId(null);
                }}
                className="min-w-0 flex-1 rounded border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-gray-900 px-1 -mx-1 text-sm font-medium text-gray-900 dark:text-gray-100 outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => openRow(row.id)}
                className="min-w-0 truncate text-left text-sm font-medium text-gray-900 dark:text-gray-100 hover:underline"
              >
                {titleValue || <span className="font-normal text-gray-400">Untitled</span>}
              </button>
            )}
            {editable && (
              <button
                type="button"
                aria-label="Edit"
                onClick={() => (isEditing ? setEditingRowId(null) : startEdit(row))}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-gray-600 group-hover:opacity-100 dark:hover:bg-gray-800 dark:hover:text-gray-300"
              >
                <Pencil size={12} />
              </button>
            )}
            {isEditing && otherProps.length > 0 && (
              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-4">
                {otherProps.map((p) => (
                  <div key={p.key} className="flex items-center gap-1 text-xs">
                    <span className="shrink-0 text-gray-400">{p.name}:</span>
                    <span className="min-w-0">
                      {renderCellValue(p, row.properties[p.key], editable, (value) =>
                        onCellChange(row.id, p.key, value)
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {editable && (
        <button
          type="button"
          onClick={handleAddRow}
          disabled={rowSubmitting}
          className="flex w-full items-center gap-1 px-3 py-2 text-left text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40 dark:hover:text-gray-300"
        >
          <Plus size={12} /> New page
        </button>
      )}

      {peekRow && (
        <RowPeek
          row={peekRow}
          properties={properties}
          editable={editable}
          onCellChange={onCellChange}
          onClose={closePeek}
          mode={peekMode === "center" ? "center" : "side"}
          dataSourceId={dataSourceId}
          onPropertyCreated={refetch}
        />
      )}
    </div>
  );
}
