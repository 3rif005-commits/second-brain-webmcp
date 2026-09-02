import { createClient } from "@/lib/supabase/server";

const BACKEND = process.env.FASTAPI_URL ?? "http://localhost:8000";

async function getAuth() {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function GET() {
  const token = await getAuth();
  if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const res = await fetch(`${BACKEND}/skills`, { headers: { Authorization: `Bearer ${token}` } });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}

export async function POST(req: Request) {
  const token = await getAuth();
  if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const body = await req.text();
  const res = await fetch(`${BACKEND}/skills`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}
