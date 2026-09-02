import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import type { PropertyResponse } from "@/lib/database/types";
import type { FormViewConfig } from "@/lib/forms/types";
import { PublicFormClient } from "@/components/forms/PublicFormClient";

interface Props {
  params: Promise<{ viewId: string }>;
}

interface FormQuestionMeta {
  property_key: string;
  required: boolean;
  name: string;
  type: string;
}

interface GetFormViewResult {
  name: string;
  config: FormViewConfig;
  questions: FormQuestionMeta[];
}

// GET /forms/[viewId] — the public, unauthenticated Form-view page. No auth
// check: this route is meant to be reached by anyone with the link (same
// spirit as `share/[noteId]/page.tsx`, this codebase's only other
// unauthenticated page). Reads via `get_form_view` (migration
// 018_forms.sql) rather than a direct table SELECT — see that function's
// own comment for why: it returns curated view+question metadata only,
// never row data, without needing a new anon SELECT policy on db_views.
export default async function FormPage({ params }: Props) {
  const { viewId } = await params;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data, error } = await supabase.rpc("get_form_view", { p_view_id: viewId });

  if (error || !data) {
    notFound();
  }

  const result = data as GetFormViewResult;
  const config = result.config;

  return (
    <div className="min-h-screen bg-white">
      {/* Minimal header — matches share/[noteId]/page.tsx's own
          minimal-header convention; this app's public-facing pages are
          intentionally plain, not the full app chrome. */}
      <header className="border-b border-gray-100 px-6 py-3 flex items-center gap-2.5">
        <div className="w-6 h-6 rounded-md bg-indigo-600 flex items-center justify-center text-sm leading-none">
          🧠
        </div>
        <span className="text-sm font-semibold text-gray-700">Second Brain</span>
      </header>

      <main className="max-w-xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">{result.name}</h1>

        {config.is_form_closed ? (
          <p className="text-gray-500">This form is not accepting responses.</p>
        ) : (
          <PublicFormClient
            viewId={viewId}
            config={config}
            questionProperties={result.questions.map(
              (q): PropertyResponse => ({
                id: q.property_key,
                data_source_id: "",
                user_id: "",
                key: q.property_key,
                name: q.name,
                type: q.type,
                config: {},
                description: null,
                storage: "jsonb",
                column_name: null,
                result_type: null,
                is_volatile: false,
                position: 0,
                created_at: "",
              })
            )}
          />
        )}
      </main>

      <footer className="mt-12 py-6 border-t border-gray-100 text-center text-xs text-gray-400">
        Powered by{" "}
        <a href="/" className="text-indigo-500 hover:underline">
          Second Brain
        </a>
      </footer>
    </div>
  );
}
