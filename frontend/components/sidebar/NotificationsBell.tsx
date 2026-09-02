"use client";

// Milestone 12 (task-41): the notifications inbox — task-41-brief.md
// decision 5. A bell NavItem-style entry, top-level and NOT scoped to any
// one database (notifications are user-wide, `GET /db/notifications` has no
// data_source_id in its path). Clicking it opens a small dropdown/panel
// (closer to ConfirmDialog's scale than SearchModal's — decision 5's own
// words), not a full page. This app has no realtime/push (spec §11.4's own
// recorded decision), so unread state is kept fresh with a plain
// `setInterval`-driven poll while the bell is mounted — no WebSocket/SSE.
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useToast } from "@/app/providers";
import type { NotificationResponse } from "@/lib/database/types";

/** Exported so the test file can advance fake timers by exactly this much
 * rather than guessing a magic number. */
export const NOTIFICATIONS_POLL_MS = 45_000;

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (typeof body?.error === "string") return body.error;
  } catch {
    // body wasn't JSON — fall through
  }
  return `Request failed (${res.status})`;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NotificationsBell() {
  const { showToast } = useToast();
  const [notifications, setNotifications] = useState<NotificationResponse[]>([]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // A sidebar badge failing to load is not worth breaking the sidebar over
  // — same silent-failure convention Sidebar.tsx's own `loadDatabases`
  // already uses for the same reason.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/db/notifications");
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (Array.isArray(data)) setNotifications(data as NotificationResponse[]);
    } catch {
      // deliberately silent
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, NOTIFICATIONS_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Close on an outside click — the same lightweight pattern this app's own
  // small floating panels (e.g. DatabaseSettingsMenu) don't bother with
  // (they close via their own explicit "Close"/backdrop), but this one has
  // no backdrop of its own (decision 5: a dropdown, not a full overlay), so
  // an outside click needs to be handled explicitly to avoid it staying
  // stuck open.
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const unreadCount = notifications.filter((n) => n.read_at === null).length;

  async function markRead(id: string) {
    const previous = notifications;
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    try {
      // `PATCH /db/notifications/{id}` takes no request body — the backend
      // route (`mark_notification_read`) accepts none, it just marks the
      // one notification read for this user.
      const res = await fetch(`/api/db/notifications/${id}`, { method: "PATCH" });
      if (!res.ok) throw new Error(await errorMessage(res));
    } catch (e) {
      setNotifications(previous);
      showToast(e instanceof Error ? e.message : "Could not mark that notification read", "error");
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-all"
      >
        <span className="relative">
          <Bell size={15} strokeWidth={2} />
          {unreadCount > 0 && (
            <span
              aria-label={`${unreadCount} unread notifications`}
              className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-[3px] rounded-full bg-red-500 text-white text-[9px] leading-[14px] text-center font-semibold"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </span>
        <span className="flex-1 text-left">Notifications</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute left-0 top-full mt-1 w-80 max-h-96 overflow-y-auto z-50 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-2xl text-xs"
        >
          {notifications.length === 0 ? (
            <p className="p-3 text-gray-400 dark:text-gray-500">No notifications yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`p-2.5 ${n.read_at === null ? "bg-indigo-50/60 dark:bg-indigo-900/20" : ""}`}
                >
                  <p className="text-gray-800 dark:text-gray-100">{n.message}</p>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-gray-400 dark:text-gray-500">{timeAgo(n.created_at)}</span>
                    <div className="flex items-center gap-2">
                      {n.link && (
                        <a href={n.link} className="text-indigo-500 hover:text-indigo-600">
                          Open
                        </a>
                      )}
                      {n.read_at === null && (
                        <button
                          type="button"
                          onClick={() => markRead(n.id)}
                          className="text-indigo-500 hover:text-indigo-600"
                        >
                          Mark read
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
