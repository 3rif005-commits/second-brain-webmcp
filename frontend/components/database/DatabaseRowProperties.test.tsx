import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { DatabaseRowProperties } from "./DatabaseRowProperties";
import type { PropertyResponse } from "@/lib/database/types";

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

const ROW_INFO = {
  data_source_id: "ds-1",
  database_id: "db-1",
  database_title: "Tasks",
  properties: [
    prop({ key: "title", name: "Title", type: "title", position: 0 }),
    prop({ key: "kind", name: "Kind", type: "select", position: 1 }),
    prop({ key: "done", name: "Done", type: "checkbox", position: 2 }),
  ],
  values: {
    title: { type: "title", title: "Write the report" },
    kind: { type: "select", select: "article" },
    done: { type: "checkbox", checkbox: false },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("DatabaseRowProperties", () => {
  it("renders nothing for an ordinary, non-database note (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "not found" }, 404)));

    const { container } = render(<DatabaseRowProperties noteId="note-1" />);

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it("renders the database link and every non-title property for a real database row", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(ROW_INFO)));

    render(<DatabaseRowProperties noteId="row-1" />);

    expect(await screen.findByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/brain/db/db-1");
    expect(screen.getByText("Kind")).toBeInTheDocument();
    expect(screen.getByText("article")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    // The title property is deliberately not duplicated here (NoteEditorPage
    // already has its own title input).
    expect(screen.queryByText("Write the report")).not.toBeInTheDocument();
  });

  it("editing a property PATCHes the row endpoint with the property key and new value", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/db/notes/row-1/row") return Promise.resolve(jsonResponse(ROW_INFO));
      return Promise.resolve(jsonResponse({ id: "row-1", properties: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DatabaseRowProperties noteId="row-1" />);
    const checkbox = await screen.findByRole("checkbox");
    await user.click(checkbox);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/db/data-sources/ds-1/rows/row-1",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ property_key: "done", value: { type: "checkbox", checkbox: true } }),
        })
      );
    });
  });

  it("rolls back the optimistic update and toasts on a failed write", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/db/notes/row-1/row") return Promise.resolve(jsonResponse(ROW_INFO));
      if (init?.method === "PATCH") return Promise.resolve(jsonResponse({ detail: "boom" }, 500));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<DatabaseRowProperties noteId="row-1" />);
    const checkbox = (await screen.findByRole("checkbox")) as HTMLInputElement;
    await user.click(checkbox);

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith("boom", "error");
    });
    await waitFor(() => {
      expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    });
  });
});
