import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { NoteUpdate } from "@/lib/types/database";

type Params = { params: Promise<{ noteId: string }> };

// GET /api/notes/[noteId] — fetch a single note with full content
export async function GET(_req: Request, { params }: Params) {
  const { noteId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .eq("id", noteId)
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}

// PATCH /api/notes/[noteId] — update a note (title, content, etc.)
export async function PATCH(req: Request, { params }: Params) {
  const { noteId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const update: NoteUpdate = {};

  if (body.title !== undefined)           update.title = body.title;
  if (body.icon !== undefined)            update.icon = body.icon;
  if (body.is_favorited !== undefined)    update.is_favorited = body.is_favorited;
  if (body.last_viewed_at !== undefined)  update.last_viewed_at = body.last_viewed_at;
  if (body.content !== undefined)        update.content = body.content;
  if (body.content_text !== undefined)   update.content_text = body.content_text;
  if (body.collection_id !== undefined)  update.collection_id = body.collection_id;
  if (body.topics !== undefined)         update.topics = body.topics;
  if (body.mastery_status !== undefined) update.mastery_status = body.mastery_status;
  if (body.is_public !== undefined)      update.is_public = body.is_public;
  if (body.position !== undefined)       update.position = body.position;
  if (typeof body.local_only === "boolean") update.local_only = body.local_only;

  const { data, error } = await supabase
    .from("notes")
    .update(update)
    .eq("id", noteId)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}

// DELETE /api/notes/[noteId] — soft delete (moves to Trash)
export async function DELETE(_req: Request, { params }: Params) {
  const { noteId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("notes")
    .update({ deleted_at: new Date().toISOString() } as never)
    .eq("id", noteId)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
