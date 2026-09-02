"use client";

// The row peek, and the host for any right-docked panel.
//
// *** NON-MODAL BY DEFAULT, AND THAT IS THE POINT. ***
// Notion's own copy for this mode reads "Open pages on the side. Keeps the view
// behind interactive." The table stays visible and clickable while a peek is
// open. Our existing RowPeek renders a bg-black/30 backdrop over the whole
// viewport and traps interaction — a behavioural difference, not a visual one.
// `modal={false}` is what preserves that, so do not "fix" it to modal.
//
// The caller owns the URL. Notion encodes both the peeked page and the mode
// (?p=<id>&pm=s|c), so a peek is deep-linkable and survives reload; this
// component just reflects `open`.
import * as RadixDialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface SidePeekProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  title: string;
  /** "side" docks right; "center" is Notion's centre-peek modal. */
  mode?: "side" | "center";
  /** Starting width in px for side mode; the user's drag is remembered here. */
  defaultWidth?: number;
  onWidthChange?: (width: number) => void;
  /** False removes the drag handle and fixes the width at `defaultWidth`.
   *
   * The row peek's 640px is a per-viewer preference, remembered across
   * sessions — Notion lets you drag it. The view settings sidebar's 483px is
   * a TOKEN (view-options-panel.md: "a token, not a per-surface choice"),
   * not a preference, so it does not resize. Defaults to true so the row
   * peek's own behaviour is unchanged. */
  resizable?: boolean;
}

const MIN_WIDTH = 380;

export function SidePeek({
  open,
  onOpenChange,
  children,
  title,
  mode = "side",
  defaultWidth = 640,
  onWidthChange,
  resizable = true,
}: SidePeekProps) {
  const [width, setWidth] = useState(defaultWidth);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
  }, []);

  useEffect(() => {
    if (!open) return;
    function onMove(e: PointerEvent) {
      if (!dragging.current) return;
      const next = Math.max(MIN_WIDTH, window.innerWidth - e.clientX);
      setWidth(next);
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      onWidthChange?.(width);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [open, width, onWidthChange]);

  const isSide = mode === "side";

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange} modal={!isSide}>
      <RadixDialog.Portal>
        {/* A backdrop ONLY in centre mode. Side peek deliberately has none. */}
        {!isSide && <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/30" />}
        <RadixDialog.Content
          data-testid="side-peek"
          data-mode={mode}
          aria-label={title}
          // `modal={false}` (side mode, above) stops Radix from trapping
          // focus/locking scroll, but Radix's DismissableLayer still closes
          // on ANY outside pointerdown regardless of `modal` — that is a
          // SEPARATE default this component never overrode. Review-
          // checkpoint finding (M1-M3 pass): side mode's whole point, per
          // this file's own "NON-MODAL BY DEFAULT" comment and Notion's own
          // copy for it ("Keeps the view behind interactive"), is that
          // clicking the table does NOT close the panel — dismissal here is
          // the × only (view-options-panel.md's own Anchor section: "Escape
          // TBD" but no outside-click dismissal is documented at all).
          // Escape is left alone; only the outside-pointerdown auto-close is
          // suppressed, and only in side mode — center peek keeps Radix's
          // default backdrop-click-to-close.
          onPointerDownOutside={isSide ? (e) => e.preventDefault() : undefined}
          style={isSide ? { width } : undefined}
          className={
            isSide
              ? "fixed right-0 top-0 z-40 flex h-full flex-col bg-menu-bg shadow-menu"
              : "fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[min(90vw,880px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-menu bg-menu-bg shadow-menu"
          }
        >
          <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
          {isSide && resizable && (
            <div
              role="separator"
              aria-label="Resize"
              aria-orientation="vertical"
              onPointerDown={onPointerDown}
              data-testid="side-peek-resize"
              className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-brand/40"
            />
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
