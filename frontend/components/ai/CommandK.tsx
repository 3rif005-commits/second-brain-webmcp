"use client";

import { useRef, useState } from "react";
import { Bot, ArrowRight } from "lucide-react";
import { Chat } from "./Chat";
import { useAIThread } from "@/context/AIThreadContext";

const URL_RE = /^https?:\/\/[^\s]{4,}/i;

function isUrl(s: string): boolean {
  return URL_RE.test(s.trim());
}

export type CommandKStage = "closed" | "compact" | "expanded";

interface CommandKProps {
  open: CommandKStage;
  onOpen: (stage: CommandKStage) => void;
}

export function CommandK({ open, onOpen }: CommandKProps) {
  const { activeThreadId, setActiveThreadId } = useAIThread();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function handleBackdropClick() {
    if (open === "compact") onOpen("closed");
    else if (open === "expanded") onOpen("compact");
  }

  function handleCompactSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    if (isUrl(query.trim())) {
      setQuery(`Summarize this URL for me: ${query.trim()}`);
    }
    onOpen("expanded");
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (open === "expanded") onOpen("compact");
      else if (open === "compact") onOpen("closed");
    }
  }

  if (open === "closed") return null;

  const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        onClick={handleBackdropClick}
        aria-hidden
      />

      {/* Modal */}
      <div
        className={[
          "fixed z-50 bg-white dark:bg-gray-900",
          "border border-gray-200 dark:border-gray-700 shadow-2xl",
          "flex flex-col overflow-hidden",
          "transition-all duration-200 ease-out",
          isMobile
            ? "inset-0 rounded-none border-0"
            : open === "expanded"
              ? "left-1/2 -translate-x-1/2 top-[10vh] w-[480px] h-[600px] rounded-2xl"
              : "left-1/2 -translate-x-1/2 top-1/3 w-[480px] rounded-2xl",
        ].join(" ")}
        role="dialog"
        aria-label="AI assistant"
        onKeyDown={handleKeyDown}
      >
        {open === "compact" && (
          <form onSubmit={handleCompactSubmit} className="flex items-center gap-3 px-4 py-4">
            <Bot size={18} className="text-indigo-500 shrink-0" />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData("text").trim();
                if (isUrl(pasted)) {
                  e.preventDefault();
                  setQuery(`Summarize this URL for me: ${pasted}`);
                  onOpen("expanded");
                }
              }}
              placeholder="Ask anything…"
              className="flex-1 text-sm bg-transparent outline-none placeholder-gray-400 text-gray-900 dark:text-gray-100"
              aria-label="AI query"
            />
            <button
              type="submit"
              disabled={!query.trim()}
              className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center bg-indigo-600 text-white disabled:opacity-40 hover:bg-indigo-500 transition-colors"
              aria-label="Send"
            >
              <ArrowRight size={14} />
            </button>
          </form>
        )}

        {open === "expanded" && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <Chat
              threadId={activeThreadId}
              onThreadIdChange={setActiveThreadId}
              initialQuery={query || undefined}
            />
          </div>
        )}
      </div>
    </>
  );
}

/** Mobile floating action button — shown when CommandK is closed */
export function CommandKFAB({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open AI"
      className="md:hidden fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-indigo-600 text-white shadow-lg flex items-center justify-center hover:bg-indigo-500 active:scale-95 transition-all"
    >
      <Bot size={24} />
    </button>
  );
}
