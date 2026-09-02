import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ViewTabs } from "./ViewTabs";
import type { PropertyResponse, ViewResponse } from "@/lib/database/types";

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
    name: "Table",
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

const VIEWS: ViewResponse[] = [view({ id: "v1", name: "Table" }), view({ id: "v2", name: "Board", type: "board" })];

describe("ViewTabs", () => {
  it("renders one tab per view and highlights the active one", () => {
    render(
      <ViewTabs
        views={VIEWS}
        activeViewId="v2"
        onSelect={vi.fn()}
        properties={[]}
        onCreateView={vi.fn()}
      />
    );
    expect(screen.getByText("Table")).toBeInTheDocument();
    expect(screen.getByText("Board")).toBeInTheDocument();
  });

  it("clicking a tab calls onSelect with that view's id", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ViewTabs views={VIEWS} activeViewId="v1" onSelect={onSelect} properties={[]} onCreateView={vi.fn()} />
    );
    await user.click(screen.getByText("Board"));
    expect(onSelect).toHaveBeenCalledWith("v2");
  });

  // view-tab-bar.md's "create first, configure after": one click on a card
  // creates the view IMMEDIATELY — no name prompt, no group-by prompt, no
  // Create button, no validation gate. Confirmed live against Notion
  // (2026-09-02): a Board auto-selects an EXISTING groupable property, and
  // an unnamed view's tab shows its TYPE. `onCreateView`'s caller
  // (DatabaseShell.handleCreateView) owns that auto-select/auto-open-
  // settings behaviour now — these tests only prove ViewTabs itself creates
  // immediately and passes the right bare `{ type }`.
  it.each(["table", "board", "gallery", "list", "feed", "calendar", "timeline", "form", "dashboard"])(
    "clicking the %s card creates the view immediately, no gate, no name prompt",
    async (type) => {
      const user = userEvent.setup();
      const onCreateView = vi.fn().mockResolvedValue(undefined);
      render(
        <ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={[]} onCreateView={onCreateView} />
      );

      await user.click(screen.getByRole("button", { name: "Add a new view" }));
      const dialog = screen.getByRole("dialog", { name: "Add a new view" });
      const label = type.charAt(0).toUpperCase() + type.slice(1);
      await user.click(within(dialog).getByRole("button", { name: label }));

      expect(onCreateView).toHaveBeenCalledWith({ type });
      // The popover closes itself right after — no lingering dialog to
      // configure, matching "opens the view settings sidebar for
      // configuring afterward" (a DatabaseShell-level effect, not this
      // popover staying open).
      expect(screen.queryByRole("dialog", { name: "Add a new view" })).not.toBeInTheDocument();
    }
  );

  it("the Table card is visually highlighted as the default, per the capture", async () => {
    const user = userEvent.setup();
    render(<ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={[]} onCreateView={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add a new view" }));
    const dialog = screen.getByRole("dialog", { name: "Add a new view" });
    expect(within(dialog).getByRole("button", { name: "Table" }).className).toMatch(/border-brand/);
    expect(within(dialog).getByRole("button", { name: "Board" }).className).not.toMatch(/border-brand/);
  });

  it("Map is not offered as a creatable view type (out of scope for the whole milestone)", async () => {
    const user = userEvent.setup();
    render(<ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={[]} onCreateView={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add a new view" }));
    const dialog = screen.getByRole("dialog", { name: "Add a new view" });
    expect(within(dialog).queryByText("Map")).not.toBeInTheDocument();
    // 10 types (11 minus Map), not the 11 Notion itself offers.
    expect(within(dialog).getAllByRole("button")).toHaveLength(10);
  });

  const CHART_PROPERTIES = [
    prop({ key: "status", name: "Status", type: "status" }),
    prop({ key: "amount", name: "Amount", type: "number" }),
  ];

  // Chart is the one disclosed exception to "creates immediately" (see
  // ViewTabs.tsx's own comment on `handlePickViewType`): there is still no
  // post-creation surface anywhere that can set its x/y/stack axes, so
  // clicking its card opens a follow-up step in the SAME popover instead of
  // creating right away.
  async function openChartStep(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Add a new view" }));
    const grid = screen.getByRole("dialog", { name: "Add a new view" });
    await user.click(within(grid).getByRole("button", { name: "Chart" }));
    return screen.getByRole("dialog", { name: "Add a new view" });
  }

  it("clicking the Chart card does not create immediately — it opens a configure step, Create stays disabled until x_axis is filled in", async () => {
    const user = userEvent.setup();
    const onCreateView = vi.fn();
    render(
      <ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={CHART_PROPERTIES} onCreateView={onCreateView} />
    );

    const step = await openChartStep(user);
    expect(onCreateView).not.toHaveBeenCalled();

    // Default chart_type is "column" (needs an x_axis) with y_axis
    // defaulting to aggregator "count" (no property needed) — Create stays
    // disabled until an x_axis property is picked.
    expect(within(step).getByRole("button", { name: /^create$/i })).toBeDisabled();

    await user.selectOptions(within(step).getByLabelText(/x-axis property/i), "status");
    await user.click(within(step).getByRole("button", { name: /^create$/i }));

    expect(onCreateView).toHaveBeenCalledWith({
      type: "chart",
      chartConfig: {
        chart_type: "column",
        y_axis: { aggregator: "count" },
        // mode: "option" is required here because CHART_PROPERTIES' only
        // groupable fixture is status-typed — services/db/query/grouping.py
        // 400s a status group_by with no mode (live-click-through
        // regression, see ChartView.test.tsx's matching coverage).
        x_axis: { property_id: "status", mode: "option" },
        hide_empty_groups: false,
      },
    });
  });

  it("creating a 'Number' Chart view needs no x_axis, only a y_axis", async () => {
    const user = userEvent.setup();
    const onCreateView = vi.fn().mockResolvedValue(undefined);
    render(
      <ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={CHART_PROPERTIES} onCreateView={onCreateView} />
    );

    const step = await openChartStep(user);
    await user.selectOptions(within(step).getByLabelText(/chart type/i), "number");

    // count aggregator + no x_axis required for "number" -> already valid.
    expect(within(step).getByRole("button", { name: /^create$/i })).not.toBeDisabled();
    await user.click(within(step).getByRole("button", { name: /^create$/i }));

    expect(onCreateView).toHaveBeenCalledWith({
      type: "chart",
      chartConfig: { chart_type: "number", y_axis: { aggregator: "count" } },
    });
  });

  it("a non-'count' y_axis aggregator requires picking a y_axis property before Create is enabled", async () => {
    const user = userEvent.setup();
    const onCreateView = vi.fn().mockResolvedValue(undefined);
    render(
      <ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={CHART_PROPERTIES} onCreateView={onCreateView} />
    );

    const step = await openChartStep(user);
    await user.selectOptions(within(step).getByLabelText(/chart type/i), "number");
    await user.selectOptions(within(step).getByLabelText(/y-axis aggregator/i), "sum");

    expect(within(step).getByRole("button", { name: /^create$/i })).toBeDisabled();

    await user.selectOptions(within(step).getByLabelText(/y-axis property/i), "amount");
    await user.click(within(step).getByRole("button", { name: /^create$/i }));

    expect(onCreateView).toHaveBeenCalledWith({
      type: "chart",
      chartConfig: { chart_type: "number", y_axis: { aggregator: "sum", property_id: "amount" } },
    });
  });

  it("stack_by's picker does not appear when chart_type is 'donut'", async () => {
    const user = userEvent.setup();
    render(
      <ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={CHART_PROPERTIES} onCreateView={vi.fn()} />
    );

    const step = await openChartStep(user);
    await user.selectOptions(within(step).getByLabelText(/chart type/i), "donut");

    expect(within(step).queryByLabelText(/stack by/i)).not.toBeInTheDocument();
  });

  it("Chart's Back button returns to the card grid without creating anything", async () => {
    const user = userEvent.setup();
    const onCreateView = vi.fn();
    render(
      <ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={CHART_PROPERTIES} onCreateView={onCreateView} />
    );

    const step = await openChartStep(user);
    await user.click(within(step).getByRole("button", { name: /^back$/i }));

    const dialog = screen.getByRole("dialog", { name: "Add a new view" });
    expect(within(dialog).getByRole("button", { name: "Board" })).toBeInTheDocument();
    expect(onCreateView).not.toHaveBeenCalled();
  });

  // A second creation in the same render must work — regression class this
  // workstream has hit before (Milestone 6, Task 16, fc906fb): stale state
  // left over from a prior create silently blocking every view after the
  // first. Proves `closeAddView` actually resets `chartDraft` (Create is
  // disabled again on the second open, same as the first) rather than
  // leaving the first chart's config lingering into the second.
  it("Chart's Create is usable again after a successful creation — a second Chart isn't blocked by stale draft state", async () => {
    const user = userEvent.setup();
    const onCreateView = vi.fn().mockResolvedValue(undefined);
    render(
      <ViewTabs views={VIEWS} activeViewId="v1" onSelect={vi.fn()} properties={CHART_PROPERTIES} onCreateView={onCreateView} />
    );

    let step = await openChartStep(user);
    await user.selectOptions(within(step).getByLabelText(/x-axis property/i), "status");
    await user.click(within(step).getByRole("button", { name: /^create$/i }));
    expect(onCreateView).toHaveBeenCalledTimes(1);

    step = await openChartStep(user);
    expect(within(step).getByRole("button", { name: /^create$/i })).toBeDisabled();
    await user.selectOptions(within(step).getByLabelText(/x-axis property/i), "status");
    expect(within(step).getByRole("button", { name: /^create$/i })).not.toBeDisabled();
    await user.click(within(step).getByRole("button", { name: /^create$/i }));

    expect(onCreateView).toHaveBeenCalledTimes(2);
  });

  // M7 — the active tab's own menu (view-tab-bar.md).
  describe("the active tab's menu", () => {
    it("clicking the active tab opens its menu rather than a no-op switch", async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(
        <ViewTabs
          views={VIEWS}
          activeViewId="v1"
          onSelect={onSelect}
          properties={[]}
          onCreateView={vi.fn()}
          dataSourceName="Tasks"
          onUpdateView={vi.fn()}
          onDeleteView={vi.fn()}
          onOpenSettings={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: /table view options/i }));
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.getByText("Rename")).toBeInTheDocument();
      expect(screen.getByText("Display as")).toBeInTheDocument();
      expect(screen.getByText("Edit view")).toBeInTheDocument();
      expect(screen.getByText("Copy link to view")).toBeInTheDocument();
      expect(screen.getByText("Duplicate view")).toBeInTheDocument();
    });

    // Live-checklist regression: clicking "Edit view" closed the menu but
    // never opened the M3 sidebar. Root cause was a same-tick race between
    // this Popover's own close and the sidebar's SidePeek mount; onEditView
    // now defers onOpenSettings by one tick. This test would have caught it
    // -- the earlier test above only asserted the row's presence, never that
    // selecting it actually calls onOpenSettings.
    it("clicking Edit view calls onOpenSettings", async () => {
      const user = userEvent.setup();
      const onOpenSettings = vi.fn();
      render(
        <ViewTabs
          views={VIEWS}
          activeViewId="v1"
          onSelect={vi.fn()}
          properties={[]}
          onCreateView={vi.fn()}
          dataSourceName="Tasks"
          onUpdateView={vi.fn()}
          onDeleteView={vi.fn()}
          onOpenSettings={onOpenSettings}
        />
      );

      await user.click(screen.getByRole("button", { name: /table view options/i }));
      await user.click(screen.getByText("Edit view"));
      await waitFor(() => expect(onOpenSettings).toHaveBeenCalledTimes(1));
    });

    // Live-checklist regression: "Duplicate view" called fetch() directly
    // instead of the hook's own createView/updateView (which both call
    // setViews on success) -- the duplicate really was created server-side,
    // but the caller's `views` array never learned about it, so the new tab
    // stayed invisible until a reload, and onSelect was pointed at an id
    // `views` didn't contain. This test would have caught it: the earlier
    // "active tab's menu" test above only asserted the row's presence.
    it("Duplicate view creates via onCreateViewRaw, patches via onUpdateView, then selects the new id", async () => {
      const user = userEvent.setup();
      const created = view({ id: "v1-copy", name: "Table (copy)" });
      const onCreateViewRaw = vi.fn().mockResolvedValue(created);
      const onUpdateView = vi.fn().mockResolvedValue(created);
      const onSelect = vi.fn();
      render(
        <ViewTabs
          views={VIEWS}
          activeViewId="v1"
          onSelect={onSelect}
          properties={[]}
          onCreateView={vi.fn()}
          dataSourceName="Tasks"
          onCreateViewRaw={onCreateViewRaw}
          onUpdateView={onUpdateView}
          onDeleteView={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: /table view options/i }));
      await user.click(screen.getByText("Duplicate view"));

      await waitFor(() => expect(onCreateViewRaw).toHaveBeenCalledWith("Table (copy)", "table", null));
      await waitFor(() =>
        expect(onUpdateView).toHaveBeenCalledWith("v1-copy", { config: {}, filter: null, sorts: [] })
      );
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith("v1-copy"));
    });

    it("Delete view is absent with only one view", async () => {
      const user = userEvent.setup();
      render(
        <ViewTabs
          views={[VIEWS[0]]}
          activeViewId="v1"
          onSelect={vi.fn()}
          properties={[]}
          onCreateView={vi.fn()}
          dataSourceName="Tasks"
          onUpdateView={vi.fn()}
          onDeleteView={vi.fn()}
        />
      );
      await user.click(screen.getByRole("button", { name: /table view options/i }));
      expect(screen.queryByText("Delete view")).not.toBeInTheDocument();
    });

    it("Delete view is present with two views, and deletes on confirm", async () => {
      const user = userEvent.setup();
      const onDeleteView = vi.fn().mockResolvedValue(undefined);
      const onSelect = vi.fn();
      render(
        <ViewTabs
          views={VIEWS}
          activeViewId="v1"
          onSelect={onSelect}
          properties={[]}
          onCreateView={vi.fn()}
          dataSourceName="Tasks"
          onUpdateView={vi.fn()}
          onDeleteView={onDeleteView}
        />
      );
      await user.click(screen.getByRole("button", { name: /table view options/i }));
      await user.click(screen.getByText("Delete view"));
      await user.click(screen.getByRole("button", { name: /^delete view$/i }));

      expect(onDeleteView).toHaveBeenCalledWith("v1");
      expect(onSelect).toHaveBeenCalledWith("v2");
    });

    it("Rename turns the tab into an editable input and commits on blur", async () => {
      const user = userEvent.setup();
      const onUpdateView = vi.fn().mockResolvedValue(undefined);
      render(
        <ViewTabs
          views={VIEWS}
          activeViewId="v1"
          onSelect={vi.fn()}
          properties={[]}
          onCreateView={vi.fn()}
          dataSourceName="Tasks"
          onUpdateView={onUpdateView}
          onDeleteView={vi.fn()}
        />
      );
      await user.click(screen.getByRole("button", { name: /table view options/i }));
      await user.click(screen.getByText("Rename"));

      const input = screen.getByLabelText("View name");
      await user.clear(input);
      await user.type(input, "My Tasks");
      await user.tab();

      expect(onUpdateView).toHaveBeenCalledWith("v1", { name: "My Tasks" });
    });

    it("an unnamed view (the literal 'New view' default) shows its type as the tab label", () => {
      render(
        <ViewTabs
          views={[{ ...VIEWS[1], name: "New view" }]}
          activeViewId="v2"
          onSelect={vi.fn()}
          properties={[]}
          onCreateView={vi.fn()}
        />
      );
      expect(screen.getByText("Board")).toBeInTheDocument();
      expect(screen.queryByText("New view")).not.toBeInTheDocument();
    });
  });
});
