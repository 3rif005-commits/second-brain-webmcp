"use client";

// M10 (row-peek.md) extracted for reuse by M12 — this used to live only inside
// TableView.tsx; every other view needs the IDENTICAL "?p=<noteId>&pm=s|c" URL
// sync, open/close, and Alt+Click/forced-side-peek behavior, not a second copy
// per view. Behavior is unchanged from TableView's own pre-extraction version.
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useOpenNote } from "./useOpenNote";
import { getOpenPagesInMode } from "./viewConfig";

export interface RowPeekControls {
  peekRowId: string | null;
  peekMode: "side" | "center" | null;
  /** Respects the view's "Open pages in" default (including "full", which
   * bypasses the peek entirely via `useOpenNote`) unless `forcedMode` is
   * given — the row menu's "Open in -> Side peek" and Alt+Click both force
   * "side", bypassing the view default entirely (row-peek.md's Trigger table). */
  openRow: (noteId: string, forcedMode?: "side") => void;
  closePeek: () => void;
  /** OpenNoteButton's `isOpen` toggle: clicking OPEN/CLOSE on the row whose
   * peek is already open closes it instead of re-opening the same row. */
  toggleRow: (noteId: string) => void;
  /** Bind on a row's outer element: `onClick={handleRowAltClick(row.id)}`. */
  handleRowAltClick: (rowId: string) => (e: React.MouseEvent) => void;
}

export function useRowPeek(config: Record<string, unknown>): RowPeekControls {
  const openNote = useOpenNote();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [peekRowId, setPeekRowId] = useState<string | null>(() => searchParams.get("p"));
  const [peekMode, setPeekMode] = useState<"side" | "center" | null>(() => {
    const pm = searchParams.get("pm");
    return pm === "c" ? "center" : pm === "s" ? "side" : null;
  });

  const openPagesInMode = getOpenPagesInMode(config);

  function writePeekUrl(noteId: string | null, mode: "side" | "center" | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (noteId) {
      params.set("p", noteId);
      params.set("pm", mode === "center" ? "c" : "s");
    } else {
      params.delete("p");
      params.delete("pm");
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function openRow(noteId: string, forcedMode?: "side") {
    if (!forcedMode && openPagesInMode === "full") {
      openNote(noteId);
      return;
    }
    const mode = forcedMode ?? (openPagesInMode === "center" ? "center" : "side");
    setPeekRowId(noteId);
    setPeekMode(mode);
    writePeekUrl(noteId, mode);
  }

  function closePeek() {
    setPeekRowId(null);
    setPeekMode(null);
    writePeekUrl(null, null);
  }

  function toggleRow(noteId: string) {
    if (peekRowId === noteId) closePeek();
    else openRow(noteId);
  }

  function handleRowAltClick(rowId: string) {
    return (e: React.MouseEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      openRow(rowId, "side");
    };
  }

  return { peekRowId, peekMode, openRow, closePeek, toggleRow, handleRowAltClick };
}
