"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import { MessageSquare, Upload, Plus, LogOut, PanelLeftClose, Trash2, RotateCcw, ChevronDown, ChevronRight, Search, Star, Clock, Sun, Moon, LayoutGrid, Table2, DatabaseIcon } from "lucide-react";
import { useTheme, useToast } from "@/app/providers";
import { createClient } from "@/lib/supabase/client";
import { useNotes } from "@/lib/hooks/useNotes";
import { useCollections } from "@/lib/hooks/useCollections";
import { useTrash } from "@/lib/hooks/useTrash";
import { NoteTree } from "./NoteTree";
import { NotificationsBell } from "./NotificationsBell";
import { CsvImportButton } from "./CsvImportButton";

function NavItem({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ElementType;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
        active
          ? "bg-indigo-500/15 text-indigo-300"
          : "text-slate-400 hover:text-slate-100 hover:bg-white/5"
      }`}
    >
      <Icon size={15} strokeWidth={active ? 2.5 : 2} />
      {label}
    </button>
  );
}

export function Sidebar({
  onToggle,
  onSearchOpen,
}: {
  onToggle?: () => void;
  onSearchOpen?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const { showToast } = useToast();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { notes, loading: notesLoading, createNote, deleteNote, toggleFavorite, reorderNotes } = useNotes();
  const { collections, loading: colsLoading } = useCollections();
  const { trashedNotes, restoreNote, permanentDelete } = useTrash();
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);

  // task-31 follow-up: the databases a user owns, listed in the sidebar.
  // `GET /db/databases` only exists as of commit 397ba23 -- before it, a
  // database was reachable ONLY by remembering its URL, because
  // `handleNewDatabase` below navigates straight to the new one and nothing
  // ever listed them again. That was the gap this section closes.
  //
  // Fetched here rather than through a `useDatabases()` hook alongside
  // `useNotes()`/`useCollections()`: those wrap Supabase-client queries
  // against tables this user's JWT can read directly, whereas databases are
  // only reachable through the FastAPI proxy (tenancy for db_* lives in the
  // query builder, not RLS -- spec §8.3). A one-off fetch here matches how
  // `handleNewDatabase` already talks to that API and avoids implying a
  // symmetry with the note hooks that does not exist.
  const [databases, setDatabases] = useState<{ id: string; title: string; icon: string | null }[]>([]);

  const loadDatabases = useCallback(async () => {
    try {
      const res = await fetch("/api/db/databases");
      if (!res.ok) return; // a sidebar list is not worth a toast on failure
      const data: {
        databases: { database: { id: string; title: string; icon: string | null } }[];
      } = await res.json();
      setDatabases(data.databases.map((entry) => entry.database));
    } catch {
      // Deliberately silent: the rest of the sidebar must still render.
    }
  }, []);

  useEffect(() => {
    loadDatabases();
  }, [loadDatabases]);

  const favoritedNotes = notes.filter((n) => n.is_favorited);
  const recentNotes = notes
    .filter((n) => n.last_viewed_at)
    .sort((a, b) => new Date(b.last_viewed_at!).getTime() - new Date(a.last_viewed_at!).getTime())
    .slice(0, 5);

  function navigate(path: string) {
    router.push(path);
    // close on mobile after navigating
    if (window.innerWidth < 768) onToggle?.();
  }

  async function handleNewNote() {
    const note = await createNote();
    navigate(`/brain/${note.id}`);
  }

  // POST /db/databases (backend, Milestone 2) has existed since before Milestone 6, but
  // nothing in the UI ever called it — Board/Gallery/List/Feed views (M6) had no live entry
  // point at all without this. Immediate create-and-navigate, same one-click convention as
  // "New Note" above, rather than a name-first dialog — a database can be renamed afterward
  // from its own page, matching how a new note starts "Untitled" too.
  async function handleNewDatabase() {
    try {
      const res = await fetch("/api/db/databases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled Database" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.error || `Request failed (${res.status})`);
      }
      const data: { database: { id: string } } = await res.json();
      // Refresh the list so the new database appears in the section below
      // rather than only being reachable via the navigation that follows.
      loadDatabases();
      navigate(`/brain/db/${data.database.id}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not create database", "error");
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside
      className="flex flex-col h-screen bg-slate-900 border-r border-slate-800"
      style={{ width: "var(--sidebar-width, 260px)" }}
    >
      {/* Brand */}
      <div className="px-4 py-4 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-base leading-none shrink-0">
            🧠
          </div>
          <span className="font-semibold text-white text-sm tracking-tight flex-1">
            Second Brain
          </span>
          {onToggle && (
            <button
              onClick={onToggle}
              aria-label="Collapse sidebar"
              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
            >
              <PanelLeftClose size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Primary CTA */}
      <div className="px-3 pt-3 shrink-0">
        <button
          onClick={handleNewNote}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
        >
          <Plus size={15} strokeWidth={2.5} />
          New Note
        </button>
      </div>

      {/* Search shortcut */}
      <div className="px-3 pt-2 shrink-0">
        <button
          onClick={onSearchOpen}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors"
        >
          <Search size={14} strokeWidth={2} />
          <span className="flex-1 text-left">Search</span>
          <kbd className="text-[10px] font-mono bg-white/10 text-slate-500 px-1.5 py-0.5 rounded">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Navigation */}
      <nav aria-label="Main navigation" className="px-3 pt-1 space-y-0.5 shrink-0">
        {/* Milestone 12 (task-41): notifications inbox — a top-level entry,
         * NOT scoped to any one database (task-41-brief.md decision 5). */}
        <NotificationsBell />
        <NavItem
          label="AI Tutor"
          icon={MessageSquare}
          active={pathname === "/brain/chat"}
          onClick={() => navigate("/brain/chat")}
        />
        <NavItem
          label="Import Knowledge"
          icon={Upload}
          active={pathname === "/brain/ingest"}
          onClick={() => navigate("/brain/ingest")}
        />
        <NavItem
          label="Workspace"
          icon={LayoutGrid}
          active={pathname?.startsWith("/brain/workspace") ?? false}
          onClick={() => navigate("/brain/workspace")}
        />
        <NavItem
          label="All Notes"
          icon={Table2}
          active={pathname?.startsWith("/brain/db/all-notes") ?? false}
          onClick={() => navigate("/brain/db/all-notes")}
        />
        <button
          onClick={handleNewDatabase}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-all"
        >
          <DatabaseIcon size={15} strokeWidth={2} />
          New Database
          <Plus size={13} strokeWidth={2.5} className="ml-auto" />
        </button>
        {/* Milestone 14 (task-47): "Import → CSV" -- a sibling action to "New
         * Database" (not inside DatabaseSettingsMenu, which is scoped to an
         * already-open database), since CSV import also always creates a brand-new
         * database. */}
        <CsvImportButton onImported={loadDatabases} />
      </nav>

      {/* Divider */}
      <div className="mx-3 my-2.5 border-t border-slate-800 shrink-0" />

      {/* Scrollable area: Starred + Recent + Notes */}
      <div className="flex-1 overflow-y-auto px-2 pb-3 min-h-0">

        {/* Starred */}
        {favoritedNotes.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
              <Star size={9} fill="currentColor" />
              Starred
            </div>
            {favoritedNotes.map((note) => (
              <button
                key={note.id}
                onClick={() => navigate(`/brain/${note.id}`)}
                className="w-full flex items-center gap-1.5 px-3 py-1 rounded-md text-xs text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors text-left"
              >
                <span className="shrink-0 text-xs leading-none">{note.icon || "📄"}</span>
                <span className="truncate">{note.title || "Untitled"}</span>
              </button>
            ))}
          </div>
        )}

        {/* Recent */}
        {recentNotes.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
              <Clock size={9} />
              Recent
            </div>
            {recentNotes.map((note) => (
              <button
                key={note.id}
                onClick={() => navigate(`/brain/${note.id}`)}
                className="w-full flex items-center gap-1.5 px-3 py-1 rounded-md text-xs text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors text-left"
              >
                <span className="shrink-0 text-xs leading-none">{note.icon || "📄"}</span>
                <span className="truncate">{note.title || "Untitled"}</span>
              </button>
            ))}
          </div>
        )}

        {/* Databases — see `loadDatabases` above for why this list could not
            exist until GET /db/databases shipped. */}
        {databases.length > 0 && (
          <div className="mb-3">
            <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
              <DatabaseIcon size={9} />
              Databases
            </div>
            {databases.map((db) => (
              <button
                key={db.id}
                onClick={() => navigate(`/brain/db/${db.id}`)}
                aria-current={pathname === `/brain/db/${db.id}` ? "page" : undefined}
                className={`w-full flex items-center gap-1.5 px-3 py-1 rounded-md text-xs transition-colors text-left ${
                  pathname === `/brain/db/${db.id}`
                    ? "bg-indigo-500/15 text-indigo-300"
                    : "text-slate-400 hover:text-slate-100 hover:bg-white/5"
                }`}
              >
                <span className="shrink-0 text-xs leading-none">{db.icon || "🗄️"}</span>
                <span className="truncate">{db.title || "Untitled Database"}</span>
              </button>
            ))}
          </div>
        )}

        {/* Notes section header */}
        <p className="px-3 mb-1 text-[10px] font-semibold text-slate-500 uppercase tracking-widest">
          Notes
        </p>

        {/* Note tree */}
        {notesLoading || colsLoading ? (
          <div className="space-y-1 px-3 pt-1">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-7 rounded-md bg-slate-800 animate-pulse" />
            ))}
          </div>
        ) : (
          <NoteTree
            notes={notes}
            collections={collections}
            onDeleteNote={deleteNote}
            onToggleFavorite={toggleFavorite}
            onReorder={reorderNotes}
          />
        )}
      </div>

      {/* Trash */}
      {trashedNotes.length > 0 && (
        <div className="px-3 pb-2 shrink-0 border-t border-slate-800 pt-2">
          <button
            onClick={() => setTrashOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-slate-500 hover:text-slate-300 rounded-md hover:bg-white/5 transition-colors"
          >
            <Trash2 size={12} />
            <span className="flex-1 text-left">Trash</span>
            <span className="mr-1 text-[10px] tabular-nums">{trashedNotes.length}</span>
            {trashOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>

          {trashOpen && (
            <div className="mt-1 space-y-0.5">
              {trashedNotes.map((note) => (
                <div
                  key={note.id}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-500 hover:bg-white/5 group"
                >
                  <span className="flex-1 truncate min-w-0">{note.title || "Untitled"}</span>
                  <button
                    onClick={() => restoreNote(note.id)}
                    title="Restore"
                    className="shrink-0 p-0.5 rounded text-slate-600 hover:text-indigo-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <RotateCcw size={11} />
                  </button>
                  <button
                    onClick={() => permanentDelete(note.id)}
                    title="Delete forever"
                    className="shrink-0 p-0.5 rounded text-slate-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Sign-out */}
      <div className="px-3 pb-4 pt-3 border-t border-slate-800 shrink-0">
        <div className="flex items-center gap-1 mb-1">
          {confirmSignOut ? (
            <div className="flex items-center gap-1.5 flex-1">
              <span className="text-xs text-slate-400 flex-1">Sign out?</span>
              <button
                onClick={handleSignOut}
                className="text-xs px-2.5 py-1 rounded-md bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors font-medium"
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmSignOut(false)}
                className="text-xs px-2.5 py-1 rounded-md bg-slate-800 text-slate-400 hover:bg-slate-700 transition-colors"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmSignOut(true)}
              className="flex-1 flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors"
            >
              <LogOut size={14} />
              Sign out
            </button>
          )}
          {mounted && (
            <button
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
              aria-label="Toggle theme"
              className="p-2 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-white/5 transition-colors shrink-0"
            >
              {resolvedTheme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
