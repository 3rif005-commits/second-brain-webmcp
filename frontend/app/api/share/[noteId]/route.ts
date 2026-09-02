import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type Params = { params: Promise<{ noteId: string }> };

// GET /api/share/[noteId] — unauthenticated read for public notes
export async function GET(_req: Request, { params }: Params) {
  const { noteId } = await params;

  // Use the anon key — RLS policy "anon_read_public_notes" restricts access
  // to rows where is_public = true AND deleted_at IS NULL
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data, error } = await supabase
    .from("notes")
    .select("id, title, icon, content, topics, mastery_status, created_at, updated_at")
    .eq("id", noteId)
    .eq("is_public", true)
    .is("deleted_at", null)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}
