// Phase 0 requires keyboard + dismissal coverage, because that is exactly what
// the later visual diff CANNOT check: a screenshot cannot tell you whether
// arrow keys move an active row.
//
// The arrow-navigation tests are asserting a DELIBERATE DEVIATION from Notion.
// Notion's column header menu has no arrow navigation at all (verified with
// real key events, docs/ui-specs/table-column-header.md). We add it because a
// 14-row menu that cannot be driven from the keyboard is a regression against
// the native <select> elements this work replaces. If someone later "fixes"
// MenuList to match Notion, these tests should fail loudly.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MenuList } from "./MenuList";
import type { MenuPanel } from "./types";

function basicPanel(overrides: Partial<MenuPanel> = {}): MenuPanel {
  return {
    sections: [
      {
        rows: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Bravo" },
          { id: "c", label: "Charlie" },
        ],
      },
    ],
    ...overrides,
  };
}

function activeLabel(): string | null {
  const el = document.querySelector('[role="option"][aria-selected="true"]');
  return el ? (el.textContent ?? "").trim() : null;
}

describe("MenuList keyboard", () => {
  it("moves the active row with ArrowDown/ArrowUp and wraps", async () => {
    const user = userEvent.setup();
    render(<MenuList root={basicPanel()} onClose={vi.fn()} />);

    const list = screen.getByRole("listbox");
    list.focus();
    expect(activeLabel()).toBe("Alpha");

    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Bravo");

    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Charlie");

    // wraps back to the first
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Alpha");

    await user.keyboard("{ArrowUp}");
    expect(activeLabel()).toBe("Charlie");
  });

  it("skips disabled rows when moving, but still renders them", async () => {
    const user = userEvent.setup();
    const panel = basicPanel({
      sections: [
        {
          rows: [
            { id: "a", label: "Alpha" },
            { id: "b", label: "Bravo", disabled: true, disabledReason: "not allowed here" },
            { id: "c", label: "Charlie" },
          ],
        },
      ],
    });
    render(<MenuList root={panel} onClose={vi.fn()} />);
    screen.getByRole("listbox").focus();

    // Disabled rows are SEMANTIC (an illegal type conversion), so they must be
    // visible and announced, not omitted.
    expect(screen.getByText("Bravo")).toBeInTheDocument();
    expect(screen.getByText("Bravo").closest('[role="option"]')).toHaveAttribute(
      "aria-disabled",
      "true"
    );

    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Charlie");
  });

  it("moves by column count in a 2-column grid, and Left/Right move by one", async () => {
    const user = userEvent.setup();
    const panel: MenuPanel = {
      columns: 2,
      sections: [
        {
          rows: [
            { id: "1", label: "One" },
            { id: "2", label: "Two" },
            { id: "3", label: "Three" },
            { id: "4", label: "Four" },
          ],
        },
      ],
    };
    render(<MenuList root={panel} onClose={vi.fn()} />);
    screen.getByRole("listbox").focus();

    expect(activeLabel()).toBe("One");
    await user.keyboard("{ArrowDown}"); // +2 in a 2-col grid
    expect(activeLabel()).toBe("Three");
    await user.keyboard("{ArrowRight}"); // +1
    expect(activeLabel()).toBe("Four");
    await user.keyboard("{ArrowLeft}"); // -1
    expect(activeLabel()).toBe("Three");
  });

  it("Enter activates the active row and closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const panel = basicPanel({
      sections: [{ rows: [{ id: "a", label: "Alpha", onSelect }] }],
    });
    render(<MenuList root={panel} onClose={onClose} />);
    screen.getByRole("listbox").focus();

    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a toggle row activates without closing — several get flipped in a row", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const panel = basicPanel({
      sections: [{ rows: [{ id: "t", label: "Wrap all content", kind: "toggle", onSelect }] }],
    });
    render(<MenuList root={panel} onClose={onClose} />);
    screen.getByRole("listbox").focus();

    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape closes at the root", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MenuList root={basicPanel()} onClose={onClose} />);
    screen.getByRole("listbox").focus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MenuList root={basicPanel()} onClose={onClose} />);
    screen.getByRole("listbox").focus();

    await user.keyboard("{Tab}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MenuList push navigation (the config sidebar's model)", () => {
  const panel: MenuPanel = {
    title: "Group",
    sections: [
      {
        rows: [
          {
            id: "by",
            label: "Group by",
            submenu: () => ({
              title: "Group by",
              sections: [{ rows: [{ id: "sel", label: "Select" }] }],
            }),
          },
        ],
      },
    ],
  };

  it("pushes a sub-panel and shows a back affordance", async () => {
    const user = userEvent.setup();
    render(<MenuList root={panel} nav="push" onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    await user.click(screen.getByText("Group by"));

    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.getByText("Select")).toBeInTheDocument();
  });

  it("Escape pops one level before closing", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<MenuList root={panel} nav="push" onClose={onClose} />);

    await user.click(screen.getByText("Group by"));
    screen.getByRole("listbox").focus();

    await user.keyboard("{Escape}");
    // popped, not closed
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Live-discovered running M3's checklist: dragging a row inside the pushed
  // "Property visibility" panel wrote the new order (the table re-rendered
  // correctly), but the PANEL ITSELF kept showing the pre-drag order until
  // popped and pushed again — `stack` held a MenuPanel snapshotted at push
  // time, and a parent re-render with fresh data never touched it. Root
  // panel is exempt from that (it always reads the live `root` prop); this
  // is the same guarantee extended to every pushed level.
  it("a pushed panel re-derives from the live root — a host re-render is reflected without popping", async () => {
    const user = userEvent.setup();
    let order = ["Select", "Status"];
    const dynamicPanel: MenuPanel = {
      sections: [
        {
          rows: [
            {
              id: "by",
              label: "Group by",
              submenu: () => ({
                sections: [{ rows: order.map((label) => ({ id: label, label })) }],
              }),
            },
          ],
        },
      ],
    };

    const { rerender } = render(<MenuList root={dynamicPanel} nav="push" onClose={vi.fn()} />);
    await user.click(screen.getByText("Group by"));
    expect(screen.getByText("Select")).toBeInTheDocument();

    // Simulate the host writing a reorder and re-rendering with fresh data —
    // no pop/push, just a new `root` prop, exactly what a live drag does.
    order = ["Status", "Select"];
    rerender(<MenuList root={{ ...dynamicPanel }} nav="push" onClose={vi.fn()} />);

    const rows = screen.getAllByRole("option").map((r) => r.textContent);
    expect(rows).toEqual(["Status", "Select"]);
  });
});

describe("MenuList search", () => {
  const panel: MenuPanel = {
    search: { placeholder: "Search for a property…", scope: "section" },
    sections: [
      // Notion's type picker leaves "AI Autofill" unfiltered while filtering
      // "Select type" below it — search scope is per-section.
      { label: "AI Autofill", searchable: false, rows: [{ id: "sum", label: "Summarize" }] },
      {
        label: "Select type",
        rows: [
          { id: "text", label: "Text" },
          { id: "rel", label: "Relation" },
        ],
      },
    ],
  };

  it("filters searchable sections and leaves exempt ones intact", async () => {
    const user = userEvent.setup();
    render(<MenuList root={panel} onClose={vi.fn()} />);

    await user.type(screen.getByRole("combobox"), "rel");

    expect(screen.getByText("Relation")).toBeInTheDocument();
    expect(screen.queryByText("Text")).not.toBeInTheDocument();
    // exempt section survives the filter
    expect(screen.getByText("Summarize")).toBeInTheDocument();
  });

  it("keeps focus in the search input while arrows move the active row", async () => {
    const user = userEvent.setup();
    render(<MenuList root={panel} onClose={vi.fn()} />);

    const input = screen.getByRole("combobox");
    expect(input).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-activedescendant");
  });

  it("reports no results based on the SEARCHABLE sections, not the exempt one", async () => {
    const user = userEvent.setup();
    render(<MenuList root={panel} onClose={vi.fn()} />);
    await user.type(screen.getByRole("combobox"), "zzzz");

    // The exempt section is still on screen...
    expect(screen.getByText("Summarize")).toBeInTheDocument();
    // ...but the searched section is empty, so say so rather than looking broken.
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("does not report no results when a searchable row still matches", async () => {
    const user = userEvent.setup();
    render(<MenuList root={panel} onClose={vi.fn()} />);
    await user.type(screen.getByRole("combobox"), "rel");
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
  });
});
