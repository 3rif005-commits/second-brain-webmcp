"use client";

// A row's "page" as a side peek — matches Notion's own default row-click
// behavior (open a panel over the table, not navigate away to a full
// page). Controller design, approved by the user after they found
// TableView's row click did nothing: previously the only way to see a
// row's body/content at all was "Open in Workspace" (the heavier
// sources/AI-synthesis/chat experience) or nothing. This is the
// lightweight middle ground — properties + body, editable, without leaving
// the table.
//
// Scope (TableView-only for now, by design — see the brainstorm this was
// approved from): reuses exactly the same per-type cell components
// TableView's own columns render (`renderCellValue`), the same
// `onCellChange` write path, and the same `BlockEditor` body component
// `NoteEditorPage.tsx` uses (dynamically imported with `ssr: false`,
// mirroring that file's own pattern — BlockNote has browser-only
// dependencies). No backend changes: the property data comes from props
// already loaded by TableView; only the note's body content is fetched
// fresh here, via the pre-existing `GET/PATCH /api/notes/{id}` routes
// `NoteEditorPage.tsx` already uses, not a new endpoint.
//
// Relation and button property cells fall back to `renderCellValue`'s own
// existing read-only degradation (no `relation`/`button` handler argument
// passed) — the same "older/other caller" convention this codebase already
// established for Board/Gallery/List/Feed, not a regression specific to
// this component. Full relation/button interactivity in the peek is a
// disclosed, deliberately-deferred follow-up, not silently dropped.
//
// M10 (row-peek.md) additions: alphabetical property ordering, the literal
// "Empty" placeholder, the `»/⤢/Share/★/⋯` header bar, and "+ Add a
// property" (reusing AddPropertyPopover at `columns={1}` — see its own
// top-of-file comment for the "one shared copy string" decision). The
// URL (`?p=&pm=`) this surface is meant to be addressable by is OWNED and
// WRITTEN by TableView.tsx, not here — RowPeek stays presentational
// (row/mode in, onClose out), the same shape it already had; TableView is
// what has `useSearchParams`/`router.replace` and knows about `?view=`
// (M3's own still-write-only query param) to merge against.
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Maximize2, MoreHorizontal, Share2, Star, X } from "lucide-react";
import { useToast } from "@/app/providers";
import type { BlockEditorHandle } from "../editor/BlockEditor";
import { noteWorkspacePath } from "@/lib/database/useOpenNote";
import type { DatabaseRow, MultiSelectValue, PropertyResponse, PropertyValue } from "@/lib/database/types";
import { renderCellValue } from "./cells/renderCellValue";
import { propertyTypeIcon } from "./ColumnHeaderMenu";
import { AddPropertyPopover } from "./AddPropertyPopover";
import { SCOPE_NOTE } from "./EditPropertyPanel";

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

/** row-peek.md: "Empty values render the literal muted word `Empty`."
 * `value == null` (the property key is simply absent from `row.properties`,
 * the common case for a freshly created row) covers every property type,
 * known or not; the per-type branches below only refine it for the 9
 * `PropertyValue` wrappers that carry data alongside a possibly-empty
 * field. Types outside that union (files, people, relation, formula,
 * rollup, unique_id, button, created/last-edited time/by) fall through to
 * `false` — whatever `renderCellValue`'s own read-only fallback already
 * shows for them is unchanged, not silently reinterpreted as "Empty". */
function isEmptyPropertyValue(value: PropertyValue | undefined): boolean {
  if (value == null) return true;
  switch (value.type) {
    case "title":
      return !value.title;
    case "rich_text":
      return !value.rich_text;
    case "number":
      return value.number == null;
    case "select":
      return !value.select;
    case "status":
      return !value.status;
    case "multi_select":
      // `UnknownValue`'s `[key: string]: unknown` index signature keeps the
      // union from narrowing `multi_select` past `unknown` here (unlike the
      // other cases above, none of which chain a further member access) —
      // an explicit cast, not a real ambiguity, since the `case` already
      // proves `value.type === "multi_select"`.
      return (value as MultiSelectValue).multi_select.length === 0;
    case "date":
      return value.date == null;
    case "url":
      return !value.url;
    case "email":
      return !value.email;
    case "phone_number":
      return !value.phone_number;
    case "checkbox":
      // A checkbox is never "unset" — false is a real, rendered value, not
      // an absence of one.
      return false;
    default:
      return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

// Same dynamic-import shape NoteEditorPage.tsx uses — BlockNote depends on
// browser-only APIs, and casting is needed to preserve forwardRef through
// next/dynamic.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BlockEditor = dynamic(
  () => import("../editor/BlockEditor").then((m) => m.BlockEditor),
  { ssr: false, loading: () => <div className="h-48 animate-pulse bg-gray-50 dark:bg-gray-800 rounded-lg" /> }
) as React.ForwardRefExoticComponent<
  React.ComponentProps<typeof import("../editor/BlockEditor").BlockEditor> &
    React.RefAttributes<BlockEditorHandle>
>;

export interface RowPeekProps {
  row: DatabaseRow;
  properties: PropertyResponse[];
  editable: boolean;
  onCellChange: (rowId: string, propertyKey: string, value: PropertyValue | null) => void;
  onClose: () => void;
  /** M3's "Open pages in" (view-options-panel.md §C) — the view-wide default
   * this row was opened under. "side" is Notion's own default and its own
   * copy for it ("Keeps the view behind interactive") is a direct textual
   * confirmation this must be NON-modal — no backdrop, table stays clickable
   * — which this component got wrong before now (a `bg-black/30` backdrop
   * blocked the whole viewport regardless of mode). "center" keeps that
   * backdrop and centers instead of docking right. */
  mode?: "side" | "center";
  /** M10 (row-peek.md): "+ Add a property" writes SCHEMA (`POST
   * .../properties`), which is why it needs the data source id a plain cell
   * edit never does. Optional — omitted (as before M10) suppresses the row
   * entirely, same as `!editable` does for a read-only source. */
  dataSourceId?: string;
  onPropertyCreated?: () => void | Promise<void>;
}

export function RowPeek({
  row,
  properties,
  editable,
  onCellChange,
  onClose,
  mode = "side",
  dataSourceId,
  onPropertyCreated,
}: RowPeekProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [content, setContent] = useState<AnyBlock[] | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const reindexDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which property's "Empty" placeholder has been clicked into its real,
  // editable control — see isEmptyPropertyValue below. Component state, not
  // per-row persisted: it only tracks this peek's own current session.
  const [activePropertyKey, setActivePropertyKey] = useState<string | null>(null);

  const titleProperty = properties.find((p) => p.type === "title");
  // row-peek.md: "Ordering: Alphabetical — not table order." Deliberately
  // NOT `position` (that is Property visibility's own order, read where a
  // user reorders columns) — Notion uses table order where you REORDER and
  // alphabetical where you SCAN (peek, Group/Sort/Filter pickers), and this
  // is a scan surface.
  const otherProperties = properties
    .filter((p) => p.type !== "title")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetch(`/api/notes/${row.id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((note) => {
        if (cancelled) return;
        setContent(note?.content ?? []);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setContent([]);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [row.id]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (reindexDebounceRef.current) clearTimeout(reindexDebounceRef.current);
    };
  }, []);

  async function handleSaveContent(blocks: AnyBlock[], plainText: string) {
    await fetch(`/api/notes/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: blocks, content_text: plainText }),
    });

    // Debounced re-index, same 30s cadence NoteEditorPage.tsx uses — best
    // effort, never blocks the save.
    if (reindexDebounceRef.current) clearTimeout(reindexDebounceRef.current);
    reindexDebounceRef.current = setTimeout(() => {
      fetch("/api/internal/reindex-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_id: row.id }),
      }).catch(() => {
        // silent — reindex is best-effort
      });
    }, 30_000);
  }

  // Same write, same limitation, as RowGutter.tsx's row-menu "Add to
  // Favorites" (M9): `DatabaseRow` doesn't carry `is_favorited` on the rows
  // query, so this can only ever fire-and-forget — there is no current
  // state to read back and render a filled-vs-outline star from.
  async function favorite() {
    try {
      const res = await fetch(`/api/notes/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_favorited: true }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      showToast("Added to Favorites", "info");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not favorite this row", "error");
    }
  }

  if (typeof document === "undefined") return null;

  const isCenter = mode === "center";

  return createPortal(
    <div
      className={
        isCenter
          ? "fixed inset-0 z-[9999] flex items-center justify-center bg-black/30"
          // Non-modal: no backdrop, and the wrapper itself does not intercept
          // clicks — only the panel does — so the table stays interactive
          // underneath, matching Notion's own "Keeps the view behind
          // interactive" copy for this mode.
          : "fixed inset-0 z-[9999] flex justify-end pointer-events-none"
      }
      role="dialog"
      aria-modal={isCenter || undefined}
      aria-label="Row details"
      onClick={
        isCenter
          ? (e) => {
              if (e.target === e.currentTarget) onClose();
            }
          : undefined
      }
    >
      <div
        className={
          isCenter
            ? "max-h-[85vh] w-[min(90vw,880px)] rounded-lg bg-white dark:bg-gray-900 shadow-xl overflow-y-auto"
            : "pointer-events-auto h-full w-full max-w-2xl bg-white dark:bg-gray-900 shadow-xl overflow-y-auto"
        }
      >
        {/* row-peek.md's header bar: "»  ⤢          Share  ★  ⋯". `»`
          * collapses back to the table (same action as CLOSE on the row's
          * own OPEN/CLOSE toggle), `⤢` expands to the full page. Share and
          * the page `⋯` menu are disabled-with-a-reason, not built or
          * omitted outright — the spec's own instruction ("the ⋯ menu
          * reuses whatever our note page already has") turned out to have
          * nothing to reuse: no page-level menu exists anywhere in this app
          * yet, matching M9's own disabled-not-omitted convention for a
          * real, named gap. "Open in Workspace" has no Notion equivalent at
          * all — kept as an explicit additive control, not a parity gap. */}
        <div className="sticky top-0 flex items-center justify-between gap-2 px-4 py-2 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label="Close"
              title="Close"
              onClick={onClose}
              className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <X size={15} />
            </button>
            <button
              type="button"
              aria-label="Open as full page"
              title="Open as full page"
              onClick={() => router.push(`/brain/${row.id}`)}
              className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <Maximize2 size={13} />
            </button>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              aria-label="Share"
              title="Sharing isn't available yet"
              disabled
              className="flex h-6 w-6 items-center justify-center rounded text-gray-300 dark:text-gray-600 opacity-40"
            >
              <Share2 size={13} />
            </button>
            <button
              type="button"
              aria-label="Add to Favorites"
              title="Add to Favorites"
              onClick={favorite}
              className="flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800 dark:hover:text-gray-200"
            >
              <Star size={13} />
            </button>
            <button
              type="button"
              aria-label="More"
              title="The page menu isn't available yet"
              disabled
              className="flex h-6 w-6 items-center justify-center rounded text-gray-300 dark:text-gray-600 opacity-40"
            >
              <MoreHorizontal size={13} />
            </button>
            <button
              type="button"
              onClick={() => router.push(noteWorkspacePath(row.id))}
              className="ml-1 text-xs text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
            >
              Open in Workspace
            </button>
          </div>
        </div>

        <div className="px-6 py-4">
          {titleProperty && (
            <div className="text-xl font-semibold mb-4">
              {renderCellValue(
                titleProperty,
                row.properties[titleProperty.key],
                editable,
                (value) => onCellChange(row.id, titleProperty.key, value)
              )}
            </div>
          )}

          {(otherProperties.length > 0 || (editable && dataSourceId)) && (
            <div className="space-y-2 mb-6 pb-6 border-b border-gray-100 dark:border-gray-800">
              {otherProperties.map((property) => {
                const value = row.properties[property.key];
                // Clicking "Empty" activates the real control for this
                // render — it does not persist once a value lands (the row
                // re-renders as the real control on its own the moment
                // `value` stops being empty).
                const showEmptyPlaceholder = isEmptyPropertyValue(value) && activePropertyKey !== property.key;
                return (
                  <div key={property.key} className="grid grid-cols-[120px_1fr] items-center gap-3 text-sm">
                    <span className="flex items-center gap-1.5 text-gray-500 dark:text-gray-400 truncate">
                      <span className="shrink-0 text-gray-400 dark:text-gray-500">{propertyTypeIcon(property.type)}</span>
                      {property.name}
                    </span>
                    <div>
                      {showEmptyPlaceholder ? (
                        <button
                          type="button"
                          disabled={!editable}
                          onClick={() => setActivePropertyKey(property.key)}
                          className="w-full text-left text-gray-400 dark:text-gray-500 disabled:cursor-default"
                        >
                          Empty
                        </button>
                      ) : (
                        renderCellValue(property, value, editable, (v) => onCellChange(row.id, property.key, v))
                      )}
                    </div>
                  </div>
                );
              })}

              {/* row-peek.md: "Last row: + Add a property." Suppressed for a
                * read-only source (no `dataSourceId`/`!editable`) — same
                * States-table rule as the table header's own version. */}
              {editable && dataSourceId && (
                <div className="grid grid-cols-[120px_1fr] items-center gap-3 text-sm">
                  <span />
                  <AddPropertyPopover
                    dataSourceId={dataSourceId}
                    properties={properties}
                    onCreated={() => onPropertyCreated?.()}
                    columns={1}
                    scopeNote={SCOPE_NOTE}
                    triggerLabel="+ Add a property"
                  />
                </div>
              )}
            </div>
          )}

          {loaded ? (
            <BlockEditor noteId={row.id} initialContent={content} onSave={handleSaveContent} />
          ) : (
            <div className="h-48 animate-pulse bg-gray-50 dark:bg-gray-800 rounded-lg" />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
