"use client";

import { useState } from "react";
import { Lock, Unlock } from "lucide-react";

interface Props {
  noteId: string;
  initialValue: boolean;
}

export function LocalOnlyBadge({ noteId, initialValue }: Props) {
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);

  async function toggle() {
    setPending(true);
    const next = !value;
    setValue(next);
    try {
      const res = await fetch(`/api/notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ local_only: next }),
      });
      if (!res.ok) setValue(!next); // revert
    } catch {
      setValue(!next);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      title={value
        ? "Local-only: this note is hidden from cloud AI"
        : "Make this note local-only (hidden from cloud AI)"}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
        value
          ? "bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-200"
          : "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-500 hover:text-gray-700"
      }`}
    >
      {value ? <Lock size={11} /> : <Unlock size={11} />}
      {value ? "Local only" : "Local-only off"}
    </button>
  );
}
