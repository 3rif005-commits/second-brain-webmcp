// Type stubs for @blocknote/xl-ai/server — the official server.d.ts is empty
// in 0.48.0. This file gives TypeScript enough information to resolve the
// dynamic import in app/api/ai/route.ts without errors.
declare module "@blocknote/xl-ai/server" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const aiDocumentFormats: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function injectDocumentStateMessages(messages: any): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function toolDefinitionsToToolSet(toolDefinitions: any): any;
}
