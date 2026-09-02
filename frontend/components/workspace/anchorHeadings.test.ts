import { describe, it, expect } from "vitest";
import { findLevelHeadings } from "./anchorHeadings";

describe("findLevelHeadings", () => {
  it("returns top-level heading blocks at the given level, in order", () => {
    const blocks = [
      { id: "a", type: "heading", props: { level: 2 } },
      { id: "b", type: "heading", props: { level: 3 } },
      { id: "c", type: "paragraph", props: {} },
      { id: "d", type: "heading", props: { level: 3 } },
    ] as any;
    expect(findLevelHeadings(blocks, 3).map((b: any) => b.id)).toEqual(["b", "d"]);
  });

  it("defaults missing level to 1 and excludes it from a level-3 search", () => {
    const blocks = [{ id: "a", type: "heading", props: {} }] as any;
    expect(findLevelHeadings(blocks, 3)).toEqual([]);
  });
});
