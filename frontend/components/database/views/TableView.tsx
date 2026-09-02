"use client";

// The one view type Milestone 2 ships: a plain TanStack Table (v8 — pinned
// explicitly rather than taking whatever "latest" resolves to, since
// @tanstack/react-table's newest major is a ground-up API rewrite with no
// useReactTable/getCoreRowModel/flexRender; v8 is the stable, documented
// surface this component is built against). Columns are derived from
// `properties[]` in position order; each cell is rendered by the matching
// dedicated cell component for its 8 known types, or GenericCell as a
// read-only fallback for anything else (e.g. `url`, `created_time`,
// `last_edited_time`) — see cells/CellProps.ts and cells/GenericCell.tsx.
//
// task-18: "Add property"/"Add row" — until this, a freshly created database
// (Milestone 2's POST /db/databases, reachable via the sidebar since a
// moment before this task) was permanently empty and uneditable through the
// UI, since nothing called POST .../properties or POST .../rows. Both POST
// calls happen right here rather than growing useDatabaseView.ts with new
// state-management methods (contrast `createView`, which appends to local
// `views` state itself) — a plain POST-then-`refetch()` is enough since
// there's no optimistic-update case to get right, unlike `updateCell`.
//
// No column reordering/resizing/visibility yet (Milestone 3+) — @dnd-kit is
// already installed elsewhere in this repo but deliberately not pulled in
// here. No virtualization (@tanstack/react-virtual) either — not needed for
// this milestone's scope; worth adding if a data source's row count becomes
// a real performance problem.
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, ChevronRight, FileText, HelpCircle, Plus, Trash2, X } from "lucide-react";
import { useToast } from "@/app/providers";
import { findSystemRelationProperty, getGroupBySpec } from "@/lib/database/types";
import type {
  DatabaseRow,
  Group,
  PropertyResponse,
  PropertyValue,
  RelatedRow,
  RowResponse,
  RowTemplatePatch,
  RowTemplateResponse,
  SubtaskDisplayMode,
  ViewResponse,
} from "@/lib/database/types";
import { renderCellValue } from "../cells/renderCellValue";
import {
  getCalculation,
  getColumnWidths,
  getHiddenKeys,
  getOpenPagesInMode,
  getShowPageIcon,
  getShowVerticalLines,
  orderProperties,
  patchColumnWidths,
} from "@/lib/database/viewConfig";
import type { SortsUpdater } from "@/lib/database/viewConfig";
import { asFilterNode, countConditions, defaultConditionFor } from "@/lib/database/filterAst";
import { filterPanel, type FilterUpdater } from "../FilterBuilder";
import { groupDisplayLabel, orderedGroups } from "../GroupBuilder";
import type { GroupByUpdater } from "../GroupBuilder";
import type { SelectOption } from "../EditPropertyPanel";
import { pillStyleForOption } from "../cells/CellProps";
import { configuredOptions } from "@/lib/database/filterOperators";
import { useOpenNote } from "@/lib/database/useOpenNote";
import { buildSubItemTree } from "@/lib/database/subItemTree";
import { ButtonPropertyConfigPopover } from "../ButtonPropertyConfigPopover";
import { OpenNoteButton } from "../OpenNoteButton";
import { RowGutter } from "../RowGutter";
import { RowPeek } from "../RowPeek";
import { ColumnHeader } from "../ColumnHeader";
import { calculationLabel } from "../ColumnHeaderMenu";
import { AddPropertyPopover } from "../AddPropertyPopover";
import { QueryBar } from "../QueryBar";
import { TemplateManager } from "../TemplateManager";
import { MenuList, Popover } from "@/components/ui/primitives";

interface TableViewProps {
  properties: PropertyResponse[];
  rows: DatabaseRow[];
  /** All Notes passes false (no write endpoint yet); ordinary databases pass true. */
  editable: boolean;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  /** Backing data source id for the "Add property"/"Add row" POSTs below.
   * Only ever needed when `editable` — All Notes (the one non-editable
   * source) never renders those controls, so it's optional rather than
   * threading a dummy id through every other call site. */
  dataSourceId?: string;
  /** useDatabaseView's `load`/`refetch` — called after adding a property so
   * the new column shows up without a full page reload. Does NOT refresh
   * `rows` (see `refetchRows`). */
  refetch?: () => void | Promise<void>;
  /** useDatabaseView's `loadRows` — called after adding a row. `refetch`
   * alone doesn't re-run the rows query (its effect isn't keyed to
   * anything a new row changes), so a new row would silently never appear
   * without calling this specifically. */
  refetchRows?: () => void | Promise<void>;
  // Milestone 7 (task-22): relation cells and sub-item nesting. All four
  // are optional — a caller that omits them (e.g. an older test) just gets
  // relation columns rendered as a read-only GenericCell fallback and no
  // tree/nesting, matching this feature's pre-task behaviour rather than
  // crashing.
  /** useDatabaseView's relation-links cache, keyed by `${rowId}:${propertyKey}`. */
  relationLinks?: Record<string, RelatedRow[]>;
  /** useDatabaseView's `ensureRelationLinks` — lazily warms the cache above
   * for a single row/property (used by `RelationCell`'s own per-cell mount). */
  ensureRelationLinks?: (rowId: string, propertyKey: string) => void;
  /** useDatabaseView's `ensureRelationLinksBulk` — warms the cache above for
   * every visible row's sub-item links in one request (M7 combined-review
   * Important finding 3: the sub-item pre-fetch effect below used to call
   * `ensureRelationLinks` once per row, one HTTP request per row). Optional,
   * same "older/other caller just gets a degraded but non-crashing
   * behaviour" convention as the other three relation props — falls back to
   * the one-request-per-row loop when omitted. */
  ensureRelationLinksBulk?: (rowIds: string[], propertyKey: string) => void;
  /** useDatabaseView's `setRelationLinks` — commits an add/remove. */
  setRelationLinks?: (rowId: string, propertyKey: string, rows: RelatedRow[]) => void | Promise<void>;
  /** The active view's `config.subtasks.display_mode` (task-22-brief.md
   * §3) — `undefined`/anything other than "show"/"flattened" renders the
   * data source's rows flat, same as before this task. Scope note: only
   * `show`/`flattened` are implemented; `hidden`/`disabled` are absent
   * rather than half-built (research §3.4 also names them, but the brief
   * explicitly scopes this task down to the first two). */
  subItemDisplayMode?: SubtaskDisplayMode;
  // Milestone 12 (task-40) / M11 (new-row-button.md): the "+ New" split
  // button's dropdown. `templates` alone is enough for picking an existing
  // one; the chevron itself is now UNCONDITIONAL (user decision, 2026-09-01
  // — Notion's own IA: the dropdown is the entry point for AUTHORING a
  // template, not merely picking one), so a caller that omits `templates`
  // still gets a chevron, just one whose menu can only offer "+ New
  // template" — the plain "+ New" click path itself is unaffected either way.
  templates?: RowTemplateResponse[];
  /** M11: the split-button dropdown's "Templates for <name>" header —
   * reuses the same "database name" string `ViewTabs.tsx`'s own
   * `dataSourceName` prop already carries. Optional: omitted renders the
   * header without a name (`"Templates"`) rather than crashing. */
  dataSourceName?: string;
  /** M11: "+ New template" opens the SAME `TemplateManager` modal
   * `DatabaseSettingsMenu.tsx`'s "Manage templates" already mounts — these
   * three are that component's own required handlers, unchanged. All
   * optional: omitted, "+ New template" is not rendered (same
   * degrade-gracefully convention as every other optional prop here). */
  onCreateTemplate?: (name: string, icon?: string | null) => Promise<RowTemplateResponse>;
  onUpdateTemplate?: (id: string, patch: RowTemplatePatch) => Promise<RowTemplateResponse>;
  onDeleteTemplate?: (id: string) => Promise<void>;
  // M1: the column header menu. All four are optional on the same
  // "an older/other caller gets a degraded but non-crashing behaviour"
  // convention the relation props above already established — omit them and
  // headers render as the plain strings they were before M1, which is exactly
  // what the read-only All Notes source should get.
  /** The active view. The menu writes per-view state (hidden, wrap,
   * calculation, order), so without it there is nothing to write to. */
  view?: ViewResponse | null;
  /** Receives a PATCH of changed keys only; DatabaseShell merges it through
   * its serialised queue. */
  onPatchConfig?: (patch: Record<string, unknown>) => void;
  onSetSorts?: (updater: SortsUpdater) => void;
  /** M4: the query bar (sort/filter chips) and each column header's
   * "Filter" row both write here. */
  onSetFilter?: (updater: FilterUpdater) => void;
  /** The column header menu's own "Group" row writes here — same
   * updater-based queue as `onSetSorts`/`onSetFilter`, see `GroupByUpdater`'s
   * own doc comment (GroupBuilder.tsx) for the "second write clobbers the
   * first" bug this avoids. */
  onSetGroupBy?: (updater: GroupByUpdater) => void;
  /** M6: `useDatabaseView`'s grouped-query result — populated (with `rows`
   * emptied) whenever `view.config.group_by` is set. `null`/`undefined`
   * renders the ordinary flat table, unchanged. */
  groups?: Group[] | null;
  /** M11 (calculations-row.md): `useDatabaseView`'s query result, populated
   * whenever `getQueryExtras` sent `aggregations` (i.e. some column has a
   * `config.calculations` entry AND the view isn't grouped — see that
   * function's own comment for why grouped is excluded). Keyed by property
   * key (this file's own `AggregationSpec.key` choice), one entry per
   * column with a calculation set. `null`/`undefined`/missing key renders
   * that column's footer cell empty, same as "None". */
  aggregates?: Record<string, number> | null;
  /** useDatabaseView's `instantiateTemplate` — creates a row from a chosen
   * (non-default) template right now. Does not itself refetch rows; this
   * component calls `refetchRows` afterward, same as `handleAddRow` does
   * for the plain path. */
  onInstantiateTemplate?: (templateId: string) => Promise<RowResponse>;
}

const columnHelper = createColumnHelper<DatabaseRow>();

/** M11 (calculations-row.md): the footer's own value formatting — the spec
 * only captures one example (`SUM 0`, an integer), so anything beyond
 * "round `average`/`median`'s often-long decimals to 2 places" and "the
 * percent_* aggregators are already 0-100 server-side (aggregations.py),
 * so append `%`" is a plain engineering call, not an invented visual
 * value. */
function formatCalculationValue(aggregator: string, value: number): string {
  const rounded = Number.isInteger(value) ? value : Math.round(value * 100) / 100;
  return aggregator.startsWith("percent_") ? `${rounded}%` : String(rounded);
}


/** Best-effort message extraction from a failed POST, matching the pattern
 * already used for the sidebar's "New Database" one-click create
 * (components/sidebar/Sidebar.tsx's handleNewDatabase) — FastAPI's
 * HTTPException body is `{"detail": "..."}`, this app's own proxy error
 * shapes are `{"error": "..."}`. */
async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

/** M6: best-effort pre-fill for a row created inside a specific group —
 * unambiguous for the option/boolean/exact-text types (the group KEY is
 * literally the value to set), skipped for Number/Date range buckets
 * (which exact value inside the bucket is genuinely ambiguous — the row is
 * created same as "+ New" and lands in "No <Property>" until the user sets
 * it) and for the implicit "No <Property>" bucket itself (nothing to write
 * — that's what an unset property already renders as). A module-level pure
 * function (not a closure inside the component) so it has its own direct
 * test coverage. */
export function groupValueForNewRow(property: PropertyResponse, group: Group): PropertyValue | undefined {
  if (group.key === "__no_value__") return undefined;
  switch (property.type) {
    case "title":
      return { type: "title", title: group.key };
    case "rich_text":
      return { type: "rich_text", rich_text: group.key };
    case "url":
      return { type: "url", url: group.key };
    case "email":
      return { type: "email", email: group.key };
    case "phone_number":
      return { type: "phone_number", phone_number: group.key };
    case "select":
      return { type: "select", select: group.key };
    case "status":
      return { type: "status", status: group.key };
    case "multi_select":
      return { type: "multi_select", multi_select: [group.key] };
    case "checkbox":
      return { type: "checkbox", checkbox: group.key === "true" };
    default:
      return undefined;
  }
}

export function TableView({
  properties,
  rows,
  editable,
  onCellChange,
  dataSourceId,
  refetch,
  refetchRows,
  relationLinks,
  ensureRelationLinks,
  ensureRelationLinksBulk,
  setRelationLinks,
  subItemDisplayMode,
  templates,
  dataSourceName,
  onCreateTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
  onInstantiateTemplate,
  view,
  onPatchConfig,
  onSetSorts,
  onSetFilter,
  onSetGroupBy,
  groups,
  aggregates,
}: TableViewProps) {
  const { showToast } = useToast();
  const openNote = useOpenNote();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // M10 (row-peek.md): "?p=<noteId>&pm=s|c" — deep-linkable and restorable.
  // The lazy initializer reads whatever the URL held AT MOUNT, so a reload
  // (or a first render carrying a shared link) reopens the same row in the
  // same mode; a browser back/forward WHILE mounted does not re-derive from
  // the URL (that would need a reactive effect keyed on `searchParams`,
  // fighting the writes below) — a disclosed limitation, same class as
  // `?view=`'s own still-write-only status (DatabaseShell.tsx/M3). `null` =
  // no peek open.
  const [peekRowId, setPeekRowId] = useState<string | null>(() => searchParams.get("p"));
  const [peekMode, setPeekMode] = useState<"side" | "center" | null>(() => {
    const pm = searchParams.get("pm");
    return pm === "c" ? "center" : pm === "s" ? "side" : null;
  });
  // M9 (row-affordances.md): bulk selection. Client state only — Notion's
  // own "Select" is not persisted either.
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(new Set());
  function toggleRowSelected(rowId: string) {
    setSelectedRowIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }
  async function trashSelectedRows() {
    const ids = Array.from(selectedRowIds);
    setSelectedRowIds(new Set());
    try {
      await Promise.all(ids.map((id) => fetch(`/api/notes/${id}`, { method: "DELETE" })));
      await refetchRows?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not move rows to Trash", "error");
    }
  }
  const config = view?.config ?? {};
  // M3's Layout panel default ("Open pages in") — "full" bypasses RowPeek
  // entirely and reuses the exact navigation List/Feed/Board/Gallery already
  // use (useOpenNote), rather than growing RowPeek a mode it would never
  // render itself.
  const openPagesInMode = getOpenPagesInMode(config);

  // Writes the peek's own `p`/`pm` onto the CURRENT url, preserving every
  // other param (`?view=` included) — router.replace, not push, since a
  // peek open/close is not a distinct navigable "page" any more than a
  // popover open/close is (row-peek.md's checklist only asks that a RELOAD
  // restores it, never that Back closes it).
  function writePeekUrl(noteId: string | null, mode: "side" | "center" | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (noteId) {
      params.set("p", noteId);
      params.set("pm", mode === "center" ? "c" : "s");
    } else {
      params.delete("p");
      params.delete("pm");
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  /** `forcedMode` — row-peek.md's Trigger table: the row menu's "Open in ->
   * Side peek" and `Alt+Click` both FORCE a side peek, bypassing "Open
   * pages in"'s view-wide default (even "full") entirely. The plain OPEN
   * button / row click instead RESPECTS that default, including "full"
   * (which bypasses the peek altogether, unchanged from before M10). */
  function openRow(noteId: string, forcedMode?: "side") {
    if (!forcedMode && openPagesInMode === "full") {
      openNote(noteId);
      return;
    }
    const mode = forcedMode ?? (openPagesInMode === "center" ? "center" : "side");
    setPeekRowId(noteId);
    setPeekMode(mode);
    writePeekUrl(noteId, mode);
  }

  function closePeek() {
    setPeekRowId(null);
    setPeekMode(null);
    writePeekUrl(null, null);
  }

  /** OpenNoteButton's `isOpen` makes it read CLOSE while this row's peek is
   * open (row-affordances.md: "OPEN is a toggle") — before M10 the SAME
   * `onOpen={openRow}` fired on every click regardless, so clicking CLOSE
   * silently re-opened the identical row instead of closing it. */
  function toggleRow(noteId: string) {
    if (peekRowId === noteId) closePeek();
    else openRow(noteId);
  }

  /** row-peek.md's Trigger table: "Alt+Click the row -> Side peek", the
   * same FORCE-side-peek behaviour as the row menu's own "Open in -> Side
   * peek". Bound on every `<tr>`, not a cell — a plain click still reaches
   * whatever cell/button the pointer landed on unchanged (this only acts
   * when `altKey` is set), so it adds a gesture rather than intercepting
   * the existing ones. */
  function handleRowAltClick(rowId: string) {
    return (e: React.MouseEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      openRow(rowId, "side");
    };
  }
  // Two entry points write this same key — the title column's own header
  // menu (M1's "Show page icon") and M3's Layout panel — this is the read
  // half neither had before now.
  const showPageIcon = getShowPageIcon(config);
  const showVerticalLines = getShowVerticalLines(config);
  const cellBorderClass = showVerticalLines ? "border-r border-gray-100 dark:border-gray-800" : "";
  const [rowSubmitting, setRowSubmitting] = useState(false);
  // Milestone 12 (task-40): the "+ New" split-button's dropdown open state,
  // and a separate submitting flag so picking a template disables/re-enables
  // its own row without touching `rowSubmitting` (the plain "+ New" click
  // path's own state).
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const templateMenuRef = useRef<HTMLDivElement>(null);
  // The dropdown below is a plain conditional div, not the shared Popover
  // primitive (it predates it) — so it needs its own outside-click/Escape
  // dismissal. Live-checklist regression: it stayed open until the chevron
  // was clicked again, since nothing else ever flipped templateMenuOpen.
  useEffect(() => {
    if (!templateMenuOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!templateMenuRef.current?.contains(e.target as Node)) setTemplateMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setTemplateMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [templateMenuOpen]);
  const [instantiatingTemplateId, setInstantiatingTemplateId] = useState<string | null>(null);
  // M11 (new-row-button.md): "Focus the new row's title cell after
  // creation." Threaded into `columns`' `cell` fn below as `TitleCell`'s
  // `autoEdit` — see that prop's own doc comment for why this never needs
  // to be reset back to `null`.
  const [newlyCreatedRowId, setNewlyCreatedRowId] = useState<string | null>(null);
  // M11: the split-button's ALWAYS-visible dropdown (user decision,
  // 2026-09-01 — matches Notion's own IA, where the dropdown is the entry
  // point for AUTHORING a template, not merely picking one) opens the same
  // `TemplateManager` modal `DatabaseSettingsMenu.tsx`'s "Manage templates"
  // already does — a second mount of the identical component/handlers, not
  // a second template-CRUD implementation.
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);


  // Sub-item "show" mode's expand/collapse state (task-22-brief.md §3) —
  // every row starts expanded (empty set), matching Notion's own default.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  // M6: which GROUPS are collapsed — same "every group starts expanded,
  // empty set" default. Purely a display toggle, not persisted anywhere
  // (group-panel.md never captured whether Notion persists this either).
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set());
  const [addingRowToGroupKey, setAddingRowToGroupKey] = useState<string | null>(null);
  const [addingGroupOption, setAddingGroupOption] = useState(false);

  // The full schema, in table order — NOT hidden-filtered. Everything that
  // needs to know "what properties exist on this data source" (sub-item/
  // relation lookups, the rollup-source picker, Insert-left/right's
  // duplicate-name check) must see a hidden column too: hiding a column is
  // a per-view DISPLAY choice, not a schema change, and a relation a Button
  // targets or a sub-item pair still functions while its column happens to
  // be hidden. `orderedProperties` below — the HIDDEN-FILTERED list — exists
  // solely for rendering table columns; nothing else should read it.
  // (Live-discovered in the M1–M3 review checkpoint: every one of the
  // lookups below used to read the filtered list, so hiding a sub-item
  // relation's column silently killed the whole nested row tree, and hiding
  // a Button's target property made it unresolvable in its own config
  // popover.)
  const allOrderedProperties = useMemo(
    () => orderProperties(properties, config),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [properties, config.property_order]
  );

  // Wired to the SAME view.config keys the column header menu's "Hide" row
  // and Insert-left/right already write (M1) and M3's Property visibility
  // panel now writes — this was the missing read half: those controls set
  // `hidden_properties`/`property_order` and nothing here consulted either,
  // so a hidden column stayed rendered and a reorder had no visible effect.
  // The title property is EXEMPT from hiding: it is the only place
  // OpenNoteButton/the sub-item tree's expand toggle render, and Notion's
  // own capture shows an eye icon on "Name" without confirming it is
  // enabled — kept visible here rather than guessed away.
  const orderedProperties = useMemo(() => {
    const hidden = new Set(getHiddenKeys(config));
    if (hidden.size === 0) return allOrderedProperties;
    return allOrderedProperties.filter((p) => p.type === "title" || !hidden.has(p.key));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allOrderedProperties, config.hidden_properties]);

  const titleProperty = useMemo(
    () => allOrderedProperties.find((p) => p.type === "title"),
    [allOrderedProperties]
  );
  // The one sub-item relation pair on this data source, if enabled
  // (research §3.2: the property choice is data-source-global, not a
  // per-view setting — there is exactly one, found by `config.system`).
  const subItemForwardProp = useMemo(
    () => findSystemRelationProperty(allOrderedProperties, "sub_item", "forward"),
    [allOrderedProperties]
  );
  const subItemReverseProp = useMemo(
    () => findSystemRelationProperty(allOrderedProperties, "sub_item", "reverse"),
    [allOrderedProperties]
  );

  // Every relation-type property on this data source (task-31 Parts 3/4) —
  // ordinary relations AND the sub-item/dependency system pairs alike, since
  // all of them are plain `type: "relation"` properties that get their own
  // column/RelationCell. Used below to bulk-warm the WHOLE relationLinks
  // cache for the whole page in one pass (Part 4), AND as the rollup form's
  // "which relation do you want to roll up through" dropdown (Part 3) — a
  // rollup can only roll up through a relation that already exists on THIS
  // data source, so an empty list here is exactly the "add a relation
  // property first" case task-31-brief.md §3 calls out.
  const relationProperties = useMemo(
    () => allOrderedProperties.filter((p) => p.type === "relation"),
    [allOrderedProperties]
  );
  const relationPropertyKeys = useMemo(() => relationProperties.map((p) => p.key), [relationProperties]);

  // Pre-fetch every visible row's links for EVERY relation column up front,
  // not on individual cell mount the way each RelationCell's own effect
  // still separately does. Keyed to `rows`'s identity (changes once per
  // `loadRows()` completion) and the joined set of relation keys,
  // deliberately NOT to `ensureRelationLinksBulk`'s/`ensureRelationLinks`'s
  // own identity (which changes on every single cache write — see
  // useDatabaseView.ts's comment on why) or this effect would re-issue a
  // full "already cached, no-op" pass on every fetch's completion.
  //
  // task-31 Part 4 (live-verified: 58 relation requests for a two-row
  // table): this used to warm the cache for ONLY whichever single sub-item
  // property matched the active `subItemDisplayMode` (M7 combined-review
  // Important finding 3) — every OTHER relation column (an ordinary
  // "Blocking"/"Related" property, or the sub-item property when no
  // display mode is even set) had no bulk pre-fetch at all, leaving each of
  // ITS cells to fall back to one `ensureRelationLinks` HTTP request per
  // row (task-20's `list_links_bulk`/`ensureRelationLinksBulk` sat unused
  // for exactly the columns that needed it most). Generalizing to every
  // relation column folds the old sub-item-only pre-fetch into this same
  // mechanism — `subItemDisplayMode`/`subItemForwardProp`/
  // `subItemReverseProp` no longer gate what gets warmed here (they're
  // still used below for the tree/flattened-mode rendering itself).
  useEffect(() => {
    if (relationPropertyKeys.length === 0) return;
    const rowIds = rows.map((row) => row.id);
    if (rowIds.length === 0) return;
    if (ensureRelationLinksBulk) {
      for (const key of relationPropertyKeys) ensureRelationLinksBulk(rowIds, key);
    } else if (ensureRelationLinks) {
      for (const key of relationPropertyKeys) {
        for (const row of rows) ensureRelationLinks(row.id, key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, relationPropertyKeys.join("|")]);

  const treeEntries = useMemo(() => {
    if (subItemDisplayMode !== "show" || !subItemForwardProp || !relationLinks) return null;
    const key = subItemForwardProp.key;
    return buildSubItemTree(
      rows,
      (rowId) => relationLinks[`${rowId}:${key}`]?.map((r) => r.id),
      collapsedIds
    );
  }, [subItemDisplayMode, subItemForwardProp, relationLinks, rows, collapsedIds]);

  function toggleCollapsed(rowId: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }

  const columns = useMemo(
    () =>
      orderedProperties.map((property) =>
        columnHelper.accessor((row) => row.properties[property.key], {
          id: property.key || property.id,
          // Milestone 12 (task-42) decision 2: a button-typed column's
          // header becomes a clickable config-popover trigger; every other
          // type keeps the plain string header unchanged.
          // M1. A button column keeps its existing config popover: a button's
          // settings ARE per-type property config, which is M2's "Edit
          // property" panel, so folding it in belongs there rather than as a
          // half-built row here. Everything else gets the header menu.
          //
          // The menu is suppressed entirely — not disabled — when the source
          // is read-only or the caller supplied no view/handlers. All Notes
          // has no db_properties to rename, hide or delete, and
          // DatabaseShell.tsx:400 already establishes hidden-over-disabled for
          // exactly that case.
          header:
            property.type === "button"
              ? () => (
                  <ButtonPropertyConfigPopover property={property} properties={allOrderedProperties} onSaved={refetch} />
                )
              : editable && dataSourceId && onPatchConfig && onSetSorts
                ? () => (
                    <ColumnHeader
                      property={property}
                      properties={allOrderedProperties}
                      dataSourceId={dataSourceId}
                      view={view ?? null}
                      onPatchConfig={onPatchConfig}
                      onSetSorts={onSetSorts}
                      onPropertiesChanged={() => refetch?.()}
                      // M4: applies a default filter on THIS property
                      // immediately, replacing whatever filter existed —
                      // same "groups by that property immediately" replace
                      // semantics M1's own "Group" row already established.
                      onFilter={
                        onSetFilter ? () => onSetFilter(() => defaultConditionFor(property)) : undefined
                      }
                      onSetGroupBy={onSetGroupBy}
                    />
                  )
                : property.name,
          cell: (info) => {
            const rowId = info.row.original.id;
            const relationExtras =
              property.type === "relation" && ensureRelationLinks && setRelationLinks
                ? {
                    links: relationLinks?.[`${rowId}:${property.key}`],
                    onEnsureLoaded: () => ensureRelationLinks(rowId, property.key),
                    onLinksChange: (nextRows: RelatedRow[]) =>
                      setRelationLinks(rowId, property.key, nextRows),
                  }
                : undefined;
            const buttonExtras = property.type === "button" ? { noteId: rowId } : undefined;
            return renderCellValue(
              property,
              info.getValue(),
              editable,
              (value) => onCellChange(rowId, property.key, value),
              relationExtras,
              buttonExtras,
              property.type === "title" && rowId === newlyCreatedRowId,
              property.type === "select" ? (name) => createSelectOption(property, name) : undefined
            );
          },
        })
      ),
    [
      orderedProperties,
      editable,
      onCellChange,
      relationLinks,
      newlyCreatedRowId,
      ensureRelationLinks,
      setRelationLinks,
      refetch,
      dataSourceId,
      view,
      onPatchConfig,
      onSetSorts,
      onSetFilter,
      onSetGroupBy,
    ]
  );

  // M6: when grouped, `rows` is empty (useDatabaseView's own "exactly one of
  // rows/groups" contract) — TanStack's `table.getRow(id)` only resolves ids
  // present in `data`, so the grouped render below (which looks up each
  // group's rows individually, same `table.getRow` technique the sub-item
  // tree branch already uses) needs every grouped row flattened back in.
  // `useMemo`, not a bare re-derive: TableView owns several unrelated bits of
  // local state (peek, template menu, group collapse, …), and a fresh
  // `.flatMap()` array identity on every one of those renders would make
  // `useReactTable` treat `data` as changed and rebuild its row model for no
  // reason (review-checkpoint finding).
  const tableData = useMemo(() => (groups ? groups.flatMap((g) => g.rows) : rows), [groups, rows]);

  // M11 (table-drag-resize.md): per-view column widths, `view.config.
  // column_widths` — JSONB pass-through, not a schema-level field ("the
  // same property can be a different width in different views," the
  // spec's own reasoning). `columnSizing` itself is left UNCONTROLLED
  // (TanStack's own default state, seeded from `initialState` below) —
  // an earlier version of this controlled it directly, which broke:
  // `columnResizeMode: "onChange"`'s live-drag math computes each new
  // width as a SIDE EFFECT inside the very `setColumnSizingInfo` updater
  // React queues for the SAME render pass, and a caller-supplied
  // `onColumnSizingChange` fires synchronously, outside that queue — so it
  // observes the side effect before React has run it. TanStack's own
  // uncontrolled path doesn't have this ordering hazard (both updates go
  // through the identical queue), so this defers to it and only
  // IMPERATIVELY re-seeds `columnSizing` (`table.setColumnSizing`) when
  // the view's own persisted widths change from under it — this same
  // `TableView` instance is reused across different Table VIEWS of the
  // active database (DatabaseShell doesn't remount it on a tab switch).
  const persistedWidths = useMemo(() => getColumnWidths(config), [config]);

  const table = useReactTable({
    data: tableData,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    columnResizeMode: "onChange",
    initialState: { columnSizing: persistedWidths },
  });

  // Keyed on a STRINGIFIED value, not `persistedWidths` itself: `config`
  // (`view?.config ?? {}`) is a fresh `{}` literal on every render when
  // `view` is absent/null, which would otherwise re-run this effect (and
  // re-`setColumnSizing`, re-rendering, re-computing a fresh `{}`, …) on
  // every single render — an infinite loop caught by this file's own test
  // suite hanging outright, not a slow test.
  const persistedWidthsKey = JSON.stringify(persistedWidths);
  useEffect(() => {
    table.setColumnSizing(persistedWidths);
    // `table` (== `useReactTable`'s own stable `tableRef.current`) is
    // deliberately excluded — including it would defeat this effect's own
    // point, since `columns` (a `table` dependency) changes on nearly
    // every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistedWidthsKey]);

  // Fires the checklist's "exactly ONE PATCH for the whole drag, not one
  // per mouse-move" the instant `columnSizingInfo.isResizingColumn`
  // transitions from a column id back to `false` (mouseup/touchend). A
  // ref, not state, for the "was resizing a moment ago" flag: it only
  // needs to survive across renders to detect the transition, never to
  // trigger one itself.
  const wasResizingRef = useRef(false);
  const isResizingColumn = table.getState().columnSizingInfo.isResizingColumn;
  useEffect(() => {
    if (wasResizingRef.current && !isResizingColumn) {
      onPatchConfig?.(patchColumnWidths(config, table.getState().columnSizing));
    }
    wasResizingRef.current = Boolean(isResizingColumn);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResizingColumn]);

  // +1 for the trailing "Add property"/spacer column, +1 for the leading
  // M9 row gutter — both only exist when editable — keeps <thead>'s and
  // <tbody>'s cell counts matching so the real columns don't visually
  // shift under the wrong header.
  const columnCount = orderedProperties.length + (editable ? 2 : 0);

  // M11 (states.md): "A filter matches nothing" is its OWN empty state —
  // "the entire table disappears," not the same `No rows yet.` message a
  // genuinely-empty, unfiltered database gets. `ruleCount`, not a bare
  // `Boolean(view?.filter)`: a present-but-empty filter node (e.g.
  // `{type:"group", op:"and", children:[]}`) is structurally "a filter"
  // but has nothing active, same distinction QueryBar.tsx's own
  // visibility check already makes.
  const hasActiveFilter = Boolean(view && countConditions(asFilterNode(view.filter)) > 0);
  const [emptyFilterMenuOpen, setEmptyFilterMenuOpen] = useState(false);

  const groupBySpec = view ? getGroupBySpec(view.config) : undefined;
  const groupProperty = groupBySpec ? allOrderedProperties.find((p) => p.key === groupBySpec.property_key) : undefined;
  // "+ New group" (group-panel.md: "creates a new select option on the
  // property — a schema write from the table body") is only well-defined
  // for option-based types; Number/Date bucket boundaries are config, not
  // something a bare "+" can invent, and Checkbox/Text/People/Relation have
  // no options list to append to at all.
  const groupPropertyIsOptionBased =
    groupProperty?.type === "select" || groupProperty?.type === "status" || groupProperty?.type === "multi_select";

  function toggleGroupCollapsed(key: string) {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }


  async function handleAddRowToGroup(group: Group) {
    if (!dataSourceId || addingRowToGroupKey) return;
    setAddingRowToGroupKey(group.key);
    try {
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/rows`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      const created: RowResponse = await res.json();
      setNewlyCreatedRowId(created.id);
      const value = groupProperty ? groupValueForNewRow(groupProperty, group) : undefined;
      if (value && groupProperty) {
        const patchRes = await fetch(`/api/db/data-sources/${dataSourceId}/rows/${created.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ property_key: groupProperty.key, value }),
        });
        if (!patchRes.ok) throw new Error(await errorMessage(patchRes));
      }
      await refetchRows?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add row", "error");
    } finally {
      setAddingRowToGroupKey(null);
    }
  }

  /** Mirrors EditPropertyPanel.tsx's own `addOption` — a fresh option named
   * "Option N", immediately usable, renamed afterward via the same Edit
   * property → Options row every other option uses (no bespoke inline
   * rename here). */
  async function handleAddGroupOption() {
    if (!groupProperty || addingGroupOption) return;
    setAddingGroupOption(true);
    try {
      const options = ((groupProperty.config?.options as SelectOption[] | undefined) ?? []) as SelectOption[];
      const next: SelectOption[] = [
        ...options,
        {
          id: Math.random().toString(36).slice(2, 10),
          name: `Option ${options.length + 1}`,
          color: "default",
          ...(groupProperty.type === "status" ? { group: "To-do" as const } : {}),
        },
      ];
      const res = await fetch(`/api/db/properties/${groupProperty.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { ...groupProperty.config, options: next } }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await refetch?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add a group", "error");
    } finally {
      setAddingGroupOption(false);
    }
  }

  /** M11 (cell-editing.md): a Select cell's create-on-type. Same PATCH
   * shape as `handleAddGroupOption` above (same endpoint, same locally-
   * minted id) — the only difference is the option's NAME comes from what
   * the user typed, not an "Option N" placeholder. A duplicate (case-
   * insensitive) name is a silent no-op, not an error: `SelectCell` only
   * calls this when its own `exactMatch` check already found none, but a
   * second column editing the SAME property concurrently could race it —
   * assigning the existing option's name still works fine either way. */
  async function createSelectOption(property: PropertyResponse, name: string) {
    const options = ((property.config?.options as SelectOption[] | undefined) ?? []) as SelectOption[];
    if (options.some((o) => o.name.toLowerCase() === name.toLowerCase())) return;
    const next: SelectOption[] = [...options, { id: Math.random().toString(36).slice(2, 10), name, color: "default" }];
    try {
      const res = await fetch(`/api/db/properties/${property.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { ...property.config, options: next } }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await refetch?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not create the option", "error");
    }
  }




  // One-click, no form, no confirmation — matches the sidebar's "New Note"
  // convention (backend defaults the row to an "Untitled" note and appends
  // it at the end position; there's nothing for a form to collect).
  //
  // UNCHANGED by task-40's split-button widening below: this still calls
  // the same bare POST with no body, and the backend already auto-applies
  // the data source's default template server-side if one exists (Task 37) —
  // no frontend change needed for that path at all.
  async function handleAddRow() {
    if (!dataSourceId || rowSubmitting) return;
    setRowSubmitting(true);
    try {
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/rows`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      const created: RowResponse = await res.json();
      setNewlyCreatedRowId(created.id);
      await refetchRows?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add row", "error");
    } finally {
      setRowSubmitting(false);
    }
  }

  // Milestone 12 (task-40), decision 3: every NON-default template — the
  // default one is already what plain "+ New" produces (the backend
  // auto-applies it), so listing it again in the dropdown would be
  // confusing/redundant.
  const nonDefaultTemplates = (templates ?? []).filter((t) => !t.is_default);

  async function handleInstantiateTemplate(templateId: string) {
    if (!onInstantiateTemplate || instantiatingTemplateId) return;
    setInstantiatingTemplateId(templateId);
    setTemplateMenuOpen(false);
    try {
      await onInstantiateTemplate(templateId);
      await refetchRows?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not create row from template", "error");
    } finally {
      setInstantiatingTemplateId(null);
    }
  }

  // `useMemo`: an unmemoized `.find()` over every row would re-run on every
  // render this component makes for unrelated reasons (review-checkpoint
  // finding, same class as `tableData` above).
  const peekRow = useMemo(() => (peekRowId ? rows.find((r) => r.id === peekRowId) : undefined), [peekRowId, rows]);

  // Shared between the flat table and M6's grouped rendering below — "every
  // group repeats the full column header row" (group-panel.md) means this
  // same `<tr>` of `<th>`s, minus the flat table's own trailing
  // "+ Add property" cell (not repeated per group — one add-property
  // affordance, not N of them).
  function headerCells() {
    return table.getHeaderGroups().map((headerGroup) => [
      gutterHeaderCell(),
      ...headerGroup.headers.map((header) => (
        <th
          key={header.id}
          style={{ width: header.getSize() }}
          className={`relative text-left font-medium text-gray-500 dark:text-gray-400 px-3 py-2 border-b border-gray-200 dark:border-gray-700 whitespace-nowrap ${cellBorderClass}`}
        >
          {flexRender(header.column.columnDef.header, header.getContext())}
          {/* M11 (table-drag-resize.md): the resize grip — "a blue
            * vertical bar at the border, within the header row." The
            * spec's own "guide line extending down through the table
            * body" is left unbuilt: several of its exact details (does it
            * persist for the whole drag or only on press?) are themselves
            * TBD in the capture, and the live column reflow below already
            * gives clear resize feedback without guessing at it. */}
          <div
            onMouseDown={header.getResizeHandler()}
            onTouchStart={header.getResizeHandler()}
            className={`absolute right-0 top-0 h-full w-1 cursor-col-resize touch-none select-none ${
              header.column.getIsResizing() ? "bg-blue-500" : "hover:bg-blue-400"
            }`}
          />
        </th>
      )),
    ]);
  }

  // M11 (calculations-row.md): the calculations footer row. Ungrouped
  // ONLY — the grouped `<table>` branch above never calls this (its own
  // `dataRow`/header-repeat machinery has no per-group footer yet; the
  // spec's own States table marks that TBD, capture-first). One `<td>` per
  // VISIBLE column (`orderedProperties`, same list `columns`/headers are
  // built from), right-aligned, empty unless that column has a calculation
  // AND `aggregates` actually carries a value for it (absent whenever
  // `getQueryExtras` had nothing to send, e.g. no calculation set at all).
  function footerRow() {
    if (!aggregates) return null;
    const config = view?.config ?? {};
    const hasAny = orderedProperties.some((p) => getCalculation(config, p.key));
    if (!hasAny) return null;
    return (
      <tfoot>
        <tr className="border-t border-gray-200 dark:border-gray-700">
          {editable && <td className="w-14" aria-hidden />}
          {orderedProperties.map((property) => {
            const aggregator = getCalculation(config, property.key);
            const value = aggregator ? aggregates[property.key] : undefined;
            return (
              <td key={property.key} className={`px-3 py-1.5 text-right text-sm ${cellBorderClass}`}>
                {aggregator && value !== undefined && (
                  <span>
                    <span className="text-[10px] font-medium uppercase text-gray-400 dark:text-gray-500 mr-1.5">
                      {calculationLabel(aggregator)}
                    </span>
                    <span className="text-gray-700 dark:text-gray-300">{formatCalculationValue(aggregator, value)}</span>
                  </span>
                )}
              </td>
            );
          })}
          {editable && <td />}
        </tr>
      </tfoot>
    );
  }

  // M9's row gutter (row-affordances.md) — a leading cell OUTSIDE the
  // table's own columns, reserved only when `editable` (the read-only All
  // Notes source suppresses `+`/drag handle/checkbox entirely, per the
  // spec's own States table — OPEN alone stays, which OpenNoteButton
  // already renders regardless of `editable`). One function for the header
  // stub, one for a row's own gutter, so all three row-render sites below
  // (grouped `dataRow`, the sub-item tree branch, the flat branch) share
  // identical markup instead of drifting three ways.
  function gutterHeaderCell() {
    if (!editable) return null;
    return <th key="gutter" className="w-14 border-b border-gray-200 dark:border-gray-700" aria-hidden />;
  }
  function gutterCell(rowId: string) {
    if (!editable) return null;
    return (
      <td key="gutter" className="px-1 align-middle w-14">
        <RowGutter
          rowId={rowId}
          selected={selectedRowIds.has(rowId)}
          onToggleSelected={toggleRowSelected}
          onAddRow={handleAddRow}
          onOpenSidePeek={(id) => openRow(id, "side")}
          onTrashed={() => refetchRows?.()}
        />
      </td>
    );
  }

  // Shared row renderer — same title-cell (page icon + OpenNoteButton)
  // treatment the flat branch below has always used, factored out so M6's
  // per-group `<tbody>` can render identically without duplicating it.
  // Sub-item tree/flattened-parent decoration is deliberately NOT
  // reproduced here: grouping and the sub-item tree are two different
  // orderings of the same flat row list, and combining them is out of
  // scope (grouped mode always renders flat rows, tree mode never combines
  // with a `group_by`).
  function dataRow(tableRow: ReturnType<typeof table.getRow>) {
    return (
      <tr
        key={tableRow.id}
        onClick={handleRowAltClick(tableRow.original.id)}
        className="group border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
      >
        {gutterCell(tableRow.original.id)}
        {tableRow.getVisibleCells().map((cell) => (
          <td key={cell.id} style={{ width: cell.column.getSize() }} className={`px-3 py-1.5 align-middle max-w-xs ${cellBorderClass}`}>
            {cell.column.id === titleProperty?.key ? (
              <div className="flex items-center gap-1">
                {showPageIcon && <FileText size={12} className="shrink-0 text-gray-300 dark:text-gray-600" aria-hidden />}
                <div className="flex-1 min-w-0">{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>
                <OpenNoteButton
                  noteId={tableRow.original.id}
                  isOpen={peekRowId === tableRow.original.id}
                  className="shrink-0 opacity-0 group-hover:opacity-100"
                  onOpen={toggleRow}
                />
              </div>
            ) : (
              flexRender(cell.column.columnDef.cell, cell.getContext())
            )}
          </td>
        ))}
        {editable && <td className="px-3 py-1.5" />}
      </tr>
    );
  }

  return (
    <>
    <div className="flex h-full flex-col">
      {view && onSetSorts && onSetFilter && (
        <QueryBar view={view} properties={allOrderedProperties} onSetSorts={onSetSorts} onSetFilter={onSetFilter} />
      )}
      {/* M9 (row-affordances.md §"Bulk selection"): replaces the toolbar row
        * while any row is selected. The overflow `⋯`, shift-click range
        * selection and the per-property-type bulk-edit icons are all
        * captured-but-TBD in the spec — this ships the count + bulk trash +
        * deselect only, not a half-built version of the rest. */}
      {editable && selectedRowIds.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-900 dark:bg-gray-800 text-white text-xs">
          <span>{selectedRowIds.size} selected</span>
          <button
            type="button"
            aria-label="Move selected rows to Trash"
            onClick={trashSelectedRows}
            className="flex items-center gap-1 text-gray-300 hover:text-white"
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            aria-label="Clear selection"
            onClick={() => setSelectedRowIds(new Set())}
            className="ml-auto text-gray-300 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {!groups && rows.length === 0 && hasActiveFilter ? (
        // M11 (states.md): "the entire table disappears — column headers,
        // group headers, the + New page row and the calculations footer
        // are ALL gone... Two buttons. No text at all." — deliberately NOT
        // the grouped case (`groups` truthy): the spec's own capture never
        // addresses an empty-due-to-filter GROUPED view (states.md's own
        // "An empty GROUP" is a separate, uncaptured TBD), so this only
        // replaces the plain flat table.
        <div className="flex flex-1 items-center justify-center gap-2">
          <Popover
            open={emptyFilterMenuOpen}
            onOpenChange={setEmptyFilterMenuOpen}
            width="md"
            label="Edit filters"
            trigger={
              <button
                type="button"
                className="rounded border border-gray-200 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Edit filters
              </button>
            }
          >
            {view && onSetFilter && (
              <MenuList
                root={filterPanel(allOrderedProperties, view.filter, onSetFilter)}
                nav="flyout"
                onClose={() => setEmptyFilterMenuOpen(false)}
                label="Filter"
              />
            )}
          </Popover>
          <button
            type="button"
            onClick={handleAddRow}
            disabled={rowSubmitting || !dataSourceId}
            className="rounded bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            + New page
          </button>
        </div>
      ) : groups ? (
        <div className="overflow-auto flex-1 min-h-0">
          {(() => {
            const spec = groupBySpec ?? { property_key: "" };
            const hidden = new Set(spec.hidden_groups ?? []);
            const visible = orderedGroups(groups, spec).filter((g) => !hidden.has(g.key));
            return visible.map((group) => {
              const collapsed = collapsedGroupKeys.has(group.key);
              return (
                <div key={group.key} className="border-b border-gray-200 dark:border-gray-700">
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-gray-900">
                    <button
                      type="button"
                      aria-label={collapsed ? `Expand ${groupDisplayLabel(group, groupProperty)}` : `Collapse ${groupDisplayLabel(group, groupProperty)}`}
                      onClick={() => toggleGroupCollapsed(group.key)}
                      className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    </button>
                    {group.key === "__no_value__" ? (
                      <span className="text-xs font-medium text-gray-400 dark:text-gray-500">
                        {groupDisplayLabel(group, groupProperty)}
                      </span>
                    ) : (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300 ${
                          groupProperty ? pillStyleForOption(group.label, configuredOptions(groupProperty)) : "bg-gray-100 dark:bg-gray-800"
                        }`}
                      >
                        {groupDisplayLabel(group, groupProperty)}
                      </span>
                    )}
                  </div>
                  {!collapsed && (
                    <table className="w-full border-collapse text-sm">
                      <thead>
                        <tr>{headerCells()}</tr>
                      </thead>
                      <tbody>
                        {group.rows.map((row) => dataRow(table.getRow(row.id)))}
                        {editable && (
                          <tr>
                            <td colSpan={Math.max(columnCount, 1)} className="px-3 py-1.5">
                              <button
                                type="button"
                                onClick={() => handleAddRowToGroup(group)}
                                disabled={addingRowToGroupKey === group.key}
                                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40"
                              >
                                + New page
                              </button>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            });
          })()}
          {editable && groupPropertyIsOptionBased && (
            <button
              type="button"
              onClick={handleAddGroupOption}
              disabled={addingGroupOption}
              className="flex items-center gap-1 px-3 py-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40"
            >
              <Plus size={12} /> New group
            </button>
          )}
        </div>
      ) : (
      <div className="overflow-auto flex-1 min-h-0">
      <table className="w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-white dark:bg-gray-900">
          <tr>
            {/* M11: now genuinely shared with the grouped table's own
              * per-group header row below — see `headerCells()`'s own
              * comment — rather than a byte-for-byte duplicate of it. */}
            {headerCells()}
            {editable && dataSourceId && (
              <th className="text-left font-normal px-3 py-2 border-b border-gray-200 dark:border-gray-700 whitespace-nowrap">
                {/* M2: the anchored creation popover. Replaced a
                  * trailing-column inline form that held five of this app's
                  * 40 native <select> elements. */}
                <AddPropertyPopover
                  dataSourceId={dataSourceId}
                  properties={allOrderedProperties}
                  onCreated={() => refetch?.()}
                />
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {/* M11 (states.md): "the empty state IS the affordance to fill
            * it" — a brand-new, unfiltered, empty database renders the
            * table NORMALLY (header row + the "+ New" row below), with no
            * "No rows yet." message at all. (The OTHER empty state — a
            * filter matching nothing — is handled by an entirely separate
            * branch above this `<table>`, which this one never reaches.) */}
          {rows.length > 0 && treeEntries
            ? // Sub-item "show" mode: tree order + indentation/toggle on the
              // title cell (task-22-brief.md §3). `table.getRow(id)` looks up
              // the same TanStack Row the flat branch below would use — the
              // column defs (and every non-title cell) are unchanged, only
              // the iteration order/decoration differs.
              treeEntries.map(({ row: entryRow, depth, hasChildren }) => {
                const tableRow = table.getRow(entryRow.id);
                return (
                  <tr
                    key={entryRow.id}
                    onClick={handleRowAltClick(entryRow.id)}
                    className="group border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    {gutterCell(entryRow.id)}
                    {tableRow.getVisibleCells().map((cell) => (
                      <td key={cell.id} style={{ width: cell.column.getSize() }} className={`px-3 py-1.5 align-middle max-w-xs ${cellBorderClass}`}>
                        {cell.column.id === titleProperty?.key ? (
                          <div className="flex items-center gap-1" style={{ paddingLeft: depth * 16 }}>
                            {hasChildren ? (
                              <button
                                type="button"
                                aria-label={collapsedIds.has(entryRow.id) ? "Expand" : "Collapse"}
                                onClick={() => toggleCollapsed(entryRow.id)}
                                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 w-3 shrink-0"
                              >
                                {collapsedIds.has(entryRow.id) ? "▸" : "▾"}
                              </button>
                            ) : (
                              <span className="w-3 shrink-0" />
                            )}
                            {showPageIcon && (
                              <FileText size={12} className="shrink-0 text-gray-300 dark:text-gray-600" aria-hidden />
                            )}
                            <div className="flex-1 min-w-0">
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </div>
                            <OpenNoteButton
                              noteId={entryRow.id}
                              isOpen={peekRowId === entryRow.id}
                              className="shrink-0 opacity-0 group-hover:opacity-100"
                              onOpen={toggleRow}
                            />
                          </div>
                        ) : (
                          flexRender(cell.column.columnDef.cell, cell.getContext())
                        )}
                      </td>
                    ))}
                    {editable && <td className="px-3 py-1.5" />}
                  </tr>
                );
              })
            : rows.length > 0 &&
              table.getRowModel().rows.map((row) => {
                // Flattened mode's "sub-items marked with a parent
                // indicator" (task-22-brief.md §3) — the reverse ("Parent
                // item") property's cached links, first one only (a
                // sub-item conceptually has one parent; nothing in this
                // schema enforces that structurally, so this just shows the
                // first link rather than guessing which one is "the" parent).
                const parentTitle =
                  subItemDisplayMode === "flattened" && subItemReverseProp
                    ? relationLinks?.[`${row.original.id}:${subItemReverseProp.key}`]?.[0]?.title
                    : undefined;
                return (
                  <tr
                    key={row.id}
                    onClick={handleRowAltClick(row.original.id)}
                    className="group border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                  >
                    {gutterCell(row.original.id)}
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} style={{ width: cell.column.getSize() }} className={`px-3 py-1.5 align-middle max-w-xs ${cellBorderClass}`}>
                        {cell.column.id === titleProperty?.key ? (
                          <div className="flex items-center gap-1">
                            {showPageIcon && (
                              <FileText size={12} className="shrink-0 text-gray-300 dark:text-gray-600" aria-hidden />
                            )}
                            <div className="flex-1 min-w-0">
                              {parentTitle && (
                                <div className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                                  ↳ {parentTitle}
                                </div>
                              )}
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </div>
                            <OpenNoteButton
                              noteId={row.original.id}
                              isOpen={peekRowId === row.original.id}
                              className="shrink-0 opacity-0 group-hover:opacity-100"
                              onOpen={toggleRow}
                            />
                          </div>
                        ) : (
                          flexRender(cell.column.columnDef.cell, cell.getContext())
                        )}
                      </td>
                    ))}
                    {editable && <td className="px-3 py-1.5" />}
                  </tr>
                );
              })}
          {editable && (
            <tr>
              <td colSpan={Math.max(columnCount, 1)} className="px-3 py-1.5">
                <div ref={templateMenuRef} className="relative inline-flex items-center">
                  <button
                    type="button"
                    onClick={handleAddRow}
                    disabled={rowSubmitting}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-40"
                  >
                    + New
                  </button>
                  {/* M11 (new-row-button.md), user decision 2026-09-01: the
                   * chevron is now UNCONDITIONAL — Notion's own IA treats
                   * this dropdown as the entry point for AUTHORING a
                   * template, not merely picking one, so "zero templates"
                   * must still open onto something (the captured empty
                   * state: header, description, "+ New template"), not
                   * disappear. */}
                  <button
                    type="button"
                    aria-label="Choose a template"
                    aria-haspopup="menu"
                    aria-expanded={templateMenuOpen}
                    onClick={() => setTemplateMenuOpen((o) => !o)}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 px-1"
                  >
                    ▾
                  </button>
                  {templateMenuOpen && (
                    <div
                      role="menu"
                      aria-label="New row from template"
                      className="absolute left-0 bottom-full z-20 mb-1 w-64 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1"
                    >
                      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 truncate">
                          Templates for {dataSourceName ?? "this database"}
                        </span>
                        <HelpCircle
                          size={13}
                          className="shrink-0 text-gray-300 dark:text-gray-600"
                          aria-label="What are templates?"
                        />
                      </div>
                      <div className="border-t border-gray-100 dark:border-gray-700 my-1" />
                      {nonDefaultTemplates.length > 0 ? (
                        // "How each is listed [with templates present] is
                        // TBD" (new-row-button.md) — unchanged from before
                        // M11, the one part that WAS captured (the EMPTY
                        // state) is what M11 adds below.
                        nonDefaultTemplates.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            role="menuitem"
                            disabled={instantiatingTemplateId === t.id}
                            onClick={() => handleInstantiateTemplate(t.id)}
                            className="w-full flex items-center gap-1.5 text-left text-xs px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 disabled:opacity-40"
                          >
                            {t.icon && <span className="leading-none">{t.icon}</span>}
                            {t.name}
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500">
                          Create a reusable page template for this database.
                        </div>
                      )}
                      {onCreateTemplate && onUpdateTemplate && onDeleteTemplate && (
                        <>
                          <div className="border-t border-gray-100 dark:border-gray-700 my-1" />
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setTemplateMenuOpen(false);
                              setTemplateManagerOpen(true);
                            }}
                            className="w-full flex items-center gap-1.5 text-left text-xs px-3 py-1.5 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                          >
                            <Plus size={12} /> New template
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </td>
            </tr>
          )}
        </tbody>
        {footerRow()}
      </table>
      </div>
      )}
    </div>
    {peekRow && (
      <RowPeek
        row={peekRow}
        properties={properties}
        editable={editable}
        onCellChange={onCellChange}
        onClose={closePeek}
        mode={peekMode === "center" ? "center" : "side"}
        dataSourceId={dataSourceId}
        onPropertyCreated={refetch}
      />
    )}
    {onCreateTemplate && onUpdateTemplate && onDeleteTemplate && (
      <TemplateManager
        open={templateManagerOpen}
        onClose={() => setTemplateManagerOpen(false)}
        templates={templates ?? []}
        properties={properties}
        onCreateTemplate={onCreateTemplate}
        onUpdateTemplate={onUpdateTemplate}
        onDeleteTemplate={onDeleteTemplate}
      />
    )}
    </>
  );
}
