"use client";

// The one place in the app that touches the browser's WebMCP API.
//
// Everything else registers tools against this registry, which does three
// things:
//
//   1. Keeps its own map, so the in-page agent and the tool inspector work
//      on every browser — including the ones that will never ship WebMCP.
//   2. Mirrors registrations to `document.modelContext` when the browser has
//      it, so external agents (Gemini in Chrome, ChatGPT Desktop) see the
//      same surface with no second definition.
//   3. Routes every call through one execute path, so journaling, error
//      shaping and the staged-session gate apply uniformly no matter who
//      called the tool.
//
// Scoping matters as much as registration. Tools are registered per surface
// ("database:<id>", "note:<id>") and unregistered when that surface
// unmounts, so the agent's tool list tracks what the user is actually
// looking at instead of accumulating every tool in the product.

import type {
  ModelContextLike,
  NativeSupport,
  WebMcpExecuteOptions,
  WebMcpResult,
  WebMcpToolDef,
} from "./types";
import { errorResult } from "./types";

/** Resolve the browser's model context object, if any.
 *
 *  The CG draft settled on `document.modelContext`; earlier drafts (and a
 *  good deal of secondary writing) used `navigator.modelContext`, and some
 *  shipped builds still expose it there. Checking both costs nothing and is
 *  the only place in the app that needs to know the difference. */
export function detectNative(): { support: NativeSupport; ctx: ModelContextLike | null } {
  if (typeof document !== "undefined") {
    const ctx = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
    if (ctx && typeof ctx.registerTool === "function") {
      return { support: { kind: "document" }, ctx };
    }
  }
  if (typeof navigator !== "undefined") {
    const ctx = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
    if (ctx && typeof ctx.registerTool === "function") {
      return { support: { kind: "navigator" }, ctx };
    }
  }
  return { support: { kind: "none" }, ctx: null };
}

export interface ToolCallRecord {
  id: string;
  tool: string;
  input: unknown;
  /** Where the call came from. `native` means the browser's agent reached us
   *  through document.modelContext; `in-page` is our own assistant. */
  caller: "native" | "in-page" | "inspector";
  startedAt: number;
  endedAt?: number;
  result?: WebMcpResult;
  error?: string;
}

type Listener = () => void;
type CallListener = (record: ToolCallRecord) => void;

interface Registration {
  scope: string;
  def: WebMcpToolDef;
  controller: AbortController | null;
}

let callSeq = 0;

class WebMcpRegistry {
  private tools = new Map<string, Registration>();
  private listeners = new Set<Listener>();
  private callListeners = new Set<CallListener>();
  private calls: ToolCallRecord[] = [];
  private native = detectNative();

  /** Interceptor installed by the staged-session layer. Returning a result
   *  short-circuits execution (used to refuse writes when no session is
   *  open); returning undefined lets the call proceed. */
  private gate:
    | ((def: WebMcpToolDef, input: unknown) => Promise<WebMcpResult | undefined>)
    | null = null;

  get support(): NativeSupport {
    return this.native.support;
  }

  /** Re-probe. The API can appear after first paint when it is behind an
   *  origin-trial token delivered by a meta tag. */
  refreshSupport(): NativeSupport {
    this.native = detectNative();
    this.emit();
    return this.native.support;
  }

  setGate(gate: typeof this.gate) {
    this.gate = gate;
  }

  /** Register a set of tools for one surface. Returns the disposer; calling
   *  it removes them from both our map and the browser's. */
  register(scope: string, defs: WebMcpToolDef[]): () => void {
    for (const def of defs) {
      const existing = this.tools.get(def.name);
      if (existing) {
        // Same name from a different surface means two components disagree
        // about who owns a capability. Last writer wins so navigation is
        // never wedged, but it is a bug worth surfacing in development.
        if (process.env.NODE_ENV !== "production" && existing.scope !== scope) {
          console.warn(
            `[webmcp] "${def.name}" re-registered by "${scope}" (was "${existing.scope}")`
          );
        }
        this.disposeOne(def.name);
      }

      let controller: AbortController | null = null;
      if (this.native.ctx) {
        controller = new AbortController();
        try {
          // The browser gets a wrapper, not the raw def, so calls arriving
          // from an external agent go through the same gate and journal as
          // calls from our own assistant.
          void this.native.ctx.registerTool(
            {
              name: def.name,
              description: def.description,
              inputSchema: def.inputSchema,
              annotations: def.annotations,
              execute: (input: Record<string, unknown>, options?: WebMcpExecuteOptions) =>
                this.execute(def.name, input, { caller: "native", signal: options?.signal }),
            },
            { signal: controller.signal }
          );
        } catch (err) {
          // A NotAllowedError here means the `tools` permission policy is off
          // for this document. The local registry still works, so the app
          // degrades to in-page-agent-only rather than breaking.
          if (process.env.NODE_ENV !== "production") {
            console.warn(`[webmcp] native registration refused for "${def.name}"`, err);
          }
          controller = null;
        }
      }

      this.tools.set(def.name, { scope, def, controller });
    }
    this.emit();

    return () => {
      for (const def of defs) {
        const current = this.tools.get(def.name);
        // Only dispose if we still own it — a later surface may have taken
        // the name over, and unmount order is not guaranteed.
        if (current && current.scope === scope) this.disposeOne(def.name);
      }
      this.emit();
    };
  }

  private disposeOne(name: string) {
    const reg = this.tools.get(name);
    if (!reg) return;
    reg.controller?.abort();
    if (!reg.controller && this.native.ctx?.unregisterTool) {
      try {
        this.native.ctx.unregisterTool(name);
      } catch {
        /* best effort — the tool may already be gone */
      }
    }
    this.tools.delete(name);
  }

  list(): WebMcpToolDef[] {
    return [...this.tools.values()].map((r) => r.def);
  }

  scopeOf(name: string): string | undefined {
    return this.tools.get(name)?.scope;
  }

  recentCalls(): ToolCallRecord[] {
    return this.calls;
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    options?: { caller?: ToolCallRecord["caller"]; signal?: AbortSignal }
  ): Promise<WebMcpResult> {
    const reg = this.tools.get(name);
    const record: ToolCallRecord = {
      id: `call-${++callSeq}`,
      tool: name,
      input,
      caller: options?.caller ?? "in-page",
      startedAt: Date.now(),
    };

    if (!reg) {
      // Naming the available tools turns a dead end into a recoverable one —
      // agents reliably retry with a correct name when given the list.
      record.error = `Unknown tool "${name}"`;
      record.endedAt = Date.now();
      this.pushCall(record);
      return errorResult(
        `Unknown tool "${name}". Tools available on this page: ${
          this.list().map((t) => t.name).join(", ") || "(none)"
        }`
      );
    }

    try {
      if (this.gate) {
        const refusal = await this.gate(reg.def, input);
        if (refusal) {
          record.result = refusal;
          record.endedAt = Date.now();
          this.pushCall(record);
          return refusal;
        }
      }

      const result = await reg.def.execute(input, { signal: options?.signal });
      record.result = result;
      record.endedAt = Date.now();
      this.pushCall(record);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.error = message;
      record.endedAt = Date.now();
      this.pushCall(record);
      return errorResult(`${name} failed: ${message}`);
    }
  }

  private pushCall(record: ToolCallRecord) {
    // Bounded: this feeds a UI strip, not an audit trail. Durable history is
    // the session journal's job.
    this.calls = [record, ...this.calls].slice(0, 50);
    for (const fn of this.callListeners) fn(record);
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onCall(fn: CallListener): () => void {
    this.callListeners.add(fn);
    return () => this.callListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

/** Module-scoped singleton. Next.js may evaluate this module more than once
 *  across route boundaries in development, so it is stashed on globalThis to
 *  keep one registry per document. */
const GLOBAL_KEY = "__secondBrainWebMcpRegistry";

export const webmcp: WebMcpRegistry =
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] as WebMcpRegistry ??
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] = new WebMcpRegistry());

export type { WebMcpRegistry };
