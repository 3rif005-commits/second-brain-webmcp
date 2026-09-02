import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ noteId: string }> };

export async function POST(_req: Request, { params }: Params) {
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
    .update({ deleted_at: null } as never)
    .eq("id", noteId)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}
