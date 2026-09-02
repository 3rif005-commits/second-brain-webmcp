"use client";

// Milestone 12 (task-42) decision 4: the click-response handling shared by
// ButtonCell (button PROPERTY surface, components/database/cells/ButtonCell
// .tsx) and ButtonBlockView (button BLOCK surface,
// components/database/ButtonBlock.tsx) — both POST to a click endpoint
// (only the URL/body differ, supplied by the caller as `postClick`), both
// need the identical `requires_confirmation` two-phase flow, "open"
// client-action navigation, and (block surface only) `insert_blocks`
// handling. Factored into one hook rather than duplicated twice, per
// task-42-brief.md decision 4's own text.
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/app/providers";
import type { ButtonClickResponse, InsertBlocksPlacement } from "./types";

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

export interface UseButtonClickOptions {
  /** POSTs the click request with the given `confirmed` flag — the two
   * surfaces' request URLs/bodies differ (button property vs. button
   * block), so the caller builds the actual `fetch` call. */
  postClick: (confirmed: boolean) => Promise<Response>;
  /** Block surface only (decision 4: "an insert_blocks entry (block surface
   * only)") — omitted by ButtonCell, whose `BUTTON_ACTIONS` never produce
   * this client action kind in the first place (button PROPERTY has no
   * page of its own to insert blocks into). */
  onInsertBlocks?: (blocks: unknown[], placement: InsertBlocksPlacement) => void;
}

export interface UseButtonClickResult {
  /** Runs the action chain fresh (`confirmed: false`). */
  click: () => void;
  pending: boolean;
  /** Non-null while a `show_confirmation` action is pending the user's
   * decision — render a `ConfirmDialog` keyed off this. */
  confirmationMessage: string | null;
  /** Re-POSTs the SAME request with `confirmed: true`. */
  confirmAndRun: () => void;
  /** Dismisses the confirmation without re-running anything (decision 4:
   * "on cancel, do nothing further — the show_confirmation-gated actions
   * never ran"). */
  cancelConfirm: () => void;
}

/** Combined M12 review's Finding 4 (Minor), controller-fixed: the brief's
 * decision 4 text literally named `router.push(\`/brain/${note_id}\`)` for
 * `kind: "note"`, but `/brain/[noteId]` and `/brain/workspace/[noteId]` are
 * two distinct, separately-rendered pages (verified live — not a redirect
 * alias), so this was a genuine route inconsistency, not just a comment.
 * A button's `open_page_or_url` target is configured from a database
 * automation/button context, the same context `lib/database/useOpenNote.ts`
 * already serves for every M6 database view's "open" affordance
 * (`/brain/workspace/${noteId}`) — aligned to that established convention
 * for consistency rather than the brief's literal (but contextually
 * mismatched) text. */
function noteHref(noteId: string): string {
  return `/brain/workspace/${noteId}`;
}

export function useButtonClick({ postClick, onInsertBlocks }: UseButtonClickOptions): UseButtonClickResult {
  const router = useRouter();
  const { showToast } = useToast();
  const [pending, setPending] = useState(false);
  const [confirmationMessage, setConfirmationMessage] = useState<string | null>(null);

  const run = useCallback(
    async (confirmed: boolean) => {
      setPending(true);
      try {
        const res = await postClick(confirmed);
        if (!res.ok) {
          showToast(await errorMessage(res), "error");
          return;
        }
        const data: ButtonClickResponse = await res.json();
        if (data.requires_confirmation) {
          setConfirmationMessage(data.confirmation_message || "Are you sure you want to continue?");
          return;
        }
        for (const action of data.client_actions) {
          if (action.type === "open") {
            if (action.kind === "url" && action.url) {
              // Judgment call: a new tab (not window.location.href) keeps
              // this app's own state intact — a button's URL-open action
              // shouldn't navigate the user away from the note they were
              // just looking at. "noopener,noreferrer" — standard
              // reverse-tabnabbing guard for a window.open'd external URL.
              window.open(action.url, "_blank", "noopener,noreferrer");
            } else if (action.kind === "note" && action.note_id) {
              router.push(noteHref(action.note_id));
            }
          } else if (action.type === "insert_blocks") {
            onInsertBlocks?.(action.blocks, action.placement);
          }
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not run this button", "error");
      } finally {
        setPending(false);
      }
    },
    [postClick, onInsertBlocks, router, showToast]
  );

  const click = useCallback(() => {
    void run(false);
  }, [run]);

  const confirmAndRun = useCallback(() => {
    setConfirmationMessage(null);
    void run(true);
  }, [run]);

  const cancelConfirm = useCallback(() => setConfirmationMessage(null), []);

  return { click, pending, confirmationMessage, confirmAndRun, cancelConfirm };
}
