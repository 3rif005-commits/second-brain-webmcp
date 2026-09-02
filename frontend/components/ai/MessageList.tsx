"use client";

import { Sparkles } from "lucide-react";
import { Markdown } from "@/lib/markdown/Markdown";
import { ToolEvent } from "./ToolEvent";
import { SkillBadge } from "./SkillBadge";

export type StreamItem =
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; content: string; streaming?: boolean }
  | { kind: "skill"; id: string; name: string }
  | { kind: "tool"; id: string; tool: string; args: Record<string, unknown>; summary?: string; denied?: string };

interface Props {
  items: StreamItem[];
}

export function MessageList({ items }: Props) {
  return (
    <div className="px-4 py-5 flex flex-col gap-4">
      {items.map((item) => {
        if (item.kind === "user") {
          return (
            <div key={item.id} className="flex justify-end">
              <div className="max-w-[84%] bg-indigo-600 text-white rounded-2xl rounded-br-sm px-3.5 py-2.5 text-sm leading-relaxed shadow-sm">
                <p className="whitespace-pre-wrap">{item.content}</p>
              </div>
            </div>
          );
        }

        if (item.kind === "skill") {
          return <SkillBadge key={item.id} name={item.name} />;
        }

        if (item.kind === "tool") {
          return (
            <ToolEvent
              key={item.id}
              tool={item.tool}
              args={item.args}
              summary={item.summary}
              deniedReason={item.denied}
            />
          );
        }

        // assistant
        return (
          <div key={item.id} className="flex gap-2.5 items-start">
            {/* Avatar */}
            <div className="mt-0.5 w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 shadow-sm">
              <Sparkles size={11} className="text-white" />
            </div>

            {/* Message card */}
            <div className="flex-1 min-w-0 bg-white dark:bg-gray-800/60 rounded-2xl rounded-tl-sm px-3.5 py-2.5 shadow-sm border border-gray-100 dark:border-gray-700/50">
              <div className="text-sm text-gray-800 dark:text-gray-100 leading-relaxed prose-sm prose dark:prose-invert max-w-none">
                <Markdown>{item.content}</Markdown>
              </div>
              {item.streaming && (
                <span className="inline-block w-0.5 h-[1em] bg-indigo-400 animate-pulse ml-0.5 align-middle rounded-full" />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
