import { createClient } from "@/lib/supabase/server";

// Local CPU-only ingest can take ~15 minutes, but a hosted deploy cannot wait
// that long: Vercel caps a Serverless Function at 300s on Hobby (and rejects
// the deploy outright, rather than clamping, if the value is higher). 300 is
// the ceiling that both environments accept — a long local ingest still runs,
// it just isn't proxied through this route with a 15-minute budget.
export const maxDuration = 300;

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
