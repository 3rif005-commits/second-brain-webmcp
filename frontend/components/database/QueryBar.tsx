"use client";

// The persistent bar between the toolbar and the table body, once a sort or
// filter exists — sort-panel.md's "chip appears in the same bar as the
// filter chip, before it" and filter-panel.md's "[⧩ 1 rule ▾] [+ Filter]".
// Neither spec captured both existing at once, so the combined order here
// (sort chip(s), then the filter chip, then "+ Filter") is a synthesis of
// the two captures, not a third one — flagged, not invented from nothing.
//
// Renders nothing at all when there is neither a sort nor a filter — same
// "No filter -> no filter bar" rule filter-panel.md states, extended to
// "no sort either" since this bar is now shared.
import { forwardRef, useState } from "react";
import { ArrowUpDown, Filter as FilterIcon, Plus } from "lucide-react";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { PropertyResponse, ViewResponse } from "@/lib/database/types";
import type { SortsUpdater } from "@/lib/database/viewConfig";
import { asFilterNode, countConditions } from "@/lib/database/filterAst";
import { sortPanel } from "./ViewSettingsSidebar";
import { filterPanel, type FilterUpdater } from "./FilterBuilder";

function asSorts(raw: unknown[]) {
  return raw.filter(
    (s): s is { property: string; direction: "asc" | "desc" } =>
      Boolean(s) &&
      typeof s === "object" &&
      typeof (s as { property?: unknown }).property === "string" &&
      ((s as { direction?: unknown }).direction === "asc" || (s as { direction?: unknown }).direction === "desc")
  );
}

// `forwardRef` + `...rest`, same fix and same reason as `ToolbarButton`
// (ViewToolbar.tsx) and the two Radix-trigger fixes already made elsewhere
// in this codebase (`DropdownButton`, `TriggerButton`): this component is
// always used as a `Popover.Trigger asChild` anchor, so it needs to accept
// the `ref` Slot clones onto it for floating-ui's position computation.
// Without it, the click still worked (Slot's composed `onClick` merges into
// the props Chip already destructures) but the popover rendered at Radix's
// pre-measurement placeholder position -- hundreds of pixels off-screen.
const Chip = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: React.ReactNode }
>(function Chip({ label, icon, className = "", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800 ${className}`}
    >
      {icon}
      {label}
      <span aria-hidden>▾</span>
    </button>
  );
});

export interface QueryBarProps {
  view: ViewResponse;
  properties: PropertyResponse[];
  onSetSorts: (updater: SortsUpdater) => void;
  onSetFilter: (updater: FilterUpdater) => void;
}

export function QueryBar({ view, properties, onSetSorts, onSetFilter }: QueryBarProps) {
  const [sortOpen, setSortOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const sorts = asSorts(view.sorts ?? []);
  const ruleCount = countConditions(asFilterNode(view.filter));

  if (sorts.length === 0 && ruleCount === 0) return null;

  const sortLabel =
    sorts.length === 1
      ? `${sorts[0].direction === "asc" ? "↑" : "↓"} ${properties.find((p) => p.key === sorts[0].property)?.name ?? sorts[0].property}`
      : `⇅ ${sorts.length} sorts`;

  return (
    <div className="flex items-center gap-1.5 border-b border-gray-100 px-3 py-1.5 dark:border-gray-800">
      {sorts.length > 0 && (
        <Popover
          open={sortOpen}
          onOpenChange={setSortOpen}
          width="sm"
          label="Sort"
          side="bottom"
          align="start"
          trigger={<Chip label={sortLabel} icon={<ArrowUpDown size={11} />} />}
        >
          <MenuList
            root={sortPanel(properties, sorts, onSetSorts)}
            nav="flyout"
            onClose={() => setSortOpen(false)}
            label="Sort"
          />
        </Popover>
      )}

      {ruleCount > 0 && (
        <Popover
          open={filterOpen}
          onOpenChange={setFilterOpen}
          width="md"
          label="Filter"
          side="bottom"
          align="start"
          trigger={<Chip label={ruleCount === 1 ? "1 rule" : `${ruleCount} rules`} icon={<FilterIcon size={11} />} />}
        >
          <MenuList
            root={filterPanel(properties, view.filter, onSetFilter)}
            nav="flyout"
            onClose={() => setFilterOpen(false)}
            label="Filter"
          />
        </Popover>
      )}

      <FilterAddButton properties={properties} filter={view.filter} onSetFilter={onSetFilter} />
    </div>
  );
}

/** The bar's own "+ Filter" (filter-panel.md's row, shown once a filter
 * already exists). The spec's capture describes it re-opening the property
 * picker specifically; this reopens `filterPanel` instead, which resolves
 * to the advanced builder once a filter exists — strictly more capable (the
 * builder's own "+ Add filter rule" already covers "add another rule"), not
 * a missing behavior, but a deliberate deviation from the literal capture
 * rather than a guess at one. */
function FilterAddButton({
  properties,
  filter,
  onSetFilter,
}: {
  properties: PropertyResponse[];
  filter: Record<string, unknown> | null;
  onSetFilter: (updater: FilterUpdater) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width="sm"
      label="Add filter"
      side="bottom"
      align="start"
      trigger={
        <button
          type="button"
          aria-label="Add filter"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
        >
          <Plus size={11} /> Filter
        </button>
      }
    >
      <MenuList
        root={filterPanel(properties, filter, onSetFilter)}
        nav="flyout"
        onClose={() => setOpen(false)}
        label="Add filter"
      />
    </Popover>
  );
}
