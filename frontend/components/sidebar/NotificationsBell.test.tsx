import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { NotificationsBell, NOTIFICATIONS_POLL_MS } from "./NotificationsBell";
import type { NotificationResponse } from "@/lib/database/types";

function notification(overrides: Partial<NotificationResponse>): NotificationResponse {
  return {
    id: "n1",
    user_id: "user-1",
    message: "Status changed to Done",
    link: null,
    source: "automation:a1",
    read_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  showToast.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("NotificationsBell", () => {
  it("renders the unread count from a mocked GET /db/notifications", async () => {
    const list = [notification({ id: "n1" }), notification({ id: "n2" }), notification({ id: "n3", read_at: "2026-01-01T00:00:00Z" })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(list)));

    render(<NotificationsBell />);

    expect(await screen.findByLabelText("2 unread notifications")).toBeInTheDocument();
  });

  it("renders no badge when there are no unread notifications", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([])));
    render(<NotificationsBell />);

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });

  it("marking one read PATCHes it (no request body) and decrements the unread count", async () => {
    const user = userEvent.setup();
    const list = [notification({ id: "n1", message: "First" })];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/notifications") return Promise.resolve(jsonResponse(list));
      if (url === "/api/db/notifications/n1" && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ ...list[0], read_at: "2026-01-01T00:00:00Z" }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NotificationsBell />);
    await screen.findByLabelText("1 unread notifications");

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Mark read" }));

    await waitFor(() => expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/db/notifications/n1", { method: "PATCH" });
  });

  it("reverts the optimistic mark-read and toasts on a failed PATCH", async () => {
    const user = userEvent.setup();
    const list = [notification({ id: "n1" })];
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/db/notifications") return Promise.resolve(jsonResponse(list));
      if (url === "/api/db/notifications/n1" && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ detail: "not found" }, 404));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NotificationsBell />);
    await screen.findByLabelText("1 unread notifications");
    await user.click(screen.getByRole("button", { name: "Notifications" }));
    await user.click(screen.getByRole("button", { name: "Mark read" }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("not found", "error"));
    expect(await screen.findByLabelText("1 unread notifications")).toBeInTheDocument();
  });

  it("polls GET /db/notifications on an interval while mounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    render(<NotificationsBell />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(NOTIFICATIONS_POLL_MS);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(NOTIFICATIONS_POLL_MS);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("clicking a notification's link is a real <a href>, not a dead control — and Slack/email affordances never appear here", async () => {
    const user = userEvent.setup();
    const list = [notification({ id: "n1", message: "Row updated", link: "/brain/db/db-1" })];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(list)));

    render(<NotificationsBell />);
    await screen.findByLabelText("1 unread notifications");
    await user.click(screen.getByRole("button", { name: "Notifications" }));

    const link = screen.getByRole("link", { name: "Open" });
    expect(link).toHaveAttribute("href", "/brain/db/db-1");
    expect(screen.queryByText(/slack/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
  });
});
