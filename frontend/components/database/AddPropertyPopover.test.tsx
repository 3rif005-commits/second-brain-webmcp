// M2 — property creation.
//
// These are the 18 tests that lived in TableView.test.tsx against the inline
// form. The BEHAVIOURS are unchanged and still load-bearing — relation two-way
// semantics, a formula that saves while still invalid, the full rollup config —
// only the interactions changed, from a form to an anchored popover. Moving
// them rather than deleting them is the point: the surface was replaced, the
// contract was not.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({ useToast: () => ({ showToast }) }));

// FormulaEditor does its own validation fetches and renders a textarea; the
// tests below only need to know it mounted and can be typed into.
vi.mock("./FormulaEditor", () => ({
  FormulaEditor: ({
    expression,
    onExpressionChange,
  }: {
    expression: string;
    onExpressionChange: (v: string) => void;
  }) => (
    <textarea
      aria-label="Formula expression"
      value={expression}
      onChange={(e) => onExpressionChange(e.target.value)}
    />
  ),
}));

import { AddPropertyPopover } from "./AddPropertyPopover";
import { ROLLUP_FUNCTIONS } from "@/lib/database/types";
import type { PropertyResponse } from "@/lib/database/types";

function prop(overrides: Partial<PropertyResponse> = {}): PropertyResponse {
  return {
    id: "p1",
    data_source_id: "ds-1",
    user_id: "u1",
    key: "k1",
    name: "Name",
    type: "title",
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DATABASES = {
  databases: [
    { database: { id: "db-1", title: "This one" }, data_source: { id: "ds-1" } },
    { database: { id: "db-2", title: "Other" }, data_source: { id: "ds-2" } },
  ],
};

function setup(properties: PropertyResponse[] = [prop()]) {
  const onCreated = vi.fn();
  render(
    <AddPropertyPopover dataSourceId="ds-1" properties={properties} onCreated={onCreated} />
  );
  return { onCreated };
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Add property" }));
  return screen.getByRole("listbox");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => json({ id: "new", key: "nk" })));
});

describe("the picker", () => {
  it("puts the name field in the header cell, not in the popover", async () => {
    const user = userEvent.setup();
    setup();
    await openPicker(user);

    // Notion separates the two; putting them side by side is what made the
    // old inline form read as a form rather than a menu.
    const nameField = screen.getByLabelText("Property name");
    expect(nameField).toHaveFocus();
    expect(within(screen.getByRole("listbox")).queryByLabelText("Property name")).toBeNull();
  });

  it("offers every type M2b delivers", async () => {
    const user = userEvent.setup();
    setup();
    const list = await openPicker(user);

    for (const label of [
      "Text",
      "Number",
      "Select",
      "Multi-select",
      "Status",
      "Date",
      "Checkbox",
      "URL",
      "Email",
      "Phone",
      "ID",
      "Created time",
      "Last edited time",
      "Relation",
      "Formula",
      "Rollup",
      "Button",
    ]) {
      expect(within(list).getByText(label)).toBeInTheDocument();
    }
  });

  it("holds back the five types that would ship broken", async () => {
    const user = userEvent.setup();
    setup();
    const list = await openPicker(user);

    // Not an oversight — each has a concrete blocker recorded at the list:
    // people/created_by/last_edited_by render a raw user id with no name
    // lookup, files needs an upload pipeline, place needs geocoding.
    for (const label of ["Person", "Created by", "Last edited by", "Files & media", "Place"]) {
      expect(within(list).queryByText(label)).toBeNull();
    }
  });

  it("filters the grid without collapsing it to a list", async () => {
    const user = userEvent.setup();
    setup();
    await openPicker(user);
    await user.type(screen.getByRole("combobox"), "sel");

    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Select")).toBeInTheDocument();
    expect(within(list).getByText("Multi-select")).toBeInTheDocument();
    expect(within(list).queryByText("Number")).toBeNull();
  });

  it("a simple type POSTs {name, type} and refetches", async () => {
    const user = userEvent.setup();
    const { onCreated } = setup();
    await openPicker(user);
    await user.type(screen.getByLabelText("Property name"), "Stage");
    await user.click(within(screen.getByRole("listbox")).getByText("Select"));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/properties",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ name: "Stage", type: "select" }),
        })
      )
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("falls back to the type's own label when no name is typed", async () => {
    const user = userEvent.setup();
    setup();
    await openPicker(user);
    await user.click(within(screen.getByRole("listbox")).getByText("Checkbox"));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/properties",
        expect.objectContaining({ body: JSON.stringify({ name: "Checkbox", type: "checkbox" }) })
      )
    );
  });
});

describe("relation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/db/databases" ? json(DATABASES) : json({ id: "new" })
      )
    );
  });

  async function chooseRelation(user: ReturnType<typeof userEvent.setup>) {
    await openPicker(user);
    await user.click(within(screen.getByRole("listbox")).getByText("Relation"));
    return screen.findByLabelText("Target database");
  }

  it("does not create anything until configured — picking the type pushes a config step", async () => {
    const user = userEvent.setup();
    setup();
    await chooseRelation(user);
    expect(fetch).not.toHaveBeenCalledWith(
      "/api/db/data-sources/ds-1/relations",
      expect.anything()
    );
  });

  it("offers every database including this one, for self-relations", async () => {
    const user = userEvent.setup();
    setup();
    const select = await chooseRelation(user);
    expect(within(select).getByText(/This one \(this database\)/)).toBeInTheDocument();
    expect(within(select).getByText("Other")).toBeInTheDocument();
  });

  it("two-way defaults on and shows a reverse-name field; unchecking hides it", async () => {
    const user = userEvent.setup();
    setup();
    await chooseRelation(user);

    const twoWay = screen.getByLabelText("Two-way relation");
    expect(twoWay).toBeChecked();
    expect(screen.getByLabelText("Reverse property name")).toBeInTheDocument();

    await user.click(twoWay);
    expect(screen.queryByLabelText("Reverse property name")).toBeNull();
  });

  it("POSTs a two-way relation to the RELATIONS endpoint, not properties", async () => {
    const user = userEvent.setup();
    setup();
    const select = await chooseRelation(user);
    await user.selectOptions(select, "ds-2");
    await user.type(screen.getByLabelText("Reverse property name"), "Back");
    await user.click(screen.getByRole("button", { name: "Add property" }));

    // The generic properties endpoint would mint no relation_id or side, and
    // every filter on the result would 400.
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/relations",
        expect.objectContaining({
          body: JSON.stringify({
            name: "Relation",
            target_data_source_id: "ds-2",
            two_way: true,
            reverse_name: "Back",
          }),
        })
      )
    );
  });

  it("a one-way relation sends two_way false and a null reverse name", async () => {
    const user = userEvent.setup();
    setup();
    const select = await chooseRelation(user);
    await user.selectOptions(select, "ds-2");
    await user.click(screen.getByLabelText("Two-way relation"));
    await user.click(screen.getByRole("button", { name: "Add property" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/relations",
        expect.objectContaining({
          body: JSON.stringify({
            name: "Relation",
            target_data_source_id: "ds-2",
            two_way: false,
            reverse_name: null,
          }),
        })
      )
    );
  });

  it("a self-relation is allowed", async () => {
    const user = userEvent.setup();
    setup();
    const select = await chooseRelation(user);
    await user.selectOptions(select, "ds-1");
    await user.type(screen.getByLabelText("Reverse property name"), "Back");
    await user.click(screen.getByRole("button", { name: "Add property" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/relations",
        expect.objectContaining({ body: expect.stringContaining('"target_data_source_id":"ds-1"') })
      )
    );
  });

  it("cannot be submitted without a target database", async () => {
    const user = userEvent.setup();
    setup();
    await chooseRelation(user);
    // Disabled rather than submitting and failing — the old form let you press
    // Add and then showed an error.
    expect(screen.getByRole("button", { name: "Add property" })).toBeDisabled();
  });
});

describe("formula", () => {
  async function chooseFormula(user: ReturnType<typeof userEvent.setup>) {
    await openPicker(user);
    await user.click(within(screen.getByRole("listbox")).getByText("Formula"));
    return screen.findByLabelText("Formula expression");
  }

  it("renders the expression editor", async () => {
    const user = userEvent.setup();
    setup();
    expect(await chooseFormula(user)).toBeInTheDocument();
  });

  it("submits while the expression is still invalid — research §1.9", async () => {
    const user = userEvent.setup();
    setup();
    const editor = await chooseFormula(user);
    // "a formula with errors can still be saved... the property will display
    // nothing". Deliberately NOT gated on the editor reporting valid.
    await user.type(editor, "prop(");
    await user.click(screen.getByRole("button", { name: "Add property" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/properties",
        expect.objectContaining({
          body: JSON.stringify({
            name: "Formula",
            type: "formula",
            config: { expression: "prop(" },
          }),
        })
      )
    );
  });

  it("cannot be submitted empty — the one thing the backend hard-rejects", async () => {
    const user = userEvent.setup();
    setup();
    await chooseFormula(user);
    expect(screen.getByRole("button", { name: "Add property" })).toBeDisabled();
  });

  it("surfaces a dependency-cycle rejection verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ detail: "saving this formula would create a dependency cycle: a → b → a" }, 400))
    );
    const user = userEvent.setup();
    setup();
    const editor = await chooseFormula(user);
    await user.type(editor, "1");
    await user.click(screen.getByRole("button", { name: "Add property" }));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "saving this formula would create a dependency cycle: a → b → a",
        "error"
      )
    );
  });
});

describe("rollup", () => {
  const relation = prop({
    id: "p2",
    key: "rel1",
    name: "Tasks",
    type: "relation",
    config: { target_data_source_id: "ds-2" },
  });

  async function chooseRollup(
    user: ReturnType<typeof userEvent.setup>,
    properties: PropertyResponse[]
  ) {
    setup(properties);
    await openPicker(user);
    await user.click(within(screen.getByRole("listbox")).getByText("Rollup"));
  }

  it("says to add a relation first rather than offering an empty dropdown", async () => {
    const user = userEvent.setup();
    await chooseRollup(user, [prop()]);
    expect(screen.getByText(/Add a relation property first/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Rollup relation")).toBeNull();
  });

  it("offers exactly the documented rollup functions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/db/databases" ? json(DATABASES) : json({})))
    );
    const user = userEvent.setup();
    await chooseRollup(user, [prop(), relation]);

    const fn = screen.getByLabelText("Rollup function");
    // -1 for the "Choose a function…" placeholder.
    expect(within(fn).getAllByRole("option").length - 1).toBe(ROLLUP_FUNCTIONS.length);
  });

  it("resolves the relation's target and POSTs the full computed config", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/db/databases") return json(DATABASES);
        if (url === "/api/db/databases/db-2")
          return json({ properties: [prop({ key: "tk", name: "Amount", type: "number" })] });
        return json({ id: "new" });
      })
    );
    const user = userEvent.setup();
    await chooseRollup(user, [prop(), relation]);

    await user.selectOptions(screen.getByLabelText("Rollup relation"), "rel1");
    await user.selectOptions(await screen.findByLabelText("Rollup target property"), "tk");
    await user.selectOptions(screen.getByLabelText("Rollup function"), ROLLUP_FUNCTIONS[0]);
    await user.click(screen.getByRole("button", { name: "Add property" }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/properties",
        expect.objectContaining({
          body: JSON.stringify({
            name: "Rollup",
            type: "rollup",
            config: {
              relation_key: "rel1",
              // Never chosen by the user — derived from the relation, because
              // the backend rejects any other value.
              target_data_source_id: "ds-2",
              target_key: "tk",
              function: ROLLUP_FUNCTIONS[0],
            },
          }),
        })
      )
    );
  });

  it("cannot be submitted without a target property and a function", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url === "/api/db/databases" ? json(DATABASES) : json({})))
    );
    const user = userEvent.setup();
    await chooseRollup(user, [prop(), relation]);
    await user.selectOptions(screen.getByLabelText("Rollup relation"), "rel1");
    expect(screen.getByRole("button", { name: "Add property" })).toBeDisabled();
  });
});
