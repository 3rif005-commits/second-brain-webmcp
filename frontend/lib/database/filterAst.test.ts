import { describe, expect, it } from "vitest";
import {
  appendChild,
  asFilterNode,
  countConditions,
  defaultConditionFor,
  isFilterableProperty,
  removeAtPath,
  sanitizeFilterForQuery,
  updateAtPath,
  type FilterCondition,
  type FilterGroup,
} from "./filterAst";
import type { PropertyResponse } from "./types";

function prop(overrides: Partial<PropertyResponse>): PropertyResponse {
  return {
    id: overrides.key ?? "id",
    data_source_id: "ds-1",
    user_id: "u1",
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

const cond = (property: string, operator = "contains"): FilterCondition => ({
  type: "condition",
  property,
  operator,
});

describe("asFilterNode", () => {
  it("returns null for null/undefined/malformed input", () => {
    expect(asFilterNode(null)).toBeNull();
    expect(asFilterNode(undefined)).toBeNull();
    expect(asFilterNode({})).toBeNull();
    expect(asFilterNode({ type: "condition" })).toBeNull();
    expect(asFilterNode({ type: "group", op: "and" })).toBeNull();
  });

  it("accepts a well-formed condition or group", () => {
    expect(asFilterNode({ type: "condition", property: "name", operator: "contains" })).toEqual(
      cond("name")
    );
    const group: FilterGroup = { type: "group", op: "or", children: [cond("a"), cond("b")] };
    expect(asFilterNode(group as unknown as Record<string, unknown>)).toEqual(group);
  });
});

describe("countConditions", () => {
  it("is 0 for null, 1 for a bare condition", () => {
    expect(countConditions(null)).toBe(0);
    expect(countConditions(cond("a"))).toBe(1);
  });

  it("counts leaves across nested groups, not top-level children", () => {
    const tree: FilterGroup = {
      type: "group",
      op: "and",
      children: [cond("a"), { type: "group", op: "or", children: [cond("b"), cond("c")] }],
    };
    expect(countConditions(tree)).toBe(3);
  });
});

describe("updateAtPath / removeAtPath / appendChild", () => {
  const tree: FilterGroup = {
    type: "group",
    op: "and",
    children: [cond("a"), cond("b")],
  };

  it("updateAtPath replaces the node at an empty path (the root)", () => {
    const next = updateAtPath(tree, [], (node) => ({ ...(node as FilterGroup), op: "or" }));
    expect((next as FilterGroup).op).toBe("or");
    expect(tree.op).toBe("and"); // original untouched
  });

  it("updateAtPath replaces a child by index, leaving siblings untouched", () => {
    const next = updateAtPath(tree, [1], (node) => ({ ...(node as FilterCondition), operator: "equals" }));
    expect((next as FilterGroup).children[1]).toEqual(cond("b", "equals"));
    expect((next as FilterGroup).children[0]).toEqual(cond("a"));
  });

  it("removeAtPath drops one child, keeping the group", () => {
    const next = removeAtPath(tree, [0]);
    expect(next).toEqual({ type: "group", op: "and", children: [cond("b")] });
  });

  it("removeAtPath prunes a nested group once its last child is removed", () => {
    const nested: FilterGroup = {
      type: "group",
      op: "and",
      children: [cond("a"), { type: "group", op: "or", children: [cond("b")] }],
    };
    const next = removeAtPath(nested, [1, 0]);
    expect(next).toEqual({ type: "group", op: "and", children: [cond("a")] });
  });

  it("removeAtPath on the root's own path (empty) returns null", () => {
    expect(removeAtPath(tree, [])).toBeNull();
  });

  it("appendChild adds a new child to the group at path", () => {
    const next = appendChild(tree, [], cond("c"));
    expect((next as FilterGroup).children).toHaveLength(3);
    expect((next as FilterGroup).children[2]).toEqual(cond("c"));
  });
});

describe("defaultConditionFor / isFilterableProperty", () => {
  // filter-panel.md's own capture: a freshly-picked Text/Title property defaults to
  // "Contains", not the first entry in TEXT_OPS ("equals"/"Is") — live-verified
  // reachable and wrong before this fix (picking Title and typing a substring matched
  // zero rows instead of narrowing).
  it("text-shaped types default to Contains, not the first operator in their list", () => {
    expect(defaultConditionFor(prop({ key: "title", type: "title" }))).toEqual({
      type: "condition",
      property: "title",
      operator: "contains",
    });
    expect(defaultConditionFor(prop({ key: "notes", type: "rich_text" }))).toEqual({
      type: "condition",
      property: "notes",
      operator: "contains",
    });
  });

  it("every other type's default is still its operator list's first entry (spec's own TBD)", () => {
    expect(defaultConditionFor(prop({ key: "kind", type: "select" }))).toEqual({
      type: "condition",
      property: "kind",
      operator: "equals",
    });
  });

  // Live-verified reachable and silently wrong: a Checkbox condition's value
  // editor is a <select> that shows "Unchecked" selected the instant it
  // exists (ValueEditor's own `value === true` fallback) — but a <select>
  // only fires onChange on an actual change, so without an explicit default
  // value here the condition looked complete yet never carried one, and
  // `sanitizeFilterForQuery` correctly (but silently) dropped it from every
  // query. Reproduced in an `Or` group: the checkbox rule's contribution
  // vanished entirely, narrowing the result to only the other rule's match.
  it("a Checkbox condition carries an explicit `value: false` from creation, not undefined", () => {
    expect(defaultConditionFor(prop({ key: "done", type: "checkbox" }))).toEqual({
      type: "condition",
      property: "done",
      operator: "equals",
      value: false,
    });
  });

  it("a Verification condition carries an explicit `value: \"none\"` from creation, same reason", () => {
    expect(defaultConditionFor(prop({ key: "check", type: "verification" }))).toEqual({
      type: "condition",
      property: "check",
      operator: "status",
      value: "none",
    });
  });

  it("place/button/formula/rollup are not filterable", () => {
    expect(isFilterableProperty(prop({ type: "place" }))).toBe(false);
    expect(isFilterableProperty(prop({ type: "button" }))).toBe(false);
    expect(isFilterableProperty(prop({ type: "formula" }))).toBe(false);
    expect(isFilterableProperty(prop({ type: "rollup" }))).toBe(false);
  });

  it("every other captured type is filterable", () => {
    for (const type of ["title", "rich_text", "number", "select", "multi_select", "status", "date", "checkbox", "url", "files"]) {
      expect(isFilterableProperty(prop({ type }))).toBe(true);
    }
  });
});

// Review checkpoint (Phase 0c/M4/M5/M6): the compiler 400s on a FilterGroup
// with zero children (ast.py's `Field(min_length=1)`) and on a condition
// whose operator needs a value it doesn't have (operators.py's
// `coerce_value`) — both are ordinary mid-edit states this app persists to
// `view.filter` directly (no separate draft), so `loadRows` was silently
// breaking every time "+ Add advanced filter" ran, or a property was picked
// but its value not yet typed. `sanitizeFilterForQuery` is what
// `useDatabaseView.loadRows` now runs the filter through before it ever
// reaches `POST .../query`.
describe("sanitizeFilterForQuery", () => {
  const properties = [prop({ key: "kind", type: "select" }), prop({ key: "count", type: "number" })];

  it("null stays null", () => {
    expect(sanitizeFilterForQuery(null, properties)).toBeNull();
  });

  it("drops a freshly-picked condition with no value yet", () => {
    const node: FilterCondition = { type: "condition", property: "kind", operator: "equals" };
    expect(sanitizeFilterForQuery(node, properties)).toBeNull();
  });

  it("keeps a none-arg-type condition (is_empty) with no value", () => {
    const node: FilterCondition = { type: "condition", property: "kind", operator: "is_empty" };
    expect(sanitizeFilterForQuery(node, properties)).toEqual(node);
  });

  it("keeps a condition once it has a real value", () => {
    const node: FilterCondition = { type: "condition", property: "count", operator: "equals", value: 3 };
    expect(sanitizeFilterForQuery(node, properties)).toEqual(node);
  });

  it("drops an empty str_or_list array value, same as no value", () => {
    const node: FilterCondition = { type: "condition", property: "kind", operator: "equals", value: [] };
    expect(sanitizeFilterForQuery(node, properties)).toBeNull();
  });

  it("an empty group (\"+ Add advanced filter\", not yet given a rule) sanitizes to null", () => {
    const node: FilterGroup = { type: "group", op: "and", children: [] };
    expect(sanitizeFilterForQuery(node, properties)).toBeNull();
  });

  it("a group with only incomplete children sanitizes to null, not an empty-children group", () => {
    const node: FilterGroup = {
      type: "group",
      op: "and",
      children: [{ type: "condition", property: "kind", operator: "equals" }],
    };
    expect(sanitizeFilterForQuery(node, properties)).toBeNull();
  });

  it("a group keeps only its complete children", () => {
    const complete: FilterCondition = { type: "condition", property: "count", operator: "equals", value: 3 };
    const incomplete: FilterCondition = { type: "condition", property: "kind", operator: "equals" };
    const node: FilterGroup = { type: "group", op: "and", children: [complete, incomplete] };
    expect(sanitizeFilterForQuery(node, properties)).toEqual({ type: "group", op: "and", children: [complete] });
  });
});
