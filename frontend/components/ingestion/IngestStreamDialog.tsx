"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";

interface Props {
  source: { type: "file"; file: File } | { type: "url"; url: string } | null;
  onClose: () => void;
}

type Phase = "idle" | "streaming" | "done" | "error";

export function IngestStreamDialog({ source, onClose }: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState("");
  const [noteId, setNoteId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!source) return;
    runIngest();
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  async function runIngest() {
    if (!source) return;
    setPhase("streaming");
    setPreview("");
    setNoteId(null);
    setError("");

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const form = new FormData();
    if (source.type === "file") {
      form.append("file", source.file);
    } else {
      form.append("url", source.url);
    }
    form.append("mode", "api");

    try {
      const res = await fetch("/api/agent/ingest", {
        method: "POST",
        body: form,
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        setError(text || `HTTP ${res.status}`);
        setPhase("error");
        return;
      }

      const reader = res.body.getReader();
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
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") {
            setPhase("done");
            break;
          }
          try {
            const ev = JSON.parse(raw);
            if (ev.type === "ingest_created") {
              setNoteId(ev.note_id);
            } else if (ev.type === "text") {
              setPreview((p) => p + ev.content);
            } else if (ev.type === "done") {
              setPhase("done");
            }
          } catch {
            // skip malformed chunk
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(e instanceof Error ? e.message : "Unexpected error");
        setPhase("error");
      }
    }
  }

  useEffect(() => {
    if (phase === "done" && noteId) {
      window.dispatchEvent(new Event("notes-changed"));
      setTimeout(() => router.push(`/brain/${noteId}`), 600);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, noteId]);

  if (!source) return null;

  const title = source.type === "file" ? source.file.name : source.url;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative w-full max-w-lg mx-4 bg-white rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {phase === "done" ? "Note created!" : phase === "error" ? "Import failed" : "Importing…"}
            </p>
            <p className="text-xs text-gray-400 truncate mt-0.5">{title}</p>
          </div>
          {(phase === "done" || phase === "error") && (
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700 transition-colors">
              <X size={18} />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4 max-h-64 overflow-y-auto">
          {phase === "error" ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : phase === "streaming" && preview ? (
            <p className="text-xs text-gray-600 whitespace-pre-wrap leading-relaxed">{preview}</p>
          ) : phase === "streaming" ? (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <div className="h-4 w-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
              Extracting and generating note…
            </div>
          ) : (
            <p className="text-sm text-green-700 font-medium">Opening your note…</p>
          )}
        </div>

        {/* Progress bar */}
        {phase === "streaming" && (
          <div className="h-1 bg-gray-100">
            <div className="h-full bg-indigo-500 animate-pulse" style={{ width: "60%" }} />
          </div>
        )}
      </div>
    </div>
  );
}
