"use client";

// Gantt-style timeline view (Milestone 9, task-34). Follows the same shape
// as CalendarView.tsx (task-33): consumes `rows` from `useDatabaseView`
// ungrouped (research §5.5's API matrix marks `group_by` unsupported for
// timeline — no hook change needed), renders titles through the shared
// `renderCellValue`/`OpenNoteButton` pair, and keeps its trickiest logic —
// zoom-to-pixel mapping, bar geometry, resize-to-date resolution, arrow
// endpoint geometry — as plain exported pure functions, directly
// unit-testable without simulating a real drag gesture end-to-end.
//
// Config, Notion's own field nesting verbatim (spec §10):
//  - `config.date_property_id` (required, set at view-creation time — see
//    ViewTabs.tsx/DatabaseShell.tsx's Calendar-mirroring special case).
//  - `config.preference.zoom_level`: one of the 8 research-documented
//    levels, default "month" — nested under `preference` per research
//    §5.4, never flattened to `config.zoom_level`.
//  - `config.arrows_by`: a plain **boolean**, not Notion's
//    `{property_id}` shape (task-34-brief.md's ruling: this app has at
//    most one dependency relation pair per data source — the one
//    `findSystemRelationProperty(..., "dependency", "forward")` finds —
//    so a workspace-wide relation *picker* would be modelling a choice
//    that structurally only ever has one non-null answer).
//
// Scope cuts, decided in task-34-brief.md (not gaps, deliberate rulings):
//  - single date property carrying a range only (research §5.2's "separate
//    start/end properties" mode is out — `end_date_property_id` isn't
//    built), matching Calendar's task-33 decision.
//  - no table panel (`show_table`/`table_properties`), no `color_by`, no
//    "Load limit", no overflow-arrows jump-to-project interaction — none
//    of these are named in the plan's test-case list.
//  - `preference.center_timestamp` (research: persisted scroll position)
//    is NOT persisted to config — the horizontal axis position is instead
//    fully derived from the plotted rows' own dates (the earliest event
//    minus one day), the same "don't invent persisted transient state"
//    spirit as Calendar's own anchor-is-local-state ruling, taken one step
//    further since there is no transient state to hold at all. `Today`
//    scrolls the (real) DOM container to the current-date marker rather
//    than mutating any stored center.
//  - no "+ add row on click" the way Calendar's day cells offer — absent
//    from task-34-brief.md's "what to build" list (items 1-7), unlike
//    Calendar's task-33 brief which named it explicitly.
import { useEffect, useRef } from "react";
import type {
  DatabaseRow,
  DateValue,
  PropertyResponse,
  PropertyValue,
  RelatedRow,
} from "@/lib/database/types";
import { findSystemRelationProperty } from "@/lib/database/types";
import { useRowPeek } from "@/lib/database/useRowPeek";
import { renderCellValue } from "../cells/renderCellValue";
import { OpenNoteButton } from "../OpenNoteButton";
import { RowPeek } from "../RowPeek";

// ── Zoom levels (research §5.3's exact 8-value enumeration) ───────────────

export const ZOOM_LEVELS = [
  "hours",
  "day",
  "week",
  "bi_week",
  "month",
  "quarter",
  "year",
  "5_years",
] as const;

export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

const ZOOM_LABELS: Record<ZoomLevel, string> = {
  hours: "Hours",
  day: "Day",
  week: "Week",
  bi_week: "Bi-week",
  month: "Month",
  quarter: "Quarter",
  year: "Year",
  "5_years": "5 years",
};

/** Concrete pixels-per-day for each zoom level — hand-picked so all 8 are
 * functionally distinguishable, strictly decreasing from `hours` (most
 * zoomed in — a screen-width shows the least real time) to `5_years`
 * (most zoomed out — a screen-width shows the most real time). */
const PIXELS_PER_DAY: Record<ZoomLevel, number> = {
  hours: 960,
  day: 120,
  week: 40,
  bi_week: 20,
  month: 8,
  quarter: 3,
  year: 1,
  "5_years": 0.3,
};

export function pixelsPerDay(zoom: ZoomLevel): number {
  return PIXELS_PER_DAY[zoom];
}

export const MS_PER_DAY = 86_400_000;

// ── Bar geometry (pure) ─────────────────────────────────────────────────

export const MIN_BAR_WIDTH_PX = 4;

export interface BarGeometry {
  left: number;
  width: number;
  /** True when `date.end` is null — rendered as a point marker, not a bar. */
  isPoint: boolean;
}

/** Positions one row's `{start,end}` along the zoomed time axis, relative
 * to `originMs` — an arbitrary shared time-zero for the whole track (see
 * `computeOriginMs` below). Mirrors research §5.1: "a point marker if end
 * is null" — `isPoint` is what `TimelineBar` uses to render a dot instead
 * of a bar. */
export function computeBarGeometry(
  date: { start: string; end: string | null },
  zoom: ZoomLevel,
  originMs: number
): BarGeometry {
  const startMs = new Date(date.start).getTime();
  const pxPerDay = pixelsPerDay(zoom);
  const left = ((startMs - originMs) / MS_PER_DAY) * pxPerDay;
  if (!date.end) return { left, width: 0, isPoint: true };
  const endMs = new Date(date.end).getTime();
  const rawWidth = ((endMs - startMs) / MS_PER_DAY) * pxPerDay;
  return { left, width: Math.max(rawWidth, MIN_BAR_WIDTH_PX), isPoint: false };
}

/** The shared time-zero every bar/arrow/today-marker on one render is
 * positioned relative to: one day before the earliest plotted event's
 * start (or one day before "now" when nothing is plotted yet), so every
 * left-offset comes out non-negative. */
export function computeOriginMs(startTimestampsMs: number[]): number {
  if (startTimestampsMs.length === 0) return Date.now() - MS_PER_DAY;
  return Math.min(...startTimestampsMs) - MS_PER_DAY;
}

// ── Bar resize -> new DateValue (pure — the load-bearing interaction) ─────
// task-34-brief.md §4: this is the ONLY new date-math this task writes.
// Milestone 7's server-side cascade (`services/db/relations.py`'s
// `cascade_dependency_shift`) already computes every dependent row's new
// window once this resolved value reaches `onCellChange`/`updateCell` —
// reimplementing that here would double-shift dates.

/** A resize never collapses a bar to zero/negative length — one day is the
 * minimum surviving range after either handle moves. */
const MIN_RANGE_MS = MS_PER_DAY;

/** Shifts a raw ISO date/instant string by `deltaMs`, preserving whether it
 * was a bare date (`YYYY-MM-DD`) or a full instant — same technique as
 * CalendarView.tsx's `shiftIsoByDays`, generalized from whole days to an
 * arbitrary millisecond delta (a resize drag's pixel delta rarely lands on
 * an exact day boundary except at the coarsest zoom levels). */
function shiftIso(iso: string, deltaMs: number): string {
  const d = new Date(new Date(iso).getTime() + deltaMs);
  return iso.includes("T") ? d.toISOString() : d.toISOString().slice(0, 10);
}

/** Resolves a left/right edge drag of `deltaPx` pixels (at `zoom`'s
 * pixels-per-day) into the row's new `DateValue`. Only ranged bars (both
 * `start` and `end` present) are resizable — a point marker has no second
 * edge to drag, so this returns `undefined` for one. Also `undefined` for
 * a zero-pixel drag (a click that never moved) — the load-bearing "don't
 * fire a PATCH per pixel of drag, only on drop" contract lives one level up
 * (the caller only invokes this once, on `mouseup`), but a true no-op drag
 * still shouldn't produce a write. */
export function resolveBarResize(
  value: DateValue,
  edge: "start" | "end",
  deltaPx: number,
  zoom: ZoomLevel
): DateValue | undefined {
  if (!value.date || !value.date.start || !value.date.end) return undefined;
  if (deltaPx === 0) return undefined;
  const deltaMs = (deltaPx / pixelsPerDay(zoom)) * MS_PER_DAY;

  const startMs = new Date(value.date.start).getTime();
  const endMs = new Date(value.date.end).getTime();

  if (edge === "start") {
    const nextStartMs = Math.min(startMs + deltaMs, endMs - MIN_RANGE_MS);
    if (nextStartMs === startMs) return undefined;
    return {
      type: "date",
      date: {
        start: shiftIso(value.date.start, nextStartMs - startMs),
        end: value.date.end,
        time_zone: value.date.time_zone,
      },
    };
  }

  const nextEndMs = Math.max(endMs + deltaMs, startMs + MIN_RANGE_MS);
  if (nextEndMs === endMs) return undefined;
  return {
    type: "date",
    date: {
      start: value.date.start,
      end: shiftIso(value.date.end, nextEndMs - endMs),
      time_zone: value.date.time_zone,
    },
  };
}

// ── Dependency arrow endpoint geometry (pure) ──────────────────────────────

export interface ArrowEndpoints {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** From the end of a "blocking" row's bar to the start of its "blocked"
 * row's bar, both already positioned in track pixel-space — task-34-
 * brief.md §5. Vertically centred on each row's own `ROW_HEIGHT` band. */
export function computeArrowEndpoints(
  blockerGeometry: { left: number; width: number },
  blockerRowIndex: number,
  blockedGeometry: { left: number },
  blockedRowIndex: number,
  rowHeight: number
): ArrowEndpoints {
  return {
    x1: blockerGeometry.left + blockerGeometry.width,
    y1: blockerRowIndex * rowHeight + rowHeight / 2,
    x2: blockedGeometry.left,
    y2: blockedRowIndex * rowHeight + rowHeight / 2,
  };
}

// ── Row extraction ──────────────────────────────────────────────────────

export interface TimelineEvent {
  rowId: string;
  value: DateValue;
}

/** For every row with a non-null `DateValue.date.start` on
 * `datePropertyKey` — rows lacking it are omitted from the plotted area
 * entirely (research §5.1: "nothing will be plotted" is the documented
 * behaviour for a row missing the configured date, not a bug to fix). */
export function extractTimelineEvents(
  rows: DatabaseRow[],
  datePropertyKey: string | null
): TimelineEvent[] {
  if (!datePropertyKey) return [];
  const events: TimelineEvent[] = [];
  for (const row of rows) {
    const raw = row.properties[datePropertyKey] as DateValue | undefined;
    if (!raw || raw.type !== "date" || !raw.date || !raw.date.start) continue;
    events.push({ rowId: row.id, value: raw });
  }
  return events;
}

// ── Config reading ──────────────────────────────────────────────────────

function readDatePropertyId(config: Record<string, unknown>): string | null {
  return typeof config.date_property_id === "string" ? config.date_property_id : null;
}

function readZoomLevel(config: Record<string, unknown>): ZoomLevel {
  const pref = config.preference;
  const raw = pref && typeof pref === "object" ? (pref as Record<string, unknown>).zoom_level : undefined;
  return typeof raw === "string" && (ZOOM_LEVELS as readonly string[]).includes(raw)
    ? (raw as ZoomLevel)
    : "month";
}

function readArrowsBy(config: Record<string, unknown>): boolean {
  return config.arrows_by === true;
}

// ── Layout constants ────────────────────────────────────────────────────

const ROW_HEIGHT = 32;
const BAR_HEIGHT = 20;
const MARKER_SIZE = 10;
const TITLE_COL_WIDTH = 200;
const MIN_TRACK_WIDTH = 480;
const TRACK_END_PADDING = 80;

// ── Components ──────────────────────────────────────────────────────────

function TimelineBar({
  event,
  geometry,
  rowIndex,
  editable,
  datePropertyKey,
  zoomLevel,
  onCellChange,
  title,
}: {
  event: TimelineEvent;
  geometry: BarGeometry;
  rowIndex: number;
  editable: boolean;
  datePropertyKey: string;
  zoomLevel: ZoomLevel;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  title: string;
}) {
  // Commits on drop (mouseup) only — never continuously while dragging, so
  // this never fires a PATCH per pixel of drag (task-34-brief.md §4). No
  // read-only branch needed inside `startResize` itself: when `!editable`
  // the resize handles below simply aren't rendered at all, so there is no
  // listener to ever fire — the component test requirement ("read-only
  // never wires a working resize handler") is satisfied by omission, the
  // same technique CalendarView.tsx's drag handle uses via dnd-kit's
  // `disabled`.
  function startResize(edge: "start" | "end", downEvent: React.MouseEvent) {
    downEvent.preventDefault();
    downEvent.stopPropagation();
    const startClientX = downEvent.clientX;
    function onUp(upEvent: MouseEvent) {
      document.removeEventListener("mouseup", onUp);
      const deltaPx = upEvent.clientX - startClientX;
      const next = resolveBarResize(event.value, edge, deltaPx, zoomLevel);
      if (next) onCellChange(event.rowId, datePropertyKey, next);
    }
    document.addEventListener("mouseup", onUp);
  }

  return (
    <div
      data-testid={`timeline-bar-${event.rowId}`}
      style={{
        position: "absolute",
        top: rowIndex * ROW_HEIGHT + (ROW_HEIGHT - (geometry.isPoint ? MARKER_SIZE : BAR_HEIGHT)) / 2,
        left: geometry.left,
        width: geometry.isPoint ? MARKER_SIZE : geometry.width,
        height: geometry.isPoint ? MARKER_SIZE : BAR_HEIGHT,
      }}
      title={title}
      className={`${
        geometry.isPoint ? "rounded-full" : "rounded"
      } bg-indigo-400/80 dark:bg-indigo-600/70`}
    >
      {editable && !geometry.isPoint && (
        <>
          <div
            role="button"
            aria-label={`Resize start of ${title}`}
            onMouseDown={(e) => startResize("start", e)}
            className="absolute left-0 inset-y-0 w-1.5 cursor-ew-resize"
          />
          <div
            role="button"
            aria-label={`Resize end of ${title}`}
            onMouseDown={(e) => startResize("end", e)}
            className="absolute right-0 inset-y-0 w-1.5 cursor-ew-resize"
          />
        </>
      )}
    </div>
  );
}

export interface TimelineViewProps {
  properties: PropertyResponse[];
  rows: DatabaseRow[];
  editable: boolean;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  config: Record<string, unknown>;
  onConfigChange: (patch: Record<string, unknown>) => void;
  /** useDatabaseView's relation-links cache, keyed by
   * `${rowId}:${propertyKey}` — reused (not a new fetch path) to draw
   * dependency arrows, same convention as TableView's relation columns. */
  relationLinks?: Record<string, RelatedRow[]>;
  /** useDatabaseView's `ensureRelationLinksBulk` — the N+1-safe bulk warm
   * (task-31 Part 4). This is the ONLY relation-link fetch TimelineView
   * makes; there is no per-row fallback loop the way TableView keeps one
   * for callers that omit `ensureRelationLinksBulk`, since arrows are a
   * new feature with no pre-existing per-row fetch path to preserve. */
  ensureRelationLinksBulk?: (rowIds: string[], propertyKey: string) => void;
  dataSourceId?: string;
  /** RowPeek's own "+ Add a property" writes SCHEMA — needs a full
   * refetch (properties included), same convention as every other M12
   * view's own `refetch`. */
  refetch?: () => void | Promise<void>;
}

export function TimelineView({
  properties,
  rows,
  editable,
  onCellChange,
  config,
  onConfigChange,
  relationLinks,
  ensureRelationLinksBulk,
  dataSourceId,
  refetch,
}: TimelineViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // M12: `useRowPeek` — a card's Open button now respects the view's "Open
  // pages in" default the same way Table/List/Feed/Board/Gallery/Calendar
  // already do, instead of always hard-navigating.
  const { peekRowId, peekMode, openRow, closePeek } = useRowPeek(config);

  const datePropertyId = readDatePropertyId(config);
  const dateProperty = properties.find((p) => p.key === datePropertyId && p.type === "date");
  const zoomLevel = readZoomLevel(config);
  const arrowsBy = readArrowsBy(config);
  const dependencyForward = findSystemRelationProperty(properties, "dependency", "forward");
  const titleProp = properties.find((p) => p.type === "title");

  // view-tab-bar.md (M7 create-flow rewrite): Timeline now creates
  // immediately like every other type — ViewTabs.tsx only auto-selects an
  // existing date property, it no longer gates creation on picking one.
  // Mirrors CalendarView.tsx's identical picker: this placeholder is the
  // only place `date_property_id` can ever be set post-creation (no
  // settings-sidebar panel owns it, unlike Board's group-by).
  if (!datePropertyId || !dateProperty) {
    const dateProperties = properties.filter((p) => p.type === "date");
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-sm text-gray-400 dark:text-gray-500 text-center px-6">
        <p>no date property configured yet</p>
        {dateProperties.length === 0 ? (
          <p>add a Date property first</p>
        ) : (
          <select
            aria-label="Date property"
            defaultValue=""
            onChange={(e) => e.target.value && onConfigChange({ date_property_id: e.target.value })}
            className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            <option value="" disabled>
              Choose a date property…
            </option>
            {dateProperties.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
    );
  }
  const datePropertyKey: string = dateProperty.key;

  // fix-wave-1 finding 2: the dependency shift cascade (services/db/relations.py's
  // `cascade_dependency_shift`) only fires server-side when the dependency relation's
  // OWN `config.date_property_key` (set independently in DatabaseSettingsMenu.tsx) equals
  // the property actually being PATCHed. This Timeline's `config.date_property_id` has no
  // relationship to that setting, so a user can configure dependencies against one date
  // property and build a Timeline against another — resizing a bar here would then
  // silently do nothing extra, no cascade, no error. A cheap, non-blocking warning is all
  // that's called for here (not a redesign): the Timeline still renders and functions
  // normally either way.
  const dependencyDatePropertyKey =
    dependencyForward && typeof dependencyForward.config.date_property_key === "string"
      ? (dependencyForward.config.date_property_key as string)
      : null;
  const dependencyDateProperty = dependencyDatePropertyKey
    ? properties.find((p) => p.key === dependencyDatePropertyKey)
    : undefined;
  const dependencyDateMismatch =
    arrowsBy &&
    !!dependencyForward &&
    dependencyDatePropertyKey !== null &&
    dependencyDatePropertyKey !== datePropertyKey;

  const rowsById: Record<string, DatabaseRow> = {};
  for (const row of rows) rowsById[row.id] = row;

  const events = extractTimelineEvents(rows, datePropertyKey);
  const originMs = computeOriginMs(events.map((e) => new Date(e.value.date!.start).getTime()));

  const geometryByRowId: Record<string, BarGeometry> = {};
  for (const event of events) {
    geometryByRowId[event.rowId] = computeBarGeometry(event.value.date!, zoomLevel, originMs);
  }
  const rowIndexById: Record<string, number> = {};
  events.forEach((event, index) => {
    rowIndexById[event.rowId] = index;
  });

  const trackWidth = Math.max(
    MIN_TRACK_WIDTH,
    ...events.map((event) => {
      const g = geometryByRowId[event.rowId];
      return g.left + (g.isPoint ? MARKER_SIZE : g.width) + TRACK_END_PADDING;
    })
  );
  const trackHeight = Math.max(events.length * ROW_HEIGHT, ROW_HEIGHT);

  const plottedIds = new Set(events.map((e) => e.rowId));
  const dependencyPairs: { blockerId: string; blockedId: string }[] = [];
  if (arrowsBy && dependencyForward && relationLinks) {
    for (const blockerId of plottedIds) {
      const linked = relationLinks[`${blockerId}:${dependencyForward.key}`] ?? [];
      for (const link of linked) {
        if (link.id !== blockerId && plottedIds.has(link.id)) {
          dependencyPairs.push({ blockerId, blockedId: link.id });
        }
      }
    }
  }

  // Warms the dependency-relation link cache for every currently-plotted
  // row in one bulk request (task-34-brief.md: "reuse ensureRelationLinksBulk
  // ... do not add a third fetch path"). Only runs when arrows are actually
  // requested and a dependency pair exists — no reason to fetch link data
  // that would never be drawn.
  const plottedRowIdsKey = events.map((e) => e.rowId).join("|");
  useEffect(() => {
    if (!arrowsBy || !dependencyForward || !ensureRelationLinksBulk) return;
    const rowIds = plottedRowIdsKey ? plottedRowIdsKey.split("|") : [];
    if (rowIds.length === 0) return;
    ensureRelationLinksBulk(rowIds, dependencyForward.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrowsBy, dependencyForward?.key, plottedRowIdsKey]);

  function handleZoomChange(next: string) {
    if (!(ZOOM_LEVELS as readonly string[]).includes(next)) return;
    const preference =
      config.preference && typeof config.preference === "object"
        ? (config.preference as Record<string, unknown>)
        : {};
    onConfigChange({ preference: { ...preference, zoom_level: next } });
  }

  function handleToday() {
    const el = scrollRef.current;
    if (!el) return;
    const todayX = ((Date.now() - originMs) / MS_PER_DAY) * pixelsPerDay(zoomLevel);
    el.scrollLeft = Math.max(todayX - el.clientWidth / 2, 0);
  }

  const todayX = ((Date.now() - originMs) / MS_PER_DAY) * pixelsPerDay(zoomLevel);

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 flex items-center gap-3 flex-wrap border-b border-gray-100 dark:border-gray-800 shrink-0 text-xs text-gray-500 dark:text-gray-400">
        <label className="flex items-center gap-1.5">
          Zoom
          <select
            aria-label="Zoom level"
            value={zoomLevel}
            onChange={(e) => handleZoomChange(e.target.value)}
            className="px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            {ZOOM_LEVELS.map((z) => (
              <option key={z} value={z}>
                {ZOOM_LABELS[z]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          aria-label="Today"
          onClick={handleToday}
          className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          Today
        </button>
        <label
          className="flex items-center gap-1.5 ml-auto"
          title={!dependencyForward ? "Turn on dependencies in Database settings first" : undefined}
        >
          <input
            type="checkbox"
            aria-label="Show dependency arrows"
            checked={arrowsBy}
            disabled={!dependencyForward}
            onChange={(e) => onConfigChange({ arrows_by: e.target.checked })}
          />
          Dependency arrows
        </label>
        {!dependencyForward && (
          <span className="text-[10px] text-gray-400 dark:text-gray-500">
            Turn on dependencies in Database settings first
          </span>
        )}
        {dependencyDateMismatch && (
          <span
            role="status"
            data-testid="timeline-dependency-date-mismatch-warning"
            className="basis-full text-[10px] text-amber-600 dark:text-amber-400"
          >
            Dependency shifting uses a different date property (
            {dependencyDateProperty?.name ?? dependencyDatePropertyKey}) than this Timeline.
            Resizing bars here won&apos;t trigger automatic shifting.
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex">
          <div
            className="shrink-0 border-r border-gray-100 dark:border-gray-800"
            style={{ width: TITLE_COL_WIDTH }}
          >
            {events.map((event) => {
              const row = rowsById[event.rowId];
              if (!row) return null;
              return (
                <div
                  key={event.rowId}
                  style={{ height: ROW_HEIGHT }}
                  className="flex items-center gap-1 px-2 text-xs"
                >
                  <OpenNoteButton
                    noteId={event.rowId}
                    className="!p-0.5 shrink-0 scale-75"
                    onOpen={openRow}
                    isOpen={peekRowId === event.rowId}
                  />
                  <span className="truncate min-w-0 flex-1">
                    {titleProp ? (
                      renderCellValue(titleProp, row.properties[titleProp.key], editable, (value) =>
                        onCellChange(event.rowId, titleProp.key, value)
                      )
                    ) : (
                      <span className="text-gray-400">Untitled</span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          <div
            ref={scrollRef}
            data-testid="timeline-track"
            className="flex-1 overflow-x-auto relative"
            style={{ height: trackHeight }}
          >
            <div style={{ position: "relative", width: trackWidth, height: trackHeight }}>
              <div
                data-testid="timeline-today-marker"
                style={{ position: "absolute", left: todayX, top: 0, bottom: 0, width: 1 }}
                className="bg-red-400/60"
              />
              {dependencyPairs.length > 0 && (
                <svg
                  data-testid="timeline-arrows"
                  className="absolute inset-0 pointer-events-none"
                  width={trackWidth}
                  height={trackHeight}
                >
                  <defs>
                    <marker
                      id="timeline-arrowhead"
                      markerWidth="8"
                      markerHeight="8"
                      refX="6"
                      refY="3"
                      orient="auto"
                    >
                      <path d="M0,0 L6,3 L0,6 Z" className="fill-indigo-400" />
                    </marker>
                  </defs>
                  {dependencyPairs.map(({ blockerId, blockedId }) => {
                    const endpoints = computeArrowEndpoints(
                      geometryByRowId[blockerId],
                      rowIndexById[blockerId],
                      geometryByRowId[blockedId],
                      rowIndexById[blockedId],
                      ROW_HEIGHT
                    );
                    return (
                      <line
                        key={`${blockerId}->${blockedId}`}
                        data-testid={`timeline-arrow-${blockerId}-${blockedId}`}
                        x1={endpoints.x1}
                        y1={endpoints.y1}
                        x2={endpoints.x2}
                        y2={endpoints.y2}
                        markerEnd="url(#timeline-arrowhead)"
                        className="stroke-indigo-400"
                        strokeWidth={1.5}
                      />
                    );
                  })}
                </svg>
              )}
              {events.map((event) => {
                const geometry = geometryByRowId[event.rowId];
                const row = rowsById[event.rowId];
                const title =
                  titleProp && row
                    ? String((row.properties[titleProp.key] as { title?: string })?.title ?? "Untitled")
                    : "Untitled";
                return (
                  <TimelineBar
                    key={event.rowId}
                    event={event}
                    geometry={geometry}
                    rowIndex={rowIndexById[event.rowId]}
                    editable={editable}
                    datePropertyKey={datePropertyKey}
                    zoomLevel={zoomLevel}
                    onCellChange={onCellChange}
                    title={title}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {peekRowId && rowsById[peekRowId] && (
        <RowPeek
          row={rowsById[peekRowId]}
          properties={properties}
          editable={editable}
          onCellChange={onCellChange}
          onClose={closePeek}
          mode={peekMode === "center" ? "center" : "side"}
          dataSourceId={dataSourceId}
          onPropertyCreated={refetch}
        />
      )}
    </div>
  );
}
