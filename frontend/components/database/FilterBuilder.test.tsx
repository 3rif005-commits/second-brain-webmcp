import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { filterPanel } from "./FilterBuilder";
import { MenuList } from "@/components/ui/primitives";
import type { PropertyResponse } from "@/lib/database/types";
import type { FilterNode } from "@/lib/database/filterAst";

// `filterPanel`'s real `filter` param is `view.filter`'s own type
// (`Record<string, unknown> | null` — an opaque JSONB blob), not
// `FilterNode` — this cast is the test-only equivalent of what a real
// caller's `view.filter` already looks like typed.
function raw(node: FilterNode): Record<string, unknown> {
  return node as unknown as Record<string, unknown>;
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
  prop({ key: "notes", name: "Text", type: "rich_text", position: 1 }),
  prop({ key: "count", name: "Number", type: "number", position: 2 }),
  prop({ key: "flag", name: "Flag", type: "checkbox", position: 3 }),
];

describe("filterPanel — stage 1, the property picker", () => {
  it("lists every filterable property alphabetically with a divider then '+ Add advanced filter'", () => {
    const onSetFilter = vi.fn();
    render(<MenuList root={filterPanel(PROPERTIES, null, onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    expect(screen.getByPlaceholderText("Filter by…")).toBeInTheDocument();
    const rows = screen.getAllByRole("option").map((el) => el.textContent);
    expect(rows).toEqual(["Flag", "Name", "Number", "Text", "+ Add advanced filter"]);
  });

  it("picking a property applies a default single-condition filter", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    render(<MenuList root={filterPanel(PROPERTIES, null, onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    await user.click(screen.getByText("Text"));
    expect(onSetFilter).toHaveBeenCalledTimes(1);
    const updater = onSetFilter.mock.calls[0][0];
    // filter-panel.md's own capture: a text-shaped property defaults to "Contains",
    // not "equals" (TEXT_OPS' first entry) — live-verified reachable and wrong before
    // this fix.
    expect(updater(null)).toEqual({ type: "condition", property: "notes", operator: "contains" });
  });

  it("+ Add advanced filter starts an empty group builder, not a default condition", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    render(<MenuList root={filterPanel(PROPERTIES, null, onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    await user.click(screen.getByText("+ Add advanced filter"));
    const updater = onSetFilter.mock.calls[0][0];
    expect(updater(null)).toEqual({ type: "group", op: "and", children: [] });
  });
});

describe("filterPanel — stage 2, a single condition", () => {
  it("renders 'Where [property] [operator] [value]' and offers Add filter rule / Delete filter", () => {
    const filter: FilterNode = { type: "condition", property: "notes", operator: "contains" };
    render(<MenuList root={filterPanel(PROPERTIES, raw(filter), vi.fn())} nav="flyout" onClose={() => {}} label="Filter" />);

    expect(screen.getByText("Where")).toBeInTheDocument();
    expect(screen.getByText("Text")).toBeInTheDocument();
    expect(screen.getByText("Contains")).toBeInTheDocument();
    expect(screen.getByText(/Add filter rule/)).toBeInTheDocument();
    expect(screen.getByText("Delete filter")).toBeInTheDocument();
  });

  it("only legal operators for the property's type are offered", async () => {
    const user = userEvent.setup();
    const filter: FilterNode = { type: "condition", property: "flag", operator: "equals" };
    render(<MenuList root={filterPanel(PROPERTIES, raw(filter), vi.fn())} nav="flyout" onClose={() => {}} label="Filter" />);

    await user.click(screen.getByText("Is"));
    const popover = screen.getByRole("listbox", { name: "Filter operator" });
    const options = within(popover).getAllByRole("option").map((el) => el.textContent);
    // "Is" carries a trailing checkmark — it's the condition's current
    // operator ("equals"), rendered `checked` by MenuList's own Row.
    expect(options).toEqual(["Is✓", "Is not"]);
  });

  it("changing the value editor commits after a debounce, not per keystroke", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    const filter: FilterNode = { type: "condition", property: "notes", operator: "contains" };
    render(<MenuList root={filterPanel(PROPERTIES, raw(filter), onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    const input = screen.getByLabelText("Filter value");
    await user.type(input, "abc");
    expect(onSetFilter).not.toHaveBeenCalled();

    await waitFor(() => expect(onSetFilter).toHaveBeenCalledTimes(1), { timeout: 1000 });
    const updater = onSetFilter.mock.calls[0][0];
    expect(updater(filter)).toEqual({ ...filter, value: "abc" });
  });

  it("Delete filter clears the whole tree", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    const filter: FilterNode = { type: "condition", property: "notes", operator: "contains" };
    render(<MenuList root={filterPanel(PROPERTIES, raw(filter), onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    await user.click(screen.getByText("Delete filter"));
    expect(onSetFilter.mock.calls[0][0](filter)).toBeNull();
  });

  it("Add filter rule wraps the lone condition into a 2-child AND group", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    const filter: FilterNode = { type: "condition", property: "notes", operator: "contains" };
    render(<MenuList root={filterPanel(PROPERTIES, raw(filter), onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    await user.click(screen.getByText(/Add filter rule/));
    await user.click(screen.getByRole("option", { name: "Add filter rule" }));

    const next = onSetFilter.mock.calls[0][0](filter);
    expect(next).toEqual({
      type: "group",
      op: "and",
      // "flag" is alphabetically first among filterable properties (Flag <
      // Name < Number < Text) — same picker order the stage-1 test asserts.
      // `value: false` (not absent): a checkbox condition's value editor
      // shows "Unchecked" selected from the moment it exists, so it must
      // actually carry that value or it would look complete but silently
      // never filter (see `defaultValueForOperator`'s own doc comment).
      children: [filter, { type: "condition", property: "flag", operator: "equals", value: false }],
    });
  });
});

describe("filterPanel — stage 2, a multi-rule group", () => {
  const group: FilterNode = {
    type: "group",
    op: "and",
    children: [
      { type: "condition", property: "notes", operator: "contains", value: "a" },
      { type: "condition", property: "count", operator: "equals", value: 1 },
    ],
  };

  it("rule 2+ shows an AND/OR selector instead of the word Where", () => {
    render(<MenuList root={filterPanel(PROPERTIES, raw(group), vi.fn())} nav="flyout" onClose={() => {}} label="Filter" />);
    expect(screen.getByText("Where")).toBeInTheDocument();
    expect(screen.getByText("And")).toBeInTheDocument();
  });

  it("switching to Or updates the group's op", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    render(<MenuList root={filterPanel(PROPERTIES, raw(group), onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    await user.click(screen.getByText("And"));
    await user.click(screen.getByRole("option", { name: "Or" }));

    const next = onSetFilter.mock.calls[0][0](group);
    expect((next as { op: string }).op).toBe("or");
  });

  it("Add filter group nests an indented group with its own conjunction/footer", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    render(<MenuList root={filterPanel(PROPERTIES, raw(group), onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    await user.click(screen.getByText(/Add filter rule/));
    // Accessible name concatenates the row's label and description with no
    // separator ("Add filter groupA group to nest more filters") — match by
    // prefix instead of the exact visible label.
    await user.click(screen.getByRole("option", { name: /^Add filter group/ }));

    const next = onSetFilter.mock.calls[0][0](group) as { children: unknown[] };
    expect(next.children).toHaveLength(3);
    expect(next.children[2]).toEqual({ type: "group", op: "and", children: [] });
  });

  it("removing one rule (×) drops only that condition", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    render(<MenuList root={filterPanel(PROPERTIES, raw(group), onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    await user.click(screen.getByLabelText("Remove filter rule on Text"));
    const next = onSetFilter.mock.calls[0][0](group);
    expect(next).toEqual({
      type: "group",
      op: "and",
      children: [{ type: "condition", property: "count", operator: "equals", value: 1 }],
    });
  });
});

describe("filterPanel — Select's str_or_list value editor renders as a chip input", () => {
  const selectProps: PropertyResponse[] = [
    prop({ key: "kind", name: "Kind", type: "select", position: 0, config: { options: [{ id: "1", name: "Alpha", color: "blue" }] } }),
  ];

  it("offers configured options as one-click suggestions and adds typed chips", async () => {
    const user = userEvent.setup();
    const onSetFilter = vi.fn();
    const filter: FilterNode = { type: "condition", property: "kind", operator: "equals" };
    render(<MenuList root={filterPanel(selectProps, raw(filter), onSetFilter)} nav="flyout" onClose={() => {}} label="Filter" />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    await user.click(screen.getByText("Alpha"));
    expect(onSetFilter.mock.calls[0][0](filter)).toEqual({ ...filter, value: ["Alpha"] });
  });
});
