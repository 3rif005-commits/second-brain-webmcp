import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryBar } from "./QueryBar";
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

describe("QueryBar", () => {
  it("renders nothing when there is neither a sort nor a filter", () => {
    const { container } = render(
      <QueryBar view={view()} properties={PROPERTIES} onSetSorts={vi.fn()} onSetFilter={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a single sort's direction arrow and property name", () => {
    render(
      <QueryBar
        view={view({ sorts: [{ property: "title", direction: "asc" }] })}
        properties={PROPERTIES}
        onSetSorts={vi.fn()}
        onSetFilter={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "↑ Name" })).toBeInTheDocument();
  });

  it("shows a count once 2+ sorts exist", () => {
    render(
      <QueryBar
        view={view({
          sorts: [
            { property: "title", direction: "asc" },
            { property: "kind", direction: "desc" },
          ],
        })}
        properties={[...PROPERTIES, prop({ key: "kind", name: "Kind", type: "select" })]}
        onSetSorts={vi.fn()}
        onSetFilter={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "⇅ 2 sorts" })).toBeInTheDocument();
  });

  it("shows the filter rule count, sort chip before it", () => {
    render(
      <QueryBar
        view={view({
          sorts: [{ property: "title", direction: "asc" }],
          filter: { type: "condition", property: "title", operator: "equals" },
        })}
        properties={PROPERTIES}
        onSetSorts={vi.fn()}
        onSetFilter={vi.fn()}
      />
    );
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons[0]).toMatch(/^↑ Name/);
    expect(buttons[1]).toMatch(/^1 rule/);
  });

  it("clicking the sort chip opens the sort panel", async () => {
    const user = userEvent.setup();
    render(
      <QueryBar
        view={view({ sorts: [{ property: "title", direction: "asc" }] })}
        properties={PROPERTIES}
        onSetSorts={vi.fn()}
        onSetFilter={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "↑ Name" }));
    expect(screen.getByText("Sort A → Z")).toBeInTheDocument();
  });

  it("the bar's own + Filter button reopens the filter panel", async () => {
    const user = userEvent.setup();
    render(
      <QueryBar
        view={view({ filter: { type: "condition", property: "title", operator: "equals" } })}
        properties={PROPERTIES}
        onSetSorts={vi.fn()}
        onSetFilter={vi.fn()}
      />
    );
    await user.click(screen.getByRole("button", { name: "Add filter" }));
    expect(screen.getByText("Where")).toBeInTheDocument();
  });
});
