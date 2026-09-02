"use client";

import { useState } from "react";
import type { MultiSelectValue } from "@/lib/database/types";
import type { CellProps } from "./CellProps";
import { pillStyleForOption, type ConfiguredOption } from "./CellProps";

/** `options` is the property's configured option list. Optional so the older
 * callers that predate the `Edit property` panel (Board/Gallery/List/Feed)
 * keep working — they simply get the hash palette, as before. */
export interface MultiSelectCellProps extends CellProps<MultiSelectValue> {
  options?: ConfiguredOption[];
}

export function MultiSelectCell({ value, editable, onChange, options }: MultiSelectCellProps) {
  const items = value?.multi_select ?? [];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(items.join(", "));

  if (editing) {
    function commit() {
      setEditing(false);
      const parsed = draft
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      onChange({ type: "multi_select", multi_select: parsed });
    }
    return (
      <input
        autoFocus
        aria-label="Multi-select"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder="comma, separated, values"
        className="w-full px-1 -mx-1 rounded border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-gray-900 text-sm outline-none"
      />
    );
  }

  const content =
    items.length > 0 ? (
      <div className="flex flex-wrap gap-1">
        {items.map((item) => (
          <span
            key={item}
            className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${pillStyleForOption(item, options)}`}
          >
            {item}
          </span>
        ))}
      </div>
    ) : (
      <span className="text-gray-400">—</span>
    );

  if (!editable) return content;

  return (
    <button
      type="button"
      onClick={() => {
        setDraft(items.join(", "));
        setEditing(true);
      }}
      className="w-full text-left hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1"
    >
      {content}
    </button>
  );
}
