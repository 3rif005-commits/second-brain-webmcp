"use client";

interface Props {
  title?: string;
  html: string;
  height?: number;
}

export function InteractiveFrame({ title = "Interactive", html, height = 300 }: Props) {
  return (
    <div className="my-4 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 text-white text-xs font-semibold">
        <span>⚡</span><span>{title}</span>
      </div>
      <iframe
        srcDoc={html}
        sandbox="allow-scripts"
        className="w-full border-none block bg-white dark:bg-gray-900"
        style={{ height }}
        title={title}
      />
    </div>
  );
}
