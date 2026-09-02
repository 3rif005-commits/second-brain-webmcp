/* eslint-disable @typescript-eslint/no-explicit-any */
import { google } from "@ai-sdk/google";
import { streamText, convertToCoreMessages } from "ai";

// Dynamic import for @blocknote/xl-ai/server — the package is in
// serverExternalPackages so Node.js loads its ESM build natively.
// The type declarations in server.d.ts are empty in 0.48, hence `as any`.
async function getXlAIServer() {
  return (await import("@blocknote/xl-ai/server")) as any;
}

// POST /api/ai — BlockNote AI endpoint (Gemini 2.0 Flash via Google AI)
// Requires GOOGLE_GENERATIVE_AI_API_KEY in .env.local
export async function POST(req: Request) {
  if (
    !process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY === "your-google-ai-key"
  ) {
    return new Response(
      JSON.stringify({ error: "GOOGLE_GENERATIVE_AI_API_KEY is not configured. Add it to .env.local." }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  const { aiDocumentFormats, injectDocumentStateMessages, toolDefinitionsToToolSet } =
    await getXlAIServer();

  const { messages, toolDefinitions } = await req.json();

  // Cast model to any — @ai-sdk/google@3.x returns LanguageModelV3 while ai@4.x
  // declares LanguageModelV1; they're structurally compatible at runtime.
  const result = streamText({
    model: google("gemini-2.0-flash") as any,
    system: aiDocumentFormats.html.systemPrompt,
    messages: convertToCoreMessages(injectDocumentStateMessages(messages) as any),
    tools: toolDefinitionsToToolSet(toolDefinitions),
    toolChoice: "required",
    maxSteps: 10,
  });

  return result.toDataStreamResponse();
}
