// TypeScript mirrors of backend/models/database.py's Pydantic models
// (Milestone 2 — Notion-style databases). Field names and shapes match the
// backend exactly so `useDatabaseView` can treat a fetch response as this
// type with no per-field mapping. See backend/models/database.py for the
// authoritative docstrings this file doesn't repeat.

export interface DatabaseResponse {
  id: string;
  user_id: string;
  title: string;
  description: unknown[];
  icon: string | null;
  cover_url: string | null;
  is_inline: boolean;
  parent_note_id: string | null;
  is_locked: boolean;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface DataSourceResponse {
  id: string;
  database_id: string;
  user_id: string;
  name: string;
  system_kind: "notes" | null;
  position: number;
  created_at: string;
  /** True only for the synthesized "All Notes" source. */
  is_virtual: boolean;
}

export interface PropertyResponse {
  id: string;
  data_source_id: string;
  user_id: string;
  /** 8-char base62 key for jsonb-storage props; a `notes` column name for column-backed ones. */
  key: string;
  name: string;
  /** One of the REGISTRY type strings — see PROPERTY_TYPES below for the 8 this UI renders natively. */
  type: string;
  config: Record<string, unknown>;
  description: string | null;
  storage: "jsonb" | "column";
  column_name: string | null;
  result_type: string | null;
  is_volatile: boolean;
  position: number;
  created_at: string;
  /** Every type this property may be changed into (backend Phase 0b, B5).
   *
   * Served with the property so the "Change type" list greys illegal rows
   * against the SAME source of truth the PATCH enforces. Do not hardcode a
   * client-side matrix — it would be a second copy and it would drift.
   *
   * OPTIONAL because it is DERIVED: the backend always sends it, but callers
   * that construct a PropertyResponse locally (the public form page, test
   * fixtures) legitimately have no conversion rules to state. Consumers
   * default to `[]`, which greys every conversion — the safe direction. */
  convertible_to?: string[];
}

export interface ViewResponse {
  id: string;
  data_source_id: string;
  user_id: string;
  name: string;
  icon: string | null;
  type: string;
  config: Record<string, unknown>;
  filter: Record<string, unknown> | null;
  sorts: unknown[];
  is_locked: boolean;
  position: number;
}

export interface DatabaseDetailResponse {
  database: DatabaseResponse;
  data_source: DataSourceResponse;
  properties: PropertyResponse[];
  views: ViewResponse[];
}

/** `GET /db/databases` (commit 397ba23, task-31) — every database this user
 * owns plus the one data source Milestone 2 always creates for it. Powers
 * the relation-target and rollup-source pickers (task-31 Part 1/3), which
 * need "which database?" without paying for each one's full property/view
 * list (`DatabaseDetailResponse`) the way `GET /db/databases/{id}` returns.
 * The built-in All Notes virtual source is never included — it has no
 * `db_databases` row and cannot be a relation target. */
export interface DatabaseSummary {
  database: DatabaseResponse;
  data_source: DataSourceResponse;
}

export interface DatabaseListResponse {
  databases: DatabaseSummary[];
}

/** JSON mirror of `services.db.query.grouping.GroupBySpec` (task-15's
 * `QueryRequest.group_by`/`sub_group_by`, and the shape stored verbatim at
 * `ViewResponse.config.group_by`/`config.sub_group_by` — spec §10's "config
 * follows Notion's own Views API verbatim"). Only `property_key` is
 * required; everything else is per-type/optional exactly as the backend
 * dataclass documents.
 *
 * `group_order`/`group_order_manual`/`hidden_groups` (M6, 2026-09-01) are
 * UI-only additions living on this SAME object, per group-panel.md's own
 * capture (`config.group_by.group_order`, not a sibling config key) — but
 * they must NEVER reach `POST .../query`'s `group_by` field as-is:
 * `grouping.GroupBySpec` is a plain dataclass (`GroupBySpec(**body.
 * group_by)`), which raises `TypeError` on any unknown kwarg, surfaced as a
 * 400 that would break grouping entirely the moment any of these three is
 * ever set. `backendGroupBySpec` below is the one place that strips them
 * before a request goes out — every reader of this type must go through it
 * rather than forwarding `config.group_by` verbatim. */
export interface GroupBySpec {
  property_key: string;
  mode?: string;
  start_day_of_week?: number;
  range_start?: number | null;
  range_end?: number | null;
  range_size?: number | null;
  hide_empty_groups?: boolean;
  /** Group ORDERING (group-panel.md §A) — distinct from the view's row
   * `Sort`. Defaults to "manual" when absent. */
  group_order?: "manual" | "alphabetical" | "reverse_alphabetical";
  /** Explicit group key order for `group_order: "manual"` — groups not
   * listed here (e.g. a brand new option) sort after the ones that are. */
  group_order_manual?: string[];
  /** Group keys hidden from the table (per-group visibility, group-
   * panel.md's per-group 👁/👁̸ toggle) — independent of `hide_empty_groups`,
   * which hides only groups with zero rows. */
  hidden_groups?: string[];
}

const _BACKEND_GROUP_BY_KEYS = [
  "property_key",
  "mode",
  "start_day_of_week",
  "range_start",
  "range_end",
  "range_size",
  "hide_empty_groups",
] as const;

/** The subset of `GroupBySpec` the backend's dataclass actually accepts —
 * see this interface's own doc comment for why sending the UI-only fields
 * verbatim would 400 every grouped query. */
export function backendGroupBySpec(spec: GroupBySpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of _BACKEND_GROUP_BY_KEYS) {
    if (spec[key] !== undefined) out[key] = spec[key];
  }
  return out;
}

/** JSON mirror of `GroupResult` (task-15's `QueryResponse.groups[]`).
 * `subgroups` is `null`/absent unless `sub_group_by` was requested, and —
 * same as the backend `Group` dataclass — never present on a subgroup
 * itself (sub-grouping is exactly two levels).
 *
 * `aggregates` (Milestone 10, task-32) is `undefined`/`null` whenever the
 * request's `aggregations` was empty (byte-identical to before that field
 * existed — see `AggregationSpec`'s own docstring on the backend); when
 * present it's one `{spec.key: value}` entry per requested aggregation,
 * computed from *this* group's own rows (or, for a subgroup entry, that
 * subgroup's own rows). Chart (task-35) is the first consumer — it always
 * requests exactly one aggregation keyed `"y"`, so `aggregates?.y` is the
 * bar/line-point/donut-slice value for that group. */
export interface Group {
  key: string;
  label: string;
  row_count: number;
  rows: DatabaseRow[];
  subgroups: Group[] | null;
  aggregates?: Record<string, number> | null;
}

/** The property types `services.db.query.grouping.group_rows` can group by
 * without raising `ValueError`/`NotImplementedError` for a missing mode.
 *
 * Plan Phase 0c (2026-09-01): the engine (`grouping.py`) already supports
 * every one of these — range/bucket grouping for Number, day/week/month/year
 * for Date, boolean for Checkbox, exact-value for the text-shaped types, plus
 * every already-supported multi/single-valued type — this constant was just
 * never widened to match after the engine work landed (task-13/15, long
 * before this plan existed). Mirrors the backend's REGISTRY key list minus
 * `grouping._NOT_GROUPABLE` (files, rollup, unique_id, verification, button,
 * place) and `formula` (needs the formula engine's result type first,
 * `grouping.group_rows` raises `NotImplementedError` — Milestone 8, still
 * deferred). Not derived at runtime from an endpoint the same way Filter
 * derives operators from `TYPE_OPERATORS` — there is no HTTP surface for
 * this table — so this list is a hand-kept mirror; keep it in sync with
 * `_NOT_GROUPABLE` if that ever changes. */
export const GROUPABLE_PROPERTY_TYPES = [
  "title",
  "rich_text",
  "select",
  "multi_select",
  "status",
  "date",
  "number",
  "people",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "relation",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
] as const;

export type GroupablePropertyType = (typeof GROUPABLE_PROPERTY_TYPES)[number];

export function isGroupablePropertyType(type: string): type is GroupablePropertyType {
  return (GROUPABLE_PROPERTY_TYPES as readonly string[]).includes(type);
}

const _DATE_GROUP_TYPES = new Set(["date", "created_time", "last_edited_time"]);
const _TEXT_GROUP_TYPES = new Set(["title", "rich_text", "url", "email", "phone_number"]);

/** Builds the `GroupBySpec` a fresh "group by this property" action should
 * send — the one place every entry point (column header menu, group panel,
 * Board/Chart creation) fills in the per-type `mode` `grouping.group_rows`
 * requires before it will accept the type, rather than each writer copying
 * its own `status`-only special case (which is how Chart/Board's creation
 * flows and the column header menu's "Group" row each independently forgot
 * to do the same for Date/Text once this constant above widened past
 * select/status/multi_select).
 *
 * `status` needs `mode: "option"` (individual options, not status *groups*
 * — those aren't configurable anywhere in this UI). Date-family types need
 * a bucket unit; group-panel.md never captured a per-view unit selector for
 * it, so `"month"` is a placeholder default, not an invented Notion value —
 * TBD until that row is captured. Text-shaped types need `mode: "exact"`
 * (the other option, `"alphabet_prefix"`, has no UI entry point yet).
 * Every other groupable type (Select, Multi-select, Number, Checkbox,
 * People, Relation, …) needs no mode at all. */
export function defaultGroupMode(type: string): string | undefined {
  if (type === "status") return "option";
  if (_DATE_GROUP_TYPES.has(type)) return "month";
  if (_TEXT_GROUP_TYPES.has(type)) return "exact";
  return undefined;
}

export function defaultGroupBySpec(property: Pick<PropertyResponse, "key" | "type">): GroupBySpec {
  // group-panel.md's own capture (line 85's table, restated by its checklist
  // step 6): "Hide empty groups | toggle, ON by default". Live-verified
  // reachable and wrong without this: grouping by a property with an
  // implicit "No <Property>" bucket left that empty group visible in the
  // table from the first click, rather than hidden the way Notion's own
  // default behaves.
  const spec: GroupBySpec = { property_key: property.key, hide_empty_groups: true };
  const mode = defaultGroupMode(property.type);
  if (mode) spec.mode = mode;
  return spec;
}

/** Reads `config.group_by`/`config.sub_group_by` out of a view's opaque
 * `config` JSONB, tolerating a missing/malformed shape (undefined, not a
 * throw) — same "tolerates unknown... drops them at read" spirit spec §10
 * already states for view config generally. */
export function getGroupBySpec(config: Record<string, unknown>): GroupBySpec | undefined {
  const raw = config.group_by;
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).property_key === "string") {
    return raw as GroupBySpec;
  }
  return undefined;
}

export function getSubGroupBySpec(config: Record<string, unknown>): GroupBySpec | undefined {
  const raw = config.sub_group_by;
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).property_key === "string") {
    return raw as GroupBySpec;
  }
  return undefined;
}

/** Task-35's generalization of `useDatabaseView.ts`'s `loadRows()`: instead
 * of a growing pile of `if (activeView.type === X) body.foo = ...` branches
 * bolted on next to each other, every view type that needs extra `/query`
 * request fields beyond `filter`/`sorts` gets one entry point here, keyed
 * on `view.type`. Board (task-16) sends `group_by`/`sub_group_by` verbatim
 * from `config.group_by`/`config.sub_group_by` (already `GroupBySpec`-
 * shaped, `property_key` and all). Table (M6) sends `group_by` the same
 * way, but never `sub_group_by` — group-panel.md's own live capture found
 * no sub-group control in a table view (a plan assumption, corrected
 * 2026-08-31), unlike Board which keeps it. Chart (task-35) is a genuinely
 * new translation, not a reuse: its own `config.x_axis`/`config.y_axis`/
 * `config.stack_by` use Notion's own field name `property_id` (spec §10's
 * "config follows Notion's own Views API verbatim"), which has to be
 * renamed to `property_key` to match `GroupBySpec`/`AggregationSpec`'s own
 * field name before it can ride in the same request body. Every other view
 * type falls through to `{}` — byte-identical to before this function
 * existed. */
export function getQueryExtras(view: Pick<ViewResponse, "type" | "config">): Record<string, unknown> {
  if (view.type === "board" || view.type === "table") {
    const extras: Record<string, unknown> = {};
    const groupBy = getGroupBySpec(view.config);
    // `backendGroupBySpec`, not `groupBy` verbatim — see GroupBySpec's own
    // doc comment: M6's group_order/group_order_manual/hidden_groups live
    // on this same object but would 400 the query if forwarded as-is.
    if (groupBy) extras.group_by = backendGroupBySpec(groupBy);
    if (view.type === "board") {
      const subGroupBy = getSubGroupBySpec(view.config);
      if (subGroupBy) extras.sub_group_by = subGroupBy;
    }
    // M11 (calculations-row.md): the footer row's own values, one
    // `AggregationSpec` per column carrying a calculation
    // (`config.calculations`, M1's Calculate sub-panel — already written,
    // never read before now). `key: propertyKey` (not a synthetic label
    // like Chart's `"y"`) since `QueryResponse.aggregates` is echoed back
    // keyed by `spec.key`, and a table footer needs exactly one value per
    // column, addressable by that column's own key.
    //
    // Deliberately NOT sent alongside a `group_by` — a grouped query
    // computes aggregates PER GROUP (`GroupResult.aggregates`), which this
    // milestone's footer does not render (calculations-row.md's own
    // States table: "Grouped view: TBD — capture first"); sending it
    // regardless would just burn a `compute_full_set` server round-trip
    // for a response `TableView` never reads.
    if (view.type === "table" && !groupBy) {
      const raw = view.config.calculations;
      if (raw && typeof raw === "object") {
        const specs = Object.entries(raw as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([propertyKey, aggregator]) => ({ key: propertyKey, property_key: propertyKey, aggregator }));
        if (specs.length > 0) extras.aggregations = specs;
      }
    }
    return extras;
  }

  if (view.type === "chart") {
    const extras: Record<string, unknown> = {};
    const chartType = getChartType(view.config);
    const yAxis = getChartYAxis(view.config);
    if (yAxis) {
      extras.aggregations = [
        { key: "y", aggregator: yAxis.aggregator, property_key: yAxis.property_id },
      ];
    }
    // "number" mode has no x-axis at all (a single scalar over every
    // filtered/sorted row, computed ungrouped server-side) — see
    // `AggregationSpec`'s "Chart's Number-type mode" docstring.
    if (chartType !== "number") {
      const xAxis = getChartXAxis(view.config);
      if (xAxis) {
        const groupBy: Record<string, unknown> = { property_key: xAxis.property_id };
        if (xAxis.mode) groupBy.mode = xAxis.mode;
        if (getChartHideEmptyGroups(view.config)) groupBy.hide_empty_groups = true;
        extras.group_by = groupBy;

        const stackBy = getChartStackBy(view.config);
        if (stackBy) {
          const subGroupBy: Record<string, unknown> = { property_key: stackBy.property_id };
          if (stackBy.mode) subGroupBy.mode = stackBy.mode;
          extras.sub_group_by = subGroupBy;
        }
      }
    }
    return extras;
  }

  return {};
}

/** One row's per-property values, keyed by `PropertyResponse.key`. Works for
 * both ordinary and virtual (All Notes) sources — see RowsResponse below.
 *
 * `cover_image_url` (task-17): a dedicated field, not a `properties[]` entry —
 * mirrors the backend's own choice (`routers/databases.py`'s
 * `_decode_all_notes_row`/`_decode_ordinary_row`, task-15's query endpoint)
 * to lift the `notes.cover_image_url` column out alongside `properties`
 * rather than exposing it as a new `COLUMN_BACKED` property, so it never
 * shows up as a Table/Board column. Only ever populated by `POST .../query`
 * (`useDatabaseView`'s `loadRows`) — `undefined` is the "this row came from
 * somewhere else, or the note has no cover" case; GalleryView's placeholder
 * treats both `undefined` and `null` the same way. */
export interface DatabaseRow {
  id: string;
  properties: Record<string, PropertyValue>;
  cover_image_url?: string | null;
}

export interface RowsResponse {
  rows: DatabaseRow[];
}

/** One row moved by a Milestone 7 dependency date-shift cascade — mirrors
 * `backend/models/database.py`'s `ShiftedRow` exactly. `properties` carries
 * only the one date property that moved, wrapped the same §3.3 way as any
 * other property value, so it merges into `DatabaseRow.properties` with the
 * same shape `updateCell` already handles for an ordinary write. */
export interface ShiftedRow {
  id: string;
  properties: Record<string, PropertyValue>;
}

export interface RowResponse {
  id: string;
  properties: Record<string, PropertyValue>;
  /** M7 combined-review Important finding 2: `PATCH .../rows/{note_id}`
   * returns this so a dependency cascade (edit row A's date, watch row B
   * move) can update the client without a refetch — non-`null`/non-`undefined`
   * only when this write triggered a cascade that actually moved rows.
   * `undefined` (the response omits the key entirely, since the backend's
   * `shifted_rows: list[ShiftedRow] | None = None` serialises an unset
   * `None` the same as an absent key over JSON) and `null` (an explicit
   * `None`) are both "no cascade" — `useDatabaseView`'s `updateCell` must
   * treat them the same. */
  shifted_rows?: ShiftedRow[] | null;
}

export interface RowPropertyUpdate {
  property_key: string;
  /** The same discriminated wrapper shape as a PropertyValue, or null to clear the property. */
  value: PropertyValue | null;
}

// ── Property value wrappers (spec §3.3's discriminated union) ─────────────
// Every cell value the backend returns is `{type: <type>, <type>: <inner>}`.
// These 8 are the ones this milestone renders with a dedicated cell
// component; any other `type` string falls back to a generic read-only
// rendering (see cells/GenericCell.tsx) rather than being dropped.

export interface TitleValue { type: "title"; title: string }
export interface RichTextValue { type: "rich_text"; rich_text: string }
export interface NumberValue { type: "number"; number: number | null }
export interface SelectValue { type: "select"; select: string | null }
export interface MultiSelectValue { type: "multi_select"; multi_select: string[] }
export interface StatusValue { type: "status"; status: string | null }
export interface DateValue {
  type: "date";
  date: { start: string; end: string | null; time_zone: string | null } | null;
}
export interface CheckboxValue { type: "checkbox"; checkbox: boolean }
// M2b. All three are the same shape as rich_text on the wire — the backend's
// _TEXT_SHAPE_TYPES already groups them with title/rich_text — but they are
// separate types here because their CELLS differ: a URL is a link, an email
// opens a mail client, a phone is tel:. Collapsing them to one alias would
// lose exactly the difference that makes them worth having.
export interface UrlValue { type: "url"; url: string }
export interface EmailValue { type: "email"; email: string }
export interface PhoneValue { type: "phone_number"; phone_number: string }

/** Any wrapper shape not in the 8 above — rendered by the generic fallback cell. */
export interface UnknownValue {
  type: string;
  [key: string]: unknown;
}

export type PropertyValue =
  | TitleValue
  | RichTextValue
  | NumberValue
  | SelectValue
  | MultiSelectValue
  | StatusValue
  | DateValue
  | CheckboxValue
  | UrlValue
  | EmailValue
  | PhoneValue
  | UnknownValue;

// ── Milestone 7: relations, sub-items, dependencies ────────────────────────
// Mirrors backend/models/database.py's RelatedRow/RelationLinksResponse
// (task-21) plus services.db.relations.DATE_SHIFT_MODES (task-20) — see
// backend/services/db/relations.py for the authoritative strings. Relation
// *values* never appear in DatabaseRow.properties (migration 015: they live
// in db_relation_links, not db_row_props.properties — see task-21-report.md
// judgement calls and task-22-report.md), so they get their own types here
// rather than joining the PropertyValue union above.

/** One linked row, as returned by every `.../relations/...` endpoint. */
export interface RelatedRow {
  id: string;
  title: string;
}

export interface RelationLinksResponse {
  rows: RelatedRow[];
}

/** `POST .../relations/{property_key}/links/bulk` (M7 combined-review
 * Important finding 3, the N+1 fix) — one entry per requested row id, keyed
 * by that row's own id, `[]` (not an absent key) for a row with no links.
 * Mirrors `backend/models/database.py`'s `RelationLinksBulkResponse`. */
export interface RelationLinksBulkResponse {
  links: Record<string, RelatedRow[]>;
}

/** `services.db.relations.DATE_SHIFT_MODES` verbatim — task-21-brief.md/
 * task-22-brief.md §4 both require these exact strings (not paraphrased)
 * to appear in the dependency settings UI. */
export const DATE_SHIFT_MODES = [
  "Shift only when dates overlap",
  "Shift & maintain time between items",
  "Do not automatically shift",
] as const;

export type DateShiftMode = (typeof DATE_SHIFT_MODES)[number];

/** The two `config.subtasks.display_mode` values this milestone renders
 * (research §3.4 also lists `hidden`/`disabled` — task-22-brief.md §3
 * explicitly scopes this task down to `show`/`flattened` only). Lives on
 * the *view's* config, not the property (research §3.2: the sub-item
 * property choice is data-source-global — there is exactly one sub-item
 * relation pair per data source, found via `config.system === "sub_item"`
 * on a `type: "relation"` property, not a per-view setting). */
export const SUBTASK_DISPLAY_MODES = ["show", "flattened"] as const;

export type SubtaskDisplayMode = (typeof SUBTASK_DISPLAY_MODES)[number];

/** Reads `config.subtasks.display_mode` out of a view's opaque `config`
 * JSONB, tolerating a missing/malformed shape — same spirit as
 * `getGroupBySpec`/`getSubGroupBySpec` above. */
export function getSubtaskDisplayMode(config: Record<string, unknown>): SubtaskDisplayMode | undefined {
  const raw = config.subtasks;
  if (raw && typeof raw === "object") {
    const mode = (raw as Record<string, unknown>).display_mode;
    if (typeof mode === "string" && (SUBTASK_DISPLAY_MODES as readonly string[]).includes(mode)) {
      return mode as SubtaskDisplayMode;
    }
  }
  return undefined;
}

/** Finds the one sub-item or dependency relation pair's forward/reverse
 * property on a data source's `properties[]`, by `config.system`/
 * `config.side` — mirrors how `routers/databases.py`'s own
 * `update_dependency_settings` looks up the forward dependency property.
 * `undefined` when the system relation hasn't been enabled yet. */
export function findSystemRelationProperty(
  properties: PropertyResponse[],
  system: "sub_item" | "dependency",
  side: "forward" | "reverse"
): PropertyResponse | undefined {
  return properties.find(
    (p) => p.type === "relation" && p.config?.system === system && p.config?.side === side
  );
}

// ── Milestone 8: formula/rollup computed values and the validate endpoint ──
// Mirrors backend/services/db/properties/computed.py's `COMPUTED_VALUE_
// SHAPES` and backend/services/db/recompute.py's `_encode_fvalue` (spec
// §7.3). A materialised formula/rollup value is deliberately a DIFFERENT
// wrapper family from `PropertyValue` above, not a reuse of it: the
// discriminant is the formula's own `result_type` (`db_properties.
// result_type`, one of "string"/"number"/"boolean"/"date" — research
// §4.6/§4.7's "lossy 4-of-7 projection"), not a `db_properties.type` string,
// and `boolean`/`string`/`date` all use different inner keys than the
// stored `checkbox`/`rich_text`/`date` wrappers do (a computed Date has no
// `time_zone` key at all). Kept OUT of the `PropertyValue` union on purpose
// — a `type: "date"` member here with a shape that omits `time_zone` would
// make every existing `DateValue` narrowing site (DateCell, etc.) lie about
// what fields are actually present. Only `ComputedCell` ever reads this
// type, cast at the one place `renderCellValue` hands it a raw
// `PropertyValue | undefined` for a `formula`/`rollup` property.
export interface ComputedNumberValue { type: "number"; number: number | null }
export interface ComputedBooleanValue { type: "boolean"; boolean: boolean | null }
export interface ComputedStringValue { type: "string"; string: string | null }
export interface ComputedDateValue {
  type: "date";
  date: { start: string; end: string | null } | null;
}
/** research §B.1 ("depend[s] on excessive related pages or nested
 * formulas") / spec §7.3: the formula-depth-15, relation-traversal-depth-3,
 * or 10,000-row fan-out limit was hit. A REAL, documented Notion UI state
 * (shipped 2026-08-05), never an error and never a blank cell — see
 * `ComputedCell`. */
export interface ComputedUnsupportedValue { type: "unsupported" }

export type ComputedValue =
  | ComputedNumberValue
  | ComputedBooleanValue
  | ComputedStringValue
  | ComputedDateValue
  | ComputedUnsupportedValue;

/** Mirrors `backend/models/database.py`'s `FormulaValidationIssue`/
 * `FormulaValidateResponse` exactly — `POST .../formulas/validate`'s entire
 * response shape (spec §7.1: parse errors, inferred result type, referenced
 * property keys, nothing else — there is no evaluate-this-formula-for-me
 * endpoint). */
export interface FormulaValidationIssue {
  message: string;
  pos: number;
  line: number;
  col: number;
}

export interface FormulaValidateResponse {
  valid: boolean;
  errors: FormulaValidationIssue[];
  result_type: string | null;
  referenced_properties: string[];
  is_volatile: boolean;
}

/** Mirrors `backend/services/db/rollup.py`'s `ROLLUP_FUNCTIONS` verbatim —
 * task-31-brief.md §3: "fetch/mirror that list, do not invent one." There is
 * no dedicated endpoint that returns this list; it's small, fixed, and
 * documented (research §3.7's 22 functions, NOT the research document's own
 * 24 -- `count_per_group`/`percent_per_group` are excluded server-side too,
 * see that module's own comment), so mirroring it here is the same
 * trade-off `DATE_SHIFT_MODES` above already made for
 * `services.db.relations.DATE_SHIFT_MODES`. A future rename on the backend
 * side won't silently drift here since `test_rollup.py` pins the backend's
 * own set equality against `aggregations.py` — this array is simply
 * expected to be kept in lockstep by hand. */
export const ROLLUP_FUNCTIONS = [
  "average", "checked", "count", "count_values", "date_range",
  "earliest_date", "empty", "latest_date", "max", "median", "min",
  "not_empty", "percent_checked", "percent_empty", "percent_not_empty",
  "percent_unchecked", "range", "show_original", "show_unique", "sum",
  "unchecked", "unique",
] as const;

export type RollupFunction = (typeof ROLLUP_FUNCTIONS)[number];

/** The 8 property `type` strings this UI has a dedicated cell component for. */
export const KNOWN_PROPERTY_TYPES = [
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
] as const;

export type KnownPropertyType = (typeof KNOWN_PROPERTY_TYPES)[number];

export function isKnownPropertyType(type: string): type is KnownPropertyType {
  return (KNOWN_PROPERTY_TYPES as readonly string[]).includes(type);
}

// ── Milestone 10 (task-35): Chart view config ──────────────────────────────
// Lives on the view's own opaque `config` JSONB (freeform, no schema change
// — same as every other view's config), using Notion's own chart-config
// field names verbatim (spec §10's stated principle) — `x_axis`/`y_axis`/
// `stack_by` each carry `property_id`, NOT `property_key` the way `Group
// BySpec`/`AggregationSpec` do; `getQueryExtras` above is the one place that
// translates between the two when building a `/query` request. See research
// §G.9 (~line 2626) for the full option matrix this task deliberately only
// implements a slice of (see ChartView.tsx's own scope-cut comment).

/** `"column"` = vertical bars, `"bar"` = horizontal bars — Notion's own
 * naming is swapped from the intuitive reading (research's flagged gotcha).
 * Get this backwards and every column/bar chart in the app renders
 * sideways. */
export const CHART_TYPES = ["column", "bar", "line", "donut", "number"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Mirrors `services.db.query.aggregations._VALID_AGGREGATORS` verbatim —
 * same hand-kept-in-lockstep trade-off as `ROLLUP_FUNCTIONS` above. */
export const CHART_Y_AXIS_AGGREGATORS = [
  "count", "count_values", "sum", "average", "median", "min", "max", "range",
  "unique", "empty", "not_empty", "percent_empty", "percent_not_empty",
  "checked", "unchecked", "percent_checked", "percent_unchecked",
  "earliest_date", "latest_date", "date_range",
] as const;
export type ChartYAxisAggregator = (typeof CHART_Y_AXIS_AGGREGATORS)[number];

export type ChartGroupStyle = "normal" | "percent" | "side_by_side";

/** `config.x_axis`/`config.stack_by`'s shape — a `GroupBySpec`-equivalent
 * concept (research confirms Chart's x-axis IS a group-by), just spelled
 * with Notion's own `property_id` key instead of this app's
 * `GroupBySpec.property_key`. */
export interface ChartAxisSpec {
  property_id: string;
  mode?: string;
}

/** `config.y_axis`'s shape. `property_id` is only omitted (or ignored) when
 * `aggregator === "count"` — the one property-independent aggregator,
 * mirroring `AggregationSpec.property_key`'s own "`None` only for count"
 * contract on the backend. */
export interface ChartYAxisSpec {
  aggregator: string;
  property_id?: string;
}

export interface ChartReferenceLine {
  id: string;
  value: number;
  label: string;
  color: string;
  dash_style: "solid" | "dash";
}

export function getChartType(config: Record<string, unknown>): ChartType {
  const raw = config.chart_type;
  return typeof raw === "string" && (CHART_TYPES as readonly string[]).includes(raw)
    ? (raw as ChartType)
    : "column";
}

export function getChartXAxis(config: Record<string, unknown>): ChartAxisSpec | undefined {
  const raw = config.x_axis;
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).property_id === "string") {
    return raw as ChartAxisSpec;
  }
  return undefined;
}

export function getChartYAxis(config: Record<string, unknown>): ChartYAxisSpec | undefined {
  const raw = config.y_axis;
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).aggregator === "string") {
    return raw as ChartYAxisSpec;
  }
  return undefined;
}

/** `null` is a valid, common return here (no stacking configured) — kept
 * distinct from `undefined` (a malformed/absent `config.stack_by`) the same
 * way `relationLinks`' cache distinguishes "not fetched" from "fetched,
 * empty" elsewhere in this codebase, though callers here only ever need to
 * treat both as falsy ("no stack_by"). */
export function getChartStackBy(config: Record<string, unknown>): ChartAxisSpec | undefined {
  const raw = config.stack_by;
  if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).property_id === "string") {
    return raw as ChartAxisSpec;
  }
  return undefined;
}

export function getChartGroupStyle(config: Record<string, unknown>): ChartGroupStyle {
  const raw = config.group_style;
  return raw === "percent" || raw === "side_by_side" ? raw : "normal";
}

export function getChartHideEmptyGroups(config: Record<string, unknown>): boolean {
  return config.hide_empty_groups === true;
}

export function getChartReferenceLines(config: Record<string, unknown>): ChartReferenceLine[] {
  const raw = config.reference_lines;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (l): l is ChartReferenceLine =>
      l && typeof l === "object" && typeof l.id === "string" && typeof l.value === "number"
  );
}

// ── Milestone 12 (task-40): row templates ──────────────────────────────────
// Mirrors `backend/models/database.py`'s `RowTemplateResponse` and
// `services/db/templates.py`'s module-docstring `RepeatConfig` shape
// (task-40-brief.md's "Backend API surface" / "repeat_config shape" — the
// authoritative version lives on that backend module, not re-derived here).
// No end-date field — templates don't have one (unlike automations' schedule
// trigger, a different M12 surface entirely). `timezone` is always `"UTC"`
// from this UI: there is no per-user timezone concept anywhere in this app
// (M3's already-recorded gap) — REPEAT_TIMEZONE below is a constant, not a
// picker.

export const REPEAT_FREQUENCIES = ["daily", "weekly", "monthly", "yearly"] as const;
export type RepeatFrequency = (typeof REPEAT_FREQUENCIES)[number];

/** This UI always sends `"UTC"` (or omits the field, which the backend
 * defaults the same way) — never offered as a choice. */
export const REPEAT_TIMEZONE = "UTC";

export interface RepeatConfig {
  frequency: RepeatFrequency;
  interval: number;
  /** ISO 1=Monday..7=Sunday. Only meaningful — and only ever collected by
   * this UI — when `frequency === "weekly"`. */
  weekdays?: number[];
  /** "YYYY-MM-DD" */
  start_date: string;
  /** "HH:MM" */
  time_of_day: string;
  timezone?: string;
}

/** Mirrors `backend/models/database.py`'s `RowTemplateResponse` exactly —
 * `POST/GET/PATCH .../templates` and `POST .../templates/{id}/instantiate`
 * (Task 37's backend, already live) all return this shape. */
export interface RowTemplateResponse {
  id: string;
  data_source_id: string;
  user_id: string;
  name: string;
  icon: string | null;
  properties: Record<string, PropertyValue>;
  /** Page-body blocks — the same `AnyBlock[]` shape `BlockEditor` already
   * reads/writes for a real note's `content`, kept `unknown[]` here (same as
   * `DatabaseResponse.description` above) since this file doesn't otherwise
   * depend on the editor's block types. */
  content: unknown[];
  is_default: boolean;
  repeat_config: RepeatConfig | null;
  /** Server-computed next scheduled run, `null` whenever `repeat_config` is
   * `null`. Read-only — never sent in a PATCH body. */
  next_run_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Fields `PATCH /db/templates/{id}` accepts — mirrors the POST body's own
 * field set (task-40-brief.md's "Backend API surface"), everything optional
 * for a partial update. `id`/`data_source_id`/`user_id`/`next_run_at`/
 * `position`/`created_at`/`updated_at` are never patchable. */
export type RowTemplatePatch = Partial<
  Pick<RowTemplateResponse, "name" | "icon" | "properties" | "content" | "is_default" | "repeat_config">
>;

// ── Milestone 12 (task-41): database automations + notifications ──────────
// Mirrors backend/models/database.py's AutomationCreate/AutomationUpdate/
// AutomationResponse/NotificationResponse and services/db/automations.py's
// own module docstring for the triggers/actions element shapes
// (task-41-brief.md's "Backend API surface"/"Trigger shapes"/"Action
// shapes" — the authoritative version lives on that backend module, not
// re-derived here). `triggers`/`actions` stay untyped `list[Any]` JSONB on
// the backend (only one save-time shape rule enforced there: an
// `every_frequency` trigger must be the array's only entry) — the
// discriminated unions below exist purely so THIS UI can build/render them
// safely; a malformed/unknown-shaped entry from elsewhere would need a
// runtime guard this file doesn't add (none of this task's own UI can
// produce one).
//
// `send_mail_to`/`send_slack_notification_to` are deliberately NOT members
// of `AutomationAction` below — spec §1's non-goals table, and the plan's
// own M12 test case ("the UI says so rather than offering a dead control").
// Omitting them from the TYPE, not just the rendered `<select>` options,
// means nothing in this file can even construct one by accident.

/** A `{"formula": "<source>"}` reference — `services/db/automations.py`'s
 * `_is_formula_ref`'s exact shape (a dict with ONLY this one key). Every
 * action/trigger config field that accepts either a literal value or a
 * formula uses `PropertyValue | FormulaValueWrapper` (or, for
 * `send_notification.message`, `string | FormulaValueWrapper`) — never a
 * bare `string` formula source at the top level, which would be
 * indistinguishable from a literal rich-text value. */
export interface FormulaValueWrapper {
  formula: string;
}

/** Any writable-property value OR a formula reference — the shape every
 * `edit_property.value` / `add_page_to.properties.*` / `edit_pages_in.value`
 * field takes. */
export type ValueOrFormula = PropertyValue | FormulaValueWrapper;

export const AUTOMATION_TRIGGER_TYPES = ["page_added", "property_edited", "every_frequency"] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

/** Decision 6 (task-41-brief.md): plain-language labels for these 4 raw
 * enum values — never surfaced to the user verbatim. */
export const PROPERTY_EDITED_CONDITIONS = [
  "any_change",
  "set_to",
  "became_empty",
  "became_non_empty",
] as const;
export type PropertyEditedCondition = (typeof PROPERTY_EDITED_CONDITIONS)[number];

export const PROPERTY_EDITED_CONDITION_LABELS: Record<PropertyEditedCondition, string> = {
  any_change: "Any change",
  set_to: "Set to a specific value",
  became_empty: "Becomes empty",
  became_non_empty: "Becomes non-empty",
};

export interface PageAddedTrigger {
  type: "page_added";
}

/** `value` is a plain literal wrapper, never a formula — `_trigger_entry_
 * matches` compares it statically via `_inner_value`, it's never resolved
 * through the formula evaluator (unlike every action-side value field
 * above). Only meaningful (and only ever collected by this UI) when
 * `condition === "set_to"`. */
export interface PropertyEditedTrigger {
  type: "property_edited";
  property_key: string;
  condition: PropertyEditedCondition;
  value?: PropertyValue;
}

/** The ONLY entry in `triggers` when present (backend 400s otherwise, see
 * `_validate_triggers`) — same schedule shape as row templates'
 * `RepeatConfig` PLUS `end_date`, which templates don't have. */
export interface EveryFrequencyTrigger {
  frequency: RepeatFrequency;
  type: "every_frequency";
  interval: number;
  weekdays?: number[];
  /** "YYYY-MM-DD" */
  start_date: string;
  /** "HH:MM" */
  time_of_day: string;
  timezone?: string;
  /** "YYYY-MM-DD", `null`/omitted for "never ends" — the one schedule field
   * `RepeatConfig` doesn't have. */
  end_date?: string | null;
}

export type AutomationTrigger = PageAddedTrigger | PropertyEditedTrigger | EveryFrequencyTrigger;

export type AutomationTriggerCombinator = "any" | "all";

export const AUTOMATION_ACTION_TYPES = [
  "edit_property",
  "add_page_to",
  "edit_pages_in",
  "send_notification",
  "send_webhook",
  "define_variables",
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** research §J.6.6: "edit the properties of pages in the database you are
 * currently in" — always the trigger row, no `target` field of its own. */
export interface EditPropertyAction {
  type: "edit_property";
  property_key: string;
  value: ValueOrFormula;
}

/** research §J.6.6: "add a page to a database of your choosing, and edit
 * the properties of that page." */
export interface AddPageToAction {
  type: "add_page_to";
  data_source_id: string;
  properties: Record<string, ValueOrFormula>;
}

/** Narrowed (task-38-brief.md decision 8) to ONE property_key/value pair —
 * symmetric with `edit_property`'s own shape. `target` is `"trigger_row"`
 * (Notion's "This page") or a `{variable_ref}` naming a prior
 * `define_variables` action's page/page-list result — never a general
 * filter-driven bulk edit. */
export interface EditPagesInAction {
  type: "edit_pages_in";
  target: "trigger_row" | { variable_ref: string };
  data_source_id: string;
  property_key: string;
  value: ValueOrFormula;
}

/** Decision 9 (task-38-brief.md): one `db_notifications` row. `link` is
 * never set by this action in this milestone (Task 38's own "cheap future
 * addition" note) — nothing in this UI needs to populate it. */
export interface SendNotificationAction {
  type: "send_notification";
  message: string | FormulaValueWrapper;
}

/** Decision 7 (task-38-brief.md): `url` is LITERAL-ONLY, backend-enforced
 * (`_action_send_webhook` rejects anything but a plain string) — never offer
 * a formula toggle for this field. */
export interface SendWebhookAction {
  type: "send_webhook";
  url: string;
  payload?: Record<string, unknown>;
}

/** Decision 8 (task-38-brief.md): `formula` MAY be a bare literal
 * (string/number/bool) instead of `{"formula": ...}` — the backend accepts
 * either. This UI always sends `{"formula": ...}` (never a bare literal),
 * matching Notion's own `∑` variable-definition UI (research §J.6.4) and
 * task-41-brief.md's own reference facts: "defaulting every
 * `define_variables` field to `FormulaEditor` is simpler." */
export interface DefineVariablesAction {
  type: "define_variables";
  name: string;
  formula: string | FormulaValueWrapper | number | boolean;
}

export type AutomationAction =
  | EditPropertyAction
  | AddPageToAction
  | EditPagesInAction
  | SendNotificationAction
  | SendWebhookAction
  | DefineVariablesAction;

/** Mirrors `backend/models/database.py`'s `AutomationResponse` exactly. */
export interface AutomationResponse {
  id: string;
  data_source_id: string;
  user_id: string;
  name: string;
  is_active: boolean;
  last_error: string | null;
  trigger_combinator: AutomationTriggerCombinator;
  triggers: AutomationTrigger[];
  view_id: string | null;
  actions: AutomationAction[];
  next_run_at: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

/** Fields `PATCH /db/automations/{id}` accepts — `last_error` is
 * deliberately absent (system-written only, via a failing action chain,
 * never a client PATCH — `AutomationUpdate`'s own docstring). */
export type AutomationPatch = Partial<
  Pick<
    AutomationResponse,
    "name" | "is_active" | "trigger_combinator" | "triggers" | "view_id" | "actions"
  >
>;

/** Mirrors `backend/models/database.py`'s `NotificationResponse` exactly —
 * `GET/PATCH /db/notifications` (Task 38's backend, already live). */
export interface NotificationResponse {
  id: string;
  user_id: string;
  message: string;
  link: string | null;
  source: string | null;
  read_at: string | null;
  created_at: string;
}

// ── Milestone 12 (task-42): buttons — button property + button BlockNote block ──
// Mirrors `services/db/buttons.py`'s `BUTTON_ACTIONS`/`BUTTON_BLOCK_ACTIONS`
// (the 6 `AutomationAction` kinds above plus these 3 button-only kinds) and
// `models/database.py`'s `ButtonClick{Request,Response}` shapes. Same
// "send_mail_to/send_slack_notification_to deliberately NOT a member"
// convention as `AutomationAction` above — this task's own action-type
// dropdown(s) can only ever offer what these types allow.

/** `services/db/buttons.py`'s `_action_show_confirmation`: `message` is a
 * plain literal string, never resolved through `_resolve_text` the way every
 * `AutomationAction` field above is — no formula toggle for this field. */
export interface ShowConfirmationAction {
  type: "show_confirmation";
  message?: string;
}

/** `_action_open_page_or_url`: `target` is LITERAL-ONLY (the backend rejects
 * a `{"formula": ...}`-shaped target outright) — exactly one of these two
 * discriminated shapes. */
export interface OpenPageOrUrlAction {
  type: "open_page_or_url";
  target: { kind: "url"; url: string } | { kind: "note"; note_id: string };
}

export const INSERT_BLOCKS_PLACEMENTS = [
  "above_button",
  "below_button",
  "top_of_page",
  "bottom_of_page",
] as const;
export type InsertBlocksPlacement = (typeof INSERT_BLOCKS_PLACEMENTS)[number];

/** `_action_insert_blocks` — block-surface only (never legal in a button
 * PROPERTY's `BUTTON_ACTIONS`, research §J.6.2/§25: a button property has no
 * page of its own to insert blocks into). `blocks` is an opaque BlockNote
 * block array the backend never interprets at all — this frontend is the
 * only place that ever reads its contents (via `editor.insertBlocks`). */
export interface InsertBlocksAction {
  type: "insert_blocks";
  blocks: unknown[];
  placement: InsertBlocksPlacement;
}

/** The 8 action kinds a button PROPERTY's `config.actions` may contain
 * (`services/db/buttons.py`'s `BUTTON_ACTIONS`) — the 6 `AutomationAction`
 * kinds plus these 2. */
export type ButtonAction = AutomationAction | ShowConfirmationAction | OpenPageOrUrlAction;

/** The 9 action kinds a button BLOCK's `actionsJson` may contain
 * (`BUTTON_BLOCK_ACTIONS`) — `ButtonAction` plus `insert_blocks`. */
export type ButtonBlockAction = ButtonAction | InsertBlocksAction;

export const BUTTON_ACTION_TYPES = [
  ...AUTOMATION_ACTION_TYPES,
  "show_confirmation",
  "open_page_or_url",
] as const;
export type ButtonActionType = (typeof BUTTON_ACTION_TYPES)[number];

export const BUTTON_BLOCK_ACTION_TYPES = [...BUTTON_ACTION_TYPES, "insert_blocks"] as const;
export type ButtonBlockActionType = (typeof BUTTON_BLOCK_ACTION_TYPES)[number];

/** `POST .../buttons/{property_key}/click` and `POST /db/buttons/block-click`'s
 * shared `client_actions` entry shapes (decision 4/7 of task-39-brief.md). */
export interface OpenClientAction {
  type: "open";
  kind: "url" | "note";
  url?: string;
  note_id?: string;
}
export interface InsertBlocksClientAction {
  type: "insert_blocks";
  blocks: unknown[];
  placement: InsertBlocksPlacement;
}
export type ClientAction = OpenClientAction | InsertBlocksClientAction;

/** Mirrors `backend/models/database.py`'s `ButtonClickResponse` exactly —
 * the shared response shape for both click endpoints. */
export interface ButtonClickResponse {
  actions_run: number;
  requires_confirmation: boolean;
  confirmation_message: string | null;
  client_actions: ClientAction[];
}
