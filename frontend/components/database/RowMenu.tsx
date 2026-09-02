"use client";

// M9 — a row's own menu (row-affordances.md). Triggered by the drag handle
// in the row gutter (RowGutter.tsx); right-click anywhere on the row opens
// the SAME menu (there is no separate context menu in this codebase, matching
// live Notion's own capture).
//
// Scoped against what this app can actually do without a new backend
// endpoint (the milestone's own "row-affordances is UI-only" assumption
// turned out to be half right, same as M8's creation modal did — Duplicate
// genuinely needs one, gap B4, not built this session):
//  - Edit icon: disabled. `notes.icon` exists and PATCHes fine, but the ROWS
//    query (`DatabaseRow`) doesn't return it, so there's nothing to render
//    back — wiring the write with no way to see the result would look
//    broken, not shipped.
//  - Edit property: disabled — row-affordances.md's own spec marks this
//    TBD, not captured.
//  - Comment: disabled — no comment composer exists anywhere in this app.
//  - Duplicate: disabled — needs gap B4 (copying the page body isn't
//    possible client-side), not built this session.
//  - Move to: omitted entirely (not disabled) — no page tree to move a row
//    into, matching the spec's own "omit, and say so" instruction for a
//    genuinely inapplicable row (same convention as M7's "Add view to
//    sidebar").
import { Bookmark, Copy, ExternalLink, ListTree, MessageSquare, SidebarOpen, SlidersHorizontal, Smile, Trash2 } from "lucide-react";
import type { MenuPanel, MenuRow } from "@/components/ui/primitives";

export interface RowMenuArgs {
  onFavorite: () => void;
  onOpenNewTab: () => void;
  onOpenSidePeek: () => void;
  onCopyLink: () => void;
  onMoveToTrash: () => void;
}

export function buildRowMenu(args: RowMenuArgs): MenuPanel {
  const { onFavorite, onOpenNewTab, onOpenSidePeek, onCopyLink, onMoveToTrash } = args;

  const pageRows: MenuRow[] = [
    { id: "favorite", icon: <Bookmark size={14} />, label: "Add to Favorites", onSelect: onFavorite },
    {
      id: "edit-icon",
      icon: <Smile size={14} />,
      label: "Edit icon",
      disabled: true,
      disabledReason: "Per-row icons aren't shown in this view yet",
    },
    {
      id: "edit-property",
      icon: <SlidersHorizontal size={14} />,
      label: "Edit property",
      disabled: true,
      disabledReason: "Not available yet",
    },
    {
      id: "open-in",
      icon: <ExternalLink size={14} />,
      label: "Open in",
      submenu: () => ({
        sections: [
          {
            rows: [
              { id: "new-tab", icon: <ExternalLink size={14} />, label: "New tab", hint: "Ctrl+⇧+↵", onSelect: onOpenNewTab },
              { id: "side-peek", icon: <SidebarOpen size={14} />, label: "Side peek", hint: "Alt+Click", onSelect: onOpenSidePeek },
            ],
          },
        ],
      }),
    },
    {
      id: "comment",
      icon: <MessageSquare size={14} />,
      label: "Comment",
      hint: "Ctrl+⇧+M",
      disabled: true,
      disabledReason: "Comments aren't available yet",
    },
  ];

  const linkRows: MenuRow[] = [
    { id: "copy-link", icon: <Copy size={14} />, label: "Copy link", onSelect: onCopyLink },
    {
      id: "duplicate",
      icon: <ListTree size={14} />,
      label: "Duplicate",
      hint: "Ctrl+D",
      disabled: true,
      disabledReason: "Duplicating a row isn't available yet",
    },
    {
      id: "trash",
      icon: <Trash2 size={14} />,
      label: "Move to Trash",
      hint: "Del",
      danger: true,
      onSelect: onMoveToTrash,
    },
  ];

  return {
    search: { placeholder: "Search actions…" },
    width: "sm",
    sections: [
      { label: "Page", rows: pageRows },
      { rows: linkRows },
    ],
  };
}
