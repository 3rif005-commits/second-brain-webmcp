// M3 — the view settings sidebar. Asserts the spec's Rows section row for
// row (view-options-panel.md), the same "and the usual options" is a failed
// spec discipline ColumnHeader.test.tsx already established for M1.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { ViewSettingsSidebar } from "./ViewSettingsSidebar";
import type { DatabaseResponse, PropertyResponse, ViewResponse } from "@/lib/database/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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

const PROPERTIES: PropertyResponse[] = [
  prop({ key: "title", name: "Name", type: "title", position: 0 }),
  prop({ key: "notes", name: "Notes", type: "rich_text", position: 1 }),
  prop({ key: "kind", name: "Kind", type: "select", position: 2 }),
];

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

function database(overrides: Partial<DatabaseResponse> = {}): DatabaseResponse {
  return {
    id: "db-1",
    user_id: "u1",
    title: "My database",
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
    ...overrides,
  };
}

function setup(overrides: Partial<Parameters<typeof ViewSettingsSidebar>[0]> = {}) {
  const onPatchConfig = vi.fn();
  const onUpdateView = vi.fn().mockResolvedValue(view());
  const onPropertiesChanged = vi.fn();
  const onDatabaseChanged = vi.fn();
  const onSetSorts = vi.fn();
  const onSetFilter = vi.fn();
  const onSetGroupBy = vi.fn();
  const onClose = vi.fn();
  render(
    <ViewSettingsSidebar
      open={true}
      onClose={onClose}
      view={view()}
      properties={PROPERTIES}
      database={database()}
      dataSourceId="ds-1"
      dataSourceName="My database"
      onPatchConfig={onPatchConfig}
      onUpdateView={onUpdateView}
      onPropertiesChanged={onPropertiesChanged}
      onDatabaseChanged={onDatabaseChanged}
      onSetSorts={onSetSorts}
      onSetFilter={onSetFilter}
      onSetGroupBy={onSetGroupBy}
      automations={[]}
      onCreateAutomation={vi.fn()}
      onUpdateAutomation={vi.fn()}
      onDeleteAutomation={vi.fn()}
      {...overrides}
    />
  );
  return { onPatchConfig, onUpdateView, onPropertiesChanged, onDatabaseChanged, onSetSorts, onSetFilter, onSetGroupBy, onClose };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("ViewSettingsSidebar", () => {
  it("renders nothing distinguishable when closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("is a docked sidebar, not a popover — 483px, fixed width", () => {
    setup();
    const sidePeek = screen.getByTestId("side-peek");
    expect(sidePeek).toHaveAttribute("data-mode", "side");
    expect(sidePeek).toHaveStyle({ width: "483px" });
    expect(screen.getByTestId("view-settings-sidebar")).toBeInTheDocument();
    // No resize handle — 483px is a token, not a per-viewer preference.
    expect(screen.queryByTestId("side-peek-resize")).not.toBeInTheDocument();
  });

  it("the header is a text input holding the view name, with a leading icon and trailing info button", () => {
    setup();
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("Table");
    expect(screen.getByRole("button", { name: "View info" })).toBeInTheDocument();
  });

  it("section 1's rows match the spec, in order, with a chevron on every row except Copy link to view", () => {
    setup();
    for (const label of ["Layout", "Property visibility", "Filter", "Sort", "Group", "Conditional color", "Copy link to view"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    const copyRow = screen.getByText("Copy link to view").closest('[role="option"]');
    expect(within(copyRow as HTMLElement).queryByText("›")).not.toBeInTheDocument();
    const layoutRow = screen.getByText("Layout").closest('[role="option"]');
    expect(within(layoutRow as HTMLElement).getByText("›")).toBeInTheDocument();
  });

  it("Layout shows the value 'Table' and Property visibility shows a count", () => {
    setup();
    expect(screen.getByText("Table", { selector: "span" })).toBeInTheDocument();
    // 3 properties, none hidden.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("section 2 is headed 'Data source settings', section 3 'More settings'", () => {
    setup();
    expect(screen.getByText("Data source settings")).toBeInTheDocument();
    expect(screen.getByText("More settings")).toBeInTheDocument();
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Edit properties")).toBeInTheDocument();
    expect(screen.getByText("Automations")).toBeInTheDocument();
    expect(screen.getByText("AI Autofill")).toBeInTheDocument();
    expect(screen.getByText("Manage data sources")).toBeInTheDocument();
    expect(screen.getByText("Lock database")).toBeInTheDocument();
  });

  it("clicking Property visibility pushes a panel with a back arrow and the × still present", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText("Property visibility"));

    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search for a property…")).toBeInTheDocument();
    expect(screen.getByText("Hide all")).toBeInTheDocument();
  });

  it("clicking Filter pushes the real property picker (M4), not a placeholder", async () => {
    const user = userEvent.setup();
    const { onSetFilter } = setup();
    await user.click(screen.getByText("Filter"));

    expect(screen.getByPlaceholderText("Filter by…")).toBeInTheDocument();
    await user.click(screen.getByText("Kind"));

    expect(onSetFilter).toHaveBeenCalledTimes(1);
    const updater = onSetFilter.mock.calls[0][0];
    expect(updater(null)).toEqual({ type: "condition", property: "kind", operator: "equals" });
  });

  it("toggling a property's eye in Property visibility patches hidden_properties", async () => {
    const user = userEvent.setup();
    const { onPatchConfig } = setup();
    await user.click(screen.getByText("Property visibility"));
    await user.click(screen.getByRole("button", { name: "Hide Notes" }));

    expect(onPatchConfig).toHaveBeenCalledWith({ hidden_properties: ["notes"] });
  });

  it("the back arrow returns to the root panel", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText("Property visibility"));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByText("Layout")).toBeInTheDocument();
  });

  it("the × closes the whole sidebar, from a pushed panel", async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByText("Property visibility"));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Layout pushes the 3x3 view-type grid with the display toggles and Open pages in", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByText("Layout"));

    expect(screen.getByRole("button", { name: "Table" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Show vertical lines" })).toBeInTheDocument();
    expect(screen.getByText("Open pages in")).toBeInTheDocument();
  });

  it("Group offers only groupable properties enabled, others greyed, Files absent entirely, and selecting one patches group_by", async () => {
    const user = userEvent.setup();
    // Local fixture, not the shared PROPERTIES array other tests assert a
    // count against: `files` is excluded from the picker OUTRIGHT (M6's
    // groupPropertyPicker, matching group-panel.md's "Files is absent
    // here" capture — contrast Filter/Sort, which include it disabled);
    // `formula` stays present but disabled (deferred to Milestone 8).
    const { onSetGroupBy } = setup({
      properties: [
        ...PROPERTIES,
        prop({ key: "attachments", name: "Attachments", type: "files", position: 3 }),
        prop({ key: "calc", name: "Calc", type: "formula", position: 4 }),
      ],
    });
    await user.click(screen.getByText("Group"));

    // "Kind" (select) is groupable — enabled.
    const kindRow = screen.getByText("Kind").closest('[role="option"]');
    expect(kindRow).not.toHaveAttribute("aria-disabled");
    // "Notes" (rich_text) is groupable since Phase 0c widened
    // GROUPABLE_PROPERTY_TYPES to match the engine's real support.
    const notesRow = screen.getByText("Notes").closest('[role="option"]');
    expect(notesRow).not.toHaveAttribute("aria-disabled");
    // "Attachments" (files) doesn't appear in the list at all.
    expect(screen.queryByText("Attachments")).not.toBeInTheDocument();
    // "Calc" (formula) appears but disabled with a reason — deferred to M8.
    const calcRow = screen.getByText("Calc").closest('[role="option"]');
    expect(calcRow).toHaveAttribute("aria-disabled", "true");

    await user.click(screen.getByText("Kind"));
    // group-panel.md's own capture: "Hide empty groups" is ON by default.
    // `onSetGroupBy` is the updater-based write (see GroupByUpdater's own
    // doc comment for why a plain patch object would race) — assert what
    // it produces, the same pattern FilterBuilder/SortRowsList's own tests
    // already use for their updater props.
    expect(onSetGroupBy).toHaveBeenCalledTimes(1);
    const updater = onSetGroupBy.mock.calls[0][0];
    expect(updater(undefined)).toEqual({ property_key: "kind", hide_empty_groups: true });
  });

  it("Sort with no existing sort shows 'New sort' and selecting a property sets a single ascending sort", async () => {
    const user = userEvent.setup();
    const { onSetSorts } = setup();
    await user.click(screen.getByText("Sort"));

    expect(screen.getByText("New sort")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Sort by…")).toBeInTheDocument();
    await user.click(screen.getByText("Kind"));

    // onSetSorts now takes an UPDATER (see SortsUpdater's own doc comment) —
    // DatabaseShell's queue supplies the latest known `sorts` when it runs,
    // not whatever this panel last rendered with.
    expect(onSetSorts).toHaveBeenCalledTimes(1);
    const updater = onSetSorts.mock.calls[0][0];
    expect(updater([])).toEqual([{ property: "kind", direction: "asc" }]);
  });

  it("Copy link to view copies a URL and applies immediately (no navigation away from the root panel)", async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own in-memory clipboard stub AFTER this
    // call, replacing whatever navigator.clipboard pointed to before — the
    // spy has to attach after setup(), not before, or it gets clobbered
    // (FormView.test.tsx's own established pattern for this exact gotcha).
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    setup();
    await user.click(screen.getByText("Copy link to view"));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("view=v1"));
    expect(showToast).toHaveBeenCalledWith("Link copied to clipboard", "info");
  });

  it("Lock database is a toggle reflecting database.is_locked and PATCHes /api/db/databases/{id}", async () => {
    const user = userEvent.setup();
    const { onDatabaseChanged } = setup({ database: database({ is_locked: false }) });
    const toggle = screen.getByRole("switch", { name: "Lock database" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByText("Lock database"));

    await waitFor(() => expect(onDatabaseChanged).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      "/api/db/databases/db-1",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ is_locked: true }) })
    );
  });

  it("renaming the view: editing the name input and blurring calls onUpdateView", async () => {
    const user = userEvent.setup();
    const { onUpdateView } = setup();
    const input = screen.getByRole("textbox", { name: "View name" });
    await user.clear(input);
    await user.type(input, "Renamed view");
    input.blur();

    await waitFor(() => expect(onUpdateView).toHaveBeenCalledWith("v1", { name: "Renamed view" }));
  });

  it("switching the active view while Settings stays open shows the NEW view's name, not the old one's", () => {
    // Review-checkpoint finding (M1-M3 pass): the name input's `draft` state
    // only seeded from `name` on first mount. Switching view tabs without
    // closing Settings used to leave `draft` holding the PREVIOUS view's
    // name — any blur after that would have silently renamed the newly
    // active view to the old one's name. Fixed with `key={view.id}` on
    // ViewNameHeader, forcing a fresh mount (and a fresh `draft`) per view.
    const onUpdateView = vi.fn().mockResolvedValue(view());
    const { rerender } = render(
      <ViewSettingsSidebar
        open={true}
        onClose={vi.fn()}
        view={view({ id: "v1", name: "View A" })}
        properties={PROPERTIES}
        database={database()}
        dataSourceId="ds-1"
        dataSourceName="My database"
        onPatchConfig={vi.fn()}
        onUpdateView={onUpdateView}
        onPropertiesChanged={vi.fn()}
        onDatabaseChanged={vi.fn()}
        onSetSorts={vi.fn()}
        onSetFilter={vi.fn()}
        onSetGroupBy={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
      />
    );
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("View A");

    rerender(
      <ViewSettingsSidebar
        open={true}
        onClose={vi.fn()}
        view={view({ id: "v2", name: "View B" })}
        properties={PROPERTIES}
        database={database()}
        dataSourceId="ds-1"
        dataSourceName="My database"
        onPatchConfig={vi.fn()}
        onUpdateView={onUpdateView}
        onPropertiesChanged={vi.fn()}
        onDatabaseChanged={vi.fn()}
        onSetSorts={vi.fn()}
        onSetFilter={vi.fn()}
        onSetGroupBy={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
      />
    );
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("View B");
  });
});
