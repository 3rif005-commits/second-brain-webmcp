import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SortRowsList, reorderSorts } from "./SortRowsList";
import type { PropertyResponse } from "@/lib/database/types";
import type { Sort } from "@/lib/database/viewConfig";

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
  prop({ key: "count", name: "Number", type: "number", position: 1 }),
  prop({ key: "flag", name: "Flag", type: "checkbox", position: 2 }),
];

describe("reorderSorts (pure drag-drop logic, no dnd-kit simulation needed)", () => {
  const sorts: Sort[] = [
    { property: "title", direction: "asc" },
    { property: "count", direction: "desc" },
  ];

  it("moves the active property to the over property's position", () => {
    expect(reorderSorts(sorts, "count", "title")).toEqual([
      { property: "count", direction: "desc" },
      { property: "title", direction: "asc" },
    ]);
  });

  it("returns null when nothing moved (active === over)", () => {
    expect(reorderSorts(sorts, "title", "title")).toBeNull();
  });

  it("returns null for an unknown property", () => {
    expect(reorderSorts(sorts, "title", "missing")).toBeNull();
  });
});

describe("SortRowsList", () => {
  it("renders one row per sort, each with its own drag handle, property and direction dropdowns", () => {
    const sorts: Sort[] = [
      { property: "count", direction: "desc" },
      { property: "flag", direction: "asc" },
    ];
    render(<SortRowsList sorts={sorts} properties={PROPERTIES} onSetSorts={vi.fn()} />);

    expect(screen.getAllByLabelText(/Reorder/)).toHaveLength(2);
    expect(screen.getByText("Number")).toBeInTheDocument();
    expect(screen.getByText("Sort high → low")).toBeInTheDocument();
    expect(screen.getByText("Flag")).toBeInTheDocument();
    expect(screen.getByText("Sort unchecked → checked")).toBeInTheDocument();
  });

  it("the direction dropdown offers type-aware labels and flips this row's direction only", async () => {
    const user = userEvent.setup();
    const onSetSorts = vi.fn();
    const sorts: Sort[] = [
      { property: "count", direction: "asc" },
      { property: "flag", direction: "asc" },
    ];
    render(<SortRowsList sorts={sorts} properties={PROPERTIES} onSetSorts={onSetSorts} />);

    await user.click(screen.getByText("Sort low → high"));
    await user.click(screen.getByText("Sort high → low"));

    expect(onSetSorts).toHaveBeenCalledTimes(1);
    const updater = onSetSorts.mock.calls[0][0];
    expect(updater(sorts)).toEqual([
      { property: "count", direction: "desc" },
      { property: "flag", direction: "asc" },
    ]);
  });

  it("Remove (×) drops only that row's sort", async () => {
    const user = userEvent.setup();
    const onSetSorts = vi.fn();
    const sorts: Sort[] = [
      { property: "count", direction: "asc" },
      { property: "flag", direction: "asc" },
    ];
    render(<SortRowsList sorts={sorts} properties={PROPERTIES} onSetSorts={onSetSorts} />);

    await user.click(screen.getByLabelText("Remove sort on Number"));

    expect(onSetSorts).toHaveBeenCalledTimes(1);
    const updater = onSetSorts.mock.calls[0][0];
    expect(updater(sorts)).toEqual([{ property: "flag", direction: "asc" }]);
  });

  it("the property dropdown excludes properties already sorted elsewhere, but keeps this row's own current property", async () => {
    const user = userEvent.setup();
    const onSetSorts = vi.fn();
    const sorts: Sort[] = [
      { property: "count", direction: "desc" },
      { property: "flag", direction: "asc" },
    ];
    render(<SortRowsList sorts={sorts} properties={PROPERTIES} onSetSorts={onSetSorts} />);

    await user.click(screen.getByText("Number"));
    // "Flag" is already sorted by the other row — excluded from this row's picker.
    expect(screen.queryByRole("option", { name: /Flag/ })).not.toBeInTheDocument();
    // "Name" is free — offered, and picking it swaps this row's property and
    // resets its direction to ascending.
    await user.click(screen.getByRole("option", { name: "Name" }));

    expect(onSetSorts).toHaveBeenCalledTimes(1);
    const updater = onSetSorts.mock.calls[0][0];
    expect(updater(sorts)).toEqual([
      { property: "title", direction: "asc" },
      { property: "flag", direction: "asc" },
    ]);
  });
});
