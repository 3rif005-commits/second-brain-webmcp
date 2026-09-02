import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Note } from "@/lib/types/database";
import { NoteEditorPage } from "@/components/editor/NoteEditorPage";

interface Props {
  params: Promise<{ noteId: string }>;
}

export default async function NotePage({ params }: Props) {
  const { noteId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [noteRes] = await Promise.all([
    supabase.from("notes").select("*").eq("id", noteId).eq("user_id", user.id).single(),
    supabase
      .from("notes")
      .update({ last_viewed_at: new Date().toISOString() })
      .eq("id", noteId)
      .eq("user_id", user.id),
  ]);

  if (noteRes.error || !noteRes.data) {
    notFound();
  }

  let collectionName: string | undefined;
  if (noteRes.data.collection_id) {
    const { data: col } = await supabase
      .from("collections")
      .select("name")
      .eq("id", noteRes.data.collection_id)
      .single();
    collectionName = col?.name ?? undefined;
  }

  return <NoteEditorPage note={noteRes.data as Note} collectionName={collectionName} />;
}
