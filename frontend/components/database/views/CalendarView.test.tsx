import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// CalendarEventBar renders an OpenNoteButton (same as BoardCard/GalleryCard),
// which navigates via next/navigation's useRouter — outside a real Next.js
// app router tree (as here, a plain RTL render) that throws "invariant
// expected app router to be mounted" unless mocked, same as
// BoardView.test.tsx does. M12: CalendarView also reads/writes the row
// peek's `?p=&pm=` via `useRowPeek` now — mocked the same way.
const push = vi.fn();
const routerReplace = vi.fn();
let mockSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: routerReplace }),
  usePathname: () => "/brain/db/ds-1",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// RowPeek mounts a real BlockEditor — heavy (BlockNote), stubbed the same
// way TableView.test.tsx/ListView.test.tsx already do.
vi.mock("@/components/editor/BlockEditor", () => ({
  BlockEditor: () => <div data-testid="block-editor-stub" />,
}));

import {
  CalendarView,
  buildMonthGrid,
  buildWeekGrid,
  calendarEventDraggableId,
  computeCalendarDragEndWrite,
  layoutWeekRow,
  resolveDropDate,
} from "./CalendarView";
import type { DatabaseRow, DateValue, PropertyResponse } from "@/lib/database/types";

beforeEach(() => {
  mockSearch = "";
  push.mockClear();
  routerReplace.mockClear();
});

function prop(overrides: Partial<PropertyResponse>): PropertyResponse {
  return {
    id: overrides.key ?? "id",
    data_source_id: "ds-1",
    user_id: "user-1",
    key: "key",
    name: "Name",
    type: "rich_text",
    config: {},
    description: null,
    storage: "jsonb",
    column_name: null,
    result_type: null,
    is_volatile: false,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const TITLE_PROP = prop({ key: "title", name: "Title", type: "title", position: 0 });
const DUE_PROP = prop({ key: "due", name: "Due", type: "date", position: 1 });

function row(id: string, title: string, dateValue?: DateValue["date"]): DatabaseRow {
  return {
    id,
    properties: {
      title: { type: "title", title },
      ...(dateValue !== undefined ? { due: { type: "date", date: dateValue } } : {}),
    },
  };
}

// ── Pure-function tests (no DOM/dnd-kit simulation needed) ────────────────

describe("buildMonthGrid (Monday-first day-in-month grid generator)", () => {
  // August 2026: Aug 1 is a Saturday, Aug 31 is a Monday — a non-trivial
  // fixture with real leading (from July) and trailing (into September)
  // days, live-verified via plain Date math before writing this test.
  it("covers the full visible month with Monday-first leading/trailing days from adjacent months", () => {
    const grid = buildMonthGrid("2026-08-15", true);
    expect(grid).toHaveLength(6);
    expect(grid[0]).toEqual([
      { dayKey: "2026-07-27", inCurrentMonth: false },
      { dayKey: "2026-07-28", inCurrentMonth: false },
      { dayKey: "2026-07-29", inCurrentMonth: false },
      { dayKey: "2026-07-30", inCurrentMonth: false },
      { dayKey: "2026-07-31", inCurrentMonth: false },
      { dayKey: "2026-08-01", inCurrentMonth: true },
      { dayKey: "2026-08-02", inCurrentMonth: true },
    ]);
    expect(grid[5]).toEqual([
      { dayKey: "2026-08-31", inCurrentMonth: true },
      { dayKey: "2026-09-01", inCurrentMonth: false },
      { dayKey: "2026-09-02", inCurrentMonth: false },
      { dayKey: "2026-09-03", inCurrentMonth: false },
      { dayKey: "2026-09-04", inCurrentMonth: false },
      { dayKey: "2026-09-05", inCurrentMonth: false },
      { dayKey: "2026-09-06", inCurrentMonth: false },
    ]);
  });

  it("is independent of which day-of-month the anchor is (normalizes to the same month grid)", () => {
    expect(buildMonthGrid("2026-08-01", true)).toEqual(buildMonthGrid("2026-08-31", true));
  });

  it("drops the weekend columns (5 per row) when show_weekends=false, keeping Monday-first ordering", () => {
    const grid = buildMonthGrid("2026-08-15", false);
    expect(grid).toHaveLength(6);
    for (const week of grid) {
      expect(week).toHaveLength(5);
    }
    expect(grid[0].map((d) => d.dayKey)).toEqual([
      "2026-07-27",
      "2026-07-28",
      "2026-07-29",
      "2026-07-30",
      "2026-07-31",
    ]);
  });
});

describe("buildWeekGrid (Monday-first single-week grid generator)", () => {
  it("returns exactly one Monday-first row of 7 days covering the anchor's week", () => {
    // 2026-08-19 is a Wednesday; its week runs Mon 2026-08-17 .. Sun 2026-08-23.
    const grid = buildWeekGrid("2026-08-19", true);
    expect(grid).toHaveLength(1);
    expect(grid[0].map((d) => d.dayKey)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
    expect(grid[0].every((d) => d.inCurrentMonth)).toBe(true);
  });

  it("drops the weekend columns (5 per row) when show_weekends=false", () => {
    const grid = buildWeekGrid("2026-08-19", false);
    expect(grid[0].map((d) => d.dayKey)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
    ]);
  });
});

describe("layoutWeekRow (multi-day-span-to-week-row layout resolver, pure, no DOM)", () => {
  // Mon 2026-08-17 .. Sun 2026-08-23 (7 columns, indices 0..6).
  const WEEK = [
    "2026-08-17",
    "2026-08-18",
    "2026-08-19",
    "2026-08-20",
    "2026-08-21",
    "2026-08-22",
    "2026-08-23",
  ];

  it("places a single-day event at its own column with colSpan 1", () => {
    const { spans } = layoutWeekRow(WEEK, [{ rowId: "row-1", startDayKey: "2026-08-18", endDayKey: "2026-08-18" }]);
    expect(spans).toEqual([{ rowId: "row-1", startCol: 1, colSpan: 1, lane: 0 }]);
  });

  it("spans a multi-day event across its full column range", () => {
    const { spans } = layoutWeekRow(WEEK, [{ rowId: "row-1", startDayKey: "2026-08-19", endDayKey: "2026-08-21" }]);
    expect(spans).toEqual([{ rowId: "row-1", startCol: 2, colSpan: 3, lane: 0 }]);
  });

  it("clips an event that started before this week to the week's first column", () => {
    const { spans } = layoutWeekRow(WEEK, [{ rowId: "row-1", startDayKey: "2026-08-10", endDayKey: "2026-08-18" }]);
    expect(spans).toEqual([{ rowId: "row-1", startCol: 0, colSpan: 2, lane: 0 }]);
  });

  it("clips an event that ends after this week to the week's last column", () => {
    const { spans } = layoutWeekRow(WEEK, [{ rowId: "row-1", startDayKey: "2026-08-22", endDayKey: "2026-08-28" }]);
    expect(spans).toEqual([{ rowId: "row-1", startCol: 5, colSpan: 2, lane: 0 }]);
  });

  it("excludes an event that doesn't intersect this week at all", () => {
    const { spans, overflowByCol } = layoutWeekRow(WEEK, [
      { rowId: "row-1", startDayKey: "2026-09-01", endDayKey: "2026-09-02" },
    ]);
    expect(spans).toEqual([]);
    expect(overflowByCol).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("assigns deterministic lanes in (startDayKey, rowId) order, capping visible bars at MAX_EVENTS_PER_DAY and counting the rest as overflow on every day they touch", () => {
    const events = [
      { rowId: "row-d", startDayKey: "2026-08-18", endDayKey: "2026-08-18" },
      { rowId: "row-b", startDayKey: "2026-08-18", endDayKey: "2026-08-18" },
      { rowId: "row-a", startDayKey: "2026-08-18", endDayKey: "2026-08-19" }, // spans col1-2
      { rowId: "row-c", startDayKey: "2026-08-18", endDayKey: "2026-08-18" },
    ];
    const { spans, overflowByCol } = layoutWeekRow(WEEK, events);
    // Sorted by (startDayKey, rowId): all start 2026-08-18, so rowId breaks
    // the tie alphabetically: row-a, row-b, row-c, row-d.
    expect(spans).toEqual([
      { rowId: "row-a", startCol: 1, colSpan: 2, lane: 0 },
      { rowId: "row-b", startCol: 1, colSpan: 1, lane: 1 },
      { rowId: "row-c", startCol: 1, colSpan: 1, lane: 2 },
    ]);
    // row-d (lane 3, past MAX_EVENTS_PER_DAY=3) doesn't get a bar — it
    // counts as 1 unit of overflow on the single day (col 1) it touches.
    expect(overflowByCol[1]).toBe(1);
    expect(overflowByCol.filter((n) => n > 0)).toEqual([1]);
  });
});

describe("resolveDropDate (pure drag-drop date resolution, mirrors BoardView.test.tsx's resolveDropValue style)", () => {
  it("moves a single-day event's start to the target day, preserving its time-of-day", () => {
    const value: DateValue = { type: "date", date: { start: "2026-08-18T14:30:00.000Z", end: null, time_zone: null } };
    const result = resolveDropDate(value, "2026-08-20");
    expect(result).toEqual({
      type: "date",
      date: { start: "2026-08-20T14:30:00.000Z", end: null, time_zone: null },
    });
  });

  it("moves a date-only (no time-of-day) event's start, keeping the date-only format", () => {
    const value: DateValue = { type: "date", date: { start: "2026-08-18", end: null, time_zone: null } };
    const result = resolveDropDate(value, "2026-08-20");
    expect(result).toEqual({ type: "date", date: { start: "2026-08-20", end: null, time_zone: null } });
  });

  it("shifts a ranged event's end by the identical delta, preserving the range length", () => {
    const value: DateValue = {
      type: "date",
      date: { start: "2026-08-18T09:00:00.000Z", end: "2026-08-20T17:00:00.000Z", time_zone: "UTC" },
    };
    const result = resolveDropDate(value, "2026-08-22"); // +4 days
    expect(result).toEqual({
      type: "date",
      date: { start: "2026-08-22T09:00:00.000Z", end: "2026-08-24T17:00:00.000Z", time_zone: "UTC" },
    });
  });

  it("is a no-op (undefined) when dropped back on the day the event already occupies", () => {
    const value: DateValue = { type: "date", date: { start: "2026-08-18", end: null, time_zone: null } };
    expect(resolveDropDate(value, "2026-08-18")).toBeUndefined();
  });

  it("is a no-op (undefined) for a value with no date to move", () => {
    expect(resolveDropDate({ type: "date", date: null }, "2026-08-20")).toBeUndefined();
  });
});

describe("computeCalendarDragEndWrite (handleDragEnd's wiring, mirrors BoardView's computeDragEndWrite)", () => {
  const rows: DatabaseRow[] = [row("row-1", "Task 1", { start: "2026-08-18", end: null, time_zone: null })];

  it("returns the write to make for a valid drop on a different day's droppable", () => {
    const event = { over: { id: "day:2026-08-20" }, active: { data: { current: { rowId: "row-1" } } } };
    const result = computeCalendarDragEndWrite(event, rows, "due");
    expect(result).toEqual({ rowId: "row-1", value: { type: "date", date: { start: "2026-08-20", end: null, time_zone: null } } });
  });

  it("returns undefined when dropped outside any droppable (over is null)", () => {
    const event = { over: null, active: { data: { current: { rowId: "row-1" } } } };
    expect(computeCalendarDragEndWrite(event, rows, "due")).toBeUndefined();
  });

  it("returns undefined when dropped on something that isn't a day droppable", () => {
    const event = { over: { id: "not-a-day" }, active: { data: { current: { rowId: "row-1" } } } };
    expect(computeCalendarDragEndWrite(event, rows, "due")).toBeUndefined();
  });

  it("returns undefined when there's no drag data attached to the active draggable", () => {
    const event = { over: { id: "day:2026-08-20" }, active: { data: { current: undefined } } };
    expect(computeCalendarDragEndWrite(event, rows, "due")).toBeUndefined();
  });

  it("returns undefined when datePropertyKey hasn't resolved yet", () => {
    const event = { over: { id: "day:2026-08-20" }, active: { data: { current: { rowId: "row-1" } } } };
    expect(computeCalendarDragEndWrite(event, rows, null)).toBeUndefined();
  });

  it("returns undefined when the dragged row has no date value on that property", () => {
    const noDateRows: DatabaseRow[] = [row("row-2", "No date")];
    const event = { over: { id: "day:2026-08-20" }, active: { data: { current: { rowId: "row-2" } } } };
    expect(computeCalendarDragEndWrite(event, noDateRows, "due")).toBeUndefined();
  });

  it("returns undefined for a no-op drop (dropped back on its own day)", () => {
    const event = { over: { id: "day:2026-08-18" }, active: { data: { current: { rowId: "row-1" } } } };
    expect(computeCalendarDragEndWrite(event, rows, "due")).toBeUndefined();
  });
});

describe("calendarEventDraggableId (pure id-shaping logic, mirrors BoardView's cardDraggableId)", () => {
  it("disambiguates the same row rendered as bar-instances in two different week rows (a multi-week-spanning event)", () => {
    const idInWeekA = calendarEventDraggableId("2026-08-17", "row-1");
    const idInWeekB = calendarEventDraggableId("2026-08-24", "row-1");
    expect(idInWeekA).not.toEqual(idInWeekB);
  });

  it("is stable for the ordinary (single-week) case", () => {
    expect(calendarEventDraggableId("2026-08-17", "row-1")).toEqual(calendarEventDraggableId("2026-08-17", "row-1"));
  });
});

// ── Component tests ────────────────────────────────────────────────────

/** Mounts with `Date` mocked to `dateIso` for the anchor's initial
 * `useState` computation, then restores real timers before returning —
 * every interaction after `render()` (clicks, etc.) runs under real timers,
 * only the initial "today" anchor is pinned. */
function renderAt(dateIso: string, ui: React.ReactElement) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(dateIso));
  const utils = render(ui);
  vi.useRealTimers();
  return utils;
}

describe("CalendarView", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the 'no date property configured' placeholder when config.date_property_id is missing/invalid", () => {
    render(
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[]}
        editable={true}
        onCellChange={vi.fn()}
        config={{}}
        onConfigChange={vi.fn()}
      />
    );
    expect(screen.getByText(/no date property configured yet/i)).toBeInTheDocument();
  });

  it("the placeholder offers no picker when there's no date property to choose from at all", () => {
    render(
      <CalendarView
        properties={[TITLE_PROP]}
        rows={[]}
        editable={true}
        onCellChange={vi.fn()}
        config={{}}
        onConfigChange={vi.fn()}
      />
    );
    expect(screen.getByText(/add a date property first/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/date property/i)).not.toBeInTheDocument();
  });

  // view-tab-bar.md's M7 create-flow rewrite: Calendar now creates
  // immediately, auto-selecting an existing date property only when one
  // exists — this placeholder's own picker is the ONLY post-creation way to
  // ever set `date_property_id` (no settings-sidebar panel owns it, unlike
  // Board's group-by), so it has to actually work, not just explain the gap.
  it("picking a date property from the placeholder's picker calls onConfigChange with date_property_id", async () => {
    const user = userEvent.setup();
    const onConfigChange = vi.fn();
    render(
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[]}
        editable={true}
        onCellChange={vi.fn()}
        config={{}}
        onConfigChange={onConfigChange}
      />
    );
    await user.selectOptions(screen.getByLabelText(/date property/i), "due");
    expect(onConfigChange).toHaveBeenCalledWith({ date_property_id: "due" });
  });

  // M12: an event bar's Open button now opens the row's side peek (the
  // same `?p=&pm=s` URL Table/List/Feed/Board/Gallery already write)
  // instead of always hard-navigating.
  it("clicking an event's Open button opens the row's side peek (writes ?p=&pm=s), not a bare navigation", async () => {
    const user = userEvent.setup();
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[row("row-1", "Task A", { start: "2026-08-18", end: null, time_zone: null })]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due" }}
        onConfigChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(push).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalled();
    const [url] = routerReplace.mock.calls[routerReplace.mock.calls.length - 1];
    expect(url).toContain("p=row-1");
    expect(url).toContain("pm=s");
  });

  it("month view renders an event on its correct day cell", () => {
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[row("row-1", "Task A", { start: "2026-08-18", end: null, time_zone: null })]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "month" }}
        onConfigChange={vi.fn()}
      />
    );
    const bar = screen.getByTestId("calendar-event-row-1");
    expect(within(bar).getByText("Task A")).toBeInTheDocument();
    // 2026-08-18 falls in the week Mon 2026-08-17..Sun 2026-08-23 — column
    // index 1 (0-based) — see layoutWeekRow's own tests for the same fixture.
    expect(bar.style.gridColumn).toBe("2 / span 1");
  });

  it("week view renders the same data windowed to 7 days, excluding rows outside the visible week", () => {
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[
          row("row-1", "In window", { start: "2026-08-18", end: null, time_zone: null }),
          row("row-2", "Out of window", { start: "2026-08-01", end: null, time_zone: null }),
        ]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={vi.fn()}
      />
    );
    expect(screen.getAllByTestId(/^calendar-day-/)).toHaveLength(7);
    expect(screen.getByTestId("calendar-event-row-1")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-event-row-2")).not.toBeInTheDocument();
  });

  it("show_weekends=false hides Saturday/Sunday columns", () => {
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week", show_weekends: false }}
        onConfigChange={vi.fn()}
      />
    );
    expect(screen.getAllByTestId(/^calendar-day-/)).toHaveLength(5);
    expect(screen.getByTestId("calendar-day-2026-08-17")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-day-2026-08-21")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-day-2026-08-22")).not.toBeInTheDocument();
    expect(screen.queryByTestId("calendar-day-2026-08-23")).not.toBeInTheDocument();
  });

  it("a multi-day event renders as a single bar spanning multiple day cells within its week row", () => {
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[row("row-1", "Multi Task", { start: "2026-08-18", end: "2026-08-20", time_zone: null })]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={vi.fn()}
      />
    );
    // Rendered exactly once (not duplicated per day it covers)...
    expect(screen.getAllByTestId("calendar-event-row-1")).toHaveLength(1);
    // ...but its own inline grid placement spans 3 columns (Aug18-20: col
    // index 1, colSpan 3 — see layoutWeekRow's own equivalent fixture test).
    expect(screen.getByTestId("calendar-event-row-1").style.gridColumn).toBe("2 / span 3");
  });

  it("the +N more overflow indicator appears once a day has past MAX_EVENTS_PER_DAY (3) events", () => {
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[
          row("row-1", "A", { start: "2026-08-18", end: null, time_zone: null }),
          row("row-2", "B", { start: "2026-08-18", end: null, time_zone: null }),
          row("row-3", "C", { start: "2026-08-18", end: null, time_zone: null }),
          row("row-4", "D", { start: "2026-08-18", end: null, time_zone: null }),
        ]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={vi.fn()}
      />
    );
    expect(screen.getByTestId("calendar-event-row-1")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-event-row-2")).toBeInTheDocument();
    expect(screen.getByTestId("calendar-event-row-3")).toBeInTheDocument();
    expect(screen.queryByTestId("calendar-event-row-4")).not.toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("a read-only (All Notes) render never wires a working drag handler", () => {
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[row("row-1", "Task A", { start: "2026-08-18", end: null, time_zone: null })]}
        editable={false}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={vi.fn()}
      />
    );
    const bar = screen.getByTestId("calendar-event-row-1");
    // dnd-kit's useDraggable({disabled: true}) sets aria-disabled and
    // returns `listeners: undefined` — the actual drag activation handlers
    // are never spread onto this node when read-only.
    expect(bar).toHaveAttribute("aria-disabled", "true");
  });

  it("editable render wires a real (enabled) drag handler on the event bar", () => {
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[row("row-1", "Task A", { start: "2026-08-18", end: null, time_zone: null })]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={vi.fn()}
      />
    );
    expect(screen.getByTestId("calendar-event-row-1")).toHaveAttribute("aria-disabled", "false");
  });

  it("clicking + on an empty day cell creates a row and sets its date to that day", async () => {
    const user = userEvent.setup();
    const onCellChange = vi.fn();
    const refetchRows = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "row-new", properties: {} }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[]}
        editable={true}
        onCellChange={onCellChange}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={vi.fn()}
        dataSourceId="ds-1"
        refetchRows={refetchRows}
      />
    );

    await user.click(screen.getByLabelText("Add row on 2026-08-18"));

    expect(fetchMock).toHaveBeenCalledWith("/api/db/data-sources/ds-1/rows", expect.objectContaining({ method: "POST" }));
    await vi.waitFor(() => expect(refetchRows).toHaveBeenCalled());
    expect(onCellChange).toHaveBeenCalledWith("row-new", "due", {
      type: "date",
      date: { start: "2026-08-18", end: null, time_zone: null },
    });

    vi.unstubAllGlobals();
  });

  it("does not offer + on a day cell that already has an event", () => {
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[row("row-1", "Task A", { start: "2026-08-18", end: null, time_zone: null })]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={vi.fn()}
        dataSourceId="ds-1"
      />
    );
    expect(screen.queryByLabelText("Add row on 2026-08-18")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Add row on 2026-08-19")).toBeInTheDocument();
  });

  it("toggling the view-range select calls onConfigChange with the new value", async () => {
    const user = userEvent.setup();
    const onConfigChange = vi.fn();
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "month" }}
        onConfigChange={onConfigChange}
      />
    );
    await user.selectOptions(screen.getByLabelText("View range"), "week");
    expect(onConfigChange).toHaveBeenCalledWith({ view_range: "week" });
  });

  it("toggling 'Show weekends' calls onConfigChange with the new value", async () => {
    const user = userEvent.setup();
    const onConfigChange = vi.fn();
    renderAt(
      "2026-08-18T00:00:00.000Z",
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={onConfigChange}
      />
    );
    const checkbox = screen.getByRole("checkbox", { name: /show weekends/i });
    await user.click(checkbox);
    expect(onConfigChange).toHaveBeenCalledWith({ show_weekends: false });
  });

  it("clicking Next then Today navigates and returns to the anchor day's week", () => {
    // Unlike the other tests above, "Today" itself reads `new Date()` at
    // click time — real timers must stay mocked through the whole
    // interaction here, not just at mount, or this test's own pass/fail
    // would depend on which real calendar day it happens to run on. Plain
    // `fireEvent.click` (synchronous, no internal setTimeout-based delay
    // machinery) rather than `userEvent.click` — userEvent's own timers
    // fight vi's fake ones and the interaction hangs.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00.000Z"));

    render(
      <CalendarView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={[]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", view_range: "week" }}
        onConfigChange={vi.fn()}
      />
    );
    expect(screen.getByTestId("calendar-day-2026-08-17")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Next"));
    expect(screen.queryByTestId("calendar-day-2026-08-17")).not.toBeInTheDocument();
    expect(screen.getByTestId("calendar-day-2026-08-24")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Today"));
    expect(screen.getByTestId("calendar-day-2026-08-17")).toBeInTheDocument();
  });
});
