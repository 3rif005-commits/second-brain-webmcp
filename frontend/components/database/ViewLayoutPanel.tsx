"use client";

// M3's "Layout" sub-panel (view-options-panel.md §A): the 3x3 view-type
// grid, three display toggles, and "Open pages in".
//
// Custom content rather than MenuRow[] for the WHOLE panel (not just the
// grid) so ordering stays exactly card-grid -> toggles -> Open pages in —
// splitting toggles into `MenuSection.rows` would have forced them into a
// second section, and MenuList draws a divider between sections that this
// panel's own capture (layout-and-open-pages-in.txt) doesn't show. "Open
// pages in" still reuses MenuList/MenuPanel for ITS OWN popover, though —
// see below — that one gets `description`/`annotation`/`checked` for free.
import { useState } from "react";
import {
  BarChart3,
  Calendar,
  Expand,
  GalleryHorizontal,
  GanttChartSquare,
  Kanban,
  LayoutDashboard,
  List,
  PanelRight,
  Rss,
  Square,
  Table2,
} from "lucide-react";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { MenuPanel } from "@/components/ui/primitives";
import {
  getOpenPagesInMode,
  getShowPageIcon,
  getShowVerticalLines,
  getWrapAllContent,
  patchOpenPagesInMode,
  patchShowPageIcon,
  patchShowVerticalLines,
  patchWrapAllContent,
} from "@/lib/database/viewConfig";
import type { OpenPagesInMode } from "@/lib/database/viewConfig";

// Notion's own grid here is Table/Board/Timeline/Calendar/List/Gallery/
// Chart/Feed/Map (layout-and-open-pages-in.txt) — 9 cards. We cut Map
// (deliberate, whole-milestone decision: no geocoding/tile provider) and, to
// keep the SAME 3x3 shape the checklist tests for, fill its slot with
// Dashboard — one of our own 10 types Notion's own grid here doesn't carry
// (Notion also lacks Form here; we leave Form out too, for the same "this
// grid isn't the exhaustive type list" reason).
const GRID_TYPES: { type: string; label: string; icon: React.ReactNode }[] = [
  { type: "table", label: "Table", icon: <Table2 size={18} /> },
  { type: "board", label: "Board", icon: <Kanban size={18} /> },
  { type: "timeline", label: "Timeline", icon: <GanttChartSquare size={18} /> },
  { type: "calendar", label: "Calendar", icon: <Calendar size={18} /> },
  { type: "list", label: "List", icon: <List size={18} /> },
  { type: "gallery", label: "Gallery", icon: <GalleryHorizontal size={18} /> },
  { type: "chart", label: "Chart", icon: <BarChart3 size={18} /> },
  { type: "feed", label: "Feed", icon: <Rss size={18} /> },
  { type: "dashboard", label: "Dashboard", icon: <LayoutDashboard size={18} /> },
];

const MODE_LABEL: Record<OpenPagesInMode, string> = {
  side: "Side peek",
  center: "Center peek",
  full: "Full page",
};

function openPagesInPanel(mode: OpenPagesInMode, onSelect: (mode: OpenPagesInMode) => void): MenuPanel {
  return {
    width: "sm",
    sections: [
      {
        rows: [
          {
            id: "side",
            icon: <PanelRight size={14} />,
            label: "Side peek",
            checked: mode === "side",
            description: "Open pages on the side. Keeps the view behind interactive.",
            // Always shown on this row, not only when it's also the current
            // selection — it names a property OF the row ("this is the
            // default"), not of the current state. layout-and-open-pages-
            // in.txt's own capture happened to show both at once, which
            // doesn't establish the annotation is conditional on `checked`.
            annotation: { label: "Default for Table" },
            onSelect: () => onSelect("side"),
          },
          {
            id: "center",
            icon: <Square size={14} />,
            label: "Center peek",
            checked: mode === "center",
            description: "Open pages in a focused, centered modal.",
            onSelect: () => onSelect("center"),
          },
          {
            id: "full",
            icon: <Expand size={14} />,
            label: "Full page",
            checked: mode === "full",
            description: "Open pages in full page.",
            onSelect: () => onSelect("full"),
          },
        ],
      },
    ],
  };
}

export interface ViewLayoutPanelProps {
  viewType: string;
  config: Record<string, unknown>;
  onPatchConfig: (patch: Record<string, unknown>) => void;
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex min-h-menu-row w-full items-center gap-2 px-2 text-left hover:bg-menu-hover"
    >
      <span className="flex-1">{label}</span>
      <span
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`h-3.5 w-6 rounded-full ${checked ? "bg-brand" : "bg-menu-divider"}`}
      />
    </button>
  );
}

export function ViewLayoutPanel({ viewType, config, onPatchConfig }: ViewLayoutPanelProps) {
  const [openPagesInOpen, setOpenPagesInOpen] = useState(false);
  const showVerticalLines = getShowVerticalLines(config);
  const showPageIcon = getShowPageIcon(config);
  const wrapAllContent = getWrapAllContent(config);
  const openPagesInMode = getOpenPagesInMode(config);

  return (
    <div className="flex flex-col gap-1 pb-1">
      <div className="grid grid-cols-3 gap-1.5 px-2 pb-2">
        {GRID_TYPES.map((card) => {
          const selected = card.type === viewType;
          return (
            <button
              key={card.type}
              type="button"
              disabled={!selected}
              // Changing a view's type has no endpoint yet (ViewUpdate has
              // no `type` field) — greyed with a reason, the same
              // "disabled, not missing" convention Filter/Group rows use
              // elsewhere on this branch, rather than a click that silently
              // does nothing.
              title={selected ? undefined : "Changing the view type isn't supported yet"}
              className={`flex flex-col items-center gap-1 rounded-md border px-2 py-2.5 text-[12px] ${
                selected
                  ? "border-brand text-brand"
                  : "cursor-not-allowed border-transparent text-menu-disabled"
              }`}
            >
              {card.icon}
              {card.label}
            </button>
          );
        })}
      </div>

      <ToggleRow
        label="Show vertical lines"
        checked={showVerticalLines}
        onChange={(next) => onPatchConfig(patchShowVerticalLines(config, next))}
      />
      <ToggleRow
        label="Show page icon"
        checked={showPageIcon}
        onChange={(next) => onPatchConfig(patchShowPageIcon(config, next))}
      />
      <ToggleRow
        label="Wrap all content"
        checked={wrapAllContent}
        onChange={(next) => onPatchConfig(patchWrapAllContent(config, next))}
      />

      <Popover
        open={openPagesInOpen}
        onOpenChange={setOpenPagesInOpen}
        // "Overlaying the panel, anchored to its row" (view-options-panel.md
        // §C) — not a side flyout, so this deliberately leaves `side` at the
        // Popover default ("bottom"), which lands the popover directly
        // beneath the row it's anchored to rather than beside the (483px,
        // right-docked) sidebar where a `side="left"`/`"right"` flyout would
        // risk running off-screen.
        align="start"
        width="sm"
        label="Open pages in"
        trigger={
          <button
            type="button"
            className="flex min-h-menu-row w-full items-center gap-2 px-2 text-left hover:bg-menu-hover"
          >
            <span className="flex-1">Open pages in</span>
            <span className="text-menu-disabled">{MODE_LABEL[openPagesInMode]}</span>
            <span aria-hidden className="text-menu-disabled">
              ›
            </span>
          </button>
        }
      >
        <MenuList
          root={openPagesInPanel(openPagesInMode, (mode) => {
            onPatchConfig(patchOpenPagesInMode(config, mode));
          })}
          nav="flyout"
          onClose={() => setOpenPagesInOpen(false)}
          label="Open pages in"
        />
      </Popover>
    </div>
  );
}
