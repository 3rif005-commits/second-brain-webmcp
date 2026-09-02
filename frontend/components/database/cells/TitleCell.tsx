"use client";

import { useState } from "react";
import type { TitleValue } from "@/lib/database/types";
import type { CellProps } from "./CellProps";

export interface TitleCellProps extends CellProps<TitleValue> {
  /** new-row-button.md: "Focus the new row's title cell after creation" —
   * both the plain `+ New` split button and the row-gutter/per-group
   * `+ New page` create a row with no focus management today, leaving the
   * user to find and click it. A lazy `useState` initializer, not a
   * reactive prop: this only needs to be true for the ONE render where the
   * row is freshly mounted (a stable React `key={row.id}` means this
   * component is never remounted for the same row again), and TitleCell
   * owns `editing` completely from then on — a later re-render with
   * `autoEdit` still `true` (or now `false`) has no further effect. */
  autoEdit?: boolean;
}

export function TitleCell({ value, editable, onChange, autoEdit }: TitleCellProps) {
  const [editing, setEditing] = useState(() => Boolean(autoEdit) && editable);
  const [draft, setDraft] = useState(value?.title ?? "");

  if (!editable) {
    return (
      <span className="truncate font-medium text-gray-900 dark:text-gray-100">
        {value?.title || <span className="font-normal text-gray-400">Untitled</span>}
      </span>
    );
  }

  if (editing) {
    function commit() {
      setEditing(false);
      onChange({ type: "title", title: draft });
    }
    return (
      <input
        autoFocus
        aria-label="Title"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full px-1 -mx-1 rounded border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-gray-900 text-sm font-medium text-gray-900 dark:text-gray-100 outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(value?.title ?? "");
        setEditing(true);
      }}
      className="w-full truncate text-left font-medium text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1"
    >
      {value?.title || <span className="font-normal text-gray-400">Untitled</span>}
    </button>
  );
}
