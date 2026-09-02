// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

const { rpc, notFound } = vi.hoisted(() => ({
  rpc: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ rpc })),
}));
vi.mock("next/navigation", () => ({ notFound }));

import FormPage from "./page";

function ctxFor(viewId: string) {
  return { params: Promise.resolve({ viewId }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FormPage (Server Component)", () => {
  it("calls notFound() for a missing/non-form view id", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await expect(FormPage(ctxFor("missing-view"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("calls notFound() when the RPC itself errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(FormPage(ctxFor("view-1"))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("renders the closed-form state, never the form itself", async () => {
    rpc.mockResolvedValue({
      data: {
        name: "Feedback",
        config: { is_form_closed: true, submission_permissions: "none", questions: [], submit_screen: {} },
        questions: [],
      },
      error: null,
    });

    const element = await FormPage(ctxFor("view-1"));
    render(element);

    expect(screen.getByText("This form is not accepting responses.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders the form (via PublicFormClient) for an open form", async () => {
    rpc.mockResolvedValue({
      data: {
        name: "Feedback",
        config: {
          is_form_closed: false,
          submission_permissions: "none",
          questions: [{ property_key: "ttl00001", required: true }],
          submit_screen: {
            button_text: "Send",
            button_color: "#4f46e5",
            confirmation_title: "Thanks!",
            confirmation_body: "",
          },
        },
        questions: [{ property_key: "ttl00001", required: true, name: "Full name", type: "title" }],
      },
      error: null,
    });

    const element = await FormPage(ctxFor("view-1"));
    render(element);

    expect(screen.getByText("Feedback")).toBeInTheDocument();
    expect(screen.getByLabelText(/Full name/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});
