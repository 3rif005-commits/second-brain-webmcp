import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ noteId: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { noteId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // UUID validation — noteId comes from URL, must be safe before embedding in pattern
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(noteId)) {
    return NextResponse.json({ error: "Invalid note ID" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("notes")
    .select("id, title, icon, updated_at, content")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .neq("id", noteId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const mentionPattern = `"noteId":"${noteId}"`;
  const backlinks = (data ?? [])
    .filter((n) => JSON.stringify(n.content).includes(mentionPattern))
    .map(({ id, title, icon, updated_at }) => ({ id, title, icon, updated_at }));

  return NextResponse.json(backlinks);
}
