import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CollectionUpdate } from "@/lib/types/database";

type Params = { params: Promise<{ collectionId: string }> };

// PUT /api/collections/[collectionId] — update a collection
export async function PUT(req: Request, { params }: Params) {
  const { collectionId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const update: CollectionUpdate = {};

  if (body.name !== undefined)        update.name = body.name;
  if (body.description !== undefined) update.description = body.description;
  if (body.icon !== undefined)        update.icon = body.icon;
  if (body.color !== undefined)       update.color = body.color;
  if (body.position !== undefined)    update.position = body.position;
  if (body.parent_id !== undefined)   update.parent_id = body.parent_id;

  const { data, error } = await supabase
    .from("collections")
    .update(update)
    .eq("id", collectionId)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}

// DELETE /api/collections/[collectionId] — delete a collection
export async function DELETE(_req: Request, { params }: Params) {
  const { collectionId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("collections")
    .delete()
    .eq("id", collectionId)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
