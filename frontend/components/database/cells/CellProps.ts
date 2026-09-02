// Shared contract for the 8 dedicated cell components (TitleCell,
// TextCell, NumberCell, SelectCell, MultiSelectCell, StatusCell, DateCell,
// CheckboxCell) plus the pill-color helper they share for Select/
// Multi-select/Status.

export interface CellProps<V> {
  /** Undefined means the property is absent for this row (spec: "Absent key ≡ empty"). */
  value: V | undefined;
  /** All Notes cells are always read-only for M2 (no write endpoint yet — see
   * `update_row_property`'s 501 for `data_source_id === "all-notes"`).
   * Ordinary (non-virtual) databases pass true. */
  editable: boolean;
  /** Commit a new value, or `null` to clear the property, through
   * `useDatabaseView`'s optimistic update. Never called when `editable` is false. */
  onChange: (value: V | null) => void;
}

// A small, stable palette so pills for arbitrary option strings (this
// milestone doesn't guarantee `property.config` carries per-option colors)
// still look visually distinct and are deterministic between renders of
// the same label.
const PILL_PALETTE = [
  "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  "bg-amber-50 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400",
  "bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400",
  "bg-green-50 text-green-600 dark:bg-green-900/40 dark:text-green-400",
  "bg-purple-50 text-purple-600 dark:bg-purple-900/40 dark:text-purple-400",
  "bg-pink-50 text-pink-600 dark:bg-pink-900/40 dark:text-pink-400",
  "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400",
];

export function pillStyleFor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return PILL_PALETTE[Math.abs(hash) % PILL_PALETTE.length];
}

// Notion's 10 option colors. These are what the `Edit property` panel's
// `Colors` list writes onto an option, so they have to be what the cell reads
// back — otherwise the colour picker is a control with no visible effect.
const OPTION_PILL_CLASSES: Record<string, string> = {
  default: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300",
  gray: "bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200",
  brown: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  orange: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  yellow: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  green: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  purple: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  pink: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
  red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

export interface ConfiguredOption {
  id: string;
  name: string;
  color?: string;
}

/** Pill classes for one value of a select/multi-select/status column.
 *
 * A CONFIGURED option (one the user created in `Edit property`) uses its own
 * colour. Anything else falls back to the hash palette above.
 *
 * The fallback is not dead code: these three cells are free-text today — they
 * store whatever is typed rather than an option id — so a column can perfectly
 * well hold values that are in no option list. Rebuilding them as real option
 * pickers is `cell-editing.md`'s surface, not this one; until then, matching by
 * NAME is what makes the colour picker take visible effect for every option a
 * user actually configured. */
export function pillStyleForOption(
  label: string,
  options: ConfiguredOption[] | undefined
): string {
  const match = options?.find((o) => o.name === label);
  if (!match) return pillStyleFor(label);
  return OPTION_PILL_CLASSES[match.color ?? "default"] ?? OPTION_PILL_CLASSES.default;
}
