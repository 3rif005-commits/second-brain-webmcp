import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { PropertyValue } from "@/lib/database/types";
import { extractIp, hashIp } from "@/lib/forms/hashIp";

type Params = { params: Promise<{ viewId: string }> };

interface SubmitBody {
  properties?: Record<string, PropertyValue>;
}

// POST /api/forms/[viewId]/submit — the public, unauthenticated write path
// for a Form view. Same anon-key shape as `share/[noteId]/route.ts`
// (this codebase's only other unauthenticated access): a Next.js route
// instantiating an anon-key Supabase client directly, bypassing FastAPI and
// `app/api/db/[...path]/route.ts`'s authenticated proxy entirely. All the
// real work — resolving the owning user_id server-side, the open/closed
// check, the atomic rate limit, filtering to config.questions[] — happens
// inside `submit_form_response` (migration 018_forms.sql); this route only
// extracts+hashes the caller's IP, calls the RPC, and maps its errors to a
// clear 4xx. Never a raw 500 leaking internals.
export async function POST(req: Request, { params }: Params) {
  const { viewId } = await params;

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const properties = body?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return NextResponse.json({ error: "Missing properties" }, { status: 400 });
  }

  const ip = extractIp(req);
  const ipHash = hashIp(ip);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data, error } = await supabase.rpc("submit_form_response", {
    p_view_id: viewId,
    p_ip_hash: ipHash,
    p_properties: properties,
  });

  if (error) {
    const message = error.message ?? "";
    if (message.includes("form_not_found") || message.includes("form_closed")) {
      return NextResponse.json({ error: "This form is not accepting responses" }, { status: 400 });
    }
    if (message.includes("rate_limited")) {
      return NextResponse.json({ error: "Too many submissions — please try again later" }, { status: 429 });
    }
    if (message.includes("missing_required_property")) {
      return NextResponse.json({ error: "Please fill in all required questions" }, { status: 422 });
    }
    // Never leak the raw Postgres/PostgREST error to an unauthenticated caller.
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }

  return NextResponse.json({ id: data }, { status: 201 });
}
