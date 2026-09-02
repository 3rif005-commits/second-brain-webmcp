"use client";

import { useEffect, useState } from "react";

export type Mode = "local" | "api";

const KEY = "secondbrain:mode";

export function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode>("api");
  useEffect(() => {
    const v = localStorage.getItem(KEY) as Mode | null;
    if (v === "local" || v === "api") setMode(v);
  }, []);
  const update = (m: Mode) => {
    setMode(m);
    localStorage.setItem(KEY, m);
  };
  return [mode, update];
}

interface Props {
  mode: Mode;
  onChange: (m: Mode) => void;
}

export function ModeToggle({ mode, onChange }: Props) {
  return (
    <button
      onClick={() => onChange(mode === "local" ? "api" : "local")}
      title={`Current mode: ${mode}. Click to switch.`}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      aria-label={`AI mode: ${mode}`}
    >
      <span className="text-sm" aria-hidden>{mode === "local" ? "📱" : "☁️"}</span>
      <span className="capitalize">{mode}</span>
    </button>
  );
}
