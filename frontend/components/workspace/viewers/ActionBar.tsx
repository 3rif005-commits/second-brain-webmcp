"use client";

// Small floating action popover shown when an element or selection is active
// in a source viewer. One-click "send to note" per the workspace spec.
import type { ReactNode } from "react";

export function ActionBar({
  x, y, children,
}: { x: number; y: number; children: ReactNode }) {
  return (
    <div
      className="ws-glass-dark ws-rise absolute z-30 flex items-center gap-0.5 p-1 rounded-full text-white text-xs"
      style={{ left: x, top: y, transform: "translate(-50%, -115%)" }}
      onMouseDown={(e) => e.preventDefault()} // keep text selection alive
    >
      {children}
    </div>
  );
}

export function ActionButton({
  onClick, children, title, primary,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
  /** The one action that matters most in this popover. */
  primary?: boolean;
}) {
  return (
    <button
      title={title}
      className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-full whitespace-nowrap font-medium
        transition-all duration-150 active:scale-[0.97]
        focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 ${
        primary
          ? "ws-accent"
          : "text-white/70 hover:text-white hover:bg-white/10"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A non-interactive label inside the bar — the element's type, usually. */
export function ActionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="pl-2 pr-1 text-[11px] uppercase tracking-wide text-white/40 select-none">
      {children}
    </span>
  );
}

export function ActionSeparator() {
  return <span className="w-px h-4 bg-white/10 mx-0.5 shrink-0" />;
}
