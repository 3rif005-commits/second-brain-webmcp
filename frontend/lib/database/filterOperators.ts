// M4's per-type operator table — a hand-kept TypeScript mirror of
// `backend/services/db/query/operators.py`'s `TYPE_OPERATORS`
// (`_FAMILIES`), not fetched at runtime: there is no HTTP endpoint that
// serves this table (unlike `TYPE_OPERATORS`'s own consumer, the compiler,
// which lives entirely server-side), so filter-panel.md's "derive from
// TYPE_OPERATORS, don't hardcode" is satisfied by keeping this file's shape
// byte-for-byte in step with the backend's, not by a network round-trip.
// Keep the two in sync by hand if operators.py's `_FAMILIES` ever changes.
//
// SCOPE DECISION (filter-panel.md's "two AST questions ... flag both, do
// not invent"): our Date family has no `between` operator and no generic
// "relative to today" builder — Notion's captured 9 date operators (Is,
// Is before, Is after, Is on or before, Is on or after, Is between, Is
// relative to today, Is empty, Is not empty) don't line up with our actual
// 14 (`_DATE_OPS`: equals/before/after/on_or_before/on_or_after/this_week/
// past_week/past_month/past_year/next_week/next_month/next_year/is_empty/
// is_not_empty). The UI shows OUR operators, not Notion's — which is also
// what sidesteps the "between takes two values" AST question entirely: we
// have no operator that needs a second value, so `FilterCondition.value`
// staying a single `Any` is never a problem. The other question (a date
// filter targeting a sub-property, start vs end) has no answer either: our
// compiler has no concept of it (`_date_instant` always projects `start`),
// so a date filter here always targets the property's single instant — not
// a deliberate design choice, a scope boundary of what the backend can do.
//
// Select/status's `equals`/`does_not_equal` and Multi-select's
// `contains`/`does_not_contain` are `arg_type: "str_or_list"` on the
// backend — genuinely either a single value OR an array — which is what
// lets their value editor be Notion's own "searchable multi-select
// checkbox list of the property's options, rendered as chips" with NO
// backend change: an array value for `equals` is already legal.
import type { PropertyResponse } from "./types";

export type FilterArgType =
  | "str"
  | "num"
  | "bool"
  | "date"
  | "uuid"
  | "uuid_or_me"
  | "str_or_list"
  | "verification_status"
  | "none";

export interface FilterOperator {
  name: string;
  argType: FilterArgType;
  /** Notion's own copy where captured (Text/Select's 8/4); our own
   * plain-English equivalent, not captured, for the 10 extra Date
   * operators our engine has that Notion's UI doesn't expose the same way. */
  label: string;
}

function op(name: string, argType: FilterArgType, label: string): FilterOperator {
  return { name, argType, label };
}

const TEXT_OPS: FilterOperator[] = [
  op("equals", "str", "Is"),
  op("does_not_equal", "str", "Is not"),
  op("contains", "str", "Contains"),
  op("does_not_contain", "str", "Does not contain"),
  op("starts_with", "str", "Starts with"),
  op("ends_with", "str", "Ends with"),
  op("is_empty", "none", "Is empty"),
  op("is_not_empty", "none", "Is not empty"),
];

const NUMBER_OPS: FilterOperator[] = [
  op("equals", "num", "Is equal to"),
  op("does_not_equal", "num", "Is not equal to"),
  op("greater_than", "num", "Is greater than"),
  op("less_than", "num", "Is less than"),
  op("greater_than_or_equal_to", "num", "Is greater than or equal to"),
  op("less_than_or_equal_to", "num", "Is less than or equal to"),
  op("is_empty", "none", "Is empty"),
  op("is_not_empty", "none", "Is not empty"),
];

const CHECKBOX_OPS: FilterOperator[] = [op("equals", "bool", "Is"), op("does_not_equal", "bool", "Is not")];

const SELECT_OPS: FilterOperator[] = [
  op("equals", "str_or_list", "Is"),
  op("does_not_equal", "str_or_list", "Is not"),
  op("is_empty", "none", "Is empty"),
  op("is_not_empty", "none", "Is not empty"),
];

const MULTI_SELECT_OPS: FilterOperator[] = [
  op("contains", "str_or_list", "Contains"),
  op("does_not_contain", "str_or_list", "Does not contain"),
  op("is_empty", "none", "Is empty"),
  op("is_not_empty", "none", "Is not empty"),
];

const DATE_OPS: FilterOperator[] = [
  op("equals", "date", "Is"),
  op("before", "date", "Is before"),
  op("after", "date", "Is after"),
  op("on_or_before", "date", "Is on or before"),
  op("on_or_after", "date", "Is on or after"),
  op("this_week", "none", "Is this week"),
  op("past_week", "none", "Is within the past week"),
  op("past_month", "none", "Is within the past month"),
  op("past_year", "none", "Is within the past year"),
  op("next_week", "none", "Is within the next week"),
  op("next_month", "none", "Is within the next month"),
  op("next_year", "none", "Is within the next year"),
  op("is_empty", "none", "Is empty"),
  op("is_not_empty", "none", "Is not empty"),
];

const PEOPLE_OPS: FilterOperator[] = [
  op("contains", "uuid_or_me", "Contains"),
  op("does_not_contain", "uuid_or_me", "Does not contain"),
  op("is_empty", "none", "Is empty"),
  op("is_not_empty", "none", "Is not empty"),
];

const FILES_OPS: FilterOperator[] = [op("is_empty", "none", "Is empty"), op("is_not_empty", "none", "Is not empty")];

const RELATION_OPS: FilterOperator[] = [
  op("contains", "uuid", "Contains"),
  op("does_not_contain", "uuid", "Does not contain"),
  op("is_empty", "none", "Is empty"),
  op("is_not_empty", "none", "Is not empty"),
];

const VERIFICATION_OPS: FilterOperator[] = [op("status", "verification_status", "Status")];

/** Mirrors `operators.py`'s `TYPE_OPERATORS` — a type is a KEY here iff it
 * is a key there. `formula`/`rollup` (dispatched by `result_type`, not
 * `type`) and `place`/`button` (not filterable at all) are absent, same as
 * the backend. */
export const TYPE_OPERATORS: Record<string, FilterOperator[]> = {
  title: TEXT_OPS,
  rich_text: TEXT_OPS,
  url: TEXT_OPS,
  email: TEXT_OPS,
  phone_number: TEXT_OPS,
  number: NUMBER_OPS,
  unique_id: NUMBER_OPS,
  checkbox: CHECKBOX_OPS,
  select: SELECT_OPS,
  multi_select: MULTI_SELECT_OPS,
  status: SELECT_OPS,
  date: DATE_OPS,
  created_time: DATE_OPS,
  last_edited_time: DATE_OPS,
  people: PEOPLE_OPS,
  created_by: PEOPLE_OPS,
  last_edited_by: PEOPLE_OPS,
  files: FILES_OPS,
  relation: RELATION_OPS,
  verification: VERIFICATION_OPS,
};

export function isFilterableType(type: string): boolean {
  return type in TYPE_OPERATORS;
}

export function operatorsForType(type: string): FilterOperator[] {
  return TYPE_OPERATORS[type] ?? [];
}

export function operatorFor(type: string, name: string): FilterOperator | undefined {
  return operatorsForType(type).find((o) => o.name === name);
}

/** The value a fresh condition should carry for `operator.argType`, so the
 * value editor's own DISPLAYED default and what's actually PERSISTED never
 * diverge. Live-verified reachable and wrong without this: `ValueEditor`'s
 * `bool`/`verification_status` editors are `<select>`s that show a real,
 * specific option selected (`Unchecked`/`None`) purely from a local
 * `value == null` fallback — but a `<select>` only fires `onChange` on an
 * actual change event, so that shown-but-never-chosen default was never
 * written to the condition. Combined with `sanitizeFilterForQuery` (which
 * correctly treats a still-`undefined` value as incomplete), a fresh
 * Checkbox or Verification condition looked complete in the UI yet silently
 * never filtered anything — caught live in an `Or`-group where the
 * checkbox condition's contribution vanished entirely, narrowing the table
 * to only the OTHER rule's matches. Every other `argType` has no honest
 * non-empty default (an empty text/number/date input already displays as
 * empty, matching what's persisted), so this only needs the two argTypes
 * whose editor pre-selects a real option. */
export function defaultValueForOperator(operator: FilterOperator): unknown {
  if (operator.argType === "bool") return false;
  if (operator.argType === "verification_status") return "none";
  return undefined;
}

/** The option list a Select/Status/Multi-select's `str_or_list` value editor
 * (a searchable, chip-rendered checkbox list) offers — `property.config`'s
 * own configured options, same shape `pillStyleForOption` (cells/
 * CellProps.ts) already reads for cell rendering. */
export function configuredOptions(property: PropertyResponse): { id: string; name: string; color?: string }[] {
  const raw = property.config?.options;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (o): o is { id: string; name: string; color?: string } =>
      Boolean(o) && typeof o === "object" && typeof (o as Record<string, unknown>).name === "string"
  );
}
