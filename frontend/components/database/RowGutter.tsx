"use client";

// M9 — the row's hover gutter (row-affordances.md): `+` (add a row),
// the drag handle (click opens the row menu AND selects the row — "the
// most easily-missed detail on the surface", per the spec), and the
// selection checkbox. Lives OUTSIDE the table's own columns, in a leading
// `<td>`/`<th>` TableView.tsx reserves so the gutter's hover-reveal never
// shifts row content — same reserved-space rule HoverAffordance already
// enforces for the database header's own hover row (M8).
//
// REAL DRAG-REORDER IS OUT OF SCOPE HERE. The plan's own milestone table
// gives row-drag mechanics to M11 (table-drag-resize.md: "the column-drag
// and row-drag drop indicators... blocks part of M11"), and there is no
// row-position/row-order storage anywhere in this schema yet regardless
// (view.config has no such field, unlike sorts/filter/group_by). So the
// handle here is a plain button carrying only the click gesture — opening
// the menu and selecting — not a dnd-kit `useSortable` handle.
import { useState } from "react";
import { GripVertical, Plus } from "lucide-react";
import { useToast } from "@/app/providers";
import { HoverAffordance, Popover, MenuList } from "@/components/ui/primitives";
import { noteWorkspacePath } from "@/lib/database/useOpenNote";
import { buildRowMenu } from "./RowMenu";

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

export interface RowGutterProps {
  rowId: string;
  selected: boolean;
  onToggleSelected: (rowId: string) => void;
  onAddRow: () => void;
  onOpenSidePeek: (rowId: string) => void;
  /** useDatabaseView's `refetchRows` — called after a successful trash. */
  onTrashed: () => void | Promise<void>;
  /** M12: List's own live capture (row-affordances.md's "List view"
   * section) confirmed List's gutter has only `+` and the drag handle —
   * no checkbox, unlike Table's three. Defaults `true` so every existing
   * Table caller is unaffected; a caller that passes `false` still gets
   * `onToggleSelected` fired by the drag handle's own click (for the
   * row's visual tint), it just renders no checkbox control for it. */
  showCheckbox?: boolean;
}

export function RowGutter({
  rowId,
  selected,
  onToggleSelected,
  onAddRow,
  onOpenSidePeek,
  onTrashed,
  showCheckbox = true,
}: RowGutterProps) {
  const { showToast } = useToast();
  const [menuOpen, setMenuOpen] = useState(false);

  async function favorite() {
    try {
      const res = await fetch(`/api/notes/${rowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_favorited: true }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      showToast("Added to Favorites", "info");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not favorite this row", "error");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}?p=${rowId}&pm=s`);
      showToast("Link copied to clipboard", "info");
    } catch {
      showToast("Could not copy the link", "error");
    }
  }

  async function moveToTrash() {
    try {
      const res = await fetch(`/api/notes/${rowId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorMessage(res));
      await onTrashed();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not move this row to Trash", "error");
    }
  }

  return (
    <div className="flex items-center gap-0.5">
      <HoverAffordance className="flex items-center gap-0.5">
        <button
          type="button"
          aria-label="Add a row below"
          title="Add a row"
          onClick={onAddRow}
          className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        >
          <Plus size={12} />
        </button>

        <Popover
          open={menuOpen}
          onOpenChange={setMenuOpen}
          label="Row options"
          trigger={
            <button
              type="button"
              aria-label="Row options"
              aria-haspopup="menu"
              onClick={() => onToggleSelected(rowId)}
              className="flex h-5 w-5 cursor-grab items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
            >
              <GripVertical size={12} />
            </button>
          }
        >
          <MenuList
            root={buildRowMenu({
              onFavorite: () => {
                setMenuOpen(false);
                favorite();
              },
              onOpenNewTab: () => {
                setMenuOpen(false);
                window.open(noteWorkspacePath(rowId), "_blank");
              },
              onOpenSidePeek: () => {
                setMenuOpen(false);
                onOpenSidePeek(rowId);
              },
              onCopyLink: () => {
                setMenuOpen(false);
                copyLink();
              },
              onMoveToTrash: () => {
                setMenuOpen(false);
                moveToTrash();
              },
            })}
            nav="flyout"
            onClose={() => setMenuOpen(false)}
            label="Row options"
          />
        </Popover>
      </HoverAffordance>

      {/* The checkbox itself stays hover-revealed UNLESS the row is already
        * selected — a selected row's checkbox must stay visible even after
        * the pointer leaves, or there would be no way to see (or undo) the
        * selection. */}
      {showCheckbox &&
        (selected ? (
          <input
            type="checkbox"
            aria-label="Select row"
            checked
            onChange={() => onToggleSelected(rowId)}
            className="h-3.5 w-3.5"
          />
        ) : (
          <HoverAffordance>
            <input
              type="checkbox"
              aria-label="Select row"
              checked={false}
              onChange={() => onToggleSelected(rowId)}
              className="h-3.5 w-3.5"
            />
          </HoverAffordance>
        ))}
    </div>
  );
}
