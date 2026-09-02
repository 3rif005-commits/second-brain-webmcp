import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({ useToast: () => ({ showToast }) }));

// Real BlockEditor mounts BlockNote — heavy, and RowPeek's own tests only
// need to prove the fetched content reaches whatever body component is
// mounted, not re-test BlockNote itself. Same stub TemplateEditor.test.tsx/
// TableView.test.tsx already use for the identical reason.
vi.mock("@/components/editor/BlockEditor", () => ({
  BlockEditor: ({
    initialContent,
    onSave,
  }: {
    initialContent?: unknown[];
    onSave?: (blocks: unknown[], plainText: string) => void;
  }) => (
    <div data-testid="block-editor-stub">
      <span data-testid="block-editor-content">{JSON.stringify(initialContent)}</span>
      <button type="button" onClick={() => onSave?.([{ type: "paragraph" }], "hi")}>
        trigger save
      </button>
    </div>
  ),
}));

import { RowPeek } from "./RowPeek";
import type { DatabaseRow, PropertyResponse } from "@/lib/database/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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

const PROPERTIES = [
  prop({ key: "title", name: "Title", type: "title", position: 0 }),
  prop({ key: "kind", name: "Kind", type: "select", position: 1 }),
  prop({ key: "done", name: "Done", type: "checkbox", position: 2 }),
];

const ROW: DatabaseRow = {
  id: "row-1",
  properties: {
    title: { type: "title", title: "First Note" },
    kind: { type: "select", select: "article" },
    done: { type: "checkbox", checkbox: true },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  routerPush.mockClear();
  showToast.mockClear();
});

describe("RowPeek", () => {
  it("renders the title, every non-title property, and the fetched body content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [{ type: "paragraph" }] }))
    );

    render(
      <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
    );

    expect(screen.getByText("First Note")).toBeInTheDocument();
    expect(screen.getByText("Kind")).toBeInTheDocument();
    expect(screen.getByText("article")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();

    const contentEl = await screen.findByTestId("block-editor-content");
    expect(contentEl.textContent).toBe(JSON.stringify([{ type: "paragraph" }]));
  });

  it("does not render a title/property section for a title-less property list, and still loads the body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));
    const noTitleProps = PROPERTIES.filter((p) => p.type !== "title");

    render(
      <RowPeek row={ROW} properties={noTitleProps} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
    );

    expect(screen.queryByText("First Note")).not.toBeInTheDocument();
    expect(await screen.findByTestId("block-editor-stub")).toBeInTheDocument();
  });

  it("a failed note fetch degrades to an empty body instead of getting stuck loading forever", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    render(
      <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
    );

    const contentEl = await screen.findByTestId("block-editor-content");
    expect(contentEl.textContent).toBe(JSON.stringify([]));
  });

  it("the Close button calls onClose", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={onClose} />
    );
    await user.click(screen.getByRole("button", { name: /close/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("center mode: clicking the backdrop calls onClose, clicking inside the panel does not", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <RowPeek
        row={ROW}
        properties={PROPERTIES}
        editable={true}
        onCellChange={vi.fn()}
        onClose={onClose}
        mode="center"
      />
    );

    await user.click(screen.getByText("Kind"));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // view-options-panel.md §C: "side" (the default) is Notion's own default
  // and its own copy for it is "Keeps the view behind interactive" — direct
  // textual confirmation this mode must be non-modal. There is no backdrop
  // to click here, unlike "center" above.
  it("side mode (the default) is non-modal: no backdrop, aria-modal absent", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));

    render(
      <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toHaveAttribute("aria-modal");
    expect(dialog.className).not.toContain("bg-black");
  });

  it("saving the body PATCHes /api/notes/{id} with the new blocks", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/notes/row-1") return Promise.resolve(jsonResponse({ id: "row-1", content: [] }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(
      <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
    );
    await screen.findByTestId("block-editor-stub");
    await user.click(screen.getByRole("button", { name: /trigger save/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/notes/row-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ content: [{ type: "paragraph" }], content_text: "hi" }),
        })
      );
    });
  });

  // M10 (row-peek.md): "Ordering: Alphabetical — not table order."
  it("orders non-title properties alphabetically, not by their table position", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));

    render(
      <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
    );
    await screen.findByTestId("block-editor-stub");

    // RowPeek portals straight to document.body (see RowPeek.tsx), outside
    // RTL's own `container` — queried from `document` for that reason.
    // PROPERTIES' table order is Kind (position 1) then Done (position 2);
    // alphabetically "Done" sorts before "Kind".
    const labels = Array.from(document.querySelectorAll(".grid.grid-cols-\\[120px_1fr\\] > span"))
      .map((el) => el.textContent?.trim())
      .filter(Boolean);
    expect(labels).toEqual(["Done", "Kind"]);
  });

  // M10 (row-peek.md): "Empty values render the literal muted word `Empty`."
  it("an empty property shows the literal word Empty, and clicking it reveals its real editable control", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));
    const props = [
      prop({ key: "title", name: "Title", type: "title", position: 0 }),
      prop({ key: "notes", name: "Notes", type: "rich_text", position: 1 }),
    ];
    const row = { id: "row-1", properties: { title: { type: "title", title: "First Note" } } };
    const user = userEvent.setup();

    render(<RowPeek row={row} properties={props} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />);
    await screen.findByTestId("block-editor-stub");

    const empty = screen.getByRole("button", { name: /^empty$/i });
    await user.click(empty);

    // TextCell.tsx has its own separate click-to-edit affordance (a "—"
    // placeholder button, unrelated to and unchanged by M10) — clicking
    // "Empty" only needs to hand off to THAT real control, not skip past
    // its own click-target too.
    expect(screen.queryByRole("button", { name: /^empty$/i })).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("a read-only row's Empty placeholder is not clickable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));
    const props = [
      prop({ key: "title", name: "Title", type: "title", position: 0 }),
      prop({ key: "notes", name: "Notes", type: "rich_text", position: 1 }),
    ];
    const row = { id: "row-1", properties: { title: { type: "title", title: "First Note" } } };

    render(<RowPeek row={row} properties={props} editable={false} onCellChange={vi.fn()} onClose={vi.fn()} />);
    await screen.findByTestId("block-editor-stub");

    expect(screen.getByRole("button", { name: /^empty$/i })).toBeDisabled();
  });

  describe("header bar (row-peek.md: '»  ⤢          Share  ★  ⋯')", () => {
    it("the star PATCHes is_favorited on the row", async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();

      render(
        <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
      );
      await screen.findByTestId("block-editor-stub");
      await user.click(screen.getByRole("button", { name: /add to favorites/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/notes/row-1",
          expect.objectContaining({
            method: "PATCH",
            body: JSON.stringify({ is_favorited: true }),
          })
        );
      });
      expect(showToast).toHaveBeenCalledWith("Added to Favorites", "info");
    });

    it("Share and the page menu (⋯) are disabled — no sharing or page-menu surface exists yet", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));

      render(
        <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
      );
      await screen.findByTestId("block-editor-stub");

      expect(screen.getByRole("button", { name: /^share$/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^more$/i })).toBeDisabled();
    });
  });

  describe('"+ Add a property" (row-peek.md checklist #12-14: schema-level, scope-disclaimed)', () => {
    it("is suppressed without a dataSourceId, even when editable", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));

      render(
        <RowPeek row={ROW} properties={PROPERTIES} editable={true} onCellChange={vi.fn()} onClose={vi.fn()} />
      );
      await screen.findByTestId("block-editor-stub");

      expect(screen.queryByRole("button", { name: /add a property/i })).not.toBeInTheDocument();
    });

    it("is suppressed for a read-only source even with a dataSourceId", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));

      render(
        <RowPeek
          row={ROW}
          properties={PROPERTIES}
          editable={false}
          onCellChange={vi.fn()}
          onClose={vi.fn()}
          dataSourceId="ds-1"
        />
      );
      await screen.findByTestId("block-editor-stub");

      expect(screen.queryByRole("button", { name: /add a property/i })).not.toBeInTheDocument();
    });

    it("opens a single-column type picker carrying the scope disclaimer, editable + dataSourceId given", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ id: "row-1", content: [] })));
      const user = userEvent.setup();

      render(
        <RowPeek
          row={ROW}
          properties={PROPERTIES}
          editable={true}
          onCellChange={vi.fn()}
          onClose={vi.fn()}
          dataSourceId="ds-1"
        />
      );
      await screen.findByTestId("block-editor-stub");
      await user.click(screen.getByRole("button", { name: /add a property/i }));

      expect(await screen.findByText("Number")).toBeInTheDocument();
      expect(screen.getByText("Changes apply to all views showing this property.")).toBeInTheDocument();
    });
  });
});
