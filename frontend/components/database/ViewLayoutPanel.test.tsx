import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ViewLayoutPanel } from "./ViewLayoutPanel";

describe("ViewLayoutPanel", () => {
  it("renders a 3x3 grid of view-type cards with the current type selected", () => {
    render(<ViewLayoutPanel viewType="table" config={{}} onPatchConfig={vi.fn()} />);

    const cards = screen.getAllByRole("button", { name: /Table|Board|Timeline|Calendar|List|Gallery|Chart|Feed|Dashboard/ });
    expect(cards).toHaveLength(9);

    const tableCard = screen.getByRole("button", { name: "Table" });
    expect(tableCard).toBeEnabled();
    const boardCard = screen.getByRole("button", { name: "Board" });
    expect(boardCard).toBeDisabled();
  });

  it("renders the three display toggles reflecting config, defaulting to on", () => {
    render(<ViewLayoutPanel viewType="table" config={{}} onPatchConfig={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Show vertical lines" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Show page icon" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Wrap all content" })).toHaveAttribute("aria-checked", "true");
  });

  it("toggling 'Show vertical lines' off patches show_vertical_lines: false", async () => {
    const user = userEvent.setup();
    const onPatchConfig = vi.fn();
    render(<ViewLayoutPanel viewType="table" config={{}} onPatchConfig={onPatchConfig} />);

    await user.click(screen.getByRole("switch", { name: "Show vertical lines" }));
    expect(onPatchConfig).toHaveBeenCalledWith({ show_vertical_lines: false });
  });

  it("Open pages in shows the current mode and opens a popover with all three options", async () => {
    const user = userEvent.setup();
    render(<ViewLayoutPanel viewType="table" config={{}} onPatchConfig={vi.fn()} />);

    expect(screen.getByText("Side peek")).toBeInTheDocument();
    await user.click(screen.getByText("Open pages in"));

    expect(screen.getByRole("option", { name: /Side peek/ })).toBeInTheDocument();
    expect(screen.getByText("Center peek")).toBeInTheDocument();
    expect(screen.getByText("Full page")).toBeInTheDocument();
    expect(screen.getByText("Default for Table")).toBeInTheDocument();
  });

  it("selecting a mode patches open_pages_in and closes the popover", async () => {
    const user = userEvent.setup();
    const onPatchConfig = vi.fn();
    render(<ViewLayoutPanel viewType="table" config={{}} onPatchConfig={onPatchConfig} />);

    await user.click(screen.getByText("Open pages in"));
    await user.click(screen.getByText("Center peek"));

    expect(onPatchConfig).toHaveBeenCalledWith({ open_pages_in: "center" });
    expect(screen.queryByText("Full page")).not.toBeInTheDocument();
  });
});
