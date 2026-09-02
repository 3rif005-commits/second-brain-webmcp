// Generic authenticated proxy for workspace-related FastAPI endpoints.
// /api/ws/<anything> → ${FASTAPI_URL}/<anything> with the Supabase JWT attached.
// Streams request bodies (multipart uploads) and response bodies (SSE) both ways.
import { createClient } from "@/lib/supabase/server";

const ALLOWED_PREFIXES = [
  "sources",
  "notes",   // /notes/{id}/{sources,synthesis,synthesize,anchors,chat}
  "sessions",
  "ai-providers",
];

async function proxy(req: Request, path: string[]) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  if (path.length === 0 || !ALLOWED_PREFIXES.includes(path[0])) {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { "Content-Type": "application/json" },
    });
  }

  const fastApiUrl = process.env.FASTAPI_URL ?? "http://localhost:8000";
  const url = new URL(req.url);
  const target = `${fastApiUrl}/${path.join("/")}${url.search}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${session.access_token}`,
  };
  const contentType = req.headers.get("Content-Type");
  if (contentType) headers["Content-Type"] = contentType;

  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
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

  const respHeaders = new Headers();
  const respCT = res.headers.get("Content-Type");
  if (respCT) respHeaders.set("Content-Type", respCT);
  return new Response(res.body, { status: res.status, headers: respHeaders });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function POST(req: Request, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function PATCH(req: Request, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function PUT(req: Request, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function DELETE(req: Request, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
