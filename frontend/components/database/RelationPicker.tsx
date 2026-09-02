"use client";

// Search-and-select over a relation property's *target* data source's rows
// (task-22-brief.md §2). Multi-select, commits on close (a "Done" button —
// not click-outside/blur detection, which is fragile to get right in jsdom
// and, per the brief's own "commit on close" wording, doesn't have to be
// outside-click specifically).
//
// task-21's committed API gives no server-side title search: `GET
// .../rows` (the "existing rows endpoint" the brief points at) takes no
// query string at all, and `rich_text`/`title` properties only ever get
// `is_empty`/`is_not_empty` operators (services/db/properties/base.py's
// `_GenericProperty` — no `contains`), so `POST .../query` can't filter by
// title substring either. This fetches the target's rows once (capped at
// the backend's own 500-row `_ROWS_LIMIT`, same as every other list
// endpoint in this feature) and searches client-side instead — see
// task-22-report.md for the full divergence writeup.
import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/app/providers";
import type { RelatedRow } from "@/lib/database/types";

interface RelationPickerProps {
  targetDataSourceId: string;
  /** Currently-linked rows, pre-checked in the list. */
  selected: RelatedRow[];
  onCommit: (rows: RelatedRow[]) => void;
  onCancel: () => void;
}

// Mirrors backend/routers/databases.py's `_ROWS_LIMIT` (task-10 review
// finding 1) — not enforced here, just the number this picker warns the
// user about when the target's row count might exceed what a plain
// `GET .../rows` call can ever return.
const ROWS_FETCH_CAP = 500;

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

export function RelationPicker({ targetDataSourceId, selected, onCommit, onCancel }: RelationPickerProps) {
  const { showToast } = useToast();
  const [allRows, setAllRows] = useState<RelatedRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [draftSelected, setDraftSelected] = useState<RelatedRow[]>(selected);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/db/data-sources/${targetDataSourceId}/rows`);
        if (!res.ok) throw new Error(await errorMessage(res));
        const data: { rows: { id: string; properties: Record<string, unknown> }[] } = await res.json();
        if (cancelled) return;
        // The title property's *key* varies per data source, but its
        // wrapper's `type` is always "title" (spec §3.3) and every
        // ordinary data source has exactly one — so scanning values
        // instead of needing to know the key up front works generically.
        const withTitles: RelatedRow[] = data.rows.map((r) => {
          const titleValue = Object.values(r.properties).find(
            (v): v is { type: "title"; title: string } =>
              !!v && typeof v === "object" && (v as { type?: unknown }).type === "title"
          );
          return { id: r.id, title: titleValue?.title || "Untitled" };
        });
        setAllRows(withTitles);
      } catch (e) {
        if (!cancelled) showToast(e instanceof Error ? e.message : "Could not load rows to link", "error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [targetDataSourceId, showToast]);

  const filtered = useMemo(() => {
    if (!allRows) return [];
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((r) => r.title.toLowerCase().includes(q));
  }, [allRows, query]);

  const selectedIds = useMemo(() => new Set(draftSelected.map((r) => r.id)), [draftSelected]);

  function toggle(row: RelatedRow) {
    setDraftSelected((prev) => (selectedIds.has(row.id) ? prev.filter((r) => r.id !== row.id) : [...prev, row]));
  }

  return (
    <div
      role="dialog"
      aria-label="Link rows"
      className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-2"
    >
      <input
        autoFocus
        aria-label="Search rows"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search…"
        className="w-full text-xs px-2 py-1 mb-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
      />
      <div className="max-h-48 overflow-auto">
        {allRows === null && <div className="text-xs text-gray-400 px-1 py-1">Loading…</div>}
        {allRows !== null && filtered.length === 0 && (
          <div className="text-xs text-gray-400 px-1 py-1">No rows found.</div>
        )}
        {filtered.map((row) => (
          <label
            key={row.id}
            className="flex items-center gap-1.5 px-1 py-1 text-xs cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700 rounded"
          >
            <input type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggle(row)} />
            <span className="truncate">{row.title}</span>
          </label>
        ))}
      </div>
      {allRows !== null && allRows.length >= ROWS_FETCH_CAP && (
        <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 px-1">
          Showing first {ROWS_FETCH_CAP} rows — search to narrow.
        </p>
      )}
      <div className="flex justify-end gap-1.5 mt-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onCommit(draftSelected)}
          className="text-xs px-2 py-1 rounded bg-indigo-600 text-white"
        >
          Done
        </button>
      </div>
    </div>
  );
}
