"use client";

// A small, explicit "open the note" affordance for card-based views whose
// cards already have a competing click behavior on their main content:
// Board cards are dnd-kit drag handles over their *entire* surface, and
// both Board and Gallery cards render their title through TitleCell, whose
// own click toggles inline editing. Making the whole card (or the title)
// double as "click to open" would fire both behaviors at once on the same
// click (start a drag, or start editing, *and* navigate away) — this is a
// separate, small, always-visible control instead, mirroring the "hover to
// reveal Open" affordance Notion itself uses on gallery/board cards for the
// same reason.
//
// List/Feed don't need this: their titles are always plain read-only text
// (no TitleCell, no inline-edit competing click), so clicking the title
// itself is unambiguous there — see ListView.tsx/FeedView.tsx.
//
// `onPointerDown`/`onClick` both call `stopPropagation()`: BoardCard spreads
// dnd-kit's `listeners` (pointer-down-driven) across the *entire* outer
// card div this button lives inside, so without stopping propagation a
// click here would also register as the start of a (zero-distance, so
// harmless) drag gesture — cheap to prevent outright rather than rely on
// dnd-kit's activation-distance threshold to absorb it.
//
// `onOpen` (optional, controller addition): TableView opens a `RowPeek`
// (a side panel showing properties + body over the table, matching
// Notion's own default row-click behavior) instead of navigating straight
// to the Workspace route every other view still does — see RowPeek.tsx.
// Every existing caller (Board/Gallery) omits this prop and keeps today's
// exact navigate-to-Workspace behavior unchanged.
import { useOpenNote } from "@/lib/database/useOpenNote";

interface OpenNoteButtonProps {
  noteId: string;
  className?: string;
  onOpen?: (noteId: string) => void;
  /** M9 (row-affordances.md): TableView's row peek toggle. "OPEN is a
   * LABELLED button — an icon plus the word OPEN, right-aligned... While
   * the peek is open it becomes CLOSE." Every other caller (Board/Gallery)
   * omits this and keeps the pre-M9 icon-only rendering unchanged. */
  isOpen?: boolean;
}

export function OpenNoteButton({ noteId, className = "", onOpen, isOpen }: OpenNoteButtonProps) {
  const openNote = useOpenNote();
  const labelled = isOpen !== undefined;

  return (
    <button
      type="button"
      aria-label={labelled ? (isOpen ? "Close" : "Open") : "Open note"}
      title={labelled ? (isOpen ? "Close" : "Open") : "Open note"}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        (onOpen ?? openNote)(noteId);
      }}
      className={`inline-flex items-center gap-1 justify-center rounded p-1 bg-white/80 dark:bg-gray-900/80 text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-white dark:hover:bg-gray-900 ${className}`}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
      </svg>
      {labelled && <span className="text-[10px] font-medium uppercase">{isOpen ? "Close" : "Open"}</span>}
    </button>
  );
}
