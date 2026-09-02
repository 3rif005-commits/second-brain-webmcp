"use client";

import { useState } from "react";

interface Props {
  tool: string;
  args: Record<string, unknown>;
  summary?: string;
  deniedReason?: string;
}

const TOOL_ICONS: Record<string, string> = {
  "brain.search_brain": "🔍",
  "brain.get_note":     "📖",
  "brain.list_notes":   "📚",
  "brain.create_note":  "✨",
  "brain.update_note":  "✏️",
  "brain.delete_note":  "🗑️",
  "brain.link_notes":   "🔗",
  "brain.set_mastery":  "🎯",
  "brain.get_backlinks":"🪞",
};

export function ToolEvent({ tool, args, summary, deniedReason }: Props) {
  const [open, setOpen] = useState(false);
  const icon = TOOL_ICONS[tool] ?? "🛠️";
  const label = tool.split(".").slice(1).join(".").replace(/_/g, " ");

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`text-xs flex items-center gap-2 px-2 py-1 rounded-md transition-colors ${
          deniedReason
            ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 hover:bg-red-100"
            : "bg-gray-50 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-100"
        }`}
      >
        <span>{icon}</span>
        <span>{label}</span>
        {summary && <span className="text-gray-400">— {summary}</span>}
        {deniedReason && <span>· denied</span>}
        <span className="ml-1 text-gray-400">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="mt-1 ml-6 p-2 rounded-md bg-gray-50 dark:bg-gray-800 text-[11px] font-mono text-gray-600 dark:text-gray-300">
          <div><b>args:</b> {JSON.stringify(args)}</div>
          {deniedReason && <div className="text-red-600 mt-1"><b>denied:</b> {deniedReason}</div>}
        </div>
      )}
    </div>
  );
}
