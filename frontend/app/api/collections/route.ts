import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CollectionInsert } from "@/lib/types/database";

// GET /api/collections — list all collections for the authenticated user
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("collections")
    .select("*")
    .eq("user_id", user.id)
    .order("position", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// POST /api/collections — create a new collection
export async function POST(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const insert: CollectionInsert = {
    user_id: user.id,
    name: body.name ?? "New Collection",
    parent_id: body.parent_id ?? null,
    icon: body.icon ?? "📁",
    color: body.color ?? "#6366f1",
  };

  const { data, error } = await supabase
    .from("collections")
    .insert(insert)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}
