"use client";

import { useState } from "react";
import type { NumberValue } from "@/lib/database/types";
import type { CellProps } from "./CellProps";
import {
  barColorClass,
  barFraction,
  formatNumber,
  ringStyle,
  type NumberConfig,
} from "@/lib/database/numberFormat";

/** The property's `config` — the ONLY cell that needs it, which is why it is an
 * extra optional prop here rather than a new field on the shared `CellProps<V>`
 * that all twelve cells would have to carry. Omitting it renders a plain
 * ungrouped number: exactly what every caller did before the `Edit property`
 * panel existed, so Board/Gallery/List/Feed keep working unchanged. */
export interface NumberCellProps extends CellProps<NumberValue> {
  config?: NumberConfig;
}

/** `Show as` = Bar or Ring. Notion draws the proportion `value / divide_by`,
 * and hides the number itself when `Show number` is off. */
function ShowAs({ value, config }: { value: number | null | undefined; config: NumberConfig }) {
  const fraction = barFraction(value, config);
  const showNumber = config.show_number !== false;
  const text = formatNumber(value, config);

  // No divisor configured: there is nothing to draw a proportion against, so
  // fall back to the number rather than to a bar that is always empty.
  if (fraction === null) return <span className="tabular-nums">{text}</span>;

  const percent = Math.round(fraction * 100);

  if (config.show_as === "ring") {
    return (
      <span className="flex items-center gap-1.5">
        <span
          role="img"
          aria-label={`${percent} percent`}
          className="h-3.5 w-3.5 shrink-0 rounded-full"
          style={ringStyle(fraction, config.bar_color)}
        />
        {showNumber && <span className="tabular-nums">{text}</span>}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <span
        role="img"
        aria-label={`${percent} percent`}
        className="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
      >
        <span
          className={`block h-full rounded-full ${barColorClass(config.bar_color)}`}
          style={{ width: `${percent}%` }}
        />
      </span>
      {showNumber && <span className="shrink-0 tabular-nums">{text}</span>}
    </span>
  );
}

export function NumberCell({ value, editable, onChange, config }: NumberCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value?.number?.toString() ?? "");

  const showAs = config?.show_as;
  const empty = value?.number === null || value?.number === undefined;

  const display = empty ? (
    <span className="text-gray-400">—</span>
  ) : config && (showAs === "bar" || showAs === "ring") ? (
    <ShowAs value={value?.number} config={config} />
  ) : (
    formatNumber(value?.number, config)
  );

  if (!editable) {
    return <span className="tabular-nums text-gray-700 dark:text-gray-300">{display}</span>;
  }

  if (editing) {
    function commit() {
      setEditing(false);
      const trimmed = draft.trim();
      onChange(
        trimmed === "" ? { type: "number", number: null } : { type: "number", number: Number(trimmed) }
      );
    }
    return (
      <input
        autoFocus
        aria-label="Number"
        type="number"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        className="w-full px-1 -mx-1 rounded border border-indigo-300 dark:border-indigo-500 bg-white dark:bg-gray-900 text-sm outline-none tabular-nums"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        // The EDITOR always shows the RAW stored number, never the formatted
        // one — typing over "$1,234.00" and parsing that back is how a
        // currency column silently turns into NaN.
        setDraft(value?.number?.toString() ?? "");
        setEditing(true);
      }}
      className="w-full text-left tabular-nums text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-1 -mx-1"
    >
      {display}
    </button>
  );
}
