"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";

interface SearchResult {
  id: string;
  title: string;
  icon: string;
  topics: string[];
  mastery_status: string;
  updated_at: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SearchModal({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/notes/search?q=${encodeURIComponent(query.trim())}`
        );
        const data = await res.json();
        setResults(Array.isArray(data) ? data : []);
        setSelectedIndex(0);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  function navigate(id: string) {
    router.push(`/brain/${id}`);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    }
    if (e.key === "Enter" && results[selectedIndex]) {
      navigate(results[selectedIndex].id);
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-700">
          <Search size={17} className="text-gray-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search notes…"
            className="flex-1 text-sm outline-none placeholder-gray-400 dark:placeholder-gray-500 text-gray-900 dark:text-gray-100 bg-transparent"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              <X size={15} />
            </button>
          )}
          <kbd className="hidden sm:inline-flex text-[10px] font-mono bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500 px-1.5 py-0.5 rounded">
            ESC
          </kbd>
        </div>

        {/* Results */}
        {query.trim() ? (
          <div className="max-h-80 overflow-y-auto">
            {loading && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                Searching…
              </div>
            )}
            {!loading && results.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-gray-400">
                No notes found for &ldquo;{query}&rdquo;
              </div>
            )}
            {!loading &&
              results.map((note, i) => (
                <button
                  key={note.id}
                  onClick={() => navigate(note.id)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    i === selectedIndex
                      ? "bg-indigo-50 dark:bg-indigo-900/30"
                      : "hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  }`}
                >
                  <span className="text-base leading-none shrink-0">{note.icon || "📄"}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                      {note.title || "Untitled"}
                    </p>
                    {note.topics?.length > 0 && (
                      <p className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5">
                        {note.topics.slice(0, 3).join(" · ")}
                      </p>
                    )}
                  </div>
                </button>
              ))}
          </div>
        ) : (
          <div className="px-4 py-3 text-xs text-gray-400 dark:text-gray-500">
            Type to search across all your notes
          </div>
        )}
      </div>
    </div>
  );
}
