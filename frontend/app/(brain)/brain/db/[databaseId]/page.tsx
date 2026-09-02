"use client";

// Auth is already enforced server-side by app/(brain)/layout.tsx for every
// route in this group (redirects to /login before this ever renders) — the
// same pattern app/(brain)/brain/workspace/[noteId]/page.tsx uses, so this
// page just reads the dynamic segment and renders the client shell.
import { Suspense } from "react";
import { useParams } from "next/navigation";
import { DatabaseShell } from "@/components/database/DatabaseShell";

export default function DatabasePage() {
  const params = useParams<{ databaseId: string }>();
  return (
    <Suspense fallback={<div className="h-full" />}>
      <DatabaseShell databaseId={params.databaseId} />
    </Suspense>
  );
}
