"use client";

// Anchored popover. Thin wrapper over Radix so we get flip/shift collision
// handling, portalling, Esc, outside-click and focus return without writing
// them — every visual decision stays here.
//
// Collision handling is the reason this is a dependency rather than hand-rolled:
// live Notion nests menus three deep and the third level FLIPS to the left when
// it runs out of room (Calculate -> Count, observed twice). Getting that right
// by hand, per surface, is where this class of work dies.
import * as RadixPopover from "@radix-ui/react-popover";
import type { ReactNode } from "react";

export type PopoverWidth = "sm" | "md" | "lg" | "trigger" | number;

const WIDTH_CLASS: Record<string, string> = {
  sm: "w-menu-sm",
  md: "w-menu-md",
  lg: "w-menu-lg",
};

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  width?: PopoverWidth;
  /** Constrains height and lets the panel scroll. Notion's menus scroll rather
   * than growing past the viewport. */
  maxHeight?: number | string;
  /** Test hook / a11y label for the surface. */
  label?: string;
  className?: string;
  /** Portal target. Defaults to document.body.
   *
   * THE ESCAPE HATCH FOR INLINE DATABASES. DatabaseBlock.tsx:188-199 stops
   * mousemove/mouseup at its wrapper because BlockNote's TableHandles walks up
   * from the hovered element to the first td/th/.tableWrapper, resolves to the
   * non-table `database` block, and crashes. A portal to document.body renders
   * OUTSIDE that wrapper, so a menu opened from an inline database is not
   * covered by the guard. If that reproduces, pass the wrapper here rather than
   * re-adding ad-hoc listeners. See the design doc §6 risk 1. */
  container?: HTMLElement | null;
  /** Keep focus where it already is when the popover opens.
   *
   * Radix focuses the content's first focusable element on open, which is
   * usually right. It is wrong when the TRIGGER is itself the primary input —
   * property creation focuses the name field in the header cell, and Radix
   * would immediately pull focus into the panel's search instead. */
  preventAutoFocus?: boolean;
}

export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  width = "sm",
  maxHeight = "min(70vh, 520px)",
  label,
  className = "",
  container,
  preventAutoFocus,
}: PopoverProps) {
  const isNamedWidth = typeof width === "string" && width in WIDTH_CLASS;
  const widthClass = isNamedWidth ? WIDTH_CLASS[width as string] : "";
  const style: React.CSSProperties = {
    maxHeight,
    ...(typeof width === "number" ? { width } : {}),
    ...(width === "trigger" ? { width: "var(--radix-popover-trigger-width)" } : {}),
  };

  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal container={container ?? undefined}>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={8}
          onOpenAutoFocus={preventAutoFocus ? (e) => e.preventDefault() : undefined}
          aria-label={label}
          style={style}
          // No border: the 1px edge is the third layer of --menu-shadow, in
          // both themes. See the design doc §5.
          className={`z-50 overflow-y-auto overscroll-contain rounded-menu bg-menu-bg shadow-menu ${widthClass} ${className}`}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
