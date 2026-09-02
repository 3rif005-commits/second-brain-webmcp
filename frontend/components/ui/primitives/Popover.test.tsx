// Dismissal and focus-return coverage. These are the behaviours we took a
// dependency on Radix FOR, so if a future change swaps the implementation out,
// this is what proves the swap kept the contract.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Popover } from "./Popover";

function Fixture() {
  return (
    <div>
      <button type="button">outside</button>
      <Popover trigger={<button type="button">open menu</button>} label="Test menu">
        <div>panel body</div>
      </Popover>
    </div>
  );
}

describe("Popover", () => {
  it("opens on trigger click and renders its content", async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    await user.click(screen.getByText("open menu"));
    expect(screen.getByText("panel body")).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    const trigger = screen.getByText("open menu");
    await user.click(trigger);
    expect(screen.getByText("panel body")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
    // Focus return is the part that is easy to lose and impossible to see in
    // a screenshot.
    expect(trigger).toHaveFocus();
  });

  it("closes on an outside click", async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    await user.click(screen.getByText("open menu"));
    expect(screen.getByText("panel body")).toBeInTheDocument();

    await user.click(screen.getByText("outside"));
    expect(screen.queryByText("panel body")).not.toBeInTheDocument();
  });

  it("can be driven as a controlled component", async () => {
    const user = userEvent.setup();
    function Controlled() {
      return (
        <Popover
          open
          onOpenChange={() => {}}
          trigger={<button type="button">t</button>}
          label="always open"
        >
          <div>pinned</div>
        </Popover>
      );
    }
    render(<Controlled />);
    expect(screen.getByText("pinned")).toBeInTheDocument();
    // An Escape on a controlled-open popover must not close it behind the
    // caller's back.
    await user.keyboard("{Escape}");
    expect(screen.getByText("pinned")).toBeInTheDocument();
  });
});
