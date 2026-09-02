// The one thing worth testing here is that the affordance is NOT unmounted.
//
// Notion's row gutter (+, drag handle, checkbox) lives outside the table's left
// edge and appears on hover. If it were mounted on hover instead of faded in,
// every row would shift sideways as the pointer entered it. CSS :hover cannot
// be exercised in jsdom, so we assert the mechanism rather than the visual.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { HoverAffordance } from "./HoverAffordance";

describe("HoverAffordance", () => {
  it("keeps its children mounted so the layout never shifts", () => {
    render(
      <div className="group">
        <HoverAffordance>
          <button type="button">Open</button>
        </HoverAffordance>
      </div>
    );
    // Present in the DOM at rest — hidden by opacity, not by absence.
    expect(screen.getByText("Open")).toBeInTheDocument();
    const wrapper = screen.getByTestId("hover-affordance");
    expect(wrapper.className).toContain("opacity-0");
    expect(wrapper.className).toContain("group-hover:opacity-100");
  });

  it("also reveals on focus, so the affordance is keyboard-reachable", () => {
    render(
      <div className="group">
        <HoverAffordance>
          <button type="button">Open</button>
        </HoverAffordance>
      </div>
    );
    expect(screen.getByTestId("hover-affordance").className).toContain("focus-within:opacity-100");
  });

  it("can opt out of reserving space when reflow genuinely cannot happen", () => {
    render(
      <div className="group">
        <HoverAffordance reserveSpace={false}>
          <button type="button">Open</button>
        </HoverAffordance>
      </div>
    );
    expect(screen.getByTestId("hover-affordance")).toHaveAttribute("data-reserve-space", "false");
  });
});
