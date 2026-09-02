import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// TimelineBar renders an OpenNoteButton (same as every other view's card/
// row/event), which navigates via next/navigation's useRouter — outside a
// real Next.js app router tree (as here, a plain RTL render) that throws
// "invariant expected app router to be mounted" unless mocked, same as
// CalendarView.test.tsx/BoardView.test.tsx do. M12: TimelineView also
// reads/writes the row peek's `?p=&pm=` via `useRowPeek` now — mocked the
// same way.
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
  TimelineView,
  ZOOM_LEVELS,
  computeArrowEndpoints,
  computeBarGeometry,
  computeOriginMs,
  extractTimelineEvents,
  pixelsPerDay,
  resolveBarResize,
  type ZoomLevel,
} from "./TimelineView";
import type { DatabaseRow, DateValue, PropertyResponse, RelatedRow } from "@/lib/database/types";

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
const DEPENDENCY_FORWARD_PROP = prop({
  key: "blocking",
  name: "Blocking",
  type: "relation",
  position: 2,
  config: {
    system: "dependency",
    side: "forward",
    relation_id: "rel-1",
    date_property_key: "due",
    date_shift_mode: "Shift & maintain time between items",
  },
});

function row(id: string, title: string, dateValue?: DateValue["date"]): DatabaseRow {
  return {
    id,
    properties: {
      title: { type: "title", title },
      ...(dateValue !== undefined ? { due: { type: "date", date: dateValue } } : {}),
    },
  };
}

// ── Pure-function tests (no DOM needed) ────────────────────────────────────

describe("pixelsPerDay (zoom-level-to-pixel-width mapping)", () => {
  it("all 8 zoom levels are functionally distinguishable and strictly decreasing from hours to 5_years", () => {
    const values = ZOOM_LEVELS.map((z) => pixelsPerDay(z));
    expect(new Set(values).size).toBe(8); // all distinct
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThan(values[i - 1]);
    }
  });

  it("hours shows less time per screen-width than 5_years (hours has the narrowest time-per-pixel)", () => {
    // A narrower time-per-pixel means MORE pixels represent one day — the
    // inverse of "how many days fit in a fixed screen width".
    expect(pixelsPerDay("hours")).toBeGreaterThan(pixelsPerDay("5_years"));
  });
});

describe("computeBarGeometry (bar position/width from {start,end} + zoom)", () => {
  const originMs = new Date("2026-01-01T00:00:00.000Z").getTime();

  it("positions a ranged bar's left edge at its start offset from origin, scaled by pixels-per-day", () => {
    const geometry = computeBarGeometry(
      { start: "2026-01-03T00:00:00.000Z", end: "2026-01-05T00:00:00.000Z" },
      "day", // 120 px/day
      originMs
    );
    expect(geometry.left).toBe(2 * 120); // 2 days after origin
    expect(geometry.width).toBe(2 * 120); // 2-day range
    expect(geometry.isPoint).toBe(false);
  });

  it("renders a null-end date as a zero-width point marker, not a bar", () => {
    const geometry = computeBarGeometry({ start: "2026-01-02T00:00:00.000Z", end: null }, "day", originMs);
    expect(geometry.isPoint).toBe(true);
    expect(geometry.width).toBe(0);
  });

  it("clamps a sub-minimum-width range to MIN_BAR_WIDTH_PX rather than rendering an invisible sliver", () => {
    const geometry = computeBarGeometry(
      { start: "2026-01-02T00:00:00.000Z", end: "2026-01-02T01:00:00.000Z" }, // 1 hour
      "5_years", // 0.3 px/day
      originMs
    );
    expect(geometry.width).toBeGreaterThanOrEqual(4);
  });
});

describe("computeOriginMs (shared time-zero for the whole track)", () => {
  it("is one day before the earliest given timestamp", () => {
    const t1 = new Date("2026-03-01T00:00:00.000Z").getTime();
    const t2 = new Date("2026-01-01T00:00:00.000Z").getTime();
    expect(computeOriginMs([t1, t2])).toBe(t2 - 86_400_000);
  });

  it("falls back to one day before now when there are no timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    expect(computeOriginMs([])).toBe(new Date("2026-05-31T00:00:00.000Z").getTime());
    vi.useRealTimers();
  });
});

describe("resolveBarResize (pure bar-resize -> new DateValue resolution)", () => {
  const rangedValue: DateValue = {
    type: "date",
    date: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null },
  };

  it("dragging the start edge shifts start, preserving end", () => {
    // "day" zoom = 120 px/day -> 240px = +2 days.
    const result = resolveBarResize(rangedValue, "start", 240, "day");
    expect(result).toEqual({
      type: "date",
      date: { start: "2026-01-03T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null },
    });
  });

  it("dragging the end edge shifts end, preserving start", () => {
    const result = resolveBarResize(rangedValue, "end", -120, "day"); // -1 day
    expect(result).toEqual({
      type: "date",
      date: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-10T00:00:00.000Z", time_zone: null },
    });
  });

  it("preserves a date-only (no time-of-day) format across a resize", () => {
    const dateOnly: DateValue = { type: "date", date: { start: "2026-01-01", end: "2026-01-11", time_zone: null } };
    const result = resolveBarResize(dateOnly, "end", 120, "day");
    expect(result?.date?.end).toBe("2026-01-12");
    expect(result?.date?.end).not.toContain("T");
  });

  it("never collapses the range below one day — clamps instead of inverting", () => {
    const result = resolveBarResize(rangedValue, "start", 120 * 20, "day"); // way past end
    expect(result?.date?.start).toBe("2026-01-10T00:00:00.000Z"); // end - 1 day
  });

  it("is a no-op (undefined) for a zero-pixel drag", () => {
    expect(resolveBarResize(rangedValue, "start", 0, "day")).toBeUndefined();
  });

  it("is a no-op (undefined) for a point marker (no end to anchor a range against)", () => {
    const point: DateValue = { type: "date", date: { start: "2026-01-01", end: null, time_zone: null } };
    expect(resolveBarResize(point, "end", 120, "day")).toBeUndefined();
  });
});

describe("computeArrowEndpoints (dependency-arrow geometry from two known bar positions)", () => {
  it("draws from the end of the blocker's bar to the start of the blocked bar, vertically centred on each row", () => {
    const endpoints = computeArrowEndpoints(
      { left: 100, width: 50 }, // blocker bar
      0, // blocker row index
      { left: 300 }, // blocked bar
      2, // blocked row index
      32 // rowHeight
    );
    expect(endpoints).toEqual({ x1: 150, y1: 16, x2: 300, y2: 80 });
  });
});

describe("extractTimelineEvents", () => {
  it("omits rows with no value on the configured date property (research §5.1: nothing is plotted)", () => {
    const rows: DatabaseRow[] = [row("row-1", "Has date", { start: "2026-01-01", end: null, time_zone: null }), row("row-2", "No date")];
    expect(extractTimelineEvents(rows, "due").map((e) => e.rowId)).toEqual(["row-1"]);
  });

  it("returns nothing when no date property is configured", () => {
    expect(extractTimelineEvents([row("row-1", "A", { start: "2026-01-01", end: null, time_zone: null })], null)).toEqual([]);
  });
});

// ── Component tests ────────────────────────────────────────────────────

function renderTimeline(overrides: Partial<React.ComponentProps<typeof TimelineView>> = {}) {
  return render(
    <TimelineView
      properties={[TITLE_PROP, DUE_PROP]}
      rows={[]}
      editable={true}
      onCellChange={vi.fn()}
      config={{ date_property_id: "due" }}
      onConfigChange={vi.fn()}
      {...overrides}
    />
  );
}

describe("TimelineView", () => {
  it("shows the 'no date property configured' placeholder when config.date_property_id is missing/invalid", () => {
    renderTimeline({ config: {} });
    expect(screen.getByText(/no date property configured yet/i)).toBeInTheDocument();
  });

  it("the placeholder offers no picker when there's no date property to choose from at all", () => {
    renderTimeline({ properties: [TITLE_PROP], config: {} });
    expect(screen.getByText(/add a date property first/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/date property/i)).not.toBeInTheDocument();
  });

  // view-tab-bar.md's M7 create-flow rewrite: Timeline now creates
  // immediately, auto-selecting an existing date property only when one
  // exists — this placeholder's own picker is the ONLY post-creation way to
  // ever set `date_property_id` (no settings-sidebar panel owns it).
  it("picking a date property from the placeholder's picker calls onConfigChange with date_property_id", async () => {
    const user = userEvent.setup();
    const onConfigChange = vi.fn();
    renderTimeline({ config: {}, onConfigChange });
    await user.selectOptions(screen.getByLabelText(/date property/i), "due");
    expect(onConfigChange).toHaveBeenCalledWith({ date_property_id: "due" });
  });

  // M12: a row's Open button now opens the side peek (the same `?p=&pm=s`
  // URL every other M12 view now writes) instead of always hard-navigating.
  it("clicking a row's Open button opens the row's side peek (writes ?p=&pm=s), not a bare navigation", async () => {
    const user = userEvent.setup();
    const rows = [row("row-1", "Task A", { start: "2026-01-01T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null })];
    renderTimeline({ rows, config: { date_property_id: "due", preference: { zoom_level: "month" } } });

    await user.click(screen.getByRole("button", { name: "Open" }));

    expect(push).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalled();
    const [url] = routerReplace.mock.calls[routerReplace.mock.calls.length - 1];
    expect(url).toContain("p=row-1");
    expect(url).toContain("pm=s");
  });

  it("all 8 zoom levels render distinguishably different bar widths for the same fixed date range", () => {
    const rows = [row("row-1", "Task A", { start: "2026-01-01T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null })];
    const { rerender } = render(
      <TimelineView
        properties={[TITLE_PROP, DUE_PROP]}
        rows={rows}
        editable={true}
        onCellChange={vi.fn()}
        config={{ date_property_id: "due", preference: { zoom_level: "hours" } }}
        onConfigChange={vi.fn()}
      />
    );

    const widths: number[] = [];
    for (const zoom of ZOOM_LEVELS) {
      rerender(
        <TimelineView
          properties={[TITLE_PROP, DUE_PROP]}
          rows={rows}
          editable={true}
          onCellChange={vi.fn()}
          config={{ date_property_id: "due", preference: { zoom_level: zoom } }}
          onConfigChange={vi.fn()}
        />
      );
      const bar = screen.getByTestId("timeline-bar-row-1");
      widths.push(parseFloat(bar.style.width));
    }

    expect(new Set(widths).size).toBe(8);
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
    }
    // Strictly less for at least the extremes (hours vs 5_years) — proves
    // the mapping isn't a no-op.
    expect(widths[widths.length - 1]).toBeLessThan(widths[0]);
  });

  it("selecting a zoom level calls onConfigChange with the nested preference.zoom_level shape (Notion's own field nesting)", async () => {
    const user = userEvent.setup();
    const onConfigChange = vi.fn();
    renderTimeline({ onConfigChange, config: { date_property_id: "due", preference: { zoom_level: "month" } } });
    await user.selectOptions(screen.getByLabelText("Zoom level"), "quarter");
    expect(onConfigChange).toHaveBeenCalledWith({ preference: { zoom_level: "quarter" } });
  });

  it("a row with no `end` renders as a point marker, not a bar", () => {
    const rows = [row("row-1", "Milestone", { start: "2026-01-05T00:00:00.000Z", end: null, time_zone: null })];
    renderTimeline({ rows });
    const bar = screen.getByTestId("timeline-bar-row-1");
    // A point marker is square (equal width/height, the MARKER_SIZE
    // constant) and rounded-full, unlike a ranged bar's wide rectangle.
    expect(bar.style.width).toBe(bar.style.height);
    expect(bar.className).toContain("rounded-full");
  });

  it("a ranged bar is a wide rectangle, not rounded-full", () => {
    const rows = [row("row-1", "Task A", { start: "2026-01-01T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null })];
    renderTimeline({ rows });
    const bar = screen.getByTestId("timeline-bar-row-1");
    expect(bar.className).not.toContain("rounded-full");
    expect(parseFloat(bar.style.width)).toBeGreaterThan(0);
  });

  it("resizing a bar's right edge (mousedown -> mousemove -> mouseup) calls onCellChange with the correctly shifted end date", () => {
    const onCellChange = vi.fn();
    const rows = [row("row-1", "Task A", { start: "2026-01-01T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null })];
    renderTimeline({ rows, onCellChange, config: { date_property_id: "due", preference: { zoom_level: "day" } } });

    const handle = screen.getByLabelText("Resize end of Task A");
    fireEvent.mouseDown(handle, { clientX: 100 });
    // "day" zoom = 120 px/day -> +120px = +1 day.
    fireEvent.mouseUp(document, { clientX: 220 });

    expect(onCellChange).toHaveBeenCalledWith("row-1", "due", {
      type: "date",
      date: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-12T00:00:00.000Z", time_zone: null },
    });
  });

  it("a read-only (All Notes) render never wires a working resize handler", () => {
    const rows = [row("row-1", "Task A", { start: "2026-01-01T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null })];
    renderTimeline({ rows, editable: false });
    expect(screen.queryByLabelText("Resize end of Task A")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resize start of Task A")).not.toBeInTheDocument();
  });

  describe("dependency arrows", () => {
    const BLOCKER_ROW = row("blocker", "Blocker task", { start: "2026-01-01T00:00:00.000Z", end: "2026-01-05T00:00:00.000Z", time_zone: null });
    const BLOCKED_ROW = row("blocked", "Blocked task", { start: "2026-01-06T00:00:00.000Z", end: "2026-01-10T00:00:00.000Z", time_zone: null });
    const NO_DATE_ROW = row("no-date", "No date task"); // never plotted

    function relationLinksFor(links: RelatedRow[]): Record<string, RelatedRow[]> {
      return { "blocker:blocking": links };
    }

    it("draws an arrow between two rows that are both currently plotted and linked via the forward dependency relation", () => {
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP, DEPENDENCY_FORWARD_PROP],
        rows: [BLOCKER_ROW, BLOCKED_ROW],
        config: { date_property_id: "due", arrows_by: true },
        relationLinks: relationLinksFor([{ id: "blocked", title: "Blocked task" }]),
        ensureRelationLinksBulk: vi.fn(),
      });
      expect(screen.getByTestId("timeline-arrow-blocker-blocked")).toBeInTheDocument();
    });

    it("skips a dependency pair when one side has no date / isn't plotted — no crash, no dangling arrow", () => {
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP, DEPENDENCY_FORWARD_PROP],
        rows: [BLOCKER_ROW, NO_DATE_ROW],
        config: { date_property_id: "due", arrows_by: true },
        relationLinks: { "blocker:blocking": [{ id: "no-date", title: "No date task" }] },
        ensureRelationLinksBulk: vi.fn(),
      });
      expect(screen.queryByTestId(/^timeline-arrow-/)).not.toBeInTheDocument();
    });

    it("config.arrows_by=false renders zero arrows even when a dependency pair exists and both rows are plotted", () => {
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP, DEPENDENCY_FORWARD_PROP],
        rows: [BLOCKER_ROW, BLOCKED_ROW],
        config: { date_property_id: "due", arrows_by: false },
        relationLinks: relationLinksFor([{ id: "blocked", title: "Blocked task" }]),
        ensureRelationLinksBulk: vi.fn(),
      });
      expect(screen.queryByTestId(/^timeline-arrow-/)).not.toBeInTheDocument();
    });

    it("warms the dependency relation's link cache via ensureRelationLinksBulk (the N+1-safe bulk fetch), not a per-row fetch loop", () => {
      const ensureRelationLinksBulk = vi.fn();
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP, DEPENDENCY_FORWARD_PROP],
        rows: [BLOCKER_ROW, BLOCKED_ROW],
        config: { date_property_id: "due", arrows_by: true },
        relationLinks: {},
        ensureRelationLinksBulk,
      });
      expect(ensureRelationLinksBulk).toHaveBeenCalledTimes(1);
      expect(ensureRelationLinksBulk).toHaveBeenCalledWith(["blocker", "blocked"], "blocking");
    });

    it("the arrows toggle is disabled (not hidden) with an explanatory note when no dependency pair exists on the data source", () => {
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP], // no dependency relation property
        rows: [BLOCKER_ROW, BLOCKED_ROW],
      });
      const checkbox = screen.getByLabelText("Show dependency arrows");
      expect(checkbox).toBeDisabled();
      expect(screen.getByText(/turn on dependencies in database settings first/i)).toBeInTheDocument();
    });

    it("toggling the arrows checkbox (when a dependency pair exists) calls onConfigChange with arrows_by as a plain boolean", async () => {
      const user = userEvent.setup();
      const onConfigChange = vi.fn();
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP, DEPENDENCY_FORWARD_PROP],
        rows: [BLOCKER_ROW, BLOCKED_ROW],
        onConfigChange,
        config: { date_property_id: "due", arrows_by: false },
      });
      await user.click(screen.getByLabelText("Show dependency arrows"));
      expect(onConfigChange).toHaveBeenCalledWith({ arrows_by: true });
    });
  });

  describe("dependency date-property mismatch warning (fix-wave-1 finding 2)", () => {
    const STARTED_PROP = prop({ key: "started", name: "Started", type: "date", position: 3 });
    const DEPENDENCY_ON_DIFFERENT_DATE_PROP = prop({
      key: "blocking",
      name: "Blocking",
      type: "relation",
      position: 2,
      config: {
        system: "dependency",
        side: "forward",
        relation_id: "rel-1",
        date_property_key: "started", // differs from the Timeline's own "due" below
        date_shift_mode: "Shift & maintain time between items",
      },
    });

    it("warns when the dependency relation's date property differs from this Timeline's own date property", () => {
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP, STARTED_PROP, DEPENDENCY_ON_DIFFERENT_DATE_PROP],
        config: { date_property_id: "due", arrows_by: true },
      });
      const warning = screen.getByTestId("timeline-dependency-date-mismatch-warning");
      expect(warning).toBeInTheDocument();
      expect(warning).toHaveTextContent("Started"); // uses the display name, not the raw key
    });

    it("does not warn when the dependency relation's date property matches this Timeline's own date property", () => {
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP, DEPENDENCY_FORWARD_PROP], // date_property_key: "due" — matches
        config: { date_property_id: "due", arrows_by: true },
      });
      expect(screen.queryByTestId("timeline-dependency-date-mismatch-warning")).not.toBeInTheDocument();
    });

    it("does not warn when arrows_by is false, even with mismatched date properties", () => {
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP, STARTED_PROP, DEPENDENCY_ON_DIFFERENT_DATE_PROP],
        config: { date_property_id: "due", arrows_by: false },
      });
      expect(screen.queryByTestId("timeline-dependency-date-mismatch-warning")).not.toBeInTheDocument();
    });

    it("does not warn when no dependency pair exists, even with arrows_by true", () => {
      renderTimeline({
        properties: [TITLE_PROP, DUE_PROP], // no dependency relation property
        config: { date_property_id: "due", arrows_by: true },
      });
      expect(screen.queryByTestId("timeline-dependency-date-mismatch-warning")).not.toBeInTheDocument();
    });
  });

  it("clicking Today does not crash and scrolls the track container", () => {
    const rows = [row("row-1", "Task A", { start: "2026-01-01T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null })];
    renderTimeline({ rows });
    const track = screen.getByTestId("timeline-track");
    fireEvent.click(screen.getByLabelText("Today"));
    // jsdom never computes real layout (clientWidth is always 0), so this
    // only proves the handler runs and assigns a finite scrollLeft — not a
    // pixel-perfect centering claim, which jsdom can't make meaningful.
    expect(Number.isFinite(track.scrollLeft)).toBe(true);
  });
});

// ── Dependency-shift propagation: the "date shifting honours the M7
// modes" test case (task-34-brief.md §4). Deliberately does NOT mock
// `onCellChange`/`updateCell` — it mounts the REAL `useDatabaseView` hook
// (only `fetch` is mocked, at the HTTP boundary) so this test actually
// exercises `updateCell`'s real `shifted_rows` merge logic
// (lib/database/useDatabaseView.ts ~L234-243). A test that instead passed
// a hand-rolled `onCellChange` stub which fabricated a moved second bar
// could pass even if that merge logic were broken — this harness cannot,
// because TimelineView never learns about row-2's new date from anything
// but the real hook's own state update. ─────────────────────────────────
describe("dependency-shift propagation (real useDatabaseView, not a mocked shifted_rows response)", () => {
  it("resizing one bar's end date, on a fixture with a configured dependency + shift mode, moves a second dependent row's bar too", async () => {
    const { useDatabaseView } = await import("@/lib/database/useDatabaseView");

    const DETAIL = {
      database: {
        id: "db-1",
        user_id: "user-1",
        title: "Project",
        description: [],
        icon: null,
        cover_url: null,
        is_inline: false,
        parent_note_id: null,
        is_locked: false,
        position: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        deleted_at: null,
      },
      data_source: {
        id: "ds-1",
        database_id: "db-1",
        user_id: "user-1",
        name: "Default",
        system_kind: null,
        position: 0,
        created_at: "2026-01-01T00:00:00Z",
        is_virtual: false,
      },
      properties: [TITLE_PROP, DUE_PROP, DEPENDENCY_FORWARD_PROP],
      views: [
        {
          id: "v1",
          data_source_id: "ds-1",
          user_id: "user-1",
          name: "Timeline",
          icon: null,
          type: "timeline",
          config: { date_property_id: "due", preference: { zoom_level: "day" } },
          filter: null,
          sorts: [],
          is_locked: false,
          position: 0,
        },
      ],
    };

    const initialRows: DatabaseRow[] = [
      { id: "blocker", properties: { title: { type: "title", title: "Blocker task" }, due: { type: "date", date: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-11T00:00:00.000Z", time_zone: null } } } },
      { id: "blocked", properties: { title: { type: "title", title: "Blocked task" }, due: { type: "date", date: { start: "2026-01-12T00:00:00.000Z", end: "2026-01-15T00:00:00.000Z", time_zone: null } } } },
    ];

    function jsonResponse(body: unknown, status = 200) {
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: initialRows }));
      }
      // The real backend contract (routers/databases.py's PATCH
      // .../rows/{note_id}, task-21-brief.md §4): a date-property write
      // that shifts the "Blocking" chain returns `shifted_rows` alongside
      // the written row's own new properties.
      if (url === "/api/db/data-sources/ds-1/rows/blocker" && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({
            id: "blocker",
            properties: {
              title: { type: "title", title: "Blocker task" },
              due: { type: "date", date: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-15T00:00:00.000Z", time_zone: null } },
            },
            shifted_rows: [
              {
                id: "blocked",
                properties: {
                  due: { type: "date", date: { start: "2026-01-16T00:00:00.000Z", end: "2026-01-19T00:00:00.000Z", time_zone: null } },
                },
              },
            ],
          })
        );
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    function Harness() {
      const { rows, properties, views, activeViewId, updateCell } = useDatabaseView("db-1");
      const activeView = views.find((v) => v.id === activeViewId);
      if (!activeView) return null;
      return (
        <TimelineView
          properties={properties}
          rows={rows}
          editable={true}
          onCellChange={updateCell}
          config={activeView.config}
          onConfigChange={() => {}}
        />
      );
    }

    render(<Harness />);

    await waitFor(() => expect(screen.getByTestId("timeline-bar-blocker")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("timeline-bar-blocked")).toBeInTheDocument());

    const blockedBarBefore = screen.getByTestId("timeline-bar-blocked");
    const leftBefore = parseFloat(blockedBarBefore.style.left);

    const handle = screen.getByLabelText("Resize end of Blocker task");
    fireEvent.mouseDown(handle, { clientX: 0 });
    // "day" zoom = 120 px/day -> +480px = +4 days (2026-01-11 -> 2026-01-15,
    // matching the mocked PATCH response above).
    await act(async () => {
      fireEvent.mouseUp(document, { clientX: 480 });
    });

    await waitFor(() => {
      const blockedBarAfter = screen.getByTestId("timeline-bar-blocked");
      expect(parseFloat(blockedBarAfter.style.left)).not.toBe(leftBefore);
    });

    // Confirms the moved value came from the mocked PATCH's `shifted_rows`
    // field, not some other coincidental re-render.
    const blockedBarAfter = screen.getByTestId("timeline-bar-blocked");
    // start moved from 2026-01-12 to 2026-01-16 = +4 days = +480px at
    // "day" zoom's 120px/day.
    expect(parseFloat(blockedBarAfter.style.left) - leftBefore).toBeCloseTo(480, 5);

    vi.unstubAllGlobals();
  });
});
