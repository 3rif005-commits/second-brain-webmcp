// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
// @ts-ignore — @blocknote/core@0.48.0 ships an empty index.d.ts (upstream bug); runtime exports are fine
import { BlockNoteSchema, defaultBlockSpecs, BlockNoteEditor } from "@blocknote/core";
import { CalloutBlockSpec, CALLOUT_PALETTE, MathBlockSpec } from "./customBlocks";

function makeEditor() {
  const schema = BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      callout: CalloutBlockSpec(),
      math: MathBlockSpec(),
    },
  });
  const editor = BlockNoteEditor.create({ schema });
  // tryParseHTMLToBlocks needs the editor mounted — mirrors the pattern in
  // @blocknote/xl-multi-column's own test suite (node_modules/@blocknote/xl-multi-column/src/test/conversions/htmlConversion.test.ts)
  editor.mount(document.createElement("div"));
  return editor;
}

describe("CALLOUT_PALETTE", () => {
  it("has exactly the 9 defined callout types, one color each, no repeats", () => {
    const types = Object.keys(CALLOUT_PALETTE);
    expect(types.sort()).toEqual(
      ["ANALOGY", "CAUTION", "EXAM", "FORMULA", "IMPORTANT", "NOTE", "OVERVIEW", "TIP", "WARNING"].sort()
    );
    const colors = types.map((t) => CALLOUT_PALETTE[t as keyof typeof CALLOUT_PALETTE].color);
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("only uses colors from BlockNote's actual default (non-'default') palette", () => {
    // BlockNote's built-in color palette, minus "default" (reserved for
    // "no special color" elsewhere in the editor, not used by callouts).
    // Guards against a future edit introducing an invented color that
    // happens to be unique but doesn't actually exist in BlockNote's theme.
    const BLOCKNOTE_NON_DEFAULT_COLORS = [
      "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink",
    ];
    const colors = Object.values(CALLOUT_PALETTE).map((v) => v.color);
    colors.forEach((color) => {
      expect(BLOCKNOTE_NON_DEFAULT_COLORS).toContain(color);
    });
  });
});

describe("callout HTML parsing", () => {
  it("parses a div[data-type=callout] into a callout block with the right calloutType", async () => {
    const editor = makeEditor();
    const blocks = await editor.tryParseHTMLToBlocks(
      '<div data-type="callout" data-callout-type="TIP"></div>'
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("callout");
    expect((blocks[0].props as any).calloutType).toBe("TIP");
  });

  it("falls back to NOTE for an unrecognized calloutType", async () => {
    const editor = makeEditor();
    const blocks = await editor.tryParseHTMLToBlocks(
      '<div data-type="callout" data-callout-type="NOT_A_TYPE"></div>'
    );
    expect((blocks[0].props as any).calloutType).toBe("NOTE");
  });

  it("does not match unrelated divs", async () => {
    const editor = makeEditor();
    const blocks = await editor.tryParseHTMLToBlocks('<div class="foo">hi</div>');
    expect(blocks.some((b: any) => b.type === "callout")).toBe(false);
  });
});

describe("math HTML parsing", () => {
  it("parses a div[data-type=math] into a math block using its text content as latex", async () => {
    const editor = makeEditor();
    const blocks = await editor.tryParseHTMLToBlocks(
      '<div data-type="math">E = mc^2</div>'
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("math");
    expect((blocks[0].props as any).latex).toBe("E = mc^2");
  });
});
