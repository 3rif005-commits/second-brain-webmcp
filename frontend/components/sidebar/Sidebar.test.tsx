import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const navigateMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigateMock, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/brain",
}));

vi.mock("@/app/providers", () => ({
  useTheme: () => ({ resolvedTheme: "dark", setTheme: vi.fn() }),
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signOut: vi.fn() } }),
}));

vi.mock("@/lib/hooks/useNotes", () => ({
  useNotes: () => ({
    notes: [],
    loading: false,
    createNote: vi.fn(),
    deleteNote: vi.fn(),
    toggleFavorite: vi.fn(),
    reorderNotes: vi.fn(),
  }),
}));
vi.mock("@/lib/hooks/useCollections", () => ({
  useCollections: () => ({ collections: [], loading: false }),
}));
vi.mock("@/lib/hooks/useTrash", () => ({
  useTrash: () => ({ trashedNotes: [], restoreNote: vi.fn(), permanentDelete: vi.fn() }),
}));
vi.mock("./NoteTree", () => ({ NoteTree: () => <div /> }));

import { Sidebar } from "./Sidebar";

const LIST = {
  databases: [
    { database: { id: "db-1", title: "Tasks", icon: null } },
    { database: { id: "db-2", title: "Reading list", icon: "📚" } },
  ],
};

beforeEach(() => {
  navigateMock.mockClear();
  global.fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).includes("/api/db/databases")) {
      return { ok: true, json: async () => LIST } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => vi.restoreAllMocks());

describe("Sidebar — Databases section", () => {
  it("lists the user's databases from GET /db/databases", async () => {
    render(<Sidebar />);
    expect(await screen.findByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Reading list")).toBeInTheDocument();
    // The section header only renders when there is at least one database.
    expect(screen.getByText("Databases")).toBeInTheDocument();
  });

  it("navigates to a database's own page when one is clicked", async () => {
    const user = userEvent.setup();
    render(<Sidebar />);
    await user.click(await screen.findByText("Tasks"));
    expect(navigateMock).toHaveBeenCalledWith("/brain/db/db-1");
  });

  it("renders no Databases section at all when the user has none", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ databases: [] }),
    })) as unknown as typeof fetch;
    render(<Sidebar />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.queryByText("Databases")).not.toBeInTheDocument();
  });

  it("stays rendered when the databases request fails — a sidebar list is not worth breaking the sidebar", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    render(<Sidebar />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    // The rest of the nav is still there.
    expect(screen.getByText("All Notes")).toBeInTheDocument();
    expect(screen.queryByText("Databases")).not.toBeInTheDocument();
  });
});
