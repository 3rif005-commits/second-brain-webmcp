"use client";

// M6 — the group panel (group-panel.md). Same shape as FilterBuilder.tsx/
// SortRowsList.tsx: a stage-1 property picker (MenuPanel data, reused by
// both the column header's "Group" row and this panel's own root), a
// stage-2 editor once a property is chosen. The per-group list (drag
// reorder + visibility, same DndContext/DragHandle pattern
// PropertyVisibilityPanel.tsx and SortRowsList.tsx already established)
// needs live component state, so it's a `MenuSection.content` React tree,
// not `MenuRow[]`.
import { useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Eye, EyeOff, HelpCircle, Trash2 } from "lucide-react";
import { DragHandle, MenuList, Popover } from "@/components/ui/primitives";
import type { MenuPanel, MenuRow } from "@/components/ui/primitives";
import type { Group, GroupBySpec, PropertyResponse } from "@/lib/database/types";
import { defaultGroupBySpec, isGroupablePropertyType } from "@/lib/database/types";
import { configuredOptions } from "@/lib/database/filterOperators";
import { pillStyleForOption } from "./cells/CellProps";
import { propertyTypeIcon } from "./ColumnHeaderMenu";

/** `group_by`'s own updater form — same "whole-value REPLACE, compute the
 * next value against whatever's latest, never a stale render-time prop"
 * contract `SortsUpdater`/`FilterUpdater` already document, and for the
 * identical reason: `group_by` lives inside `config` (mergeable at the
 * top level) but `GroupStageTwo`'s own writers (`Hide all`, the per-group
 * eye toggle, `Hide empty groups`, group order) each PATCH `group_by` as
 * one whole sub-object, built by spreading the CURRENT `group_by` — two
 * of those fired close together (before a re-render) both spread the SAME
 * stale snapshot, so the second one's spread silently drops whatever
 * sub-field the first one had just set. Live-verified reachable: `Hide
 * all` followed immediately by toggling `Hide empty groups` persisted
 * only the toggle, with `hidden_groups` gone entirely — the exact "second
 * write clobbers the first" bug class the M1-M3 review checkpoint already
 * fixed once for `sorts`, recurring here for `group_by`'s own sub-fields. */
export type GroupByUpdater = (current: GroupBySpec | undefined) => GroupBySpec | null;

/** `group.key` this module reserves for the implicit "no value" bucket —
 * mirrors `grouping._NO_VALUE_KEY` on the backend (`"__no_value__"`), not
 * re-derived from the label since `_NO_VALUE_LABEL` ("No value") is exactly
 * what this file overrides for display (spec: "the naming convention is a
 * UI concern"). */
const NO_VALUE_KEY = "__no_value__";

/** "No <PropertyName>" for the implicit empty bucket, the group's own label
 * (rendered as its own chip) for everything else — the backend produces the
 * bucket, this is purely a display override (group-panel.md). */
export function groupDisplayLabel(group: Group, property: PropertyResponse | undefined): string {
  if (group.key === NO_VALUE_KEY) return `No ${property?.name ?? "value"}`;
  return group.label;
}

/** Pure reorder logic — same "no dnd-kit simulation needed" convention
 * `reorderPropertyKeys`/`reorderSorts` already established. */
export function reorderGroups(order: string[], activeKey: string, overKey: string): string[] | null {
  if (activeKey === overKey) return null;
  const oldIdx = order.indexOf(activeKey);
  const newIdx = order.indexOf(overKey);
  if (oldIdx === -1 || newIdx === -1) return null;
  return arrayMove(order, oldIdx, newIdx);
}

/** Resolves the DISPLAY order for the Groups section: `group_order`
 * "alphabetical"/"reverse_alphabetical" sorts by label outright; "manual"
 * (the default) uses `group_order_manual` where present, falling any group
 * NOT listed there (a brand new option, or before any manual reorder ever
 * happened) to the end in the backend's own returned order. */
export function orderedGroups(groups: Group[], groupBy: GroupBySpec): Group[] {
  if (groupBy.group_order === "alphabetical") return [...groups].sort((a, b) => a.label.localeCompare(b.label));
  if (groupBy.group_order === "reverse_alphabetical") return [...groups].sort((a, b) => b.label.localeCompare(a.label));
  const manual = groupBy.group_order_manual;
  if (!manual || manual.length === 0) return groups;
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const ordered = manual.filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);
  const seen = new Set(manual);
  const remaining = groups.filter((g) => !seen.has(g.key));
  return [...ordered, ...remaining];
}

// ── Stage 1: property picker ────────────────────────────────────────────

function groupPropertyPicker(
  properties: PropertyResponse[],
  groupBy: GroupBySpec | undefined,
  onSelect: (property: PropertyResponse | null) => void
): MenuPanel {
  const alphabetical = [...properties].sort((a, b) => a.name.localeCompare(b.name));
  const rows: MenuRow[] = [
    { id: "none", label: "None", checked: !groupBy, onSelect: () => onSelect(null) },
    ...alphabetical
      // Files (and everything else `grouping._NOT_GROUPABLE` rejects) is
      // absent here entirely — contrast Filter/Sort, which include it.
      // Each panel keeps its own eligibility predicate (group-panel.md).
      .filter((p) => p.type !== "files")
      .map((p) => ({
        id: p.key,
        icon: propertyTypeIcon(p.type),
        label: p.name,
        checked: groupBy?.property_key === p.key,
        disabled: !isGroupablePropertyType(p.type),
        disabledReason: "This property type cannot be grouped by yet",
        onSelect: () => onSelect(p),
      })),
  ];
  return {
    title: groupBy ? "Group" : "Group by",
    search: { placeholder: "Search for a property…" },
    sections: [{ rows }],
  };
}

// ── §A: group ordering ──────────────────────────────────────────────────

function groupOrderPanel(
  groupBy: GroupBySpec,
  onChange: (order: GroupBySpec["group_order"]) => void
): MenuPanel {
  const current = groupBy.group_order ?? "manual";
  return {
    sections: [
      {
        rows: [
          { id: "manual", label: "Manual", checked: current === "manual", onSelect: () => onChange("manual") },
          {
            id: "alphabetical",
            label: "Alphabetical",
            checked: current === "alphabetical",
            onSelect: () => onChange("alphabetical"),
          },
          {
            id: "reverse_alphabetical",
            label: "Reverse alphabetical",
            checked: current === "reverse_alphabetical",
            onSelect: () => onChange("reverse_alphabetical"),
          },
        ],
      },
    ],
  };
}

// ── The "Groups" section's per-group rows ───────────────────────────────

function GroupRow({
  group,
  property,
  hidden,
  onToggleHidden,
}: {
  group: Group;
  property: PropertyResponse | undefined;
  hidden: boolean;
  onToggleHidden: () => void;
}) {
  const options = property ? configuredOptions(property) : [];
  const label = groupDisplayLabel(group, property);
  const isNoValue = group.key === NO_VALUE_KEY;
  return (
    <DragHandle
      id={group.key}
      label={`Reorder ${label}`}
      wrapper={({ handle }) => (
        <div className={`flex min-h-menu-row items-center gap-2 px-2 ${hidden ? "opacity-50" : ""}`}>
          {handle}
          <span
            className={
              isNoValue
                ? "truncate text-menu-disabled"
                : `truncate rounded-full px-2 py-0.5 text-[11px] font-medium ${pillStyleForOption(label, options)}`
            }
          >
            {label}
          </span>
          <button
            type="button"
            aria-label={hidden ? `Show ${label}` : `Hide ${label}`}
            onClick={onToggleHidden}
            className="ml-auto shrink-0 rounded p-0.5 text-menu-disabled hover:bg-menu-hover hover:text-menu-fg"
          >
            {hidden ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      )}
    />
  );
}

function GroupsSection({
  groups,
  groupBy,
  property,
  onPatchGroupBy,
}: {
  groups: Group[];
  groupBy: GroupBySpec;
  property: PropertyResponse | undefined;
  onPatchGroupBy: (patch: Partial<GroupBySpec>) => void;
}) {
  const display = orderedGroups(groups, groupBy);
  const hiddenKeys = new Set(groupBy.hidden_groups ?? []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const currentOrder = display.map((g) => g.key);
    const next = reorderGroups(currentOrder, active.id as string, over.id as string);
    if (next) onPatchGroupBy({ group_order: "manual", group_order_manual: next });
  }

  function toggleHidden(key: string) {
    const next = hiddenKeys.has(key) ? [...hiddenKeys].filter((k) => k !== key) : [...hiddenKeys, key];
    onPatchGroupBy({ hidden_groups: next });
  }

  return (
    <div className="flex flex-col gap-0.5 pb-1">
      <div className="flex items-center justify-between px-2 py-1 text-menu-disabled">
        <span>Groups</span>
        <button
          type="button"
          onClick={() => onPatchGroupBy({ hidden_groups: display.map((g) => g.key) })}
          className="hover:text-menu-fg"
        >
          Hide all
        </button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={display.map((g) => g.key)} strategy={verticalListSortingStrategy}>
          {display.map((g) => (
            <GroupRow
              key={g.key}
              group={g}
              property={property}
              hidden={hiddenKeys.has(g.key)}
              onToggleHidden={() => toggleHidden(g.key)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}

// ── Stage 2 root ─────────────────────────────────────────────────────────

function GroupByTrigger({
  properties,
  groupBy,
  property,
  onSelectProperty,
}: {
  properties: PropertyResponse[];
  groupBy: GroupBySpec;
  property: PropertyResponse | undefined;
  onSelectProperty: (property: PropertyResponse | null) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width="sm"
      label="Group by"
      trigger={
        <button type="button" className="flex min-h-menu-row w-full items-center justify-between px-2 text-left hover:bg-menu-hover">
          <span>Group by</span>
          <span className="flex items-center gap-1 text-menu-disabled">
            {property ? propertyTypeIcon(property.type) : null} {property?.name ?? groupBy.property_key} ›
          </span>
        </button>
      }
    >
      <MenuList
        nav="flyout"
        label="Group by"
        onClose={() => setOpen(false)}
        root={groupPropertyPicker(properties, groupBy, (p) => {
          setOpen(false);
          onSelectProperty(p);
        })}
      />
    </Popover>
  );
}

function GroupOrderTrigger({ groupBy, onChange }: { groupBy: GroupBySpec; onChange: (order: GroupBySpec["group_order"]) => void }) {
  const [open, setOpen] = useState(false);
  const current = groupBy.group_order ?? "manual";
  const label = current === "alphabetical" ? "Alphabetical" : current === "reverse_alphabetical" ? "Reverse alphabetical" : "Manual";
  return (
    <Popover open={open} onOpenChange={setOpen} width="sm" label="Sort" trigger={
      <button type="button" className="flex min-h-menu-row w-full items-center justify-between px-2 text-left hover:bg-menu-hover">
        <span>Sort</span>
        <span className="text-menu-disabled">{label} ›</span>
      </button>
    }>
      <MenuList nav="flyout" label="Sort" onClose={() => setOpen(false)} root={groupOrderPanel(groupBy, onChange)} />
    </Popover>
  );
}

export interface GroupBuilderProps {
  properties: PropertyResponse[];
  groupBy: GroupBySpec;
  groups: Group[] | null;
  onSetGroupBy: (updater: GroupByUpdater) => void;
  onSelectProperty: (property: PropertyResponse | null) => void;
}

function GroupStageTwo({ properties, groupBy, groups, onSetGroupBy, onSelectProperty }: GroupBuilderProps) {
  const property = properties.find((p) => p.key === groupBy.property_key);

  // Merges onto whatever `onSetGroupBy`'s queue knows is LATEST when this
  // runs, not this render's `groupBy` closure — see `GroupByUpdater`'s own
  // doc comment for the bug this avoids. `latest ?? groupBy` only ever
  // falls back to the render-time value the very first time (before any
  // write has landed); every write after that reads the queue's own truth.
  function patchGroupBy(patch: Partial<GroupBySpec>) {
    onSetGroupBy((latest) => ({ ...(latest ?? groupBy), ...patch }));
  }

  return (
    <div className="flex flex-col gap-0.5 pb-1">
      <GroupByTrigger properties={properties} groupBy={groupBy} property={property} onSelectProperty={onSelectProperty} />
      <GroupOrderTrigger groupBy={groupBy} onChange={(order) => patchGroupBy({ group_order: order })} />
      <div className="flex min-h-menu-row items-center justify-between px-2">
        <span>Hide empty groups</span>
        <button
          type="button"
          role="switch"
          aria-checked={groupBy.hide_empty_groups ?? false}
          aria-label="Hide empty groups"
          onClick={() => patchGroupBy({ hide_empty_groups: !groupBy.hide_empty_groups })}
          className={`h-3.5 w-6 rounded-full ${groupBy.hide_empty_groups ? "bg-brand" : "bg-menu-divider"}`}
        />
      </div>
      <div role="separator" className="my-1 h-px bg-menu-divider" />
      {groups && groups.length > 0 && (
        <>
          <GroupsSection groups={groups} groupBy={groupBy} property={property} onPatchGroupBy={patchGroupBy} />
          <div role="separator" className="my-1 h-px bg-menu-divider" />
        </>
      )}
      <button
        type="button"
        onClick={() => onSelectProperty(null)}
        className="flex items-center gap-1.5 px-2 py-1 text-left text-red-500 hover:bg-menu-hover"
      >
        <Trash2 size={13} /> Remove grouping
      </button>
      <div
        className="flex items-center gap-1.5 px-2 py-1 text-left text-menu-disabled opacity-60"
        title="No help article for this app yet"
      >
        <HelpCircle size={13} /> Learn about grouping
      </div>
    </div>
  );
}

/** The panel `ViewSettingsSidebar`'s Group row and the column header's own
 * "Group" row both host. Unlike Sort/Filter, there is no top-level toolbar
 * button for Group (group-panel.md's own stated rule). */
export function groupPanel(
  properties: PropertyResponse[],
  groupBy: GroupBySpec | undefined,
  groups: Group[] | null,
  onSetGroupBy: (updater: GroupByUpdater) => void
): MenuPanel {
  function onSelectProperty(property: PropertyResponse | null) {
    onSetGroupBy(() => (property ? defaultGroupBySpec(property) : null));
  }

  if (!groupBy) {
    return groupPropertyPicker(properties, groupBy, onSelectProperty);
  }

  return {
    title: "Group",
    sections: [
      {
        rows: [],
        content: (
          <GroupStageTwo
            properties={properties}
            groupBy={groupBy}
            groups={groups}
            onSetGroupBy={onSetGroupBy}
            onSelectProperty={onSelectProperty}
          />
        ),
      },
    ],
  };
}
