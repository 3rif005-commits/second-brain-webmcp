// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PublicFormClient } from "./PublicFormClient";
import type { PropertyResponse } from "@/lib/database/types";
import type { FormViewConfig } from "@/lib/forms/types";

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

const TITLE_PROP = prop({ key: "ttl00001", name: "Full name", type: "title" });
const NOTES_PROP = prop({ key: "txt00001", name: "Notes", type: "rich_text" });

function configWith(overrides: Partial<FormViewConfig> = {}): FormViewConfig {
  return {
    is_form_closed: false,
    submission_permissions: "none",
    questions: [
      { property_key: "ttl00001", required: true },
      { property_key: "txt00001", required: false },
    ],
    submit_screen: {
      button_text: "Send it",
      button_color: "#4f46e5",
      confirmation_title: "Thanks!",
      confirmation_body: "We got your response.",
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PublicFormClient", () => {
  it("renders one input per config.questions[] entry, in order, with required marked", () => {
    render(
      <PublicFormClient
        viewId="view-1"
        config={configWith()}
        questionProperties={[TITLE_PROP, NOTES_PROP]}
      />
    );

    const labels = screen.getAllByText(/Full name|Notes/);
    expect(labels[0]).toHaveTextContent("Full name");
    expect(labels[1]).toHaveTextContent("Notes");
    // Required marker on the title question, not on the optional notes one.
    expect(screen.getByText(/Full name/).textContent).toContain("*");
    expect(screen.getByText(/^Notes$/).textContent).not.toContain("*");
  });

  it("blocks submit client-side when a required question is empty, without calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const user = userEvent.setup();
    render(
      <PublicFormClient
        viewId="view-1"
        config={configWith()}
        questionProperties={[TITLE_PROP, NOTES_PROP]}
      />
    );

    await user.click(screen.getByRole("button", { name: "Send it" }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/required/i);
  });

  it("happy path: fills the form, submits, and shows the confirmation screen in place (no navigation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "row-1" }), { status: 201, headers: { "Content-Type": "application/json" } })
      )
    );
    const user = userEvent.setup();
    render(
      <PublicFormClient
        viewId="view-1"
        config={configWith()}
        questionProperties={[TITLE_PROP, NOTES_PROP]}
      />
    );

    await user.type(screen.getByLabelText(/Full name/), "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Send it" }));

    await waitFor(() => {
      expect(screen.getByText("Thanks!")).toBeInTheDocument();
    });
    expect(screen.getByText("We got your response.")).toBeInTheDocument();
    // The form itself is gone — replaced in place, not navigated away from.
    expect(screen.queryByRole("button", { name: "Send it" })).not.toBeInTheDocument();

    expect(fetch).toHaveBeenCalledWith(
      "/api/forms/view-1/submit",
      expect.objectContaining({ method: "POST" })
    );
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.properties.ttl00001).toEqual({ type: "title", title: "Ada Lovelace" });
  });

  it("rejected submission renders an inline error, never a native alert/confirm/prompt", async () => {
    const alertSpy = vi.spyOn(window, "alert");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Too many submissions — please try again later" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    const user = userEvent.setup();
    render(
      <PublicFormClient
        viewId="view-1"
        config={configWith()}
        questionProperties={[TITLE_PROP, NOTES_PROP]}
      />
    );

    await user.type(screen.getAllByRole("textbox")[0], "Ada Lovelace");
    await user.click(screen.getByRole("button", { name: "Send it" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/too many submissions/i);
    });
    // The form stays visible so the caller can retry — this is not a
    // navigate-away or a native browser alert.
    expect(screen.getByRole("button", { name: "Send it" })).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
