"use client";

import { useState } from "react";
import type { DateValue } from "@/lib/database/types";
import type { CellProps } from "./CellProps";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function DateCell({ value, editable, onChange }: CellProps<DateValue>) {
  const start = value?.date?.start;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(start ? start.slice(0, 10) : "");

  if (!editable) {
    return (
      <span className="text-gray-700 dark:text-gray-300">
        {start ? formatDate(start) : <span className="text-gray-400">—</span>}
      </span>
    );
  }

  if (editing) {
    function commit() {
      setEditing(false);
      onChange(
        draft === ""
          ? { type: "date", date: null }
          : { type: "date", date: { start: draft, end: null, time_zone: null } }
      );
    }
    return (
      <input
        autoFocus
        aria-label="Date"
        type="date"
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
        setDraft(start ? start.slice(0, 10) : "");
        setEditing(true);
      }}
      className="w-full text-left text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1"
    >
      {start ? formatDate(start) : <span className="text-gray-400">—</span>}
    </button>
  );
}
