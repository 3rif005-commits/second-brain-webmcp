"use client";

import { useState } from "react";
import type { InteractiveBlock } from "./BlockEditor";

interface Props {
  block: InteractiveBlock;
  index: number;
  onUpdate: (index: number, block: InteractiveBlock) => void;
  onRemove: (index: number) => void;
}

type Mode = "preview" | "edit" | "ai";

export function InteractiveBlockCard({ block, index, onUpdate, onRemove }: Props) {
  const [mode, setMode] = useState<Mode>("preview");
  const [title, setTitle] = useState(block.title);
  const [code, setCode] = useState(block.html);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  function save() {
    onUpdate(index, { title, html: code });
    setMode("preview");
  }

  async function generate() {
    if (!prompt.trim()) return;
    setGenerating(true);
    setError("");
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: `Title: "${title}"\n\n${prompt.trim()}` }],
          query: prompt.trim(),
          surface: "interactive",
          mode: "api",
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let html = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") break;
          try {
            const ev = JSON.parse(raw);
            if (ev.type === "text") html += ev.content;
          } catch { /* skip */ }
        }
      }

      // Strip any markdown code fences the model may have wrapped around the HTML
      const stripped = html.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
      setCode(stripped);
      setMode("edit");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="mt-6 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 no-print">
      {/* Title bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white">
        <span className="text-base">⚡</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => onUpdate(index, { title, html: code })}
          className="flex-1 bg-transparent text-sm font-semibold outline-none placeholder-indigo-300 min-w-0"
          placeholder="Block title"
        />
        {/* Mode tabs */}
        <div className="flex gap-1 ml-auto shrink-0">
          {(["preview", "edit", "ai"] as Mode[]).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(""); }}
              className={`text-xs px-2 py-0.5 rounded-md font-medium transition-colors ${
                mode === m
                  ? "bg-white text-indigo-700"
                  : "text-indigo-200 hover:text-white hover:bg-indigo-500"
              }`}
            >
              {m === "preview" ? "Preview" : m === "edit" ? "Code" : "AI"}
            </button>
          ))}
          <button
            onClick={() => onRemove(index)}
            className="ml-1 text-indigo-300 hover:text-white text-xs px-1"
            title="Remove block"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Preview */}
      {mode === "preview" && (
        <iframe
          srcDoc={code}
          sandbox="allow-scripts"
          className="w-full border-none block bg-slate-50 dark:bg-gray-900"
          style={{ height: 300 }}
        />
      )}

      {/* Code editor */}
      {mode === "edit" && (
        <div className="flex flex-col bg-gray-950">
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="w-full font-mono text-xs text-green-300 bg-gray-950 p-4 resize-none outline-none"
            style={{ height: 260 }}
            placeholder="Paste any self-contained HTML / CSS / JS here…"
            spellCheck={false}
          />
          <div className="flex justify-end gap-2 px-3 py-2 border-t border-gray-800">
            <button
              onClick={() => setMode("preview")}
              className="text-xs px-3 py-1.5 rounded-lg text-gray-400 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
            >
              Apply
            </button>
          </div>
        </div>
      )}

      {/* AI generation */}
      {mode === "ai" && (
        <div className="p-4 bg-white dark:bg-gray-900 flex flex-col gap-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Describe what this block should do — simulation, quiz, chart, timeline, calculator…
          </p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full text-sm border border-gray-200 dark:border-gray-700 rounded-lg p-3 outline-none focus:ring-2 focus:ring-indigo-400 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none"
            placeholder="e.g. A bar chart comparing bubble sort vs merge sort complexity, or a Newton's law simulator with sliders…"
          />
          {error && <p className="text-xs text-red-500">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setMode("preview")}
              className="text-xs px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={generate}
              disabled={generating || !prompt.trim()}
              className="text-xs px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium transition-colors flex items-center gap-1.5"
            >
              {generating ? "Generating…" : "Generate"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
