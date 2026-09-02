import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// ListView (task-17) navigates via next/navigation's useRouter — outside a
// real Next.js app router tree (as here, a plain RTL render) that throws
// "invariant expected app router to be mounted" unless mocked, same as
// DatabaseShell.test.tsx / ListView.test.tsx already do. M12: ListView now
// also reads/writes the row peek's `?p=&pm=` via `useRowPeek`
// (usePathname/useSearchParams/router.replace) when embedded as a
// dashboard widget — mocked the same no-op way as useRouter above.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/brain/db/ds-1",
  useSearchParams: () => new URLSearchParams(),
}));

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { DashboardView, readDashboardRows, DASHBOARD_MAX_WIDGETS_PER_ROW, DASHBOARD_MAX_WIDGETS_TOTAL } from "./DashboardView";
import type { DashboardRow } from "./DashboardView";
import type { PropertyResponse, ViewResponse } from "@/lib/database/types";

afterEach(() => {
  showToast.mockClear();
  vi.unstubAllGlobals();
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

function view(overrides: Partial<ViewResponse>): ViewResponse {
  return {
    id: "v1",
    data_source_id: "ds-1",
    user_id: "user-1",
    name: "View",
    icon: null,
    type: "table",
    config: {},
    filter: null,
    sorts: [],
    is_locked: false,
    position: 0,
    ...overrides,
  };
}

const TITLE_PROP = prop({ key: "title", name: "Title", type: "title", position: 0 });

const DASHBOARD_VIEW = view({ id: "dash-1", name: "Dashboard", type: "dashboard", config: {} });

/** Generic fetch mock for `/api/db/data-sources/{id}/query`: returns a
 * `groups` response when the request body carries `aggregations` (a Chart
 * widget's own query shape, per `getQueryExtras`), a plain `rows` response
 * otherwise — deterministic regardless of which widget's effect fires
 * first, unlike a call-order-based mock would be. */
function makeQueryFetchMock(rowsTitle = "Row") {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (Array.isArray(body.aggregations)) {
      return new Response(
        JSON.stringify({ groups: [{ key: "a", label: "A", row_count: 1, rows: [], subgroups: null, aggregates: { y: 3 } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(
      JSON.stringify({ rows: [{ id: "row-1", properties: { title: { type: "title", title: rowsTitle } } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });
}

function buildWidgets(count: number, viewId: string, widthEach = 3) {
  return Array.from({ length: count }, (_, i) => ({ id: `w-${viewId}-${i}`, view_id: viewId, width: widthEach }));
}

describe("readDashboardRows", () => {
  it("tolerates a missing/malformed config.rows shape (empty array, never a throw)", () => {
    expect(readDashboardRows({})).toEqual([]);
    expect(readDashboardRows({ rows: "not an array" })).toEqual([]);
    expect(readDashboardRows({ rows: [{ widgets: "nope" }] })).toEqual([
      expect.objectContaining({ widgets: [] }),
    ]);
  });

  it("reads a well-formed config.rows verbatim", () => {
    const rows = readDashboardRows({
      rows: [{ id: "row-1", height: 400, widgets: [{ id: "w1", view_id: "v2", width: 6 }] }],
    });
    expect(rows).toEqual([{ id: "row-1", height: 400, widgets: [{ id: "w1", view_id: "v2", width: 6 }] }]);
  });
});

describe("DashboardView", () => {
  it("View mode renders each widget's correct component, by the referenced view's own type", async () => {
    const fetchMock = makeQueryFetchMock("List Widget Row");
    vi.stubGlobal("fetch", fetchMock);

    const listView = view({ id: "list-1", name: "My List", type: "list", config: {} });
    const chartView = view({
      id: "chart-1",
      name: "My Chart",
      type: "chart",
      config: { chart_type: "column", x_axis: { property_id: "title" }, y_axis: { aggregator: "count" } },
    });
    const config = {
      rows: [
        {
          id: "row-1",
          height: 300,
          widgets: [
            { id: "w1", view_id: "list-1", width: 6 },
            { id: "w2", view_id: "chart-1", width: 6 },
          ],
        },
      ],
    };

    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, listView, chartView]}
        config={config}
        editable={true}
        onUpdateView={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText("List Widget Row")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("chart-view")).toBeInTheDocument());
  });

  it("a widget whose view_id no longer resolves (dangling reference) shows a placeholder, not a crash", () => {
    const config = {
      rows: [{ id: "row-1", height: 300, widgets: [{ id: "w1", view_id: "missing-view", width: 6 }] }],
    };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW]}
        config={config}
        editable={true}
        onUpdateView={vi.fn()}
      />
    );
    expect(screen.getByText("This view is no longer available.")).toBeInTheDocument();
  });

  it("adding a row PATCHes config.rows with a new empty row appended", async () => {
    const user = userEvent.setup();
    const onUpdateView = vi.fn().mockResolvedValue(DASHBOARD_VIEW);
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW]}
        config={{ rows: [] }}
        editable={true}
        onUpdateView={onUpdateView}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "+ Add row" }));

    expect(onUpdateView).toHaveBeenCalledTimes(1);
    const [calledViewId, patch] = onUpdateView.mock.calls[0];
    expect(calledViewId).toBe("dash-1");
    const rows = patch.config.rows as DashboardRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ height: 320, widgets: [] }));
  });

  it("removing a row (via ConfirmDialog, not a native confirm) PATCHes config.rows without it", async () => {
    const user = userEvent.setup();
    const fetchMock = makeQueryFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const onUpdateView = vi.fn().mockResolvedValue(DASHBOARD_VIEW);
    const otherView = view({ id: "other-1", name: "Other", type: "list" });
    // A single row -- "Remove row" stays unambiguous (every row gets its
    // own such button in Edit mode).
    const config = {
      rows: [{ id: "row-1", height: 300, widgets: [{ id: "w1", view_id: "other-1", width: 6 }] }],
    };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, otherView]}
        config={config}
        editable={true}
        onUpdateView={onUpdateView}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Remove row" }));
    // Native window.confirm is never used in this repo -- ConfirmDialog
    // renders an actual accessible dialog with its own Confirm/Cancel.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(onUpdateView).toHaveBeenCalledWith("dash-1", { config: { rows: [] } });
  });

  it("adding a widget PATCHes config.rows with the picked view_id at the default width", async () => {
    const user = userEvent.setup();
    const onUpdateView = vi.fn().mockResolvedValue(DASHBOARD_VIEW);
    const listView = view({ id: "list-1", name: "My List", type: "list" });
    const config = { rows: [{ id: "row-1", height: 300, widgets: [] }] };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, listView]}
        config={config}
        editable={true}
        onUpdateView={onUpdateView}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.selectOptions(screen.getByLabelText("Add widget to row-1"), "list-1");
    await user.click(screen.getByRole("button", { name: "+ Add" }));

    expect(onUpdateView).toHaveBeenCalledTimes(1);
    const [, patch] = onUpdateView.mock.calls[0];
    const rows = patch.config.rows as DashboardRow[];
    expect(rows[0].widgets).toHaveLength(1);
    expect(rows[0].widgets[0]).toEqual(expect.objectContaining({ view_id: "list-1", width: 6 }));
  });

  it("the add-widget picker never offers a dashboard-typed view (client-side pre-check for the server's no-nesting rule) or this dashboard itself", async () => {
    const user = userEvent.setup();
    const otherDashboard = view({ id: "other-dash", name: "Other Dashboard", type: "dashboard" });
    const listView = view({ id: "list-1", name: "My List", type: "list" });
    const config = { rows: [{ id: "row-1", height: 300, widgets: [] }] };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, otherDashboard, listView]}
        config={config}
        editable={true}
        onUpdateView={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options.some((t) => t?.includes("(dashboard)"))).toBe(false);
    expect(options.some((t) => t?.includes("Other Dashboard"))).toBe(false);
    expect(options.some((t) => t?.includes("My List"))).toBe(true);
  });

  it("removing a widget (via ConfirmDialog) PATCHes config.rows without it", async () => {
    const user = userEvent.setup();
    const fetchMock = makeQueryFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const onUpdateView = vi.fn().mockResolvedValue(DASHBOARD_VIEW);
    const otherView = view({ id: "other-1", name: "Other", type: "list" });
    const config = {
      rows: [{ id: "row-1", height: 300, widgets: [{ id: "w1", view_id: "other-1", width: 6 }] }],
    };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, otherView]}
        config={config}
        editable={true}
        onUpdateView={onUpdateView}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Remove widget Other" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(onUpdateView).toHaveBeenCalledWith("dash-1", { config: { rows: [{ id: "row-1", height: 300, widgets: [] }] } } );
  });

  it("resizing a widget's width (numeric stepper) PATCHes config with the new width, clamped to 1-12", async () => {
    const user = userEvent.setup();
    const fetchMock = makeQueryFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const onUpdateView = vi.fn().mockResolvedValue(DASHBOARD_VIEW);
    const otherView = view({ id: "other-1", name: "Other", type: "list" });
    const config = {
      rows: [{ id: "row-1", height: 300, widgets: [{ id: "w1", view_id: "other-1", width: 6 }] }],
    };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, otherView]}
        config={config}
        editable={true}
        onUpdateView={onUpdateView}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const widthInput = screen.getByLabelText("Width for Other");
    fireEvent.change(widthInput, { target: { value: "20" } });

    // Combined-M13-review fix: debounced (600ms), same pattern FormView.tsx's
    // own submit-screen fields already use — no PATCH on the raw keystroke,
    // preventing a slow-arriving intermediate response from clobbering a
    // later one (the race the review found: DashboardView.tsx used to PATCH
    // on every keystroke with no ordering guarantee).
    expect(onUpdateView).not.toHaveBeenCalled();
    fireEvent.blur(widthInput);

    await waitFor(() => expect(onUpdateView).toHaveBeenCalledTimes(1));
    const [, patch] = onUpdateView.mock.calls[0];
    const rows = patch.config.rows as DashboardRow[];
    expect(rows[0].widgets[0].width).toBe(12); // clamped, never above the 12-column grid
  });

  it("changing a row's height (numeric input) PATCHes config with the new height", async () => {
    const user = userEvent.setup();
    const onUpdateView = vi.fn().mockResolvedValue(DASHBOARD_VIEW);
    const config = { rows: [{ id: "row-1", height: 300, widgets: [] }] };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW]}
        config={config}
        editable={true}
        onUpdateView={onUpdateView}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const heightInput = screen.getByLabelText("Row height for row-1");
    fireEvent.change(heightInput, { target: { value: "500" } });

    // Combined-M13-review fix: debounced (600ms) — see the widget-width
    // test above for why.
    expect(onUpdateView).not.toHaveBeenCalled();
    fireEvent.blur(heightInput);

    await waitFor(() => expect(onUpdateView).toHaveBeenCalledTimes(1));
    const [, patch] = onUpdateView.mock.calls[0];
    const rows = patch.config.rows as DashboardRow[];
    expect(rows[0].height).toBe(500);
  });

  it("changing a row's height debounce-PATCHes without an explicit blur (real timer, no premature call)", async () => {
    const onUpdateView = vi.fn().mockResolvedValue(DASHBOARD_VIEW);
    const config = { rows: [{ id: "row-1", height: 300, widgets: [] }] };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW]}
        config={config}
        editable={true}
        onUpdateView={onUpdateView}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const heightInput = screen.getByLabelText("Row height for row-1");
    fireEvent.change(heightInput, { target: { value: "700" } });

    expect(onUpdateView).not.toHaveBeenCalled();

    await waitFor(() => expect(onUpdateView).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const [, patch] = onUpdateView.mock.calls[0];
    const rows = patch.config.rows as DashboardRow[];
    expect(rows[0].height).toBe(700);
  });

  it("a row already at 4 widgets disables adding another (client-side pre-check of the backend's per-row limit)", async () => {
    const user = userEvent.setup();
    const fetchMock = makeQueryFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const filler = view({ id: "filler", name: "Filler", type: "list" });
    const config = {
      rows: [{ id: "row-1", height: 300, widgets: buildWidgets(DASHBOARD_MAX_WIDGETS_PER_ROW, "filler") }],
    };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, filler]}
        config={config}
        editable={true}
        onUpdateView={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText(`Row full (${DASHBOARD_MAX_WIDGETS_PER_ROW}/${DASHBOARD_MAX_WIDGETS_PER_ROW})`)).toBeInTheDocument();
    expect(screen.queryByLabelText("Add widget to row-1")).not.toBeInTheDocument();
  });

  it("the dashboard already at 12 widgets total disables adding another, even in a row that itself isn't full", async () => {
    const user = userEvent.setup();
    const fetchMock = makeQueryFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const filler = view({ id: "filler", name: "Filler", type: "list" });
    const config = {
      rows: [
        { id: "row-1", height: 300, widgets: buildWidgets(4, "filler") },
        { id: "row-2", height: 300, widgets: buildWidgets(4, "filler") },
        { id: "row-3", height: 300, widgets: buildWidgets(4, "filler") },
        { id: "row-4", height: 300, widgets: [] }, // not full itself (0/4)
      ],
    };
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, filler]}
        config={config}
        editable={true}
        onUpdateView={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByText(`Dashboard full (${DASHBOARD_MAX_WIDGETS_TOTAL}/${DASHBOARD_MAX_WIDGETS_TOTAL})`)
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Add widget to row-4")).not.toBeInTheDocument();
  });

  it("a rejected PATCH (the backend's 400, e.g. a widget-limit or nested-dashboard rejection) surfaces via showToast rather than failing silently", async () => {
    const user = userEvent.setup();
    const onUpdateView = vi.fn().mockRejectedValue(new Error("dashboard views cannot be nested"));
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW]}
        config={{ rows: [] }}
        editable={true}
        onUpdateView={onUpdateView}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "+ Add row" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("dashboard views cannot be nested", "error"));
  });

  it("the Edit toggle is disabled when the dashboard isn't editable (e.g. the read-only All Notes source)", () => {
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW]}
        config={{ rows: [] }}
        editable={false}
        onUpdateView={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });

  it("combined-M13-review fix: a Form-type view is not offered in the add-widget picker", async () => {
    const user = userEvent.setup();
    const fetchMock = makeQueryFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const formView = view({ id: "form-1", name: "Signup form", type: "form" });
    const tableView = view({ id: "table-1", name: "A table", type: "table" });
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, formView, tableView]}
        config={{ rows: [{ id: "row-1", height: 300, widgets: [] }] }}
        editable={true}
        onUpdateView={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const picker = screen.getByLabelText("Add widget to row-1");
    const optionLabels = Array.from(picker.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionLabels.some((label) => label?.includes("Signup form"))).toBe(false);
    expect(optionLabels.some((label) => label?.includes("A table"))).toBe(true);
  });

  it("combined-M13-review fix: a stale config referencing a Form-type widget renders a placeholder, not the FormView builder", async () => {
    const formView = view({ id: "form-1", name: "Signup form", type: "form" });
    render(
      <DashboardView
        viewId="dash-1"
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        views={[DASHBOARD_VIEW, formView]}
        config={{ rows: [{ id: "row-1", height: 300, widgets: [{ id: "w1", view_id: "form-1", width: 6 }] }] }}
        editable={true}
        onUpdateView={vi.fn()}
      />
    );

    expect(screen.getByText("Form views can't be shown as a dashboard widget.")).toBeInTheDocument();
  });
});
