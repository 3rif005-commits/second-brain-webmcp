import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Group, RelatedRow, RowTemplateResponse, ViewResponse } from "@/lib/database/types";

// ListView (task-17) navigates via next/navigation's useRouter — outside a
// real Next.js app router tree (as here, a plain RTL render) that throws
// "invariant expected app router to be mounted" unless mocked, same as
// ListView.test.tsx does on its own.
// TableView (rendered for the "table" active-view case below) reads/writes
// the row peek's `?p=&pm=` via useSearchParams/usePathname/router.replace
// (M10, row-peek.md) — mocked the same way. DatabaseShell ITSELF now reads/
// writes `?view=` the identical way (M7's create-flow rewrite) — `mockSearch`
// mutable and `routerReplace` a shared spy, same shape TableView.test.tsx's
// own `?p=`/`?pm=` mock already established, so a test can seed the URL the
// component reads at mount and assert what it writes back.
const routerReplace = vi.fn();
let mockSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplace }),
  usePathname: () => "/brain/db/db-1",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

// Factories, not shared object literals — `mockHook.database`/`dataSource`/
// `rows` are plain property REASSIGNMENTS in several tests (e.g. the
// switching-databases regression test below), not deep mutations of the
// original object, so `beforeEach` resetting them back to a FRESH object
// each time (not the SAME stale reference) is what actually stops one
// test's override leaking into the next — same reasoning `properties`'s
// own reset comment below already documents for arrays.
function defaultDatabase() {
  return {
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
  };
}
function defaultDataSource() {
  return {
    id: "ds-1",
    database_id: "db-1",
    user_id: "user-1",
    name: "Default",
    system_kind: null,
    position: 0,
    created_at: "2026-01-01T00:00:00Z",
    is_virtual: false,
  };
}
function defaultRows() {
  return [{ id: "row-1", properties: { title: { type: "title", title: "First" } } }];
}

const mockHook: {
  database: unknown;
  dataSource: unknown;
  properties: unknown[];
  views: ViewResponse[];
  activeViewId: string;
  setActiveViewId: ReturnType<typeof vi.fn>;
  rows: unknown[];
  groups: Group[] | null;
  aggregates: Record<string, number> | null;
  loading: boolean;
  error: string | null;
  updateCell: ReturnType<typeof vi.fn>;
  relationLinks: Record<string, RelatedRow[]>;
  ensureRelationLinks: ReturnType<typeof vi.fn>;
  setRelationLinks: ReturnType<typeof vi.fn>;
  createView: ReturnType<typeof vi.fn>;
  updateView: ReturnType<typeof vi.fn>;
  templates: RowTemplateResponse[];
  createTemplate: ReturnType<typeof vi.fn>;
  updateTemplate: ReturnType<typeof vi.fn>;
  deleteTemplate: ReturnType<typeof vi.fn>;
  instantiateTemplate: ReturnType<typeof vi.fn>;
  refetch: ReturnType<typeof vi.fn>;
  refetchRows: ReturnType<typeof vi.fn>;
} = {
  database: defaultDatabase(),
  dataSource: defaultDataSource(),
  properties: [
    { id: "p1", data_source_id: "ds-1", user_id: "user-1", key: "title", name: "Title", type: "title", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 0, created_at: "2026-01-01T00:00:00Z" },
    { id: "p2", data_source_id: "ds-1", user_id: "user-1", key: "status", name: "Status", type: "status", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 1, created_at: "2026-01-01T00:00:00Z" },
  ],
  views: [
    { id: "v1", data_source_id: "ds-1", user_id: "user-1", name: "Table view", icon: null, type: "table", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
  ],
  activeViewId: "v1",
  setActiveViewId: vi.fn(),
  rows: defaultRows(),
  groups: null,
  aggregates: null,
  loading: false,
  error: null,
  updateCell: vi.fn(),
  relationLinks: {},
  ensureRelationLinks: vi.fn(),
  setRelationLinks: vi.fn(),
  createView: vi.fn(),
  updateView: vi.fn(),
  templates: [],
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  instantiateTemplate: vi.fn(),
  refetch: vi.fn(),
  refetchRows: vi.fn(),
};

vi.mock("@/lib/database/useDatabaseView", () => ({
  useDatabaseView: () => mockHook,
}));

import { DatabaseShell } from "./DatabaseShell";

beforeEach(() => {
  // Same leak-prevention reasoning as `properties` below — the switching-
  // databases regression test reassigns `database`/`dataSource`/`rows`
  // outright, which (found live, running this exact test) leaked "db-2"/
  // "ds-2" into every test declared after it before this reset existed.
  mockHook.database = defaultDatabase();
  mockHook.dataSource = defaultDataSource();
  mockHook.rows = defaultRows();
  mockHook.activeViewId = "v1";
  mockHook.views = [
    { id: "v1", data_source_id: "ds-1", user_id: "user-1", name: "Table view", icon: null, type: "table", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
  ];
  mockHook.groups = null;
  mockHook.aggregates = null;
  mockSearch = "";
  // Reset in case a test (e.g. the "group by a Select property" test below)
  // appends to this array — `mockHook.properties` is otherwise a single
  // module-scoped object every test shares, so a mutation would otherwise
  // leak into every test declared after it.
  mockHook.properties = [
    { id: "p1", data_source_id: "ds-1", user_id: "user-1", key: "title", name: "Title", type: "title", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 0, created_at: "2026-01-01T00:00:00Z" },
    { id: "p2", data_source_id: "ds-1", user_id: "user-1", key: "status", name: "Status", type: "status", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 1, created_at: "2026-01-01T00:00:00Z" },
  ];
  vi.clearAllMocks();
  // `patchViewConfig` (DatabaseShell.tsx's fix for the live-discovered
  // stale-config-merge race) actually awaits `updateView`'s response and
  // reads `.config` off it — every prior config-driven view's PATCH call
  // was fire-and-forget from the component's own perspective, so this
  // mock never needed a resolved value before. A generic default here
  // (id doesn't need to match any specific test's view) keeps every
  // existing `updateView`-calling test from hitting an unhandled
  // rejection; a test asserting the ACTUAL merged/returned config
  // overrides this with its own `mockResolvedValueOnce` as needed.
  mockHook.updateView.mockResolvedValue({
    id: "unused",
    data_source_id: "ds-1",
    user_id: "user-1",
    name: "",
    icon: null,
    type: "table",
    config: {},
    filter: null,
    sorts: [],
    is_locked: false,
    position: 0,
  });
});

describe("DatabaseShell", () => {
  it("renders TableView for a table-typed active view", () => {
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByText("First")).toBeInTheDocument();
  });

  // Review-checkpoint finding (M7-M11 pass): the same class of bug the
  // M1-M3 checkpoint already fixed for ViewNameHeader — DatabaseHeader's
  // titleDraft is a useState INITIAL value, never resynced when the
  // `database` prop changes to a DIFFERENT database. Sidebar.tsx navigates
  // between databases client-side (no full reload), so switching from A to
  // B without a `key` left the input showing A's stale title over B's real
  // data. Fixed with `key={database.id}` in DatabaseShell.tsx.
  it("switching to a different database (client-side nav, same DatabaseShell instance) shows the NEW database's title, not the old one's", () => {
    const { rerender } = render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByLabelText("Database title")).toHaveValue("My Database");

    mockHook.database = { ...(mockHook.database as Record<string, unknown>), id: "db-2", title: "Other Database" };
    mockHook.dataSource = { ...(mockHook.dataSource as Record<string, unknown>), id: "ds-2", database_id: "db-2" };
    mockHook.views = [
      { id: "v-other", data_source_id: "ds-2", user_id: "user-1", name: "Table view", icon: null, type: "table", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v-other";
    mockHook.rows = [];
    rerender(<DatabaseShell databaseId="db-2" />);

    expect(screen.getByLabelText("Database title")).toHaveValue("Other Database");
  });

  it("renders BoardView for a board-typed active view", () => {
    mockHook.views = [
      { id: "v2", data_source_id: "ds-1", user_id: "user-1", name: "Board", icon: null, type: "board", config: { group_by: { property_key: "status" } }, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v2";
    mockHook.groups = [
      { key: "todo", label: "To do", row_count: 1, rows: [{ id: "row-1", properties: { title: { type: "title", title: "First" } } }], subgroups: null },
    ];
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByText("To do")).toBeInTheDocument();
  });

  it("renders a plain placeholder — not a crash — for an unrecognized view type", () => {
    mockHook.views = [
      // "__unsupported_test_type__" rather than "calendar" — Task 33 gives
      // calendar a real branch below (and gallery/list/feed already have
      // theirs from Task 17), so this test's own unrecognized-type example
      // has to be a string that actually stays unimplemented, not a stale
      // stand-in for a type that's since shipped.
      { id: "v3", data_source_id: "ds-1", user_id: "user-1", name: "Unsupported", icon: null, type: "__unsupported_test_type__", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v3";
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByText(/this view type isn.t supported yet/i)).toBeInTheDocument();
  });

  it("renders CalendarView for a calendar-typed active view", () => {
    mockHook.views = [
      { id: "v7", data_source_id: "ds-1", user_id: "user-1", name: "Calendar", icon: null, type: "calendar", config: { date_property_id: "due" }, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v7";
    mockHook.properties = [
      ...mockHook.properties,
      { id: "p4", data_source_id: "ds-1", user_id: "user-1", key: "due", name: "Due", type: "date", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 2, created_at: "2026-01-01T00:00:00Z" },
    ];
    render(<DatabaseShell databaseId="db-1" />);
    // The Calendar view's own toolbar (view-range select) is a stable
    // render signal that doesn't depend on the visible month/week's actual
    // day contents (which vary with the real current date).
    expect(screen.getByLabelText("View range")).toBeInTheDocument();
  });

  it("renders TimelineView for a timeline-typed active view", () => {
    mockHook.views = [
      { id: "v8", data_source_id: "ds-1", user_id: "user-1", name: "Timeline", icon: null, type: "timeline", config: { date_property_id: "due" }, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v8";
    mockHook.properties = [
      ...mockHook.properties,
      { id: "p4", data_source_id: "ds-1", user_id: "user-1", key: "due", name: "Due", type: "date", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 2, created_at: "2026-01-01T00:00:00Z" },
    ];
    render(<DatabaseShell databaseId="db-1" />);
    // The Timeline view's own toolbar (zoom-level select) is a stable
    // render signal that doesn't depend on the plotted rows' actual dates.
    expect(screen.getByLabelText("Zoom level")).toBeInTheDocument();
  });

  it("renders ChartView for a chart-typed active view", () => {
    mockHook.views = [
      {
        id: "v9",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Chart",
        icon: null,
        type: "chart",
        config: { chart_type: "column", x_axis: { property_id: "status" }, y_axis: { aggregator: "count" } },
        filter: null,
        sorts: [],
        is_locked: false,
        position: 0,
      },
    ];
    mockHook.activeViewId = "v9";
    mockHook.groups = [
      { key: "todo", label: "To do", row_count: 1, rows: [], subgroups: null, aggregates: { y: 1 } },
    ];
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByTestId("chart-view")).toBeInTheDocument();
  });

  it("forces editable={false} for ChartView regardless of the caller's own editable (dataSource) state — the one place this view type diverges from every other view's read/write gating", () => {
    // is_virtual=false would make every OTHER view editable=true.
    mockHook.dataSource = { ...(mockHook.dataSource as Record<string, unknown>), is_virtual: false };
    mockHook.views = [
      {
        id: "v9",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Chart",
        icon: null,
        type: "chart",
        config: { chart_type: "column", x_axis: { property_id: "status" }, y_axis: { aggregator: "count" } },
        filter: null,
        sorts: [],
        is_locked: false,
        position: 0,
      },
    ];
    mockHook.activeViewId = "v9";
    mockHook.groups = [
      { key: "todo", label: "To do", row_count: 1, rows: [], subgroups: null, aggregates: { y: 1 } },
    ];
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByTestId("chart-view")).toHaveAttribute("data-editable", "false");
  });

  it("renders GalleryView for a gallery-typed active view", () => {
    mockHook.views = [
      { id: "v4", data_source_id: "ds-1", user_id: "user-1", name: "Gallery", icon: null, type: "gallery", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v4";
    mockHook.rows = [{ id: "row-1", properties: { title: { type: "title", title: "Gallery row" } } }];
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByText("Gallery row")).toBeInTheDocument();
    expect(screen.getByLabelText("Cover size")).toBeInTheDocument();
  });

  it("renders ListView for a list-typed active view", () => {
    mockHook.views = [
      { id: "v5", data_source_id: "ds-1", user_id: "user-1", name: "List", icon: null, type: "list", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v5";
    mockHook.rows = [{ id: "row-1", properties: { title: { type: "title", title: "List row" } } }];
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByText("List row")).toBeInTheDocument();
  });

  it("renders FeedView for a feed-typed active view", () => {
    mockHook.views = [
      { id: "v6", data_source_id: "ds-1", user_id: "user-1", name: "Feed", icon: null, type: "feed", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v6";
    mockHook.rows = [{ id: "row-1", properties: { title: { type: "title", title: "Feed row" } } }];
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByText("Feed row")).toBeInTheDocument();
  });

  it("renders FormView (not some other component, not a blank fallback) for a form-typed active view", () => {
    mockHook.views = [
      {
        id: "v11",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Form",
        icon: null,
        type: "form",
        config: { questions: [{ property_key: "title", required: false }] },
        filter: null,
        sorts: [],
        is_locked: false,
        position: 0,
      },
    ];
    mockHook.activeViewId = "v11";
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByTestId("form-view")).toBeInTheDocument();
    // The seeded question renders by its property name, proof `properties`
    // reached FormView and config.questions was read correctly — not just
    // that some placeholder rendered.
    expect(screen.getByText("Title")).toBeInTheDocument();
  });

  it("Form view's onConfigChange PATCHes through updateView with the rest of activeView.config preserved, same as every other config-driven view", async () => {
    const user = userEvent.setup();
    mockHook.views = [
      {
        id: "v11",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Form",
        icon: null,
        type: "form",
        config: { submit_screen: { button_text: "Go", button_color: "#000000", confirmation_title: "Thanks!", confirmation_body: "" } },
        filter: null,
        sorts: [],
        is_locked: false,
        position: 0,
      },
    ];
    mockHook.activeViewId = "v11";
    render(<DatabaseShell databaseId="db-1" />);

    await user.click(screen.getByLabelText("Closed for submissions"));

    expect(mockHook.updateView).toHaveBeenCalledWith("v11", {
      config: {
        submit_screen: { button_text: "Go", button_color: "#000000", confirmation_title: "Thanks!", confirmation_body: "" },
        is_form_closed: true,
        submission_permissions: "none",
      },
    });
  });

  it("live-discovered fix: two config PATCHes fired before the first's response lands do not clobber each other (patchViewConfig's stale-merge race)", async () => {
    // Reproduces exactly what broke live while click-testing FormView.tsx:
    // toggling "Required" then immediately toggling "Closed", before the
    // first PATCH's response had come back, silently reverted "Required"
    // back to false in the SECOND request's body — because the old
    // `(patch) => updateView(activeView.id, { config: { ...activeView.config,
    // ...patch } })` closure always merged onto the SAME stale
    // `activeView.config` from render time, regardless of an earlier PATCH
    // already in flight.
    const user = userEvent.setup();
    mockHook.views = [
      {
        id: "v11",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Form",
        icon: null,
        type: "form",
        config: { questions: [{ property_key: "title", required: false }], is_form_closed: false },
        filter: null,
        sorts: [],
        is_locked: false,
        position: 0,
      },
    ];
    mockHook.activeViewId = "v11";

    // A controllable, never-auto-resolving mock for the FIRST call only —
    // the second call gets the `beforeEach` default (resolves immediately)
    // so it can complete and reveal what it actually sent, without the test
    // itself needing to inspect an intermediate resolved value.
    let resolveFirst: (v: ViewResponse) => void = () => {};
    mockHook.updateView.mockImplementationOnce(
      () => new Promise<ViewResponse>((resolve) => { resolveFirst = resolve; })
    );

    render(<DatabaseShell databaseId="db-1" />);

    await user.click(screen.getByLabelText("Question 1 required"));
    // The first PATCH (Required) is now in flight, deliberately unresolved.
    expect(mockHook.updateView).toHaveBeenCalledTimes(1);

    await user.click(screen.getByLabelText("Closed for submissions"));
    // patchViewConfig queues same-view PATCHes sequentially — the second
    // one must not have fired its own updateView call yet, since it's
    // chained behind the still-pending first one.
    expect(mockHook.updateView).toHaveBeenCalledTimes(1);

    // Resolve the first PATCH exactly as the real endpoint would: the
    // server's own merged config, `required: true` genuinely applied.
    resolveFirst({
      id: "v11",
      data_source_id: "ds-1",
      user_id: "user-1",
      name: "Form",
      icon: null,
      type: "form",
      config: { questions: [{ property_key: "title", required: true }], is_form_closed: false },
      filter: null,
      sorts: [],
      is_locked: false,
      position: 0,
    });

    await vi.waitFor(() => expect(mockHook.updateView).toHaveBeenCalledTimes(2));

    // The bug: this second call's body would carry `required: false` if it
    // had merged onto the stale render-time `activeView.config` instead of
    // the first PATCH's own resolved result.
    const [, secondPatchBody] = mockHook.updateView.mock.calls[1];
    expect(secondPatchBody.config.questions).toEqual([{ property_key: "title", required: true }]);
    expect(secondPatchBody.config.is_form_closed).toBe(true);
  });

  it("live-discovered fix (M1-M3 review checkpoint): two sort writes fired before the first's response lands do not clobber each other (queueSortsUpdate's stale-array race)", async () => {
    // `sorts` is a whole-array REPLACE, not a mergeable object like
    // `config` — patchViewConfig's own merge trick doesn't apply, so this
    // exercises the separate fix: onSetSorts takes an UPDATER, and
    // DatabaseShell defers computing the next array until the write's own
    // turn in the queue, feeding it whatever the LATEST resolved sorts are
    // — not whatever was current when the row was clicked. M3 is what made
    // this reachable: the toolbar's Sort popover and the header menu's own
    // Sort row can now both be interacted with in the same session.
    const user = userEvent.setup();

    let resolveFirst: (v: ViewResponse) => void = () => {};
    mockHook.updateView.mockImplementationOnce(
      () => new Promise<ViewResponse>((resolve) => { resolveFirst = resolve; })
    );

    render(<DatabaseShell databaseId="db-1" />);

    // First write: the toolbar's Sort popover adds a sort on "Title".
    await user.click(screen.getByRole("button", { name: /^Sort/ }));
    let panel = await screen.findByRole("listbox", { name: "Sort" });
    await user.click(within(panel).getByText("Title"));
    expect(mockHook.updateView).toHaveBeenCalledTimes(1);
    // Still unresolved — deliberately, so the second write races it.

    // Second write: reopen the SAME popover (MenuList closes it after the
    // first selection) and add a sort on "Status" — its own updater closes
    // over an empty `current` from THIS render (the client hasn't heard
    // back from the first write yet), exactly the stale input the old code
    // would have sent as-is.
    await user.click(screen.getByRole("button", { name: /^Sort/ }));
    panel = await screen.findByRole("listbox", { name: "Sort" });
    await user.click(within(panel).getByText("Status"));
    // Queued, not fired yet — chained behind the still-pending first write.
    expect(mockHook.updateView).toHaveBeenCalledTimes(1);

    resolveFirst({
      id: "v1",
      data_source_id: "ds-1",
      user_id: "user-1",
      name: "Table view",
      icon: null,
      type: "table",
      config: {},
      filter: null,
      sorts: [{ property: "title", direction: "asc" }],
      is_locked: false,
      position: 0,
    });

    await vi.waitFor(() => expect(mockHook.updateView).toHaveBeenCalledTimes(2));

    // The bug: the second call's body would be just [{property:"status",...}]
    // — dropping Title's sort entirely — if it had used the stale `[]` it
    // closed over instead of the first write's resolved result.
    const [, secondBody] = mockHook.updateView.mock.calls[1];
    expect(secondBody.sorts).toEqual([
      { property: "title", direction: "asc" },
      { property: "status", direction: "asc" },
    ]);
  });

  it("live-discovered fix (M6 group-order checklist): two group_by writes fired before the first's response lands do not clobber each other (queueGroupByUpdate's stale-merge race)", async () => {
    // `group_by` lives inside `config` (mergeable at the top level, unlike
    // `sorts`/`filter`) but `GroupStageTwo.patchGroupBy` (GroupBuilder.tsx)
    // builds its own next `group_by` SUB-object by spreading whatever it
    // closed over at render time — two of its own writers ("Hide all", the
    // "Hide empty groups" toggle) fired close together both spread the SAME
    // stale snapshot, so the second one's spread silently dropped whatever
    // the first had just set. Live-verified reachable: "Hide all" (sets
    // hidden_groups) immediately followed by toggling "Hide empty groups"
    // persisted only the toggle, with hidden_groups gone entirely.
    const user = userEvent.setup();
    mockHook.views = [
      {
        id: "v1",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Table view",
        icon: null,
        type: "table",
        config: { group_by: { property_key: "status", hide_empty_groups: true } },
        filter: null,
        sorts: [],
        is_locked: false,
        position: 0,
      },
    ];
    mockHook.groups = [
      { key: "todo", label: "To do", row_count: 1, rows: [{ id: "row-1", properties: {} }], subgroups: null },
      { key: "done", label: "Done", row_count: 0, rows: [], subgroups: null },
    ];

    let resolveFirst: (v: ViewResponse) => void = () => {};
    mockHook.updateView.mockImplementationOnce(
      () => new Promise<ViewResponse>((resolve) => { resolveFirst = resolve; })
    );

    render(<DatabaseShell databaseId="db-1" />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const sidebar = await screen.findByRole("dialog", { name: "View settings" });
    await user.click(within(sidebar).getByText("Group"));

    // First write: "Hide all" — sets hidden_groups to every visible group's key.
    await user.click(within(sidebar).getByText("Hide all"));
    expect(mockHook.updateView).toHaveBeenCalledTimes(1);
    // Still unresolved — deliberately, so the second write races it.

    // Second write: toggling "Hide empty groups" — its own updater closes
    // over the render-time `groupBy` (the client hasn't heard back from the
    // first write yet), exactly the stale input the old code would have sent.
    await user.click(within(sidebar).getByRole("switch", { name: "Hide empty groups" }));
    // Queued, not fired yet — chained behind the still-pending first write.
    expect(mockHook.updateView).toHaveBeenCalledTimes(1);

    resolveFirst({
      id: "v1",
      data_source_id: "ds-1",
      user_id: "user-1",
      name: "Table view",
      icon: null,
      type: "table",
      config: { group_by: { property_key: "status", hide_empty_groups: true, hidden_groups: ["todo", "done"] } },
      filter: null,
      sorts: [],
      is_locked: false,
      position: 0,
    });

    await vi.waitFor(() => expect(mockHook.updateView).toHaveBeenCalledTimes(2));

    // The bug: the second call's group_by would be just
    // { property_key: "status", hide_empty_groups: false } — hidden_groups
    // gone entirely — if it had merged onto the stale render-time `groupBy`
    // instead of the first write's resolved result.
    const [, secondBody] = mockHook.updateView.mock.calls[1];
    expect(secondBody.config.group_by).toEqual({
      property_key: "status",
      hide_empty_groups: false,
      hidden_groups: ["todo", "done"],
    });
  });

  it("renders DashboardView (not some other component, not a blank fallback) for a dashboard-typed active view", () => {
    // Empty config.rows -- no widgets to mount, so no per-widget fetch is
    // needed for this render-dispatch check (DashboardView.test.tsx owns
    // the widget-content/fetch-driven behaviour).
    mockHook.views = [
      { id: "v12", data_source_id: "ds-1", user_id: "user-1", name: "Dashboard", icon: null, type: "dashboard", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockHook.activeViewId = "v12";
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByTestId("dashboard-view")).toBeInTheDocument();
  });

  it("clicking a different view tab calls setActiveViewId", async () => {
    mockHook.views = [
      { id: "v1", data_source_id: "ds-1", user_id: "user-1", name: "Table view", icon: null, type: "table", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
      { id: "v2", data_source_id: "ds-1", user_id: "user-1", name: "Board", icon: null, type: "board", config: {}, filter: null, sorts: [], is_locked: false, position: 1 },
    ];
    const user = userEvent.setup();
    render(<DatabaseShell databaseId="db-1" />);
    await user.click(screen.getByText("Board"));
    expect(mockHook.setActiveViewId).toHaveBeenCalledWith("v2");
  });

  // view-tab-bar.md's Persistence table: "The active view is already in the
  // URL as ?view=<viewId> ... DatabaseShell keeps it in component state
  // only" — a disclosed, previously-unclosed gap (M3/M7's own recorded
  // notes). ViewTabs.tsx's "Copy link to view" has written `?view=` since
  // M7; these prove DatabaseShell now reads it back too.
  it("switching tabs writes ?view=<viewId> onto the URL, preserving other params", async () => {
    mockHook.views = [
      { id: "v1", data_source_id: "ds-1", user_id: "user-1", name: "Table view", icon: null, type: "table", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
      { id: "v2", data_source_id: "ds-1", user_id: "user-1", name: "Board", icon: null, type: "board", config: {}, filter: null, sorts: [], is_locked: false, position: 1 },
    ];
    mockSearch = "p=row-1";
    const user = userEvent.setup();
    render(<DatabaseShell databaseId="db-1" />);
    await user.click(screen.getByText("Board"));

    expect(mockHook.setActiveViewId).toHaveBeenCalledWith("v2");
    const [url] = routerReplace.mock.calls[routerReplace.mock.calls.length - 1];
    const params = new URLSearchParams(url.split("?")[1]);
    expect(params.get("view")).toBe("v2");
    expect(params.get("p")).toBe("row-1"); // untouched
  });

  it("a ?view= param matching one of this database's views overrides the hook's own default selection on load", () => {
    mockHook.views = [
      { id: "v1", data_source_id: "ds-1", user_id: "user-1", name: "Table view", icon: null, type: "table", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
      { id: "v2", data_source_id: "ds-1", user_id: "user-1", name: "Board", icon: null, type: "board", config: {}, filter: null, sorts: [], is_locked: false, position: 1 },
    ];
    mockSearch = "view=v2";
    render(<DatabaseShell databaseId="db-1" />);
    expect(mockHook.setActiveViewId).toHaveBeenCalledWith("v2");
  });

  it("a ?view= param naming a view that doesn't exist is silently ignored", () => {
    mockHook.views = [
      { id: "v1", data_source_id: "ds-1", user_id: "user-1", name: "Table view", icon: null, type: "table", config: {}, filter: null, sorts: [], is_locked: false, position: 0 },
    ];
    mockSearch = "view=does-not-exist";
    render(<DatabaseShell databaseId="db-1" />);
    expect(mockHook.setActiveViewId).not.toHaveBeenCalledWith("does-not-exist");
  });

  it("creating a Board view auto-selects the existing Status property, sets group_by with mode='option', then switches to it", async () => {
    // view-tab-bar.md's M7 create-flow rewrite: Board creates IMMEDIATELY
    // (no name/group-by prompt) and DatabaseShell.handleCreateView
    // auto-selects the first select/status/multi_select property by
    // position — mockHook.properties' default fixture is [title, status],
    // so "status" is the only candidate.
    //
    // Regression, live-verified: services.db.query.grouping.GroupBySpec has no
    // implicit default `mode` for `status` (Milestone 4's own "fail loud, don't
    // guess" decision) — omitting it isn't a no-op, it's a real 400 from
    // POST .../query the moment this view is opened. Confirmed by actually
    // creating a Board grouped by Status in the running app and watching it get
    // stuck on "Loading…" forever (a 400 with no error surfaced). This test
    // previously asserted the buggy shape (`{ property_key: "status" }`, no
    // `mode`) and passed, which is exactly how it shipped uncaught.
    const user = userEvent.setup();
    const createdView = { id: "v9", data_source_id: "ds-1", user_id: "user-1", name: "", icon: null, type: "board", config: {}, filter: null, sorts: [], is_locked: false, position: 1 };
    mockHook.createView.mockResolvedValue(createdView);
    mockHook.updateView.mockResolvedValue({
      ...createdView,
      config: { group_by: { property_key: "status", mode: "option" } },
    });

    render(<DatabaseShell databaseId="db-1" />);

    await user.click(screen.getByRole("button", { name: "Add a new view" }));
    const dialog = screen.getByRole("dialog", { name: "Add a new view" });
    await user.click(within(dialog).getByRole("button", { name: "Board" }));

    expect(mockHook.createView).toHaveBeenCalledWith("", "board");
    expect(mockHook.updateView).toHaveBeenCalledWith("v9", {
      config: { group_by: { property_key: "status", mode: "option", hide_empty_groups: true } },
    });
    expect(mockHook.setActiveViewId).toHaveBeenCalledWith("v9");
  });

  it("creating a Board view auto-selects a Select property when no Status property exists: no mode needed, group_by stays bare", async () => {
    // Restricted to title (ungroupable-for-Board-purposes, see
    // DatabaseShell.tsx's own comment) + a lone "select" property — proves
    // the auto-select doesn't need `mode` for a plain select, and doesn't
    // pick "title" even though it's in the wider GROUPABLE_PROPERTY_TYPES
    // list other surfaces (Group panel, column header) use.
    mockHook.properties = [
      mockHook.properties[0],
      { id: "p3", data_source_id: "ds-1", user_id: "user-1", key: "priority", name: "Priority", type: "select", config: {}, description: null, storage: "jsonb", column_name: null, result_type: null, is_volatile: false, position: 2, created_at: "2026-01-01T00:00:00Z" },
    ];
    const user = userEvent.setup();
    const createdView = { id: "v10", data_source_id: "ds-1", user_id: "user-1", name: "", icon: null, type: "board", config: {}, filter: null, sorts: [], is_locked: false, position: 1 };
    mockHook.createView.mockResolvedValue(createdView);
    mockHook.updateView.mockResolvedValue({ ...createdView, config: { group_by: { property_key: "priority" } } });

    render(<DatabaseShell databaseId="db-1" />);

    await user.click(screen.getByRole("button", { name: "Add a new view" }));
    const dialog = screen.getByRole("dialog", { name: "Add a new view" });
    await user.click(within(dialog).getByRole("button", { name: "Board" }));

    expect(mockHook.updateView).toHaveBeenCalledWith("v10", {
      config: { group_by: { property_key: "priority", hide_empty_groups: true } },
    });
  });

  it("creating a Board view with no select/status/multi_select property leaves it ungrouped — does not auto-invent one", async () => {
    // The user's own decision (2026-09-02, asked live rather than guessed):
    // keep this app's refusal to auto-create a Status property the way
    // Notion itself does (confirmed live against a real Notion database
    // with no groupable property at all) — land on BoardView's own "no
    // groupable property yet" placeholder instead, fixable afterward via
    // the Group panel.
    mockHook.properties = [mockHook.properties[0]]; // title only
    const user = userEvent.setup();
    const createdView = { id: "v11", data_source_id: "ds-1", user_id: "user-1", name: "", icon: null, type: "board", config: {}, filter: null, sorts: [], is_locked: false, position: 1 };
    mockHook.createView.mockResolvedValue(createdView);

    render(<DatabaseShell databaseId="db-1" />);

    await user.click(screen.getByRole("button", { name: "Add a new view" }));
    const dialog = screen.getByRole("dialog", { name: "Add a new view" });
    await user.click(within(dialog).getByRole("button", { name: "Board" }));

    expect(mockHook.createView).toHaveBeenCalledWith("", "board");
    expect(mockHook.updateView).not.toHaveBeenCalled();
    expect(mockHook.setActiveViewId).toHaveBeenCalledWith("v11");
  });

  // view-tab-bar.md: "opens the view settings sidebar for configuring
  // afterward" — DatabaseShell.handleCreateView's own last step.
  it("creating a Board view opens the view settings sidebar afterward", async () => {
    const user = userEvent.setup();
    const createdView = { id: "v12", data_source_id: "ds-1", user_id: "user-1", name: "", icon: null, type: "board", config: {}, filter: null, sorts: [], is_locked: false, position: 1 };
    mockHook.createView.mockResolvedValue(createdView);
    mockHook.updateView.mockResolvedValue({ ...createdView, config: { group_by: { property_key: "status", mode: "option" } } });

    render(<DatabaseShell databaseId="db-1" />);
    await user.click(screen.getByRole("button", { name: "Add a new view" }));
    await user.click(within(screen.getByRole("dialog", { name: "Add a new view" })).getByRole("button", { name: "Board" }));

    expect(await screen.findByText("Layout")).toBeInTheDocument();
  });

  // Live-found bug, fixed alongside this create-flow rewrite: Chart's own
  // follow-up step (ViewTabs.tsx's `handleCreateChart`) used to close its
  // popover only AFTER awaiting `onCreateView`, one tick after this sidebar
  // had already opened — two Radix overlays alive at once, and the
  // popover's own dismissal silently closed the sidebar right back. Every
  // other type closed BEFORE creating and never hit this. Reproduced live
  // (2026-09-02): the sidebar opened for Board/Calendar but never for
  // Chart. Fixed by matching the same "close, then create" order.
  it("creating a Chart view ALSO opens the settings sidebar afterward — regression, this specifically broke once", async () => {
    const user = userEvent.setup();
    const createdView = { id: "v13", data_source_id: "ds-1", user_id: "user-1", name: "", icon: null, type: "chart", config: {}, filter: null, sorts: [], is_locked: false, position: 1 };
    mockHook.createView.mockResolvedValue(createdView);
    mockHook.updateView.mockResolvedValue({ ...createdView, config: { chart_type: "column", y_axis: { aggregator: "count" }, x_axis: { property_id: "status", mode: "option" }, hide_empty_groups: false } });

    render(<DatabaseShell databaseId="db-1" />);
    await user.click(screen.getByRole("button", { name: "Add a new view" }));
    let dialog = screen.getByRole("dialog", { name: "Add a new view" });
    await user.click(within(dialog).getByRole("button", { name: "Chart" }));
    dialog = screen.getByRole("dialog", { name: "Add a new view" });
    await user.selectOptions(within(dialog).getByLabelText(/x-axis property/i), "status");
    await user.click(within(dialog).getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText("Layout")).toBeInTheDocument();
  });

  it("threads dataSource.id and refetchRows down to TableView's Add row control (task-18)", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "row-2", properties: {} }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<DatabaseShell databaseId="db-1" />);
    await user.click(screen.getByRole("button", { name: "+ New" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/db/data-sources/ds-1/rows",
      expect.objectContaining({ method: "POST" })
    );
    // Regression: adding a row must refetch *rows*, not just database
    // metadata — `refetch` (=`load`) never re-runs the rows query, so
    // asserting it alone is a false-positive that let a real live-verified
    // bug ship (the new row never appeared, "No rows yet." stuck forever).
    await vi.waitFor(() => expect(mockHook.refetchRows).toHaveBeenCalled());
    expect(mockHook.refetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("renders the database settings menu button for an editable (ordinary) database", () => {
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.getByRole("button", { name: "Database settings" })).toBeInTheDocument();
  });

  it("hides the database settings menu entirely for the read-only All Notes source (not merely disabled)", () => {
    mockHook.dataSource = { ...(mockHook.dataSource as Record<string, unknown>), is_virtual: true };
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.queryByRole("button", { name: "Database settings" })).not.toBeInTheDocument();
    mockHook.dataSource = { ...(mockHook.dataSource as Record<string, unknown>), is_virtual: false };
  });

  // Live-checklist regression (view-tab-bar.md's own States table: "Read-only
  // source (is_virtual): ... Suppress the whole bar"): only the toolbar's
  // `trailing` was ever gated on `editable` -- the tab bar itself, and its
  // per-view menu (Rename/Edit view/Duplicate view), rendered anyway. Those
  // rows would PATCH/DELETE a view id that has no real `db_views` row behind
  // it (All Notes synthesizes a fixed `"all-notes-table"` id server-side).
  it("hides the whole view tab bar for the read-only All Notes source, not merely its toolbar", () => {
    mockHook.dataSource = { ...(mockHook.dataSource as Record<string, unknown>), is_virtual: true };
    render(<DatabaseShell databaseId="db-1" />);
    expect(screen.queryByRole("button", { name: /view options/i })).not.toBeInTheDocument();
    expect(screen.queryByText("+ New view")).not.toBeInTheDocument();
    mockHook.dataSource = { ...(mockHook.dataSource as Record<string, unknown>), is_virtual: false };
  });

  it("threads relationLinks/ensureRelationLinks/setRelationLinks and the active view's subtasks display mode down to TableView", async () => {
    mockHook.views = [
      {
        id: "v1",
        data_source_id: "ds-1",
        user_id: "user-1",
        name: "Table view",
        icon: null,
        type: "table",
        config: { subtasks: { display_mode: "flattened" } },
        filter: null,
        sorts: [],
        is_locked: false,
        position: 0,
      },
    ];
    mockHook.properties = [
      ...mockHook.properties,
      {
        id: "p-sub",
        data_source_id: "ds-1",
        user_id: "user-1",
        key: "subitem",
        name: "Sub-item",
        type: "relation",
        config: { relation_id: "rel-1", side: "forward", system: "sub_item", target_data_source_id: "ds-1" },
        description: null,
        storage: "jsonb",
        column_name: null,
        result_type: null,
        is_volatile: false,
        position: 2,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    mockHook.relationLinks = { "row-1:subitem": [] };

    render(<DatabaseShell databaseId="db-1" />);

    // A relation column renders via RelationCell, which calls
    // ensureRelationLinks on mount — proof the prop actually reached
    // TableView rather than being silently dropped along the way.
    expect(mockHook.ensureRelationLinks).toHaveBeenCalledWith("row-1", "subitem");
  });
});
