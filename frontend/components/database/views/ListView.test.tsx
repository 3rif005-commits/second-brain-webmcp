import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DatabaseRow, PropertyResponse } from "@/lib/database/types";

// M12: ListView now reads/writes the row peek's `?p=&pm=` via useRowPeek
// (useSearchParams/usePathname/router.replace), the same shared hook every
// other M12 view uses — mocked the same way TableView.test.tsx's own
// `?p=`/`?pm=` mock already established.
const routerReplace = vi.fn();
let mockSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace }),
  usePathname: () => "/brain/db/ds-1",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// RowPeek mounts a real BlockEditor for the row's own body — heavy
// (BlockNote), not what ListView-level tests exercise. Stubbed the same way
// TableView.test.tsx already does for the identical reason.
vi.mock("@/components/editor/BlockEditor", () => ({
  BlockEditor: () => <div data-testid="block-editor-stub" />,
}));

import { ListView } from "./ListView";

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
const STATUS_PROP = prop({ key: "status", name: "Status", type: "status", position: 1 });

function row(id: string, title: string, extra: DatabaseRow["properties"] = {}): DatabaseRow {
  return { id, properties: { title: { type: "title", title }, ...extra } };
}

beforeEach(() => {
  mockSearch = "";
  routerReplace.mockClear();
});

describe("ListView", () => {
  // M12's live capture (row-affordances-list-view.txt): a List row shows
  // ONLY its title at rest — confirmed live even for a row whose OTHER
  // property already had a value set. Every other property is revealed only
  // via the per-row "Edit" toggle, matching that capture — not the old
  // always-expanded behavior this test used to assert.
  it("shows only the title at rest — other properties are hidden until Edit is clicked", () => {
    render(
      <ListView
        properties={[TITLE_PROP, STATUS_PROP]}
        rows={[row("row-1", "First task", { status: { type: "status", status: "todo" } })]}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    expect(screen.getByText("First task")).toBeInTheDocument();
    expect(screen.queryByText("Status:")).not.toBeInTheDocument();
    expect(screen.queryByText("todo")).not.toBeInTheDocument();
  });

  it("clicking Edit reveals the row's other visible properties as quick-fill chips, in position order", async () => {
    const user = userEvent.setup();
    render(
      <ListView
        properties={[TITLE_PROP, STATUS_PROP]}
        rows={[row("row-1", "First task", { status: { type: "status", status: "todo" } })]}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Status:")).toBeInTheDocument();
    expect(screen.getByText("todo")).toBeInTheDocument();
  });

  // hidden_properties: M3's Property visibility panel already writes this
  // key; ListView.tsx used to never read it (a silent no-op, per PROGRESS.md's
  // own M12 survey) — confirmed fixed here.
  it("a property hidden via config.hidden_properties does not appear even after Edit", async () => {
    const user = userEvent.setup();
    render(
      <ListView
        properties={[TITLE_PROP, STATUS_PROP]}
        rows={[row("row-1", "First task", { status: { type: "status", status: "todo" } })]}
        editable={true}
        onCellChange={vi.fn()}
        config={{ hidden_properties: ["status"] }}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByText("Status:")).not.toBeInTheDocument();
  });

  it("clicking Edit turns the title into an inline-editable input, committed on blur", async () => {
    const user = userEvent.setup();
    const onCellChange = vi.fn();
    render(
      <ListView
        properties={[TITLE_PROP]}
        rows={[row("row-1", "First task")]}
        editable={true}
        onCellChange={onCellChange}
      />
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("Title");
    await user.clear(input);
    await user.type(input, "Renamed task");
    await user.tab();

    expect(onCellChange).toHaveBeenCalledWith("row-1", "title", { type: "title", title: "Renamed task" });
  });

  // M12's own capture: no separate "OPEN" button exists in List — the
  // row's title IS the open control, and a plain click opens the side peek
  // (the same p=/pm=s URL shape Table's own OPEN button already writes),
  // not a bare page navigation the way this test used to assert.
  it("clicking the title opens the row's side peek (writes ?p=&pm=s), not a bare navigation", async () => {
    const user = userEvent.setup();
    render(
      <ListView properties={[TITLE_PROP]} rows={[row("row-1", "First task")]} editable={true} onCellChange={vi.fn()} />
    );

    await user.click(screen.getByText("First task"));

    expect(routerReplace).toHaveBeenCalled();
    const [url] = routerReplace.mock.calls[routerReplace.mock.calls.length - 1];
    expect(url).toContain("p=row-1");
    expect(url).toContain("pm=s");
  });

  it("renders the gutter's + and drag handle, but no checkbox — List's own gutter has no bulk-select checkbox", () => {
    render(
      <ListView properties={[TITLE_PROP]} rows={[row("row-1", "First task")]} editable={true} onCellChange={vi.fn()} />
    );
    expect(screen.getByLabelText("Add a row below")).toBeInTheDocument();
    expect(screen.getByLabelText("Row options")).toBeInTheDocument();
    expect(screen.queryByLabelText("Select row")).not.toBeInTheDocument();
  });

  // Live-found bug: clicking a revealed property's own editor right after
  // Edit was clicked never worked — the title input's own `onBlur` closed
  // the WHOLE editing row (unmounting the revealed properties with it)
  // before the click that was headed to one of them ever landed, the same
  // "trigger swaps mid-interaction, dismiss logic wins the race" class M11's
  // cell-editing session already hit twice. Fixed by moving the exit-edit
  // decision to the ROW's own blur (checking `relatedTarget` stayed inside),
  // not the title input's blur in isolation.
  it("clicking a revealed property right after Edit keeps the row expanded (blur race regression)", async () => {
    render(
      <ListView
        properties={[TITLE_PROP, STATUS_PROP]}
        rows={[row("row-1", "First task", { status: { type: "status", status: "todo" } })]}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    await userEvent.setup().click(screen.getByRole("button", { name: "Edit" }));
    const titleInput = screen.getByLabelText("Title");
    const statusValue = screen.getByText("todo");

    // Simulate the real browser sequence a click on the property triggers:
    // the title input blurs with the property's own element as
    // `relatedTarget` (still inside the row) BEFORE the click itself lands.
    fireEvent.blur(titleInput, { relatedTarget: statusValue });

    // The row must still be expanded — the property chip is still there,
    // not unmounted by a premature exit-edit.
    expect(screen.getByText("Status:")).toBeInTheDocument();
    expect(screen.getByText("todo")).toBeInTheDocument();
  });

  it("blurring the title with focus leaving the row entirely closes edit mode", () => {
    render(
      <ListView
        properties={[TITLE_PROP, STATUS_PROP]}
        rows={[row("row-1", "First task", { status: { type: "status", status: "todo" } })]}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const titleInput = screen.getByLabelText("Title");
    fireEvent.blur(titleInput, { relatedTarget: document.body });

    expect(screen.queryByText("Status:")).not.toBeInTheDocument();
  });

  it("a read-only source (editable=false) suppresses the gutter and Edit, but the title still opens the peek", async () => {
    const user = userEvent.setup();
    render(
      <ListView properties={[TITLE_PROP]} rows={[row("row-1", "First task")]} editable={false} onCellChange={vi.fn()} />
    );
    expect(screen.queryByLabelText("Add a row below")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    await user.click(screen.getByText("First task"));
    const [url] = routerReplace.mock.calls[routerReplace.mock.calls.length - 1];
    expect(url).toContain("p=row-1");
  });

  it("renders no grouping UI anywhere — List doesn't support group_by (research: UNRESOLVED, not implemented)", () => {
    render(
      <ListView
        properties={[TITLE_PROP, STATUS_PROP]}
        rows={[row("row-1", "First task", { status: { type: "status", status: "todo" } })]}
        editable={false}
        onCellChange={vi.fn()}
      />
    );

    expect(screen.queryByText(/hide empty groups/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/group by/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^group/i)).not.toBeInTheDocument();
  });

  it("renders 'No rows yet.' for an empty rows array", () => {
    render(<ListView properties={[TITLE_PROP]} rows={[]} editable={false} onCellChange={vi.fn()} />);
    expect(screen.getByText(/no rows yet/i)).toBeInTheDocument();
  });

  it("the gutter's + posts a new row and refetches, when a dataSourceId is provided", async () => {
    const user = userEvent.setup();
    const refetchRows = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "row-2" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ListView
        properties={[TITLE_PROP]}
        rows={[row("row-1", "First task")]}
        editable={true}
        onCellChange={vi.fn()}
        dataSourceId="ds-1"
        refetchRows={refetchRows}
      />
    );

    await user.click(screen.getByLabelText("Add a row below"));
    expect(fetchMock).toHaveBeenCalledWith("/api/db/data-sources/ds-1/rows", expect.objectContaining({ method: "POST" }));
    expect(refetchRows).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("the bottom '+ New page' row also posts a new row", async () => {
    const user = userEvent.setup();
    const refetchRows = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "row-2" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ListView
        properties={[TITLE_PROP]}
        rows={[row("row-1", "First task")]}
        editable={true}
        onCellChange={vi.fn()}
        dataSourceId="ds-1"
        refetchRows={refetchRows}
      />
    );

    await user.click(screen.getByRole("button", { name: /new page/i }));
    expect(fetchMock).toHaveBeenCalledWith("/api/db/data-sources/ds-1/rows", expect.objectContaining({ method: "POST" }));
    expect(refetchRows).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
