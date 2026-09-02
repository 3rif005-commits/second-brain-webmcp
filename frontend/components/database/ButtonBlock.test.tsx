// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
// @ts-ignore — @blocknote/core@0.48.0 ships an empty index.d.ts (upstream bug); runtime exports are fine
import { BlockNoteSchema, defaultBlockSpecs, BlockNoteEditor } from "@blocknote/core";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import {
  ButtonBlockSpec,
  insertButtonBlock,
  insertBlocksForButtonClick,
  ButtonBlockView,
} from "./ButtonBlock";
import { NoteIdContext } from "../editor/noteIdContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Mirrors DatabaseBlock.test.tsx's own makeEditor() convention.
function makeEditor(initialContent?: AnyBlock[]) {
  const schema = BlockNoteSchema.create({
    blockSpecs: { ...defaultBlockSpecs, button: ButtonBlockSpec() },
  });
  const editor = BlockNoteEditor.create({ schema, initialContent });
  editor.mount(document.createElement("div"));
  return editor;
}

describe("ButtonBlockSpec schema build", () => {
  it("builds a working editor when the block spec factory is invoked", () => {
    expect(() => makeEditor()).not.toThrow();
  });

  it("crashes with the literal 'reading node' error when registered uninvoked", () => {
    // createReactBlockSpec returns a FACTORY, not a BlockSpec — registering
    // it uninvoked (the plan's own literal test case, and M11's task-36
    // report's own already-hit bug) crashes schema creation with this exact
    // message.
    expect(() => {
      const schema = BlockNoteSchema.create({
        blockSpecs: { ...defaultBlockSpecs, button: ButtonBlockSpec as unknown as AnyBlock },
      });
      const editor = BlockNoteEditor.create({ schema });
      editor.mount(document.createElement("div"));
    }).toThrow(/Cannot read properties of undefined \(reading 'node'\)/);
  });
});

describe("button block round-trips through a save/load cycle", () => {
  it("keeps label/icon/actionsJson props byte-identical across JSON.parse(JSON.stringify(...))", () => {
    const editor1 = makeEditor();
    const actionsJson = JSON.stringify([{ type: "open_page_or_url", target: { kind: "url", url: "https://x" } }]);
    editor1.replaceBlocks(editor1.document, [{ type: "button", props: { label: "Click me", icon: "🚀", actionsJson } }]);
    const original = (editor1.document as AnyBlock[]).find((b) => b.type === "button");
    expect(original).toBeTruthy();
    expect(original.props).toEqual({ label: "Click me", icon: "🚀", actionsJson });

    const reloaded = JSON.parse(JSON.stringify(editor1.document));
    const editor2 = makeEditor(reloaded);
    const roundTripped = (editor2.document as AnyBlock[]).find((b) => b.type === "button");

    expect(roundTripped).toBeTruthy();
    expect(roundTripped.props).toEqual(original.props);
  });
});

describe("insertButtonBlock", () => {
  it("inserts a button-typed block immediately after the given block id", () => {
    const editor = makeEditor([
      { type: "paragraph", content: "First" },
      { type: "paragraph", content: "Second" },
    ]);
    const [first] = editor.document as AnyBlock[];

    insertButtonBlock(editor, first.id);

    const doc = editor.document as AnyBlock[];
    // BlockNote auto-inserts an empty paragraph directly after a
    // content:"none" block wherever it lands (live-verified — same
    // behavior DatabaseBlock.test.tsx already documents for its own
    // content:"none" database block; not this task's own behavior to
    // control), so a `button` block inserted between two paragraphs pushes
    // the doc to 4 blocks, not 3. The load-bearing assertions are the
    // position (right after `first`, right before the original "Second")
    // and the fresh block's props.
    expect(doc.map((b) => b.type)).toEqual(["paragraph", "button", "paragraph", "paragraph"]);
    expect(doc[1].props).toEqual({ label: "Button", icon: "⚡", actionsJson: "[]" });
    const texts = doc
      .slice(2)
      .map((b) => (Array.isArray(b.content) ? b.content.map((c: AnyBlock) => c.text).join("") : ""));
    expect(texts).toContain("Second");
  });

  it("falls back to appending after the document's last block when no id is given", () => {
    const editor = makeEditor([{ type: "paragraph", content: "Only" }]);

    insertButtonBlock(editor, undefined);

    const doc = editor.document as AnyBlock[];
    // Same BlockNote auto-inserted trailing paragraph as above.
    expect(doc.map((b) => b.type)).toEqual(["paragraph", "button", "paragraph"]);
    expect(doc[1].props).toEqual({ label: "Button", icon: "⚡", actionsJson: "[]" });
  });
});

describe("insertBlocksForButtonClick", () => {
  it("inserts above_button immediately before the button block", () => {
    const editor = makeEditor([{ type: "paragraph", content: "A" }]);
    insertButtonBlock(editor, (editor.document as AnyBlock[])[0].id);
    const buttonBlock = (editor.document as AnyBlock[]).find((b) => b.type === "button");

    insertBlocksForButtonClick(editor, buttonBlock, [{ type: "paragraph", content: "Inserted" }], "above_button");

    const doc = editor.document as AnyBlock[];
    const idx = doc.findIndex((b) => b.type === "button");
    expect(doc[idx - 1].content?.[0]?.text).toBe("Inserted");
  });

  it("inserts below_button immediately after the button block", () => {
    const editor = makeEditor([{ type: "paragraph", content: "A" }]);
    insertButtonBlock(editor, (editor.document as AnyBlock[])[0].id);
    const buttonBlock = (editor.document as AnyBlock[]).find((b) => b.type === "button");

    insertBlocksForButtonClick(editor, buttonBlock, [{ type: "paragraph", content: "Inserted" }], "below_button");

    const doc = editor.document as AnyBlock[];
    const idx = doc.findIndex((b) => b.type === "button");
    expect(doc[idx + 1].content?.[0]?.text).toBe("Inserted");
  });

  it("inserts top_of_page before the document's first block", () => {
    const editor = makeEditor([
      { type: "paragraph", content: "A" },
      { type: "paragraph", content: "B" },
    ]);
    const buttonBlock = { id: "unused", type: "button" };

    insertBlocksForButtonClick(editor, buttonBlock, [{ type: "paragraph", content: "Top" }], "top_of_page");

    const doc = editor.document as AnyBlock[];
    expect(doc[0].content?.[0]?.text).toBe("Top");
  });

  it("inserts bottom_of_page after the document's last block", () => {
    const editor = makeEditor([{ type: "paragraph", content: "A" }]);
    const buttonBlock = { id: "unused", type: "button" };

    insertBlocksForButtonClick(editor, buttonBlock, [{ type: "paragraph", content: "Bottom" }], "bottom_of_page");

    // BlockNote may auto-append a further trailing empty paragraph once the
    // inserted block becomes the doc's new last block (live-verified, same
    // "doc always ends with an editable paragraph" convention as the
    // content:"none" auto-insert above) — assert "Bottom" landed somewhere
    // in the doc rather than assuming it's the literal last element,
    // mirroring DatabaseBlock.test.tsx's own "assert the text exists"
    // robustness for this exact class of BlockNote behavior.
    const doc = editor.document as AnyBlock[];
    const texts = doc.map((b) => (Array.isArray(b.content) ? b.content.map((c: AnyBlock) => c.text).join("") : ""));
    expect(texts).toContain("Bottom");
  });

  it("is a no-op for an empty blocks array", () => {
    const editor = makeEditor([{ type: "paragraph", content: "A" }]);
    const before = (editor.document as AnyBlock[]).length;
    const buttonBlock = { id: "unused", type: "button" };

    insertBlocksForButtonClick(editor, buttonBlock, [], "bottom_of_page");

    expect((editor.document as AnyBlock[]).length).toBe(before);
  });
});

describe("ButtonBlockView click flow", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    push.mockClear();
    showToast.mockClear();
  });

  const block = {
    id: "b1",
    props: { label: "Click me", icon: "🚀", actionsJson: JSON.stringify([{ type: "send_webhook", url: "https://x" }]) },
  };

  it("POSTs /buttons/block-click with note_id from context, the block's actions, and confirmed: false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ actions_run: 1, requires_confirmation: false, confirmation_message: null, client_actions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const editor = { updateBlock: vi.fn(), insertBlocks: vi.fn(), replaceBlocks: vi.fn(), document: [block] };

    render(
      <NoteIdContext.Provider value="note-77">
        <ButtonBlockView block={block} editor={editor} />
      </NoteIdContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: /click me/i }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/db/buttons/block-click");
    expect(JSON.parse(init.body)).toEqual({
      note_id: "note-77",
      actions: [{ type: "send_webhook", url: "https://x" }],
      confirmed: false,
    });
  });

  it("shows a ConfirmDialog on requires_confirmation and re-POSTs with confirmed: true on confirm", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ actions_run: 0, requires_confirmation: true, confirmation_message: "Really?", client_actions: [] })
      )
      .mockResolvedValueOnce(
        jsonResponse({ actions_run: 1, requires_confirmation: false, confirmation_message: null, client_actions: [] })
      );
    vi.stubGlobal("fetch", fetchMock);
    const editor = { updateBlock: vi.fn(), insertBlocks: vi.fn(), document: [block] };

    render(
      <NoteIdContext.Provider value="note-77">
        <ButtonBlockView block={block} editor={editor} />
      </NoteIdContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: /click me/i }));

    await vi.waitFor(() => expect(screen.getByText("Really?")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondInit = fetchMock.mock.calls[1][1];
    expect(JSON.parse(secondInit.body).confirmed).toBe(true);
  });

  it("calls editor.insertBlocks with the right blocks/position for an insert_blocks client action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        actions_run: 1,
        requires_confirmation: false,
        confirmation_message: null,
        client_actions: [
          { type: "insert_blocks", blocks: [{ type: "paragraph", content: "Hi" }], placement: "below_button" },
        ],
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const insertBlocks = vi.fn();
    const editor = { updateBlock: vi.fn(), insertBlocks, document: [block] };

    render(
      <NoteIdContext.Provider value="note-77">
        <ButtonBlockView block={block} editor={editor} />
      </NoteIdContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: /click me/i }));

    await vi.waitFor(() =>
      expect(insertBlocks).toHaveBeenCalledWith([{ type: "paragraph", content: "Hi" }], "b1", "after")
    );
  });

  it("toasts on a failed click, never throws to a native dialog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "boom" }, 400));
    vi.stubGlobal("fetch", fetchMock);
    const editor = { updateBlock: vi.fn(), document: [block] };

    render(
      <NoteIdContext.Provider value="note-77">
        <ButtonBlockView block={block} editor={editor} />
      </NoteIdContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: /click me/i }));

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("boom", "error"));
  });

  it("shows the pencil edit affordance and toggles an edit panel with the action-chain editor", () => {
    const editor = { updateBlock: vi.fn(), document: [block] };

    render(
      <NoteIdContext.Provider value="note-77">
        <ButtonBlockView block={block} editor={editor} />
      </NoteIdContext.Provider>
    );
    fireEvent.click(screen.getByRole("button", { name: /edit button/i }));

    expect(screen.getByLabelText(/button label/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/action 1 type/i)).toBeInTheDocument();
  });
});
