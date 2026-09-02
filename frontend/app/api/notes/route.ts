import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { NoteInsert } from "@/lib/types/database";
import { notesTableName } from "@/lib/database/notesExclusion";

// GET /api/notes — list all notes for the authenticated user
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseQuery = supabase
    .from(notesTableName())
    .select("id, title, icon, is_favorited, last_viewed_at, collection_id, topics, mastery_status, source_type, position, created_at, updated_at")
    .eq("user_id", user.id)
    .is("deleted_at", null);

  const { data, error } = await baseQuery
    .order("position", { ascending: true })
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// POST /api/notes — create a new note
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const insert: NoteInsert = {
    user_id: user.id,
    title: body.title ?? "Untitled",
    collection_id: body.collection_id ?? null,
    content: body.content ?? [],
    source_type: body.source_type ?? "manual",
  };

  const { data, error } = await supabase
    .from("notes")
    .insert(insert)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
