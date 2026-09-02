"use client";

// M3's view toolbar (view-options-panel.md's "Establish the whole toolbar
// first, because we have none of it") — Filter · Sort · Automations ·
// AI Autofill · Search · Settings, at the right of the view-tabs row.
//
// Filter and Sort reuse the EXACT SAME MenuPanel data ViewSettingsSidebar
// pushes for its own Filter/Sort rows (`filterPanel` from FilterBuilder.tsx,
// `sortPanel` exported from ViewSettingsSidebar.tsx) — hosted here as a
// popover flyout instead of a pushed sidebar panel. Two entry points, one
// panel-as-data, which is the whole argument for building panels this way.
//
// Automations reuses the existing AutomationManager modal directly rather
// than growing a second entry point's worth of bespoke UI. AI Autofill and
// Search have no real surface behind them yet (AI Autofill: out of scope for
// this app; Search: view-options-panel.md marks it TBD) — both disabled with
// a reason, the "disabled, not missing" convention this branch uses
// everywhere else for the same situation.
import { forwardRef, useState } from "react";
import { ArrowUpDown, Filter as FilterIcon, Search as SearchIcon, Settings, Sparkles, Wand2 } from "lucide-react";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { AutomationPatch, AutomationResponse, PropertyResponse, ViewResponse } from "@/lib/database/types";
import type { Sort, SortsUpdater } from "@/lib/database/viewConfig";
import { asFilterNode, countConditions } from "@/lib/database/filterAst";
import { sortPanel } from "./ViewSettingsSidebar";
import { filterPanel, type FilterUpdater } from "./FilterBuilder";
import { AutomationManager } from "./AutomationManager";

function asSorts(raw: unknown[]): Sort[] {
  return raw.filter(
    (s): s is Sort =>
      Boolean(s) &&
      typeof s === "object" &&
      typeof (s as Sort).property === "string" &&
      ((s as Sort).direction === "asc" || (s as Sort).direction === "desc")
  );
}

export interface ViewToolbarProps {
  view: ViewResponse;
  properties: PropertyResponse[];
  onSetSorts: (updater: SortsUpdater) => void;
  onSetFilter: (updater: FilterUpdater) => void;
  dataSourceId: string;
  automations: AutomationResponse[];
  onCreateAutomation: (name: string) => Promise<AutomationResponse>;
  onUpdateAutomation: (id: string, patch: AutomationPatch) => Promise<AutomationResponse>;
  onDeleteAutomation: (id: string) => Promise<void>;
  onOpenSettings: () => void;
}

// `forwardRef` AND spreading `...rest` are both required, not cosmetic: the
// Filter/Sort buttons are Radix `Popover.Trigger asChild` anchors, and
// `Slot` clones this element with its own `ref` (for floating-ui's
// position computation) and `onClick`/`aria-*`/`data-*` props merged on. A
// plain function component that only destructures its own named props
// drops the ref entirely -- React silently ignores a `ref` passed to a
// non-forwardRef function component -- so floating-ui had no anchor rect to
// measure and the popover rendered at Radix's pre-measurement placeholder
// position (`translate(0, -200%)`), hundreds of pixels above the viewport,
// forever. Same root cause and fix as `DropdownButton` (SortRowsList.tsx)
// and `TriggerButton` (FilterBuilder.tsx); this one just never got the
// live-checklist repro to catch it (masked as "the automation session's own
// off-screen-render artifact" in an earlier session, since the popover DID
// open -- just not where anyone could see it).
const ToolbarButton = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    icon: React.ReactNode;
    disabledReason?: string;
  }
>(function ToolbarButton({ label, icon, disabled, disabledReason, className = "", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={disabled ? disabledReason : label}
      disabled={disabled}
      {...rest}
      className={`flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-gray-800 dark:hover:text-gray-300 ${className}`}
    >
      {icon}
    </button>
  );
});

export function ViewToolbar({
  view,
  properties,
  onSetSorts,
  onSetFilter,
  dataSourceId,
  automations,
  onCreateAutomation,
  onUpdateAutomation,
  onDeleteAutomation,
  onOpenSettings,
}: ViewToolbarProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const sorts = asSorts(view.sorts ?? []);
  const ruleCount = countConditions(asFilterNode(view.filter));

  return (
    <div className="ml-auto flex items-center gap-0.5" role="toolbar" aria-label="View toolbar">
      <Popover
        open={filterOpen}
        onOpenChange={setFilterOpen}
        width="sm"
        label="Filter"
        trigger={
          <ToolbarButton
            label={ruleCount === 1 ? "1 rule" : ruleCount > 1 ? `${ruleCount} rules` : "Filter"}
            icon={<FilterIcon size={14} />}
          />
        }
      >
        <MenuList
          root={filterPanel(properties, view.filter, onSetFilter)}
          nav="flyout"
          onClose={() => setFilterOpen(false)}
          label="Filter"
        />
      </Popover>

      <Popover
        open={sortOpen}
        onOpenChange={setSortOpen}
        width="sm"
        label="Sort"
        trigger={
          <ToolbarButton
            label={
              sorts.length === 1
                ? `Sort: ${properties.find((p) => p.key === sorts[0].property)?.name ?? sorts[0].property}`
                : sorts.length > 1
                  ? `${sorts.length} sorts`
                  : "Sort"
            }
            icon={<ArrowUpDown size={14} />}
          />
        }
      >
        <MenuList
          root={sortPanel(properties, sorts, onSetSorts)}
          nav="flyout"
          onClose={() => setSortOpen(false)}
          label="Sort"
        />
      </Popover>

      <ToolbarButton
        label="Automations"
        icon={<Wand2 size={14} />}
        onClick={() => setAutomationsOpen(true)}
      />

      <ToolbarButton label="AI Autofill" icon={<Sparkles size={14} />} disabled disabledReason="Out of scope for this app" />

      <ToolbarButton label="Search" icon={<SearchIcon size={14} />} disabled disabledReason="In-view search isn't available yet" />

      <ToolbarButton label="Settings" icon={<Settings size={14} />} onClick={onOpenSettings} />

      <AutomationManager
        open={automationsOpen}
        onClose={() => setAutomationsOpen(false)}
        automations={automations}
        properties={properties}
        dataSourceId={dataSourceId}
        onCreateAutomation={onCreateAutomation}
        onUpdateAutomation={onUpdateAutomation}
        onDeleteAutomation={onDeleteAutomation}
      />
    </div>
  );
}
