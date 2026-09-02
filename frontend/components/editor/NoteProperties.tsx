"use client";

import { useState } from "react";
import { ChevronRight, X } from "lucide-react";
import type { Note } from "@/lib/types/database";
import { LocalOnlyBadge } from "./LocalOnlyBadge";

const MASTERY_ORDER = [
  "not_started",
  "learning",
  "reviewing",
  "mastered",
] as const;

const MASTERY_STYLE: Record<string, string> = {
  not_started: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400",
  learning:    "bg-amber-50 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400",
  reviewing:   "bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400",
  mastered:    "bg-green-50 text-green-600 dark:bg-green-900/40 dark:text-green-400",
};

const MASTERY_LABEL: Record<string, string> = {
  not_started: "Not started",
  learning: "Learning",
  reviewing: "Reviewing",
  mastered: "Mastered",
};

interface Props {
  note: Note;
}

export function NoteProperties({ note }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [mastery, setMastery] = useState(note.mastery_status);
  const [topics, setTopics] = useState<string[]>(note.topics ?? []);
  const [newTopic, setNewTopic] = useState("");
  const [showInput, setShowInput] = useState(false);

  async function patch(update: Record<string, unknown>) {
    await fetch(`/api/notes/${note.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    window.dispatchEvent(new Event("notes-changed"));
  }

  function cycleMastery() {
    const idx = MASTERY_ORDER.indexOf(mastery);
    const next = MASTERY_ORDER[(idx + 1) % MASTERY_ORDER.length];
    setMastery(next);
    patch({ mastery_status: next });
  }

  function removeTopic(t: string) {
    const updated = topics.filter((x) => x !== t);
    setTopics(updated);
    patch({ topics: updated });
  }

  function commitTopic(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const trimmed = newTopic.trim();
      if (trimmed && !topics.includes(trimmed)) {
        const updated = [...topics, trimmed];
        setTopics(updated);
        patch({ topics: updated });
      }
      setNewTopic("");
      setShowInput(false);
    }
    if (e.key === "Escape") {
      setNewTopic("");
      setShowInput(false);
    }
  }

  return (
    <div className="mb-5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
      >
        <ChevronRight
          size={12}
          className={`transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        Properties
      </button>

      {expanded && (
        <div className="mt-2 space-y-2 pl-3 border-l border-gray-100 dark:border-gray-700">
          {/* Local only */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-16 shrink-0">Visibility</span>
            <LocalOnlyBadge noteId={note.id} initialValue={note.local_only ?? false} />
          </div>

          {/* Mastery */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-16 shrink-0">Mastery</span>
            <button
              onClick={cycleMastery}
              className={`text-xs px-2.5 py-0.5 rounded-full font-medium transition-colors ${MASTERY_STYLE[mastery]}`}
            >
              {MASTERY_LABEL[mastery]}
            </button>
          </div>

          {/* Topics */}
          <div className="flex items-start gap-3">
            <span className="text-xs text-gray-400 w-16 shrink-0 pt-0.5">Topics</span>
            <div className="flex flex-wrap gap-1">
              {topics.map((t) => (
                <span
                  key={t}
                  className="flex items-center gap-1 text-xs px-2 py-0.5 bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-400 rounded-full"
                >
                  {t}
                  <button
                    onClick={() => removeTopic(t)}
                    className="hover:text-indigo-900 dark:hover:text-indigo-200 leading-none"
                    aria-label={`Remove ${t}`}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {showInput ? (
                <input
                  autoFocus
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                  onKeyDown={commitTopic}
                  onBlur={() => {
                    setNewTopic("");
                    setShowInput(false);
                  }}
                  placeholder="Add topic…"
                  className="text-xs px-2 py-0.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-full outline-none w-24 focus:border-indigo-300 dark:focus:border-indigo-500"
                />
              ) : (
                <button
                  onClick={() => setShowInput(true)}
                  className="text-xs px-2 py-0.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-full hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                >
                  + Add
                </button>
              )}
            </div>
          </div>

          {/* Source */}
          {note.source_type && note.source_type !== "manual" && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-400 w-16 shrink-0">Source</span>
              <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs">
                {note.source_filename || note.source_url || note.source_type}
              </span>
            </div>
          )}

          {/* Created */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-16 shrink-0">Created</span>
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {new Date(note.created_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
