"use client";

// M7 — a view's own menu (view-tab-bar.md). Opens on clicking the ACTIVE
// tab (clicking an inactive tab just switches, per the spec's own trigger
// table).
//
// TWO THINGS THAT LOOK LIKE MISTAKES BUT ARE NOT:
//
//  1. THERE IS NO HEADER RENAME FIELD HERE. Unlike the column header menu
//     (M1) and the view settings sidebar (M3), Notion's own capture shows a
//     "Rename" ROW in this specific menu, with no sub-panel — the view
//     settings sidebar ALSO renames via its own header input. Both exist;
//     Notion is inconsistent here on purpose (per the spec), so this one
//     drives the TAB's own inline edit instead of carrying an input itself.
//  2. "Add view to sidebar" IS DELIBERATELY ABSENT, not disabled. We have no
//     per-view sidebar entries at all — the spec calls this out by name as a
//     row to omit rather than ship dead ("Omit deliberately and say so").
import { Copy, Eye, Palette, Settings, SquarePen, Table2, Trash2 } from "lucide-react";
import type { MenuPanel, MenuRow } from "@/components/ui/primitives";
import type { ViewTabDisplayAs } from "@/lib/database/viewTabPrefs";

export interface ViewTabMenuArgs {
  viewCount: number;
  dataSourceName: string;
  displayAs: ViewTabDisplayAs;
  onSetDisplayAs: (mode: ViewTabDisplayAs) => void;
  onRename: () => void;
  onEditView: () => void;
  onCopyLink: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

const DISPLAY_AS_LABELS: { value: ViewTabDisplayAs; label: string }[] = [
  { value: "text_and_icon", label: "Text and icon" },
  { value: "text_only", label: "Text only" },
  { value: "icon_only", label: "Icon only" },
];

export function buildViewTabMenu(args: ViewTabMenuArgs): MenuPanel {
  const { viewCount, dataSourceName, displayAs, onSetDisplayAs, onRename, onEditView, onCopyLink, onDuplicate, onDelete } =
    args;

  const rows: MenuRow[] = [
    {
      id: "rename",
      icon: <SquarePen size={14} />,
      label: "Rename",
      onSelect: onRename,
    },
    {
      id: "display-as",
      icon: <Palette size={14} />,
      label: "Display as",
      submenu: () => ({
        sections: [
          {
            rows: DISPLAY_AS_LABELS.map((opt) => ({
              id: opt.value,
              label: opt.label,
              checked: displayAs === opt.value,
              onSelect: () => onSetDisplayAs(opt.value),
            })),
          },
        ],
        footer: <span className="italic">Only applies to you</span>,
      }),
    },
    {
      id: "edit-view",
      icon: <Settings size={14} />,
      label: "Edit view",
      onSelect: onEditView,
    },
    {
      id: "source",
      icon: <Table2 size={14} />,
      label: "Source",
      value: dataSourceName,
      // Observed-but-unexplained state change between one and two views
      // (view-tab-bar.md's own note) — re-capture before encoding a rule
      // from two data points. This app has exactly one data source per
      // database regardless, so the "active" state below is informational
      // only, never a real picker.
      disabled: viewCount < 2,
      disabledReason: "Managing multiple data sources isn't available here yet",
      submenu:
        viewCount >= 2
          ? () => ({
              sections: [{ rows: [{ id: "current-source", label: dataSourceName, checked: true }] }],
            })
          : undefined,
    },
  ];

  const copyRows: MenuRow[] = [
    {
      id: "copy-link",
      icon: <Copy size={14} />,
      label: "Copy link to view",
      onSelect: onCopyLink,
    },
  ];

  const structuralRows: MenuRow[] = [
    {
      id: "duplicate",
      icon: <Eye size={14} />,
      label: "Duplicate view",
      onSelect: onDuplicate,
    },
  ];

  // "Delete view is present iff view count > 1" — the row is ABSENT, not
  // disabled, matching the spec's own table (M9's row-affordances.md
  // establishes the same hidden-not-disabled convention for a row that is
  // genuinely inapplicable, not merely unavailable right now).
  if (viewCount > 1) {
    structuralRows.push({
      id: "delete",
      icon: <Trash2 size={14} />,
      label: "Delete view",
      danger: true,
      onSelect: onDelete,
    });
  }

  return {
    sections: [{ rows }, { rows: copyRows }, { rows: structuralRows }],
  };
}
