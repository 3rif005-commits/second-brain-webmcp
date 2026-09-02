"use client";

interface Props { name: string }

export function SkillBadge({ name }: Props) {
  return (
    <div className="my-2 inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300">
      <span aria-hidden>🧩</span>
      <span>Loaded skill: <span className="font-semibold">{name}</span></span>
    </div>
  );
}
