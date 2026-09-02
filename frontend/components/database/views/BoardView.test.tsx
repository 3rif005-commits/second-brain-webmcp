import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// BoardCard renders an OpenNoteButton (task-17 fix round, finding 1), which
// navigates via next/navigation's useRouter — outside a real Next.js app
// router tree (as here, a plain RTL render) that throws "invariant expected
// app router to be mounted" unless mocked, same as ListView.test.tsx. M12:
// BoardView also reads/writes the row peek's `?p=&pm=` via `useRowPeek`
// now (usePathname/useSearchParams/router.replace) — mocked the same way.
const push = vi.fn();
const routerReplace = vi.fn();
let mockSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: routerReplace }),
  usePathname: () => "/brain/db/ds-1",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// RowPeek mounts a real BlockEditor for the row's own body — heavy
// (BlockNote), not what BoardView-level tests exercise. Stubbed the same
// way TableView.test.tsx/ListView.test.tsx already do for the identical
// reason.
vi.mock("@/components/editor/BlockEditor", () => ({
  BlockEditor: () => <div data-testid="block-editor-stub" />,
}));

import { BoardView, cardDraggableId, computeDragEndWrite, resolveDropValue } from "./BoardView";

beforeEach(() => {
  mockSearch = "";
  push.mockClear();
  routerReplace.mockClear();
});
import type { DatabaseRow, Group, PropertyResponse } from "@/lib/database/types";

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

const TITLE_PROP = prop({ key: "title", name: "Title", type: "title", position: 0 });
const STATUS_PROP = prop({ key: "status", name: "Status", type: "status", position: 1 });
const TAGS_PROP = prop({ key: "tags", name: "Tags", type: "multi_select", position: 1 });

function row(id: string, title: string, extra: DatabaseRow["properties"] = {}): DatabaseRow {
  return { id, properties: { title: { type: "title", title }, ...extra } };
}

describe("resolveDropValue (pure drag-drop logic, no dnd-kit simulation needed)", () => {
  const groups: Group[] = [
    {
      key: "todo",
      label: "To do",
      row_count: 1,
      rows: [row("row-1", "Task 1", { status: { type: "status", status: "todo" } })],
      subgroups: null,
    },
    { key: "done", label: "Done", row_count: 0, rows: [], subgroups: null },
  ];

  it("single-valued (status) group: dropping into a different column sets that value", () => {
    const result = resolveDropValue({ rowId: "row-1", sourceGroupKey: "todo" }, "done", STATUS_PROP, groups);
    expect(result).toEqual({ type: "status", status: "done" });
  });

  it("dropping into the same column it came from is a no-op", () => {
    const result = resolveDropValue({ rowId: "row-1", sourceGroupKey: "todo" }, "todo", STATUS_PROP, groups);
    expect(result).toBeUndefined();
  });

  it("dropping into the No value column clears a single-valued property", () => {
    const result = resolveDropValue(
      { rowId: "row-1", sourceGroupKey: "todo" },
      "__no_value__",
      STATUS_PROP,
      groups
    );
    expect(result).toBeNull();
  });

  it("multi_select: dropping into a new column ADDS the tag, preserving existing tags", () => {
    const msGroups: Group[] = [
      {
        key: "urgent",
        label: "Urgent",
        row_count: 1,
        rows: [row("row-1", "Task 1", { tags: { type: "multi_select", multi_select: ["urgent"] } })],
        subgroups: null,
      },
      { key: "backlog", label: "Backlog", row_count: 0, rows: [], subgroups: null },
    ];
    const result = resolveDropValue(
      { rowId: "row-1", sourceGroupKey: "urgent" },
      "backlog",
      TAGS_PROP,
      msGroups
    );
    expect(result).toEqual({ type: "multi_select", multi_select: ["urgent", "backlog"] });
  });

  it("multi_select: dropping onto a column whose tag the card already has is a no-op (no duplicate)", () => {
    // A card with tags ["urgent", "backlog"] appears in both columns; dropping
    // the instance shown under "urgent" onto "backlog" must not duplicate "backlog".
    const msGroups: Group[] = [
      {
        key: "urgent",
        label: "Urgent",
        row_count: 1,
        rows: [
          row("row-1", "Task 1", { tags: { type: "multi_select", multi_select: ["urgent", "backlog"] } }),
        ],
        subgroups: null,
      },
      {
        key: "backlog",
        label: "Backlog",
        row_count: 1,
        rows: [
          row("row-1", "Task 1", { tags: { type: "multi_select", multi_select: ["urgent", "backlog"] } }),
        ],
        subgroups: null,
      },
    ];
    const result = resolveDropValue(
      { rowId: "row-1", sourceGroupKey: "urgent" },
      "backlog",
      TAGS_PROP,
      msGroups
    );
    expect(result).toBeUndefined();
  });

  it("multi_select: dropping into the No value column clears all tags", () => {
    const msGroups: Group[] = [
      {
        key: "urgent",
        label: "Urgent",
        row_count: 1,
        rows: [row("row-1", "Task 1", { tags: { type: "multi_select", multi_select: ["urgent"] } })],
        subgroups: null,
      },
    ];
    const result = resolveDropValue(
      { rowId: "row-1", sourceGroupKey: "urgent" },
      "__no_value__",
      TAGS_PROP,
      msGroups
    );
    expect(result).toEqual({ type: "multi_select", multi_select: [] });
  });
});

describe("BoardView", () => {
  const GROUPS: Group[] = [
    {
      key: "todo",
      label: "To do",
      row_count: 2,
      rows: [
        row("row-1", "First task", { status: { type: "status", status: "todo" } }),
        row("row-2", "Second task", { status: { type: "status", status: "todo" } }),
      ],
      subgroups: null,
    },
    {
      key: "done",
      label: "Done",
      row_count: 1,
      rows: [row("row-3", "Third task", { status: { type: "status", status: "done" } })],
      subgroups: null,
    },
  ];

  it("renders one column per group with the group's label (not key) and a row_count badge", () => {
    render(
      <BoardView
        properties={[TITLE_PROP, STATUS_PROP]}
        groups={GROUPS}
        groupPropertyKey="status"
        hideEmptyGroups={false}
        onToggleHideEmptyGroups={vi.fn()}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    expect(screen.getByText("To do")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  // M12: cards used to always show every non-title property, in schema
  // order, regardless of Property Visibility (`config.hidden_properties`/
  // `property_order`) — a silent no-op, the same class of bug Table's own
  // `orderedProperties` already had fixed once (Checkpoint 1, finding 1).
  it("a property hidden via config.hidden_properties does not render on any card", () => {
    render(
      <BoardView
        properties={[TITLE_PROP, STATUS_PROP]}
        groups={GROUPS}
        groupPropertyKey="status"
        hideEmptyGroups={false}
        onToggleHideEmptyGroups={vi.fn()}
        editable={true}
        onCellChange={vi.fn()}
        config={{ hidden_properties: ["status"] }}
      />
    );

    expect(screen.queryByText("Status:")).not.toBeInTheDocument();
  });

  it("renders a card's title and other properties read-only when editable=false", () => {
    render(
      <BoardView
        properties={[TITLE_PROP, STATUS_PROP]}
        groups={GROUPS}
        groupPropertyKey="status"
        hideEmptyGroups={false}
        onToggleHideEmptyGroups={vi.fn()}
        editable={false}
        onCellChange={vi.fn()}
      />
    );

    expect(screen.getByText("First task")).toBeInTheDocument();
    expect(screen.getAllByText("todo")).toHaveLength(2);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("shows the 'no groupable property' placeholder when the view has no group_by configured", () => {
    render(
      <BoardView
        properties={[TITLE_PROP, STATUS_PROP]}
        groups={null}
        groupPropertyKey={null}
        hideEmptyGroups={false}
        onToggleHideEmptyGroups={vi.fn()}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    expect(
      screen.getByText(/no groupable property yet — add a Select, Status, or Multi-select property first/i)
    ).toBeInTheDocument();
  });

  it("toggling 'Hide empty groups' calls onToggleHideEmptyGroups with the new value", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <BoardView
        properties={[TITLE_PROP, STATUS_PROP]}
        groups={GROUPS}
        groupPropertyKey="status"
        hideEmptyGroups={false}
        onToggleHideEmptyGroups={onToggle}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: /hide empty groups/i });
    await user.click(checkbox);

    expect(onToggle).toHaveBeenCalledWith(true);
  });

  // M12: a card's Open button now opens the row's side peek (the same
  // `?p=&pm=s` URL shape Table/List/Feed already write) instead of always
  // hard-navigating — it respects the view's "Open pages in" default the
  // same way, replacing the old task-17 bare-navigation fix. `isOpen` being
  // set now also gives Board the same labelled OPEN/CLOSE toggle Table's
  // own row already has (previously icon-only, per this file's own prior
  // comment — no longer, now that a real peek-open state exists to reflect).
  it("clicking a card's Open button opens the row's side peek (writes ?p=&pm=s), not a bare navigation", async () => {
    const user = userEvent.setup();
    render(
      <BoardView
        properties={[TITLE_PROP, STATUS_PROP]}
        groups={GROUPS}
        groupPropertyKey="status"
        hideEmptyGroups={false}
        onToggleHideEmptyGroups={vi.fn()}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    await user.click(screen.getAllByRole("button", { name: "Open" })[0]);

    expect(push).not.toHaveBeenCalled();
    expect(routerReplace).toHaveBeenCalled();
    const [url] = routerReplace.mock.calls[routerReplace.mock.calls.length - 1];
    expect(url).toContain("p=row-1");
    expect(url).toContain("pm=s");
  });
});

describe("cardDraggableId (pure id-shaping logic, task-17 fix round, finding 2)", () => {
  it("disambiguates by sub-bucket when the same row appears in two sub-buckets of one column (multi_select sub_group_by)", () => {
    // Only possible when sub_group_by targets a multi_select property: the
    // same row can land in more than one sub-bucket of the same top-level
    // column. sourceGroupKey alone is identical for both instances there,
    // so without the sub-bucket's own key in the id, dnd-kit's internal
    // registry would silently drop one draggable's handlers (last
    // registration wins).
    const idInSubA = cardDraggableId("urgent", "tag-a", "row-1");
    const idInSubB = cardDraggableId("urgent", "tag-b", "row-1");
    expect(idInSubA).not.toEqual(idInSubB);
  });

  it("still disambiguates the pre-existing case: the same row in two different top-level columns (multi_select group_by)", () => {
    const idInColumnA = cardDraggableId("urgent", undefined, "row-1");
    const idInColumnB = cardDraggableId("backlog", undefined, "row-1");
    expect(idInColumnA).not.toEqual(idInColumnB);
  });

  it("is stable (not accidentally colliding) for the ordinary non-sub-grouped case", () => {
    expect(cardDraggableId("todo", undefined, "row-1")).toEqual(cardDraggableId("todo", undefined, "row-1"));
  });
});

describe("BoardView sub-grouping render (synthetic fixture, no real sub_group_by UI needed)", () => {
  it("renders the same row once per sub-bucket without React key/id collisions when sub-grouped by a multi_select property", () => {
    // Constructed directly, the same way task-16-brief.md's own sub-group
    // shape works: a top-level Group whose `rows` is empty (task-15's own
    // contract — a sub-grouped Group's own `.rows` is unused once
    // `.subgroups` is set) and two subgroups both containing the same row,
    // modeling a card with two tags under a multi_select sub_group_by.
    const SUBGROUPED: Group[] = [
      {
        key: "urgent",
        label: "Urgent",
        row_count: 1,
        rows: [],
        subgroups: [
          { key: "tag-a", label: "Tag A", row_count: 1, rows: [row("row-1", "Task 1")], subgroups: null },
          { key: "tag-b", label: "Tag B", row_count: 1, rows: [row("row-1", "Task 1")], subgroups: null },
        ],
      },
    ];

    render(
      <BoardView
        properties={[TITLE_PROP, STATUS_PROP]}
        groups={SUBGROUPED}
        groupPropertyKey="status"
        hideEmptyGroups={false}
        onToggleHideEmptyGroups={vi.fn()}
        editable={true}
        onCellChange={vi.fn()}
      />
    );

    // Both sub-bucket instances render — the real dnd-kit-registry
    // collision this closes can't be observed without simulating a full
    // pointer drag (see the cardDraggableId unit tests above for the
    // uniqueness guarantee itself); this is a rendering sanity check that
    // the fix didn't break the sub-grouped layout.
    expect(screen.getAllByText("Task 1")).toHaveLength(2);
    expect(screen.getByText(/tag a/i)).toBeInTheDocument();
    expect(screen.getByText(/tag b/i)).toBeInTheDocument();
  });
});

describe("computeDragEndWrite (handleDragEnd's wiring, task-17 fix round, finding 4)", () => {
  const groups: Group[] = [
    {
      key: "todo",
      label: "To do",
      row_count: 1,
      rows: [row("row-1", "Task 1", { status: { type: "status", status: "todo" } })],
      subgroups: null,
    },
    { key: "done", label: "Done", row_count: 0, rows: [], subgroups: null },
  ];

  it("returns the write to make for a valid drop on a different column's droppable", () => {
    const event = {
      over: { id: "column:done" },
      active: { data: { current: { rowId: "row-1", sourceGroupKey: "todo" } } },
    };
    const result = computeDragEndWrite(event, STATUS_PROP, groups);
    expect(result).toEqual({ rowId: "row-1", value: { type: "status", status: "done" } });
  });

  it("returns undefined when dropped outside any droppable (over is null)", () => {
    const event = { over: null, active: { data: { current: { rowId: "row-1", sourceGroupKey: "todo" } } } };
    expect(computeDragEndWrite(event, STATUS_PROP, groups)).toBeUndefined();
  });

  it("returns undefined when dropped on something that isn't a column droppable", () => {
    const event = {
      over: { id: "not-a-column" },
      active: { data: { current: { rowId: "row-1", sourceGroupKey: "todo" } } },
    };
    expect(computeDragEndWrite(event, STATUS_PROP, groups)).toBeUndefined();
  });

  it("returns undefined when there's no drag data attached to the active draggable", () => {
    const event = { over: { id: "column:done" }, active: { data: { current: undefined } } };
    expect(computeDragEndWrite(event, STATUS_PROP, groups)).toBeUndefined();
  });

  it("returns undefined when groupProperty hasn't resolved yet", () => {
    const event = {
      over: { id: "column:done" },
      active: { data: { current: { rowId: "row-1", sourceGroupKey: "todo" } } },
    };
    expect(computeDragEndWrite(event, undefined, groups)).toBeUndefined();
  });

  it("returns undefined when groups is null (query not resolved yet)", () => {
    const event = {
      over: { id: "column:done" },
      active: { data: { current: { rowId: "row-1", sourceGroupKey: "todo" } } },
    };
    expect(computeDragEndWrite(event, STATUS_PROP, null)).toBeUndefined();
  });

  it("returns undefined for a no-op drop (dropped back in its own column)", () => {
    const event = {
      over: { id: "column:todo" },
      active: { data: { current: { rowId: "row-1", sourceGroupKey: "todo" } } },
    };
    expect(computeDragEndWrite(event, STATUS_PROP, groups)).toBeUndefined();
  });
});
