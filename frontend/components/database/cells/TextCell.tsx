"use client";

import { useState } from "react";
import type { RichTextValue } from "@/lib/database/types";
import type { CellProps } from "./CellProps";

export function TextCell({ value, editable, onChange }: CellProps<RichTextValue>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value?.rich_text ?? "");

  if (!editable) {
    return (
      <span className="truncate text-gray-700 dark:text-gray-300">
        {value?.rich_text || <span className="text-gray-400">—</span>}
      </span>
    );
  }

  if (editing) {
    function commit() {
      setEditing(false);
      onChange({ type: "rich_text", rich_text: draft });
    }
    return (
      <input
        autoFocus
        aria-label="Text"
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
        setDraft(value?.rich_text ?? "");
        setEditing(true);
      }}
      className="w-full truncate text-left text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1"
    >
      {value?.rich_text || <span className="text-gray-400">—</span>}
    </button>
  );
}
