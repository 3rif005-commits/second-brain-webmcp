import { createClient } from "@/lib/supabase/server";

const BACKEND = process.env.FASTAPI_URL ?? "http://localhost:8000";

async function getToken() {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await getToken();
  if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const { id } = await params;
  const body = await req.text();
  const res = await fetch(`${BACKEND}/mcp-servers/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
  });
  return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await getToken();
  if (!token) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const { id } = await params;
  const res = await fetch(`${BACKEND}/mcp-servers/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  return new Response(null, { status: res.status });
}
