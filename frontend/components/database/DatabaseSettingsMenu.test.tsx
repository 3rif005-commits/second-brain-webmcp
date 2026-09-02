import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { DatabaseSettingsMenu } from "./DatabaseSettingsMenu";
import type { PropertyResponse, ViewResponse } from "@/lib/database/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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
const DUE_DATE_PROP = prop({ key: "due", name: "Due date", type: "date", position: 1 });

const VIEW: ViewResponse = {
  id: "v1",
  data_source_id: "ds-1",
  user_id: "user-1",
  name: "Table view",
  icon: null,
  type: "table",
  config: {},
  filter: null,
  sorts: [],
  is_locked: false,
  position: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  showToast.mockClear();
});

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Database settings" }));
}

describe("DatabaseSettingsMenu", () => {
  it("Sub-items: shows a 'Turn on' button when not yet enabled, POSTs to the sub-items endpoint", async () => {
    const user = userEvent.setup();
    const onPropertiesChanged = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ forward: {}, reverse: {} }, 201));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DatabaseSettingsMenu
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        activeView={VIEW}
        onPropertiesChanged={onPropertiesChanged}
        onUpdateView={vi.fn()}
        templates={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
      />
    );
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Turn on sub-items" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/db/data-sources/ds-1/sub-items", { method: "POST" });
    await waitFor(() => expect(onPropertiesChanged).toHaveBeenCalled());
  });

  it("Sub-items: once enabled, offers the display-mode picker and PATCHes the view's config on change", async () => {
    const user = userEvent.setup();
    const onUpdateView = vi.fn().mockResolvedValue(VIEW);
    const subItemForward = prop({
      key: "subitem",
      name: "Sub-item",
      type: "relation",
      config: { relation_id: "rel-1", side: "forward", system: "sub_item", target_data_source_id: "ds-1" },
    });

    render(
      <DatabaseSettingsMenu
        dataSourceId="ds-1"
        properties={[TITLE_PROP, subItemForward]}
        activeView={VIEW}
        onPropertiesChanged={vi.fn()}
        onUpdateView={onUpdateView}
        templates={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
      />
    );
    await openMenu(user);
    expect(screen.queryByRole("button", { name: "Turn on sub-items" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Sub-item display mode"), "flattened");

    expect(onUpdateView).toHaveBeenCalledWith("v1", { config: { subtasks: { display_mode: "flattened" } } });
  });

  it("Dependencies: shows a 'Turn on' button when not yet enabled, POSTs to the dependencies endpoint", async () => {
    const user = userEvent.setup();
    const onPropertiesChanged = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ forward: {}, reverse: {} }, 201));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DatabaseSettingsMenu
        dataSourceId="ds-1"
        properties={[TITLE_PROP]}
        activeView={VIEW}
        onPropertiesChanged={onPropertiesChanged}
        onUpdateView={vi.fn()}
        templates={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
      />
    );
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Turn on dependencies" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/db/data-sources/ds-1/dependencies", { method: "POST" });
    await waitFor(() => expect(onPropertiesChanged).toHaveBeenCalled());
  });

  describe("Dependencies, once enabled", () => {
    const dependencyForward = prop({
      key: "blocking",
      name: "Blocking",
      type: "relation",
      config: { relation_id: "rel-2", side: "forward", system: "dependency", target_data_source_id: "ds-1" },
    });

    it("shows all three date-shift-mode strings verbatim (task-22-brief.md §4's exact Notion names)", async () => {
      const user = userEvent.setup();
      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP, DUE_DATE_PROP, dependencyForward]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
        templates={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);

      expect(screen.getByText("Shift only when dates overlap")).toBeInTheDocument();
      expect(screen.getByText("Shift & maintain time between items")).toBeInTheDocument();
      expect(screen.getByText("Do not automatically shift")).toBeInTheDocument();
      expect(screen.getByLabelText("Avoid weekends")).toBeInTheDocument();
    });

    it("selecting a date-shift mode PATCHes .../dependency-settings with the exact string", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "p", config: {} }));
      vi.stubGlobal("fetch", fetchMock);

      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP, DUE_DATE_PROP, dependencyForward]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
        templates={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      await user.click(screen.getByLabelText("Shift & maintain time between items"));

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/db/relations/rel-2/dependency-settings",
        expect.objectContaining({ method: "PATCH" })
      );
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({
        date_shift_mode: "Shift & maintain time between items",
      });
    });

    it("toggling 'Avoid weekends' PATCHes avoid_weekends", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "p", config: {} }));
      vi.stubGlobal("fetch", fetchMock);

      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP, DUE_DATE_PROP, dependencyForward]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
        templates={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      await user.click(screen.getByLabelText("Avoid weekends"));

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({ avoid_weekends: true });
    });

    it("picking a date property PATCHes date_property_key", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "p", config: {} }));
      vi.stubGlobal("fetch", fetchMock);

      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP, DUE_DATE_PROP, dependencyForward]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
        templates={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      await user.selectOptions(screen.getByLabelText("Dependency date property"), "due");

      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(init.body as string)).toEqual({ date_property_key: "due" });
    });

    it("shows a one-line hint that dependency arrows are timeline-only (task-34: Timeline view now exists)", async () => {
      const user = userEvent.setup();
      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP, DUE_DATE_PROP, dependencyForward]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
        templates={[]}
        onCreateTemplate={vi.fn()}
        onUpdateTemplate={vi.fn()}
        onDeleteTemplate={vi.fn()}
        automations={[]}
        onCreateAutomation={vi.fn()}
        onUpdateAutomation={vi.fn()}
        onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      expect(screen.getByText(/dependency arrows only appear in the timeline view/i)).toBeInTheDocument();
      // The old "isn't available yet" caveat must be gone now that Timeline
      // is real (task-34-brief.md's whole reason for existing).
      expect(screen.queryByText(/isn.t available yet/i)).not.toBeInTheDocument();
    });
  });

  describe("Export (task-48)", () => {
    function stubDownloadGlobals() {
      const createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
      const revokeObjectURL = vi.fn();
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      // jsdom doesn't implement navigation -- clicking a real `<a href="blob:...">`
      // would otherwise log a "Not implemented" error. Follows BlockEditor.tsx's
      // exact Blob/createObjectURL/`<a download>` mechanism (task-48-brief.md), so
      // this stubs only the one browser API jsdom can't do, not the mechanism itself.
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      return { createObjectURL, revokeObjectURL, clickSpy };
    }

    it("fetches the export endpoint and triggers a Blob download via createObjectURL/<a>, then revokes the URL", async () => {
      const user = userEvent.setup();
      const csvBody = "id,Title\nabc,Dune\n";
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(csvBody, { status: 200, headers: { "Content-Type": "text/csv" } })
      );
      vi.stubGlobal("fetch", fetchMock);
      const { createObjectURL, revokeObjectURL, clickSpy } = stubDownloadGlobals();
      const appendSpy = vi.spyOn(document.body, "appendChild");

      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
          templates={[]}
          onCreateTemplate={vi.fn()}
          onUpdateTemplate={vi.fn()}
          onDeleteTemplate={vi.fn()}
          automations={[]}
          onCreateAutomation={vi.fn()}
          onUpdateAutomation={vi.fn()}
          onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      await user.click(screen.getByRole("button", { name: "Export CSV" }));

      expect(fetchMock).toHaveBeenCalledWith("/api/db/data-sources/ds-1/export?view_id=v1");
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      // Not `toBeInstanceOf(Blob)`: Response.blob() (Node's undici Response) and
      // this test file's global `Blob` are different realms/classes in this
      // Vitest/jsdom setup, so a real cross-realm Blob fails a strict instanceof
      // check despite being a genuine Blob -- duck-type instead.
      const blobArg = createObjectURL.mock.calls[0][0];
      expect(blobArg.constructor.name).toBe("Blob");
      expect(blobArg.size).toBe(csvBody.length);

      const anchor = appendSpy.mock.calls
        .map(([node]) => node)
        .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
      expect(anchor).toBeDefined();
      expect(anchor?.download).toBe("table_view.csv");
      expect(anchor?.href).toBe("blob:mock-url");
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
      clickSpy.mockRestore();
    });

    it("task-51 Fix 5: warns via toast (in addition to still downloading) when the response carries X-Export-Truncated", async () => {
      const user = userEvent.setup();
      const csvBody = "id,Title\nabc,Dune\n";
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(csvBody, {
          status: 200,
          headers: { "Content-Type": "text/csv", "X-Export-Truncated": "true" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      const { createObjectURL, clickSpy } = stubDownloadGlobals();

      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
          templates={[]}
          onCreateTemplate={vi.fn()}
          onUpdateTemplate={vi.fn()}
          onDeleteTemplate={vi.fn()}
          automations={[]}
          onCreateAutomation={vi.fn()}
          onUpdateAutomation={vi.fn()}
          onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      await user.click(screen.getByRole("button", { name: "Export CSV" }));

      await waitFor(() => expect(showToast).toHaveBeenCalled());
      expect(showToast.mock.calls[0][0]).toMatch(/500 rows/i);
      // Still triggers the download -- a truncated-but-present export is still useful.
      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      expect(clickSpy).toHaveBeenCalledTimes(1);
      clickSpy.mockRestore();
    });

    it("does not warn when the response has no X-Export-Truncated header", async () => {
      const user = userEvent.setup();
      const csvBody = "id,Title\nabc,Dune\n";
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(csvBody, { status: 200, headers: { "Content-Type": "text/csv" } })
      );
      vi.stubGlobal("fetch", fetchMock);
      const { createObjectURL, clickSpy } = stubDownloadGlobals();

      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
          templates={[]}
          onCreateTemplate={vi.fn()}
          onUpdateTemplate={vi.fn()}
          onDeleteTemplate={vi.fn()}
          automations={[]}
          onCreateAutomation={vi.fn()}
          onUpdateAutomation={vi.fn()}
          onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      await user.click(screen.getByRole("button", { name: "Export CSV" }));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      expect(showToast).not.toHaveBeenCalled();
      clickSpy.mockRestore();
    });

    it("a failed fetch toasts and does NOT create a stray anchor/download", async () => {
      const user = userEvent.setup();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "view not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);
      const { createObjectURL, clickSpy } = stubDownloadGlobals();

      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
          templates={[]}
          onCreateTemplate={vi.fn()}
          onUpdateTemplate={vi.fn()}
          onDeleteTemplate={vi.fn()}
          automations={[]}
          onCreateAutomation={vi.fn()}
          onUpdateAutomation={vi.fn()}
          onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      await user.click(screen.getByRole("button", { name: "Export CSV" }));

      await waitFor(() => expect(showToast).toHaveBeenCalledWith("view not found", "error"));
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(clickSpy).not.toHaveBeenCalled();
      clickSpy.mockRestore();
    });

    it("disables the Export CSV button when there is no active view", async () => {
      const user = userEvent.setup();
      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP]}
          activeView={null}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
          templates={[]}
          onCreateTemplate={vi.fn()}
          onUpdateTemplate={vi.fn()}
          onDeleteTemplate={vi.fn()}
          automations={[]}
          onCreateAutomation={vi.fn()}
          onUpdateAutomation={vi.fn()}
          onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    });
  });

  describe("Templates (task-40)", () => {
    it("shows a 'Manage templates' button that opens TemplateManager, and closes the settings dropdown", async () => {
      const user = userEvent.setup();
      render(
        <DatabaseSettingsMenu
          dataSourceId="ds-1"
          properties={[TITLE_PROP]}
          activeView={VIEW}
          onPropertiesChanged={vi.fn()}
          onUpdateView={vi.fn()}
          templates={[]}
          onCreateTemplate={vi.fn()}
          onUpdateTemplate={vi.fn()}
          onDeleteTemplate={vi.fn()}
          automations={[]}
          onCreateAutomation={vi.fn()}
          onUpdateAutomation={vi.fn()}
          onDeleteAutomation={vi.fn()}
        />
      );
      await openMenu(user);
      await user.click(screen.getByRole("button", { name: "Manage templates" }));

      expect(screen.getByRole("dialog", { name: "Templates" })).toBeInTheDocument();
      // The settings dropdown itself collapses once the modal takes over.
      expect(screen.queryByRole("button", { name: "Manage templates" })).not.toBeInTheDocument();
    });
  });
});
