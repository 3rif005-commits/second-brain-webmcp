import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const navigateMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigateMock, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/brain",
}));

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { CsvImportButton } from "./CsvImportButton";

const CSV_FILE = new File(["Name,Value\nA,1\n"], "contacts.csv", { type: "text/csv" });

const SUCCESS_RESPONSE = {
  database_id: "db-123",
  row_count: 1,
  columns: [
    { header: "Name", inferred_type: "title", non_empty_count: 1, empty_count: 0 },
    { header: "Value", inferred_type: "number", non_empty_count: 1, empty_count: 0 },
  ],
};

beforeEach(() => {
  navigateMock.mockClear();
  showToast.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("CsvImportButton", () => {
  it("uploads the selected CSV as multipart/form-data to /api/db/import/csv", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => SUCCESS_RESPONSE,
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;

    const user = userEvent.setup();
    render(<CsvImportButton />);

    const input = screen.getByLabelText("Import CSV") as HTMLInputElement;
    await user.upload(input, CSV_FILE);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = (fetchMock as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/db/import/csv");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBe(CSV_FILE);
    expect((init.body as FormData).get("database_title")).toBe("contacts");
  });

  it("shows the per-column inference report and routes to the new database on confirm", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => SUCCESS_RESPONSE,
    })) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<CsvImportButton />);

    await user.upload(screen.getByLabelText("Import CSV"), CSV_FILE);

    // The per-column report renders as a simple list, not a native dialog.
    expect(await screen.findByText("Imported 1 row")).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Value")).toBeInTheDocument();
    expect(screen.getByText(/title/)).toBeInTheDocument();
    expect(screen.getByText(/number/)).toBeInTheDocument();

    await user.click(screen.getByText("Open database"));
    expect(navigateMock).toHaveBeenCalledWith("/brain/db/db-123");
  });

  it("calls onImported after a successful import", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => SUCCESS_RESPONSE,
    })) as unknown as typeof fetch;
    const onImported = vi.fn();

    const user = userEvent.setup();
    render(<CsvImportButton onImported={onImported} />);
    await user.upload(screen.getByLabelText("Import CSV"), CSV_FILE);

    await waitFor(() => expect(onImported).toHaveBeenCalled());
  });

  it("shows an error toast on failure and never navigates", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ detail: "CSV file is not valid UTF-8" }),
    })) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<CsvImportButton />);
    await user.upload(screen.getByLabelText("Import CSV"), CSV_FILE);

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("CSV file is not valid UTF-8", "error")
    );
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Imported/)).not.toBeInTheDocument();
  });

  it("shows a generic error toast when the response body has no detail/error", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<CsvImportButton />);
    await user.upload(screen.getByLabelText("Import CSV"), CSV_FILE);

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith("Request failed (500)", "error")
    );
  });
});
