"use client";

import type { CheckboxValue } from "@/lib/database/types";
import type { CellProps } from "./CellProps";

export function CheckboxCell({ value, editable, onChange }: CellProps<CheckboxValue>) {
  const checked = value?.checkbox ?? false;
  return (
    <input
      type="checkbox"
      aria-label="Checkbox"
      checked={checked}
      disabled={!editable}
      onChange={(e) => onChange({ type: "checkbox", checkbox: e.target.checked })}
      className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed"
    />
  );
}
