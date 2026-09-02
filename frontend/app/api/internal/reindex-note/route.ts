import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const fastApiUrl = process.env.FASTAPI_URL ?? "http://localhost:8000";
  const body = await req.json();

  let res: Response;
  try {
    res = await fetch(`${fastApiUrl}/internal/reindex-note`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return new Response(JSON.stringify({ error: "Backend unreachable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }

  const data = await res.json().catch(() => ({}));
  return new Response(JSON.stringify(data), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
