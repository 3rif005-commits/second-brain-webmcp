import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { notesTableName } from "@/lib/database/notesExclusion";

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
    .select("id, title, deleted_at")
    .eq("user_id", user.id)
    .not("deleted_at", "is", null);

  const { data, error } = await baseQuery.order("deleted_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}
