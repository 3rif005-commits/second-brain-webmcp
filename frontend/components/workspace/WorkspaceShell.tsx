"use client";

// The compact workspace shell: one note, the sources attached to it, and every
// tool that acts on them — in one tight layout. Left column = source rail +
// viewer (resizable, remembered); right column = the note in the ordinary block
// editor; chat is a drawer over the note, never a third column.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle, ArrowLeft, Check, ExternalLink, MessageSquare, Pencil,
  RefreshCw, Sparkles, Upload, X,
} from "lucide-react";
import { useToast } from "@/app/providers";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { sourceColor, wsApi, type Citation, type NoteSource, type SendAction } from "@/lib/workspace";
import { DropZone } from "./DropZone";
import { NotePane, type NoteApplyApi, type NoteData } from "./NotePane";
import { SourceRail } from "./SourceRail";
import { SourceViewer } from "./SourceViewer";
import { useSynthesis } from "./useSynthesis";
import { WorkspaceChat } from "./WorkspaceChat";

const SPLIT_KEY = "workspace:splitPct";

interface WorkspaceShellProps {
  noteId: string | null;
}

/** What the shell is doing right now, in the header's meta line. */
function StatusNote({ saving, saved, synthesizing }: {
  saving: boolean; saved: boolean; synthesizing: boolean;
}) {
  if (synthesizing) {
    return (
      <span className="flex items-center gap-1 shrink-0 text-indigo-500 dark:text-indigo-400">
        <span className="text-gray-300 dark:text-gray-700">·</span>
        <Sparkles size={10} className="animate-pulse" />
        <span className="ws-shimmer font-medium">Writing the note…</span>
      </span>
    );
  }
  if (saving) {
    return (
      <span className="flex items-center gap-1 shrink-0">
        <span className="text-gray-300 dark:text-gray-700">·</span>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        Saving…
      </span>
    );
  }
  if (saved) {
    return (
      <span className="flex items-center gap-1 shrink-0 text-emerald-500">
        <span className="text-gray-300 dark:text-gray-700">·</span>
        <Check size={11} /> Saved
      </span>
    );
  }
  return null;
}

/** Full-bleed invitation shown while something is being dragged over the shell. */
function DropOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="ws-rise pointer-events-none absolute inset-0 z-50 flex items-center justify-center
      bg-indigo-500/[0.06] backdrop-blur-[2px] p-6">
      <div className="ws-glass flex flex-col items-center gap-1.5 px-10 py-8 rounded-3xl
        !border-2 !border-dashed !border-indigo-400/70">
        <span className="ws-accent w-12 h-12 rounded-2xl flex items-center justify-center mb-1">
          <Upload size={20} />
        </span>
        <p className="text-sm font-semibold text-gray-900 dark:text-gray-50">
          Drop to add sources
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          PDFs, notes, videos or a link — they all feed this one note
        </p>
      </div>
    </div>
  );
}

export function WorkspaceShell({ noteId }: WorkspaceShellProps) {
  const router = useRouter();
  const search = useSearchParams();
  const { showToast } = useToast();

  const [note, setNote] = useState<NoteData | null>(null);
  const [sources, setSources] = useState<NoteSource[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [splitPct, setSplitPct] = useState(45);

  const seekRef = useRef<((value: number) => void) | null>(null);
  const actionSinkRef = useRef<((a: SendAction) => void) | null>(null);
  const positionSinkRef = useRef<((value: number) => void) | null>(null);
  const applyRef = useRef<NoteApplyApi | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // dragenter/dragleave fire for every child element the pointer crosses, so a
  // plain boolean makes the drop overlay strobe. Count the depth instead.
  const dragDepth = useRef(0);

  const syn = useSynthesis({ noteId, sources, applyRef });

  // ── load ──────────────────────────────────────────────────────────────────
  const loadSources = useCallback(async () => {
    if (!noteId) return;
    const rows = await wsApi.listSources(noteId).catch(() => null);
    if (rows) setSources(rows);
  }, [noteId]);

  useEffect(() => {
    if (!noteId) { setNote(null); setSources([]); return; }
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/notes/${noteId}`);
      if (!res.ok || cancelled) return;
      const n = await res.json();
      setNote({ id: n.id, title: n.title ?? "Untitled", content: n.content ?? [] });
    })();
    loadSources();
    return () => { cancelled = true; };
  }, [noteId, loadSources]);

  // poll while any source is still working
  const pending = sources.some((s) => s.status === "queued" || s.status === "processing");
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(loadSources, 2000);
    return () => clearInterval(timer);
  }, [pending, loadSources]);

  // pick a sensible active source
  useEffect(() => {
    if (activeId && sources.some((s) => s.id === activeId)) return;
    const firstReady = sources.find((s) => s.status === "ready") ?? sources[0];
    setActiveId(firstReady?.id ?? null);
  }, [sources, activeId]);

  // the note's title can be upgraded server-side when the draft lands
  useEffect(() => {
    if (!noteId || syn.synthesis?.status !== "ready") return;
    fetch(`/api/notes/${noteId}`).then((r) => r.ok ? r.json() : null).then((n) => {
      if (n?.title) setNote((prev) => prev ? { ...prev, title: n.title } : prev);
    }).catch(() => {});
  }, [noteId, syn.synthesis?.status]);

  // A brief "Saved" after every autosave settles — otherwise the header goes
  // silent the moment the work finishes and the save reads as never happening.
  const wasSaving = useRef(false);
  useEffect(() => {
    const settled = wasSaving.current && !saving;
    wasSaving.current = saving;
    if (!settled) return;
    setSavedFlash(true);
    const timer = setTimeout(() => setSavedFlash(false), 2000);
    return () => clearTimeout(timer);
  }, [saving]);

  // ── split divider ─────────────────────────────────────────────────────────
  useEffect(() => {
    const stored = Number(window.localStorage.getItem(SPLIT_KEY));
    if (stored >= 25 && stored <= 70) setSplitPct(stored);
  }, []);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !containerRef.current) return;
      const box = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - box.left) / box.width) * 100;
      setSplitPct(Math.min(70, Math.max(25, pct)));
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      setSplitPct((p) => { window.localStorage.setItem(SPLIT_KEY, String(Math.round(p))); return p; });
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // ── add / remove sources ──────────────────────────────────────────────────
  const addInputs = useCallback(async (
    items: { file?: File; url?: string }[]
  ) => {
    setBusy(true);
    const defer = items.length > 1;
    let landed = noteId;
    for (const item of items) {
      try {
        const r = await wsApi.addSource({ ...item, noteId: landed, defer });
        landed = r.note_id;
      } catch (e) {
        showToast(e instanceof Error ? e.message
          : `Could not add ${item.file?.name ?? item.url ?? "source"}`);
      }
    }
    // Deferred attaches are inert until this call. If it fails, the sources are
    // safely attached but idle, so say so and leave the rail's retry to restart them.
    if (defer && landed) {
      try {
        await wsApi.processSources(landed);
      } catch {
        showToast("Sources attached, but processing didn’t start — use the retry "
                  + "arrow on a source to begin.");
      }
    }
    setBusy(false);
    if (!noteId && landed) router.replace(`/brain/workspace/${landed}`);
    else await loadSources();
  }, [noteId, router, loadSources, showToast]);

  const addFiles = useCallback((files: File[]) =>
    addInputs(files.map((file) => ({ file }))), [addInputs]);
  const addUrl = useCallback((url: string) =>
    addInputs([{ url }]), [addInputs]);

  const removeSource = useCallback(async (s: NoteSource) => {
    await wsApi.deleteSource(s.id).catch((e) =>
      showToast(e instanceof Error ? e.message : "Could not remove that source"));
    if (activeId === s.id) setActiveId(null);
    await loadSources();
  }, [activeId, loadSources, showToast]);

  const retrySource = useCallback(async (s: NoteSource) => {
    await wsApi.reprocessSource(s.id).catch(() => {});
    await loadSources();
  }, [loadSources]);

  // ── whole-shell drag & drop ───────────────────────────────────────────────
  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) { addFiles(files); return; }
    const text = e.dataTransfer.getData("text/uri-list")
      || e.dataTransfer.getData("text/plain");
    if (text?.startsWith("http")) addUrl(text.trim());
  }, [addFiles, addUrl]);

  const dragProps = useMemo(() => ({
    onDragEnter: () => { dragDepth.current += 1; setDragOver(true); },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragOver(false);
    },
    onDrop,
  }), [onDrop]);

  // ── deep link: ?source=<id>&t=|p=|s= ──────────────────────────────────────
  const deepLink = useMemo(() => {
    const sid = search.get("source");
    if (!sid) return null;
    const t = search.get("t"), p = search.get("p"), s = search.get("s");
    const raw = t ?? p ?? s;
    return { sid, value: raw !== null ? parseFloat(raw) : null };
  }, [search]);

  const deepLinkKey = deepLink ? `${deepLink.sid}:${deepLink.value ?? ""}` : null;
  const handledDeepLink = useRef<string | null>(null);

  useEffect(() => {
    if (!deepLink || !deepLinkKey || handledDeepLink.current === deepLinkKey) return;
    if (!sources.some((s) => s.id === deepLink.sid)) return;
    handledDeepLink.current = deepLinkKey;
    if (deepLink.sid !== activeId) seekRef.current = null;
    setActiveId(deepLink.sid);
    if (deepLink.value === null || Number.isNaN(deepLink.value)) return;
    const timer = setInterval(() => {
      if (seekRef.current) {
        seekRef.current(deepLink.value as number);
        clearInterval(timer);
      }
    }, 300);
    const stop = setTimeout(() => clearInterval(timer), 15000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, [deepLink, deepLinkKey, sources, activeId]);

  // Switching sources swaps the viewer, and the outgoing viewer's seek function
  // is still in the ref at that instant — so a naive setActiveId-then-seek either
  // seeks the pane that is unmounting or is lost. Clear the ref at the switch and
  // wait for the incoming viewer to register its own.
  const seekWhenReady = useCallback((value: number) => {
    if (seekRef.current) { seekRef.current(value); return; }
    const timer = setInterval(() => {
      if (seekRef.current) { seekRef.current(value); clearInterval(timer); }
    }, 200);
    setTimeout(() => clearInterval(timer), 8000);
  }, []);

  const selectAndSeek = useCallback((sourceId: string, value: number) => {
    if (sourceId !== activeId) {
      seekRef.current = null;
      setActiveId(sourceId);
    }
    seekWhenReady(value);
  }, [activeId, seekWhenReady]);

  const handleCitation = useCallback((c: Citation) => {
    selectAndSeek(c.resource_id, c.anchor_start);
  }, [selectAndSeek]);

  // ── title ─────────────────────────────────────────────────────────────────
  async function saveTitle() {
    const next = (titleDraft ?? "").trim();
    setTitleDraft(null);
    if (!note || !next || next === note.title) return;
    setNote({ ...note, title: next });
    await fetch(`/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next }),
    }).catch(() => {});
  }

  const activeSource = sources.find((s) => s.id === activeId) ?? null;
  const colorIndex = useMemo(
    () => new Map(sources.map((s) => [s.id, s.order_index])), [sources]);

  // ── empty shell ───────────────────────────────────────────────────────────
  if (!noteId || !note) {
    return (
      <div className="ws-canvas relative h-full" {...dragProps}>
        {noteId ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-gray-400">
            <span className="w-5 h-5 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
            Opening your session…
          </div>
        ) : (
          <DropZone onAddFiles={addFiles} onAddUrl={addUrl} busy={busy} />
        )}
        <DropOverlay show={dragOver} />
      </div>
    );
  }

  return (
    <div className="ws-canvas relative h-full flex flex-col" {...dragProps}>
      {/* header */}
      <header className="flex items-center gap-2 pl-3 pr-3 h-[52px] shrink-0 group-data-[sidebar=collapsed]/shell:pl-12">
        <button
          onClick={() => router.push("/brain/workspace")}
          title="Start a new session"
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-xl text-gray-400
            hover:text-gray-800 dark:hover:text-gray-100 hover:bg-black/5 dark:hover:bg-white/5
            transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <ArrowLeft size={16} />
        </button>

        <div className="min-w-0 flex-1 flex flex-col justify-center">
          {titleDraft !== null ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); }}
              className="w-full text-[15px] font-semibold tracking-tight bg-transparent outline-none
                text-gray-900 dark:text-gray-50 border-b-2 border-indigo-500 pb-px"
            />
          ) : (
            <button
              onClick={() => setTitleDraft(note.title)}
              title="Rename this note"
              className="group/title flex items-center gap-1.5 min-w-0 text-left"
            >
              <span className="truncate text-[15px] font-semibold tracking-tight text-gray-900 dark:text-gray-50">
                {note.title}
              </span>
              <Pencil
                size={12}
                className="shrink-0 text-gray-300 dark:text-gray-600 opacity-0 group-hover/title:opacity-100 transition-opacity"
              />
            </button>
          )}
          <div className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500 leading-none mt-0.5">
            {sources.length > 0 && (
              <span className="flex items-center -space-x-0.5 shrink-0">
                {sources.slice(0, 5).map((s) => (
                  <span
                    key={s.id}
                    className="w-2 h-2 rounded-full ring-2 ring-[#f3f4f6] dark:ring-[#0a0c12]"
                    style={{ backgroundColor: sourceColor(s.order_index) }}
                  />
                ))}
              </span>
            )}
            <span className="shrink-0">
              {sources.length} source{sources.length === 1 ? "" : "s"}
            </span>
            <StatusNote saving={saving} saved={savedFlash} synthesizing={syn.running} />
          </div>
        </div>

        <button
          onClick={syn.requestSynthesis}
          disabled={syn.running || syn.readyCount === 0}
          title="Rewrite the note from the current sources"
          className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12px] font-medium
            transition-all duration-150 active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100
            focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
            syn.stale
              ? "ws-accent"
              : "text-gray-500 dark:text-gray-400 border border-gray-200/80 dark:border-white/10 hover:bg-white dark:hover:bg-white/5 hover:text-gray-800 dark:hover:text-gray-100"
          }`}
        >
          {syn.running
            ? <RefreshCw size={12} className="animate-spin" />
            : syn.stale ? <Sparkles size={12} /> : <RefreshCw size={12} />}
          {syn.stale
            ? `Re-synthesize · ${syn.readyCount}`
            : "Re-synthesize"}
        </button>
        <button
          onClick={() => setChatOpen((v) => !v)}
          title="Ask about these sources"
          className={`shrink-0 w-8 h-8 flex items-center justify-center rounded-xl transition-colors
            focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${
            chatOpen
              ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 ring-1 ring-indigo-500/25"
              : "text-gray-400 hover:text-gray-800 dark:hover:text-gray-100 hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          <MessageSquare size={15} />
        </button>
        <a
          href={`/brain/${note.id}`}
          title="Open this note on its own page"
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-xl text-gray-400
            hover:text-gray-800 dark:hover:text-gray-100 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <ExternalLink size={15} />
        </a>
      </header>

      {/* synthesis failure banner */}
      {syn.synthesis?.status === "failed" && syn.synthesis.error && (
        <div className="ws-rise mx-2 mb-2 flex items-center gap-2 px-3 py-2 rounded-xl text-[12px]
          bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200
          ring-1 ring-amber-200 dark:ring-amber-900/60 shrink-0">
          <AlertTriangle size={14} className="shrink-0 text-amber-500" />
          <span className="flex-1 min-w-0 truncate">
            Couldn’t write the note: {syn.synthesis.error}
          </span>
          <button
            onClick={syn.requestSynthesis}
            className="shrink-0 px-2 py-0.5 rounded-full font-medium bg-amber-500/15 hover:bg-amber-500/25 transition-colors"
          >
            Retry
          </button>
          <button
            onClick={syn.dismissError}
            title="Dismiss"
            className="shrink-0 w-5 h-5 flex items-center justify-center rounded-full hover:bg-amber-500/20 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* body */}
      <div ref={containerRef} className="flex-1 min-h-0 flex px-2 pb-2">
        <div
          className="ws-panel flex flex-col min-w-0 rounded-2xl overflow-hidden"
          style={{ width: `${splitPct}%` }}
        >
          <SourceRail
            sources={sources}
            activeId={activeId}
            onSelect={setActiveId}
            onAddFiles={addFiles}
            onAddUrl={addUrl}
            onRemove={removeSource}
            onRetry={retrySource}
            busy={busy}
          />
          <div className="flex-1 min-h-0 flex flex-col">
            <SourceViewer
              source={activeSource}
              onPosition={(v) => positionSinkRef.current?.(v)}
              onAction={(a) => actionSinkRef.current?.(a)}
              seekRef={seekRef}
            />
          </div>
        </div>

        <div
          onMouseDown={() => { draggingRef.current = true; document.body.style.cursor = "col-resize"; }}
          className="group/split w-2 shrink-0 cursor-col-resize flex items-center justify-center"
          title="Drag to resize"
        >
          <span className="w-[3px] h-8 rounded-full bg-gray-300/0 dark:bg-white/0
            group-hover/split:bg-indigo-400 dark:group-hover/split:bg-indigo-500 transition-colors" />
        </div>

        <div className="ws-panel relative flex-1 min-w-0 rounded-2xl overflow-hidden">
          <NotePane
            note={note}
            sources={sources}
            activeSourceId={activeId}
            onJump={selectAndSeek}
            actionSinkRef={actionSinkRef}
            positionSinkRef={positionSinkRef}
            applyRef={applyRef}
            onApplied={() => {}}
            onSavingChange={setSaving}
          />
          {chatOpen && (
            <WorkspaceChat
              noteId={note.id}
              colorIndex={colorIndex}
              onCitation={handleCitation}
              onClose={() => setChatOpen(false)}
            />
          )}
        </div>
      </div>

      <DropOverlay show={dragOver} />

      {/* ConfirmDialog fires onCancel for both its cancel button and a backdrop
          click, so "add at the end" is also what a dismissal does. That is the
          non-destructive branch, which is the important half; a true third
          "do nothing" exit would need a variant of the shared dialog. */}
      <ConfirmDialog
        open={syn.askMode}
        title="This note has your own edits in it"
        description="Replace everything with the new draft, or keep what you wrote and add the new draft at the end? Closing this leaves your note untouched."
        confirmLabel="Replace everything"
        cancelLabel="Keep my note, add at the end"
        danger
        onConfirm={() => syn.chooseMode("replace")}
        onCancel={() => syn.chooseMode("append")}
      />
    </div>
  );
}
