"use client";

import dynamic from "next/dynamic";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

interface PublicNoteViewProps {
  content: AnyBlock[];
}

function PublicNoteViewInner({ content }: PublicNoteViewProps) {
  const editor = useCreateBlockNote({
    initialContent: content && content.length > 0 ? content : undefined,
  } as Parameters<typeof useCreateBlockNote>[0]);

  return (
    <div className="prose max-w-none pointer-events-none select-text">
      <BlockNoteView editor={editor} editable={false} theme="light" />
    </div>
  );
}

// Must be client-only (BlockNote uses window)
export const PublicNoteView = dynamic(
  () => Promise.resolve(PublicNoteViewInner),
  { ssr: false, loading: () => <div className="h-64 animate-pulse bg-gray-100 rounded-lg" /> }
);
