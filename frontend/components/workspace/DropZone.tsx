"use client";

// Empty state of the workspace shell: one drop target, and a recents strip so a
// session can be resumed without a sidebar section to maintain.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight, FileText, FileUp, Globe, Link2, PlaySquare, Sparkles,
} from "lucide-react";
import { PromptDialog } from "@/components/ui/PromptDialog";
import { wsApi, type RecentSession } from "@/lib/workspace";

interface DropZoneProps {
  onAddFiles: (files: File[]) => void;
  onAddUrl: (url: string) => void;
  busy?: boolean;
}

export function DropZone({ onAddFiles, onAddUrl, busy }: DropZoneProps) {
  const router = useRouter();
  const [recents, setRecents] = useState<RecentSession[]>([]);
  const [showUrl, setShowUrl] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    wsApi.recentSessions().then(setRecents).catch(() => {});
  }, []);

  return (
    <div className="h-full overflow-y-auto flex flex-col items-center justify-center gap-9 px-6 py-12">
      <div className="w-full max-w-lg text-center">
        {/* the three source kinds, fanned out */}
        <div className="flex items-end justify-center mb-6 h-16">
          <span className="w-12 h-12 rounded-2xl ws-panel flex items-center justify-center
            text-rose-500 -rotate-[12deg] translate-x-1 translate-y-1.5">
            <PlaySquare size={20} />
          </span>
          <span className="w-14 h-14 rounded-2xl ws-panel flex items-center justify-center
            text-indigo-500 z-10 shadow-lg">
            <FileText size={22} />
          </span>
          <span className="w-12 h-12 rounded-2xl ws-panel flex items-center justify-center
            text-emerald-500 rotate-[12deg] -translate-x-1 translate-y-1.5">
            <Globe size={20} />
          </span>
        </div>

        <h1 className="text-[22px] font-semibold tracking-tight text-gray-900 dark:text-gray-50">
          Bring in what you’re studying
        </h1>
        <p className="mt-2 mx-auto max-w-md text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
          PDFs, notes, videos, YouTube links, articles — as many as you like.
          They all feed <span className="text-gray-700 dark:text-gray-200 font-medium">one note</span>,
          written for you the moment the last one finishes.
        </p>

        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="ws-accent inline-flex items-center gap-2 h-10 px-5 rounded-full text-[13px] font-semibold
              transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100
              focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2"
          >
            {busy
              ? <span className="w-4 h-4 rounded-full border-2 border-white/60 border-t-transparent animate-spin" />
              : <FileUp size={16} />}
            {busy ? "Uploading…" : "Choose files"}
          </button>
          <button
            onClick={() => setShowUrl(true)}
            disabled={busy}
            className="inline-flex items-center gap-2 h-10 px-5 rounded-full text-[13px] font-medium
              text-gray-700 dark:text-gray-200 bg-white/70 dark:bg-white/[0.06]
              ring-1 ring-gray-200/80 dark:ring-white/10 hover:bg-white dark:hover:bg-white/10
              transition-all duration-150 active:scale-[0.98] disabled:opacity-50
              focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <Link2 size={16} /> Paste a link
          </button>
        </div>

        <p className="mt-4 text-[11.5px] text-gray-400">
          …or just drag them anywhere on this page
        </p>
      </div>

      {recents.length > 0 && (
        <div className="w-full max-w-lg">
          <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400 mb-2.5">
            <Sparkles size={11} /> Pick up where you left off
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {recents.map((r) => (
              <button
                key={r.note_id}
                onClick={() => router.push(`/brain/workspace/${r.note_id}`)}
                className="group ws-panel flex items-center gap-2.5 h-12 px-3 rounded-2xl text-left
                  hover:-translate-y-px hover:border-indigo-300/70 dark:hover:border-indigo-500/40
                  transition-all duration-150
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-gray-800 dark:text-gray-100">
                    {r.title}
                  </span>
                  <span className="block text-[11px] text-gray-400">
                    {r.source_count} source{r.source_count === 1 ? "" : "s"}
                  </span>
                </span>
                <ArrowRight
                  size={14}
                  className="shrink-0 text-gray-300 dark:text-gray-600 group-hover:text-indigo-500
                    group-hover:translate-x-0.5 transition-all"
                />
              </button>
            ))}
          </div>
        </div>
      )}

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
    </div>
  );
}
