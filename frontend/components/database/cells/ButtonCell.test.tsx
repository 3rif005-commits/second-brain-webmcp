// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { ButtonCell } from "./ButtonCell";
import { renderCellValue } from "./renderCellValue";
import type { PropertyResponse } from "@/lib/database/types";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const property: PropertyResponse = {
  id: "prop-1",
  data_source_id: "ds-1",
  user_id: "u1",
  key: "btn",
  name: "Run it",
  type: "button",
  config: {},
  description: null,
  storage: "jsonb",
  column_name: null,
  result_type: null,
  is_volatile: false,
  position: 0,
  created_at: "2024-01-01T00:00:00Z",
};

describe("ButtonCell", () => {
  beforeEach(() => {
    push.mockClear();
    showToast.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the property click endpoint with confirmed: false on click", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ actions_run: 1, requires_confirmation: false, confirmation_message: null, client_actions: [] })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ButtonCell property={property} noteId="note-1" editable={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/db/data-sources/ds-1/rows/note-1/buttons/btn/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: false }),
    });
  });

  it("shows a ConfirmDialog on requires_confirmation and re-POSTs with confirmed: true on confirm", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ actions_run: 0, requires_confirmation: true, confirmation_message: "Sure?", client_actions: [] })
      )
      .mockResolvedValueOnce(
        jsonResponse({ actions_run: 1, requires_confirmation: false, confirmation_message: null, client_actions: [] })
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<ButtonCell property={property} noteId="note-1" editable={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));

    await vi.waitFor(() => expect(screen.getByText("Sure?")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondCallInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(secondCallInit.body as string)).toEqual({ confirmed: true });
  });

  it("cancelling the confirmation dialog does not re-POST", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ actions_run: 0, requires_confirmation: true, confirmation_message: "Sure?", client_actions: [] })
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<ButtonCell property={property} noteId="note-1" editable={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));
    await vi.waitFor(() => expect(screen.getByText("Sure?")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Sure?")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens a new tab for an 'open' client action with kind url", async () => {
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        actions_run: 1,
        requires_confirmation: false,
        confirmation_message: null,
        client_actions: [{ type: "open", kind: "url", url: "https://example.com" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ButtonCell property={property} noteId="note-1" editable={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));

    await vi.waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith("https://example.com", "_blank", "noopener,noreferrer")
    );
  });

  it("navigates via router.push for an 'open' client action with kind note", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        actions_run: 1,
        requires_confirmation: false,
        confirmation_message: null,
        client_actions: [{ type: "open", kind: "note", note_id: "note-42" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ButtonCell property={property} noteId="note-1" editable={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));

    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/brain/workspace/note-42"));
  });

  it("toasts on a failed click, never throws to a native dialog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ detail: "boom" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    render(<ButtonCell property={property} noteId="note-1" editable={true} />);
    fireEvent.click(screen.getByRole("button", { name: "Run it" }));

    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith("boom", "error"));
  });

  it("disables the button when not editable", () => {
    render(<ButtonCell property={property} noteId="note-1" editable={false} />);
    expect(screen.getByRole("button", { name: "Run it" })).toBeDisabled();
  });
});

describe("renderCellValue button dispatch", () => {
  it("renders ButtonCell when a button handler is provided", () => {
    render(<>{renderCellValue(property, undefined, true, () => {}, undefined, { noteId: "note-9" })}</>);
    expect(screen.getByRole("button", { name: "Run it" })).toBeInTheDocument();
  });

  it("falls back to GenericCell (no button, no crash) when no button handler is provided", () => {
    render(<>{renderCellValue(property, undefined, true, () => {})}</>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
