import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RowGutter } from "./RowGutter";

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

describe("RowGutter", () => {
  it("renders the three gutter affordances: add, drag handle (row options), checkbox", () => {
    render(
      <RowGutter
        rowId="row-1"
        selected={false}
        onToggleSelected={vi.fn()}
        onAddRow={vi.fn()}
        onOpenSidePeek={vi.fn()}
        onTrashed={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Add a row below" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Row options" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select row" })).toBeInTheDocument();
  });

  // M12: List's own live capture (row-affordances-list-view.txt) confirmed
  // its gutter has only `+` and the drag handle — no checkbox at all, unlike
  // Table's three affordances.
  it("showCheckbox=false renders + and the drag handle, but no checkbox (List's own gutter shape)", () => {
    render(
      <RowGutter
        rowId="row-1"
        selected={false}
        onToggleSelected={vi.fn()}
        onAddRow={vi.fn()}
        onOpenSidePeek={vi.fn()}
        onTrashed={vi.fn()}
        showCheckbox={false}
      />
    );
    expect(screen.getByRole("button", { name: "Add a row below" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Row options" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select row" })).not.toBeInTheDocument();
  });

  it("clicking the drag handle both opens the row menu and selects the row", async () => {
    const user = userEvent.setup();
    const onToggleSelected = vi.fn();
    render(
      <RowGutter
        rowId="row-1"
        selected={false}
        onToggleSelected={onToggleSelected}
        onAddRow={vi.fn()}
        onOpenSidePeek={vi.fn()}
        onTrashed={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Row options" }));
    expect(onToggleSelected).toHaveBeenCalledWith("row-1");
    expect(screen.getByPlaceholderText("Search actions…")).toBeInTheDocument();
    expect(screen.getByText("Add to Favorites")).toBeInTheDocument();
    expect(screen.getByText("Move to Trash")).toBeInTheDocument();
    // "Move to" has no analogue for a row without a page tree, and is
    // deliberately absent rather than disabled (row-affordances.md).
    expect(screen.queryByText("Move to")).not.toBeInTheDocument();
  });

  it("checking the checkbox selects the row without opening the menu", async () => {
    const user = userEvent.setup();
    const onToggleSelected = vi.fn();
    render(
      <RowGutter
        rowId="row-1"
        selected={false}
        onToggleSelected={onToggleSelected}
        onAddRow={vi.fn()}
        onOpenSidePeek={vi.fn()}
        onTrashed={vi.fn()}
      />
    );
    await user.click(screen.getByRole("checkbox", { name: "Select row" }));
    expect(onToggleSelected).toHaveBeenCalledWith("row-1");
    expect(screen.queryByPlaceholderText("Search actions…")).not.toBeInTheDocument();
  });

  it("Open in -> Side peek calls onOpenSidePeek", async () => {
    const user = userEvent.setup();
    const onOpenSidePeek = vi.fn();
    render(
      <RowGutter
        rowId="row-1"
        selected={false}
        onToggleSelected={vi.fn()}
        onAddRow={vi.fn()}
        onOpenSidePeek={onOpenSidePeek}
        onTrashed={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Row options" }));
    await user.click(screen.getByText("Open in"));
    await user.click(screen.getByText("Side peek"));
    expect(onOpenSidePeek).toHaveBeenCalledWith("row-1");
  });

  it("Move to Trash DELETEs the note and calls onTrashed", async () => {
    const user = userEvent.setup();
    const onTrashed = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    render(
      <RowGutter
        rowId="row-1"
        selected={false}
        onToggleSelected={vi.fn()}
        onAddRow={vi.fn()}
        onOpenSidePeek={vi.fn()}
        onTrashed={onTrashed}
      />
    );
    await user.click(screen.getByRole("button", { name: "Row options" }));
    await user.click(screen.getByText("Move to Trash"));
    expect(global.fetch).toHaveBeenCalledWith("/api/notes/row-1", { method: "DELETE" });
    expect(onTrashed).toHaveBeenCalled();
  });
});
