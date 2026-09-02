"use client";

// React binding for the registry.
//
// The awkward part of registering tools from a component is that `execute`
// closes over state that changes every render, while registration itself
// must NOT churn every render — each re-registration fires `toolchange`,
// and an agent that re-reads the tool list on every keystroke is a broken
// agent.
//
// The split below resolves that: registration is keyed on the tool *names*
// only, while the implementations are read from a ref that every render
// refreshes. Tools therefore always run against current state, and
// `toolchange` fires only when the page's capabilities genuinely change —
// which is exactly what it is for.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { webmcp } from "./registry";
import type { WebMcpResult, WebMcpToolDef } from "./types";
import { errorResult } from "./types";

export function useWebMcpTools(
  scope: string | null,
  build: () => WebMcpToolDef[]
): void {
  const buildRef = useRef(build);
  buildRef.current = build;

  // Cheap on every render, but it only drives the registration effect below.
  const defs = build();
  const signature = defs.map((d) => d.name).join("|");

  const proxies = useMemo(() => {
    const names = signature ? signature.split("|") : [];
    return names.map((name): WebMcpToolDef => {
      const template = defs.find((d) => d.name === name)!;
      return {
        name,
        description: template.description,
        inputSchema: template.inputSchema,
        annotations: template.annotations,
        execute: async (input, options): Promise<WebMcpResult> => {
          // Resolve late: this is what keeps a tool registered at mount from
          // acting on state captured at mount.
          const current = buildRef.current().find((d) => d.name === name);
          if (!current) {
            return errorResult(
              `"${name}" is no longer available on this page.`
            );
          }
          return current.execute(input, options);
        },
      };
    });
    // `defs` is deliberately excluded — including it would defeat the whole
    // point and re-register on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  useEffect(() => {
    if (!scope || proxies.length === 0) return;
    return webmcp.register(scope, proxies);
  }, [scope, proxies]);
}

/** Subscribe a component to registry changes — used by the inspector panel
 *  and the status badge. */
export function useWebMcpSnapshot() {
  const tools = useSyncExternalStore(
    (cb) => webmcp.subscribe(cb),
    () => webmcp.list(),
    () => [] as WebMcpToolDef[]
  );
  const calls = useSyncExternalStore(
    (cb) => webmcp.subscribe(cb),
    () => webmcp.recentCalls(),
    () => []
  );
  return { tools, calls, support: webmcp.support };
}
