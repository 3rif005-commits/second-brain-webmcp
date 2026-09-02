import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const fastApiUrl = process.env.FASTAPI_URL ?? "http://localhost:8000";

  let res: Response;
  try {
    res = await fetch(`${fastApiUrl}/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: req.body,
      // @ts-expect-error — Node 18+ streaming bodies
      duplex: "half",
    });
  } catch (e) {
    const refused = e instanceof Error && e.message.includes("ECONNREFUSED");
    return new Response(
      JSON.stringify({
        error: refused
          ? "Backend not running. Start it with: cd backend && uvicorn main:app --reload"
          : `Failed to reach backend: ${e instanceof Error ? e.message : String(e)}`,
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "text/event-stream" },
  });
}
