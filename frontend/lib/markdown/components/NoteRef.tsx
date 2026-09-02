"use client";

import Link from "next/link";

interface Props {
  id: string;
  title?: string;
  icon?: string;
}

export function NoteRef({ id, title = "Untitled", icon = "📄" }: Props) {
  return (
    <Link
      href={`/brain/${id}`}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 text-sm hover:bg-indigo-100 dark:hover:bg-indigo-900 transition-colors"
    >
      <span aria-hidden>{icon}</span>
      <span className="font-medium">{title}</span>
    </Link>
  );
}
