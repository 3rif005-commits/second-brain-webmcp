"use client";

// Grounded chat over one note's sources — answers only from what's attached to
// this note, every claim carrying a [n] citation that opens the right source at
// the exact spot. Rendered as a drawer over the note pane: a third column in a
// compact layout leaves nothing readable.
import { useCallback, useRef, useState } from "react";
import { ArrowUp, MessagesSquare, X } from "lucide-react";
import { anchorLabel, sourceColor, type Citation } from "@/lib/workspace";

/** Openers for an empty thread — one tap instead of a blank page. */
const STARTERS = [
  "Summarise the key ideas",
  "What should I remember first?",
  "Explain the hardest part simply",
];

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

interface WorkspaceChatProps {
  noteId: string;
  colorIndex: Map<string, number>;   // resource_id → order_index, for the dots
  onCitation: (citation: Citation) => void;
  onClose: () => void;
}

/** Render assistant text with [n] markers replaced by clickable chips. */
function CitedText({ content, citations, colorIndex, onCitation }: {
  content: string;
  citations: Citation[];
  colorIndex: Map<string, number>;
  onCitation: (c: Citation) => void;
}) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const parts = content.split(/(\[\d+\])/g);
  return (
    <div className="text-sm leading-relaxed whitespace-pre-wrap text-gray-800 dark:text-gray-200">
      {parts.map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        if (!m) return <span key={i}>{part}</span>;
        const c = byN.get(Number(m[1]));
        if (!c) return null; // hallucinated marker — never rendered
        const idx = colorIndex.get(c.resource_id);
        return (
          <button
            key={i}
            onClick={() => onCitation(c)}
            title={`${c.title} — ${anchorLabel(c.anchor_type, c.anchor_start)}\n${c.snippet ?? ""}`}
            className="inline-flex items-center gap-0.5 align-baseline mx-0.5 px-1.5 rounded-full bg-indigo-100 dark:bg-indigo-900/50 text-indigo-600 dark:text-indigo-300 text-[10px] font-semibold hover:bg-indigo-200 dark:hover:bg-indigo-800 transition-colors cursor-pointer"
          >
            {/* No dot rather than a wrong dot: a citation whose source is gone
                must not borrow the first source's colour. */}
            {idx !== undefined && (
              <span className="w-1 h-1 rounded-full"
                    style={{ backgroundColor: sourceColor(idx) }} />
            )}
            {m[1]}
          </button>
        );
      })}
    </div>
  );
}

export function WorkspaceChat({ noteId, colorIndex, onCitation, onClose }: WorkspaceChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // `override` lets a starter chip send without a round trip through state.
  const send = useCallback(async (override?: string) => {
    const q = (override ?? input).trim();
    if (!q || streaming) return;
    setInput("");
    const history = [...messages, { role: "user" as const, content: q }];
    setMessages([...history, { role: "assistant", content: "", citations: [] }]);
    setStreaming(true);

    try {
      const res = await fetch(`/api/ws/notes/${noteId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let citations: Citation[] = [];

      const apply = () => {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: text, citations };
          return next;
        });
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          const line = evt.trim();
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6);
          if (raw === "[DONE]") continue;
          let data;
          try { data = JSON.parse(raw); } catch { continue; }
          if (data.type === "text") { text += data.content; apply(); }
          else if (data.type === "context" || data.type === "citations") {
            citations = data.citations ?? []; apply();
          } else if (data.type === "error") {
            text += `\n⚠️ ${data.content}`; apply();
          }
        }
      }
    } catch (e) {
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          content: `⚠️ ${e instanceof Error ? e.message : "Chat failed"}`,
        };
        return next;
      });
    } finally {
      setStreaming(false);
    }
  }, [input, messages, streaming, noteId]);

  return (
    <div className="ws-slide-in absolute inset-y-0 right-0 z-30 w-[400px] max-w-full flex flex-col
      border-l border-gray-200/80 dark:border-white/10
      bg-white/95 dark:bg-[#11141c]/95 backdrop-blur-xl
      shadow-[-24px_0_48px_-24px_rgba(16,24,40,0.35)]">
      <div className="flex items-center gap-2 px-3.5 h-[52px] shrink-0 border-b border-gray-100 dark:border-white/5">
        <span className="w-7 h-7 rounded-xl bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
          <MessagesSquare size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-gray-900 dark:text-gray-50 leading-tight">
            Ask your sources
          </p>
          <p className="text-[11px] text-gray-400 leading-tight">
            Answers cite the exact spot
          </p>
        </div>
        <button
          onClick={onClose}
          title="Close"
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-xl text-gray-400
            hover:text-gray-800 dark:hover:text-gray-100 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <X size={15} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-3.5 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="ws-rise">
            <p className="text-[12.5px] text-gray-500 dark:text-gray-400 leading-relaxed">
              Ask anything about the sources attached to this note. Every claim
              carries a clickable citation that opens the right source at the exact
              page or timestamp.
            </p>
            <div className="mt-3 flex flex-col items-start gap-1.5">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[12px]
                    text-gray-600 dark:text-gray-300 bg-gray-100/80 dark:bg-white/[0.06]
                    ring-1 ring-transparent hover:ring-indigo-400/40 hover:text-indigo-600
                    dark:hover:text-indigo-300 transition-all duration-150"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="ws-accent max-w-[85%] px-3.5 py-2 rounded-2xl rounded-br-md text-[13px] leading-relaxed">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="mr-2">
              {m.content ? (
                <CitedText
                  content={m.content}
                  citations={m.citations ?? []}
                  colorIndex={colorIndex}
                  onCitation={onCitation}
                />
              ) : (
                <span className="inline-flex items-center gap-1 text-gray-400" aria-label="Thinking">
                  {[0, 1, 2].map((d) => (
                    <span
                      key={d}
                      className="w-1.5 h-1.5 rounded-full bg-current animate-bounce"
                      style={{ animationDelay: `${d * 140}ms` }}
                    />
                  ))}
                </span>
              )}
            </div>
          )
        )}
      </div>

      <div className="p-3 shrink-0 border-t border-gray-100 dark:border-white/5">
        <div className="flex items-end gap-2 p-1.5 rounded-2xl bg-gray-100/70 dark:bg-white/[0.06]
          ring-1 ring-transparent focus-within:ring-indigo-400/50 transition-shadow">
          <textarea
            className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[13px] outline-none
              text-gray-800 dark:text-gray-100 placeholder:text-gray-400 max-h-32"
            rows={1}
            placeholder="Ask about your sources…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          <button
            onClick={() => send()}
            disabled={streaming || !input.trim()}
            title="Send"
            className="ws-accent shrink-0 w-8 h-8 flex items-center justify-center rounded-xl
              disabled:opacity-30 disabled:shadow-none transition-all duration-150 active:scale-95"
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
