import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { PublicNoteView } from "@/components/editor/PublicNoteView";

interface Props {
  params: Promise<{ noteId: string }>;
}

export default async function SharePage({ params }: Props) {
  const { noteId } = await params;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data: note, error } = await supabase
    .from("notes")
    .select("id, title, icon, content, topics, mastery_status, created_at")
    .eq("id", noteId)
    .eq("is_public", true)
    .is("deleted_at", null)
    .single();

  if (error || !note) {
    notFound();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blocks = Array.isArray(note.content) ? (note.content as any[]) : [];

  return (
    <div className="min-h-screen bg-white">
      {/* Minimal header */}
      <header className="border-b border-gray-100 px-6 py-3 flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md bg-indigo-600 flex items-center justify-center text-sm leading-none">
          🧠
        </div>
        <span className="text-sm font-semibold text-gray-700">Second Brain</span>
        <div className="flex-1" />
        <a
          href="/signup"
          className="text-xs font-medium text-indigo-600 hover:text-indigo-700 px-3 py-1.5 rounded-lg border border-indigo-200 hover:bg-indigo-50 transition-colors"
        >
          Create your own →
        </a>
      </header>

      {/* Note content */}
      <main className="max-w-3xl mx-auto px-6 py-10">
        {/* Icon + title */}
        <div className="mb-2 text-4xl leading-none">{note.icon || "📄"}</div>
        <h1 className="text-3xl font-bold text-gray-900 mb-6">
          {note.title || "Untitled"}
        </h1>

        {/* Topics */}
        {Array.isArray(note.topics) && note.topics.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-6">
            {(note.topics as string[]).map((t) => (
              <span
                key={t}
                className="text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 font-medium"
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {/* Read-only editor */}
        <PublicNoteView content={blocks} />
      </main>

      <footer className="mt-12 py-6 border-t border-gray-100 text-center text-xs text-gray-400">
        Shared via{" "}
        <a href="/" className="text-indigo-500 hover:underline">
          Second Brain
        </a>{" "}
        — your AI-powered knowledge OS
      </footer>
    </div>
  );
}
