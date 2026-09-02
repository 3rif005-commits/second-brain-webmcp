"use client";

// M5's sort-editor row list (sort-panel.md's "Rows — stage 2, the sort
// editor"): `⠿ [Aa Name ▾] [Sort A → Z ▾] [×]`, drag-reorderable — row order
// IS sort precedence, so this is the one part of the sort panel that needs a
// live @dnd-kit context, which MenuList's generic `MenuRow[]` rendering has
// no concept of (same reason PropertyVisibilityPanel.tsx owns its own
// DndContext instead of routing drag through the shared primitive). Rendered
// as a `MenuSection.content`, not `rows`, for that reason.
//
// Two SEPARATE dropdowns per row, not one combined "click the row" menu the
// way the pre-M5 MVP had it (property+direction+remove all behind a single
// submenu) — the spec's row anatomy table is explicit that Property and
// Direction are independent controls, so changing one must not require
// re-picking the other.
import { forwardRef, useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { X } from "lucide-react";
import type { PropertyResponse } from "@/lib/database/types";
import type { Sort, SortsUpdater } from "@/lib/database/viewConfig";
import { DragHandle, MenuList, Popover } from "@/components/ui/primitives";
import { propertyTypeIcon, sortLabels } from "./ColumnHeaderMenu";

/** Pure reorder logic, split out for the same reason
 * `PropertyVisibilityPanel.reorderPropertyKeys` is — testable without
 * simulating a real dnd-kit pointer drag. */
export function reorderSorts(sorts: Sort[], activeProperty: string, overProperty: string): Sort[] | null {
  if (activeProperty === overProperty) return null;
  const keys = sorts.map((s) => s.property);
  const oldIdx = keys.indexOf(activeProperty);
  const newIdx = keys.indexOf(overProperty);
  if (oldIdx === -1 || newIdx === -1) return null;
  return arrayMove(sorts, oldIdx, newIdx);
}

// `forwardRef` AND spreading `...rest` are both required, not cosmetic:
// Radix's `Popover.Trigger asChild` clones this element via `Slot`, which
// merges its own `ref` (for collision-aware positioning) and its own
// `onClick`/`onPointerDown`/`aria-*`/`data-*` props onto whatever this
// component renders. A plain function component that only destructures
// `label` silently drops every one of those — including the click handler
// that actually opens the popover, so the trigger renders identically but
// never opens anything. `MenuList.tsx`'s own `Row` sidesteps this by handing
// Radix a bare `<div>` (a host element, which accepts arbitrary props by
// definition); this is the same fix, generalized to a real component.
// Caught by this file's own test suite (SortRowsList.test.tsx) before it
// shipped — reproduced down to a minimal two-sibling-Popover case with no
// `DndContext`/`DragHandle` involved at all.
const DropdownButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { label: React.ReactNode }>(
  function DropdownButton({ label, className = "", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={`flex min-w-0 flex-1 items-center gap-1 truncate rounded bg-menu-field px-1.5 py-0.5 text-left text-menu hover:bg-menu-hover ${className}`}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="shrink-0 text-menu-disabled">
          ▾
        </span>
      </button>
    );
  }
);

export interface SortRowProps {
  sort: Sort;
  property: PropertyResponse | undefined;
  properties: PropertyResponse[];
  sorts: Sort[];
  onSetSorts: (updater: SortsUpdater) => void;
}

/** One row's own `⠿ [property ▾] [direction ▾] [×]`. Exported so a future
 * test can exercise a single row without mounting the whole list's
 * `DndContext`. Drag-reorder itself is covered separately by the pure
 * `reorderSorts` function below, same "no dnd-kit simulation needed"
 * convention `PropertyVisibilityPanel.test.tsx` already established. */
export function SortRow({ sort, property, properties, sorts, onSetSorts }: SortRowProps) {
  const [propertyMenuOpen, setPropertyMenuOpen] = useState(false);
  const [directionMenuOpen, setDirectionMenuOpen] = useState(false);
  const labels = property ? sortLabels(property.type) : { asc: "Ascending", desc: "Descending" };
  const alphabetical = [...properties].sort((a, b) => a.name.localeCompare(b.name));
  const sortedElsewhere = new Set(sorts.filter((s) => s.property !== sort.property).map((s) => s.property));

  return (
    <DragHandle
      id={sort.property}
      label={`Reorder ${property?.name ?? sort.property}`}
      // `wrapper` is what attaches `useSortable`'s ref/transform to the
      // WHOLE row, not just the "⠿" glyph — without it, dnd-kit's collision
      // detection tracks only that tiny span's bounding rect, so a drop
      // target is a few pixels wide instead of the row's full height. Same
      // fix `PropertyVisibilityPanel.tsx` already applies for its own rows.
      wrapper={({ handle }) => (
        <div className="flex min-h-menu-row items-center gap-1 px-2">
          {handle}
          <SortRowControls
            sort={sort}
            property={property}
            properties={properties}
            sorts={sorts}
            onSetSorts={onSetSorts}
            propertyMenuOpen={propertyMenuOpen}
            setPropertyMenuOpen={setPropertyMenuOpen}
            directionMenuOpen={directionMenuOpen}
            setDirectionMenuOpen={setDirectionMenuOpen}
            labels={labels}
            alphabetical={alphabetical}
            sortedElsewhere={sortedElsewhere}
          />
        </div>
      )}
    />
  );
}

interface SortRowControlsProps extends SortRowProps {
  propertyMenuOpen: boolean;
  setPropertyMenuOpen: (open: boolean) => void;
  directionMenuOpen: boolean;
  setDirectionMenuOpen: (open: boolean) => void;
  labels: { asc: string; desc: string };
  alphabetical: PropertyResponse[];
  sortedElsewhere: Set<string>;
}

/** The two dropdowns + remove button — split out from `SortRow` only so its
 * JSX can sit inside `DragHandle`'s `wrapper` render prop without one giant
 * inline arrow function. */
function SortRowControls({
  sort,
  property,
  onSetSorts,
  propertyMenuOpen,
  setPropertyMenuOpen,
  directionMenuOpen,
  setDirectionMenuOpen,
  labels,
  alphabetical,
  sortedElsewhere,
}: SortRowControlsProps) {
  return (
    <>
      <Popover
        open={propertyMenuOpen}
        onOpenChange={setPropertyMenuOpen}
        width="sm"
        label="Sort property"
        trigger={
          <DropdownButton
            label={
              <span className="flex items-center gap-1.5">
                {property ? propertyTypeIcon(property.type) : null}
                {property?.name ?? sort.property}
              </span>
            }
          />
        }
      >
        <MenuList
          nav="flyout"
          label="Sort property"
          onClose={() => setPropertyMenuOpen(false)}
          root={{
            search: { placeholder: "Sort by…" },
            sections: [
              {
                rows: alphabetical
                  .filter((p) => !sortedElsewhere.has(p.key))
                  .map((p) => ({
                    id: p.key,
                    icon: propertyTypeIcon(p.type),
                    label: p.name,
                    checked: p.key === sort.property,
                    // Switching a row's property keeps its position (this
                    // row's precedence) but resets direction to ascending —
                    // same "picking applies a default" convention the stage-1
                    // picker already establishes for a brand new sort.
                    onSelect: () =>
                      onSetSorts((latest) =>
                        latest.map((s) => (s.property === sort.property ? { property: p.key, direction: "asc" } : s))
                      ),
                  })),
              },
            ],
          }}
        />
      </Popover>
      <Popover
        open={directionMenuOpen}
        onOpenChange={setDirectionMenuOpen}
        width="sm"
        label="Sort direction"
        trigger={<DropdownButton label={sort.direction === "asc" ? labels.asc : labels.desc} />}
      >
        <MenuList
          nav="flyout"
          label="Sort direction"
          onClose={() => setDirectionMenuOpen(false)}
          root={{
            sections: [
              {
                rows: [
                  {
                    id: "asc",
                    label: labels.asc,
                    checked: sort.direction === "asc",
                    onSelect: () =>
                      onSetSorts((latest) =>
                        latest.map((s) => (s.property === sort.property ? { ...s, direction: "asc" } : s))
                      ),
                  },
                  {
                    id: "desc",
                    label: labels.desc,
                    checked: sort.direction === "desc",
                    onSelect: () =>
                      onSetSorts((latest) =>
                        latest.map((s) => (s.property === sort.property ? { ...s, direction: "desc" } : s))
                      ),
                  },
                ],
              },
            ],
          }}
        />
      </Popover>
      <button
        type="button"
        aria-label={`Remove sort on ${property?.name ?? sort.property}`}
        onClick={() => onSetSorts((latest) => latest.filter((s) => s.property !== sort.property))}
        className="shrink-0 rounded p-0.5 text-menu-disabled hover:bg-menu-hover hover:text-menu-fg"
      >
        <X size={12} />
      </button>
    </>
  );
}

export interface SortRowsListProps {
  sorts: Sort[];
  properties: PropertyResponse[];
  onSetSorts: (updater: SortsUpdater) => void;
}

export function SortRowsList({ sorts, properties, onSetSorts }: SortRowsListProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    // Reorders against whatever `onSetSorts`'s queue knows is latest at drop
    // time, not this render's `sorts` — same "compute the next value inside
    // the updater, never in the closure" rule every other writer here
    // follows, so a drop landing after a concurrent edit doesn't clobber it.
    onSetSorts((latest) => reorderSorts(latest, active.id as string, over.id as string) ?? latest);
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sorts.map((s) => s.property)} strategy={verticalListSortingStrategy}>
        {sorts.map((sort) => (
          <SortRow
            key={sort.property}
            sort={sort}
            property={properties.find((p) => p.key === sort.property)}
            properties={properties}
            sorts={sorts}
            onSetSorts={onSetSorts}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}
