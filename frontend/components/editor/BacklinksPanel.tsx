"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";

interface Backlink {
  id: string;
  title: string;
  icon: string;
  updated_at: string;
}

interface BacklinksPanelProps {
  noteId: string;
}

export function BacklinksPanel({ noteId }: BacklinksPanelProps) {
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [open, setOpen] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch(`/api/notes/${noteId}/backlinks`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setBacklinks(data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [noteId]);

  if (!loaded || backlinks.length === 0) return null;

  return (
    <div className="mt-10 border-t border-gray-100 dark:border-gray-800 pt-6 no-print">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-widest hover:text-gray-600 dark:hover:text-gray-300 transition-colors mb-3"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {backlinks.length} backlink{backlinks.length !== 1 ? "s" : ""}
      </button>

      {open && (
        <ul className="space-y-1">
          {backlinks.map((note) => (
            <li key={note.id}>
              <Link
                href={`/brain/${note.id}`}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors group"
              >
                <span className="text-base leading-none shrink-0">{note.icon || "📄"}</span>
                <span className="truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  {note.title || "Untitled"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
