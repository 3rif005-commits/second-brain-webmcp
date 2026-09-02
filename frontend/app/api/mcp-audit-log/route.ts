import { createClient } from "@/lib/supabase/server";

const BACKEND = process.env.FASTAPI_URL ?? "http://localhost:8000";

export async function GET() {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const res = await fetch(`${BACKEND}/mcp-audit-log`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}
