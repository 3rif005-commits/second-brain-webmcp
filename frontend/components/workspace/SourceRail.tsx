"use client";

// The source rail: every source attached to this note, one compact row each.
// Add (file picker or pasted URL), select → viewer, retry a failed source,
// remove. Rows are ~36px so five sources still leave the viewer usable, and
// each one wears its source colour — the same colour its section chips and
// chat citations use elsewhere in the shell.
import { useEffect, useRef, useState } from "react";
import {
  FileText, Globe, Link2, PlaySquare, Plus, RefreshCw, Upload, Video, X,
} from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PromptDialog } from "@/components/ui/PromptDialog";
import { sourceColor, type NoteSource, type ResourceKind } from "@/lib/workspace";

const KIND_ICON = {
  youtube: PlaySquare,
  video: Video,
  website: Globe,
  pdf: FileText,
  document: FileText,
} as const satisfies Record<ResourceKind, unknown>;

/** The source's colour chip — and its status, told through that same chip. */
function KindTile({ source }: { source: NoteSource }) {
  const Icon = KIND_ICON[source.kind] ?? FileText;
  const color = sourceColor(source.order_index);

  if (source.status === "failed") {
    return (
      <span className="shrink-0 w-6 h-6 rounded-lg flex items-center justify-center
        bg-red-500/12 text-red-500 ring-1 ring-red-500/25">
        <Icon size={13} />
      </span>
    );
  }
  const working = source.status !== "ready";
  return (
    <span
      className={`shrink-0 w-6 h-6 rounded-lg flex items-center justify-center transition-opacity ${
        working ? "opacity-50" : ""}`}
      style={{ backgroundColor: `${color}22`, color, boxShadow: `inset 0 0 0 1px ${color}33` }}
    >
      <Icon size={13} />
    </span>
  );
}

interface SourceRailProps {
  sources: NoteSource[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAddFiles: (files: File[]) => void;
  onAddUrl: (url: string) => void;
  onRemove: (s: NoteSource) => void;
  onRetry: (s: NoteSource) => void;
  busy?: boolean;
}

export function SourceRail({
  sources, activeId, onSelect, onAddFiles, onAddUrl, onRemove, onRetry, busy,
}: SourceRailProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [showUrl, setShowUrl] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<NoteSource | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showAdd) return;
    function onDown(e: MouseEvent) {
      if (!addMenuRef.current?.contains(e.target as Node)) setShowAdd(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showAdd]);

  return (
    <div className="shrink-0 max-h-[38%] flex flex-col border-b border-gray-100 dark:border-white/5">
      <div className="flex items-center justify-between pl-3.5 pr-2 pt-2.5 pb-1 shrink-0">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400">
          Sources
          {sources.length > 0 && (
            <span className="px-1.5 py-px rounded-full bg-gray-100 dark:bg-white/10 text-gray-500 dark:text-gray-400 tracking-normal">
              {sources.length}
            </span>
          )}
        </span>
        <div className="relative" ref={addMenuRef}>
          <button
            onClick={() => setShowAdd((v) => !v)}
            disabled={busy}
            title="Add a source"
            className="inline-flex items-center gap-1 h-7 pl-1.5 pr-2.5 rounded-full text-[11.5px] font-medium
              text-gray-500 dark:text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-300
              hover:bg-indigo-500/10 disabled:opacity-40 transition-colors
              focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            {busy
              ? <span className="w-3.5 h-3.5 m-[1px] rounded-full border-2 border-current border-t-transparent animate-spin" />
              : <Plus size={15} />}
            {busy ? "Adding…" : "Add"}
          </button>
          {showAdd && (
            <div className="ws-glass ws-rise absolute right-0 top-full mt-1.5 w-60 z-30 rounded-2xl p-1 overflow-hidden">
              <button
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left text-[12.5px]
                  text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                onClick={() => { setShowAdd(false); fileInputRef.current?.click(); }}
              >
                <span className="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
                  <Upload size={14} />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Upload a file</span>
                  <span className="block text-[11px] text-gray-400">PDF, Markdown, text, video</span>
                </span>
              </button>
              <button
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left text-[12.5px]
                  text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                onClick={() => { setShowAdd(false); setShowUrl(true); }}
              >
                <span className="w-7 h-7 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
                  <Link2 size={14} />
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">Paste a link</span>
                  <span className="block text-[11px] text-gray-400">Article or YouTube video</span>
                </span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-0.5">
        {sources.length === 0 && (
          <p className="px-1.5 pb-2 text-[11.5px] leading-relaxed text-gray-400">
            Drop a PDF, a video, or paste a link anywhere in this panel.
          </p>
        )}
        {sources.map((s) => {
          const active = s.id === activeId;
          const working = s.status === "queued" || s.status === "processing";
          return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              aria-current={active}
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(s.id);
                }
              }}
              className={`group relative flex items-center gap-2.5 h-9 pl-2 pr-1.5 rounded-xl cursor-pointer
                overflow-hidden transition-all duration-150 ${
                active
                  ? "bg-indigo-500/[0.09] ring-1 ring-inset ring-indigo-500/20"
                  : "hover:bg-black/[0.035] dark:hover:bg-white/[0.05]"
              } focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400`}
            >
              <KindTile source={s} />
              <span
                className={`flex-1 min-w-0 truncate text-[12.5px] ${
                  active
                    ? "text-indigo-700 dark:text-indigo-200 font-medium"
                    : "text-gray-700 dark:text-gray-300"
                }`}
                title={s.error ? `Failed: ${s.error}` : s.title}
              >
                {s.title}
              </span>

              {s.status === "processing" && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-500">
                  reading
                </span>
              )}
              {s.status === "failed" && (
                <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-red-500">
                  failed
                </span>
              )}
              {(s.status === "queued" || s.status === "failed") && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRetry(s); }}
                  title={s.status === "failed"
                    ? (s.error ?? "Retry")
                    : "Queued — click to start processing"}
                  className={`shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-colors ${
                    s.status === "failed"
                      ? "text-red-400 hover:text-red-600 hover:bg-red-500/10"
                      : "text-gray-400 hover:text-indigo-500 hover:bg-indigo-500/10"}`}
                >
                  <RefreshCw size={12} />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); setPendingRemove(s); }}
                title="Remove this source"
                className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg opacity-0
                  group-hover:opacity-100 focus:opacity-100 text-gray-400 hover:text-red-500
                  hover:bg-red-500/10 transition-all"
              >
                <X size={12} />
              </button>

              {/* still being read — an indeterminate sliver along the bottom edge */}
              {working && (
                <span className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden">
                  <span className="ws-indeterminate block h-full w-full bg-gradient-to-r from-transparent via-amber-400 to-transparent" />
                </span>
              )}
            </div>
          );
        })}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.md,.txt,.mp4,.webm,.mov,.mkv,.m4v"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onAddFiles(files);
        }}
      />
      <PromptDialog
        open={showUrl}
        title="Add a source URL"
        label="URL"
        placeholder="https://… (website or YouTube video)"
        confirmLabel="Add"
        onSubmit={(v) => { setShowUrl(false); if (v.trim()) onAddUrl(v.trim()); }}
        onCancel={() => setShowUrl(false)}
      />
      <ConfirmDialog
        open={pendingRemove !== null}
        title={`Remove "${pendingRemove?.title ?? ""}"?`}
        description="It is detached from this note and its extracted data is deleted. Your note keeps everything you already wrote."
        confirmLabel="Remove"
        onConfirm={() => {
          const s = pendingRemove;
          setPendingRemove(null);
          if (s) onRemove(s);
        }}
        onCancel={() => setPendingRemove(null)}
      />
    </div>
  );
}
