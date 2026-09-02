import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MenuList } from "@/components/ui/primitives";
import { groupDisplayLabel, groupPanel, orderedGroups, reorderGroups } from "./GroupBuilder";
import type { Group, GroupBySpec, PropertyResponse } from "@/lib/database/types";

function prop(overrides: Partial<PropertyResponse>): PropertyResponse {
  return {
    id: overrides.key ?? "id",
    data_source_id: "ds-1",
    user_id: "u1",
    key: "key",
    name: "Name",
    type: "select",
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
  prop({ key: "title", name: "Name", type: "title", position: 0 }),
  prop({ key: "kind", name: "Kind", type: "select", position: 1 }),
  prop({ key: "attachments", name: "Attachments", type: "files", position: 2 }),
];

function group(key: string, label = key): Group {
  return { key, label, row_count: 1, rows: [], subgroups: null };
}

describe("groupDisplayLabel", () => {
  it("renders 'No <PropertyName>' for the implicit empty bucket", () => {
    expect(groupDisplayLabel(group("__no_value__", "No value"), prop({ name: "Kind" }))).toBe("No Kind");
  });

  it("falls back to 'No value' when the property is unknown", () => {
    expect(groupDisplayLabel(group("__no_value__", "No value"), undefined)).toBe("No value");
  });

  it("uses the group's own label for a real value", () => {
    expect(groupDisplayLabel(group("article", "article"), prop({ name: "Kind" }))).toBe("article");
  });
});

describe("reorderGroups (pure drag-drop logic, no dnd-kit simulation needed)", () => {
  it("moves the active key to the over key's position", () => {
    expect(reorderGroups(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns null when nothing moved or a key is unknown", () => {
    expect(reorderGroups(["a", "b"], "a", "a")).toBeNull();
    expect(reorderGroups(["a", "b"], "a", "ghost")).toBeNull();
  });
});

describe("orderedGroups", () => {
  const groups = [group("b", "Bravo"), group("a", "Alpha"), group("c", "Charlie")];

  it("alphabetical sorts by label ascending", () => {
    const spec: GroupBySpec = { property_key: "kind", group_order: "alphabetical" };
    expect(orderedGroups(groups, spec).map((g) => g.key)).toEqual(["a", "b", "c"]);
  });

  it("reverse_alphabetical sorts by label descending", () => {
    const spec: GroupBySpec = { property_key: "kind", group_order: "reverse_alphabetical" };
    expect(orderedGroups(groups, spec).map((g) => g.key)).toEqual(["c", "b", "a"]);
  });

  it("manual with no group_order_manual falls back to the backend's own order", () => {
    const spec: GroupBySpec = { property_key: "kind" };
    expect(orderedGroups(groups, spec).map((g) => g.key)).toEqual(["b", "a", "c"]);
  });

  it("manual with group_order_manual reorders listed groups, unlisted ones trail in backend order", () => {
    const spec: GroupBySpec = { property_key: "kind", group_order: "manual", group_order_manual: ["c", "a"] };
    expect(orderedGroups(groups, spec).map((g) => g.key)).toEqual(["c", "a", "b"]);
  });
});

describe("groupPanel — stage 1, the property picker", () => {
  it("lists groupable properties, excludes Files entirely (not merely disabled)", () => {
    const onPatchConfig = vi.fn();
    render(
      <MenuList root={groupPanel(PROPERTIES, undefined, null, onPatchConfig)} nav="flyout" onClose={() => {}} label="Group" />
    );
    expect(screen.getByText("Group by")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search for a property…")).toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
    expect(screen.getByText("Kind")).toBeInTheDocument();
    expect(screen.queryByText("Attachments")).not.toBeInTheDocument();
  });

  it("picking a property patches group_by with the type's default mode", async () => {
    const user = userEvent.setup();
    const onSetGroupBy = vi.fn();
    render(
      <MenuList root={groupPanel(PROPERTIES, undefined, null, onSetGroupBy)} nav="flyout" onClose={() => {}} label="Group" />
    );
    await user.click(screen.getByText("Kind"));
    // group-panel.md's own capture: "Hide empty groups" is ON by default.
    // `onSetGroupBy` is the updater-based write (see GroupByUpdater's own
    // doc comment, GroupBuilder.tsx, for why a plain patch object would
    // race two rapid group_by edits against each other).
    expect(onSetGroupBy).toHaveBeenCalledTimes(1);
    expect(onSetGroupBy.mock.calls[0][0](undefined)).toEqual({
      property_key: "kind",
      hide_empty_groups: true,
    });
  });
});

describe("groupPanel — stage 2, grouped", () => {
  const groupBy: GroupBySpec = { property_key: "kind" };
  const groups: Group[] = [group("article", "article"), group("__no_value__", "No value")];

  it("renders Group by / Sort / Hide empty groups rows, plus Remove grouping and Learn about grouping", () => {
    const onSetGroupBy = vi.fn();
    render(
      <MenuList root={groupPanel(PROPERTIES, groupBy, groups, onSetGroupBy)} nav="flyout" onClose={() => {}} label="Group" />
    );
    expect(screen.getByText("Group by")).toBeInTheDocument();
    expect(screen.getByText("Sort")).toBeInTheDocument();
    expect(screen.getByText("Hide empty groups")).toBeInTheDocument();
    expect(screen.getByText("Groups")).toBeInTheDocument();
    expect(screen.getByText("Hide all")).toBeInTheDocument();
    expect(screen.getByText("article")).toBeInTheDocument();
    expect(screen.getByText("No Kind")).toBeInTheDocument();
    expect(screen.getByText("Remove grouping")).toBeInTheDocument();
    expect(screen.getByText("Learn about grouping")).toBeInTheDocument();
  });

  it("Remove grouping clears group_by", async () => {
    const user = userEvent.setup();
    const onSetGroupBy = vi.fn();
    render(
      <MenuList root={groupPanel(PROPERTIES, groupBy, groups, onSetGroupBy)} nav="flyout" onClose={() => {}} label="Group" />
    );
    await user.click(screen.getByText("Remove grouping"));
    expect(onSetGroupBy).toHaveBeenCalledTimes(1);
    expect(onSetGroupBy.mock.calls[0][0](groupBy)).toBeNull();
  });

  it("toggling Hide empty groups patches hide_empty_groups, merged onto the LATEST group_by", async () => {
    const user = userEvent.setup();
    const onSetGroupBy = vi.fn();
    render(
      <MenuList root={groupPanel(PROPERTIES, groupBy, groups, onSetGroupBy)} nav="flyout" onClose={() => {}} label="Group" />
    );
    await user.click(screen.getByRole("switch", { name: "Hide empty groups" }));
    expect(onSetGroupBy).toHaveBeenCalledTimes(1);
    // The updater merges onto whatever it's called with — asserting against
    // a DIFFERENT "latest" than the render-time `groupBy` (e.g. one a
    // concurrent write had already set `hidden_groups` on) is exactly the
    // race this fix closes: the merge must happen INSIDE the updater, not
    // against a stale closure.
    const latest = { ...groupBy, hidden_groups: ["article"] };
    expect(onSetGroupBy.mock.calls[0][0](latest)).toEqual({ ...latest, hide_empty_groups: true });
  });

  it("Hide all patches hidden_groups with every visible group's key", async () => {
    const user = userEvent.setup();
    const onSetGroupBy = vi.fn();
    render(
      <MenuList root={groupPanel(PROPERTIES, groupBy, groups, onSetGroupBy)} nav="flyout" onClose={() => {}} label="Group" />
    );
    await user.click(screen.getByText("Hide all"));
    expect(onSetGroupBy).toHaveBeenCalledTimes(1);
    expect(onSetGroupBy.mock.calls[0][0](groupBy)).toEqual({
      ...groupBy,
      hidden_groups: ["article", "__no_value__"],
    });
  });

  it("toggling one group's eye patches hidden_groups with just that key", async () => {
    const user = userEvent.setup();
    const onSetGroupBy = vi.fn();
    render(
      <MenuList root={groupPanel(PROPERTIES, groupBy, groups, onSetGroupBy)} nav="flyout" onClose={() => {}} label="Group" />
    );
    await user.click(screen.getByRole("button", { name: "Hide article" }));
    expect(onSetGroupBy).toHaveBeenCalledTimes(1);
    expect(onSetGroupBy.mock.calls[0][0](groupBy)).toEqual({ ...groupBy, hidden_groups: ["article"] });
  });
});
