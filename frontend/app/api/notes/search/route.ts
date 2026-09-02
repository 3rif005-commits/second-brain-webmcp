import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { notesTableName } from "@/lib/database/notesExclusion";

export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";

  if (!q) return NextResponse.json([]);

  const baseQuery = supabase
    .from(notesTableName())
    .select("id, title, icon, topics, mastery_status, updated_at")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .limit(10);

  // Short queries don't tokenise well — fall back to ilike
  if (q.length < 3) {
    const { data, error } = await baseQuery
      .or(`title.ilike.%${q}%,content_text.ilike.%${q}%`)
      .order("updated_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data ?? []);
  }

  // Full-text search: websearch_to_tsquery handles multi-word, phrases ("…"), negation (-word)
  const { data, error } = await baseQuery
    .textSearch("fts", q, { type: "websearch", config: "english" })
    .order("updated_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If FTS returns nothing, fall back to ilike so partial-word queries still work
  if (!data || data.length === 0) {
    const { data: fallback } = await baseQuery
      .or(`title.ilike.%${q}%,content_text.ilike.%${q}%`)
      .order("updated_at", { ascending: false });
    return NextResponse.json(fallback ?? []);
  }

  return NextResponse.json(data);
}
