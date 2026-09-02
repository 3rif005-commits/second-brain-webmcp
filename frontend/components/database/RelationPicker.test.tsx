import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const showToast = vi.fn();
vi.mock("@/app/providers", () => ({
  useToast: () => ({ showToast }),
}));

import { RelationPicker } from "./RelationPicker";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function targetRow(id: string, title: string) {
  return { id, properties: { title: { type: "title", title } } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("RelationPicker", () => {
  it("fetches the target data source's rows and lists them by title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ rows: [targetRow("r1", "Row One"), targetRow("r2", "Row Two")] }))
    );

    render(<RelationPicker targetDataSourceId="ds-2" selected={[]} onCommit={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Row One")).toBeInTheDocument());
    expect(screen.getByText("Row Two")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/db/data-sources/ds-2/rows");
  });

  it("pre-checks already-linked rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rows: [targetRow("r1", "Row One")] })));

    render(
      <RelationPicker
        targetDataSourceId="ds-2"
        selected={[{ id: "r1", title: "Row One" }]}
        onCommit={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByText("Row One")).toBeInTheDocument());
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it("filters the list client-side by the search query", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ rows: [targetRow("r1", "Apple"), targetRow("r2", "Banana")] }))
    );

    render(<RelationPicker targetDataSourceId="ds-2" selected={[]} onCommit={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Apple")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Search rows"), "ban");

    expect(screen.queryByText("Apple")).not.toBeInTheDocument();
    expect(screen.getByText("Banana")).toBeInTheDocument();
  });

  it("multi-select: toggling rows updates the draft, committed only on Done", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ rows: [targetRow("r1", "Apple"), targetRow("r2", "Banana")] }))
    );

    render(<RelationPicker targetDataSourceId="ds-2" selected={[]} onCommit={onCommit} onCancel={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Apple")).toBeInTheDocument());

    const [appleCheckbox, bananaCheckbox] = screen.getAllByRole("checkbox");
    await user.click(appleCheckbox);
    await user.click(bananaCheckbox);
    expect(onCommit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(onCommit).toHaveBeenCalledWith([
      { id: "r1", title: "Apple" },
      { id: "r2", title: "Banana" },
    ]);
  });

  it("Cancel calls onCancel without committing", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rows: [] })));

    render(<RelationPicker targetDataSourceId="ds-2" selected={[]} onCommit={onCommit} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows a 'showing first N' note instead of silently truncating when the fetch hits the 500-row cap", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => targetRow(`r${i}`, `Row ${i}`));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rows })));

    render(<RelationPicker targetDataSourceId="ds-2" selected={[]} onCommit={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/showing first 500 rows/i)).toBeInTheDocument());
  });

  it("toasts an error rather than crashing when the fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ detail: "boom" }, 500)));

    render(<RelationPicker targetDataSourceId="ds-2" selected={[]} onCommit={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("boom", "error"));
  });
});
