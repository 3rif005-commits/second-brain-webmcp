"use client";

// Chart view (Milestone 10, task-35) — hand-written inline SVG, no charting
// dependency (docs/plans/2026-08-08-notion-databases.md, M10's own hard
// constraint). Consumes `groups`/`aggregates` from `useDatabaseView` the
// same way BoardView consumes `groups` — this component never fetches or
// re-derives grouping/aggregation client-side, task-32's `POST .../query`
// (`aggregations`/`GroupResult.aggregates`) already did that work.
//
// Scope ruling (task-35-brief.md, made explicit rather than silently cut):
// research §9.2 documents two data modes, "Grouped data" (x_axis group-by +
// y_axis aggregation) and "Results" (raw per-row values, no aggregation).
// This component only implements Grouped-data mode — every plan-named test
// case (y-axis aggregator, stack_by, group_style, hide_empty_groups) only
// makes sense there, and Results mode would need its own zero-aggregation
// data-fetching path this task never builds.
//
// Read-only, explicitly (research §9.8: "you can't edit database entries
// from chart view"): DatabaseShell.tsx passes `editable={false}`
// unconditionally (unlike every other view, which threads through the
// caller's real editable state) and never wires a real `onCellChange` —
// see this file's `ChartViewProps.onCellChange` doc for why the prop still
// exists on the type. There is no click-to-edit, no drilldown-to-table-view
// (research documents drilldown; explicitly out of scope, not in the
// plan's test-case list) anywhere in this component's render tree.
//
// Out of scope, deliberately (zero test-case coverage in the plan, pure
// presentation): `color_theme`, `height`, `grid_lines`, `axis_labels`,
// `show_data_labels`, `smooth_line`, `hide_line_fill_area`,
// `color_by_value`, `legend_position`, `donut_labels`, `y_axis_min`/`max`,
// `caption`, `hide_title`. Each chart type renders with one sensible,
// legible default appearance instead.
import type { ReactNode } from "react";
import type { PropertyResponse, PropertyValue } from "@/lib/database/types";
import {
  CHART_TYPES,
  CHART_Y_AXIS_AGGREGATORS,
  defaultGroupMode,
  GROUPABLE_PROPERTY_TYPES,
  getChartGroupStyle,
  getChartHideEmptyGroups,
  getChartReferenceLines,
  getChartStackBy,
  getChartType,
  getChartXAxis,
  getChartYAxis,
} from "@/lib/database/types";
import type { ChartGroupStyle, ChartReferenceLine, ChartType, Group } from "@/lib/database/types";

// ── Pure math: stacking layout, donut arcs, the shared value→pixel scale ──
// Kept separate from the rendering components below so the milestone's own
// named test cases (group_style normalization, donut arc angles,
// reference-line y-position) are directly unit-testable against known
// numbers, without rendering SVG or simulating any DOM interaction.

export interface StackSegment {
  key: string;
  value: number;
  /** 0-based position within the group's subgroup order — the lateral slot
   * index a "side_by_side" renderer places this segment's own small bar
   * into (unused for "normal"/"percent", which stack instead of laying out
   * side by side). */
  index: number;
  /** Cumulative offset (in the same units as `size`) before this segment.
   * Always `0` for "side_by_side" (nothing stacks); cumulative for
   * "normal"/"percent". */
  offset: number;
  /** This segment's own height/length. Raw value for "normal"/
   * "side_by_side"; `value` normalized to a 0-100 percent-of-group-total
   * for "percent". */
  size: number;
}

/** `config.group_style`'s rendering math (task-35-brief.md §1's ruling:
 * pure client-side math over already-aggregated per-subgroup values, no new
 * backend field) —
 *  - "normal": segments stack to their raw sum per x-group.
 *  - "percent": each segment is `value / sum(this group's subgroup values)`,
 *    normalized so the full stack is always exactly 100.
 *  - "side_by_side": each subgroup gets its own bar (`offset` stays 0,
 *    `index` positions it laterally) rather than stacking. */
export function computeStackLayout(
  values: { key: string; value: number }[],
  groupStyle: ChartGroupStyle
): StackSegment[] {
  if (groupStyle === "percent") {
    const total = values.reduce((sum, v) => sum + v.value, 0);
    let offset = 0;
    return values.map((v, index) => {
      const size = total > 0 ? (v.value / total) * 100 : 0;
      const seg: StackSegment = { key: v.key, value: v.value, index, offset, size };
      offset += size;
      return seg;
    });
  }
  let offset = 0;
  return values.map((v, index) => {
    const seg: StackSegment = {
      key: v.key,
      value: v.value,
      index,
      offset: groupStyle === "side_by_side" ? 0 : offset,
      size: v.value,
    };
    if (groupStyle !== "side_by_side") offset += v.value;
    return seg;
  });
}

export interface DonutSlice {
  key: string;
  value: number;
  /** Radians. `0` is the 3-o'clock position, sweeping clockwise (SVG's own
   * y-down convention) — an arbitrary but fixed starting point; only the
   * sweep magnitude (`endAngle - startAngle`) is load-bearing for the
   * "value fraction → angle" math this exists to get right. */
  startAngle: number;
  endAngle: number;
}

/** Donut slice sizing: each slice's sweep is its value's fraction of the
 * total, times a full turn (2π). 4 equal values → 4 exact quarter-circle
 * (π/2) sweeps — the milestone's own named test case. */
export function computeDonutSlices(values: { key: string; value: number }[]): DonutSlice[] {
  const total = values.reduce((sum, v) => sum + v.value, 0);
  let angle = 0;
  return values.map((v) => {
    const sweep = total > 0 ? (v.value / total) * 2 * Math.PI : 0;
    const slice: DonutSlice = { key: v.key, value: v.value, startAngle: angle, endAngle: angle + sweep };
    angle += sweep;
    return slice;
  });
}

function arcPoint(cx: number, cy: number, r: number, angle: number): [number, number] {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

/** SVG path `d` for one donut ring segment (outer arc out, straight edge in,
 * inner arc back, close) — the "nested `<circle>` + `stroke-dasharray`"
 * alternative task-35-brief.md also allows works fine for a single ring but
 * gets awkward once slices need distinct fill colors with crisp edges, so
 * this uses an explicit arc path instead. */
export function donutArcPath(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  startAngle: number,
  endAngle: number
): string {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const [x1o, y1o] = arcPoint(cx, cy, rOuter, startAngle);
  const [x2o, y2o] = arcPoint(cx, cy, rOuter, endAngle);
  const [x2i, y2i] = arcPoint(cx, cy, rInner, endAngle);
  const [x1i, y1i] = arcPoint(cx, cy, rInner, startAngle);
  return [
    `M ${x1o} ${y1o}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2o} ${y2o}`,
    `L ${x2i} ${y2i}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x1i} ${y1i}`,
    "Z",
  ].join(" ");
}

export interface ChartScale {
  /** The scale's upper bound (its lower bound is always 0 — every
   * aggregator this milestone charts is non-negative in practice, and
   * Notion's own bar/line/donut charts never show a negative axis either). */
  max: number;
  pxHeight: number;
}

/** Built once from every value that will be plotted (bar/point heights AND
 * reference lines together — task-35-brief.md §3's explicit "compute the
 * shared scale once, reuse it for both, don't derive two inconsistent
 * scales"), so a reference line always lands at the same pixel position a
 * data value of the same number would. */
export function computeYScale(values: number[], pxHeight: number): ChartScale {
  const max = values.length ? Math.max(...values, 0) : 0;
  return { max: max > 0 ? max : 1, pxHeight };
}

/** SVG y-coordinate (0 at top) for a data value against `scale`. */
export function valueToY(value: number, scale: ChartScale): number {
  return scale.pxHeight - (value / scale.max) * scale.pxHeight;
}

/** Pixel height/length for a data value against `scale` — `pxHeight -
 * valueToY`, kept as its own function so bar-rendering code reads as "this
 * bar's size" rather than re-deriving it from a y-coordinate every time. */
export function valueToSize(value: number, scale: ChartScale): number {
  return (value / scale.max) * scale.pxHeight;
}

// ── Creation-time config (ViewTabs.tsx renders `ChartCreateFields` inline
// when `type === "chart"`) ─────────────────────────────────────────────────
// Kept here rather than inlined into ViewTabs.tsx: Chart's config is
// genuinely richer than every other view's single-property-pick creation UI
// (Board/Calendar/Timeline), so its own semantics (what's required, what
// `donut` excludes) belong next to the type/rendering code that has to stay
// in sync with it, not duplicated into the generic view-creation form.

export interface ChartDraftConfig {
  chart_type: ChartType;
  x_axis_property_key: string;
  y_axis_aggregator: string;
  y_axis_property_key: string;
  /** `""` means "no stacking" — never offered at all when chart_type is
   * "donut" (research §9.6 has no stacking concept for a donut). */
  stack_by_property_key: string;
  hide_empty_groups: boolean;
}

export const DEFAULT_CHART_DRAFT: ChartDraftConfig = {
  chart_type: "column",
  x_axis_property_key: "",
  y_axis_aggregator: "count",
  y_axis_property_key: "",
  stack_by_property_key: "",
  hide_empty_groups: false,
};

/** Board's `canSubmit`-gated pattern (ViewTabs.tsx): don't let a chart be
 * created that would render nothing. `chart_type` always has a default so
 * it's never the blocker in practice; the real gates are y_axis (a
 * non-count aggregator needs a property) and x_axis (required for every
 * type except "number"). */
export function isChartConfigComplete(draft: ChartDraftConfig): boolean {
  if (draft.y_axis_aggregator !== "count" && !draft.y_axis_property_key) return false;
  if (draft.chart_type !== "number" && !draft.x_axis_property_key) return false;
  return true;
}

/** Assembles the view's `config` JSONB from a completed draft — Notion's
 * own field names (`x_axis`/`y_axis`/`stack_by`, each carrying
 * `property_id`), per this task's "config shape" section. Only ever called
 * once `isChartConfigComplete` is true (ViewTabs.tsx's `canSubmit` gate).
 *
 * `properties` is used to derive each x_axis/stack_by selection's required
 * `mode`: `services/db/query/grouping.py`'s `group_rows` requires an
 * explicit `mode` for several types (status, date-family, text-family) —
 * the same requirement Board's own group_by creation (`DatabaseShell.tsx`'s
 * `handleCreateView`) and the column header menu's "Group" row handle via
 * `defaultGroupMode` (types.ts, Phase 0c) — mirrored here (adapted to this
 * config's own `property_id` field name, not `GroupBySpec`'s `property_key`)
 * so a Chart grouped by any of them doesn't 400 at query time. Passing
 * `properties=[]` (or omitting it) skips this detection, matching every
 * other caller before this fix — never a fatal default, just a grouping
 * that would 400 the same way Board's did before Task 16 added its own
 * check. */
export function buildChartViewConfig(
  draft: ChartDraftConfig,
  properties: PropertyResponse[] = []
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    chart_type: draft.chart_type,
    y_axis:
      draft.y_axis_aggregator === "count"
        ? { aggregator: "count" }
        : { aggregator: draft.y_axis_aggregator, property_id: draft.y_axis_property_key },
  };
  if (draft.chart_type !== "number") {
    const xAxis: Record<string, unknown> = { property_id: draft.x_axis_property_key };
    const xMode = defaultGroupMode(properties.find((p) => p.key === draft.x_axis_property_key)?.type ?? "");
    if (xMode) xAxis.mode = xMode;
    config.x_axis = xAxis;
    config.hide_empty_groups = draft.hide_empty_groups;
    if (draft.chart_type !== "donut" && draft.stack_by_property_key) {
      const stackBy: Record<string, unknown> = { property_id: draft.stack_by_property_key };
      const stackMode = defaultGroupMode(
        properties.find((p) => p.key === draft.stack_by_property_key)?.type ?? ""
      );
      if (stackMode) stackBy.mode = stackMode;
      config.stack_by = stackBy;
    }
  }
  return config;
}

const CHART_TYPE_LABELS: Record<ChartType, string> = {
  column: "Column (vertical bars)",
  bar: "Bar (horizontal bars)",
  line: "Line",
  donut: "Donut",
  number: "Number",
};

const SELECT_CLASS =
  "text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100";

/** x_axis/stack_by property pickers are restricted to `GROUPABLE_PROPERTY_
 * TYPES` (select/status/multi_select) — the same restriction Board's own
 * "group by" picker already uses (ViewTabs.tsx), deliberately, not an
 * oversight: `services.db.query.grouping.group_rows` actually supports
 * grouping by several more types (date, number, text, ...), each needing
 * its own `mode`/range/bucketing sub-UI this task doesn't build. See
 * task-35-report.md's judgment-call note. */
export function ChartCreateFields({
  properties,
  value,
  onChange,
}: {
  properties: PropertyResponse[];
  value: ChartDraftConfig;
  onChange: (next: ChartDraftConfig) => void;
}) {
  const axisProperties = properties.filter((p) =>
    (GROUPABLE_PROPERTY_TYPES as readonly string[]).includes(p.type)
  );
  const needsXAxis = value.chart_type !== "number";

  return (
    <>
      <select
        aria-label="Chart type"
        value={value.chart_type}
        onChange={(e) => onChange({ ...value, chart_type: e.target.value as ChartType })}
        className={SELECT_CLASS}
      >
        {CHART_TYPES.map((t) => (
          <option key={t} value={t}>
            {CHART_TYPE_LABELS[t]}
          </option>
        ))}
      </select>

      <select
        aria-label="Y-axis aggregator"
        value={value.y_axis_aggregator}
        onChange={(e) => onChange({ ...value, y_axis_aggregator: e.target.value })}
        className={SELECT_CLASS}
      >
        {CHART_Y_AXIS_AGGREGATORS.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>

      {value.y_axis_aggregator !== "count" && (
        <select
          aria-label="Y-axis property"
          value={value.y_axis_property_key}
          onChange={(e) => onChange({ ...value, y_axis_property_key: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">Property…</option>
          {properties.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      )}

      {needsXAxis &&
        (axisProperties.length === 0 ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            no groupable property yet — add a Select, Status, or Multi-select property first
          </span>
        ) : (
          <select
            aria-label="X-axis property"
            value={value.x_axis_property_key}
            onChange={(e) => onChange({ ...value, x_axis_property_key: e.target.value })}
            className={SELECT_CLASS}
          >
            <option value="">X-axis…</option>
            {axisProperties.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        ))}

      {/* research §9.6: donut has no stacking concept — no picker at all,
       * not shown-disabled. */}
      {needsXAxis && value.chart_type !== "donut" && axisProperties.length > 0 && (
        <select
          aria-label="Stack by"
          value={value.stack_by_property_key}
          onChange={(e) => onChange({ ...value, stack_by_property_key: e.target.value })}
          className={SELECT_CLASS}
        >
          <option value="">No stacking</option>
          {axisProperties.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      )}

      {needsXAxis && (
        <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
          <input
            type="checkbox"
            checked={value.hide_empty_groups}
            onChange={(e) => onChange({ ...value, hide_empty_groups: e.target.checked })}
          />
          Hide empty groups
        </label>
      )}
    </>
  );
}

// ── Rendering ───────────────────────────────────────────────────────────

interface ChartDatum {
  key: string;
  label: string;
  value: number;
  subgroups?: { key: string; label: string; value: number }[];
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-full text-sm text-gray-400 dark:text-gray-500 text-center px-6">
      {text}
    </div>
  );
}

const W = 640;
const H = 320;
const PAD = 40;
const PLOT_W = W - PAD * 2;
const PLOT_H = H - PAD * 2;

/** `axis="y"` (column/line — value grows upward, `<line>` runs horizontally
 * at the value's y-position) vs. `axis="x"` (bar — value grows rightward
 * from x=0, same as `BarChart`'s own horizontal-orientation bars, so the
 * reference line has to run *vertically* at the value's x-position, not
 * reuse `valueToY`'s y-coordinate math). Both share the one `scale` the
 * caller built from bars/points AND reference lines together (task-35-
 * brief.md §3's "compute the shared scale once, reuse it for both"). */
function ReferenceLines({
  referenceLines,
  scale,
  axis,
}: {
  referenceLines: ChartReferenceLine[];
  scale: ChartScale;
  axis: "y" | "x";
}) {
  return (
    <>
      {referenceLines.map((line) => {
        const pos = axis === "y" ? valueToY(line.value, scale) : valueToSize(line.value, scale);
        const dash = line.dash_style === "dash" ? "4 4" : undefined;
        return (
          <g key={line.id} data-testid={`chart-refline-${line.id}`}>
            {axis === "y" ? (
              <line x1={0} x2={PLOT_W} y1={pos} y2={pos} stroke={line.color} strokeWidth={1.5} strokeDasharray={dash} />
            ) : (
              <line x1={pos} x2={pos} y1={0} y2={PLOT_H} stroke={line.color} strokeWidth={1.5} strokeDasharray={dash} />
            )}
            <text
              x={axis === "y" ? PLOT_W : pos}
              y={axis === "y" ? pos - 4 : 10}
              fontSize={9}
              textAnchor={axis === "y" ? "end" : "middle"}
              fill={line.color}
            >
              {line.label}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** column (vertical, height encodes value) / bar (horizontal, width encodes
 * value) — task-35-brief.md's own flagged gotcha: getting `orientation`
 * backwards renders every column chart sideways and vice versa, so which
 * SVG attribute (`height` vs `width`) carries the data value is the one
 * thing this function must never get swapped. */
function BarChart({
  data,
  orientation,
  stacked,
  groupStyle,
  referenceLines,
}: {
  data: ChartDatum[];
  orientation: "vertical" | "horizontal";
  stacked: boolean;
  groupStyle: ChartGroupStyle;
  referenceLines: ChartReferenceLine[];
}) {
  const mainAxisLength = orientation === "vertical" ? PLOT_W : PLOT_H;
  const crossAxisLength = orientation === "vertical" ? PLOT_H : PLOT_W;
  const slotSize = mainAxisLength / Math.max(data.length, 1);
  const thickness = slotSize * 0.6;

  const allValues: number[] = [];
  const perGroupSegments = data.map((g) => {
    if (stacked && g.subgroups) {
      const segs = computeStackLayout(
        g.subgroups.map((sg) => ({ key: sg.key, value: sg.value })),
        groupStyle
      );
      if (groupStyle === "percent") {
        allValues.push(100);
      } else if (groupStyle === "normal") {
        allValues.push(segs.reduce((sum, seg) => sum + seg.size, 0));
      } else {
        segs.forEach((seg) => allValues.push(seg.size));
      }
      return segs;
    }
    allValues.push(g.value);
    return null;
  });
  referenceLines.forEach((l) => allValues.push(l.value));
  const scale = computeYScale(allValues, crossAxisLength);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Chart" className="w-full h-full">
      <g transform={`translate(${PAD},${PAD})`}>
        <line x1={0} y1={PLOT_H} x2={PLOT_W} y2={PLOT_H} stroke="currentColor" strokeOpacity={0.2} />
        {data.map((g, i) => {
          const slotStart = i * slotSize;
          const segs = perGroupSegments[i];

          if (!segs) {
            const size = valueToSize(g.value, scale);
            const rectProps =
              orientation === "vertical"
                ? {
                    x: slotStart + (slotSize - thickness) / 2,
                    y: PLOT_H - size,
                    width: thickness,
                    height: size,
                  }
                : {
                    x: 0,
                    y: slotStart + (slotSize - thickness) / 2,
                    width: size,
                    height: thickness,
                  };
            return (
              <rect
                key={g.key}
                data-testid={`chart-bar-${g.key}`}
                className="fill-indigo-500"
                {...rectProps}
              />
            );
          }

          if (groupStyle === "side_by_side") {
            const segThickness = thickness / Math.max(segs.length, 1);
            return segs.map((seg) => {
              const size = valueToSize(seg.size, scale);
              const rectProps =
                orientation === "vertical"
                  ? {
                      x: slotStart + (slotSize - thickness) / 2 + seg.index * segThickness,
                      y: PLOT_H - size,
                      width: segThickness,
                      height: size,
                    }
                  : {
                      x: 0,
                      y: slotStart + (slotSize - thickness) / 2 + seg.index * segThickness,
                      width: size,
                      height: segThickness,
                    };
              return (
                <rect
                  key={`${g.key}:${seg.key}`}
                  data-testid={`chart-bar-${g.key}-${seg.key}`}
                  className="fill-indigo-500"
                  opacity={0.55 + 0.45 * (seg.index % 2)}
                  {...rectProps}
                />
              );
            });
          }

          // "normal" / "percent": stacked segments.
          return segs.map((seg) => {
            const offsetPx = valueToSize(seg.offset, scale);
            const sizePx = valueToSize(seg.size, scale);
            const rectProps =
              orientation === "vertical"
                ? {
                    x: slotStart + (slotSize - thickness) / 2,
                    y: PLOT_H - offsetPx - sizePx,
                    width: thickness,
                    height: sizePx,
                  }
                : {
                    x: offsetPx,
                    y: slotStart + (slotSize - thickness) / 2,
                    width: sizePx,
                    height: thickness,
                  };
            return (
              <rect
                key={`${g.key}:${seg.key}`}
                data-testid={`chart-bar-${g.key}-${seg.key}`}
                className="fill-indigo-500"
                opacity={0.55 + 0.45 * (seg.index % 2)}
                {...rectProps}
              />
            );
          });
        })}
        <ReferenceLines referenceLines={referenceLines} scale={scale} axis={orientation === "vertical" ? "y" : "x"} />
      </g>
    </svg>
  );
}

function LineChart({ data, referenceLines }: { data: ChartDatum[]; referenceLines: ChartReferenceLine[] }) {
  const scale = computeYScale(
    [...data.map((d) => d.value), ...referenceLines.map((l) => l.value)],
    PLOT_H
  );
  const stepX = data.length > 1 ? PLOT_W / (data.length - 1) : 0;
  const points = data.map((d, i) => `${i * stepX},${valueToY(d.value, scale)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Chart" className="w-full h-full">
      <g transform={`translate(${PAD},${PAD})`}>
        <line x1={0} y1={PLOT_H} x2={PLOT_W} y2={PLOT_H} stroke="currentColor" strokeOpacity={0.2} />
        <polyline data-testid="chart-line" points={points} fill="none" stroke="currentColor" strokeWidth={2} />
        {data.map((d, i) => (
          <circle
            key={d.key}
            data-testid={`chart-point-${d.key}`}
            cx={i * stepX}
            cy={valueToY(d.value, scale)}
            r={3}
            className="fill-indigo-500"
          />
        ))}
        <ReferenceLines referenceLines={referenceLines} scale={scale} axis="y" />
      </g>
    </svg>
  );
}

const DONUT_COLORS = [
  "#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4",
  "#a855f7", "#ec4899", "#84cc16", "#0ea5e9", "#f97316",
];

function DonutChart({ data }: { data: ChartDatum[] }) {
  const size = 280;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 10;
  const rInner = rOuter * 0.6;
  const slices = computeDonutSlices(data.map((d) => ({ key: d.key, value: d.value })));

  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Donut chart" className="max-h-full max-w-full">
      {slices.map((s, i) => (
        <path
          key={s.key}
          data-testid={`chart-slice-${s.key}`}
          d={donutArcPath(cx, cy, rOuter, rInner, s.startAngle, s.endAngle)}
          fill={DONUT_COLORS[i % DONUT_COLORS.length]}
        />
      ))}
    </svg>
  );
}

function NumberChart({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-1">
      <div data-testid="chart-number-value" className="text-5xl font-semibold text-gray-900 dark:text-gray-100">
        {value === null ? "—" : value.toLocaleString()}
      </div>
      {label && <div className="text-sm text-gray-400 dark:text-gray-500">{label}</div>}
    </div>
  );
}

interface ChartViewProps {
  properties: PropertyResponse[];
  config: Record<string, unknown>;
  /** `null` while the query for a grouped chart_type hasn't resolved yet
   * (or the view has no x_axis configured). Unused for chart_type
   * "number" — see `aggregates` below. */
  groups: Group[] | null;
  /** The ungrouped, whole-row-set aggregate (`QueryResponse.aggregates`,
   * task-32) — Chart's "number" mode reads `aggregates?.y` from here. Unused
   * for every other chart_type (they read `groups[].aggregates.y` instead). */
  aggregates: Record<string, number> | null;
  editable: boolean;
  /** Optional, purely for interface parity with every other view component
   * (TableView/BoardView/...). Chart is read-only for data by design
   * (research §9.8) — `DatabaseShell.tsx`'s "chart" case never actually
   * passes this, and nothing in this component's render tree (no
   * click-to-edit, no drilldown) has a code path that could call it even if
   * a caller did supply one — see `ChartView.test.tsx`'s "no onCellChange
   * call is ever reachable" test, which passes a mock directly and proves
   * it's never invoked. */
  onCellChange?: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
}

export function ChartView({ properties, config, groups, aggregates, editable }: ChartViewProps) {
  const chartType = getChartType(config);
  const yAxis = getChartYAxis(config);
  const xAxis = getChartXAxis(config);
  const stackBySpec = getChartStackBy(config);
  const groupStyle = getChartGroupStyle(config);
  const referenceLines = getChartReferenceLines(config);
  const yAxisProperty = yAxis?.property_id ? properties.find((p) => p.key === yAxis.property_id) : undefined;
  const yAxisLabel = yAxis ? `${yAxis.aggregator}${yAxisProperty ? ` of ${yAxisProperty.name}` : ""}` : "";

  let body: ReactNode;

  if (!yAxis) {
    body = <Placeholder text="no y-axis configured yet" />;
  } else if (chartType === "number") {
    const value = typeof aggregates?.y === "number" ? aggregates.y : null;
    body = <NumberChart value={value} label={yAxisLabel} />;
  } else if (!xAxis) {
    body = <Placeholder text="no x-axis configured yet" />;
  } else if (groups === null) {
    body = <Placeholder text="Loading…" />;
  } else {
    const data: ChartDatum[] = groups.map((g) => ({
      key: g.key,
      label: g.label,
      value: typeof g.aggregates?.y === "number" ? g.aggregates.y : 0,
      subgroups: g.subgroups?.map((sg) => ({
        key: sg.key,
        label: sg.label,
        value: typeof sg.aggregates?.y === "number" ? sg.aggregates.y : 0,
      })),
    }));
    const stacked = Boolean(stackBySpec) && chartType !== "donut";

    switch (chartType) {
      case "column":
        body = <BarChart data={data} orientation="vertical" stacked={stacked} groupStyle={groupStyle} referenceLines={referenceLines} />;
        break;
      case "bar":
        body = <BarChart data={data} orientation="horizontal" stacked={stacked} groupStyle={groupStyle} referenceLines={referenceLines} />;
        break;
      case "line":
        body = <LineChart data={data} referenceLines={referenceLines} />;
        break;
      case "donut":
        body = <DonutChart data={data} />;
        break;
      default:
        body = <Placeholder text="unsupported chart type" />;
    }
  }

  // `data-editable` is a test hook, not an interactive affordance — this
  // component has no write path regardless of the value it's given (see
  // `ChartViewProps.editable`'s doc); it exists solely so
  // `DatabaseShell.test.tsx` can assert the one place Chart diverges from
  // every other view (`editable={false}` forced unconditionally) without
  // depending on the real config-driven `useDatabaseView` hook.
  return (
    <div data-testid="chart-view" data-editable={String(editable)} className="h-full flex items-center justify-center p-4">
      {body}
    </div>
  );
}
