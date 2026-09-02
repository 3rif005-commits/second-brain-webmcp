import type { UnknownValue } from "@/lib/database/types";

// Fallback for any property `type` string without a dedicated cell
// component (e.g. `url`, `created_time`, `last_edited_time` — All Notes'
// `source_url`/`created_at`/`updated_at` columns). Always read-only: there's
// no per-type write coercion for these, so TableView never passes an
// `editable`/`onChange` here (spec brief: fall back to a plain read-only
// rendering rather than crashing or omitting the column).
function formatInner(value: UnknownValue): string {
  const inner = value[value.type];
  if (inner === null || inner === undefined) return "";
  if (typeof inner === "string") {
    // created_time/last_edited_time are ISO datetimes — render a bit more
    // readably than the raw string when it parses as one.
    if (/^\d{4}-\d{2}-\d{2}/.test(inner)) {
      const d = new Date(inner);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    return inner;
  }
  return JSON.stringify(inner);
}

export function GenericCell({ value }: { value: UnknownValue | undefined }) {
  if (!value) return <span className="text-gray-400">—</span>;
  const text = formatInner(value);
  return (
    <span className="truncate text-gray-500 dark:text-gray-400">
      {text || <span className="text-gray-400">—</span>}
    </span>
  );
}
