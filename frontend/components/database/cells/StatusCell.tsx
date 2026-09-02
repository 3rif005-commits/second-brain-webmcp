"use client";

// M11 (cell-editing.md): "Status — and why it could not be inferred from
// Select." Four differences from Select's own editor: options are GROUPED
// under To-do / In progress / Complete (with headers/dividers), there is NO
// create-on-type (options are managed on the property, not minted from a
// cell), each option renders as a coloured DOT + label rather than a filled
// chip, and the search placeholder drops Select's ellipsis ("Search for an
// option", not "Search for an option…").
import { useState } from "react";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { MenuPanel } from "@/components/ui/primitives";
import type { StatusValue } from "@/lib/database/types";
import type { CellProps } from "./CellProps";
import { pillStyleForOption, type ConfiguredOption } from "./CellProps";
import { STATUS_GROUPS, type StatusGroup } from "../EditPropertyPanel";

type StatusOption = ConfiguredOption & { group?: StatusGroup };

export interface StatusCellProps extends CellProps<StatusValue> {
  options?: ConfiguredOption[];
}

function dot(name: string, options: ConfiguredOption[] | undefined) {
  // `pillStyleForOption` returns pill classes ("bg-x-100 text-x-700 …") —
  // reused here for the swatch's fill/text colour alone (the dot is a
  // `bg-current` circle), not for a pill background.
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${pillStyleForOption(name, options)}`} />;
}

export function StatusCell({ value, editable, onChange, options }: StatusCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const content = value?.status ? (
    <span className="inline-flex items-center gap-1.5 text-xs">
      {dot(value.status, options)}
      {value.status}
    </span>
  ) : (
    <span className="text-gray-400">—</span>
  );

  if (!editable) return content;

  function close() {
    setEditing(false);
    setDraft("");
  }

  function assign(name: string | null) {
    close();
    onChange(name ? { type: "status", status: name } : { type: "status", status: null });
  }

  const query = draft.trim().toLowerCase();
  const statusOptions = (options ?? []) as StatusOption[];
  const matches = statusOptions.filter((o) => !query || o.name.toLowerCase().includes(query));

  const panel: MenuPanel = {
    sections: [
      ...STATUS_GROUPS.map((group) => ({
        label: group,
        rows: matches
          .filter((o) => (o.group ?? "To-do") === group)
          .map((o) => ({
            id: o.id,
            label: o.name,
            labelNode: (
              <span className="flex items-center gap-1.5">
                {dot(o.name, options)}
                {o.name}
              </span>
            ),
            checked: value?.status === o.name,
            onSelect: () => assign(o.name),
          })),
      })),
    ],
  };

  return (
    <Popover
      open={editing}
      onOpenChange={(next) => (next ? setEditing(true) : close())}
      label="Status"
      preventAutoFocus
      trigger={
        // Same stable-wrapper reasoning as SelectCell.tsx: the trigger
        // element must not change TYPE across the editing/not-editing
        // states, or Radix's non-modal `onInteractOutside` (its
        // `context.triggerRef.current?.contains(target)` check) can catch
        // the newly-mounted, newly-`autoFocus`ed input in a stale-ref
        // window and dismiss the popover before a keystroke lands.
        <div>
          {editing ? (
            <input
              type="text"
              autoFocus
              aria-label="Status"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search for an option"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  close();
                }
              }}
              className="w-full px-1 -mx-1 rounded border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-gray-900 text-sm outline-none"
            />
          ) : (
            <button type="button" className="w-full text-left hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1">
              {content}
            </button>
          )}
        </div>
      }
    >
      <MenuList root={panel} nav="flyout" onClose={close} label="Select an option" />
    </Popover>
  );
}
