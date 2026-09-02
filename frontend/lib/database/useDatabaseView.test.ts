import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { useDatabaseView } from "./useDatabaseView";
import type {
  AutomationResponse,
  DatabaseDetailResponse,
  DatabaseRow,
  Group,
  RowTemplateResponse,
  ViewResponse,
} from "./types";

const TABLE_VIEW: ViewResponse = {
  id: "v1",
  data_source_id: "ds-1",
  user_id: "user-1",
  name: "Default view",
  icon: null,
  type: "table",
  config: {},
  filter: null,
  sorts: [],
  is_locked: false,
  position: 0,
};

const BOARD_VIEW: ViewResponse = {
  id: "v2",
  data_source_id: "ds-1",
  user_id: "user-1",
  name: "Board",
  icon: null,
  type: "board",
  config: { group_by: { property_key: "status" } },
  filter: null,
  sorts: [],
  is_locked: false,
  position: 1,
};

function detail(views: ViewResponse[]): DatabaseDetailResponse {
  return {
    database: {
      id: "db-1",
      user_id: "user-1",
      title: "My Database",
      description: [],
      icon: null,
      cover_url: null,
      is_inline: false,
      parent_note_id: null,
      is_locked: false,
      position: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      deleted_at: null,
    },
    data_source: {
      id: "ds-1",
      database_id: "db-1",
      user_id: "user-1",
      name: "Default",
      system_kind: null,
      position: 0,
      created_at: "2026-01-01T00:00:00Z",
      is_virtual: false,
    },
    properties: [
      { id: "p1", data_source_id: "ds-1", user_id: "user-1", key: "titleKey", name: "Title", type: "title", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 0, created_at: "2026-01-01T00:00:00Z" },
      { id: "p2", data_source_id: "ds-1", user_id: "user-1", key: "status", name: "Status", type: "status", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 1, created_at: "2026-01-01T00:00:00Z" },
    ],
    views,
  };
}

const DETAIL = detail([TABLE_VIEW]);

const ROWS: DatabaseRow[] = [
  { id: "row-1", properties: { titleKey: { type: "title", title: "First" } } },
  { id: "row-2", properties: { titleKey: { type: "title", title: "Second" } } },
];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  showToast.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDatabaseView", () => {
  it("loads database detail, defaults activeViewId to the first view, and queries rows via POST .../query", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    expect(result.current.database?.title).toBe("My Database");
    expect(result.current.activeViewId).toBe("v1");
    expect(result.current.groups).toBeNull();
    expect(result.current.error).toBeNull();

    const queryCall = fetchMock.mock.calls.find(([url]) => url === "/api/db/data-sources/ds-1/query");
    expect(queryCall).toBeTruthy();
    const body = JSON.parse((queryCall![1] as RequestInit).body as string);
    expect(body).toEqual({ filter: null, sorts: [] });
  });

  // Review checkpoint (Phase 0c/M4/M5/M6): `view.filter` can be a MID-EDIT
  // state — "+ Add advanced filter" persists an empty group, picking a
  // property persists a condition with no value yet — since this app writes
  // the filter tree to the view on every builder edit, with no separate
  // draft. Before this fix, either state 400'd `POST .../query` (the
  // backend's `FilterGroup` requires >=1 child, and `coerce_value` rejects
  // a missing value), silently — `loadRows`'s own catch sets `error`, which
  // the component only ever surfaces while `!database`, so once the
  // database has loaded, rows/groups just stop updating with no visible
  // sign anything went wrong.
  it("sends `filter: null` (not a 400) when the view's persisted filter is an empty group", async () => {
    const view: ViewResponse = { ...TABLE_VIEW, filter: { type: "group", op: "and", children: [] } };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(detail([view])));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.error).toBeNull();

    const queryCall = fetchMock.mock.calls.find(([url]) => url === "/api/db/data-sources/ds-1/query");
    const body = JSON.parse((queryCall![1] as RequestInit).body as string);
    expect(body.filter).toBeNull();
  });

  it("sends `filter: null` when a freshly-picked property's condition has no value yet", async () => {
    const view: ViewResponse = {
      ...TABLE_VIEW,
      filter: { type: "condition", property: "status", operator: "equals" },
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(detail([view])));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.error).toBeNull();

    const queryCall = fetchMock.mock.calls.find(([url]) => url === "/api/db/data-sources/ds-1/query");
    const body = JSON.parse((queryCall![1] as RequestInit).body as string);
    expect(body.filter).toBeNull();
  });

  it("sets an error when the initial load fails", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ detail: "database not found" }, 404))
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("missing"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("database not found");
  });

  it("switching to a board view queries with group_by from its config and exposes `groups`, not `rows`", async () => {
    const boardDetail = detail([TABLE_VIEW, BOARD_VIEW]);
    const GROUPS: Group[] = [
      { key: "todo", label: "To do", row_count: 1, rows: [ROWS[0]], subgroups: null },
      { key: "done", label: "Done", row_count: 1, rows: [ROWS[1]], subgroups: null },
    ];

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(boardDetail));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        const body = JSON.parse(init!.body as string);
        if (body.group_by) return Promise.resolve(jsonResponse({ groups: GROUPS }));
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    act(() => result.current.setActiveViewId("v2"));

    await waitFor(() => expect(result.current.groups).not.toBeNull());
    expect(result.current.groups).toEqual(GROUPS);

    const queryCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/db/data-sources/ds-1/query");
    const boardCall = queryCalls[queryCalls.length - 1];
    const body = JSON.parse((boardCall[1] as RequestInit).body as string);
    expect(body.group_by).toEqual({ property_key: "status" });
  });

  // Task-35 (Chart view): `getQueryExtras` (types.ts) is the single dispatch
  // point `loadRows` now calls for both Board and Chart, translating Chart's
  // Notion-named `config.x_axis`/`config.y_axis`/`config.stack_by`
  // (`property_id`) into the `group_by`/`sub_group_by`/`aggregations`
  // shapes `POST .../query` expects (`property_key`). ChartView.tsx itself
  // is a pure `groups`/`aggregates`-props-driven component (same shape as
  // BoardView) with no fetch logic of its own, so — same as the Board
  // wiring test directly above — the actual request-building assertions
  // belong here, next to the code that builds the request, not in
  // ChartView.test.tsx.
  it("switching to a Chart view (column/bar/line/donut) sends group_by (incl. hide_empty_groups), sub_group_by, and aggregations built from x_axis/y_axis/stack_by", async () => {
    const CHART_VIEW: ViewResponse = {
      id: "v3",
      data_source_id: "ds-1",
      user_id: "user-1",
      name: "Chart",
      icon: null,
      type: "chart",
      config: {
        chart_type: "column",
        x_axis: { property_id: "status" },
        y_axis: { aggregator: "count" },
        stack_by: { property_id: "titleKey" },
        hide_empty_groups: true,
      },
      filter: null,
      sorts: [],
      is_locked: false,
      position: 2,
    };
    const chartDetail = detail([TABLE_VIEW, CHART_VIEW]);
    const GROUPS: Group[] = [
      { key: "todo", label: "To do", row_count: 1, rows: [ROWS[0]], subgroups: null, aggregates: { y: 1 } },
    ];

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(chartDetail));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        const body = JSON.parse(init!.body as string);
        if (body.group_by) return Promise.resolve(jsonResponse({ groups: GROUPS }));
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    act(() => result.current.setActiveViewId("v3"));
    await waitFor(() => expect(result.current.groups).not.toBeNull());
    expect(result.current.groups).toEqual(GROUPS);
    expect(result.current.aggregates).toBeNull();

    const queryCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/db/data-sources/ds-1/query");
    const body = JSON.parse((queryCalls[queryCalls.length - 1][1] as RequestInit).body as string);
    expect(body.group_by).toEqual({ property_key: "status", hide_empty_groups: true });
    expect(body.sub_group_by).toEqual({ property_key: "titleKey" });
    expect(body.aggregations).toEqual([{ key: "y", aggregator: "count", property_key: undefined }]);
  });

  it("switching to a Chart view with chart_type='number' sends no group_by/sub_group_by, and exposes the ungrouped `aggregates` (not `groups`)", async () => {
    const NUMBER_CHART_VIEW: ViewResponse = {
      id: "v4",
      data_source_id: "ds-1",
      user_id: "user-1",
      name: "Total",
      icon: null,
      type: "chart",
      config: { chart_type: "number", y_axis: { aggregator: "count" } },
      filter: null,
      sorts: [],
      is_locked: false,
      position: 3,
    };
    const numberDetail = detail([TABLE_VIEW, NUMBER_CHART_VIEW]);

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(numberDetail));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        const body = JSON.parse(init!.body as string);
        if (body.aggregations?.length && !body.group_by) {
          return Promise.resolve(jsonResponse({ rows: ROWS, aggregates: { y: 2 } }));
        }
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    act(() => result.current.setActiveViewId("v4"));
    await waitFor(() => expect(result.current.aggregates).toEqual({ y: 2 }));
    expect(result.current.groups).toBeNull();

    const queryCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/db/data-sources/ds-1/query");
    const body = JSON.parse((queryCalls[queryCalls.length - 1][1] as RequestInit).body as string);
    expect(body.group_by).toBeUndefined();
    expect(body.sub_group_by).toBeUndefined();
    expect(body.aggregations).toEqual([{ key: "y", aggregator: "count", property_key: undefined }]);
  });

  it("updateCell: applies optimistically, then reconciles with the server response", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/rows/row-1" && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({ id: "row-1", properties: { titleKey: { type: "title", title: "Edited" } } })
        );
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    await act(async () => {
      await result.current.updateCell("row-1", "titleKey", { type: "title", title: "Edited" });
    });

    const row1 = result.current.rows.find((r) => r.id === "row-1");
    expect(row1?.properties.titleKey).toEqual({ type: "title", title: "Edited" });
    expect(showToast).not.toHaveBeenCalled();

    const patchCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
    expect(patchCall).toBeTruthy();
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
      property_key: "titleKey",
      value: { type: "title", title: "Edited" },
    });
  });

  it("updateCell: merges a PATCH response's shifted_rows into the other row's properties, without a refetch (M7 combined-review Important finding 2)", async () => {
    // Regression test: the backend's PATCH .../rows/{note_id} returns
    // `shifted_rows` when a dependency date-shift cascade moves other rows
    // as a side effect of this write (task-21-brief.md §4), so the client
    // can apply them without a refetch. Before this fix, `RowResponse`
    // didn't declare the field and `updateCell` only ever read `id`/
    // `properties` off the PATCH response — the cascade happened correctly
    // server-side (task B's date really did move) but row-2 stayed
    // visibly stale in `rows` until a full reload, since an ungrouped
    // Table view (this test's `TABLE_VIEW`) never re-queries after a write.
    const rowsWithDates: DatabaseRow[] = [
      {
        id: "row-1",
        properties: {
          titleKey: { type: "title", title: "First" },
          due: { type: "date", date: { start: "2026-01-01T00:00:00+00:00", end: null, time_zone: null } },
        },
      },
      {
        id: "row-2",
        properties: {
          titleKey: { type: "title", title: "Second" },
          due: { type: "date", date: { start: "2026-01-02T00:00:00+00:00", end: null, time_zone: null } },
        },
      },
    ];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: rowsWithDates }));
      }
      if (url === "/api/db/data-sources/ds-1/rows/row-1" && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({
            id: "row-1",
            properties: {
              titleKey: { type: "title", title: "First" },
              due: { type: "date", date: { start: "2026-01-08T00:00:00+00:00", end: null, time_zone: null } },
            },
            shifted_rows: [
              {
                id: "row-2",
                properties: {
                  due: { type: "date", date: { start: "2026-01-09T00:00:00+00:00", end: null, time_zone: null } },
                },
              },
            ],
          })
        );
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    await act(async () => {
      await result.current.updateCell("row-1", "due", {
        type: "date",
        date: { start: "2026-01-08T00:00:00+00:00", end: null, time_zone: null },
      });
    });

    // No extra query fetch — this is an ungrouped (table) view, so the
    // shift must be applied from the PATCH response directly, not by a
    // second `POST .../query` round trip.
    const queryCalls = fetchMock.mock.calls.filter(([url]) => url === "/api/db/data-sources/ds-1/query");
    expect(queryCalls).toHaveLength(1); // only the initial load

    const row1 = result.current.rows.find((r) => r.id === "row-1");
    const row2 = result.current.rows.find((r) => r.id === "row-2");
    expect(row1?.properties.due).toEqual({
      type: "date",
      date: { start: "2026-01-08T00:00:00+00:00", end: null, time_zone: null },
    });
    // The shifted row's date actually updates...
    expect(row2?.properties.due).toEqual({
      type: "date",
      date: { start: "2026-01-09T00:00:00+00:00", end: null, time_zone: null },
    });
    // ...and only the shifted property is touched — the rest of row-2's
    // properties (a ShiftedRow carries only the one date property that
    // moved, not a full row) survive the merge untouched.
    expect(row2?.properties.titleKey).toEqual({ type: "title", title: "Second" });
  });

  it("updateCell: rolls back and toasts on a 500", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/rows/row-1" && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ detail: "internal error" }, 500));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    await act(async () => {
      await result.current.updateCell("row-1", "titleKey", { type: "title", title: "Edited" });
    });

    const row1 = result.current.rows.find((r) => r.id === "row-1");
    expect(row1?.properties.titleKey).toEqual({ type: "title", title: "First" });
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("internal error", "error");
  });

  it("updateCell: rolls back and toasts on a 501 (All Notes write-not-implemented)", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/rows/row-1" && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({ detail: "row writes on the All Notes virtual source are not yet implemented" }, 501)
        );
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    await act(async () => {
      await result.current.updateCell("row-1", "titleKey", { type: "title", title: "Edited" });
    });

    const row1 = result.current.rows.find((r) => r.id === "row-1");
    expect(row1?.properties.titleKey).toEqual({ type: "title", title: "First" });
    expect(showToast).toHaveBeenCalledWith(
      "row writes on the All Notes virtual source are not yet implemented",
      "error"
    );
  });

  it("updateCell: on a grouped (board) view, re-queries so `groups` reflects the new column after a successful write", async () => {
    const boardDetail = detail([BOARD_VIEW]);
    const initialGroups: Group[] = [
      { key: "todo", label: "To do", row_count: 1, rows: [{ id: "row-1", properties: { titleKey: { type: "title", title: "First" }, status: { type: "status", status: "todo" } } }], subgroups: null },
      { key: "done", label: "Done", row_count: 0, rows: [], subgroups: null },
    ];
    const movedGroups: Group[] = [
      { key: "todo", label: "To do", row_count: 0, rows: [], subgroups: null },
      { key: "done", label: "Done", row_count: 1, rows: [{ id: "row-1", properties: { titleKey: { type: "title", title: "First" }, status: { type: "status", status: "done" } } }], subgroups: null },
    ];

    let queryCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(boardDetail));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        queryCount += 1;
        return Promise.resolve(jsonResponse({ groups: queryCount === 1 ? initialGroups : movedGroups }));
      }
      if (url === "/api/db/data-sources/ds-1/rows/row-1" && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({ id: "row-1", properties: { titleKey: { type: "title", title: "First" }, status: { type: "status", status: "done" } } })
        );
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.groups).toEqual(initialGroups));

    await act(async () => {
      await result.current.updateCell("row-1", "status", { type: "status", status: "done" });
    });

    await waitFor(() => expect(result.current.groups).toEqual(movedGroups));
  });

  it("updateCell: PATCH succeeds but the follow-up grouped refetch fails — doesn't roll back the write and doesn't show a false 'could not save' toast (task-17 fix round, finding 3)", async () => {
    const boardDetail = detail([BOARD_VIEW]);
    const initialGroups: Group[] = [
      {
        key: "todo",
        label: "To do",
        row_count: 1,
        rows: [
          {
            id: "row-1",
            properties: { titleKey: { type: "title", title: "First" }, status: { type: "status", status: "todo" } },
          },
        ],
        subgroups: null,
      },
      { key: "done", label: "Done", row_count: 0, rows: [], subgroups: null },
    ];

    let queryCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(boardDetail));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        queryCount += 1;
        // First query (initial load) succeeds; the second (updateCell's
        // post-write grouped refetch) simulates a transient network blip.
        if (queryCount === 1) return Promise.resolve(jsonResponse({ groups: initialGroups }));
        return Promise.reject(new Error("network blip"));
      }
      if (url === "/api/db/data-sources/ds-1/rows/row-1" && init?.method === "PATCH") {
        return Promise.resolve(
          jsonResponse({
            id: "row-1",
            properties: { titleKey: { type: "title", title: "First" }, status: { type: "status", status: "done" } },
          })
        );
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.groups).toEqual(initialGroups));

    await act(async () => {
      await result.current.updateCell("row-1", "status", { type: "status", status: "done" });
    });

    // The PATCH succeeded — the property really did change server-side —
    // so the refetch failing afterward must not roll `groups` back to
    // something else or null it out.
    expect(result.current.groups).toEqual(initialGroups);

    // No false "could not save" toast: the write wasn't the thing that
    // failed. Exactly one toast fires, and it's the milder "out of date"
    // notice, distinguishable by variant from a real write failure.
    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, variant] = showToast.mock.calls[0];
    expect(variant).toBe("info");
    expect(message).not.toMatch(/could not save/i);
    expect(message).toMatch(/saved.*out of date/i);
  });

  it("createView: POSTs to .../views and appends the created view to `views`", async () => {
    const created: ViewResponse = { ...BOARD_VIEW, id: "v3", name: "New view" };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/views" && init?.method === "POST") {
        return Promise.resolve(jsonResponse(created, 201));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let returned: ViewResponse | undefined;
    await act(async () => {
      returned = await result.current.createView("New view", "board");
    });

    expect(returned).toEqual(created);
    expect(result.current.views.map((v) => v.id)).toEqual(["v1", "v3"]);

    const createCall = fetchMock.mock.calls.find(([url]) => url === "/api/db/data-sources/ds-1/views");
    expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({
      name: "New view",
      type: "board",
      icon: null,
    });
  });

  it("updateView: PATCHes .../views/{id} and updates the local view", async () => {
    const patched: ViewResponse = { ...TABLE_VIEW, config: { foo: "bar" } };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/views/v1" && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse(patched));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.updateView("v1", { config: { foo: "bar" } });
    });

    expect(result.current.views.find((v) => v.id === "v1")?.config).toEqual({ foo: "bar" });
  });

  // Milestone 12 (task-40): row templates. createTemplate/updateTemplate/
  // deleteTemplate/instantiateTemplate mirror createView/updateView above
  // exactly (fetch, errorMessage on a failed response — thrown, not caught
  // here, same as createView/updateView — and local `templates` state
  // updated on success).
  describe("templates (task-40)", () => {
    const TEMPLATE: RowTemplateResponse = {
      id: "tmpl-1",
      data_source_id: "ds-1",
      user_id: "user-1",
      name: "Weekly review",
      icon: null,
      properties: {},
      content: [],
      is_default: false,
      repeat_config: null,
      next_run_at: null,
      position: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    it("load(): fetches GET .../templates alongside the database detail and exposes it as `templates`", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([TEMPLATE]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.templates).toEqual([TEMPLATE]);
    });

    it("load(): skips GET .../templates entirely for the virtual All Notes source", async () => {
      const virtualDetail: DatabaseDetailResponse = {
        ...DETAIL,
        data_source: { ...DETAIL.data_source, id: "all-notes", is_virtual: true },
      };
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(virtualDetail));
        if (url === "/api/db/data-sources/all-notes/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.templates).toEqual([]);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/templates"))).toBe(false);
    });

    it("createTemplate: POSTs {name, icon, properties: {}, content: [], is_default: false, repeat_config: null} and appends the result to `templates`", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(TEMPLATE, 201));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let returned: RowTemplateResponse | undefined;
      await act(async () => {
        returned = await result.current.createTemplate("Weekly review");
      });

      expect(returned).toEqual(TEMPLATE);
      expect(result.current.templates).toEqual([TEMPLATE]);

      const createCall = fetchMock.mock.calls.find(
        ([url, i]) => url === "/api/db/data-sources/ds-1/templates" && (i as RequestInit)?.method === "POST"
      );
      expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({
        name: "Weekly review",
        icon: null,
        properties: {},
        content: [],
        is_default: false,
        repeat_config: null,
      });
    });

    it("updateTemplate: PATCHes .../templates/{id} and replaces the matching entry in `templates`", async () => {
      const updated: RowTemplateResponse = { ...TEMPLATE, name: "Renamed" };
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([TEMPLATE]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/templates/tmpl-1" && init?.method === "PATCH") {
          return Promise.resolve(jsonResponse(updated));
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.templates).toEqual([TEMPLATE]));

      await act(async () => {
        await result.current.updateTemplate("tmpl-1", { name: "Renamed" });
      });

      expect(result.current.templates).toEqual([updated]);
      const patchCall = fetchMock.mock.calls.find(([url]) => url === "/api/db/templates/tmpl-1");
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ name: "Renamed" });
    });

    it("updateTemplate: throws (does not catch/toast internally) on a failed PATCH — same as updateView", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([TEMPLATE]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/templates/tmpl-1" && init?.method === "PATCH") {
          return Promise.resolve(jsonResponse({ detail: "another default already exists" }, 400));
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.templates).toEqual([TEMPLATE]));

      await expect(
        act(async () => {
          await result.current.updateTemplate("tmpl-1", { is_default: true });
        })
      ).rejects.toThrow("another default already exists");
      expect(showToast).not.toHaveBeenCalled();
      // Local state is untouched by a failed PATCH — the caller (e.g.
      // TemplateEditor's is_default checkbox) owns its own revert.
      expect(result.current.templates).toEqual([TEMPLATE]);
    });

    it("deleteTemplate: DELETEs .../templates/{id} and removes it from `templates`", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([TEMPLATE]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/templates/tmpl-1" && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.templates).toEqual([TEMPLATE]));

      await act(async () => {
        await result.current.deleteTemplate("tmpl-1");
      });

      expect(result.current.templates).toEqual([]);
      expect(fetchMock).toHaveBeenCalledWith("/api/db/templates/tmpl-1", { method: "DELETE" });
    });

    it("instantiateTemplate: POSTs .../templates/{id}/instantiate, returns the created row, and does NOT touch `templates` state", async () => {
      const createdRow = { id: "row-9", properties: { titleKey: { type: "title", title: "From template" } } };
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([TEMPLATE]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/templates/tmpl-1/instantiate" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(createdRow));
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.templates).toEqual([TEMPLATE]));

      let returned: unknown;
      await act(async () => {
        returned = await result.current.instantiateTemplate("tmpl-1");
      });

      expect(returned).toEqual(createdRow);
      expect(result.current.templates).toEqual([TEMPLATE]);
    });
  });

  // Milestone 12 (task-41): database automations. createAutomation/
  // updateAutomation/deleteAutomation mirror createTemplate/updateTemplate/
  // deleteTemplate above exactly (fetch, errorMessage on a failed response —
  // thrown, not caught here — and local `automations` state updated on
  // success).
  describe("automations (task-41)", () => {
    const AUTOMATION: AutomationResponse = {
      id: "auto-1",
      data_source_id: "ds-1",
      user_id: "user-1",
      name: "Weekly digest",
      is_active: true,
      last_error: null,
      trigger_combinator: "any",
      triggers: [],
      view_id: null,
      actions: [],
      next_run_at: null,
      position: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };

    it("load(): fetches GET .../automations alongside the database detail and exposes it as `automations`", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([AUTOMATION]));
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.automations).toEqual([AUTOMATION]);
    });

    it("load(): skips GET .../automations entirely for the virtual All Notes source", async () => {
      const virtualDetail: DatabaseDetailResponse = {
        ...DETAIL,
        data_source: { ...DETAIL.data_source, id: "all-notes", is_virtual: true },
      };
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(virtualDetail));
        if (url === "/api/db/data-sources/all-notes/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.automations).toEqual([]);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/automations"))).toBe(false);
    });

    it("createAutomation: POSTs {name, is_active: true, trigger_combinator: 'any', triggers: [], view_id: null, actions: []} and appends the result to `automations`", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/data-sources/ds-1/automations" && init?.method === "POST") {
          return Promise.resolve(jsonResponse(AUTOMATION, 201));
        }
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.loading).toBe(false));

      let returned: AutomationResponse | undefined;
      await act(async () => {
        returned = await result.current.createAutomation("Weekly digest");
      });

      expect(returned).toEqual(AUTOMATION);
      expect(result.current.automations).toEqual([AUTOMATION]);

      const createCall = fetchMock.mock.calls.find(
        ([url, i]) => url === "/api/db/data-sources/ds-1/automations" && (i as RequestInit)?.method === "POST"
      );
      expect(JSON.parse((createCall![1] as RequestInit).body as string)).toEqual({
        name: "Weekly digest",
        is_active: true,
        trigger_combinator: "any",
        triggers: [],
        view_id: null,
        actions: [],
      });
    });

    it("updateAutomation: PATCHes .../automations/{id} and replaces the matching entry in `automations`", async () => {
      const updated: AutomationResponse = { ...AUTOMATION, name: "Renamed" };
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([AUTOMATION]));
        if (url === "/api/db/automations/auto-1" && init?.method === "PATCH") {
          return Promise.resolve(jsonResponse(updated));
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.automations).toEqual([AUTOMATION]));

      await act(async () => {
        await result.current.updateAutomation("auto-1", { name: "Renamed" });
      });

      expect(result.current.automations).toEqual([updated]);
      const patchCall = fetchMock.mock.calls.find(([url]) => url === "/api/db/automations/auto-1");
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ name: "Renamed" });
    });

    it("updateAutomation: throws (does not catch/toast internally) on a failed PATCH — same as updateTemplate", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([AUTOMATION]));
        if (url === "/api/db/automations/auto-1" && init?.method === "PATCH") {
          return Promise.resolve(
            jsonResponse({ detail: "an every_frequency trigger cannot be paired with any other trigger" }, 400)
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.automations).toEqual([AUTOMATION]));

      await expect(
        act(async () => {
          await result.current.updateAutomation("auto-1", {
            triggers: [
              {
                type: "every_frequency",
                frequency: "daily",
                interval: 1,
                start_date: "2026-01-01",
                time_of_day: "09:00",
              },
            ],
          });
        })
      ).rejects.toThrow("an every_frequency trigger cannot be paired with any other trigger");
      expect(showToast).not.toHaveBeenCalled();
      expect(result.current.automations).toEqual([AUTOMATION]);
    });

    it("deleteAutomation: DELETEs .../automations/{id} and removes it from `automations`", async () => {
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
        if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
          return Promise.resolve(jsonResponse({ rows: ROWS }));
        }
        if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
        if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([AUTOMATION]));
        if (url === "/api/db/automations/auto-1" && init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        throw new Error(`unexpected fetch ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const { result } = renderHook(() => useDatabaseView("db-1"));
      await waitFor(() => expect(result.current.automations).toEqual([AUTOMATION]));

      await act(async () => {
        await result.current.deleteAutomation("auto-1");
      });

      expect(result.current.automations).toEqual([]);
      expect(fetchMock).toHaveBeenCalledWith("/api/db/automations/auto-1", { method: "DELETE" });
    });
  });

  it("ensureRelationLinks: fetches once, caches the result, and is a no-op on a second call for the same key", async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query") return Promise.resolve(jsonResponse({ rows: ROWS }));
      if (url === "/api/db/data-sources/ds-1/rows/row-1/relations/related") {
        return Promise.resolve(jsonResponse({ rows: [{ id: "row-2", title: "Second" }] }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.ensureRelationLinks("row-1", "related");
    });
    expect(result.current.relationLinks["row-1:related"]).toEqual([{ id: "row-2", title: "Second" }]);

    const relationCallsBefore = fetchMock.mock.calls.filter(([url]) =>
      (url as string).includes("/relations/")
    ).length;
    await act(async () => {
      await result.current.ensureRelationLinks("row-1", "related");
    });
    const relationCallsAfter = fetchMock.mock.calls.filter(([url]) =>
      (url as string).includes("/relations/")
    ).length;
    expect(relationCallsAfter).toBe(relationCallsBefore); // cached — no second fetch
  });

  it("ensureRelationLinksBulk: fetches every requested row's links in ONE request and caches each under its own key (M7 combined-review Important finding 3)", async () => {
    // Regression test for the N+1 fix: TableView's sub-item pre-fetch used
    // to call ensureRelationLinks once per visible row — one HTTP request
    // per row. ensureRelationLinksBulk must issue exactly one request for
    // however many row ids are asked about, hitting the bulk endpoint
    // task 20's list_links_bulk was built for and task 21 originally never
    // exposed.
    const bulkCalls: unknown[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query") return Promise.resolve(jsonResponse({ rows: ROWS }));
      if (url === "/api/db/data-sources/ds-1/relations/subitem/links/bulk" && init?.method === "POST") {
        bulkCalls.push(JSON.parse(init.body as string));
        return Promise.resolve(
          jsonResponse({
            links: {
              "row-1": [{ id: "row-9", title: "Child" }],
              "row-2": [],
            },
          })
        );
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.ensureRelationLinksBulk(["row-1", "row-2"], "subitem");
    });

    expect(bulkCalls).toEqual([{ row_ids: ["row-1", "row-2"] }]);
    expect(result.current.relationLinks["row-1:subitem"]).toEqual([{ id: "row-9", title: "Child" }]);
    // Present as an empty array, not absent — same "every requested id is a
    // key" contract as the backend's list_links_bulk.
    expect(result.current.relationLinks["row-2:subitem"]).toEqual([]);

    const bulkCallCount = fetchMock.mock.calls.filter(([url]) => (url as string).includes("/links/bulk")).length;
    expect(bulkCallCount).toBe(1); // one request for both rows, not two
  });

  it("ensureRelationLinksBulk: only requests ids that aren't already cached", async () => {
    const bulkCalls: unknown[] = [];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query") return Promise.resolve(jsonResponse({ rows: ROWS }));
      if (url === "/api/db/data-sources/ds-1/relations/subitem/links/bulk" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        bulkCalls.push(body);
        return Promise.resolve(
          jsonResponse({ links: Object.fromEntries(body.row_ids.map((id: string) => [id, []])) })
        );
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.ensureRelationLinksBulk(["row-1"], "subitem");
    });
    expect(bulkCalls).toEqual([{ row_ids: ["row-1"] }]);

    await act(async () => {
      await result.current.ensureRelationLinksBulk(["row-1", "row-2"], "subitem");
    });
    // row-1 was already cached from the first call — only row-2 is asked
    // about the second time.
    expect(bulkCalls).toEqual([{ row_ids: ["row-1"] }, { row_ids: ["row-2"] }]);
  });

  it("setRelationLinks: applies optimistically, PUTs {row_ids}, then reconciles with the server response", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query") return Promise.resolve(jsonResponse({ rows: ROWS }));
      if (url === "/api/db/data-sources/ds-1/rows/row-1/relations/related" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ rows: [{ id: "row-2", title: "Second" }] }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setRelationLinks("row-1", "related", [{ id: "row-2", title: "Second" }]);
    });

    expect(result.current.relationLinks["row-1:related"]).toEqual([{ id: "row-2", title: "Second" }]);
    expect(showToast).not.toHaveBeenCalled();

    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT"
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({ row_ids: ["row-2"] });
  });

  it("setRelationLinks: rolls back the cache and toasts an error on a failed PUT", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query") return Promise.resolve(jsonResponse({ rows: ROWS }));
      if (url === "/api/db/data-sources/ds-1/rows/row-1/relations/related" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ detail: "cycle detected: a -> b -> a" }, 400));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setRelationLinks("row-1", "related", [{ id: "row-2", title: "Second" }]);
    });

    // Nothing was cached before this call — rollback means the key goes
    // back to "not fetched" (absent), not `[]`.
    expect("row-1:related" in result.current.relationLinks).toBe(false);
    expect(showToast).toHaveBeenCalledWith("cycle detected: a -> b -> a", "error");
  });

  it("setRelationLinks: rolls back to the PREVIOUS cached value (not an empty list) when one existed", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query") return Promise.resolve(jsonResponse({ rows: ROWS }));
      if (url === "/api/db/data-sources/ds-1/rows/row-1/relations/related" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ detail: "boom" }, 500));
      }
      if (url === "/api/db/data-sources/ds-1/rows/row-1/relations/related") {
        return Promise.resolve(jsonResponse({ rows: [{ id: "row-2", title: "Second" }] }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.ensureRelationLinks("row-1", "related");
    });
    expect(result.current.relationLinks["row-1:related"]).toEqual([{ id: "row-2", title: "Second" }]);

    await act(async () => {
      await result.current.setRelationLinks("row-1", "related", []);
    });

    expect(result.current.relationLinks["row-1:related"]).toEqual([{ id: "row-2", title: "Second" }]);
  });

  it("setRelationLinks: PUT succeeds but the follow-up rows refetch fails — doesn't roll back the write and shows an info toast, not an error toast (mirrors updateCell's task-17 fix)", async () => {
    let queryCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query") {
        queryCount += 1;
        if (queryCount === 1) return Promise.resolve(jsonResponse({ rows: ROWS }));
        return Promise.reject(new Error("network blip"));
      }
      if (url === "/api/db/data-sources/ds-1/rows/row-1/relations/related" && init?.method === "PUT") {
        return Promise.resolve(jsonResponse({ rows: [{ id: "row-2", title: "Second" }] }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.setRelationLinks("row-1", "related", [{ id: "row-2", title: "Second" }]);
    });

    // The write succeeded — the cache must reflect that, not roll back.
    expect(result.current.relationLinks["row-1:related"]).toEqual([{ id: "row-2", title: "Second" }]);

    expect(showToast).toHaveBeenCalledTimes(1);
    const [message, variant] = showToast.mock.calls[0];
    expect(variant).toBe("info");
    expect(message).not.toMatch(/could not save/i);
    expect(message).toMatch(/saved.*out of date/i);
  });

  it("refetch vs refetchRows: refetch alone does not re-run the rows query, refetchRows does (live-verified regression)", async () => {
    // A real bug shipped and was caught by live-clicking the app, not by
    // this suite: TableView's "Add row" called `refetch` (= `load`) after a
    // successful POST, but `load` only re-fetches database/properties/views
    // — `loadRows`'s own effect is keyed to activeView's id/type/filter/
    // sorts/config, none of which change when a row is merely added, so it
    // never re-ran. The new row was created server-side (confirmed 201) but
    // never appeared — "No rows yet." stuck forever. `refetchRows` is the
    // separately-exposed function that actually re-queries rows.
    let queryCallCount = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/databases/db-1") return Promise.resolve(jsonResponse(DETAIL));
      if (url === "/api/db/data-sources/ds-1/query" && init?.method === "POST") {
        queryCallCount += 1;
        return Promise.resolve(jsonResponse({ rows: ROWS }));
      }
      if (url === "/api/db/data-sources/ds-1/templates") return Promise.resolve(jsonResponse([]));
      if (url === "/api/db/data-sources/ds-1/automations") return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useDatabaseView("db-1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(queryCallCount).toBe(1); // the initial load

    await act(async () => {
      await result.current.refetch();
    });
    expect(queryCallCount).toBe(1); // unchanged — refetch must not touch rows

    await act(async () => {
      await result.current.refetchRows();
    });
    expect(queryCallCount).toBe(2); // refetchRows actually re-queries
  });
});
