// @vitest-environment jsdom
import { StrictMode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
// @ts-ignore — @blocknote/core@0.48.0 ships an empty index.d.ts (upstream bug); runtime exports are fine
import { BlockNoteSchema, defaultBlockSpecs, BlockNoteEditor } from "@blocknote/core";
import {
  DatabaseBlockSpec,
  insertDatabaseBlock,
  InlineDatabaseView,
  InlineDatabaseTable,
} from "./DatabaseBlock";
import { NoteIdContext } from "../editor/noteIdContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Mirrors customBlocks.test.tsx's makeEditor() — schema + BlockNoteEditor.create
// + .mount(document.createElement("div")) is the exact pattern this app's own
// suite uses to build a real, non-DOM-rendered editor instance.
function makeEditor(initialContent?: AnyBlock[]) {
  const schema = BlockNoteSchema.create({
    blockSpecs: { ...defaultBlockSpecs, database: DatabaseBlockSpec() },
  });
  const editor = BlockNoteEditor.create({ schema, initialContent });
  editor.mount(document.createElement("div"));
  return editor;
}

describe("DatabaseBlockSpec schema build", () => {
  it("builds a working editor when the block spec factory is invoked", () => {
    expect(() => makeEditor()).not.toThrow();
  });

  it("crashes with the literal 'reading node' error when registered uninvoked", () => {
    // createReactBlockSpec returns a FACTORY, not a BlockSpec — registering
    // it uninvoked (the plan's own literal test case) crashes schema
    // creation with this exact message, not just "throws something".
    expect(() => {
      const schema = BlockNoteSchema.create({
        blockSpecs: { ...defaultBlockSpecs, database: DatabaseBlockSpec as unknown as AnyBlock },
      });
      const editor = BlockNoteEditor.create({ schema });
      editor.mount(document.createElement("div"));
    }).toThrow(/Cannot read properties of undefined \(reading 'node'\)/);
  });
});

describe("database block round-trips through a save/load cycle", () => {
  it("keeps databaseId/viewId props byte-identical across JSON.parse(JSON.stringify(...))", () => {
    const editor1 = makeEditor();
    editor1.replaceBlocks(editor1.document, [
      { type: "database", props: { databaseId: "db-abc123", viewId: "view-xyz789" } },
    ]);
    const original = (editor1.document as AnyBlock[]).find((b) => b.type === "database");
    expect(original).toBeTruthy();
    expect(original.props).toEqual({ databaseId: "db-abc123", viewId: "view-xyz789" });

    // The exact mechanism a real save/reload cycle goes through — the
    // note's `content` column is this same JSON.
    const reloaded = JSON.parse(JSON.stringify(editor1.document));

    const editor2 = makeEditor(reloaded);
    const roundTripped = (editor2.document as AnyBlock[]).find((b) => b.type === "database");

    expect(roundTripped).toBeTruthy();
    expect(roundTripped.props).toEqual(original.props);
  });
});

describe("insertDatabaseBlock", () => {
  it("inserts a database-typed block immediately after the given block id", () => {
    const editor = makeEditor([
      { type: "paragraph", content: "First" },
      { type: "paragraph", content: "Second" },
    ]);
    const [first] = editor.document as AnyBlock[];

    insertDatabaseBlock(editor, first.id);

    const doc = editor.document as AnyBlock[];
    // BlockNote auto-inserts an empty paragraph directly after a
    // content:"none" block wherever it lands (live-verified — not this
    // task's own behavior to control), so a `database` block inserted
    // between two paragraphs pushes the doc to 4 blocks, not 3. The load-
    // bearing assertions are the position (right after `first`, right
    // before the original "Second") and the fresh block's props.
    expect(doc.map((b) => b.type)).toEqual(["paragraph", "database", "paragraph", "paragraph"]);
    expect(doc[1].props).toEqual({ databaseId: "", viewId: "" });
    // One of the two trailing paragraphs is the original "Second" (now
    // pushed later by BlockNote's own auto-inserted empty one) — assert
    // its text still exists in the doc rather than assuming which index,
    // since which one BlockNote places first isn't this task's contract.
    const texts = doc
      .slice(2)
      .map((b) => (Array.isArray(b.content) ? b.content.map((c: AnyBlock) => c.text).join("") : ""));
    expect(texts).toContain("Second");
  });

  it("falls back to appending after the document's last block when no id is given", () => {
    const editor = makeEditor([{ type: "paragraph", content: "Only" }]);

    insertDatabaseBlock(editor, undefined);

    const doc = editor.document as AnyBlock[];
    // Same BlockNote auto-inserted trailing paragraph as above.
    expect(doc.map((b) => b.type)).toEqual(["paragraph", "database", "paragraph"]);
    expect(doc[1].props).toEqual({ databaseId: "", viewId: "" });
  });
});

describe("InlineDatabaseView", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a database on mount using noteId from context, then updates the block", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          database: { id: "db-42", title: "Untitled" },
          data_source: { id: "ds-42" },
          properties: [],
          views: [{ id: "view-42", type: "table" }],
        },
        201
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const updateBlock = vi.fn();
    const block = { id: "b1", props: { databaseId: "", viewId: "" } };

    render(
      <NoteIdContext.Provider value="note-abc">
        <InlineDatabaseView block={block} editor={{ updateBlock }} />
      </NoteIdContext.Provider>
    );

    expect(screen.getByText(/creating database/i)).toBeInTheDocument();

    await vi.waitFor(() => expect(updateBlock).toHaveBeenCalledTimes(1));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/db/databases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled", parent_note_id: "note-abc" }),
    });
    expect(updateBlock).toHaveBeenCalledWith(block, {
      props: { databaseId: "db-42", viewId: "view-42" },
    });
  });

  it("sends parent_note_id: null when there is no note in context", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          database: { id: "db-1" },
          data_source: { id: "ds-1" },
          properties: [],
          views: [],
        },
        201
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const block = { id: "b1", props: { databaseId: "", viewId: "" } };

    render(<InlineDatabaseView block={block} editor={{ updateBlock: vi.fn() }} />);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body).parent_note_id).toBeNull();
  });

  it("does not double-fire the create POST under a StrictMode double-invoke", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          database: { id: "db-99" },
          data_source: { id: "ds-99" },
          properties: [],
          views: [{ id: "view-99", type: "table" }],
        },
        201
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const updateBlock = vi.fn();
    const block = { id: "b1", props: { databaseId: "", viewId: "" } };

    render(
      <StrictMode>
        <InlineDatabaseView block={block} editor={{ updateBlock }} />
      </StrictMode>
    );

    await vi.waitFor(() => expect(updateBlock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders an inline error message (no toast) when the create POST fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "could not create" }, 500)));
    const block = { id: "b1", props: { databaseId: "", viewId: "" } };

    render(<InlineDatabaseView block={block} editor={{ updateBlock: vi.fn() }} />);

    await vi.waitFor(() => expect(screen.getByText("could not create")).toBeInTheDocument());
  });

  it("renders InlineDatabaseTable once databaseId is already populated (no create POST)", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const block = { id: "b1", props: { databaseId: "db-already", viewId: "v-already" } };

    render(<InlineDatabaseView block={block} editor={{ updateBlock: vi.fn() }} />);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/creating database/i)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// InlineDatabaseTable — mock useDatabaseView the same way DatabaseShell.test.tsx
// does (~L13-30: a shared, mutable mockHook object returned unconditionally by
// the mocked hook), and mock TableView itself so we can assert on the exact
// props InlineDatabaseTable wires into it without depending on TableView's own
// internal rendering.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tableViewSpy = vi.fn((_props: any) => <div data-testid="table-view-mock" />);
vi.mock("./views/TableView", () => ({
  TableView: (props: AnyBlock) => tableViewSpy(props),
}));

const mockHook: AnyBlock = {
  database: { id: "db-1", title: "My Inline DB", icon: "📁" },
  dataSource: { id: "ds-1", is_virtual: false },
  properties: [{ key: "title", name: "Title", type: "title", position: 0 }],
  views: [{ id: "v1", type: "table", name: "Table", config: {}, filter: null, sorts: [] }],
  activeViewId: "v1",
  setActiveViewId: vi.fn(),
  rows: [{ id: "row-1", properties: { title: { type: "title", title: "Hello" } } }],
  loading: false,
  error: null,
  updateCell: vi.fn(),
  refetch: vi.fn(),
  refetchRows: vi.fn(),
  relationLinks: {},
  ensureRelationLinks: vi.fn(),
  ensureRelationLinksBulk: vi.fn(),
  setRelationLinks: vi.fn(),
};

vi.mock("@/lib/database/useDatabaseView", () => ({
  useDatabaseView: () => mockHook,
}));

describe("InlineDatabaseTable", () => {
  beforeEach(() => {
    tableViewSpy.mockClear();
    mockHook.database = { id: "db-1", title: "My Inline DB", icon: "📁" };
    mockHook.dataSource = { id: "ds-1", is_virtual: false };
    mockHook.views = [{ id: "v1", type: "table", name: "Table", config: {}, filter: null, sorts: [] }];
    mockHook.activeViewId = "v1";
    mockHook.loading = false;
    mockHook.error = null;
    mockHook.setActiveViewId = vi.fn();
  });

  it("renders TableView with DatabaseShell's own table-case prop wiring", () => {
    render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);

    expect(tableViewSpy).toHaveBeenCalledTimes(1);
    const props = tableViewSpy.mock.calls[0][0];
    expect(props.properties).toBe(mockHook.properties);
    expect(props.rows).toBe(mockHook.rows);
    expect(props.editable).toBe(true);
    expect(props.onCellChange).toBe(mockHook.updateCell);
    expect(props.dataSourceId).toBe("ds-1");
    expect(props.refetch).toBe(mockHook.refetch);
    expect(props.refetchRows).toBe(mockHook.refetchRows);
    expect(props.relationLinks).toBe(mockHook.relationLinks);
    expect(props.ensureRelationLinks).toBe(mockHook.ensureRelationLinks);
    expect(props.ensureRelationLinksBulk).toBe(mockHook.ensureRelationLinksBulk);
    expect(props.setRelationLinks).toBe(mockHook.setRelationLinks);
  });

  it("stops mousemove/mouseup from bubbling past the scroll wrapper (BlockNote TableHandles collision)", () => {
    // Live-reproduced bug: TableView renders a real HTML <table>/<td>, and
    // BlockNote's own TableHandles extension listens for mousemove (on
    // pmView.dom) and mouseup (on window) to detect hovering/clicking one of
    // ITS OWN native table blocks' rows — it walks up from the event target
    // looking for the first <td>/<th> ancestor and, finding this table's
    // cells, crashes trying to read a "rows" shape off this "database"
    // block instead. The wrapper must stop both events before they reach
    // any ancestor, or every hover/click inside an inline table crashes the
    // whole editor.
    const { container } = render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);
    const wrapper = container.querySelector(".overscroll-contain") as HTMLElement;
    expect(wrapper).toBeTruthy();

    const moveListener = vi.fn();
    document.addEventListener("mousemove", moveListener);
    wrapper.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(moveListener).not.toHaveBeenCalled();
    document.removeEventListener("mousemove", moveListener);

    const upListener = vi.fn();
    document.addEventListener("mouseup", upListener);
    wrapper.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    expect(upListener).not.toHaveBeenCalled();
    document.removeEventListener("mouseup", upListener);
  });

  it("derives subItemDisplayMode from the active view's config, matching DatabaseShell's table case", () => {
    mockHook.views = [
      {
        id: "v1",
        type: "table",
        name: "Table",
        config: { subtasks: { display_mode: "flattened" } },
        filter: null,
        sorts: [],
      },
    ];

    render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);

    const props = tableViewSpy.mock.calls[0][0];
    expect(props.subItemDisplayMode).toBe("flattened");
  });

  it("switches to the block's viewId once it differs from and disagrees with the hook's activeViewId", () => {
    mockHook.views = [
      { id: "v1", type: "table", name: "Table", config: {}, filter: null, sorts: [] },
      { id: "v2", type: "table", name: "Table 2", config: {}, filter: null, sorts: [] },
    ];
    mockHook.activeViewId = "v1";

    render(<InlineDatabaseTable databaseId="db-1" viewId="v2" />);

    expect(mockHook.setActiveViewId).toHaveBeenCalledWith("v2");
  });

  it("does not call setActiveViewId when the block's viewId already matches", () => {
    mockHook.activeViewId = "v1";

    render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);

    expect(mockHook.setActiveViewId).not.toHaveBeenCalled();
  });

  it("renders a fallback link instead of TableView for a non-table active view", () => {
    mockHook.views = [{ id: "v1", type: "board", name: "Board", config: {}, filter: null, sorts: [] }];
    mockHook.activeViewId = "v1";

    render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);

    expect(tableViewSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/isn't supported inline yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open the full database/i })).toHaveAttribute(
      "href",
      "/brain/db/db-1"
    );
  });

  it("wraps the body in a bounded, overscroll-contained scroll region", () => {
    const { container } = render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);

    const wrapper = container.querySelector(".overscroll-contain");
    expect(wrapper).toBeTruthy();
    expect(wrapper?.className).toMatch(/max-h-\d+/);
    expect(wrapper?.className).toMatch(/overflow-auto/);
  });

  it("shows Loading… while the hook has no database yet", () => {
    mockHook.database = null;
    mockHook.dataSource = null;
    mockHook.loading = true;

    render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    expect(tableViewSpy).not.toHaveBeenCalled();
  });

  it("shows an inline error when the hook errored before ever loading a database", () => {
    mockHook.database = null;
    mockHook.dataSource = null;
    mockHook.loading = false;
    mockHook.error = "could not load database";

    render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);

    expect(screen.getByText("could not load database")).toBeInTheDocument();
  });

  it("links the header title to the full database page", () => {
    render(<InlineDatabaseTable databaseId="db-1" viewId="v1" />);

    expect(screen.getByRole("link", { name: "My Inline DB" })).toHaveAttribute(
      "href",
      "/brain/db/db-1"
    );
  });
});
