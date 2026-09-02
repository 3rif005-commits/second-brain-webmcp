"use client";

// Shared "click through to the note's actual content" navigation for every
// M6 view type (List: the title itself; Feed: same, its title is also
// always read-only — see FeedView.tsx; Board/Gallery: a dedicated small
// "open" affordance, see OpenNoteButton.tsx and each view's own comment for
// why the whole card isn't the click target there).
//
// Extracted here (task-17 fix round, finding 1) rather than left inline in
// ListView.tsx, which is where this was first written (task-17): Board and
// Gallery need the exact same navigation, and duplicating the `router.push`
// call three times would have let the three copies drift.
//
// A `DatabaseRow.id` is provably a note id for both ordinary and virtual
// sources (spec Q2 — `backend/routers/databases.py`'s
// `_decode_all_notes_row`/`_decode_ordinary_row` both key rows by
// `notes.id`/`db_row_props.note_id`, an FK to `notes.id`), and
// `/brain/workspace/{noteId}` is the same route
// `components/workspace/DropZone.tsx` already uses to open a note
// (`router.push('/brain/workspace/${r.note_id}')`) — not a new one invented
// for this feature.
import { useRouter } from "next/navigation";

export function noteWorkspacePath(noteId: string): string {
  return `/brain/workspace/${noteId}`;
}

export function useOpenNote(): (noteId: string) => void {
  const router = useRouter();
  return (noteId: string) => router.push(noteWorkspacePath(noteId));
}
