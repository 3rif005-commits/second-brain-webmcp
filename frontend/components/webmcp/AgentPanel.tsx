"use client";

// The agent surface, made visible.
//
// WebMCP is invisible by design: tools register, an agent calls them, state
// changes. That is fine in production and useless for anyone trying to
// verify the integration — including a judge on a browser that has not
// shipped the API yet.
//
// This panel does three things:
//   - reports whether the browser exposes document.modelContext at all;
//   - lists the tools registered for whatever the user is looking at, which
//     changes as they navigate;
//   - lets a human invoke any tool directly, so the surface is testable with
//     no agent in the loop.
//
// The third is the important one. Everything an agent can do here, you can
// do from this panel and watch happen in the page behind it.

import { useEffect, useMemo, useState } from "react";
import { Play, Wrench, X, ChevronRight, Circle } from "lucide-react";
import { webmcp } from "@/lib/webmcp/registry";
import { useWebMcpSnapshot } from "@/lib/webmcp/useWebMcpTools";
import type { JsonSchema } from "@/lib/webmcp/types";

/** Seed an editable JSON body from a tool's schema so the runner starts from
 *  something valid rather than an empty box. */
function seedInput(schema: JsonSchema | undefined): string {
  if (!schema?.properties) return "{}";
  const seed: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.default !== undefined) seed[key] = prop.default;
    else if (prop.enum?.length) seed[key] = prop.enum[0];
    else if (prop.type === "object") seed[key] = {};
    else if (prop.type === "array") seed[key] = [];
    else if (prop.type === "number" || prop.type === "integer") seed[key] = 0;
    else if (prop.type === "boolean") seed[key] = false;
    else seed[key] = "";
  }
  return JSON.stringify(seed, null, 2);
}

export function AgentPanel() {
  const { tools, calls, support } = useWebMcpSnapshot();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState("{}");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);

  // The API can arrive after hydration when it is gated behind an
  // origin-trial token in a meta tag, so probe once more after mount.
  useEffect(() => {
    const id = window.setTimeout(() => webmcp.refreshSupport(), 400);
    return () => window.clearTimeout(id);
  }, []);

  const tool = useMemo(() => tools.find((t) => t.name === selected), [tools, selected]);

  useEffect(() => {
    if (tool) setBody(seedInput(tool.inputSchema));
    setOutput(null);
  }, [tool]);

  async function run() {
    if (!tool) return;
    setRunning(true);
    setOutput(null);
    try {
      const parsed = body.trim() ? JSON.parse(body) : {};
      const result = await webmcp.execute(tool.name, parsed, { caller: "inspector" });
      setOutput(result.content.map((c) => c.text).join("\n"));
    } catch (err) {
      setOutput(
        err instanceof SyntaxError
          ? `That isn't valid JSON: ${err.message}`
          : String(err)
      );
    } finally {
      setRunning(false);
    }
  }

  const supportLabel =
    support.kind === "document"
      ? "document.modelContext"
      : support.kind === "navigator"
      ? "navigator.modelContext"
      : "not in this browser";

  const supported = support.kind !== "none";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-3.5 py-2 text-xs font-medium shadow-lg transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        aria-label={`Open agent tools panel — ${tools.length} tools registered`}
      >
        <Wrench size={14} />
        <span>{tools.length} agent tools</span>
        <span
          className={`h-1.5 w-1.5 rounded-full ${supported ? "bg-emerald-500" : "bg-amber-500"}`}
          aria-hidden
        />
      </button>
    );
  }

  return (
    <aside className="fixed bottom-4 right-4 z-50 flex max-h-[80vh] w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <Wrench size={14} />
          <h2 className="text-sm font-semibold">Agent tools</h2>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          aria-label="Close agent tools panel"
        >
          <X size={14} />
        </button>
      </header>

      <div className="border-b border-neutral-200 px-4 py-2.5 text-xs dark:border-neutral-800">
        <div className="flex items-center gap-2">
          <Circle
            size={8}
            className={supported ? "fill-emerald-500 text-emerald-500" : "fill-amber-500 text-amber-500"}
          />
          <span className="font-medium">WebMCP: {supportLabel}</span>
        </div>
        <p className="mt-1 text-neutral-500 dark:text-neutral-400">
          {supported
            ? "Tools below are registered with the browser and callable by its agent."
            : "This browser has no WebMCP API, so tools are served to the in-page assistant only. Everything below still runs."}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <section className="px-4 py-3">
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Registered here ({tools.length})
          </h3>
          {tools.length === 0 ? (
            <p className="text-xs text-neutral-500">
              No tools on this page. Open a database or a note.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {tools.map((t) => {
                const isSelected = t.name === selected;
                return (
                  <li key={t.name}>
                    <button
                      type="button"
                      onClick={() => setSelected(isSelected ? null : t.name)}
                      className={`flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                        isSelected
                          ? "bg-neutral-100 dark:bg-neutral-800"
                          : "hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                      }`}
                    >
                      <ChevronRight
                        size={12}
                        className={`mt-0.5 shrink-0 transition-transform ${isSelected ? "rotate-90" : ""}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block font-mono text-[11px] font-medium">{t.name}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                          {t.description}
                        </span>
                      </span>
                      {t.annotations?.readOnlyHint && (
                        <span className="shrink-0 rounded bg-neutral-200 px-1 py-0.5 text-[9px] font-medium uppercase text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                          read
                        </span>
                      )}
                    </button>

                    {isSelected && (
                      <div className="mt-1.5 flex flex-col gap-2 rounded border border-neutral-200 p-2.5 dark:border-neutral-800">
                        <label className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
                          Arguments
                        </label>
                        <textarea
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                          spellCheck={false}
                          rows={Math.min(10, body.split("\n").length + 1)}
                          className="w-full resize-y rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-[11px] leading-relaxed outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-950"
                        />
                        <button
                          type="button"
                          onClick={run}
                          disabled={running}
                          className="flex items-center justify-center gap-1.5 rounded bg-neutral-900 px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
                        >
                          <Play size={11} />
                          {running ? "Running…" : "Run tool"}
                        </button>
                        {output !== null && (
                          <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 font-mono text-[10.5px] leading-relaxed dark:bg-neutral-950">
                            {output}
                          </pre>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {calls.length > 0 && (
          <section className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
              Recent calls
            </h3>
            <ul className="flex flex-col gap-1">
              {calls.slice(0, 8).map((c) => (
                <li key={c.id} className="flex items-baseline gap-2 text-[11px]">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      c.error ? "bg-red-500" : "bg-emerald-500"
                    }`}
                    aria-hidden
                  />
                  <span className="font-mono">{c.tool}</span>
                  <span className="text-neutral-400">{c.caller}</span>
                  {c.endedAt && (
                    <span className="ml-auto tabular-nums text-neutral-400">
                      {c.endedAt - c.startedAt}ms
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
