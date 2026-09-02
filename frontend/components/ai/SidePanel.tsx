"use client";

import { useRef } from "react";
import { Bot } from "lucide-react";
import { Chat } from "./Chat";
import { useAIThread } from "@/context/AIThreadContext";

interface SidePanelProps {
  open: boolean;
  onToggle: () => void;
  width?: number;
  onWidthChange?: (w: number) => void;
}

export function SidePanel({ open, onToggle, width = 360, onWidthChange }: SidePanelProps) {
  const { activeThreadId, setActiveThreadId } = useAIThread();
  const startX = useRef(0);
  const startWidth = useRef(width);

  function onResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    startX.current = e.clientX;
    startWidth.current = width;

    function onMove(e: MouseEvent) {
      // Dragging LEFT increases panel width (panel is on the right)
      const delta = startX.current - e.clientX;
      onWidthChange?.(startWidth.current + delta);
    }

    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  return (
    <>
      {/* Mobile backdrop */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={onToggle}
          aria-hidden
        />
      )}

      {/* Panel */}
      <div
        className={[
          "fixed inset-y-0 right-0 z-40 flex flex-col",
          // Distinct background: light lavender in light mode, deep blue-black in dark
          "bg-[#eeeefc] dark:bg-[#0f0f1a]",
          "transition-transform duration-200 ease-in-out",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
        style={{ width }}
        aria-label="AI assistant panel"
        role="complementary"
      >
        {/* Resize handle — desktop only, on the left edge */}
        <div
          onMouseDown={onResizeStart}
          className="absolute left-0 inset-y-0 w-3 cursor-col-resize hidden md:flex items-center justify-center z-10 group"
        >
          {/* The actual visible line */}
          <div className="w-px h-full bg-indigo-200/60 dark:bg-indigo-900/40 group-hover:bg-indigo-400 dark:group-hover:bg-indigo-500 transition-colors duration-150" />
          {/* Drag grip dots — appear on hover */}
          <div className="absolute flex flex-col gap-[3px] opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {[0, 1, 2].map((i) => (
              <div key={i} className="w-[3px] h-[3px] rounded-full bg-indigo-400 dark:bg-indigo-500" />
            ))}
          </div>
        </div>

        {/* Indigo gradient accent at the top */}
        <div className="h-[3px] w-full bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-400 shrink-0" />

        {/* Chat — only mounted when open */}
        {open && (
          <Chat
            threadId={activeThreadId}
            onThreadIdChange={setActiveThreadId}
            onClose={onToggle}
          />
        )}
      </div>
    </>
  );
}

/** Floating reopen button shown when panel is collapsed on desktop */
export function SidePanelToggleButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open AI panel"
      className="fixed top-3 right-3 z-30 hidden md:flex items-center justify-center w-8 h-8 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-indigo-500 hover:bg-indigo-50 dark:hover:bg-gray-700 shadow-sm transition-colors"
    >
      <Bot size={16} />
    </button>
  );
}
