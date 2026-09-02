"use client";

import { Suspense } from "react";
import { WorkspaceShell } from "@/components/workspace/WorkspaceShell";

export default function NewWorkspaceSessionPage() {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <WorkspaceShell noteId={null} />
    </Suspense>
  );
}
