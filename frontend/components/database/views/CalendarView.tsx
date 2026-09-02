"use client";

// Month/week calendar view (Milestone 9, task-33). Follows the same shape
// as every other M6 view (Board/Gallery/List/Feed): consumes `rows` from
// `useDatabaseView` (no grouping — task-33-brief.md's reference facts, the
// hook needs no change for this task), renders through the shared
// `renderCellValue` dispatcher (never a second cell renderer), and mirrors
// BoardView.tsx's drag-and-drop shape exactly: `DndContext`/`PointerSensor`
// from `@dnd-kit/core`, `useDraggable`/`useDroppable` (an event moves
// *between* day-cell drop targets, the same shape as a card moving between
// Board columns — not a reorder-within-one-list shape), and a pure
// drag-resolution function (`resolveDropDate`) kept separate from the
// `onDragEnd` handler so the trickiest logic (preserving time-of-day and
// range length across a day-cell drop) is directly unit-testable without
// simulating dnd-kit pointer events, exactly like BoardView's
// `resolveDropValue`/`computeDragEndWrite` split.
//
// Config: `config.date_property_id` (required, set at view-creation time —
// see ViewTabs.tsx/DatabaseShell.tsx's Board-mirroring special case),
// `config.view_range: "week" | "month"` (default "month"),
// `config.show_weekends: boolean` (default true).
//
// Monday-first weeks (matches `services/db/query/grouping.py`'s
// `_week_start`/`GroupBySpec.start_day_of_week` default of 1=Monday — this
// app has no per-user locale/timezone concept anywhere, M3's already-
// recorded UTC-only ruling, so every date computation here works in UTC via
// `Date#getUTC*`/`setUTCDate`, never local-timezone-sensitive getters).
//
// Scope cuts, decided in task-33-brief.md (not gaps, deliberate rulings):
//  - no resize interaction (dragging an event's edge to grow/shrink its
//    range) — Timeline's separate task owns that.
//  - plain bidirectional prev/next navigation, not research's documented
//    infinite-scroll-forward-only behaviour.
//  - visible-range (the "anchor" below) is local component state, never
//    persisted to the view's `config`.
//  - at most 3 event bars per day cell, "+N more" with no click-to-expand.
//  - multi-day spanning is a simplified single-bar-per-week-row (the
//    standard month-calendar technique), not cross-week continuous bars.
//    Lane assignment (`layoutWeekRow` below) is a simple deterministic rule
//    (sort by start day then row id, assign lanes in that fixed order, no
//    lane reuse) rather than a tight interval-scheduling/overlap-packing
//    algorithm — task-33-brief.md explicitly asks for "a simple
//    deterministic rule", not full packing.
import { useState } from "react";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useToast } from "@/app/providers";
import type { DatabaseRow, DateValue, PropertyResponse, PropertyValue } from "@/lib/database/types";
import { useRowPeek } from "@/lib/database/useRowPeek";
import { renderCellValue } from "../cells/renderCellValue";
import { OpenNoteButton } from "../OpenNoteButton";
import { RowPeek } from "../RowPeek";

/** Matches TableView.tsx's own local copy — FastAPI's HTTPException body is
 * `{"detail": "..."}`, this app's proxy error shapes are `{"error": "..."}`. */
async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

// ── Pure date utilities (UTC-only, no per-user timezone concept) ──────────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Extracts the UTC calendar-day key (`YYYY-MM-DD`) from any ISO8601
 * instant or date-only string. */
export function toDayKey(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

/** `dayKey` shifted by `delta` UTC calendar days (negative moves back). */
export function addDays(dayKey: string, delta: number): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Whole UTC calendar days from `fromDayKey` to `toDayKeyArg` (positive if `to` is later). */
export function dayDiff(fromDayKey: string, toDayKeyArg: string): number {
  const a = new Date(`${fromDayKey}T00:00:00.000Z`).getTime();
  const b = new Date(`${toDayKeyArg}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** The Monday on or before `dayKey` (Monday-first week convention). */
function mondayOf(dayKey: string): string {
  const weekday = new Date(`${dayKey}T00:00:00.000Z`).getUTCDay(); // 0=Sun..6=Sat
  const offsetFromMonday = (weekday + 6) % 7;
  return addDays(dayKey, -offsetFromMonday);
}

/** Shifts a raw ISO date/instant string by `deltaDays`, preserving whether
 * it was a bare date (`YYYY-MM-DD`) or a full instant (keeps its
 * time-of-day) — `resolveDropDate` below relies on this to satisfy
 * task-33-brief.md §4's "preserving the same start time-of-day". */
function shiftIsoByDays(iso: string, deltaDays: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return iso.includes("T") ? d.toISOString() : d.toISOString().slice(0, 10);
}

export type ViewRange = "week" | "month";

/** One cell in the rendered grid. `inCurrentMonth=false` marks a leading/
 * trailing day from an adjacent month (month view only; always `true` in
 * week view) — dimmed and not clickable-for-create, but still a valid drop
 * target (task-33-brief.md §2). */
export interface CalendarGridDay {
  dayKey: string;
  inCurrentMonth: boolean;
}

function buildWeekDays(weekStartDayKey: string, showWeekends: boolean): string[] {
  const count = showWeekends ? 7 : 5;
  return Array.from({ length: count }, (_, i) => addDays(weekStartDayKey, i));
}

/** Month view: a 5-or-6-row grid covering the visible month (Monday-first),
 * with leading/trailing days from adjacent months included and marked
 * `inCurrentMonth: false`. */
export function buildMonthGrid(anchorDayKey: string, showWeekends: boolean): CalendarGridDay[][] {
  const [yearStr, monthStr] = anchorDayKey.split("-");
  const monthPrefix = `${yearStr}-${monthStr}`;
  const firstOfMonth = `${monthPrefix}-01`;
  const gridStart = mondayOf(firstOfMonth);

  const year = Number(yearStr);
  const month = Number(monthStr); // 1-based
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastOfMonth = `${monthPrefix}-${pad2(daysInMonth)}`;
  const lastWeekStart = mondayOf(lastOfMonth);

  const weeks: CalendarGridDay[][] = [];
  let weekStart = gridStart;
  // Bounded by construction (a month is never more than 6 Monday-starts
  // wide), but capped defensively so a date-math mistake can't loop forever.
  for (let guard = 0; guard < 8; guard++) {
    weeks.push(
      buildWeekDays(weekStart, showWeekends).map((dayKey) => ({
        dayKey,
        inCurrentMonth: dayKey.startsWith(monthPrefix),
      }))
    );
    if (weekStart === lastWeekStart) break;
    weekStart = addDays(weekStart, 7);
  }
  return weeks;
}

/** Week view: one row, Monday-first, 7 (or 5 with weekends hidden) columns —
 * every day `inCurrentMonth: true` (there's no "adjacent month" concept in
 * week view). */
export function buildWeekGrid(anchorDayKey: string, showWeekends: boolean): CalendarGridDay[][] {
  const weekStart = mondayOf(anchorDayKey);
  return [buildWeekDays(weekStart, showWeekends).map((dayKey) => ({ dayKey, inCurrentMonth: true }))];
}

export function buildCalendarGrid(
  anchorDayKey: string,
  viewRange: ViewRange,
  showWeekends: boolean
): CalendarGridDay[][] {
  return viewRange === "week"
    ? buildWeekGrid(anchorDayKey, showWeekends)
    : buildMonthGrid(anchorDayKey, showWeekends);
}

/** Moves the visible-range anchor one step forward/back — a week at a time
 * in week view, a whole month (normalized to day 1) in month view. */
export function shiftAnchor(anchorDayKey: string, viewRange: ViewRange, direction: 1 | -1): string {
  if (viewRange === "week") return addDays(anchorDayKey, 7 * direction);
  const [yearStr, monthStr] = anchorDayKey.split("-");
  const d = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1 + direction, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`;
}

// ── Events: extraction, multi-day-span-to-week-row layout ─────────────────

export interface CalendarEvent {
  rowId: string;
  startDayKey: string;
  endDayKey: string;
}

/** For every row with a non-null `DateValue` on `datePropertyKey`, the
 * day(s) it falls on. `date.end` (when set and later than `date.start`)
 * makes a multi-day event; an `end` before `start` is clamped to a
 * single-day event rather than treated as backwards. */
export function extractCalendarEvents(rows: DatabaseRow[], datePropertyKey: string | null): CalendarEvent[] {
  if (!datePropertyKey) return [];
  const events: CalendarEvent[] = [];
  for (const row of rows) {
    const value = row.properties[datePropertyKey] as DateValue | undefined;
    if (!value || value.type !== "date" || !value.date || !value.date.start) continue;
    const startDayKey = toDayKey(value.date.start);
    const rawEndDayKey = value.date.end ? toDayKey(value.date.end) : startDayKey;
    const endDayKey = rawEndDayKey < startDayKey ? startDayKey : rawEndDayKey;
    events.push({ rowId: row.id, startDayKey, endDayKey });
  }
  return events;
}

export const MAX_EVENTS_PER_DAY = 3;

export interface WeekRowSpan {
  rowId: string;
  /** 0-based column index within the week's day array. */
  startCol: number;
  colSpan: number;
  /** 0-based visual lane (row) within the week; always `< MAX_EVENTS_PER_DAY`. */
  lane: number;
}

export interface WeekRowLayout {
  /** The bars to render — at most `MAX_EVENTS_PER_DAY` per lane conflict. */
  spans: WeekRowSpan[];
  /** One entry per column: how many *additional* (unrendered) events touch
   * that day, for a "+N more" label. `0` means no overflow that day. */
  overflowByCol: number[];
}

/** Resolves one week row's events into renderable spans, clipped to that
 * row's day range — the "standard single-row-per-week bar" month-calendar
 * technique task-33-brief.md §3 asks for. Deterministic lane assignment:
 * events intersecting this row are sorted by `(startDayKey, rowId)` (the
 * brief's own tie-break rule) and assigned lanes in that fixed order, first
 * `MAX_EVENTS_PER_DAY` become bars, the rest count toward every day column
 * they touch's overflow — a simple deterministic rule, not interval-
 * scheduling/overlap-lane packing (explicitly out of scope). */
export function layoutWeekRow(weekDayKeys: string[], events: CalendarEvent[]): WeekRowLayout {
  const weekStart = weekDayKeys[0];
  const weekEnd = weekDayKeys[weekDayKeys.length - 1];

  const intersecting = events
    .filter((ev) => ev.endDayKey >= weekStart && ev.startDayKey <= weekEnd)
    .map((ev) => ({
      ...ev,
      clippedStart: ev.startDayKey < weekStart ? weekStart : ev.startDayKey,
      clippedEnd: ev.endDayKey > weekEnd ? weekEnd : ev.endDayKey,
    }))
    .sort((a, b) => a.startDayKey.localeCompare(b.startDayKey) || a.rowId.localeCompare(b.rowId));

  const overflowByCol = weekDayKeys.map(() => 0);
  const spans: WeekRowSpan[] = [];

  intersecting.forEach((ev, lane) => {
    const startCol = weekDayKeys.indexOf(ev.clippedStart);
    const endCol = weekDayKeys.indexOf(ev.clippedEnd);
    // Only possible if the clipped span landed on a hidden weekend column
    // (show_weekends=false) with no visible day left in this row for it.
    if (startCol === -1 || endCol === -1) return;

    if (lane < MAX_EVENTS_PER_DAY) {
      spans.push({ rowId: ev.rowId, startCol, colSpan: endCol - startCol + 1, lane });
    } else {
      for (let col = startCol; col <= endCol; col++) overflowByCol[col] += 1;
    }
  });

  return { spans, overflowByCol };
}

// ── Drag-to-reschedule: pure resolution, separate from dnd-kit wiring ─────

const DAY_DROPPABLE_PREFIX = "day:";

/** The dnd-kit draggable id for one event-bar *instance*. A row whose event
 * spans more than one week is rendered as more than one bar (one per week
 * row it touches, see `layoutWeekRow`) — `weekStartDayKey` disambiguates
 * those instances the same way BoardView's `cardDraggableId` disambiguates
 * a multi_select card's per-column instances. */
export function calendarEventDraggableId(weekStartDayKey: string, rowId: string): string {
  return `event:${weekStartDayKey}:${rowId}`;
}

/** Pure drag-drop resolution (task-33-brief.md §4/§52's drag-and-drop
 * precedent — mirrors BoardView's `resolveDropValue`). Computes the new
 * `DateValue` for dropping an event currently at `value` onto
 * `targetDayKey`: shifts `date.start` to that day, preserving its
 * time-of-day, and — for a ranged event — shifts `date.end` by the
 * identical day delta so the range length is unchanged. Returns `undefined`
 * for a no-op (dropped back on the day it already occupies, or a value with
 * no date to move). */
export function resolveDropDate(value: DateValue, targetDayKey: string): DateValue | undefined {
  if (!value.date || !value.date.start) return undefined;
  const sourceDayKey = toDayKey(value.date.start);
  if (sourceDayKey === targetDayKey) return undefined;

  const delta = dayDiff(sourceDayKey, targetDayKey);
  return {
    type: "date",
    date: {
      start: shiftIsoByDays(value.date.start, delta),
      end: value.date.end ? shiftIsoByDays(value.date.end, delta) : null,
      time_zone: value.date.time_zone,
    },
  };
}

/** Structural subset of dnd-kit's real `DragEndEvent` — same reasoning and
 * shape as BoardView.tsx's `DragEndEventLike`. */
interface DragEndEventLike {
  over: { id: string | number } | null;
  active: { data: { current?: Record<string, unknown> } };
}

/** The "wiring" between a real dnd-kit drag-end event and `resolveDropDate`
 * above — mirrors BoardView's `computeDragEndWrite` exactly: parses the
 * `day:` droppable-id prefix, reads `active.data.current`, looks up the
 * dragged row's current date value, and returns the write to make (or
 * `undefined` for every no-op case). Exported and unit-tested directly
 * against a hand-built event-shaped object, same as Board's. */
export function computeCalendarDragEndWrite(
  event: DragEndEventLike,
  rows: DatabaseRow[],
  datePropertyKey: string | null
): { rowId: string; value: DateValue } | undefined {
  const { active, over } = event;
  if (!over || !datePropertyKey) return undefined;
  const overId = String(over.id);
  if (!overId.startsWith(DAY_DROPPABLE_PREFIX)) return undefined;
  const targetDayKey = overId.slice(DAY_DROPPABLE_PREFIX.length);

  const data = active.data.current as { rowId?: string } | undefined;
  if (!data?.rowId) return undefined;

  const row = rows.find((r) => r.id === data.rowId);
  const value = row?.properties[datePropertyKey] as DateValue | undefined;
  if (!value || value.type !== "date") return undefined;

  const nextValue = resolveDropDate(value, targetDayKey);
  if (!nextValue) return undefined;
  return { rowId: data.rowId, value: nextValue };
}

// ── Config reading ──────────────────────────────────────────────────────

function readDatePropertyId(config: Record<string, unknown>): string | null {
  return typeof config.date_property_id === "string" ? config.date_property_id : null;
}

function readViewRange(config: Record<string, unknown>): ViewRange {
  return config.view_range === "week" ? "week" : "month";
}

function readShowWeekends(config: Record<string, unknown>): boolean {
  return config.show_weekends !== false;
}

function formatShortDate(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatRangeLabel(anchorDayKey: string, viewRange: ViewRange): string {
  if (viewRange === "week") {
    const start = mondayOf(anchorDayKey);
    const end = addDays(start, 6);
    return `${formatShortDate(start)} – ${formatShortDate(end)}`;
  }
  const [yearStr, monthStr] = anchorDayKey.split("-");
  return new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// ── Components ──────────────────────────────────────────────────────────

function CalendarDayCell({
  day,
  col,
  isEmpty,
  editable,
  onCreate,
}: {
  day: CalendarGridDay;
  col: number;
  isEmpty: boolean;
  editable: boolean;
  onCreate: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${DAY_DROPPABLE_PREFIX}${day.dayKey}` });
  const dayNumber = Number(day.dayKey.slice(8, 10));

  return (
    <div
      ref={setNodeRef}
      data-testid={`calendar-day-${day.dayKey}`}
      style={{ gridColumn: col + 1, gridRow: `1 / span ${MAX_EVENTS_PER_DAY + 2}` }}
      className={`relative group/day border-r border-b border-gray-100 dark:border-gray-800 p-1 min-h-[80px] ${
        day.inCurrentMonth ? "" : "opacity-40"
      } ${isOver ? "ring-2 ring-indigo-400 ring-inset" : ""}`}
    >
      <div className="text-[11px] text-gray-400">{dayNumber}</div>
      {editable && day.inCurrentMonth && isEmpty && (
        <button
          type="button"
          aria-label={`Add row on ${day.dayKey}`}
          onClick={onCreate}
          className="absolute top-1 right-1 opacity-0 group-hover/day:opacity-100 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xs font-medium leading-none"
        >
          +
        </button>
      )}
    </div>
  );
}

function CalendarEventBar({
  row,
  properties,
  editable,
  onCellChange,
  weekStartDayKey,
  style,
  onOpenRow,
  isPeekOpen,
}: {
  row: DatabaseRow;
  properties: PropertyResponse[];
  editable: boolean;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  weekStartDayKey: string;
  style: React.CSSProperties;
  /** M12: `useRowPeek`'s own `openRow`/`peekRowId`, threaded down instead
   * of a bare `useOpenNote` navigation. */
  onOpenRow?: (noteId: string) => void;
  isPeekOpen?: boolean;
}) {
  // Disabled (not just unwired) when read-only — task-33-brief.md's test
  // requirement: "a read-only (All Notes) render never wires a working drag
  // handler". `listeners` is only spread onto the DOM when `editable`,
  // belt-and-suspenders with `disabled` itself.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: calendarEventDraggableId(weekStartDayKey, row.id),
    data: { rowId: row.id },
    disabled: !editable,
  });

  const titleProp = properties.find((p) => p.type === "title");

  return (
    <div
      ref={setNodeRef}
      data-testid={`calendar-event-${row.id}`}
      style={style}
      {...attributes}
      {...(editable ? listeners : {})}
      className={`relative flex items-center gap-0.5 mx-0.5 my-0.5 px-1 rounded text-[11px] overflow-hidden bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-200 ${
        editable ? "cursor-grab active:cursor-grabbing touch-none" : ""
      } ${isDragging ? "opacity-40" : ""}`}
    >
      <OpenNoteButton
        noteId={row.id}
        className="!p-0.5 shrink-0 scale-75"
        onOpen={onOpenRow}
        isOpen={onOpenRow ? isPeekOpen : undefined}
      />
      <span className="truncate min-w-0 flex-1">
        {titleProp ? (
          renderCellValue(titleProp, row.properties[titleProp.key], editable, (value) =>
            onCellChange(row.id, titleProp.key, value)
          )
        ) : (
          <span className="text-gray-400">Untitled</span>
        )}
      </span>
    </div>
  );
}

function CalendarWeekRow({
  weekDays,
  events,
  properties,
  rowsById,
  editable,
  onCellChange,
  onCreateOnDay,
  onOpenRow,
  peekRowId,
}: {
  weekDays: CalendarGridDay[];
  events: CalendarEvent[];
  properties: PropertyResponse[];
  rowsById: Record<string, DatabaseRow>;
  editable: boolean;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  onCreateOnDay: (dayKey: string) => void;
  onOpenRow?: (noteId: string) => void;
  peekRowId?: string | null;
}) {
  const weekDayKeys = weekDays.map((d) => d.dayKey);
  const { spans, overflowByCol } = layoutWeekRow(weekDayKeys, events);
  const weekStartDayKey = weekDayKeys[0];

  const colHasEvents = weekDayKeys.map((_, col) => {
    const spanHit = spans.some((s) => col >= s.startCol && col < s.startCol + s.colSpan);
    return spanHit || overflowByCol[col] > 0;
  });

  return (
    <div
      className="grid"
      style={{
        gridTemplateColumns: `repeat(${weekDayKeys.length}, 1fr)`,
        gridTemplateRows: `auto repeat(${MAX_EVENTS_PER_DAY}, auto) auto`,
      }}
    >
      {weekDays.map((day, col) => (
        <CalendarDayCell
          key={day.dayKey}
          day={day}
          col={col}
          isEmpty={!colHasEvents[col]}
          editable={editable}
          onCreate={() => onCreateOnDay(day.dayKey)}
        />
      ))}
      {spans.map((span) => {
        const row = rowsById[span.rowId];
        if (!row) return null;
        return (
          <CalendarEventBar
            key={calendarEventDraggableId(weekStartDayKey, span.rowId)}
            row={row}
            properties={properties}
            editable={editable}
            onCellChange={onCellChange}
            weekStartDayKey={weekStartDayKey}
            style={{ gridColumn: `${span.startCol + 1} / span ${span.colSpan}`, gridRow: span.lane + 2 }}
            onOpenRow={onOpenRow}
            isPeekOpen={peekRowId === span.rowId}
          />
        );
      })}
      {overflowByCol.map((count, col) =>
        count > 0 ? (
          <div
            key={`overflow-${weekStartDayKey}-${col}`}
            style={{ gridColumn: col + 1, gridRow: MAX_EVENTS_PER_DAY + 2 }}
            className="text-[10px] text-gray-400 px-1 leading-tight"
          >
            +{count} more
          </div>
        ) : null
      )}
    </div>
  );
}

export interface CalendarViewProps {
  properties: PropertyResponse[];
  rows: DatabaseRow[];
  editable: boolean;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  config: Record<string, unknown>;
  onConfigChange: (patch: Record<string, unknown>) => void;
  /** Backing data source id for the "+ on a day" create-row POST — same
   * optionality reasoning as TableView's own `dataSourceId`: only needed
   * when `editable` (All Notes never renders the create control). */
  dataSourceId?: string;
  /** useDatabaseView's `loadRows` — called after creating a row on a day so
   * it appears without a full reload, same contract as TableView's
   * `refetchRows`. */
  refetchRows?: () => void | Promise<void>;
  /** RowPeek's own "+ Add a property" writes SCHEMA — needs a full refetch
   * (properties included), not just `refetchRows`. Threaded through
   * exactly like TableView's own `refetch`. */
  refetch?: () => void | Promise<void>;
}

export function CalendarView({
  properties,
  rows,
  editable,
  onCellChange,
  config,
  onConfigChange,
  dataSourceId,
  refetchRows,
  refetch,
}: CalendarViewProps) {
  const { showToast } = useToast();
  const [anchorDayKey, setAnchorDayKey] = useState(() => toDayKey(new Date().toISOString()));
  const [rowCreating, setRowCreating] = useState(false);
  // M12: called unconditionally, before the "no date property" early return
  // below (hooks can't follow a conditional return).
  const { peekRowId, peekMode, openRow, closePeek } = useRowPeek(config);

  const datePropertyId = readDatePropertyId(config);
  const viewRange = readViewRange(config);
  const showWeekends = readShowWeekends(config);
  const dateProperty = properties.find((p) => p.key === datePropertyId && p.type === "date");

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // view-tab-bar.md (M7 create-flow rewrite): a Calendar view now creates
  // immediately like every other type — ViewTabs.tsx no longer gates
  // creation on picking a date property first, it only auto-selects one if
  // exactly the property already exists. When none does (or one gets
  // deleted later, or a hand-edited config), this is the ONLY place
  // `date_property_id` can ever be set — there is no settings-sidebar panel
  // for it (unlike Board's group-by, which M6's Group panel already owns) —
  // so the placeholder must offer a real picker, not just explain the gap.
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
  // Re-bind to a fresh const: same reasoning as BoardView.tsx's
  // `resolvedGroupPropertyKey` — TS's narrowing from the early return above
  // doesn't carry into the `handleDragEnd`/`handleCreateOnDay` closures below.
  const datePropertyKey: string = dateProperty.key;

  const grid = buildCalendarGrid(anchorDayKey, viewRange, showWeekends);
  const events = extractCalendarEvents(rows, datePropertyKey);
  const rowsById: Record<string, DatabaseRow> = {};
  for (const row of rows) rowsById[row.id] = row;

  async function handleCreateOnDay(dayKey: string) {
    if (!dataSourceId || rowCreating) return;
    setRowCreating(true);
    try {
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/rows`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      const created: { id: string } = await res.json();
      // Refetch first so the new row is present in `rows` before the
      // date-setting write below — `onCellChange`'s optimistic update only
      // finds/updates a row that's already in local state (see
      // useDatabaseView.ts's updateCell), same ordering TableView's own
      // "+ New row" relies on for the row to show up at all.
      await refetchRows?.();
      onCellChange(created.id, datePropertyKey, { type: "date", date: { start: dayKey, end: null, time_zone: null } });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not add row", "error");
    } finally {
      setRowCreating(false);
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const result = computeCalendarDragEndWrite(event, rows, datePropertyKey);
    if (!result) return;
    onCellChange(result.rowId, datePropertyKey, result.value);
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-3 py-2 flex items-center gap-3 flex-wrap border-b border-gray-100 dark:border-gray-800 shrink-0 text-xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous"
            onClick={() => setAnchorDayKey((k) => shiftAnchor(k, viewRange, -1))}
            className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            ‹
          </button>
          <button
            type="button"
            aria-label="Today"
            onClick={() => setAnchorDayKey(toDayKey(new Date().toISOString()))}
            className="px-2 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            Today
          </button>
          <button
            type="button"
            aria-label="Next"
            onClick={() => setAnchorDayKey((k) => shiftAnchor(k, viewRange, 1))}
            className="px-1.5 py-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            ›
          </button>
        </div>
        <span className="font-medium text-gray-700 dark:text-gray-300">
          {formatRangeLabel(anchorDayKey, viewRange)}
        </span>
        <label className="flex items-center gap-1.5 ml-auto">
          View
          <select
            aria-label="View range"
            value={viewRange}
            onChange={(e) => onConfigChange({ view_range: e.target.value })}
            className="px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          >
            <option value="month">Month</option>
            <option value="week">Week</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showWeekends}
            onChange={(e) => onConfigChange({ show_weekends: e.target.checked })}
          />
          Show weekends
        </label>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">
          {grid.map((weekDays) => (
            <CalendarWeekRow
              key={weekDays[0].dayKey}
              weekDays={weekDays}
              events={events}
              properties={properties}
              rowsById={rowsById}
              editable={editable}
              onCellChange={onCellChange}
              onCreateOnDay={handleCreateOnDay}
              onOpenRow={openRow}
              peekRowId={peekRowId}
            />
          ))}
        </div>
      </DndContext>

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
