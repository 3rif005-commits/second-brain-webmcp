"use client";

// M3's "Property visibility" sub-panel (view-options-panel.md §B) — the
// panel that makes `hidden_properties`/`property_order` (both already
// written by M1's column header menu, both now finally READ by
// TableView.tsx — see its own M3 comment) editable directly, with drag
// reorder and a per-row eye toggle.
//
// Rendered as a pushed panel's `MenuSection.content`, not as `MenuRow[]`:
// this needs a live @dnd-kit SortableContext, which MenuList's generic row
// renderer has no concept of — the same reason BoardView/NoteTree own their
// own DndContext rather than routing drag through a shared primitive.
// Follows components/sidebar/NoteTree.tsx's DndContext/SortableContext/
// arrayMove structural pattern (sensors, activationConstraint distance,
// onDragEnd), but through the DragHandle primitive rather than a bespoke
// useSortable call, since DragHandle is already the shared wrapper property/
// row/group reorder all use.
import { useState } from "react";
import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Eye, EyeOff } from "lucide-react";
import type { PropertyResponse } from "@/lib/database/types";
import { DragHandle } from "@/components/ui/primitives";
import { propertyTypeIcon } from "./ColumnHeaderMenu";

/** Pure reorder logic, split out so it's testable without simulating a real
 * dnd-kit pointer drag (BoardView.test.tsx's own "no dnd-kit simulation
 * needed" convention for drag-drop logic). `null` when either key is
 * unknown or nothing moved. */
export function reorderPropertyKeys(
  properties: PropertyResponse[],
  activeKey: string,
  overKey: string
): string[] | null {
  if (activeKey === overKey) return null;
  const keys = properties.map((p) => p.key);
  const oldIdx = keys.indexOf(activeKey);
  const newIdx = keys.indexOf(overKey);
  if (oldIdx === -1 || newIdx === -1) return null;
  return arrayMove(keys, oldIdx, newIdx);
}

export interface PropertyVisibilityPanelProps {
  /** In TABLE order (`orderProperties` already applied by the caller) — this
   * is where you REORDER, unlike Group/Sort's alphabetical pickers, which
   * are for FINDING (view-options-panel.md's ordering rule). */
  properties: PropertyResponse[];
  hiddenKeys: string[];
  /** The full property_order this view should now have. */
  onReorder: (orderedKeys: string[]) => void;
  onToggleHidden: (key: string, hidden: boolean) => void;
  onHideAll: () => void;
}

export function PropertyVisibilityPanel({
  properties,
  hiddenKeys,
  onReorder,
  onToggleHidden,
  onHideAll,
}: PropertyVisibilityPanelProps) {
  const [query, setQuery] = useState("");
  const hidden = new Set(hiddenKeys);
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed ? properties.filter((p) => p.name.toLowerCase().includes(trimmed)) : properties;
  // Reordering a FILTERED list is ambiguous (drop position among rows that
  // are themselves a subset) — offered only against the full, unfiltered
  // list, same restraint the row stays visible-but-inert under.
  const canDrag = trimmed.length === 0;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;
    const next = reorderPropertyKeys(properties, active.id as string, over.id as string);
    if (next) onReorder(next);
  }

  return (
    <div className="flex flex-col gap-0.5 pb-1">
      <div className="px-2 pb-1">
        <input
          autoFocus
          aria-label="Search for a property…"
          placeholder="Search for a property…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-menu-row w-full rounded bg-menu-field px-2 text-menu outline-none placeholder:text-menu-disabled"
        />
      </div>
      <div className="flex items-center justify-between px-2 py-1 text-menu-disabled">
        <span>Shown in table</span>
        <button type="button" onClick={onHideAll} className="hover:text-menu-fg">
          Hide all
        </button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={filtered.map((p) => p.key)} strategy={verticalListSortingStrategy}>
          {filtered.map((property) => {
            // The title column is the only place OpenNoteButton and the
            // sub-item tree's expand toggle render (TableView.tsx) — hiding
            // it would remove the only way to open a row, so its eye toggle
            // is greyed rather than wired, the same "disabled, not missing"
            // convention Filter/Group rows use elsewhere on this branch.
            const isTitle = property.type === "title";
            const isHidden = hidden.has(property.key);
            return (
              <DragHandle
                key={property.key}
                id={property.key}
                disabled={!canDrag}
                wrapper={({ handle }) => (
                  <div className="flex min-h-menu-row items-center gap-2 px-2">
                    {canDrag ? handle : <span className="w-3.5 shrink-0" />}
                    <span className="flex w-menu-icon shrink-0 items-center justify-center">
                      {propertyTypeIcon(property.type)}
                    </span>
                    <span className="flex-1 truncate">{property.name}</span>
                    <button
                      type="button"
                      aria-label={isHidden ? `Show ${property.name}` : `Hide ${property.name}`}
                      disabled={isTitle}
                      title={isTitle ? "The title column can't be hidden" : undefined}
                      onClick={() => onToggleHidden(property.key, !isHidden)}
                      className={`shrink-0 rounded p-0.5 ${
                        isTitle
                          ? "cursor-default text-menu-disabled opacity-50"
                          : "text-menu-disabled hover:text-menu-fg"
                      }`}
                    >
                      {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                )}
              />
            );
          })}
        </SortableContext>
      </DndContext>
      {filtered.length === 0 && <div className="px-2 py-2 text-menu-disabled">No results</div>}
    </div>
  );
}
