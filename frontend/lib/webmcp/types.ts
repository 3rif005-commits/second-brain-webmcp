// Shared types for the WebMCP layer.
//
// These mirror the W3C Web Machine Learning CG draft
// (https://github.com/webmachinelearning/webmcp) closely enough that a tool
// definition written against this file can be handed to
// `document.modelContext.registerTool()` unchanged. They are declared here
// rather than pulled from `webmcp-types` so the app builds on browsers and
// CI images where the package (and the API) does not exist.

export type JsonSchema = {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
};

/** A single block of a tool result. The spec's content array is typed; we
 *  only ever emit text, which every consumer understands. */
export interface WebMcpContent {
  type: "text";
  text: string;
}

export interface WebMcpResult {
  content: WebMcpContent[];
  /** Set when `execute` threw or refused. Agents treat this as a failed call
   *  rather than as data. */
  isError?: boolean;
}

/** Hints the spec defines for agents deciding whether a call needs consent.
 *  `readOnlyHint` is the one Chrome currently acts on; the others are carried
 *  because our own permission gate reads them (see `session.ts`). */
export interface WebMcpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  title?: string;
}

export interface WebMcpExecuteOptions {
  signal?: AbortSignal;
}

export interface WebMcpToolDef<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  annotations?: WebMcpAnnotations;
  execute: (
    input: TInput,
    options?: WebMcpExecuteOptions
  ) => WebMcpResult | Promise<WebMcpResult>;
}

/** What the browser exposes, when it exposes anything. Kept structural so we
 *  never import a type that may not exist at build time. */
export interface ModelContextLike {
  registerTool: (
    tool: unknown,
    options?: { signal?: AbortSignal }
  ) => Promise<unknown> | unknown;
  unregisterTool?: (name: string) => unknown;
  getTools?: () => Promise<unknown[]>;
  addEventListener?: (type: string, listener: () => void) => void;
}

export type NativeSupport =
  | { kind: "none" }
  | { kind: "document" }   // spec-current: document.modelContext
  | { kind: "navigator" }; // earlier drafts, still shipped in some builds

/** Convenience for the common case of returning a blob of text. */
export function text(body: string): WebMcpResult {
  return { content: [{ type: "text", text: body }] };
}

export function errorResult(message: string): WebMcpResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Tools carry structured payloads often enough to be worth one helper.
 *  JSON is what models parse most reliably. */
export function json(value: unknown): WebMcpResult {
  return text(JSON.stringify(value, null, 2));
}
