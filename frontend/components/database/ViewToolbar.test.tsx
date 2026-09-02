// M3's view toolbar — Filter · Sort · Automations · AI Autofill · Search ·
// Settings. Existence + wiring, not the full Filter/Sort editors (those are
// ViewSettingsSidebar/EditPropertyPanel's own coverage — the panels are
// literally the same MenuPanel data, reused here through a different host).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ViewToolbar } from "./ViewToolbar";
import type { PropertyResponse, ViewResponse } from "@/lib/database/types";

function prop(overrides: Partial<PropertyResponse>): PropertyResponse {
  return {
    id: overrides.key ?? "id",
    data_source_id: "ds-1",
    user_id: "u1",
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

const PROPERTIES: PropertyResponse[] = [prop({ key: "title", name: "Name", type: "title" })];

function view(overrides: Partial<ViewResponse> = {}): ViewResponse {
  return {
    id: "v1",
    data_source_id: "ds-1",
    user_id: "u1",
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

function setup(overrides: Partial<Parameters<typeof ViewToolbar>[0]> = {}) {
  const onSetSorts = vi.fn();
  const onSetFilter = vi.fn();
  const onOpenSettings = vi.fn();
  render(
    <ViewToolbar
      view={view()}
      properties={PROPERTIES}
      onSetSorts={onSetSorts}
      onSetFilter={onSetFilter}
      dataSourceId="ds-1"
      automations={[]}
      onCreateAutomation={vi.fn()}
      onUpdateAutomation={vi.fn()}
      onDeleteAutomation={vi.fn()}
      onOpenSettings={onOpenSettings}
      {...overrides}
    />
  );
  return { onSetSorts, onSetFilter, onOpenSettings };
}

describe("ViewToolbar", () => {
  it("renders all six buttons: Filter, Sort, Automations, AI Autofill, Search, Settings", () => {
    setup();
    for (const label of ["Filter", "Sort", "Automations", "AI Autofill", "Search", "Settings"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeInTheDocument();
    }
  });

  it("AI Autofill and Search are disabled with a reason, not absent", () => {
    setup();
    expect(screen.getByRole("button", { name: "AI Autofill" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Search" })).toBeDisabled();
  });

  it("clicking Settings calls onOpenSettings", async () => {
    const user = userEvent.setup();
    const { onOpenSettings } = setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("Filter opens the property picker and picking one calls onSetFilter with a default condition", async () => {
    const user = userEvent.setup();
    const { onSetFilter } = setup();
    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByPlaceholderText("Filter by…")).toBeInTheDocument();

    await user.click(screen.getByText("Name"));

    expect(onSetFilter).toHaveBeenCalledTimes(1);
    const updater = onSetFilter.mock.calls[0][0];
    // filter-panel.md's own capture: a text-shaped property (title included) defaults
    // to "Contains", not "equals" (TEXT_OPS' first entry).
    expect(updater(null)).toEqual({ type: "condition", property: "title", operator: "contains" });
  });

  it("the Filter button's label reflects the current rule count", () => {
    setup({
      view: view({ filter: { type: "condition", property: "title", operator: "equals" } }),
    });
    expect(screen.getByRole("button", { name: "1 rule" })).toBeInTheDocument();
  });

  it("Sort opens the sort panel and selecting a property calls onSetSorts", async () => {
    const user = userEvent.setup();
    const { onSetSorts } = setup();
    await user.click(screen.getByRole("button", { name: /^Sort/ }));
    expect(screen.getByText("New sort")).toBeInTheDocument();

    await user.click(screen.getByText("Name"));

    // onSetSorts now takes an UPDATER (see SortsUpdater's own doc comment) —
    // DatabaseShell's queue supplies the latest known `sorts` when it runs.
    expect(onSetSorts).toHaveBeenCalledTimes(1);
    const updater = onSetSorts.mock.calls[0][0];
    expect(updater([])).toEqual([{ property: "title", direction: "asc" }]);
  });

  it("the Sort button's label reflects the current sort state, by property NAME not its raw key", () => {
    setup({ view: view({ sorts: [{ property: "title", direction: "asc" }] }) });
    expect(screen.getByRole("button", { name: "Sort: Name" })).toBeInTheDocument();
  });

  it("clicking Automations opens the automation manager", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: "Automations" }));
    expect(screen.getByRole("heading", { name: /automation/i })).toBeInTheDocument();
  });
});
