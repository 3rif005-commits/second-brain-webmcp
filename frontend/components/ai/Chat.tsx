"use client";

import { useEffect, useRef, useState } from "react";
import { Send, History, SquarePen, X, Smartphone, Cloud, Check, SlidersHorizontal, Sparkles } from "lucide-react";
import { MessageList, type StreamItem } from "./MessageList";
import { ThreadHistory } from "./ThreadHistory";
import { useMode, type Mode } from "./ModeToggle";

interface ChatProps {
  threadId?: string | null;
  onThreadIdChange?: (id: string) => void;
  initialQuery?: string;
  onClose?: () => void;
}

const MODEL_OPTIONS: { value: Mode; label: string; desc: string; icon: React.ReactNode }[] = [
  { value: "local", label: "Local", desc: "On-device · private", icon: <Smartphone size={14} /> },
  { value: "api",   label: "Cloud", desc: "Faster · smarter",    icon: <Cloud size={14} /> },
];

export function Chat({ threadId: controlledThreadId, onThreadIdChange, initialQuery, onClose }: ChatProps = {}) {
  const [items, setItems] = useState<StreamItem[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalThreadId, setInternalThreadId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const threadId = controlledThreadId !== undefined ? controlledThreadId : internalThreadId;
  const [mode, setMode] = useMode();
  const scrollRef = useRef<HTMLDivElement>(null);
  const didAutoSend = useRef(false);
  const modeMenuRef = useRef<HTMLDivElement>(null);

  // Close mode menu on outside click
  useEffect(() => {
    if (!modeMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [modeMenuOpen]);

  function setThreadId(id: string | null) {
    setInternalThreadId(id);
    if (id) onThreadIdChange?.(id);
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  // Load thread on switch
  useEffect(() => {
    if (!threadId) { setItems([]); return; }
    (async () => {
      const res = await fetch(`/api/threads/${threadId}`);
      if (!res.ok) return;
      const t = await res.json();
      const loaded: StreamItem[] = (t.messages ?? []).map(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (m: any, i: number) => m.role === "user"
          ? { kind: "user" as const, id: `h-${i}`, content: m.content }
          : { kind: "assistant" as const, id: `h-${i}`, content: m.content }
      );
      setItems(loaded);
    })();
  }, [threadId]);

  // Auto-send initialQuery when CommandK expands into full chat
  useEffect(() => {
    if (initialQuery && !threadId && !didAutoSend.current) {
      didAutoSend.current = true;
      setInput(initialQuery);
      setTimeout(() => send(), 50);
    }
  }, [initialQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    const query = input.trim();
    if (!query || loading) return;

    const userMsg: StreamItem = { kind: "user", id: crypto.randomUUID(), content: query };
    const assistantId = crypto.randomUUID();
    setItems((prev) => [...prev, userMsg,
      { kind: "assistant", id: assistantId, content: "", streaming: true }]);
    setInput("");
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread_id: threadId,
          query,
          mode,
          messages: [
            ...items.filter((i) => i.kind === "user" || i.kind === "assistant")
                  .map((i) => ({ role: i.kind, content: (i as { content: string }).content })),
            { role: "user", content: query },
          ],
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Server ${res.status}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6);
          if (raw === "[DONE]") break;
          let ev: { type: string; [k: string]: unknown };
          try { ev = JSON.parse(raw); } catch { continue; }

          if (ev.type === "text") {
            setItems((prev) => prev.map((it) =>
              it.kind === "assistant" && it.id === assistantId
                ? { ...it, content: it.content + (ev.content as string) }
                : it
            ));
          } else if (ev.type === "skill_active") {
            setItems((prev) => insertBefore(prev, assistantId, {
              kind: "skill", id: crypto.randomUUID(), name: ev.name as string,
            }));
          } else if (ev.type === "tool_call") {
            setItems((prev) => insertBefore(prev, assistantId, {
              kind: "tool", id: ev.id as string, tool: ev.tool as string,
              args: ev.args as Record<string, unknown>,
            }));
          } else if (ev.type === "tool_result") {
            setItems((prev) => prev.map((it) =>
              it.kind === "tool" && it.id === ev.id
                ? { ...it, summary: ev.summary as string }
                : it
            ));
          } else if (ev.type === "tool_denied") {
            setItems((prev) => prev.map((it) =>
              it.kind === "tool" && it.id === ev.id
                ? { ...it, denied: ev.reason as string }
                : it
            ));
          } else if (ev.type === "done") {
            if (ev.thread_id) setThreadId(ev.thread_id as string);
          } else if (ev.type === "error") {
            setError(ev.content as string);
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setItems((prev) => prev.map((it) =>
        it.kind === "assistant" && it.id === assistantId
          ? { ...it, streaming: false }
          : it
      ));
      setLoading(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0 relative overflow-hidden">
      {/* History drawer — slides in from the left */}
      <div
        className={[
          "absolute inset-0 z-10 flex flex-col",
          "bg-[#eeeefc] dark:bg-[#0f0f1a]",
          "transition-transform duration-200 ease-in-out",
          historyOpen ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
        aria-hidden={!historyOpen}
      >
        <ThreadHistory
          activeThreadId={threadId}
          onSelect={(id) => { setThreadId(id); setHistoryOpen(false); }}
          onClose={() => setHistoryOpen(false)}
          onNew={() => { setThreadId(null); setItems([]); setHistoryOpen(false); }}
        />
      </div>

      {/* Top bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200/60 dark:border-gray-800 shrink-0">
        <button
          onClick={() => setHistoryOpen(true)}
          aria-label="Thread history"
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        >
          <History size={15} />
        </button>

        {/* Centered label */}
        <span className="flex-1 text-center text-[11px] font-medium text-gray-400 dark:text-gray-500 select-none pointer-events-none">
          AI Assistant
        </span>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => { setThreadId(null); setItems([]); }}
            aria-label="New thread"
            className="p-1.5 rounded-lg text-gray-400 hover:text-indigo-500 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <SquarePen size={15} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close AI panel"
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <X size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 bg-white/50 dark:bg-white/[0.02]" role="log" aria-live="polite">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 py-12 text-center">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-4 shadow-lg">
              <Sparkles size={28} className="text-white" aria-hidden />
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-1.5">
              What do you want to know?
            </h2>
            <p className="text-sm text-gray-400 dark:text-gray-500 max-w-[240px] leading-relaxed">
              Ask anything — answers are grounded in your notes.
            </p>
          </div>
        ) : (
          <MessageList items={items} />
        )}
        {error && (
          <div className="px-4 mb-4">
            <div className="text-xs text-red-500 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg px-3 py-2">{error}</div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-3 pb-3 pt-2.5 shrink-0 border-t border-gray-200/60 dark:border-gray-800">
        <form
          onSubmit={send}
          className="flex items-end gap-2 bg-white dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700/60 rounded-xl px-3 py-2.5 shadow-md shadow-gray-100 dark:shadow-black/20"
        >
          <textarea
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask anything about your notes…"
            disabled={loading}
            aria-label="Message input"
            className="flex-1 resize-none text-sm bg-transparent border-none outline-none disabled:opacity-50 placeholder-gray-400"
            style={{ minHeight: "1.5rem" }}
          />

          {/* Model selector */}
          <div ref={modeMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setModeMenuOpen((v) => !v)}
              aria-label={`AI model: ${mode}`}
              className={`p-1.5 rounded-lg transition-colors ${
                modeMenuOpen
                  ? "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-500"
                  : "text-gray-400 hover:text-indigo-500 hover:bg-gray-100 dark:hover:bg-gray-700"
              }`}
            >
              <SlidersHorizontal size={14} />
            </button>

            {modeMenuOpen && (
              <div className="absolute bottom-full mb-2 right-0 w-52 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden z-20">
                <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                  Model
                </p>
                {MODEL_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => { setMode(opt.value); setModeMenuOpen(false); }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      mode === opt.value
                        ? "bg-indigo-50 dark:bg-indigo-950/40"
                        : "hover:bg-gray-50 dark:hover:bg-gray-750"
                    }`}
                  >
                    <span className={mode === opt.value ? "text-indigo-500" : "text-gray-400"}>
                      {opt.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm font-medium ${mode === opt.value ? "text-indigo-600 dark:text-indigo-400" : "text-gray-700 dark:text-gray-200"}`}>
                        {opt.label}
                      </div>
                      <div className="text-xs text-gray-400 dark:text-gray-500">{opt.desc}</div>
                    </div>
                    {mode === opt.value && <Check size={13} className="shrink-0 text-indigo-500" />}
                  </button>
                ))}
                <div className="h-1" />
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label="Send"
            className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
              input.trim() && !loading
                ? "bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm"
                : "bg-gray-100 dark:bg-gray-700 text-gray-400 cursor-not-allowed"
            }`}
          >
            {loading
              ? <span className="w-3.5 h-3.5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
              : <Send size={14} strokeWidth={2.5} />}
          </button>
        </form>
        <p className="text-[10px] text-gray-400 mt-1.5 text-center">
          Enter to send · Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}

function insertBefore(prev: StreamItem[], pivotId: string, item: StreamItem): StreamItem[] {
  const idx = prev.findIndex((p) => p.kind === "assistant" && p.id === pivotId);
  if (idx < 0) return [...prev, item];
  return [...prev.slice(0, idx), item, ...prev.slice(idx)];
}
