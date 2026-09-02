import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("chat_threads")
    .select("id, title, pinned, model_mode, created_at, updated_at, archived_at")
    .eq("user_id", user.id)
    .is("archived_at", null)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ threads: data ?? [] });
}
