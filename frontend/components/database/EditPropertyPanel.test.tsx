// M2 (completion) — the `Edit property` panel.
//
// These assert the panel row-for-row against the live capture
// (docs/ui-specs/raw-dom/20-edit-property-panel.md), for the same reason the
// M1 tests do: a test that only checks the panel opens would let the rows
// drift silently, and the rows ARE the spec.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { ColumnHeader } from "./ColumnHeader";
import { hasEditableConfig, sortOptions } from "./EditPropertyPanel";
import type { PropertyResponse, ViewResponse } from "@/lib/database/types";

function prop(overrides: Partial<PropertyResponse> = {}): PropertyResponse {
  return {
    id: "p1",
    data_source_id: "ds-1",
    user_id: "u1",
    key: "abc123",
    name: "Notes",
    type: "rich_text",
    config: {},
    description: null,
    storage: "jsonb",
    column_name: null,
    result_type: null,
    is_volatile: false,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    convertible_to: ["number", "select"],
    ...overrides,
  };
}

function view(): ViewResponse {
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
  };
}

let lastBody: Record<string, unknown> | null = null;

function setup(property: PropertyResponse) {
  const onPropertiesChanged = vi.fn();
  render(
    <ColumnHeader
      property={property}
      properties={[property]}
      dataSourceId="ds-1"
      view={view()}
      onPatchConfig={vi.fn()}
      onSetSorts={vi.fn()}
      onPropertiesChanged={onPropertiesChanged}
    />
  );
  return { onPropertiesChanged };
}

/** Rows of ONE panel.
 *
 * Scoping matters here in a way it does not for a pushed panel: `nav="flyout"`
 * keeps the parent menu mounted beside the child, so an unscoped
 * `getAllByRole("option")` returns the header menu's 13 rows AND the flyout's.
 * Each panel carries `role="listbox"` named after the row that opened it. */
function rowLabels(panel: HTMLElement): string[] {
  return within(panel)
    .getAllByRole("option")
    .map((el) => (el.textContent ?? "").replace(/[›✓]/g, "").trim())
    .filter(Boolean);
}

function allRowLabels(): string[] {
  return screen
    .getAllByRole("option")
    .map((el) => (el.textContent ?? "").replace(/[›✓]/g, "").trim())
    .filter(Boolean);
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole("button", { name: `${name} column options` }));
}

/** Open a flyout by clicking its row inside `from`, and return the new panel. */
async function openPanel(
  user: ReturnType<typeof userEvent.setup>,
  from: HTMLElement | null,
  rowText: string | RegExp,
  panelName: string
): Promise<HTMLElement> {
  const scope = from ? within(from) : screen;
  await user.click(scope.getByRole("option", { name: rowText }));
  return screen.findByRole("listbox", { name: panelName });
}

beforeEach(() => {
  vi.clearAllMocks();
  lastBody = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      lastBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify(prop()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
});

describe("when the Edit property row appears at all", () => {
  it("is absent for a Text column — Notion's menu opens straight onto Change type", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "rich_text", name: "Notes" }));
    await openMenu(user, "Notes");

    expect(allRowLabels()).not.toContain("Edit property");
    // And the FIRST row is Change type, not a gap where the row used to be.
    expect(allRowLabels()[0]).toBe("Change type");
  });

  it("is the first row for a Number column", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "number", name: "Score" }));
    await openMenu(user, "Score");

    expect(allRowLabels()[0]).toBe("Edit property");
  });

  it("agrees with hasEditableConfig, which is the single source of the rule", () => {
    expect(hasEditableConfig("number")).toBe(true);
    expect(hasEditableConfig("select")).toBe(true);
    expect(hasEditableConfig("multi_select")).toBe(true);
    expect(hasEditableConfig("status")).toBe(true);
    expect(hasEditableConfig("rich_text")).toBe(false);
    expect(hasEditableConfig("checkbox")).toBe(false);
    expect(hasEditableConfig("date")).toBe(false);
  });
});

describe("the number panel", () => {
  it("shows both rows with their current values, and the scope disclaimer", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "number", name: "Score", config: { format: "dollar" } }));
    await openMenu(user, "Score");
    const panel = await openPanel(user, null, /Edit property/, "Edit property");

    expect(within(panel).getByRole("option", { name: /Number format/ })).toHaveTextContent(
      "US Dollar (USD)"
    );
    expect(within(panel).getByRole("option", { name: /Decimal places/ })).toHaveTextContent(
      "Default"
    );
    expect(
      screen.getByText("Changes apply to all views showing this property.")
    ).toBeInTheDocument();
  });

  it("offers the three Show as cards with Number pressed by default", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "number", name: "Score" }));
    await openMenu(user, "Score");
    await openPanel(user, null, /Edit property/, "Edit property");

    expect(screen.getByRole("button", { name: "Number" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bar" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Ring" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reveals Color / Divide by / Show number only once Bar or Ring is chosen", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "number", name: "Score", config: { show_as: "bar", divide_by: 100 } }));
    await openMenu(user, "Score");
    await openPanel(user, null, /Edit property/, "Edit property");

    expect(screen.getByRole("button", { name: /^Color/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Divide by")).toHaveValue(100);
    expect(screen.getByLabelText("Show number")).toBeChecked();
  });

  it("does not show that sub-form for a plain Number column", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "number", name: "Score" }));
    await openMenu(user, "Score");
    await openPanel(user, null, /Edit property/, "Edit property");

    expect(screen.queryByLabelText("Divide by")).not.toBeInTheDocument();
  });

  it("pre-fills Divide by with 100 when Bar is first chosen, as Notion does", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "number", name: "Score" }));
    await openMenu(user, "Score");
    await openPanel(user, null, /Edit property/, "Edit property");
    await user.click(screen.getByRole("button", { name: "Bar" }));

    await waitFor(() => expect(lastBody).not.toBeNull());
    expect((lastBody as { config: Record<string, unknown> }).config).toMatchObject({
      show_as: "bar",
      divide_by: 100,
    });
  });

  it("writes decimal_places as null for Default, so a previous value is cleared", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "number", name: "Score", config: { decimal_places: 2 } }));
    await openMenu(user, "Score");
    const edit = await openPanel(user, null, /Edit property/, "Edit property");
    const decimals = await openPanel(user, edit, /Decimal places/, "Decimal places");
    await user.click(within(decimals).getByRole("option", { name: /^Default/ }));

    await waitFor(() => expect(lastBody).not.toBeNull());
    expect((lastBody as { config: Record<string, unknown> }).config.decimal_places).toBeNull();
  });

  it("searches the format list — it is 39 rows long", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "number", name: "Score" }));
    await openMenu(user, "Score");
    const edit = await openPanel(user, null, /Edit property/, "Edit property");
    const formats = await openPanel(user, edit, /Number format/, "Number format");

    await user.type(screen.getByPlaceholderText("Filter formats…"), "krona");
    expect(rowLabels(formats)).toEqual(["Swedish krona (SEK)"]);
  });
});

describe("the select option editor", () => {
  const selectProp = prop({
    type: "select",
    name: "Stage",
    config: {
      options: [
        { id: "o1", name: "Alpha", color: "purple" },
        { id: "o2", name: "Beta", color: "blue" },
      ],
    },
  });

  it("lists Sort and every option under an Options header", async () => {
    const user = userEvent.setup();
    setup(selectProp);
    await openMenu(user, "Stage");
    const panel = await openPanel(user, null, /Edit property/, "Edit property");

    expect(rowLabels(panel)).toEqual(["SortManual", "Alpha", "Beta"]);
    expect(within(panel).getByText("Options")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add an option" })).toBeInTheDocument();
  });

  it("opens an option's own editor with Delete and the 10 colors", async () => {
    const user = userEvent.setup();
    setup(selectProp);
    await openMenu(user, "Stage");
    const edit = await openPanel(user, null, /Edit property/, "Edit property");
    const option = await openPanel(user, edit, /Alpha/, "Alpha");

    expect(screen.getByLabelText("Option name")).toHaveValue("Alpha");
    expect(rowLabels(option)).toEqual([
      "Delete",
      "Default",
      "Gray",
      "Brown",
      "Orange",
      "Yellow",
      "Green",
      "Blue",
      "Purple",
      "Pink",
      "Red",
    ]);
  });

  it("recolors one option and leaves the other untouched", async () => {
    const user = userEvent.setup();
    setup(selectProp);
    await openMenu(user, "Stage");
    const edit = await openPanel(user, null, /Edit property/, "Edit property");
    const option = await openPanel(user, edit, /Alpha/, "Alpha");
    await user.click(within(option).getByRole("option", { name: /^Red/ }));

    await waitFor(() => expect(lastBody).not.toBeNull());
    expect((lastBody as { config: { options: unknown[] } }).config.options).toEqual([
      { id: "o1", name: "Alpha", color: "red" },
      { id: "o2", name: "Beta", color: "blue" },
    ]);
  });

  it("deletes an option without a confirm — one label, not a whole column", async () => {
    const user = userEvent.setup();
    setup(selectProp);
    await openMenu(user, "Stage");
    const edit = await openPanel(user, null, /Edit property/, "Edit property");
    const option = await openPanel(user, edit, /Alpha/, "Alpha");
    await user.click(within(option).getByRole("option", { name: /Delete/ }));

    await waitFor(() => expect(lastBody).not.toBeNull());
    expect((lastBody as { config: { options: { id: string }[] } }).config.options).toEqual([
      { id: "o2", name: "Beta", color: "blue" },
    ]);
  });

  it("appends a new option through the + on the Options header", async () => {
    const user = userEvent.setup();
    setup(selectProp);
    await openMenu(user, "Stage");
    await openPanel(user, null, /Edit property/, "Edit property");
    await user.click(screen.getByRole("button", { name: "Add an option" }));

    await waitFor(() => expect(lastBody).not.toBeNull());
    const options = (lastBody as { config: { options: { name: string }[] } }).config.options;
    expect(options).toHaveLength(3);
    expect(options[2].name).toBe("Option 3");
  });
});

describe("the status option editor", () => {
  it("splits options into Notion's three groups rather than one flat list", async () => {
    const user = userEvent.setup();
    setup(
      prop({
        type: "status",
        name: "State",
        config: {
          options: [
            { id: "o1", name: "Idea", group: "To-do" },
            { id: "o2", name: "Building", group: "In progress" },
            { id: "o3", name: "Shipped", group: "Complete" },
          ],
        },
      })
    );
    await openMenu(user, "State");
    const panel = await openPanel(user, null, /Edit property/, "Edit property");

    expect(within(panel).getByText("To-do")).toBeInTheDocument();
    expect(within(panel).getByText("In progress")).toBeInTheDocument();
    expect(within(panel).getByText("Complete")).toBeInTheDocument();
    expect(rowLabels(panel)).toEqual(["SortManual", "Idea", "Building", "Shipped"]);
  });

  it("stamps the group on an option added from that group's own +", async () => {
    const user = userEvent.setup();
    setup(prop({ type: "status", name: "State", config: { options: [] } }));
    await openMenu(user, "State");
    await openPanel(user, null, /Edit property/, "Edit property");
    await user.click(screen.getByRole("button", { name: "Add an option to Complete" }));

    await waitFor(() => expect(lastBody).not.toBeNull());
    const options = (lastBody as { config: { options: { group: string }[] } }).config.options;
    expect(options[0].group).toBe("Complete");
  });
});

describe("sortOptions", () => {
  const options = [
    { id: "1", name: "Charlie" },
    { id: "2", name: "alpha" },
    { id: "3", name: "Bravo" },
  ];

  it("leaves manual order exactly as stored", () => {
    expect(sortOptions(options, "manual")).toBe(options);
  });

  it("sorts case-insensitively, so 'alpha' is not exiled below 'Charlie'", () => {
    expect(sortOptions(options, "alphabetical").map((o) => o.name)).toEqual([
      "alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("reverses that order for reverse_alphabetical", () => {
    expect(sortOptions(options, "reverse_alphabetical").map((o) => o.name)).toEqual([
      "Charlie",
      "Bravo",
      "alpha",
    ]);
  });

  it("does not mutate the array it was given", () => {
    const original = [...options];
    sortOptions(options, "alphabetical");
    expect(options).toEqual(original);
  });
});
