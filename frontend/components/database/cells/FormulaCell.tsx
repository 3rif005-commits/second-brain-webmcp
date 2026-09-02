// Read-only display of a materialised formula/rollup value (Milestone 8,
// task-28-brief.md §4). Spec §7.1 gives the frontend NO evaluator — this
// component never computes anything, it only renders what the backend
// already materialised into `db_row_props.computed` (see
// `services/db/recompute.py`) and merged into the row's `properties` at the
// router layer (`routers/databases.py`'s `_merge_computed_into_rows`). One
// component covers both `formula` and `rollup` property types: their
// materialised-value shape and every rendering rule below are identical —
// only `is_volatile` (formula-only; a rollup is never volatile) differs.
//
// Always read-only, unconditionally — there is exactly one legal writer of
// a computed value (`recompute.py`), so this deliberately does NOT accept
// `editable`/`onChange` the way `CellProps<V>` cells do; there is nothing a
// user can type into a formula/rollup cell.
import type { ComputedValue, PropertyResponse, PropertyValue } from "@/lib/database/types";

const LIMITS_TOOLTIP =
  "This value is too complex to calculate: it exceeded a materialisation limit " +
  "(formula nesting depth 15, relation traversal depth 3, or 10,000 related rows " +
  "for a rollup). No value is shown, by design — Notion's own formula engine " +
  "has the identical behaviour.";

const VOLATILE_TOOLTIP =
  "This formula references now() or today(), so its value is never pre-computed " +
  "— it is recalculated live on every read instead of being stored. Table view " +
  "does not evaluate it yet, so nothing shows here.";

function formatComputed(value: ComputedValue): string | null {
  switch (value.type) {
    case "number":
      return value.number === null ? null : String(value.number);
    case "boolean":
      return value.boolean === null ? null : value.boolean ? "Yes" : "No";
    case "string":
      return value.string === null || value.string === "" ? null : value.string;
    case "date": {
      if (value.date === null) return null;
      const start = new Date(value.date.start);
      return Number.isNaN(start.getTime()) ? value.date.start : start.toLocaleDateString();
    }
    default:
      return null;
  }
}

export function FormulaCell({
  property,
  value,
}: {
  property: PropertyResponse;
  value: PropertyValue | undefined;
}) {
  // The materialised wrapper's OWN discriminant is the formula's
  // result_type ("number"/"boolean"/"string"/"date"), never "formula" or
  // "rollup" (see ComputedValue's own docstring in lib/database/types.ts) —
  // `property.type` is what routes here, `value.type` is what shape the
  // value itself carries.
  const computed = value as ComputedValue | undefined;

  if (computed?.type === "unsupported") {
    return (
      <span
        className="italic text-gray-400 dark:text-gray-500 cursor-help"
        title={LIMITS_TOOLTIP}
      >
        Too complex to calculate
      </span>
    );
  }

  // A volatile formula's value NEVER comes from `computed` — recompute.py
  // skips it unconditionally (spec §7.4), so `_merge_computed_into_rows`
  // never has anything to merge in for its key, and `computed` here is
  // always `undefined`. This is a distinct, honest state from "an ordinary
  // formula that just happens to be empty right now" — rendering it as a
  // plain "—" would look like a bug (or an empty formula) instead of what
  // it actually is (spec §7.4's per-request evaluation path is not built
  // yet — flagged in task-28-report.md, inherited from Task 27's own
  // flagged gap).
  if (computed === undefined && property.type === "formula" && property.is_volatile) {
    return (
      <span
        className="italic text-gray-400 dark:text-gray-500 cursor-help"
        title={VOLATILE_TOOLTIP}
      >
        Live formula
      </span>
    );
  }

  const text = computed ? formatComputed(computed) : null;
  return (
    <span className="truncate text-gray-500 dark:text-gray-400">
      {text ?? <span className="text-gray-400">—</span>}
    </span>
  );
}
