"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export default function WorkspaceSessionPage() {
  const params = useParams<{ noteId: string }>();
  return (
    <Suspense fallback={<div className="h-full" />}>
      <WorkspaceShell noteId={params.noteId} />
    </Suspense>
  );
}
