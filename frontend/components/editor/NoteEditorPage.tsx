"use client";

import React, { Component, useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ChevronRight, Link, Check, Layers } from "lucide-react";
import type { Note } from "@/lib/types/database";
import { Button } from "@/components/ui/button";
import { wsApi } from "@/lib/workspace";
import { NoteProperties } from "./NoteProperties";
import { DatabaseRowProperties } from "../database/DatabaseRowProperties";
import { BacklinksPanel } from "./BacklinksPanel";
import { InteractiveBlockCard } from "./InteractiveBlockCard";
import type { BlockEditorHandle, InteractiveBlock } from "./BlockEditor";

const EMOJIS = [
  "📄","📝","📋","📌","📍","📎","🔗","📚","📖","📕","📗","📘","📙","🗒️","🗓️",
  "📅","📆","🗃️","🗂️","📁","📂","📊","📈","📉","💡","🎯","⭐","✨","🔥","💎",
  "🏆","🥇","🎖️","🧠","🔬","🔭","🧪","⚗️","⚙️","🛠️","🔑","🔒","🚀","🎨","🎭",
  "🎬","🎵","🎸","🎹","❤️","🧡","💛","💚","💙","💜","🌍","🌱","🌸","🌊","⚡","☀️",
];

// Cast to support forwardRef after dynamic import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BlockEditor = dynamic(
  () => import("./BlockEditor").then((m) => m.BlockEditor),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-gray-50 dark:bg-gray-800 rounded-lg" /> }
) as React.ForwardRefExoticComponent<
  React.ComponentProps<typeof import("./BlockEditor").BlockEditor> &
    React.RefAttributes<BlockEditorHandle>
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

interface EditorErrorBoundaryProps {
  onClear: () => void;
  children: React.ReactNode;
}
interface EditorErrorBoundaryState { error: Error | null }

class EditorErrorBoundary extends Component<EditorErrorBoundaryProps, EditorErrorBoundaryState> {
  state: EditorErrorBoundaryState = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-gray-500 dark:text-gray-400">
          <p className="text-sm">Note content couldn't be loaded (corrupted block data).</p>
          <button
            onClick={this.props.onClear}
            className="text-xs px-3 py-1.5 rounded-md bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/40 transition-colors"
          >
            Clear content and start fresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface NoteEditorPageProps {
  note: Note;
  collectionName?: string;
}

export function NoteEditorPage({ note, collectionName }: NoteEditorPageProps) {
  const router = useRouter();
  const editorRef = useRef<BlockEditorHandle>(null);
  const [title, setTitle] = useState(note.title);
  const [icon, setIcon] = useState(note.icon || "📄");
  const [isPublic, setIsPublic] = useState(note.is_public ?? false);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [ingestHtml, setIngestHtml] = useState<string | undefined>();
  const [interactiveBlocks, setInteractiveBlocks] = useState<InteractiveBlock[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      return JSON.parse(localStorage.getItem(`interactive-${note.id}`) ?? "[]");
    } catch { return []; }
  });
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [sourceCount, setSourceCount] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const emojiRef = useRef<HTMLDivElement>(null);
  const titleDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reindexDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A note with sources attached can be reopened in the workspace shell — the
  // other half of "how do I get back to a session?" (the first half is the
  // recents strip in the empty shell).
  useEffect(() => {
    wsApi.listSources(note.id)
      .then((rows) => setSourceCount(rows.length))
      .catch(() => setSourceCount(0));
  }, [note.id]);

  useEffect(() => {
    const key = `ingest-pending-${note.id}`;
    const html = sessionStorage.getItem(key);
    if (html) {
      sessionStorage.removeItem(key);
      setIngestHtml(html);
    }
  }, [note.id]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    if (showMenu) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [showMenu]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
    }
    if (showEmojiPicker) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [showEmojiPicker]);

  async function persistTitle(val: string) {
    await fetch(`/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: val }),
    });
    window.dispatchEvent(new Event("notes-changed"));
  }

  async function selectEmoji(emoji: string) {
    setIcon(emoji);
    setShowEmojiPicker(false);
    await fetch(`/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon: emoji }),
    });
    window.dispatchEvent(new Event("notes-changed"));
  }

  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setTitle(val);
    if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
    titleDebounceRef.current = setTimeout(() => persistTitle(val), 600);
  }

  function handleTitleBlur() {
    if (titleDebounceRef.current) clearTimeout(titleDebounceRef.current);
    persistTitle(title);
  }

  const handleSaveContent = useCallback(
    async (blocks: AnyBlock[], plainText: string) => {
      setSaving(true);
      await fetch(`/api/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: blocks, content_text: plainText }),
      });
      setSaving(false);
      setLastSaved(new Date());

      // Debounce re-index: fire 30s after last block change
      if (reindexDebounceRef.current) clearTimeout(reindexDebounceRef.current);
      reindexDebounceRef.current = setTimeout(() => {
        fetch("/api/internal/reindex-note", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note_id: note.id }),
        }).catch(() => {
          // silent — reindex is best-effort
        });
      }, 30_000);
    },
    [note.id]
  );

  async function confirmDelete() {
    setShowDeleteModal(false);
    await fetch(`/api/notes/${note.id}`, { method: "DELETE" });
    window.dispatchEvent(new Event("notes-changed"));
    router.push("/brain");
    router.refresh();
  }

  async function togglePublic() {
    const next = !isPublic;
    setIsPublic(next);
    await fetch(`/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_public: next }),
    });
  }

  async function copyShareLink() {
    const url = `${window.location.origin}/share/${note.id}`;
    await navigator.clipboard.writeText(url);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  function handleExportMarkdown() {
    setShowMenu(false);
    editorRef.current?.exportMarkdown(title || "note");
  }

  function handleExportPdf() {
    setShowMenu(false);
    window.print();
  }

  return (
    <>
      <div className="print-scroll flex flex-col h-full bg-white dark:bg-gray-900 transition-colors">
        {/* Toolbar */}
        <div className="no-print flex items-center justify-between px-5 py-2.5 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900 shrink-0">
          {/* Left: back (mobile) + save status */}
          <div className="flex items-center gap-3">
            <button
              className="md:hidden p-1 rounded-md text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              onClick={() => router.push("/brain")}
              aria-label="Back to notes"
            >
              ←
            </button>
            <span className="text-xs text-gray-400">
              {saving
                ? "Saving…"
                : lastSaved
                ? `Saved ${lastSaved.toLocaleTimeString()}`
                : ingestHtml
                ? "Applying…"
                : ""}
            </span>
            {sourceCount > 0 && (
              <button
                onClick={() => router.push(`/brain/workspace/${note.id}`)}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                title="Open this note beside its sources"
              >
                <Layers size={12} />
                Open sources ({sourceCount})
              </button>
            )}
          </div>

          {/* Right: options menu */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setShowMenu((v) => !v)}
              aria-label="Note options"
              aria-expanded={showMenu}
              aria-haspopup="menu"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-base font-bold tracking-widest leading-none"
            >
              ···
            </button>
            {showMenu && (
              <div
                role="menu"
                className="absolute right-0 top-full mt-1.5 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg z-50 py-1 overflow-hidden"
              >
                {/* Export section */}
                <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
                  Export
                </div>
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  onClick={handleExportMarkdown}
                >
                  Export as Markdown
                </button>
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                  onClick={handleExportPdf}
                >
                  Export as PDF
                </button>

                {/* Divider */}
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />

                {/* Share section */}
                <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest">
                  Share
                </div>
                <div className="px-3 py-2 flex items-center justify-between">
                  <span className="text-sm text-gray-700 dark:text-gray-200">Public link</span>
                  <button
                    onClick={togglePublic}
                    aria-pressed={isPublic}
                    className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                      isPublic ? "bg-indigo-500" : "bg-gray-300 dark:bg-gray-600"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform ${
                        isPublic ? "translate-x-[18px]" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </div>
                {isPublic && (
                  <button
                    role="menuitem"
                    className="w-full text-left px-3 py-2 text-sm text-indigo-600 dark:text-indigo-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
                    onClick={copyShareLink}
                  >
                    {linkCopied ? <Check size={13} /> : <Link size={13} />}
                    {linkCopied ? "Copied!" : "Copy link"}
                  </button>
                )}

                {/* Divider */}
                <div className="my-1 border-t border-gray-100 dark:border-gray-700" />

                {/* Danger zone */}
                <button
                  role="menuitem"
                  className="w-full text-left px-3 py-2.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                  onClick={() => {
                    setShowMenu(false);
                    setShowDeleteModal(true);
                  }}
                >
                  Delete note
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Scrollable content */}
        <div className="print-scroll flex-1 overflow-y-auto min-h-0 bg-white dark:bg-gray-900">
          <div className="print-content max-w-3xl mx-auto px-6 py-8">
            {/* Breadcrumb */}
            <div className="no-print flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 mb-4 flex-wrap">
              <span>My Brain</span>
              {collectionName && (
                <>
                  <ChevronRight size={11} className="text-gray-300 shrink-0" />
                  <span>{collectionName}</span>
                </>
              )}
              <ChevronRight size={11} className="text-gray-300 shrink-0" />
              <span className="text-gray-600 dark:text-gray-300 font-medium truncate max-w-[200px]">
                {title || "Untitled"}
              </span>
            </div>

            {/* Page icon */}
            <div ref={emojiRef} className="relative inline-block mb-3">
              <button
                onClick={() => setShowEmojiPicker((v) => !v)}
                title="Change icon"
                className="text-4xl leading-none p-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                {icon}
              </button>

              {showEmojiPicker && (
                <div className="no-print absolute left-0 top-full mt-1 z-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-xl p-2 w-72">
                  <div className="grid grid-cols-10 gap-0.5 max-h-48 overflow-y-auto">
                    {EMOJIS.map((e) => (
                      <button
                        key={e}
                        onClick={() => selectEmoji(e)}
                        className={`text-xl p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors leading-none ${
                          e === icon ? "bg-indigo-50 dark:bg-indigo-900/40 ring-1 ring-indigo-300" : ""
                        }`}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Editable title */}
            <label htmlFor="note-title" className="sr-only">
              Note title
            </label>
            <input
              id="note-title"
              className="w-full text-3xl font-bold text-gray-900 dark:text-gray-100 bg-transparent border-none outline-none mb-6 placeholder-gray-300 dark:placeholder-gray-600 caret-gray-900 dark:caret-gray-100"
              value={title}
              onChange={handleTitleChange}
              onBlur={handleTitleBlur}
              placeholder="Untitled"
            />

            {/* Properties panel */}
            <NoteProperties note={note} />

            {/* Database row properties — RowPeek's deferred phase 2, renders
             * nothing for an ordinary note (see DatabaseRowProperties.tsx). */}
            <DatabaseRowProperties noteId={note.id} />

            {/* Block editor */}
            <EditorErrorBoundary
              onClear={() => handleSaveContent([], "").then(() => window.location.reload())}
            >
              <BlockEditor
                ref={editorRef}
                noteId={note.id}
                initialContent={
                  Array.isArray(note.content) && note.content.length > 0
                    ? (note.content as AnyBlock[])
                    : undefined
                }
                onSave={handleSaveContent}
                ingestHtml={ingestHtml}
                onInteractiveBlocks={(blocks) => {
                  localStorage.setItem(`interactive-${note.id}`, JSON.stringify(blocks));
                  setInteractiveBlocks(blocks);
                }}
                onAddInteractiveBlock={(block) => {
                  setInteractiveBlocks((prev) => {
                    const next = [...prev, block];
                    localStorage.setItem(`interactive-${note.id}`, JSON.stringify(next));
                    return next;
                  });
                }}
              />
            </EditorErrorBoundary>

            {/* Disco Blocks — sandboxed interactive blocks */}
            {interactiveBlocks.map((block, i) => (
              <InteractiveBlockCard
                key={i}
                index={i}
                block={block}
                onUpdate={(idx, updated) => {
                  const next = interactiveBlocks.map((b, j) => j === idx ? updated : b);
                  localStorage.setItem(`interactive-${note.id}`, JSON.stringify(next));
                  setInteractiveBlocks(next);
                }}
                onRemove={(idx) => {
                  const next = interactiveBlocks.filter((_, j) => j !== idx);
                  localStorage.setItem(`interactive-${note.id}`, JSON.stringify(next));
                  setInteractiveBlocks(next);
                }}
              />
            ))}

            {/* Backlinks — notes that @mention this one */}
            <BacklinksPanel noteId={note.id} />
          </div>
        </div>
      </div>

      {/* Delete confirmation modal */}
      {showDeleteModal &&
        createPortal(
          <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] px-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-modal-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowDeleteModal(false);
            }}
          >
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 w-full max-w-sm">
              <h2
                id="delete-modal-title"
                className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2"
              >
                Move to Trash?
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">
                This note will be moved to Trash. You can restore it from the sidebar.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowDeleteModal(false)}
                >
                  Cancel
                </Button>
                <Button variant="danger" size="sm" onClick={confirmDelete}>
                  Move to Trash
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
