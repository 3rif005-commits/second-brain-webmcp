"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypePrism from "rehype-prism-plus";
import "katex/dist/katex.min.css";

import { remarkCustomFences } from "./fences";
import { Callout } from "./components/Callout";
import { NoteRef } from "./components/NoteRef";
import { InteractiveFrame } from "@/components/interactive/InteractiveFrame";

interface Props {
  children: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const components: any = {
  customFence: (({ node, children }: any) => {
    const name = node.name as string;
    const attrs = (node.attrs ?? {}) as Record<string, string>;
    if (name === "callout") {
      return <Callout color={attrs.color} icon={attrs.icon}>{children}</Callout>;
    }
    if (name === "interactive") {
      return (
        <InteractiveFrame
          title={attrs.title}
          html={node.raw}
          height={attrs.height ? parseInt(attrs.height, 10) : 300}
        />
      );
    }
    if (name === "note-ref") {
      return <NoteRef id={attrs.id} title={attrs.title} icon={attrs.icon} />;
    }
    return <>{children}</>;
  }),
  // Tight typography in chat
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: ({ children }: any) => <p className="my-2 leading-relaxed">{children}</p>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ul: ({ children }: any) => <ul className="my-2 ml-5 list-disc space-y-1">{children}</ul>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ol: ({ children }: any) => <ol className="my-2 ml-5 list-decimal space-y-1">{children}</ol>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h1: ({ children }: any) => <h1 className="mt-5 mb-2 text-xl font-bold">{children}</h1>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h2: ({ children }: any) => <h2 className="mt-4 mb-2 text-lg font-semibold">{children}</h2>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  h3: ({ children }: any) => <h3 className="mt-3 mb-1 text-base font-semibold">{children}</h3>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: ({ inline, className, children, ...props }: any) =>
    inline ? (
      <code className="bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-[13px] font-mono text-indigo-600 dark:text-indigo-300" {...props}>{children}</code>
    ) : (
      <code className={className} {...props}>{children}</code>
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pre: ({ children }: any) => <pre className="my-3 p-3 rounded-lg bg-slate-900 text-slate-100 text-[13px] overflow-x-auto">{children}</pre>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: ({ children }: any) => <table className="my-3 border-collapse text-sm w-full">{children}</table>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  th: ({ children }: any) => <th className="border border-gray-300 dark:border-gray-700 px-2 py-1 bg-gray-50 dark:bg-gray-800 text-left font-semibold">{children}</th>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  td: ({ children }: any) => <td className="border border-gray-300 dark:border-gray-700 px-2 py-1">{children}</td>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blockquote: ({ children }: any) => <blockquote className="my-2 border-l-2 border-indigo-300 pl-3 italic text-gray-600 dark:text-gray-400">{children}</blockquote>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: ({ href, children }: any) => (
    <a href={href} className="text-indigo-600 dark:text-indigo-400 hover:underline">{children}</a>
  ),
};

export function Markdown({ children }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkCustomFences]}
      rehypePlugins={[rehypeKatex, [rehypePrism, { ignoreMissing: true }]]}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
