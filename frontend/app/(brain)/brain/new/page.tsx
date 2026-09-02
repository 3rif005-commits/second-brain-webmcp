import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Server component: creates a new note and immediately redirects to its page
export default async function NewNotePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data, error } = await supabase
    .from("notes")
    .insert({ user_id: user.id, title: "Untitled", content: [] })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error("Failed to create note");
  }

  redirect(`/brain/${data.id}`);
}
