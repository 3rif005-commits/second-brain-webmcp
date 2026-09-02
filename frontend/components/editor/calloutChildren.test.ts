// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { extractCalloutChildren, attachCalloutChildren } from "./calloutChildren";
// @ts-ignore — @blocknote/core@0.48.0 ships an empty index.d.ts (upstream bug); runtime exports are fine
import { BlockNoteSchema, defaultBlockSpecs, BlockNoteEditor } from "@blocknote/core";
import { CalloutBlockSpec, MathBlockSpec } from "./customBlocks";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeEditor(): any {
  const schema = BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      callout: CalloutBlockSpec(),
      math: MathBlockSpec(),
    },
  });
  const editor = BlockNoteEditor.create({ schema });
  // tryParseHTMLToBlocks needs the editor mounted — mirrors customBlocks.test.tsx's makeEditor
  editor.mount(document.createElement("div"));
  return editor;
}

describe("extractCalloutChildren", () => {
  it("pulls each callout div's inner HTML out and strips it from the document", async () => {
    const html =
      '<h2>Title</h2>' +
      '<div data-type="callout" data-callout-type="TIP"><p>insight</p></div>' +
      '<p>after</p>';
    const parseHTML = async (h: string) => [{ type: "paragraph", innerHtml: h } as any];

    const { strippedHtml, calloutChildren } = await extractCalloutChildren(html, parseHTML);

    expect(strippedHtml).toContain('data-callout-type="TIP"');
    expect(strippedHtml).not.toContain("<p>insight</p>");
    expect(strippedHtml).toContain("<p>after</p>");
    expect(calloutChildren).toHaveLength(1);
    expect((calloutChildren[0][0] as any).innerHtml).toBe("<p>insight</p>");
  });

  it("returns no callout children when there are no callout divs", async () => {
    const parseHTML = async () => [];
    const { strippedHtml, calloutChildren } = await extractCalloutChildren("<p>plain</p>", parseHTML);
    expect(strippedHtml).toBe("<p>plain</p>");
    expect(calloutChildren).toHaveLength(0);
  });

  it("skips a callout div nested inside a table cell, without desyncing a later sibling callout", async () => {
    const html =
      '<div data-type="callout" data-callout-type="TIP"><p>legit-1</p></div>' +
      '<table><tr><td><div data-type="callout" data-callout-type="NOTE"><p>in-table-cell</p></div></td></tr></table>' +
      '<div data-type="callout" data-callout-type="WARNING"><p>legit-2</p></div>';
    const parseHTML = async (h: string) => [{ type: "paragraph", innerHtml: h } as any];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { strippedHtml, calloutChildren } = await extractCalloutChildren(html, parseHTML);

    // Only the two top-level callouts were extracted — the table-nested one was skipped.
    expect(calloutChildren).toHaveLength(2);
    expect((calloutChildren[0][0] as any).innerHtml).toBe("<p>legit-1</p>");
    expect((calloutChildren[1][0] as any).innerHtml).toBe("<p>legit-2</p>");
    // The nested one's markup is left untouched, still inside the table cell.
    expect(strippedHtml).toContain("<p>in-table-cell</p>");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("skips a callout div nested inside another callout, without desyncing a later sibling callout", async () => {
    const html =
      '<div data-type="callout" data-callout-type="TIP">' +
      '<p>outer-legit</p>' +
      '<div data-type="callout" data-callout-type="NOTE"><p>inner-nested</p></div>' +
      '</div>' +
      '<div data-type="callout" data-callout-type="WARNING"><p>next-legit</p></div>';
    const parseHTML = async (h: string) => [{ type: "paragraph", innerHtml: h } as any];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { calloutChildren } = await extractCalloutChildren(html, parseHTML);

    // Only the outer callout and the following sibling were extracted.
    expect(calloutChildren).toHaveLength(2);
    // The outer callout's extracted content still contains the untouched nested callout markup.
    expect((calloutChildren[0][0] as any).innerHtml).toContain("outer-legit");
    expect((calloutChildren[0][0] as any).innerHtml).toContain("inner-nested");
    // The later sibling callout's content is correctly attributed, not shifted.
    expect((calloutChildren[1][0] as any).innerHtml).toBe("<p>next-legit</p>");
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});

describe("attachCalloutChildren", () => {
  it("assigns extracted children to callout blocks in document order, including nested ones", () => {
    const blocks = [
      { id: "a", type: "callout", children: [] },
      {
        id: "b",
        type: "heading",
        children: [
          { id: "c", type: "callout", children: [] },
        ],
      },
    ] as any;
    const calloutChildren = [
      [{ id: "child1", type: "paragraph" }],
      [{ id: "child2", type: "paragraph" }],
    ] as any;

    const result = attachCalloutChildren(blocks, calloutChildren);

    expect(result[0].children).toEqual(calloutChildren[0]);
    expect(result[1].children![0].children).toEqual(calloutChildren[1]);
  });

  it("leaves non-callout blocks' children untouched", () => {
    const blocks = [{ id: "a", type: "paragraph", children: [] }] as any;
    const result = attachCalloutChildren(blocks, []);
    expect(result[0].children).toEqual([]);
  });
});

// Covers Critical #1: BlockEditor's `ingestHtml` effect (PDF/URL ingest, and
// workspace multi-source synthesis's "replace" mode) runs HTML straight through
// this exact extract-then-parse-then-attach sequence before it ever reaches
// BlockNote. Without it, `editor.tryParseHTMLToBlocks` alone can't reconstruct
// a callout's children — the callout div's inner HTML is a plain sibling in
// BlockNote's DOM output, not something the parser attaches as block children —
// so every ingested callout would land as an empty shell.
describe("extractCalloutChildren + attachCalloutChildren (ingestHtml pipeline)", () => {
  it("preserves a callout's math block and list children when run through the real BlockNote HTML parser", async () => {
    const editor = makeEditor();
    const html =
      '<h2>Chapter</h2>' +
      '<div data-type="callout" data-callout-type="FORMULA"><p>Ohm law</p><div data-type="math">V = IR</div><ul><li>V volts</li></ul></div>' +
      '<p>after</p>';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { strippedHtml, calloutChildren } = await extractCalloutChildren(html, async (h: string) =>
      (await editor.tryParseHTMLToBlocks(h)) as any
    );
    const rawBlocks = await editor.tryParseHTMLToBlocks(strippedHtml);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks = attachCalloutChildren(rawBlocks as any[], calloutChildren) as any[];

    const calloutBlock = blocks.find((b) => b.type === "callout");
    expect(calloutBlock).toBeDefined();
    expect(calloutBlock.props.calloutType).toBe("FORMULA");
    // Not an empty shell: both the math block and the list item survived.
    expect(calloutBlock.children.length).toBeGreaterThan(0);
    expect(calloutBlock.children.some((c: any) => c.type === "math" && c.props.latex === "V = IR")).toBe(true);
    expect(calloutBlock.children.some((c: any) => c.type === "bulletListItem")).toBe(true);

    // The rest of the document parsed normally around the callout.
    expect(blocks.some((b) => b.type === "heading")).toBe(true);
    expect(blocks.some((b) => b.type === "paragraph")).toBe(true);
    expect(strippedHtml).toContain("<p>after</p>");
  });
});
