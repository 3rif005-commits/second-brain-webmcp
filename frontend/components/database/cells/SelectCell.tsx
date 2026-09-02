"use client";

// M11 (cell-editing.md): create-on-type. The spec's own words: "We have no
// create-on-type at all — a select option can only be added by editing the
// property. This is the single biggest cell-editing gap." Notion's capture:
// the cell becomes a search input in place, with a panel below listing
// matching options plus a `Create [x]` row (the typed text rendered as a
// coloured chip preview) when nothing matches; Enter on that row creates,
// assigns AND closes in one keystroke.
//
// Reuses the Popover/MenuList primitives — the same "input IS the trigger,
// panel hangs below" shape AddPropertyPopover.tsx already established for
// property creation — rather than a bespoke dropdown.
import { useState } from "react";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { MenuPanel } from "@/components/ui/primitives";
import type { SelectValue } from "@/lib/database/types";
import type { CellProps } from "./CellProps";
import { pillStyleForOption, type ConfiguredOption } from "./CellProps";

export interface SelectCellProps extends CellProps<SelectValue> {
  options?: ConfiguredOption[];
  /** Optional: an older/other caller (Board/Gallery/List/Feed, RowPeek) that
   * omits it gets the pre-M11 bare-input editor unchanged — assigning a
   * free-text value still works, it just cannot mint a new configured
   * option. Resolves once the option is created (schema write); the
   * caller's own `onChange` still does the assignment. */
  onCreateOption?: (name: string) => Promise<void>;
}

function chip(label: string, options: ConfiguredOption[] | undefined) {
  return (
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${pillStyleForOption(label, options)}`}>
      {label}
    </span>
  );
}

export function SelectCell({ value, editable, onChange, options, onCreateOption }: SelectCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const content = value?.select ? chip(value.select, options) : <span className="text-gray-400">—</span>;

  if (!editable) return content;

  function close() {
    setEditing(false);
    setDraft("");
  }

  function assign(name: string | null) {
    close();
    onChange(name ? { type: "select", select: name } : { type: "select", select: null });
  }

  async function createAndAssign(name: string) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onCreateOption?.(name);
      assign(name);
    } finally {
      setSubmitting(false);
    }
  }

  // Pre-M11 fallback for callers that don't supply `onCreateOption` — the
  // original bare free-text input, unchanged.
  if (!onCreateOption) {
    if (editing) {
      function commit() {
        setEditing(false);
        const trimmed = draft.trim();
        onChange(trimmed === "" ? { type: "select", select: null } : { type: "select", select: trimmed });
      }
      return (
        <input
          autoFocus
          aria-label="Select"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setEditing(false);
          }}
          className="w-full px-1 -mx-1 rounded border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-gray-900 text-sm outline-none"
        />
      );
    }
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(value?.select ?? "");
          setEditing(true);
        }}
        className="w-full text-left hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1"
      >
        {content}
      </button>
    );
  }

  const query = draft.trim();
  const lowerQuery = query.toLowerCase();
  const matches = (options ?? []).filter((o) => !query || o.name.toLowerCase().includes(lowerQuery));
  // The actual configured option, casing and all — Enter on an exact
  // (case-insensitive) match assigns THIS name, not whatever casing the
  // user happened to type, so it never mints a same-name-different-case
  // duplicate.
  const exactMatch = (options ?? []).find((o) => o.name.toLowerCase() === lowerQuery);

  const panel: MenuPanel = {
    sections: [
      {
        rows: [
          ...(query && !exactMatch
            ? [
                {
                  id: "__create__",
                  label: `Create ${query}`,
                  labelNode: (
                    <span className="flex items-center gap-1.5">
                      Create {chip(query, options)}
                    </span>
                  ),
                  onSelect: () => createAndAssign(query),
                },
              ]
            : []),
          ...matches.map((o) => ({
            id: o.id,
            label: o.name,
            labelNode: chip(o.name, options),
            onSelect: () => assign(o.name),
          })),
        ],
        content:
          (options ?? []).length === 0 && !query ? (
            <div className="pt-1 text-menu-disabled">Select an option or create one</div>
          ) : undefined,
      },
    ],
  };

  return (
    <Popover
      open={editing}
      onOpenChange={(next) => (next ? setEditing(true) : close())}
      label="Select"
      preventAutoFocus
      trigger={
        // A single, STABLE wrapper element (never swapped for a different
        // element type across the editing/not-editing states) — Radix's
        // own `context.triggerRef` tracks whatever `asChild` clones onto,
        // and swapping `<button>` for `<input>` there (an earlier version
        // of this did) unmounts/remounts the DOM node the ref points at.
        // The resulting stale-vs-new ref race made Radix's non-modal
        // `onInteractOutside` (`PopoverContentNonModal`'s `targetIsTrigger
        // = context.triggerRef.current?.contains(target)` check) briefly
        // see the newly-`autoFocus`ed input as "outside" the trigger and
        // dismiss the popover on its own focus-in event — before a single
        // keystroke ever landed. A `<div>` wrapper is stable; whichever
        // input/button lives inside it stays reachable via `.contains()`.
        <div>
          {editing ? (
            <input
              type="text"
              autoFocus
              aria-label="Select"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Search for an option…"
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (query) exactMatch ? assign(exactMatch.name) : createAndAssign(query);
                } else if (e.key === "Escape") {
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
