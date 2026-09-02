"use client";

// Reveals its children on hover of an ancestor marked `group`, and on keyboard
// focus.
//
// Two things this exists to enforce, both from live capture:
//  1. NO LAYOUT SHIFT. Notion's row gutter (+, drag handle, checkbox) lives
//     outside the table's left edge and appears only on hover. If the space is
//     not reserved, every row jumps sideways when the pointer enters it. The
//     same applies to the database header's Add icon / Add cover / Add
//     description row. So this toggles OPACITY, never mounting.
//  2. KEYBOARD REACHABILITY. Notion's hover affordances are mouse-only. Ours
//     also reveal on focus-within, so they are not unreachable by keyboard —
//     a deliberate deviation, consistent with MenuList's arrow navigation.
import type { ReactNode } from "react";

export interface HoverAffordanceProps {
  children: ReactNode;
  /** Rendered even when hidden so the box keeps its size. Set false only when
   * the affordance sits somewhere that genuinely cannot reflow. */
  reserveSpace?: boolean;
  className?: string;
}

export function HoverAffordance({
  children,
  reserveSpace = true,
  className = "",
}: HoverAffordanceProps) {
  return (
    <span
      data-testid="hover-affordance"
      data-reserve-space={reserveSpace}
      className={[
        "opacity-0 transition-opacity",
        "group-hover:opacity-100 focus-within:opacity-100",
        reserveSpace ? "" : "hidden group-hover:inline-flex",
        className,
      ].join(" ")}
    >
      {children}
    </span>
  );
}
