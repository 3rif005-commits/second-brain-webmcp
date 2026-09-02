import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ChartCreateFields,
  ChartView,
  DEFAULT_CHART_DRAFT,
  buildChartViewConfig,
  computeDonutSlices,
  computeStackLayout,
  computeYScale,
  isChartConfigComplete,
  valueToSize,
  valueToY,
  type ChartDraftConfig,
} from "./ChartView";
import type { Group, PropertyResponse } from "@/lib/database/types";

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

const STATUS_PROP = prop({ key: "status", name: "Status", type: "status", position: 0 });
const PRIORITY_PROP = prop({ key: "priority", name: "Priority", type: "select", position: 1 });
const AMOUNT_PROP = prop({ key: "amount", name: "Amount", type: "number", position: 2 });

// ── Pure-function tests ─────────────────────────────────────────────────

describe("computeStackLayout (group_style normalization math)", () => {
  const values = [
    { key: "a", value: 10 },
    { key: "b", value: 30 },
  ];

  it("'normal': stacks to the raw sum, cumulative offsets", () => {
    const segs = computeStackLayout(values, "normal");
    expect(segs).toEqual([
      { key: "a", value: 10, index: 0, offset: 0, size: 10 },
      { key: "b", value: 30, index: 1, offset: 10, size: 30 },
    ]);
  });

  it("'percent': each segment normalized to its share of the group total, summing to exactly 100", () => {
    const segs = computeStackLayout(values, "percent");
    expect(segs).toEqual([
      { key: "a", value: 10, index: 0, offset: 0, size: 25 },
      { key: "b", value: 30, index: 1, offset: 25, size: 75 },
    ]);
    expect(segs[segs.length - 1].offset + segs[segs.length - 1].size).toBe(100);
  });

  it("'side_by_side': every segment keeps offset 0 and its own raw value — nothing stacks", () => {
    const segs = computeStackLayout(values, "side_by_side");
    expect(segs).toEqual([
      { key: "a", value: 10, index: 0, offset: 0, size: 10 },
      { key: "b", value: 30, index: 1, offset: 0, size: 30 },
    ]);
  });

  it("'percent' with a zero group total: every segment sizes to 0, not NaN/Infinity", () => {
    const segs = computeStackLayout([{ key: "a", value: 0 }], "percent");
    expect(segs).toEqual([{ key: "a", value: 0, index: 0, offset: 0, size: 0 }]);
  });
});

describe("computeDonutSlices (donut arc-angle computation)", () => {
  it("4 equal-value groups produce 4 exact quarter-circle (π/2) sweeps", () => {
    const slices = computeDonutSlices([
      { key: "a", value: 1 },
      { key: "b", value: 1 },
      { key: "c", value: 1 },
      { key: "d", value: 1 },
    ]);
    expect(slices).toHaveLength(4);
    slices.forEach((s) => {
      expect(s.endAngle - s.startAngle).toBeCloseTo(Math.PI / 2, 10);
    });
    // Boundaries are cumulative: 0, π/2, π, 3π/2, 2π.
    expect(slices[0].startAngle).toBeCloseTo(0, 10);
    expect(slices[1].startAngle).toBeCloseTo(Math.PI / 2, 10);
    expect(slices[2].startAngle).toBeCloseTo(Math.PI, 10);
    expect(slices[3].startAngle).toBeCloseTo((3 * Math.PI) / 2, 10);
    expect(slices[3].endAngle).toBeCloseTo(2 * Math.PI, 10);
  });

  it("an unequal split sizes sweeps proportionally to each value's fraction of the total", () => {
    const slices = computeDonutSlices([
      { key: "a", value: 1 },
      { key: "b", value: 3 },
    ]);
    expect(slices[0].endAngle - slices[0].startAngle).toBeCloseTo((2 * Math.PI) / 4, 10);
    expect(slices[1].endAngle - slices[1].startAngle).toBeCloseTo((2 * Math.PI * 3) / 4, 10);
  });
});

describe("valueToY / computeYScale (reference-line y-position math)", () => {
  it("maps a value to its y-position against a known scale (0 at bottom, max at top)", () => {
    const scale = { max: 100, pxHeight: 200 };
    expect(valueToY(0, scale)).toBe(200);
    expect(valueToY(25, scale)).toBe(150);
    expect(valueToY(100, scale)).toBe(0);
  });

  it("computeYScale derives max from the given values (bars and reference lines share one scale)", () => {
    const scale = computeYScale([10, 40, 25], 200);
    expect(scale).toEqual({ max: 40, pxHeight: 200 });
    // A reference line at the same value as the scale's own max lands at y=0.
    expect(valueToY(40, scale)).toBe(0);
  });

  it("valueToSize is the complement of valueToY (size = pxHeight - y)", () => {
    const scale = { max: 100, pxHeight: 200 };
    expect(valueToSize(25, scale)).toBe(50);
    expect(valueToSize(25, scale)).toBe(scale.pxHeight - valueToY(25, scale));
  });

  it("degenerate case (all-zero values) falls back to max=1, never divides by zero", () => {
    const scale = computeYScale([0, 0], 200);
    expect(scale.max).toBe(1);
    expect(Number.isFinite(valueToY(0, scale))).toBe(true);
  });
});

describe("isChartConfigComplete / buildChartViewConfig", () => {
  it("requires a y_axis property when the aggregator isn't 'count'", () => {
    const draft: ChartDraftConfig = {
      ...DEFAULT_CHART_DRAFT,
      chart_type: "number",
      y_axis_aggregator: "sum",
    };
    expect(isChartConfigComplete(draft)).toBe(false);
    expect(isChartConfigComplete({ ...draft, y_axis_property_key: "amount" })).toBe(true);
  });

  it("count aggregator needs no property, but still requires an x_axis for a non-number chart_type", () => {
    expect(isChartConfigComplete(DEFAULT_CHART_DRAFT)).toBe(false); // column, no x_axis yet
    expect(isChartConfigComplete({ ...DEFAULT_CHART_DRAFT, x_axis_property_key: "status" })).toBe(true);
  });

  it("chart_type 'number' needs no x_axis at all", () => {
    expect(isChartConfigComplete({ ...DEFAULT_CHART_DRAFT, chart_type: "number" })).toBe(true);
  });

  it("buildChartViewConfig assembles Notion-named config fields (property_id, not property_key)", () => {
    const config = buildChartViewConfig({
      chart_type: "column",
      x_axis_property_key: "status",
      y_axis_aggregator: "sum",
      y_axis_property_key: "amount",
      stack_by_property_key: "priority",
      hide_empty_groups: true,
    });
    expect(config).toEqual({
      chart_type: "column",
      y_axis: { aggregator: "sum", property_id: "amount" },
      x_axis: { property_id: "status" },
      hide_empty_groups: true,
      stack_by: { property_id: "priority" },
    });
  });

  it("buildChartViewConfig omits x_axis/hide_empty_groups/stack_by for chart_type 'number'", () => {
    const config = buildChartViewConfig({ ...DEFAULT_CHART_DRAFT, chart_type: "number" });
    expect(config).toEqual({ chart_type: "number", y_axis: { aggregator: "count" } });
  });

  it("buildChartViewConfig never sets stack_by for chart_type 'donut', even if one was picked", () => {
    const config = buildChartViewConfig({
      ...DEFAULT_CHART_DRAFT,
      chart_type: "donut",
      x_axis_property_key: "status",
      stack_by_property_key: "priority",
    });
    expect(config.stack_by).toBeUndefined();
  });

  // Live-click-through regression: grouping a Chart by a Status property
  // 400'd at query time -- services/db/query/grouping.py's group_rows
  // requires an explicit mode="option" for status grouping (no default),
  // and this function never set one. DatabaseShell.tsx's Board-creation
  // special case already discovered and handles the identical requirement
  // (`if (groupProperty?.type === "status") groupBy.mode = "option"`);
  // this mirrors it for Chart's x_axis and stack_by.
  it("sets mode='option' on x_axis when the selected property is status-typed, so grouping doesn't 400", () => {
    const statusProp = prop({ key: "st1", name: "Status", type: "status" });
    const selectProp = prop({ key: "sel1", name: "Priority", type: "select" });
    const config = buildChartViewConfig(
      { ...DEFAULT_CHART_DRAFT, chart_type: "column", x_axis_property_key: "st1" },
      [statusProp, selectProp]
    );
    expect(config.x_axis).toEqual({ property_id: "st1", mode: "option" });
  });

  it("does not set mode on x_axis for select/multi_select — grouping.py needs none for those types", () => {
    const selectProp = prop({ key: "sel1", name: "Priority", type: "select" });
    const config = buildChartViewConfig(
      { ...DEFAULT_CHART_DRAFT, chart_type: "column", x_axis_property_key: "sel1" },
      [selectProp]
    );
    expect(config.x_axis).toEqual({ property_id: "sel1" });
  });

  it("sets mode='option' on stack_by too, when it's status-typed", () => {
    const statusProp = prop({ key: "st1", name: "Status", type: "status" });
    const selectProp = prop({ key: "sel1", name: "Priority", type: "select" });
    const config = buildChartViewConfig(
      {
        ...DEFAULT_CHART_DRAFT,
        chart_type: "column",
        x_axis_property_key: "sel1",
        stack_by_property_key: "st1",
      },
      [statusProp, selectProp]
    );
    expect(config.stack_by).toEqual({ property_id: "st1", mode: "option" });
  });

  it("omitting properties entirely (existing callers) never sets mode — backward compatible", () => {
    const config = buildChartViewConfig({
      ...DEFAULT_CHART_DRAFT,
      chart_type: "column",
      x_axis_property_key: "status",
    });
    expect(config.x_axis).toEqual({ property_id: "status" });
  });
});

// ── Component tests: ChartCreateFields ─────────────────────────────────

describe("ChartCreateFields", () => {
  const properties = [STATUS_PROP, PRIORITY_PROP, AMOUNT_PROP];

  it("stack_by's picker does not appear when chart_type === 'donut'", () => {
    render(
      <ChartCreateFields properties={properties} value={{ ...DEFAULT_CHART_DRAFT, chart_type: "donut" }} onChange={vi.fn()} />
    );
    expect(screen.queryByLabelText(/stack by/i)).not.toBeInTheDocument();
  });

  it("stack_by's picker DOES appear for a non-donut, non-number chart_type", () => {
    render(
      <ChartCreateFields properties={properties} value={{ ...DEFAULT_CHART_DRAFT, chart_type: "column" }} onChange={vi.fn()} />
    );
    expect(screen.getByLabelText(/stack by/i)).toBeInTheDocument();
  });

  it("x_axis/stack_by/hide-empty-groups controls are all absent for chart_type 'number'", () => {
    render(
      <ChartCreateFields properties={properties} value={{ ...DEFAULT_CHART_DRAFT, chart_type: "number" }} onChange={vi.fn()} />
    );
    expect(screen.queryByLabelText(/x-axis property/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/stack by/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/hide empty groups/i)).not.toBeInTheDocument();
  });

  it("the y-axis property picker only appears once a non-count aggregator is chosen", () => {
    const { rerender } = render(
      <ChartCreateFields properties={properties} value={DEFAULT_CHART_DRAFT} onChange={vi.fn()} />
    );
    expect(screen.queryByLabelText(/y-axis property/i)).not.toBeInTheDocument();
    rerender(
      <ChartCreateFields
        properties={properties}
        value={{ ...DEFAULT_CHART_DRAFT, y_axis_aggregator: "sum" }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByLabelText(/y-axis property/i)).toBeInTheDocument();
  });
});

// ── Component tests: ChartView ──────────────────────────────────────────

function groupsFixture(values: { key: string; label: string; y: number }[]): Group[] {
  return values.map((v) => ({
    key: v.key,
    label: v.label,
    row_count: 1,
    rows: [],
    subgroups: null,
    aggregates: { y: v.y },
  }));
}

const CHART_CONFIG_BASE = {
  x_axis: { property_id: "status" },
  y_axis: { aggregator: "count" },
};

describe("ChartView", () => {
  it.each(["column", "bar", "line", "donut"] as const)("chart_type=%s renders without crashing given a groups/aggregates fixture", (chartType) => {
    const groups = groupsFixture([
      { key: "todo", label: "To do", y: 3 },
      { key: "done", label: "Done", y: 5 },
    ]);
    render(
      <ChartView
        properties={[STATUS_PROP]}
        config={{ ...CHART_CONFIG_BASE, chart_type: chartType }}
        groups={groups}
        aggregates={null}
        editable={false}
      />
    );
    expect(screen.getByTestId("chart-view")).toBeInTheDocument();
  });

  it("chart_type='number' renders the single aggregate value correctly when no x_axis is configured", () => {
    render(
      <ChartView
        properties={[]}
        config={{ chart_type: "number", y_axis: { aggregator: "count" } }}
        groups={null}
        aggregates={{ y: 42 }}
        editable={false}
      />
    );
    expect(screen.getByTestId("chart-number-value")).toHaveTextContent("42");
  });

  it("stack_by + each of the 3 group_style values produce visibly different bar segment layouts", () => {
    const groups: Group[] = [
      {
        key: "todo",
        label: "To do",
        row_count: 2,
        rows: [],
        aggregates: { y: 40 },
        subgroups: [
          { key: "low", label: "Low", row_count: 1, rows: [], subgroups: null, aggregates: { y: 10 } },
          { key: "high", label: "High", row_count: 1, rows: [], subgroups: null, aggregates: { y: 30 } },
        ],
      },
    ];
    const baseConfig = {
      chart_type: "column" as const,
      x_axis: { property_id: "status" },
      y_axis: { aggregator: "count" },
      stack_by: { property_id: "priority" },
    };

    const { container: normalContainer } = render(
      <ChartView properties={[]} config={{ ...baseConfig, group_style: "normal" }} groups={groups} aggregates={null} editable={false} />
    );
    const normalRects = normalContainer.querySelectorAll("[data-testid^='chart-bar-todo-']");
    expect(normalRects).toHaveLength(2);
    // "normal": the "high" segment is stacked on top of "low" -> nonzero y-offset.
    const normalHigh = normalContainer.querySelector("[data-testid='chart-bar-todo-high']")!;
    const normalLow = normalContainer.querySelector("[data-testid='chart-bar-todo-low']")!;
    expect(Number(normalHigh.getAttribute("y"))).toBeLessThan(Number(normalLow.getAttribute("y")));

    const { container: percentContainer } = render(
      <ChartView properties={[]} config={{ ...baseConfig, group_style: "percent" }} groups={groups} aggregates={null} editable={false} />
    );
    const percentLow = percentContainer.querySelector("[data-testid='chart-bar-todo-low']")!;
    const percentHigh = percentContainer.querySelector("[data-testid='chart-bar-todo-high']")!;
    // percent mode: low is 25% of the group total, high is 75% — their
    // heights are in a 1:3 ratio, unlike normal mode's raw 10 vs 30 (also
    // 1:3 numerically, but scaled against the *whole chart's* max, not
    // normalized per-group) — the two modes' pixel heights differ because
    // percent always fills to a 100-based scale regardless of other groups.
    expect(Number(percentHigh.getAttribute("height"))).toBeGreaterThan(Number(percentLow.getAttribute("height")));

    const { container: sideContainer } = render(
      <ChartView properties={[]} config={{ ...baseConfig, group_style: "side_by_side" }} groups={groups} aggregates={null} editable={false} />
    );
    const sideLow = sideContainer.querySelector("[data-testid='chart-bar-todo-low']")!;
    const sideHigh = sideContainer.querySelector("[data-testid='chart-bar-todo-high']")!;
    // side_by_side: both bars sit on the baseline (same y + height => same
    // bottom edge), unlike normal's stacking above.
    const sideLowBottom = Number(sideLow.getAttribute("y")) + Number(sideLow.getAttribute("height"));
    const sideHighBottom = Number(sideHigh.getAttribute("y")) + Number(sideHigh.getAttribute("height"));
    expect(sideLowBottom).toBeCloseTo(sideHighBottom, 5);
    // And they occupy different x-slots (not stacked on top of each other).
    expect(sideLow.getAttribute("x")).not.toBe(sideHigh.getAttribute("x"));
  });

  it("reference lines: a column chart draws a horizontal <line> at the value's y-position on the shared scale", () => {
    const groups = groupsFixture([
      { key: "a", label: "A", y: 10 },
      { key: "b", label: "B", y: 100 },
    ]);
    const { container } = render(
      <ChartView
        properties={[]}
        config={{
          chart_type: "column",
          x_axis: { property_id: "status" },
          y_axis: { aggregator: "count" },
          reference_lines: [{ id: "target", value: 50, label: "Target", color: "#ef4444", dash_style: "dash" }],
        }}
        groups={groups}
        aggregates={null}
        editable={false}
      />
    );
    const refLine = container.querySelector("[data-testid='chart-refline-target'] line")!;
    // Shared scale: max=100 over PLOT_H=240 (H=320 - 2*PAD=40) -> value 50 is
    // exactly half-way up -> y = 120. A horizontal line has y1 === y2.
    expect(refLine.getAttribute("y1")).toBe(refLine.getAttribute("y2"));
    expect(Number(refLine.getAttribute("y1"))).toBeCloseTo(120, 5);
  });

  it("reference lines: a bar (horizontal) chart draws a VERTICAL line at the value's x-position, not reusing column's y-position math", () => {
    const groups = groupsFixture([
      { key: "a", label: "A", y: 10 },
      { key: "b", label: "B", y: 100 },
    ]);
    const { container } = render(
      <ChartView
        properties={[]}
        config={{
          chart_type: "bar",
          x_axis: { property_id: "status" },
          y_axis: { aggregator: "count" },
          reference_lines: [{ id: "target", value: 50, label: "Target", color: "#ef4444", dash_style: "solid" }],
        }}
        groups={groups}
        aggregates={null}
        editable={false}
      />
    );
    const refLine = container.querySelector("[data-testid='chart-refline-target'] line")!;
    // Vertical line: x1 === x2, and (unlike the column case) y1 !== y2.
    expect(refLine.getAttribute("x1")).toBe(refLine.getAttribute("x2"));
    expect(refLine.getAttribute("y1")).not.toBe(refLine.getAttribute("y2"));
    // Same shared scale (max=100 over PLOT_W=560) -> value 50 is half-way -> x = 280.
    expect(Number(refLine.getAttribute("x1"))).toBeCloseTo(280, 5);
  });

  it("column chart bars vary in HEIGHT (fixed width) — not swapped with bar's orientation", () => {
    const groups = groupsFixture([
      { key: "a", label: "A", y: 10 },
      { key: "b", label: "B", y: 50 },
    ]);
    const { container } = render(
      <ChartView
        properties={[]}
        config={{ chart_type: "column", x_axis: { property_id: "status" }, y_axis: { aggregator: "count" } }}
        groups={groups}
        aggregates={null}
        editable={false}
      />
    );
    const barA = container.querySelector("[data-testid='chart-bar-a']")!;
    const barB = container.querySelector("[data-testid='chart-bar-b']")!;
    expect(barA.getAttribute("width")).toBe(barB.getAttribute("width"));
    expect(barA.getAttribute("height")).not.toBe(barB.getAttribute("height"));
  });

  it("bar chart bars vary in WIDTH (fixed height) — the swapped-from-intuitive Notion naming", () => {
    const groups = groupsFixture([
      { key: "a", label: "A", y: 10 },
      { key: "b", label: "B", y: 50 },
    ]);
    const { container } = render(
      <ChartView
        properties={[]}
        config={{ chart_type: "bar", x_axis: { property_id: "status" }, y_axis: { aggregator: "count" } }}
        groups={groups}
        aggregates={null}
        editable={false}
      />
    );
    const barA = container.querySelector("[data-testid='chart-bar-a']")!;
    const barB = container.querySelector("[data-testid='chart-bar-b']")!;
    expect(barA.getAttribute("height")).toBe(barB.getAttribute("height"));
    expect(barA.getAttribute("width")).not.toBe(barB.getAttribute("width"));
  });

  it("hide_empty_groups is passed straight through to the rendered chart's underlying groups (server already filtered them)", () => {
    // Server-side filtering (task-15/M6) already dropped empty groups from
    // the response by the time ChartView sees it — this just confirms
    // ChartView renders exactly the groups it's given, adding no client-side
    // filter of its own that could double-apply or contradict the server.
    const groups = groupsFixture([{ key: "todo", label: "To do", y: 3 }]);
    const { container } = render(
      <ChartView
        properties={[]}
        config={{
          chart_type: "column",
          x_axis: { property_id: "status" },
          y_axis: { aggregator: "count" },
          hide_empty_groups: true,
        }}
        groups={groups}
        aggregates={null}
        editable={false}
      />
    );
    expect(container.querySelectorAll("[data-testid^='chart-bar-']")).toHaveLength(1);
  });

  it("no onCellChange call is ever reachable from any interaction in this component", () => {
    const onCellChange = vi.fn();
    const groups = groupsFixture([
      { key: "todo", label: "To do", y: 3 },
      { key: "done", label: "Done", y: 5 },
    ]);
    const { container } = render(
      <ChartView
        properties={[]}
        config={{ chart_type: "column", x_axis: { property_id: "status" }, y_axis: { aggregator: "count" } }}
        groups={groups}
        aggregates={null}
        editable={true}
        onCellChange={onCellChange}
      />
    );
    container.querySelectorAll("rect, path, circle, svg, text").forEach((el) => {
      fireEvent.click(el);
    });
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it("data-editable reflects whatever the caller passes (DatabaseShell forces this to false — see DatabaseShell.test.tsx)", () => {
    const groups = groupsFixture([{ key: "todo", label: "To do", y: 3 }]);
    render(
      <ChartView
        properties={[]}
        config={{ chart_type: "column", x_axis: { property_id: "status" }, y_axis: { aggregator: "count" } }}
        groups={groups}
        aggregates={null}
        editable={false}
      />
    );
    expect(screen.getByTestId("chart-view")).toHaveAttribute("data-editable", "false");
  });
});
