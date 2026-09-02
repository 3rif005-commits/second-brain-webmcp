import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PropertyVisibilityPanel, reorderPropertyKeys } from "./PropertyVisibilityPanel";
import type { PropertyResponse } from "@/lib/database/types";

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

const PROPERTIES: PropertyResponse[] = [
  prop({ key: "title", name: "Name", type: "title", position: 0 }),
  prop({ key: "notes", name: "Text", type: "rich_text", position: 1 }),
  prop({ key: "count", name: "Number", type: "number", position: 2 }),
];

describe("reorderPropertyKeys (pure drag-drop logic, no dnd-kit simulation needed)", () => {
  it("moves the active key to the over key's position", () => {
    expect(reorderPropertyKeys(PROPERTIES, "count", "title")).toEqual(["count", "title", "notes"]);
  });

  it("returns null when nothing moved (active === over)", () => {
    expect(reorderPropertyKeys(PROPERTIES, "title", "title")).toBeNull();
  });

  it("returns null for an unknown key", () => {
    expect(reorderPropertyKeys(PROPERTIES, "ghost", "title")).toBeNull();
  });
});

describe("PropertyVisibilityPanel", () => {
  it("renders every property in the given (table) order with its type icon and name", () => {
    render(
      <PropertyVisibilityPanel
        properties={PROPERTIES}
        hiddenKeys={[]}
        onReorder={vi.fn()}
        onToggleHidden={vi.fn()}
        onHideAll={vi.fn()}
      />
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Text")).toBeInTheDocument();
    expect(screen.getByText("Number")).toBeInTheDocument();
  });

  it("the search input is autofocused and filters rows by name", async () => {
    const user = userEvent.setup();
    render(
      <PropertyVisibilityPanel
        properties={PROPERTIES}
        hiddenKeys={[]}
        onReorder={vi.fn()}
        onToggleHidden={vi.fn()}
        onHideAll={vi.fn()}
      />
    );
    expect(screen.getByPlaceholderText("Search for a property…")).toHaveFocus();

    await user.type(screen.getByPlaceholderText("Search for a property…"), "Num");
    expect(screen.getByText("Number")).toBeInTheDocument();
    expect(screen.queryByText("Text")).not.toBeInTheDocument();
  });

  it("clicking a non-title row's eye toggle calls onToggleHidden with the flipped state", async () => {
    const user = userEvent.setup();
    const onToggleHidden = vi.fn();
    render(
      <PropertyVisibilityPanel
        properties={PROPERTIES}
        hiddenKeys={["count"]}
        onReorder={vi.fn()}
        onToggleHidden={onToggleHidden}
        onHideAll={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: "Hide Text" }));
    expect(onToggleHidden).toHaveBeenCalledWith("notes", true);

    await user.click(screen.getByRole("button", { name: "Show Number" }));
    expect(onToggleHidden).toHaveBeenCalledWith("count", false);
  });

  it("the title row's eye toggle is disabled — the title column can't be hidden", () => {
    render(
      <PropertyVisibilityPanel
        properties={PROPERTIES}
        hiddenKeys={[]}
        onReorder={vi.fn()}
        onToggleHidden={vi.fn()}
        onHideAll={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Hide Name" })).toBeDisabled();
  });

  it("Hide all calls onHideAll", async () => {
    const user = userEvent.setup();
    const onHideAll = vi.fn();
    render(
      <PropertyVisibilityPanel
        properties={PROPERTIES}
        hiddenKeys={[]}
        onReorder={vi.fn()}
        onToggleHidden={vi.fn()}
        onHideAll={onHideAll}
      />
    );
    await user.click(screen.getByRole("button", { name: "Hide all" }));
    expect(onHideAll).toHaveBeenCalledTimes(1);
  });

  it("shows 'No results' when the search matches nothing", async () => {
    const user = userEvent.setup();
    render(
      <PropertyVisibilityPanel
        properties={PROPERTIES}
        hiddenKeys={[]}
        onReorder={vi.fn()}
        onToggleHidden={vi.fn()}
        onHideAll={vi.fn()}
      />
    );
    await user.type(screen.getByPlaceholderText("Search for a property…"), "zzz");
    expect(screen.getByText("No results")).toBeInTheDocument();
  });
});
