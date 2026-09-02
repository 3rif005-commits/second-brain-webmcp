import { createClient } from "@/lib/supabase/server";

// Allow up to 15 minutes for local LLM ingest (CPU-only is slow)
export const maxDuration = 900;

// POST /api/ingest — proxy to FastAPI ingest service with JWT forwarding
// Body: FormData with file | { url: string }
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const fastApiUrl = process.env.FASTAPI_URL ?? "http://localhost:8000";

  let res: Response;
  try {
    res = await fetch(`${fastApiUrl}/ingest/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        ...(req.headers.get("Content-Type")
          ? { "Content-Type": req.headers.get("Content-Type")! }
          : {}),
        ...(req.headers.get("X-LLM-Model")
          ? { "X-LLM-Model": req.headers.get("X-LLM-Model")! }
          : {}),
      },
      body: req.body,
      // @ts-expect-error — Node 18+ streams
      duplex: "half",
      signal: AbortSignal.timeout(900_000), // 15 min — local LLM on CPU is slow
    });
  } catch (e) {
    const isRefused = e instanceof Error && e.message.includes("ECONNREFUSED");
    return new Response(
      JSON.stringify({
        error: isRefused
          ? `FastAPI backend is not running. Start it with: cd backend && uvicorn main:app --reload`
          : `Failed to reach backend: ${e instanceof Error ? e.message : String(e)}`,
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") ?? "application/json" },
  });
}
