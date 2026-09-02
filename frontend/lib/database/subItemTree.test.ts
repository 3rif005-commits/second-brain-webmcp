import { describe, expect, it } from "vitest";
import { buildSubItemTree, MAX_SUBITEM_DEPTH } from "./subItemTree";
import type { DatabaseRow } from "./types";

function row(id: string, title: string): DatabaseRow {
  return { id, properties: { title: { type: "title", title } } };
}

describe("buildSubItemTree", () => {
  it("puts a row with no parent at depth 0, no children", () => {
    const rows = [row("a", "A")];
    const tree = buildSubItemTree(rows, () => []);
    expect(tree).toEqual([{ row: rows[0], depth: 0, hasChildren: false }]);
  });

  it("nests a child under its parent at depth+1, in order", () => {
    const rows = [row("parent", "Parent"), row("child", "Child")];
    const childIdsOf = (id: string) => (id === "parent" ? ["child"] : []);
    const tree = buildSubItemTree(rows, childIdsOf);
    expect(tree.map((e) => [e.row.id, e.depth, e.hasChildren])).toEqual([
      ["parent", 0, true],
      ["child", 1, false],
    ]);
  });

  it("a row that's someone's child is never also listed as a root", () => {
    const rows = [row("parent", "Parent"), row("child", "Child")];
    const childIdsOf = (id: string) => (id === "parent" ? ["child"] : []);
    const tree = buildSubItemTree(rows, childIdsOf);
    expect(tree.filter((e) => e.row.id === "child")).toHaveLength(1);
  });

  it("collapsing a parent hides its descendants but keeps its own entry", () => {
    const rows = [row("parent", "Parent"), row("child", "Child")];
    const childIdsOf = (id: string) => (id === "parent" ? ["child"] : []);
    const tree = buildSubItemTree(rows, childIdsOf, new Set(["parent"]));
    expect(tree.map((e) => e.row.id)).toEqual(["parent"]);
    expect(tree[0].hasChildren).toBe(true);
  });

  it("drops a child id that doesn't resolve to a fetched row, rather than rendering a dangling node", () => {
    const rows = [row("parent", "Parent")];
    const childIdsOf = (id: string) => (id === "parent" ? ["missing-child"] : []);
    const tree = buildSubItemTree(rows, childIdsOf);
    expect(tree).toEqual([{ row: rows[0], depth: 0, hasChildren: false }]);
  });

  it("treats a still-loading row (childIdsOf returns undefined) as having no children yet", () => {
    const rows = [row("a", "A")];
    const tree = buildSubItemTree(rows, () => undefined);
    expect(tree).toEqual([{ row: rows[0], depth: 0, hasChildren: false }]);
  });

  it("guards against a cycle rather than looping forever, even though the backend should prevent one", () => {
    const rows = [row("a", "A"), row("b", "B")];
    // a -> b -> a: not something the real API can produce (RelationCycleError),
    // but this function must not rely on that for its own correctness.
    const childIdsOf = (id: string) => (id === "a" ? ["b"] : id === "b" ? ["a"] : []);
    const tree = buildSubItemTree(rows, childIdsOf);
    // Both "a" and "b" list each other as a child, so neither is a root by
    // this function's "not anyone's child" rule -- nothing renders, but it
    // terminates rather than recursing forever.
    expect(tree).toEqual([]);
  });

  it("guards against runaway depth past MAX_SUBITEM_DEPTH, even for a long non-cyclic chain", () => {
    const chainLength = MAX_SUBITEM_DEPTH + 5;
    const rows: DatabaseRow[] = Array.from({ length: chainLength }, (_, i) => row(`r${i}`, `R${i}`));
    const childIdsOf = (id: string) => {
      const i = Number(id.slice(1));
      return i + 1 < chainLength ? [`r${i + 1}`] : [];
    };
    const tree = buildSubItemTree(rows, childIdsOf);
    const depths = tree.map((e) => e.depth);
    expect(Math.max(...depths)).toBeLessThanOrEqual(MAX_SUBITEM_DEPTH);
    expect(tree.length).toBeLessThan(chainLength);
  });
});
