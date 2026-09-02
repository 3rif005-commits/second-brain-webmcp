"use client";

// Dashboard view (Milestone 13, task-45) — the only COMPOSITE view type in
// this app (research §13): it renders OTHER views, arranged in a 12-column
// widget grid, rather than rendering row data itself. A dashboard view here
// still belongs to a real `data_source_id` (migration 014's `NOT NULL`
// column — Notion's own dashboards have `data_source_id: null`, a deliberate
// scope reduction the brief calls out), and its widgets may only reference
// OTHER views from that SAME data source — enforced server-side by
// `_validate_dashboard_config` (routers/databases.py, task-45's backend
// half) and pre-checked here client-side as a UX nicety only (the backend
// stays the single source of truth for the actual limits).
//
// `config` contract (task-45-brief.md, research §13.1, simplified per the
// brief: no `widgets[].row_index` — row array ORDER is the display order):
//   rows: [{ id: string, height: number, widgets: [{ id, view_id, width }] }]
//
// Why no shared `renderViewComponent` extracted from DatabaseShell.tsx:
// DatabaseShell's `renderActiveView` switch is a closure over ONE fetched
// row/group/aggregate set (`useDatabaseView`'s single `activeView` query) —
// every case reads `rows`/`groups`/`aggregates` from that one hook call. A
// dashboard widget needs a DIFFERENT, INDEPENDENT query per widget (each
// widget's own view has its own filter/sorts/config, e.g. one Table widget
// and one Board widget on the same dashboard need two unrelated `/query`
// calls) — so the actual hard part here is per-widget data-fetching, not
// the switch statement itself (which is ~10 short cases either way). This
// file therefore fetches its own per-widget data (`useWidgetQuery` below,
// a scoped-down sibling of `useDatabaseView`'s `loadRows`/`updateCell`) and
// writes its own small switch (`DashboardWidgetContent`) rather than
// extracting/reusing DatabaseShell's — touches DatabaseShell.tsx only for
// the one-line `case "dashboard"` wiring, nothing in its existing switch
// internals.
//
// Resize interaction: a plain numeric stepper (`<input type="number">`,
// 1-12) for widget width and a plain numeric pixel input for row height —
// the brief's documented "acceptable, simpler substitute" for a full
// drag-resize, chosen to keep this task's scope to the grid mechanic itself
// rather than a new pointer-drag interaction.
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/app/providers";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { getQueryExtras } from "@/lib/database/types";
import type { DatabaseRow, Group, PropertyValue, PropertyResponse, ViewResponse } from "@/lib/database/types";
import { TableView } from "./TableView";
import { BoardView } from "./BoardView";
import { GalleryView } from "./GalleryView";
import { ListView } from "./ListView";
import { FeedView } from "./FeedView";
import { CalendarView } from "./CalendarView";
import { TimelineView } from "./TimelineView";
import { ChartView } from "./ChartView";

// research §13.2: "Up to 4 widgets per row" / "Up to 12 widgets total" —
// mirrors `_DASHBOARD_MAX_WIDGETS_PER_ROW`/`_DASHBOARD_MAX_WIDGETS_TOTAL`
// (backend/routers/databases.py). Client-side only for disabling the "add
// widget" control before a request is even made — the backend's own
// `_validate_dashboard_config` is still what actually enforces this; a
// mismatch here would only ever produce an extra round-trip-then-toast, not
// a bypass.
export const DASHBOARD_MAX_WIDGETS_PER_ROW = 4;
export const DASHBOARD_MAX_WIDGETS_TOTAL = 12;
export const DASHBOARD_DEFAULT_ROW_HEIGHT = 320;
const DASHBOARD_DEFAULT_WIDGET_WIDTH = 6;

export interface DashboardWidget {
  id: string;
  view_id: string;
  width: number;
}

export interface DashboardRow {
  id: string;
  height: number;
  widgets: DashboardWidget[];
}

let localIdCounter = 0;
function genLocalId(prefix: string): string {
  localIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${localIdCounter}`;
}

/** Tolerates a missing/malformed shape (empty array, never a throw) — same
 * "tolerates unknown... drops them at read" spirit spec §10 states for view
 * config generally, and `FormView.tsx`'s `readFormQuestions` already
 * follows for this milestone's other config-driven view.
 *
 * Combined-M13-review fix: fallback ids for a row/widget missing one used
 * to be minted via `genLocalId` (a module counter + `Date.now()`) — called
 * fresh on every invocation, including every render, since this function
 * runs unconditionally in the component body. For any config lacking ids
 * (hand-edited, or a future writer that omits them), that meant a NEW id
 * every render: React remounts every widget each time (id is the list
 * key), re-firing `useWidgetQuery`'s fetch, and `handleRemoveWidgetConfirmed`
 * filters on a `widgetId` captured at click time that no longer matches
 * anything by the time the click handler runs — Remove silently no-ops.
 * Fallback ids are now derived from each row/widget's own position in the
 * array instead — deterministic across repeated calls with the SAME
 * config, so two reads of identical input always agree, and only a
 * genuinely NEW row/widget (via `handleAddRow`/`handleAddWidget`, still
 * using `genLocalId`) gets a freshly-minted id. */
export function readDashboardRows(config: Record<string, unknown>): DashboardRow[] {
  if (!Array.isArray(config.rows)) return [];
  return config.rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r, rowIndex) => ({
      id: typeof r.id === "string" && r.id ? r.id : `row-${rowIndex}`,
      height: typeof r.height === "number" && r.height > 0 ? r.height : DASHBOARD_DEFAULT_ROW_HEIGHT,
      widgets: Array.isArray(r.widgets)
        ? r.widgets
            .filter(
              (w): w is Record<string, unknown> =>
                !!w && typeof w === "object" && typeof (w as Record<string, unknown>).view_id === "string"
            )
            .map((w, widgetIndex) => ({
              id: typeof w.id === "string" && w.id ? w.id : `row-${rowIndex}-widget-${widgetIndex}`,
              view_id: w.view_id as string,
              width:
                typeof w.width === "number" && w.width >= 1 && w.width <= 12
                  ? w.width
                  : DASHBOARD_DEFAULT_WIDGET_WIDTH,
            }))
        : [],
    }));
}

async function widgetErrorMessage(res: Response): Promise<string> {
  // Duplicated from useDatabaseView.ts's own (unexported) `errorMessage`
  // rather than exporting/importing it — this is the first view component
  // that fetches its own data independently of that hook, and the logic is
  // eight lines with no shared state to keep it in sync with.
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (typeof body?.error === "string") return body.error;
  } catch {
    // body wasn't JSON (or was empty) — fall through to the generic message
  }
  return `Request failed (${res.status})`;
}

/** A scoped-down sibling of `useDatabaseView.ts`'s `loadRows`/`updateCell`,
 * for exactly ONE widget's own view — independent of whatever the dashboard
 * view's own (unrelated) query state is. Simplifications versus the full
 * hook, deliberate for this task's scope: no relation-links cache, no
 * dependency-cascade `shifted_rows` merge, no row-template plumbing — a
 * widget still renders correctly without them (relation columns fall back
 * to TableView's own documented read-only `GenericCell`, per its own
 * "optional — caller just gets a degraded but non-crashing behaviour"
 * contract), it just doesn't get every table affordance DatabaseShell's own
 * active view gets. */
function useWidgetQuery(dataSourceId: string, view: ViewResponse | undefined) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [aggregates, setAggregates] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!view) return;
    // Combined-M13-review fix: `form` is a builder/editor over `config`,
    // never a row-data view (same reasoning FormView.tsx's own top-of-file
    // comment gives) — querying rows for it was always wasted work, only
    // reachable via a stale/hand-edited config since the "add widget"
    // picker now excludes `form` (see widgetCandidates below).
    if (view.type === "form") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    try {
      const body: Record<string, unknown> = {
        filter: view.filter ?? null,
        sorts: view.sorts ?? [],
        ...getQueryExtras(view),
      };
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await widgetErrorMessage(res));
      const data: { rows?: DatabaseRow[]; groups?: Group[]; aggregates?: Record<string, number> } =
        await res.json();
      if (data.groups) {
        setGroups(data.groups);
        setRows([]);
        setAggregates(null);
      } else {
        setRows(data.rows ?? []);
        setGroups(null);
        setAggregates(data.aggregates ?? null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load this widget");
    } finally {
      setLoading(false);
    }
    // Same "key on the query-relevant shape, not the object identity" reason
    // useDatabaseView's own loadRows effect documents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    dataSourceId,
    view?.id,
    view?.type,
    JSON.stringify(view?.filter ?? null),
    JSON.stringify(view?.sorts ?? []),
    JSON.stringify(view?.config ?? {}),
  ]);

  useEffect(() => {
    load();
  }, [load]);

  const updateCell = useCallback(
    async (rowId: string, propertyKey: string, value: PropertyValue | null) => {
      const previousRows = rows;
      const wasGrouped = groups !== null;
      setRows((prev) =>
        prev.map((row) => {
          if (row.id !== rowId) return row;
          if (value === null) {
            const { [propertyKey]: _omit, ...rest } = row.properties;
            return { ...row, properties: rest };
          }
          return { ...row, properties: { ...row.properties, [propertyKey]: value } };
        })
      );
      try {
        const res = await fetch(`/api/db/data-sources/${dataSourceId}/rows/${rowId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ property_key: propertyKey, value }),
        });
        if (!res.ok) throw new Error(await widgetErrorMessage(res));
      } catch (e) {
        setRows(previousRows);
        showToast(e instanceof Error ? e.message : "Could not save that change", "error");
        return;
      }
      if (wasGrouped) {
        try {
          await load();
        } catch {
          showToast("Saved, but this widget may be out of date — refresh to see the latest.", "info");
        }
      }
    },
    [dataSourceId, rows, groups, load, showToast]
  );

  return { rows, groups, aggregates, loading, loadError, updateCell, refetchRows: load };
}

interface DashboardWidgetContentProps {
  view: ViewResponse;
  properties: PropertyResponse[];
  dataSourceId: string;
  editable: boolean;
  onUpdateView: (viewId: string, patch: { config: Record<string, unknown> }) => Promise<ViewResponse>;
}

/** Mounts the widget's OWN view's existing component — the same type-to-
 * component dispatch DatabaseShell.tsx's `renderActiveView` does for the
 * currently active view, kept as its own small switch here rather than
 * shared (see this file's top-of-file comment for why). `dashboard` and
 * `map` are deliberately absent: nested dashboards are already rejected
 * server-side (and filtered out of the "add widget" picker below), and Map
 * is out of scope for the whole milestone. */
function DashboardWidgetContent({ view, properties, dataSourceId, editable, onUpdateView }: DashboardWidgetContentProps) {
  const { rows, groups, aggregates, loading, loadError, updateCell, refetchRows } = useWidgetQuery(
    dataSourceId,
    view
  );

  function patchThisWidgetsView(patch: Record<string, unknown>) {
    onUpdateView(view.id, { config: { ...view.config, ...patch } });
  }

  if (loading && rows.length === 0 && groups === null) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-500">
        Loading…
      </div>
    );
  }
  if (loadError) {
    return <div className="flex items-center justify-center h-full text-xs text-red-500">{loadError}</div>;
  }

  switch (view.type) {
    case "table":
      return (
        <TableView
          properties={properties}
          rows={rows}
          editable={editable}
          onCellChange={updateCell}
          dataSourceId={dataSourceId}
          refetchRows={refetchRows}
        />
      );
    case "board":
      return (
        <BoardView
          properties={properties}
          groups={groups}
          groupPropertyKey={
            (view.config.group_by as Record<string, unknown> | undefined)?.property_key as string | undefined ??
            null
          }
          hideEmptyGroups={(view.config.group_by as Record<string, unknown> | undefined)?.hide_empty_groups === true}
          onToggleHideEmptyGroups={(value) => {
            const groupBy = (view.config.group_by as Record<string, unknown>) ?? { property_key: "" };
            patchThisWidgetsView({ group_by: { ...groupBy, hide_empty_groups: value } });
          }}
          editable={editable}
          onCellChange={updateCell}
        />
      );
    case "gallery":
      return (
        <GalleryView
          properties={properties}
          rows={rows}
          editable={editable}
          onCellChange={updateCell}
          config={view.config}
          onConfigChange={patchThisWidgetsView}
        />
      );
    case "list":
      return <ListView properties={properties} rows={rows} editable={editable} onCellChange={updateCell} />;
    case "feed":
      return (
        <FeedView
          properties={properties}
          rows={rows}
          editable={editable}
          onCellChange={updateCell}
          config={view.config}
          onConfigChange={patchThisWidgetsView}
        />
      );
    case "calendar":
      return (
        <CalendarView
          properties={properties}
          rows={rows}
          editable={editable}
          onCellChange={updateCell}
          config={view.config}
          onConfigChange={patchThisWidgetsView}
          dataSourceId={dataSourceId}
          refetchRows={refetchRows}
        />
      );
    case "timeline":
      return (
        <TimelineView
          properties={properties}
          rows={rows}
          editable={editable}
          onCellChange={updateCell}
          config={view.config}
          onConfigChange={patchThisWidgetsView}
        />
      );
    case "chart":
      return (
        <ChartView properties={properties} config={view.config} groups={groups} aggregates={aggregates} editable={false} />
      );
    case "form":
      // Combined-M13-review fix: a Form view is a builder/editor over
      // `config` (question picker, submit-screen settings, the public
      // share link) — mounting the FULL owner-side FormView.tsx into a
      // ~small grid cell, ignoring `editable` entirely (FormView has no
      // such prop), was never a sensible dashboard widget. Now excluded
      // from the "add widget" picker (widgetCandidates below); this
      // branch only still exists for a config that already references one
      // (stale/hand-edited), rendered as a clear placeholder rather than
      // silently degrading.
      return (
        <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-500 p-2 text-center">
          Form views can&apos;t be shown as a dashboard widget.
        </div>
      );
    default:
      return (
        <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-500">
          This view type isn&apos;t supported yet.
        </div>
      );
  }
}

export interface DashboardViewProps {
  viewId: string;
  dataSourceId: string;
  properties: PropertyResponse[];
  /** Every OTHER view on this dashboard's OWN data source — the pool a
   * widget's `view_id` may be picked from (server-enforced same-data-source
   * check, `_validate_dashboard_config`) and rendered from once picked.
   * Includes this dashboard's own `ViewResponse` too (needed to resolve
   * `views.find(v => v.id === widget.view_id)`), filtered out of the
   * add-widget picker below by id. */
  views: ViewResponse[];
  config: Record<string, unknown>;
  editable: boolean;
  onUpdateView: (viewId: string, patch: { config: Record<string, unknown> }) => Promise<ViewResponse>;
}

export function DashboardView({ viewId, dataSourceId, properties, views, config, editable, onUpdateView }: DashboardViewProps) {
  const { showToast } = useToast();
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [confirmRemoveWidget, setConfirmRemoveWidget] = useState<{ rowId: string; widgetId: string } | null>(null);
  const [confirmRemoveRow, setConfirmRemoveRow] = useState<string | null>(null);
  const [addWidgetViewId, setAddWidgetViewId] = useState<Record<string, string>>({});

  // Combined-M13-review fix: row-height/widget-width numeric inputs used to
  // PATCH on every keystroke, fire-and-forget, with no ordering guarantee —
  // `useDatabaseView.updateView` unconditionally applies whichever response
  // lands last, so typing "1000" (four PATCHes: 1/10/100/1000) could have
  // the "1" response arrive after "1000" under routine latency jitter and
  // silently clobber the layout back to height 1. Local draft state +
  // 600ms debounce-then-flush-on-blur, same duration/pattern
  // `FormView.tsx`'s submit-screen fields already establish for this
  // milestone's other config-driven view, closes both the ordering race
  // and the "clearing the field mid-edit snaps to the default and PATCHes
  // that" side effect (the draft holds the raw in-progress string; only
  // the debounced/blurred save clamps it).
  const [draftHeights, setDraftHeights] = useState<Record<string, string>>({});
  const [draftWidths, setDraftWidths] = useState<Record<string, string>>({});
  const heightDebounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const widthDebounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const rows = readDashboardRows(config);
  const totalWidgets = rows.reduce((n, row) => n + row.widgets.length, 0);

  // The "SAME data source" + "no nested dashboards" constraints, applied
  // client-side as the add-widget picker's own candidate pool — a UX
  // nicety (research §13.2's hard rules are still enforced server-side by
  // `_validate_dashboard_config`, which is what actually rejects a request
  // this pool somehow let through, e.g. a stale `views` list). `form` is
  // also excluded (combined-M13-review fix): it's a builder/editor over
  // `config`, not a row-data view, and was never a sensible widget — see
  // `DashboardWidgetContent`'s own `case "form"` comment.
  const widgetCandidates = views.filter((v) => v.id !== viewId && v.type !== "dashboard" && v.type !== "form");
  const viewById = new Map(views.map((v) => [v.id, v]));

  async function saveRows(nextRows: DashboardRow[]) {
    try {
      await onUpdateView(viewId, { config: { ...config, rows: nextRows } });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not update the dashboard layout", "error");
    }
  }

  function handleAddRow() {
    saveRows([...rows, { id: genLocalId("row"), height: DASHBOARD_DEFAULT_ROW_HEIGHT, widgets: [] }]);
  }

  function handleRemoveRowConfirmed() {
    if (!confirmRemoveRow) return;
    saveRows(rows.filter((r) => r.id !== confirmRemoveRow));
    setConfirmRemoveRow(null);
  }

  async function commitRowHeight(rowId: string, raw: string) {
    const parsed = Number(raw);
    const clamped = Number.isFinite(parsed) && parsed > 0 ? parsed : DASHBOARD_DEFAULT_ROW_HEIGHT;
    await saveRows(rows.map((r) => (r.id === rowId ? { ...r, height: clamped } : r)));
    // Falls back to reading `row.height` (now updated) again, rather than
    // pinning to this stale raw string forever.
    setDraftHeights((prev) => {
      const { [rowId]: _omit, ...rest } = prev;
      return rest;
    });
  }

  function handleRowHeightChange(rowId: string, raw: string) {
    setDraftHeights((prev) => ({ ...prev, [rowId]: raw }));
    if (heightDebounceRefs.current[rowId]) clearTimeout(heightDebounceRefs.current[rowId]);
    heightDebounceRefs.current[rowId] = setTimeout(() => commitRowHeight(rowId, raw), 600);
  }

  function handleRowHeightBlur(rowId: string) {
    const draft = draftHeights[rowId];
    if (draft === undefined) return;
    if (heightDebounceRefs.current[rowId]) clearTimeout(heightDebounceRefs.current[rowId]);
    commitRowHeight(rowId, draft);
  }

  function handleAddWidget(rowId: string) {
    const targetViewId = addWidgetViewId[rowId];
    if (!targetViewId) return;
    saveRows(
      rows.map((r) =>
        r.id === rowId
          ? { ...r, widgets: [...r.widgets, { id: genLocalId("widget"), view_id: targetViewId, width: DASHBOARD_DEFAULT_WIDGET_WIDTH }] }
          : r
      )
    );
    setAddWidgetViewId((prev) => ({ ...prev, [rowId]: "" }));
  }

  function handleRemoveWidgetConfirmed() {
    if (!confirmRemoveWidget) return;
    const { rowId, widgetId } = confirmRemoveWidget;
    saveRows(
      rows.map((r) => (r.id === rowId ? { ...r, widgets: r.widgets.filter((w) => w.id !== widgetId) } : r))
    );
    setConfirmRemoveWidget(null);
  }

  async function commitWidgetWidth(rowId: string, widgetId: string, raw: string) {
    const parsed = Number(raw);
    const clamped = Math.min(12, Math.max(1, Math.round(parsed) || 1));
    await saveRows(
      rows.map((r) =>
        r.id === rowId
          ? { ...r, widgets: r.widgets.map((w) => (w.id === widgetId ? { ...w, width: clamped } : w)) }
          : r
      )
    );
    const draftKey = `${rowId}:${widgetId}`;
    setDraftWidths((prev) => {
      const { [draftKey]: _omit, ...rest } = prev;
      return rest;
    });
  }

  function handleResizeWidget(rowId: string, widgetId: string, raw: string) {
    const draftKey = `${rowId}:${widgetId}`;
    setDraftWidths((prev) => ({ ...prev, [draftKey]: raw }));
    if (widthDebounceRefs.current[draftKey]) clearTimeout(widthDebounceRefs.current[draftKey]);
    widthDebounceRefs.current[draftKey] = setTimeout(() => commitWidgetWidth(rowId, widgetId, raw), 600);
  }

  function handleResizeWidgetBlur(rowId: string, widgetId: string) {
    const draftKey = `${rowId}:${widgetId}`;
    const draft = draftWidths[draftKey];
    if (draft === undefined) return;
    if (widthDebounceRefs.current[draftKey]) clearTimeout(widthDebounceRefs.current[draftKey]);
    commitWidgetWidth(rowId, widgetId, draft);
  }

  const removingWidgetView = confirmRemoveWidget
    ? viewById.get(rows.find((r) => r.id === confirmRemoveWidget.rowId)?.widgets.find((w) => w.id === confirmRemoveWidget.widgetId)?.view_id ?? "")
    : undefined;

  return (
    <div data-testid="dashboard-view" className="h-full overflow-auto p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs text-gray-400 dark:text-gray-500">
          {totalWidgets}/{DASHBOARD_MAX_WIDGETS_TOTAL} widgets
        </div>
        <div className="inline-flex rounded-md border border-gray-200 dark:border-gray-700 overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => setMode("view")}
            aria-pressed={mode === "view"}
            className={`px-2.5 py-1 ${mode === "view" ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100" : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"}`}
          >
            View
          </button>
          <button
            type="button"
            onClick={() => setMode("edit")}
            aria-pressed={mode === "edit"}
            disabled={!editable}
            className={`px-2.5 py-1 border-l border-gray-200 dark:border-gray-700 ${mode === "edit" ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100" : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"} disabled:opacity-40`}
          >
            Edit
          </button>
        </div>
      </div>

      {rows.length === 0 && (
        <div className="flex items-center justify-center py-16 text-sm text-gray-400 dark:text-gray-500">
          {mode === "view" ? "No widgets yet." : "No rows yet — add one below."}
        </div>
      )}

      <div className="space-y-4">
        {rows.map((row) => {
          const rowFull = row.widgets.length >= DASHBOARD_MAX_WIDGETS_PER_ROW;
          const dashboardFull = totalWidgets >= DASHBOARD_MAX_WIDGETS_TOTAL;
          return (
            <div key={row.id} className="space-y-1.5">
              {mode === "edit" && (
                <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <label className="flex items-center gap-1">
                    Row height
                    <input
                      type="number"
                      aria-label={`Row height for ${row.id}`}
                      value={draftHeights[row.id] ?? row.height}
                      min={1}
                      onChange={(e) => handleRowHeightChange(row.id, e.target.value)}
                      onBlur={() => handleRowHeightBlur(row.id)}
                      className="w-16 text-xs px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                    />
                    px
                  </label>
                  <span>
                    {row.widgets.length}/{DASHBOARD_MAX_WIDGETS_PER_ROW} widgets
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmRemoveRow(row.id)}
                    className="text-red-500 hover:text-red-700 ml-auto"
                  >
                    Remove row
                  </button>
                </div>
              )}

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(12, 1fr)",
                  gap: "0.5rem",
                  minHeight: row.height,
                }}
              >
                {row.widgets.map((widget) => {
                  const widgetView = viewById.get(widget.view_id);
                  return (
                    <div
                      key={widget.id}
                      style={{ gridColumn: `span ${widget.width}` }}
                      className="min-w-0 border border-gray-100 dark:border-gray-800 rounded-lg overflow-hidden flex flex-col"
                    >
                      {mode === "edit" && (
                        <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] bg-gray-50 dark:bg-gray-800/60 border-b border-gray-100 dark:border-gray-800">
                          <span className="truncate flex-1 text-gray-600 dark:text-gray-300">
                            {widgetView?.name ?? "Unknown view"}
                          </span>
                          <label className="flex items-center gap-1 text-gray-400 dark:text-gray-500">
                            w
                            <input
                              type="number"
                              aria-label={`Width for ${widgetView?.name ?? widget.id}`}
                              min={1}
                              max={12}
                              value={draftWidths[`${row.id}:${widget.id}`] ?? widget.width}
                              onChange={(e) => handleResizeWidget(row.id, widget.id, e.target.value)}
                              onBlur={() => handleResizeWidgetBlur(row.id, widget.id)}
                              className="w-10 text-[11px] px-1 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                            />
                          </label>
                          <button
                            type="button"
                            aria-label={`Remove widget ${widgetView?.name ?? widget.id}`}
                            onClick={() => setConfirmRemoveWidget({ rowId: row.id, widgetId: widget.id })}
                            className="text-red-500 hover:text-red-700"
                          >
                            ×
                          </button>
                        </div>
                      )}
                      <div className="flex-1 min-h-0">
                        {widgetView ? (
                          <DashboardWidgetContent
                            view={widgetView}
                            properties={properties}
                            dataSourceId={dataSourceId}
                            editable={editable}
                            onUpdateView={onUpdateView}
                          />
                        ) : (
                          <div className="flex items-center justify-center h-full text-xs text-gray-400 dark:text-gray-500 p-2 text-center">
                            This view is no longer available.
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {mode === "edit" && (
                  <div
                    style={{ gridColumn: `span ${Math.max(2, 12 - row.widgets.reduce((n, w) => n + w.width, 0))}` }}
                    className="min-w-0 flex items-center gap-1.5 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-2"
                  >
                    {rowFull || dashboardFull ? (
                      <span className="text-[11px] text-amber-600 dark:text-amber-400">
                        {rowFull
                          ? `Row full (${DASHBOARD_MAX_WIDGETS_PER_ROW}/${DASHBOARD_MAX_WIDGETS_PER_ROW})`
                          : `Dashboard full (${DASHBOARD_MAX_WIDGETS_TOTAL}/${DASHBOARD_MAX_WIDGETS_TOTAL})`}
                      </span>
                    ) : widgetCandidates.length === 0 ? (
                      <span className="text-[11px] text-gray-400 dark:text-gray-500">
                        No other views on this data source yet.
                      </span>
                    ) : (
                      <>
                        <select
                          aria-label={`Add widget to ${row.id}`}
                          value={addWidgetViewId[row.id] ?? ""}
                          onChange={(e) => setAddWidgetViewId((prev) => ({ ...prev, [row.id]: e.target.value }))}
                          className="flex-1 min-w-0 text-[11px] px-1.5 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                        >
                          <option value="">Pick a view…</option>
                          {widgetCandidates.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name} ({v.type})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleAddWidget(row.id)}
                          disabled={!addWidgetViewId[row.id]}
                          className="text-[11px] px-2 py-1 rounded bg-indigo-600 text-white disabled:opacity-40"
                        >
                          + Add
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {mode === "edit" && (
        <button
          type="button"
          onClick={handleAddRow}
          className="text-xs px-2.5 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
        >
          + Add row
        </button>
      )}

      <ConfirmDialog
        open={confirmRemoveWidget !== null}
        title="Remove this widget?"
        description={
          removingWidgetView ? `"${removingWidgetView.name}" will be removed from this dashboard.` : undefined
        }
        confirmLabel="Remove"
        danger
        onConfirm={handleRemoveWidgetConfirmed}
        onCancel={() => setConfirmRemoveWidget(null)}
      />
      <ConfirmDialog
        open={confirmRemoveRow !== null}
        title="Remove this row?"
        description="Every widget in this row will be removed too."
        confirmLabel="Remove"
        danger
        onConfirm={handleRemoveRowConfirmed}
        onCancel={() => setConfirmRemoveRow(null)}
      />
    </div>
  );
}
