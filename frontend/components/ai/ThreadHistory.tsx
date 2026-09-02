"use client";

import { useEffect, useState } from "react";
import { Pin, Trash2, Pencil, SquarePen, X } from "lucide-react";

interface Thread {
  id: string;
  title: string | null;
  pinned: boolean;
  model_mode: string | null;
  updated_at: string;
}

interface Props {
  activeThreadId: string | null;
  onSelect: (id: string | null) => void;
  onClose?: () => void;
  onNew?: () => void;
}

function groupThreads(threads: Thread[]): { label: string; items: Thread[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);

  const pinned = threads.filter((t) => t.pinned);
  const rest = threads.filter((t) => !t.pinned);

  const todayItems = rest.filter((t) => new Date(t.updated_at) >= today);
  const yesterdayItems = rest.filter(
    (t) => new Date(t.updated_at) >= yesterday && new Date(t.updated_at) < today
  );
  const weekItems = rest.filter(
    (t) => new Date(t.updated_at) >= weekAgo && new Date(t.updated_at) < yesterday
  );
  const olderItems = rest.filter((t) => new Date(t.updated_at) < weekAgo);

  const groups = [];
  if (pinned.length)       groups.push({ label: "Pinned", items: pinned });
  if (todayItems.length)   groups.push({ label: "Today", items: todayItems });
  if (yesterdayItems.length) groups.push({ label: "Yesterday", items: yesterdayItems });
  if (weekItems.length)    groups.push({ label: "Past 7 days", items: weekItems });
  if (olderItems.length)   groups.push({ label: "Older", items: olderItems });
  return groups;
}

export function ThreadHistory({ activeThreadId, onSelect, onClose, onNew }: Props) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);

  async function reload() {
    setLoading(true);
    const res = await fetch("/api/threads");
    const data = await res.json();
    setThreads(data.threads ?? []);
    setLoading(false);
  }

  useEffect(() => { reload(); }, []);

  async function togglePin(t: Thread, e: React.MouseEvent) {
    e.stopPropagation();
    await fetch(`/api/threads/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !t.pinned }),
    });
    reload();
  }

  async function rename(t: Thread, e: React.MouseEvent) {
    e.stopPropagation();
    const next = prompt("Rename thread:", t.title ?? "");
    if (next === null) return;
    await fetch(`/api/threads/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next.trim() || null }),
    });
    reload();
  }

  async function remove(t: Thread, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Archive this thread?")) return;
    await fetch(`/api/threads/${t.id}`, { method: "DELETE" });
    if (activeThreadId === t.id) onSelect(null);
    reload();
  }

  const groups = groupThreads(threads);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200/60 dark:border-gray-800 shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
          History
        </span>
        <div className="flex items-center gap-0.5">
          {onNew && (
            <button
              onClick={onNew}
              aria-label="New thread"
              className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <SquarePen size={14} />
            </button>
          )}
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close history"
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <div className="flex flex-col gap-2 px-3 pt-2">
            {[80, 60, 72, 50].map((w, i) => (
              <div key={i} className={`h-8 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse`} style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 px-6 text-center">
            <span className="text-2xl">💬</span>
            <p className="text-sm text-gray-400 dark:text-gray-500">No conversations yet.</p>
            <p className="text-xs text-gray-300 dark:text-gray-600">Start chatting and your history will appear here.</p>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} className="mb-1">
              <p className="px-3 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-600">
                {group.label}
              </p>
              {group.items.map((t) => (
                <ThreadItem
                  key={t.id}
                  thread={t}
                  active={t.id === activeThreadId}
                  onSelect={() => onSelect(t.id)}
                  onPin={(e) => togglePin(t, e)}
                  onRename={(e) => rename(t, e)}
                  onRemove={(e) => remove(t, e)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

interface ItemProps {
  thread: Thread;
  active: boolean;
  onSelect: () => void;
  onPin: (e: React.MouseEvent) => void;
  onRename: (e: React.MouseEvent) => void;
  onRemove: (e: React.MouseEvent) => void;
}

function ThreadItem({ thread, active, onSelect, onPin, onRename, onRemove }: ItemProps) {
  return (
    <button
      onClick={onSelect}
      className={[
        "group w-full flex items-center gap-2 px-3 py-2 text-left rounded-lg mx-1 transition-colors",
        "w-[calc(100%-8px)]",
        active
          ? "bg-indigo-50 dark:bg-indigo-950/40"
          : "hover:bg-gray-100 dark:hover:bg-gray-800/60",
      ].join(" ")}
    >
      {thread.pinned && (
        <span className="text-amber-400 shrink-0 text-xs">📌</span>
      )}
      <span className={`flex-1 truncate text-sm ${active ? "text-indigo-700 dark:text-indigo-300 font-medium" : "text-gray-700 dark:text-gray-300"}`}>
        {thread.title ?? "Untitled"}
      </span>
      {/* Actions — only visible on hover */}
      <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <span
          role="button"
          onClick={onPin}
          title={thread.pinned ? "Unpin" : "Pin"}
          className="p-1 rounded-md text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors"
        >
          <Pin size={12} />
        </span>
        <span
          role="button"
          onClick={onRename}
          title="Rename"
          className="p-1 rounded-md text-gray-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors"
        >
          <Pencil size={12} />
        </span>
        <span
          role="button"
          onClick={onRemove}
          title="Archive"
          className="p-1 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
        >
          <Trash2 size={12} />
        </span>
      </span>
    </button>
  );
}
