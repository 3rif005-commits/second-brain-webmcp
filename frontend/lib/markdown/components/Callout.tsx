"use client";

import type { ReactNode } from "react";

const COLORS: Record<string, { bg: string; border: string; text: string }> = {
  blue:   { bg: "bg-blue-50 dark:bg-blue-900/20",   border: "border-blue-300 dark:border-blue-700",   text: "text-blue-900 dark:text-blue-100" },
  red:    { bg: "bg-red-50 dark:bg-red-900/20",     border: "border-red-300 dark:border-red-700",     text: "text-red-900 dark:text-red-100" },
  orange: { bg: "bg-orange-50 dark:bg-orange-900/20", border: "border-orange-300 dark:border-orange-700", text: "text-orange-900 dark:text-orange-100" },
  yellow: { bg: "bg-yellow-50 dark:bg-yellow-900/20", border: "border-yellow-300 dark:border-yellow-700", text: "text-yellow-900 dark:text-yellow-100" },
  green:  { bg: "bg-green-50 dark:bg-green-900/20", border: "border-green-300 dark:border-green-700", text: "text-green-900 dark:text-green-100" },
  purple: { bg: "bg-purple-50 dark:bg-purple-900/20", border: "border-purple-300 dark:border-purple-700", text: "text-purple-900 dark:text-purple-100" },
  gray:   { bg: "bg-gray-50 dark:bg-gray-800/30",   border: "border-gray-300 dark:border-gray-600",   text: "text-gray-900 dark:text-gray-100" },
};

interface Props {
  color?: string;
  icon?: string;
  children: ReactNode;
}

export function Callout({ color = "blue", icon, children }: Props) {
  const c = COLORS[color] ?? COLORS.blue;
  return (
    <div
      className={`my-3 rounded-lg border-l-4 px-4 py-3 ${c.bg} ${c.border} ${c.text}`}
      role="note"
    >
      {icon && <span className="mr-2 text-base" aria-hidden>{icon}</span>}
      <span className="text-sm leading-relaxed">{children}</span>
    </div>
  );
}
