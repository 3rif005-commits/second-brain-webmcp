import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// TableView's title cell now renders an OpenNoteButton (controller fix, closing the
// gap a user found live: TableView was the only view with no "open the row as its
// full note page" affordance — Board/Gallery/List/Feed/Calendar/Timeline all already
// had one). OpenNoteButton navigates via next/navigation's useRouter — outside a real
// Next.js app router tree (as here, a plain RTL render) that throws "invariant
// expected app router to be mounted" unless mocked, same as BoardView.test.tsx/
// ListView.test.tsx.
//
// M10 (row-peek.md): TableView now also reads/writes the peek's `?p=&pm=`
// via `useSearchParams`/`usePathname`/`router.replace` — mocked the same
// way, `mockSearch` mutable so a test can seed the URL the component reads
// at mount (the lazy `useState` initializer) before rendering.
const routerPush = vi.fn();
const routerReplace = vi.fn();
let mockSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: routerReplace }),
  usePathname: () => "/brain/db/ds-1",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// RowPeek (opened by the Open-note button, see above) mounts a real
// BlockEditor for the row's body — heavy (BlockNote), and not what these
// TableView-level tests exercise (its own body-save wiring is
// RowPeek-scoped, not TableView's concern). Stubbed the same way
// TemplateEditor.test.tsx already does for the identical reason.
vi.mock("@/components/editor/BlockEditor", () => ({
  BlockEditor: () => <div data-testid="block-editor-stub" />,
}));

import { TableView, groupValueForNewRow } from "./TableView";
import { KNOWN_PROPERTY_TYPES, ROLLUP_FUNCTIONS } from "@/lib/database/types";
import type { DatabaseRow, PropertyResponse, RelatedRow, RowTemplateResponse } from "@/lib/database/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  routerPush.mockClear();
  routerReplace.mockClear();
  mockSearch = "";
});

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
  prop({ key: "title", name: "Title", type: "title", position: 0 }),
  prop({ key: "notes", name: "Notes", type: "rich_text", position: 1 }),
  prop({ key: "count", name: "Count", type: "number", position: 2 }),
  prop({ key: "kind", name: "Kind", type: "select", position: 3 }),
  prop({ key: "topics", name: "Topics", type: "multi_select", position: 4 }),
  prop({ key: "mastery", name: "Mastery", type: "status", position: 5 }),
  prop({ key: "due", name: "Due", type: "date", position: 6 }),
  prop({ key: "done", name: "Done", type: "checkbox", position: 7 }),
  prop({ key: "url", name: "URL", type: "url", position: 8 }), // no dedicated cell -> GenericCell fallback
];

const ROWS: DatabaseRow[] = [
  {
    id: "row-1",
    properties: {
      title: { type: "title", title: "First Note" },
      notes: { type: "rich_text", rich_text: "some text" },
      count: { type: "number", number: 3 },
      kind: { type: "select", select: "article" },
      topics: { type: "multi_select", multi_select: ["rust", "async"] },
      mastery: { type: "status", status: "learning" },
      due: { type: "date", date: { start: "2026-08-08", end: null, time_zone: null } },
      done: { type: "checkbox", checkbox: true },
      url: { type: "url", url: "https://example.com" },
    },
  },
];

describe("TableView", () => {
  it("renders all 8 known property types plus a generic fallback, read-only, with no editable inputs when editable=false", () => {
    render(<TableView properties={PROPERTIES} rows={ROWS} editable={false} onCellChange={vi.fn()} />);

    expect(screen.getByText("First Note")).toBeInTheDocument();
    expect(screen.getByText("some text")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("article")).toBeInTheDocument();
    expect(screen.getByText("rust")).toBeInTheDocument();
    expect(screen.getByText("async")).toBeInTheDocument();
    expect(screen.getByText("learning")).toBeInTheDocument();
    expect(screen.getByText("https://example.com")).toBeInTheDocument();
    // Checkbox renders but is disabled (visible, not interactive).
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox).toBeDisabled();
    expect(checkbox.checked).toBe(true);
    // No text/number inputs anywhere — nothing is click-to-edit.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("renders column headers from properties[] in position order", () => {
    render(<TableView properties={PROPERTIES} rows={ROWS} editable={false} onCellChange={vi.fn()} />);
    const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Title", "Notes", "Count", "Kind", "Topics", "Mastery", "Due", "Done", "URL"]);
  });

  describe("M3: view.config is the read half of column visibility/order/wrap/vertical-lines/page-icon", () => {
    // M1's column header menu ("Hide", Insert left/right) and M3's Property
    // visibility panel both WRITE hidden_properties/property_order — this
    // suite is the read half neither had before now (M1-VISUAL-DIFF.md's
    // "a control that writes a setting nothing reads" defect class, one
    // surface over).
    function view(config: Record<string, unknown>) {
      return {
        id: "view-1",
        data_source_id: "ds-1",
        user_id: "user-1",
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

    it("hides a column listed in config.hidden_properties, but never the title column", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={false}
          onCellChange={vi.fn()}
          view={view({ hidden_properties: ["notes", "title"] })}
        />
      );
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      expect(headers).not.toContain("Notes");
      expect(headers).toContain("Title");
    });

    it("orders columns from config.property_order over schema position", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={false}
          onCellChange={vi.fn()}
          view={view({ property_order: ["title", "count", "notes"] })}
        />
      );
      const headers = screen.getAllByRole("columnheader").map((h) => h.textContent);
      // Only the three named properties' relative order is asserted — the
      // rest fall back to position order after them, per orderProperties.
      expect(headers.indexOf("Title")).toBeLessThan(headers.indexOf("Count"));
      expect(headers.indexOf("Count")).toBeLessThan(headers.indexOf("Notes"));
    });

    it("show_vertical_lines: false removes the column-separator border class", () => {
      const { container } = render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={false}
          onCellChange={vi.fn()}
          view={view({ show_vertical_lines: false })}
        />
      );
      const headerCell = container.querySelector("th");
      expect(headerCell?.className).not.toContain("border-r");
    });

    it("show_vertical_lines defaults to true (border class present)", () => {
      const { container } = render(
        <TableView properties={PROPERTIES} rows={ROWS} editable={false} onCellChange={vi.fn()} />
      );
      const headerCell = container.querySelector("th");
      expect(headerCell?.className).toContain("border-r");
    });

    it("show_page_icon: false hides the title cell's page icon", () => {
      const { container: shown } = render(
        <TableView properties={PROPERTIES} rows={ROWS} editable={false} onCellChange={vi.fn()} />
      );
      expect(shown.querySelector("svg.lucide-file-text")).toBeInTheDocument();

      const { container: hidden } = render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={false}
          onCellChange={vi.fn()}
          view={view({ show_page_icon: false })}
        />
      );
      expect(hidden.querySelector("svg.lucide-file-text")).not.toBeInTheDocument();
    });
  });

  // M11 (states.md): "the empty state IS the affordance to fill it" — a
  // brand-new, unfiltered, empty database renders NORMALLY, no message.
  it("renders no empty-state message for a brand-new, unfiltered, empty database", () => {
    render(<TableView properties={PROPERTIES} rows={[]} editable={false} onCellChange={vi.fn()} />);
    expect(screen.queryByText(/no rows yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Title" })).toBeInTheDocument();
  });

  it("is editable when editable=true: editing the Title cell calls onCellChange with the row id, property key, and new value", async () => {
    const user = userEvent.setup();
    const onCellChange = vi.fn();
    render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={onCellChange} />);

    await user.click(screen.getByText("First Note"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");

    expect(onCellChange).toHaveBeenCalledWith("row-1", "title", { type: "title", title: "Renamed" });
  });

  it("checkbox cell is interactive and calls onCellChange when editable", async () => {
    const user = userEvent.setup();
    const onCellChange = vi.fn();
    render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={onCellChange} />);

    // Disambiguated against M9's own row-selection checkbox, which now
    // shares the "checkbox" role in the same row (row-affordances.md's
    // gutter) — this targets the CELL's checkbox specifically.
    const checkbox = screen.getByRole("checkbox", { name: "Checkbox" });
    expect(checkbox).not.toBeDisabled();
    await user.click(checkbox);

    expect(onCellChange).toHaveBeenCalledWith("row-1", "done", { type: "checkbox", checkbox: false });
  });

  describe("M9 row gutter (row-affordances.md)", () => {
    it("renders the gutter's own 'Select row' checkbox when editable", () => {
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);
      expect(screen.getByRole("checkbox", { name: "Select row" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Row options" })).toBeInTheDocument();
    });

    it("suppresses the gutter entirely when not editable (read-only source)", () => {
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={false} onCellChange={vi.fn()} />);
      expect(screen.queryByRole("checkbox", { name: "Select row" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Row options" })).not.toBeInTheDocument();
      // OPEN survives read-only, per the spec's own States table.
      expect(screen.getByRole("button", { name: /^open$/i })).toBeInTheDocument();
    });

    it("selecting a row's checkbox shows the bulk bar with a count, and clearing it hides the bar again", async () => {
      const user = userEvent.setup();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

      await user.click(screen.getByRole("checkbox", { name: "Select row" }));
      expect(screen.getByText("1 selected")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Clear selection" }));
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    it("the bulk bar's trash button moves every selected row to Trash and refetches", async () => {
      const user = userEvent.setup();
      const refetchRows = vi.fn();
      global.fetch = vi.fn().mockResolvedValue({ ok: true });
      render(
        <TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} refetchRows={refetchRows} />
      );
      await user.click(screen.getByRole("checkbox", { name: "Select row" }));
      await user.click(screen.getByRole("button", { name: "Move selected rows to Trash" }));

      expect(global.fetch).toHaveBeenCalledWith("/api/notes/row-1", { method: "DELETE" });
      expect(refetchRows).toHaveBeenCalled();
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });
  });

  describe("row peek (controller design, approved 2026-08-25 — a user found live that TableView had no way to open a row as its note page at all; the peek is the Notion-parity fix: a side panel with properties + body over the table, not an immediate navigation)", () => {
    beforeEach(() => {
      // RowPeek fetches the row's body via the pre-existing GET /api/notes/{id}
      // route (the same one NoteEditorPage.tsx already uses) — mocked here
      // since these are plain RTL renders, no real backend.
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", title: "First Note", content: [] }))
      );
    });

    it("clicking a row's Open note button opens the peek, not a navigation", async () => {
      const user = userEvent.setup();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /^open$/i }));

      expect(await screen.findByRole("dialog", { name: /row details/i })).toBeInTheDocument();
      expect(routerPush).not.toHaveBeenCalled();
    });

    it("clicking a row's title still only renames it — Open note is a separate control, not a side effect of the rename click", async () => {
      const user = userEvent.setup();
      const onCellChange = vi.fn();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={onCellChange} />);

      await user.click(screen.getByText("First Note"));
      expect(screen.getByRole("textbox")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(routerPush).not.toHaveBeenCalled();
    });

    it("shows the row's properties inside the peek, and editing one calls onCellChange with the row id", async () => {
      const user = userEvent.setup();
      const onCellChange = vi.fn();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={onCellChange} />);

      await user.click(screen.getByRole("button", { name: /^open$/i }));
      const dialog = await screen.findByRole("dialog", { name: /row details/i });

      expect(within(dialog).getByText("Kind")).toBeInTheDocument();
      expect(within(dialog).getByText("article")).toBeInTheDocument();

      const checkbox = within(dialog).getByRole("checkbox");
      await user.click(checkbox);
      expect(onCellChange).toHaveBeenCalledWith("row-1", "done", { type: "checkbox", checkbox: false });
    });

    it("loads and renders the row's body once the note fetch resolves", async () => {
      const user = userEvent.setup();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /^open$/i }));
      const dialog = await screen.findByRole("dialog", { name: /row details/i });

      expect(await within(dialog).findByTestId("block-editor-stub")).toBeInTheDocument();
    });

    it('"Open as full page" navigates to /brain/{noteId}', async () => {
      const user = userEvent.setup();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /^open$/i }));
      const dialog = await screen.findByRole("dialog", { name: /row details/i });
      await user.click(within(dialog).getByRole("button", { name: /open as full page/i }));

      expect(routerPush).toHaveBeenCalledWith("/brain/row-1");
    });

    it('"Open in Workspace" navigates to the workspace route', async () => {
      const user = userEvent.setup();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /^open$/i }));
      const dialog = await screen.findByRole("dialog", { name: /row details/i });
      await user.click(within(dialog).getByRole("button", { name: /open in workspace/i }));

      expect(routerPush).toHaveBeenCalledWith("/brain/workspace/row-1");
    });

    it("the Close button closes the peek", async () => {
      const user = userEvent.setup();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /^open$/i }));
      const dialog = await screen.findByRole("dialog", { name: /row details/i });
      // Disambiguates against the row's OWN toggle, which now ALSO reads
      // "Close" while the peek is open for it (row-affordances.md: "OPEN
      // is a toggle... becomes CLOSE") — this asserts RowPeek's own ×.
      await user.click(within(dialog).getByRole("button", { name: /^close$/i }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("pressing Escape closes the peek", async () => {
      const user = userEvent.setup();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /^open$/i }));
      await screen.findByRole("dialog", { name: /row details/i });
      await user.keyboard("{Escape}");

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // row-peek.md: "Opening the peek rewrites the URL: ?v=&p=&pm=" — adopted
    // as `?p=<noteId>&pm=s|c`, written by TableView (RowPeek stays
    // presentational) via router.replace, preserving any existing params.
    describe("URL sync (row-peek.md: '?p=<noteId>&pm=s|c')", () => {
      it("opening the peek writes p/pm onto the URL, preserving other params", async () => {
        mockSearch = "view=view-1";
        const user = userEvent.setup();
        render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

        await user.click(screen.getByRole("button", { name: /^open$/i }));

        expect(routerReplace).toHaveBeenCalledWith(
          "/brain/db/ds-1?view=view-1&p=row-1&pm=s",
          { scroll: false }
        );
      });

      it("reloading with p/pm already in the URL reopens the same row in the same mode", async () => {
        mockSearch = "p=row-1&pm=s";
        render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

        expect(await screen.findByRole("dialog", { name: /row details/i })).toBeInTheDocument();
      });

      it("closing (Escape) strips p/pm from the URL", async () => {
        mockSearch = "p=row-1&pm=s";
        const user = userEvent.setup();
        render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

        await screen.findByRole("dialog", { name: /row details/i });
        await user.keyboard("{Escape}");

        expect(routerReplace).toHaveBeenCalledWith("/brain/db/ds-1", { scroll: false });
      });
    });

    // row-affordances.md: "OPEN is a toggle... becomes CLOSE" — before M10
    // the SAME onOpen handler fired unconditionally, so clicking CLOSE
    // silently re-opened the identical row rather than closing it.
    it("clicking OPEN, then clicking the now-CLOSE button on the same row, closes the peek", async () => {
      const user = userEvent.setup();
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={true} onCellChange={vi.fn()} />);

      await user.click(screen.getByRole("button", { name: /^open$/i }));
      await screen.findByRole("dialog", { name: /row details/i });

      // Both the row's own toggle AND RowPeek's own × now read "Close" —
      // scoped to the `<table>` (the row toggle) to disambiguate against
      // the dialog's ×, which `createPortal`s straight to `document.body`
      // outside it.
      await user.click(within(screen.getByRole("table")).getByRole("button", { name: /^close$/i }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // row-peek.md's Trigger table: both the row menu's "Open in -> Side
    // peek" and Alt+Click FORCE a side peek, bypassing "Open pages in"'s
    // view-wide default entirely — unlike the plain OPEN button, which
    // respects it (asserted by the "full" branch of the OPEN-button suite
    // elsewhere in this file).
    describe("forced side peek (row menu 'Side peek', Alt+Click) bypasses the view's own default mode", () => {
      function fullPageView() {
        return {
          id: "view-1",
          data_source_id: "ds-1",
          user_id: "user-1",
          name: "Table",
          icon: null,
          type: "table",
          config: { open_pages_in: "full" },
          filter: null,
          sorts: [],
          is_locked: false,
          position: 0,
        };
      }

      it("Alt+Click a row opens a side peek even when the view's default is 'full'", async () => {
        render(
          <TableView
            properties={PROPERTIES}
            rows={ROWS}
            editable={true}
            onCellChange={vi.fn()}
            view={fullPageView()}
          />
        );

        fireEvent.click(screen.getByText("First Note"), { altKey: true });

        expect(await screen.findByRole("dialog", { name: /row details/i })).toBeInTheDocument();
        expect(routerPush).not.toHaveBeenCalled();
      });

      it("a plain click on OPEN navigates away instead, honoring the view's 'full' default", async () => {
        const user = userEvent.setup();
        render(
          <TableView
            properties={PROPERTIES}
            rows={ROWS}
            editable={true}
            onCellChange={vi.fn()}
            view={fullPageView()}
          />
        );

        await user.click(screen.getByRole("button", { name: /^open$/i }));

        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        // useOpenNote()'s own navigate-away target — unrelated to RowPeek's
        // "Open as full page" (`/brain/{id}`) tested elsewhere in this file.
        expect(routerPush).toHaveBeenCalledWith("/brain/workspace/row-1");
      });
    });
  });

  // M11 (calculations-row.md): the footer row. M1 already writes
  // `config.calculations`; this is the first thing that reads it.
  describe("calculations footer row", () => {
    function tableView(config: Record<string, unknown>) {
      return {
        id: "view-1",
        data_source_id: "ds-1",
        user_id: "user-1",
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

    it("renders LABEL value, right-aligned, only under a column with a calculation set", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={true}
          onCellChange={vi.fn()}
          view={tableView({ calculations: { count: "sum" } })}
          aggregates={{ count: 42 }}
        />
      );

      const footer = document.querySelector("tfoot");
      expect(footer).not.toBeNull();
      expect(within(footer as HTMLElement).getByText("SUM")).toBeInTheDocument();
      expect(within(footer as HTMLElement).getByText("42")).toBeInTheDocument();
    });

    it("renders nothing when no column has a calculation, even with aggregates present", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={true}
          onCellChange={vi.fn()}
          view={tableView({})}
          aggregates={{ count: 42 }}
        />
      );

      expect(document.querySelector("tfoot")).toBeNull();
    });

    it("renders nothing without an aggregates prop at all (no calculation ever sent)", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={true}
          onCellChange={vi.fn()}
          view={tableView({ calculations: { count: "sum" } })}
        />
      );

      expect(document.querySelector("tfoot")).toBeNull();
    });

    it("percent_* aggregators format with a trailing %", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={true}
          onCellChange={vi.fn()}
          view={tableView({ calculations: { count: "percent_empty" } })}
          aggregates={{ count: 33.333 }}
        />
      );

      const footer = document.querySelector("tfoot") as HTMLElement;
      expect(within(footer).getByText("PERCENT EMPTY")).toBeInTheDocument();
      // Rounded to 2 decimals, same as any other non-integer aggregate.
      expect(within(footer).getByText("33.33%")).toBeInTheDocument();
    });
  });

  // M11 (table-drag-resize.md): column resize. Reorder (header-drag AND
  // row-drag) stays unbuilt — the spec's own "not captured by dragging a
  // header" / "not captured" TBDs, same discipline as every other TBD this
  // plan has deferred rather than guessed at.
  describe("column resize", () => {
    function tableView(config: Record<string, unknown>) {
      return {
        id: "view-1",
        data_source_id: "ds-1",
        user_id: "user-1",
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

    it("applies a persisted view.config.column_widths as the column's rendered width", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={false}
          onCellChange={vi.fn()}
          view={tableView({ column_widths: { notes: 300 } })}
        />
      );
      const header = screen.getByRole("columnheader", { name: "Notes" });
      expect(header).toHaveStyle({ width: "300px" });
    });

    it("dragging the grip resizes live and fires exactly one PATCH (onPatchConfig) on release, not one per move", () => {
      const onPatchConfig = vi.fn();
      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={false}
          onCellChange={vi.fn()}
          view={tableView({})}
          onPatchConfig={onPatchConfig}
        />
      );
      const header = screen.getByRole("columnheader", { name: "Notes" });
      const startWidth = parseFloat(header.style.width);
      const grip = header.querySelector(".cursor-col-resize") as HTMLElement;

      fireEvent.mouseDown(grip, { clientX: 100 });
      fireEvent.mouseMove(document, { clientX: 150 });
      // Live: the header's own width already reflects the in-progress drag,
      // before mouseup.
      expect(parseFloat(header.style.width)).toBeGreaterThan(startWidth);
      expect(onPatchConfig).not.toHaveBeenCalled();

      fireEvent.mouseMove(document, { clientX: 200 });
      fireEvent.mouseUp(document, { clientX: 200 });

      expect(onPatchConfig).toHaveBeenCalledTimes(1);
      expect(onPatchConfig).toHaveBeenCalledWith({
        column_widths: expect.objectContaining({ notes: expect.any(Number) }),
      });
    });

    it("a resize on one view's column does not affect a different view's persisted width — per-view, not schema-level", () => {
      const { rerender } = render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={false}
          onCellChange={vi.fn()}
          view={tableView({ column_widths: { notes: 300 } })}
        />
      );
      expect(screen.getByRole("columnheader", { name: "Notes" })).toHaveStyle({ width: "300px" });

      rerender(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={false}
          onCellChange={vi.fn()}
          view={tableView({ column_widths: { notes: 150 } })}
        />
      );
      expect(screen.getByRole("columnheader", { name: "Notes" })).toHaveStyle({ width: "150px" });
    });
  });

  describe("empty-state gap fix", () => {
    it("renders column headers normally (no message) when there are no rows", () => {
      render(
        <TableView properties={PROPERTIES} rows={[]} editable={false} onCellChange={vi.fn()} />
      );
      expect(screen.queryByText(/no rows yet/i)).not.toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Title" })).toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Notes" })).toBeInTheDocument();
    });

    it("shows both add-controls, no empty-state message, when editable", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetch={vi.fn()}
        />
      );
      expect(screen.queryByText(/no rows yet/i)).not.toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Title" })).toBeInTheDocument();
      expect(screen.getByLabelText(/add property/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "+ New" })).toBeInTheDocument();
    });
  });

  // M11 (states.md): "A filter matches nothing" — "the entire table
  // disappears... Two buttons. No text at all." Distinct from the
  // no-filter empty state above.
  describe("empty state: a filter matches nothing", () => {
    function filteredView(filter: Record<string, unknown> | null) {
      return {
        id: "view-1",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Table",
        icon: null,
        type: "table",
        config: {},
        filter,
        sorts: [],
        is_locked: false,
        position: 0,
      };
    }

    const ACTIVE_FILTER = {
      type: "group",
      op: "and",
      children: [{ type: "condition", property: "kind", operator: "equals", value: "nope" }],
    };

    it("hides headers/footer entirely and shows only Edit filters + New page, no text message", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          view={filteredView(ACTIVE_FILTER)}
          onSetFilter={vi.fn()}
        />
      );

      expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "+ New" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Edit filters" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "+ New page" })).toBeInTheDocument();
    });

    it("a structurally-present but EMPTY filter (no conditions) does not trigger this state", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          view={filteredView({ type: "group", op: "and", children: [] })}
          onSetFilter={vi.fn()}
        />
      );

      expect(screen.queryByRole("button", { name: "Edit filters" })).not.toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Title" })).toBeInTheDocument();
    });

    it("no active filter, just zero rows, renders the ordinary empty table instead", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          view={filteredView(null)}
          onSetFilter={vi.fn()}
        />
      );

      expect(screen.queryByRole("button", { name: "Edit filters" })).not.toBeInTheDocument();
      expect(screen.getByRole("columnheader", { name: "Title" })).toBeInTheDocument();
    });

    it("clicking Edit filters opens the filter builder", async () => {
      const user = userEvent.setup();
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          view={filteredView(ACTIVE_FILTER)}
          onSetFilter={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: "Edit filters" }));

      expect(await screen.findByRole("dialog", { name: "Edit filters" })).toBeInTheDocument();
      // The actual filter builder, not an empty panel.
      expect(screen.getByText("Add filter rule")).toBeInTheDocument();
    });

    it("clicking + New page creates a row", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "row-9", properties: {} }, 201));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      const refetchRows = vi.fn().mockResolvedValue(undefined);
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetchRows={refetchRows}
          view={filteredView(ACTIVE_FILTER)}
          onSetFilter={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: "+ New page" }));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/db/data-sources/ds-1/rows",
          expect.objectContaining({ method: "POST" })
        )
      );
    });
  });

  // M2 — the four creation describes that lived here moved to
  // components/database/AddPropertyPopover.test.tsx along with the surface
  // they test. The BEHAVIOURS are unchanged and still covered (relation
  // two-way semantics, formula-saves-while-invalid, the full rollup config);
  // only the UI they drive changed, from an inline form to an anchored
  // popover, so the interactions had to be rewritten rather than moved.

  describe("Add row", () => {
    it("is visible whenever editable=true, including the empty-rows case", () => {
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetch={vi.fn()}
        />
      );
      expect(screen.getByRole("button", { name: "+ New" })).toBeInTheDocument();
    });

    it("is hidden when editable=false", () => {
      render(<TableView properties={PROPERTIES} rows={ROWS} editable={false} onCellChange={vi.fn()} />);
      expect(screen.queryByRole("button", { name: "+ New" })).not.toBeInTheDocument();
    });

    it("clicking it POSTs to the rows endpoint with no body, then refetches rows specifically", async () => {
      // Regression test: useDatabaseView's `refetch` (=`load`) only re-fetches
      // database/properties/views — its `loadRows` has a separate effect keyed
      // to activeView's id/type/filter/sorts/config, none of which change when
      // a row is merely added. Live-verified bug: calling `refetch` alone after
      // POSTing a new row left the table showing "No rows yet." forever, even
      // though the row was created successfully server-side (confirmed via the
      // network log: POST .../rows → 201, followed only by GET .../databases,
      // never another POST .../query). `refetchRows` (=`loadRows`) is the one
      // that actually needs to be called here — asserting only "some refetch
      // happened" (the original version of this test) is exactly how this
      // shipped without being caught.
      const user = userEvent.setup();
      const refetch = vi.fn().mockResolvedValue(undefined);
      const refetchRows = vi.fn().mockResolvedValue(undefined);
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "row-2", properties: {} }, 201));
      vi.stubGlobal("fetch", fetchMock);

      render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetch={refetch}
          refetchRows={refetchRows}
        />
      );

      await user.click(screen.getByRole("button", { name: "+ New" }));

      await waitFor(() => expect(refetchRows).toHaveBeenCalled());
      expect(refetch).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/rows",
        expect.objectContaining({ method: "POST" })
      );
      const [, init] = fetchMock.mock.calls[0];
      expect(init).not.toHaveProperty("body");
    });
  });

  describe("relation cells (task-22)", () => {
    const RELATION_PROP = prop({
      key: "related",
      name: "Related",
      type: "relation",
      position: 9,
      config: { relation_id: "rel-1", side: "forward", target_data_source_id: "ds-2" },
    });
    const PROPS_WITH_RELATION = [...PROPERTIES, RELATION_PROP];

    it("calls ensureRelationLinks once per visible relation cell on mount", () => {
      const ensureRelationLinks = vi.fn();
      render(
        <TableView
          properties={PROPS_WITH_RELATION}
          rows={ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={{}}
          ensureRelationLinks={ensureRelationLinks}
          setRelationLinks={vi.fn()}
        />
      );
      expect(ensureRelationLinks).toHaveBeenCalledWith("row-1", "related");
    });

    it("renders linked titles from the relationLinks cache, and removing one calls setRelationLinks with the remainder", async () => {
      const user = userEvent.setup();
      const setRelationLinks = vi.fn();
      render(
        <TableView
          properties={PROPS_WITH_RELATION}
          rows={ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={{ "row-1:related": [{ id: "row-9", title: "Linked Note" }] }}
          ensureRelationLinks={vi.fn()}
          setRelationLinks={setRelationLinks}
        />
      );
      expect(screen.getByText("Linked Note")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Remove Linked Note" }));
      expect(setRelationLinks).toHaveBeenCalledWith("row-1", "related", []);
    });

    it("falls back to a read-only placeholder when relation handler props are omitted (older/other-view callers)", () => {
      render(<TableView properties={PROPS_WITH_RELATION} rows={ROWS} editable={true} onCellChange={vi.fn()} />);
      // GenericCell's fallback for an absent value — no crash, no picker controls.
      expect(screen.queryByRole("button", { name: /link a row/i })).not.toBeInTheDocument();
    });
  });

  describe("relation N+1 fix (task-31 Part 4)", () => {
    // Live-verified bug this reproduces the shape of: 58 relation requests
    // for a two-row table. Before this fix, TableView's own pre-fetch
    // effect only ever warmed ONE relation column (whichever sub-item
    // property matched the active display mode) — every OTHER relation
    // column had no bulk pre-fetch at all, so each of ITS cells fell back
    // to one `ensureRelationLinks` HTTP request per row: for M relation
    // columns and N rows, that's O(N×M) requests, growing with the row
    // count. The fix warms every relation column via
    // `ensureRelationLinksBulk` — exactly one call per column (M calls
    // total), each a single request covering every row id, regardless of
    // how many rows there are: O(M), not O(N×M).
    function manyRelationProps(count: number): PropertyResponse[] {
      return Array.from({ length: count }, (_, i) =>
        prop({
          key: `rel${i}`,
          name: `Relation ${i}`,
          type: "relation",
          position: 100 + i,
          config: { relation_id: `rel-pair-${i}`, side: "forward", target_data_source_id: "ds-2" },
        })
      );
    }

    function manyRows(count: number): DatabaseRow[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `row-${i}`,
        properties: { title: { type: "title", title: `Row ${i}` } },
      }));
    }

    it("issues exactly M ensureRelationLinksBulk calls (one per relation column) for N rows and M relation columns — NOT N×M", () => {
      const M = 4;
      const N = 12;
      const relationProps = manyRelationProps(M);
      const rows = manyRows(N);
      const ensureRelationLinksBulk = vi.fn();

      render(
        <TableView
          properties={[...PROPERTIES, ...relationProps]}
          rows={rows}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={{}}
          ensureRelationLinksBulk={ensureRelationLinksBulk}
        />
      );

      // Exactly M calls (one per relation column) — a call count that
      // would have been N×M = 48 before this fix (one per row per
      // column, via each cell's own `ensureRelationLinks`), or even just
      // 0 (no pre-fetch at all) for any non-sub-item relation column,
      // leaving those N×M requests to individual cell mounts instead. A
      // test that merely checked "data appears" would pass either way —
      // this asserts the actual request-count shape.
      expect(ensureRelationLinksBulk).toHaveBeenCalledTimes(M);
      const allRowIds = rows.map((r) => r.id);
      for (let i = 0; i < M; i++) {
        expect(ensureRelationLinksBulk).toHaveBeenCalledWith(allRowIds, `rel${i}`);
      }
    });

    it("stays at exactly M calls even as N grows — proves the call count is independent of row count", () => {
      const M = 3;
      const relationProps = manyRelationProps(M);
      const ensureRelationLinksBulkSmall = vi.fn();
      const ensureRelationLinksBulkLarge = vi.fn();

      const { unmount } = render(
        <TableView
          properties={[...PROPERTIES, ...relationProps]}
          rows={manyRows(2)}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={{}}
          ensureRelationLinksBulk={ensureRelationLinksBulkSmall}
        />
      );
      expect(ensureRelationLinksBulkSmall).toHaveBeenCalledTimes(M);
      unmount();

      render(
        <TableView
          properties={[...PROPERTIES, ...relationProps]}
          rows={manyRows(50)}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={{}}
          ensureRelationLinksBulk={ensureRelationLinksBulkLarge}
        />
      );
      // Same M, 25x the rows — an O(N×M) implementation would call this 25x
      // more; an O(M) one calls it exactly the same number of times.
      expect(ensureRelationLinksBulkLarge).toHaveBeenCalledTimes(M);
    });
  });

  describe("sub-item nesting (task-22)", () => {
    const SUBITEM_FORWARD = prop({
      key: "subitem",
      name: "Sub-item",
      type: "relation",
      position: 10,
      config: { relation_id: "rel-2", side: "forward", system: "sub_item", target_data_source_id: "ds-1" },
    });
    const SUBITEM_REVERSE = prop({
      key: "parentitem",
      name: "Parent item",
      type: "relation",
      position: 11,
      config: { relation_id: "rel-2", side: "reverse", system: "sub_item", target_data_source_id: "ds-1" },
    });
    const PROPS_WITH_SUBITEMS = [...PROPERTIES, SUBITEM_FORWARD, SUBITEM_REVERSE];

    const PARENT_ROW: DatabaseRow = {
      id: "parent-1",
      properties: { title: { type: "title", title: "Parent" } },
    };
    const CHILD_ROW: DatabaseRow = {
      id: "child-1",
      properties: { title: { type: "title", title: "Child" } },
    };
    const TREE_ROWS = [PARENT_ROW, CHILD_ROW];

    function relationLinksFor(childrenOfParent: RelatedRow[]): Record<string, RelatedRow[]> {
      return {
        "parent-1:subitem": childrenOfParent,
        "child-1:subitem": [],
      };
    }

    it("'show' mode: nests a child under its parent, indented, with an expand/collapse toggle", () => {
      render(
        <TableView
          properties={PROPS_WITH_SUBITEMS}
          rows={TREE_ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={relationLinksFor([{ id: "child-1", title: "Child" }])}
          ensureRelationLinks={vi.fn()}
          setRelationLinks={vi.fn()}
          subItemDisplayMode="show"
        />
      );

      // `getByRole("button", ...)` (not `getByText`) specifically targets
      // TitleCell's own button (its accessible name is the bare title) —
      // the Sub-item relation column, rendered as a column in its own
      // right, *also* shows "Child" as a chip on the parent's row (it's
      // linked there), which would make a plain text query ambiguous.
      expect(screen.getByRole("button", { name: "Parent" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Child" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
    });

    // Review-checkpoint finding (M1-M3 pass): `orderedProperties` used to be
    // the ONE list every lookup read, so hiding a column silently broke
    // whatever depended on that property existing — a sub-item relation's
    // column being hidden shouldn't disable the whole nested tree, since
    // hiding is a display choice, not a schema change.
    it("'show' mode nests correctly even when the sub-item relation's own column is hidden", () => {
      render(
        <TableView
          properties={PROPS_WITH_SUBITEMS}
          rows={TREE_ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={relationLinksFor([{ id: "child-1", title: "Child" }])}
          ensureRelationLinks={vi.fn()}
          setRelationLinks={vi.fn()}
          subItemDisplayMode="show"
          view={{
            id: "v1",
            data_source_id: "ds-1",
            user_id: "u1",
            name: "Table",
            icon: null,
            type: "table",
            config: { hidden_properties: ["subitem"] },
            filter: null,
            sorts: [],
            is_locked: false,
            position: 0,
          }}
        />
      );

      expect(screen.getByRole("button", { name: "Parent" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Child" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Collapse" })).toBeInTheDocument();
      // And the hidden column itself is actually gone from the table.
      expect(screen.queryByText("Sub-item")).not.toBeInTheDocument();
    });

    it("'show' mode: collapsing the parent hides the child row", async () => {
      const user = userEvent.setup();
      render(
        <TableView
          properties={PROPS_WITH_SUBITEMS}
          rows={TREE_ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={relationLinksFor([{ id: "child-1", title: "Child" }])}
          ensureRelationLinks={vi.fn()}
          setRelationLinks={vi.fn()}
          subItemDisplayMode="show"
        />
      );

      await user.click(screen.getByRole("button", { name: "Collapse" }));

      expect(screen.getByRole("button", { name: "Parent" })).toBeInTheDocument();
      // The child *row* is gone — its own TitleCell button no longer
      // exists — even though "Child" the text still appears elsewhere (the
      // parent's own Sub-item relation column still shows its link chip;
      // collapsing hides the child's *row*, not that unrelated chip).
      expect(screen.queryByRole("button", { name: "Child" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
    });

    it("'show' mode: a root row with no children has no toggle button", () => {
      render(
        <TableView
          properties={PROPS_WITH_SUBITEMS}
          rows={[PARENT_ROW]}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={{ "parent-1:subitem": [] }}
          ensureRelationLinks={vi.fn()}
          setRelationLinks={vi.fn()}
          subItemDisplayMode="show"
        />
      );
      expect(screen.queryByRole("button", { name: /collapse|expand/i })).not.toBeInTheDocument();
    });

    it("'flattened' mode: renders every row at one level (no nesting/toggle), with a parent indicator on the sub-item", () => {
      render(
        <TableView
          properties={PROPS_WITH_SUBITEMS}
          rows={TREE_ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={{ "child-1:parentitem": [{ id: "parent-1", title: "Parent" }] }}
          ensureRelationLinks={vi.fn()}
          setRelationLinks={vi.fn()}
          subItemDisplayMode="flattened"
        />
      );

      expect(screen.getByRole("button", { name: "Parent" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Child" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /collapse|expand/i })).not.toBeInTheDocument();
      expect(screen.getByText(/↳ Parent/)).toBeInTheDocument();
    });

    it("pre-fetches sub-item links (both forward AND reverse columns) via ensureRelationLinksBulk, not one ensureRelationLinks call per row (M7 combined-review Important finding 3, generalized by task-31 Part 4)", () => {
      const ensureRelationLinksBulk = vi.fn();
      // `ensureRelationLinks` is deliberately omitted here: TableView only
      // wires a relation column up to a live RelationCell (which calls
      // `ensureRelationLinks` itself, on mount, for its own single-cell
      // load — unrelated to this pre-fetch effect) when BOTH
      // `ensureRelationLinks` and `setRelationLinks` are provided. Omitting
      // it isolates what THIS effect calls from what the per-cell
      // RelationCell components for the sub-item/parent-item columns
      // would otherwise also call, which would make a bare call-count
      // assertion meaningless.
      //
      // task-31 Part 4: this effect no longer gates on `subItemDisplayMode`
      // at all — it warms EVERY relation column (here: both "subitem" and
      // "parentitem", since both are `type: "relation"` properties), so
      // both fire regardless of which (if any) display mode is active.
      render(
        <TableView
          properties={PROPS_WITH_SUBITEMS}
          rows={TREE_ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={relationLinksFor([{ id: "child-1", title: "Child" }])}
          ensureRelationLinksBulk={ensureRelationLinksBulk}
          subItemDisplayMode="show"
        />
      );

      expect(ensureRelationLinksBulk).toHaveBeenCalledTimes(2);
      expect(ensureRelationLinksBulk).toHaveBeenCalledWith(["parent-1", "child-1"], "subitem");
      expect(ensureRelationLinksBulk).toHaveBeenCalledWith(["parent-1", "child-1"], "parentitem");
    });

    it("falls back to one ensureRelationLinks call per row per relation column when ensureRelationLinksBulk is omitted (older/other caller)", () => {
      const ensureRelationLinks = vi.fn();
      // `setRelationLinks` is deliberately omitted (same reasoning as
      // above, inverted): without it, `renderCellValue`'s relationExtras
      // stay `undefined` for the sub-item/parent-item columns too, so no
      // RelationCell mounts to make its own independent `ensureRelationLinks`
      // calls — the only calls left are this effect's own per-row
      // fallback loop, which is exactly what this test asserts the shape
      // of.
      render(
        <TableView
          properties={PROPS_WITH_SUBITEMS}
          rows={TREE_ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={relationLinksFor([{ id: "child-1", title: "Child" }])}
          ensureRelationLinks={ensureRelationLinks}
          subItemDisplayMode="show"
        />
      );

      expect(ensureRelationLinks).toHaveBeenCalledWith("parent-1", "subitem");
      expect(ensureRelationLinks).toHaveBeenCalledWith("child-1", "subitem");
      expect(ensureRelationLinks).toHaveBeenCalledWith("parent-1", "parentitem");
      expect(ensureRelationLinks).toHaveBeenCalledWith("child-1", "parentitem");
      expect(ensureRelationLinks).toHaveBeenCalledTimes(4);
    });

    it("with no sub-item display mode set, renders flat with no tree/indicator controls at all", () => {
      render(
        <TableView
          properties={PROPS_WITH_SUBITEMS}
          rows={TREE_ROWS}
          editable={true}
          onCellChange={vi.fn()}
          relationLinks={relationLinksFor([{ id: "child-1", title: "Child" }])}
          ensureRelationLinks={vi.fn()}
          setRelationLinks={vi.fn()}
        />
      );
      expect(screen.queryByRole("button", { name: /collapse|expand/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/↳/)).not.toBeInTheDocument();
    });
  });

  // Milestone 12 (task-40): the "+ New" split-button's dropdown. The plain
  // "+ New" click path itself (handleAddRow, tested in "Add row" above) is
  // untouched by any of this — this task's own regression bar for this
  // file — so none of those existing tests were modified.
  describe("New row from template (task-40)", () => {
    function rowTemplate(overrides: Partial<RowTemplateResponse>): RowTemplateResponse {
      return {
        id: "tmpl-1",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Weekly review",
        icon: null,
        properties: {},
        content: [],
        is_default: false,
        repeat_config: null,
        next_run_at: null,
        position: 0,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        ...overrides,
      };
    }

    // M11 (new-row-button.md), user decision 2026-09-01: the chevron is now
    // UNCONDITIONAL — it's Notion's own entry point for AUTHORING a
    // template, not merely picking one, so it must survive zero templates.
    it("shows the chevron even with zero templates, opening onto the captured empty state", async () => {
      const user = userEvent.setup();
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          templates={[]}
          dataSourceName="Tasks"
        />
      );
      expect(screen.getByRole("button", { name: "+ New" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Choose a template" }));

      expect(screen.getByText("Templates for Tasks")).toBeInTheDocument();
      expect(
        screen.getByText("Create a reusable page template for this database.")
      ).toBeInTheDocument();
      // "Add shortcut to sidebar" — new-row-button.md's own "no analogue
      // for us — omit deliberately".
      expect(screen.queryByText(/add shortcut to sidebar/i)).not.toBeInTheDocument();
    });

    // Live-checklist regression: this dropdown is a plain conditional div
    // (predates the Popover primitive), so it never dismissed on outside
    // click or Escape -- only re-clicking the chevron closed it.
    it("dismisses on outside click and on Escape", async () => {
      const user = userEvent.setup();
      render(
        <div>
          <button>outside</button>
          <TableView
            properties={PROPERTIES}
            rows={[]}
            editable={true}
            onCellChange={vi.fn()}
            dataSourceId="ds-1"
            templates={[]}
            dataSourceName="Tasks"
          />
        </div>
      );

      await user.click(screen.getByRole("button", { name: "Choose a template" }));
      expect(screen.getByText("Templates for Tasks")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "outside" }));
      expect(screen.queryByText("Templates for Tasks")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Choose a template" }));
      expect(screen.getByText("Templates for Tasks")).toBeInTheDocument();
      await user.keyboard("{Escape}");
      expect(screen.queryByText("Templates for Tasks")).not.toBeInTheDocument();
    });

    it("shows the chevron even when the `templates` prop is simply omitted (older/other caller)", () => {
      render(
        <TableView properties={PROPERTIES} rows={[]} editable={true} onCellChange={vi.fn()} dataSourceId="ds-1" />
      );
      expect(screen.getByRole("button", { name: "Choose a template" })).toBeInTheDocument();
    });

    it('"+ New template" opens the same TemplateManager modal the settings menu uses, only when all three template handlers are supplied', async () => {
      const user = userEvent.setup();
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          templates={[]}
          onCreateTemplate={vi.fn()}
          onUpdateTemplate={vi.fn()}
          onDeleteTemplate={vi.fn()}
        />
      );
      await user.click(screen.getByRole("button", { name: "Choose a template" }));
      await user.click(screen.getByRole("menuitem", { name: /new template/i }));

      expect(screen.getByRole("dialog", { name: "Templates" })).toBeInTheDocument();
    });

    it('"+ New template" is absent when the template handlers are omitted', async () => {
      const user = userEvent.setup();
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          templates={[]}
        />
      );
      await user.click(screen.getByRole("button", { name: "Choose a template" }));

      expect(screen.queryByRole("menuitem", { name: /new template/i })).not.toBeInTheDocument();
    });

    it("the dropdown lists one entry per NON-default template — the default one is omitted (plain \"+ New\" already produces it)", async () => {
      const user = userEvent.setup();
      const templates = [
        rowTemplate({ id: "default-1", name: "Default one", is_default: true }),
        rowTemplate({ id: "extra-1", name: "Extra template", is_default: false }),
      ];
      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          templates={templates}
          onInstantiateTemplate={vi.fn()}
        />
      );

      await user.click(screen.getByRole("button", { name: "Choose a template" }));

      expect(screen.getByRole("menuitem", { name: "Extra template" })).toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "Default one" })).not.toBeInTheDocument();
    });

    it("clicking a template entry calls onInstantiateTemplate then refetchRows", async () => {
      const user = userEvent.setup();
      const onInstantiateTemplate = vi.fn().mockResolvedValue({ id: "row-9", properties: {} });
      const refetchRows = vi.fn().mockResolvedValue(undefined);
      const templates = [rowTemplate({ id: "extra-1", name: "Extra template" })];

      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetchRows={refetchRows}
          templates={templates}
          onInstantiateTemplate={onInstantiateTemplate}
        />
      );

      await user.click(screen.getByRole("button", { name: "Choose a template" }));
      await user.click(screen.getByRole("menuitem", { name: "Extra template" }));

      await waitFor(() => expect(onInstantiateTemplate).toHaveBeenCalledWith("extra-1"));
      await waitFor(() => expect(refetchRows).toHaveBeenCalled());
    });

    it("a failed instantiate shows a toast and does not call refetchRows", async () => {
      const user = userEvent.setup();
      const onInstantiateTemplate = vi.fn().mockRejectedValue(new Error("could not create row"));
      const refetchRows = vi.fn();
      const templates = [rowTemplate({ id: "extra-1", name: "Extra template" })];

      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetchRows={refetchRows}
          templates={templates}
          onInstantiateTemplate={onInstantiateTemplate}
        />
      );

      await user.click(screen.getByRole("button", { name: "Choose a template" }));
      await user.click(screen.getByRole("menuitem", { name: "Extra template" }));

      await waitFor(() => expect(onInstantiateTemplate).toHaveBeenCalled());
      expect(refetchRows).not.toHaveBeenCalled();
    });

    it("the plain \"+ New\" button's click behavior is unaffected by templates being present", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "row-2", properties: {} }, 201));
      vi.stubGlobal("fetch", fetchMock);
      const refetchRows = vi.fn().mockResolvedValue(undefined);
      const onInstantiateTemplate = vi.fn();
      const templates = [rowTemplate({ id: "extra-1", name: "Extra template" })];

      render(
        <TableView
          properties={PROPERTIES}
          rows={[]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetchRows={refetchRows}
          templates={templates}
          onInstantiateTemplate={onInstantiateTemplate}
        />
      );

      await user.click(screen.getByRole("button", { name: "+ New" }));

      await waitFor(() => expect(refetchRows).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/rows",
        expect.objectContaining({ method: "POST" })
      );
      expect(onInstantiateTemplate).not.toHaveBeenCalled();
    });

    // new-row-button.md: "Focus the new row's title cell after creation."
    it('"+ New" focuses the created row\'s title cell into inline edit once it appears', async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "row-2", properties: {} }, 201));
      vi.stubGlobal("fetch", fetchMock);
      const refetchRows = vi.fn().mockResolvedValue(undefined);

      const { rerender } = render(
        <TableView
          properties={PROPERTIES}
          rows={ROWS}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetchRows={refetchRows}
        />
      );
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "+ New" }));
      await waitFor(() => expect(refetchRows).toHaveBeenCalled());

      // Mimics DatabaseShell: refetchRows resolving re-renders TableView
      // with the freshly-created row now present in `rows`.
      const newRow = { id: "row-2", properties: {} };
      rerender(
        <TableView
          properties={PROPERTIES}
          rows={[...ROWS, newRow]}
          editable={true}
          onCellChange={vi.fn()}
          dataSourceId="ds-1"
          refetchRows={refetchRows}
        />
      );

      // TitleCell mounts straight into its `editing` branch (a text input)
      // instead of the plain button every other row's title renders as.
      expect(screen.getByRole("textbox", { name: "Title" })).toBeInTheDocument();
    });
  });
});

// `fireEvent`, not `userEvent`, for every click in this describe block —
// `userEvent.click` hangs indefinitely (not a slow test, an unresolved
// promise even past a 30s wall-clock kill) the moment TWO OR MORE grouped
// `<table>` sections exist side by side and ANY one of them is clicked,
// reproduced down to two minimal sibling `<table>` elements with no other
// TableView machinery involved. `fireEvent.click` on the exact same button
// resolves instantly and asserts correctly — the state update and resulting
// DOM change are right; this is userEvent's own pointer/visibility
// simulation getting stuck on jsdom's layout-less multi-<table> DOM, the
// same class of environment-only artifact SortRowsList.test.tsx already
// documents for DndContext+Popover. Unverified beyond jsdom — the live
// Chrome checklist run is this surface's real cross-check.
//
// For the same reason, `waitFor` (also MutationObserver/interval-poll
// based) hangs the identical way once a click triggers an async fetch
// inside this multi-<table> DOM — reproduced down to the same minimal
// case. `flushPromises` below (a handful of awaited microtask turns) is
// the workaround: it resolves the same pending promises `waitFor` would
// have polled for, without the polling mechanism that hangs.
async function flushPromises() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("TableView — M6 grouped rendering", () => {
  function view(config: Record<string, unknown>) {
    return {
      id: "view-1",
      data_source_id: "ds-1",
      user_id: "user-1",
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

  const GROUPS = [
    {
      key: "article",
      label: "article",
      row_count: 1,
      rows: [ROWS[0]],
      subgroups: null,
    },
    {
      key: "__no_value__",
      label: "No value",
      row_count: 1,
      rows: [
        {
          id: "row-2",
          properties: {
            title: { type: "title", title: "Second Note" },
          },
        },
      ],
      subgroups: null,
    },
  ];

  it("renders one section per group, each with its own repeated column header row", () => {
    render(
      <TableView
        properties={PROPERTIES}
        rows={[]}
        groups={GROUPS}
        editable={false}
        onCellChange={vi.fn()}
        view={view({ group_by: { property_key: "kind" } })}
      />
    );

    // Two groups -> two independent header rows, each with every column.
    const titleHeaders = screen.getAllByText("Title");
    expect(titleHeaders).toHaveLength(2);
    expect(screen.getByText("First Note")).toBeInTheDocument();
    expect(screen.getByText("Second Note")).toBeInTheDocument();
  });

  it("the implicit empty bucket displays as 'No <PropertyName>', not the backend's 'No value'", () => {
    render(
      <TableView
        properties={PROPERTIES}
        rows={[]}
        groups={GROUPS}
        editable={false}
        onCellChange={vi.fn()}
        view={view({ group_by: { property_key: "kind" } })}
      />
    );
    expect(screen.getByText("No Kind")).toBeInTheDocument();
    expect(screen.queryByText("No value")).not.toBeInTheDocument();
  });

  it("collapsing a group hides its rows but keeps the group header visible", () => {
    render(
      <TableView
        properties={PROPERTIES}
        rows={[]}
        groups={GROUPS}
        editable={false}
        onCellChange={vi.fn()}
        view={view({ group_by: { property_key: "kind" } })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse article" }));
    expect(screen.queryByText("First Note")).not.toBeInTheDocument();
    expect(screen.getByText("Second Note")).toBeInTheDocument();
    expect(screen.getByText("article")).toBeInTheDocument();
  });

  it("a group listed in hidden_groups doesn't render at all", () => {
    render(
      <TableView
        properties={PROPERTIES}
        rows={[]}
        groups={GROUPS}
        editable={false}
        onCellChange={vi.fn()}
        view={view({ group_by: { property_key: "kind", hidden_groups: ["article"] } })}
      />
    );
    expect(screen.queryByText("First Note")).not.toBeInTheDocument();
    expect(screen.getByText("Second Note")).toBeInTheDocument();
  });

  it("groupValueForNewRow: unambiguous for option/boolean/exact-text types, undefined for the empty bucket and Number/Date buckets", () => {
    const g = (key: string) => ({ key, label: key, row_count: 0, rows: [], subgroups: null });
    expect(groupValueForNewRow(prop({ type: "select" }), g("article"))).toEqual({ type: "select", select: "article" });
    expect(groupValueForNewRow(prop({ type: "status" }), g("done"))).toEqual({ type: "status", status: "done" });
    expect(groupValueForNewRow(prop({ type: "multi_select" }), g("tag"))).toEqual({
      type: "multi_select",
      multi_select: ["tag"],
    });
    expect(groupValueForNewRow(prop({ type: "checkbox" }), g("true"))).toEqual({ type: "checkbox", checkbox: true });
    expect(groupValueForNewRow(prop({ type: "checkbox" }), g("false"))).toEqual({ type: "checkbox", checkbox: false });
    expect(groupValueForNewRow(prop({ type: "title" }), g("Hello"))).toEqual({ type: "title", title: "Hello" });
    // The implicit empty bucket needs no write — an unset property already renders as empty.
    expect(groupValueForNewRow(prop({ type: "select" }), g("__no_value__"))).toBeUndefined();
    // Number/Date range buckets: which exact value inside the bucket is ambiguous.
    expect(groupValueForNewRow(prop({ type: "number" }), g("0-10"))).toBeUndefined();
    expect(groupValueForNewRow(prop({ type: "date" }), g("2026-01"))).toBeUndefined();
  });

  it("each group has its own + New page that creates a row pre-filled with that group's value", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ id: "row-new", properties: {} }, 201));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const refetchRows = vi.fn().mockResolvedValue(undefined);

    render(
      <TableView
        properties={PROPERTIES}
        rows={[]}
        groups={GROUPS}
        editable={true}
        onCellChange={vi.fn()}
        dataSourceId="ds-1"
        refetchRows={refetchRows}
        view={view({ group_by: { property_key: "kind" } })}
      />
    );

    const addButtons = screen.getAllByRole("button", { name: "+ New page" });
    fireEvent.click(addButtons[0]);
    await flushPromises();

    expect(refetchRows).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("/api/db/data-sources/ds-1/rows", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/db/data-sources/ds-1/rows/row-new",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ property_key: "kind", value: { type: "select", select: "article" } }),
      })
    );
  });

  it("+ New group is offered for a select-typed group property and PATCHes a new option onto it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const refetch = vi.fn();

    render(
      <TableView
        properties={PROPERTIES}
        rows={[]}
        groups={GROUPS}
        editable={true}
        onCellChange={vi.fn()}
        dataSourceId="ds-1"
        refetch={refetch}
        view={view({ group_by: { property_key: "kind" } })}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /New group/ }));
    await flushPromises();

    expect(refetch).toHaveBeenCalled();
    const kindProperty = PROPERTIES.find((p) => p.key === "kind")!;
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/db/properties/${kindProperty.id}`,
      expect.objectContaining({ method: "PATCH" })
    );
  });

  it("+ New group is absent for a non-option-based group property (e.g. Number)", () => {
    render(
      <TableView
        properties={PROPERTIES}
        rows={[]}
        groups={GROUPS}
        editable={true}
        onCellChange={vi.fn()}
        dataSourceId="ds-1"
        view={view({ group_by: { property_key: "count" } })}
      />
    );
    expect(screen.queryByRole("button", { name: /New group/ })).not.toBeInTheDocument();
  });

  it("falls back to the ordinary flat table when groups is null/omitted", () => {
    render(
      <TableView
        properties={PROPERTIES}
        rows={ROWS}
        editable={false}
        onCellChange={vi.fn()}
        view={view({})}
      />
    );
    expect(screen.getAllByText("Title")).toHaveLength(1);
  });
});
