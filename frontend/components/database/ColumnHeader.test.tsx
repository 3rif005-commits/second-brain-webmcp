// M1 — the column header menu.
//
// These assert the spec's Rows section row-for-row, because that is the whole
// point of the spec: "and the usual options" is a failed spec, and a test that
// only checks the menu opens would let the rows drift silently.
// Source: docs/ui-specs/table-column-header.md
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { ColumnHeader } from "./ColumnHeader";
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
    convertible_to: ["number", "select", "multi_select", "status", "url"],
    ...overrides,
  };
}

function view(config: Record<string, unknown> = {}): ViewResponse {
  return {
    id: "v1",
    data_source_id: "ds-1",
    user_id: "u1",
    name: "Table",
    icon: null,
    type: "table",
    config,
    filter: null,
    sorts: [],
    is_locked: false,
    position: 0,
  };
}

function setup(overrides: Partial<Parameters<typeof ColumnHeader>[0]> = {}) {
  const onPatchConfig = vi.fn();
  const onSetSorts = vi.fn();
  const onPropertiesChanged = vi.fn();
  render(
    <ColumnHeader
      property={prop()}
      properties={[prop()]}
      dataSourceId="ds-1"
      view={view()}
      onPatchConfig={onPatchConfig}
      onSetSorts={onSetSorts}
      onPropertiesChanged={onPropertiesChanged}
      {...overrides}
    />
  );
  return { onPatchConfig, onSetSorts, onPropertiesChanged };
}

function rowLabels(): string[] {
  // Strip the decorative trailing glyphs (submenu chevron, current-value
  // checkmark) — they are aria-hidden, but textContent still includes them.
  return screen
    .getAllByRole("option")
    .map((el) => (el.textContent ?? "").replace(/[›✓]/g, "").trim())
    .filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ...prop(), key: "new1", id: "p2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  );
});

describe("trigger", () => {
  it("opens on a plain left click — there is no separate chevron", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /column options/i }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("right-click opens the SAME menu, not a separate context menu", async () => {
    setup();
    const trigger = screen.getByRole("button", { name: /column options/i });

    // Notion has no bespoke context menus in a database table.
    trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    expect(rowLabels()).toContain("Change type");
  });
});

describe("rows", () => {
  it("renders the ordinary-property rows in the captured order", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));

    expect(rowLabels()).toEqual([
      "Change type",
      "Filter",
      "Sort",
      "Group",
      "Calculate",
      "Freeze",
      "Hide",
      "Unwrap content",
      "Insert left",
      "Insert right",
      "Duplicate property",
      "Delete property",
    ]);
  });

  it("a title column has a reduced set plus its own Show page icon toggle", async () => {
    const user = userEvent.setup();
    setup({ property: prop({ type: "title", name: "Name", convertible_to: [] }) });
    await user.click(screen.getByRole("button", { name: /column options/i }));

    const labels = rowLabels();
    // Structurally impossible on a title, so absent rather than disabled.
    expect(labels).not.toContain("Change type");
    expect(labels).not.toContain("Hide");
    expect(labels).not.toContain("Delete property");
    expect(labels).not.toContain("Duplicate property");
    // And one row only a title has.
    expect(labels.some((l) => l.startsWith("Show page icon"))).toBe(true);
  });

  it("the wrap label names the ACTION, so it flips with state", async () => {
    const user = userEvent.setup();
    const { unmount } = { unmount: () => {} };
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));
    // Default is wrapped, so the offered action is to unwrap.
    expect(rowLabels()).toContain("Unwrap content");
    void unmount;
  });

  it("shows Wrap content once the column is already unwrapped", async () => {
    const user = userEvent.setup();
    setup({ view: view({ wrapped_properties: { abc123: false } }) });
    await user.click(screen.getByRole("button", { name: /column options/i }));
    expect(rowLabels()).toContain("Wrap content");
  });

  it("disables rows whose surface does not exist yet, with a reason", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));

    // Present-but-disabled, not missing: the row exists in Notion, and a
    // silently absent row is harder to notice than a disabled one.
    const filter = screen.getByText("Filter").closest('[role="option"]');
    expect(filter).toHaveAttribute("aria-disabled", "true");
    expect(filter).toHaveAttribute("title", expect.stringContaining("not available"));

    const freeze = screen.getByText("Freeze").closest('[role="option"]');
    expect(freeze).toHaveAttribute("aria-disabled", "true");
  });

  it("enables Filter once a handler is supplied (M4)", async () => {
    const user = userEvent.setup();
    setup({ onFilter: vi.fn() });
    await user.click(screen.getByRole("button", { name: /column options/i }));
    expect(screen.getByText("Filter").closest('[role="option"]')).not.toHaveAttribute(
      "aria-disabled"
    );
  });
});

describe("Change type", () => {
  it("marks the current type and disables illegal conversions from the server list", async () => {
    const user = userEvent.setup();
    setup({ property: prop({ type: "rich_text", convertible_to: ["number", "select"] }) });
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Change type"));

    const panel = await screen.findByRole("listbox", { name: "Change type" });
    const row = (label: string) =>
      within(panel).getByText(label).closest('[role="option"]');

    expect(row("Number")).not.toHaveAttribute("aria-disabled");
    expect(row("Select")).not.toHaveAttribute("aria-disabled");
    // Not in convertible_to -> disabled. The legality comes from the server,
    // so a hardcoded client matrix cannot drift from it.
    expect(row("Relation")).toHaveAttribute("aria-disabled", "true");
    expect(row("Date")).toHaveAttribute("aria-disabled", "true");
  });

  it("PATCHes the type when a legal target is chosen", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Change type"));
    const panel = await screen.findByRole("listbox", { name: "Change type" });
    await user.click(within(panel).getByText("Number"));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/properties/p1",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify({ type: "number" }) })
      )
    );
  });
});

describe("Calculate", () => {
  it("offers More options only for a numeric property", async () => {
    const user = userEvent.setup();
    setup({ property: prop({ type: "number" }) });
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Calculate"));

    const panel = await screen.findByRole("listbox", { name: "Calculate" });
    expect(within(panel).getByText("More options")).toBeInTheDocument();
  });

  it("omits More options for text", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Calculate"));

    const panel = await screen.findByRole("listbox", { name: "Calculate" });
    expect(within(panel).queryByText("More options")).not.toBeInTheDocument();
    expect(within(panel).getByText("Count")).toBeInTheDocument();
  });

  it("writes the chosen aggregator into view config as a PATCH", async () => {
    const user = userEvent.setup();
    const { onPatchConfig } = setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Calculate"));
    const calc = await screen.findByRole("listbox", { name: "Calculate" });
    await user.click(within(calc).getByText("Count"));
    const count = await screen.findByRole("listbox", { name: "Count" });
    await user.click(within(count).getByText("Count all"));

    // Only the changed key — DatabaseShell merges it onto the freshest config.
    expect(onPatchConfig).toHaveBeenCalledWith({ calculations: { abc123: "count" } });
  });
});

describe("view-config actions", () => {
  it("Hide patches only hidden_properties", async () => {
    const user = userEvent.setup();
    const { onPatchConfig } = setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Hide"));
    expect(onPatchConfig).toHaveBeenCalledWith({ hidden_properties: ["abc123"] });
  });

  it("Sort writes a single sort with a type-aware label", async () => {
    const user = userEvent.setup();
    const { onSetSorts } = setup({ property: prop({ type: "number" }) });
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Sort"));

    const panel = await screen.findByRole("listbox", { name: "Sort" });
    // Never a generic "Ascending".
    expect(within(panel).getByText("Sort low → high")).toBeInTheDocument();
    await user.click(within(panel).getByText("Sort low → high"));

    // onSetSorts now takes an UPDATER, not a finished array — DatabaseShell's
    // queue supplies the latest known `sorts` at write time (see
    // SortsUpdater's doc comment); this row's own write doesn't depend on
    // whatever was previously sorted, so it ignores its `current` argument.
    expect(onSetSorts).toHaveBeenCalledTimes(1);
    const updater = onSetSorts.mock.calls[0][0];
    expect(updater([{ property: "unrelated", direction: "desc" }])).toEqual([
      { property: "abc123", direction: "asc" },
    ]);
  });
});

describe("rename and description", () => {
  it("renames on blur, not per keystroke", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));

    const input = screen.getByLabelText("Property name");
    await user.clear(input);
    await user.type(input, "Summary");
    expect(fetch).not.toHaveBeenCalled();

    await user.tab();
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/properties/p1",
        expect.objectContaining({ body: JSON.stringify({ name: "Summary" }) })
      )
    );
  });

  it("clearing the name field and blurring does NOT rename to an empty string — restores the original instead", async () => {
    // Review-checkpoint finding (M1-M3 pass): this was the one rename field
    // in the codebase without a trim/empty guard — OptionRenameHeader and
    // ViewNameHeader both require `name.trim()` before committing.
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));

    const input = screen.getByLabelText("Property name");
    await user.clear(input);
    await user.tab();

    expect(fetch).not.toHaveBeenCalled();
    expect(input).toHaveValue("Notes");
  });

  it("the ⓘ reveals a description field — its tooltip names what it does", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));

    const info = screen.getByRole("button", { name: "Add property description" });
    expect(info).toHaveAttribute("title", "Add property description");

    await user.click(info);
    expect(screen.getByLabelText("Property description")).toBeInTheDocument();
  });
});

describe("delete", () => {
  it("confirms before deleting, because a property has no trash", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Delete property"));

    // No native dialog — those freeze the tab and kill browser automation.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete property" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/api/db/properties/p1",
        expect.objectContaining({ method: "DELETE" })
      )
    );
  });
});

describe("failures", () => {
  it("surfaces the server's own refusal reason rather than a generic message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail: "cannot convert a rich_text property to date" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const user = userEvent.setup();
    setup({ property: prop({ convertible_to: ["date"] }) });
    await user.click(screen.getByRole("button", { name: /column options/i }));
    await user.click(screen.getByText("Change type"));
    const panel = await screen.findByRole("listbox", { name: "Change type" });
    await user.click(within(panel).getByText("Date"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        "cannot convert a rich_text property to date",
        "error"
      )
    );
  });
});
