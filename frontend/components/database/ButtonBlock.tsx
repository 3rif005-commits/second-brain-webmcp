"use client";

// Milestone 12 (task-42) decision 3: the button BLOCK — mirrors
// DatabaseBlock.tsx's own file shape (a `...BlockSpec` export + the
// rendering component + an exported, directly-unit-testable insert
// function). Unlike DatabaseBlock, a button block's action chain lives
// ENTIRELY client-side in its own BlockNote props (task-42-brief.md's
// "Backend API surface": "there is no server endpoint to save it to at
// all" — it round-trips through the note's own `content` save the same way
// every other block's props already do). `propSchema` values must be
// primitives (M11's own constraint — MathBlockSpec.latex,
// CheckpointBlockSpec's fields, DatabaseBlockSpec.databaseId/viewId all use
// bare strings only), so `actions` is JSON-stringified into `actionsJson`
// rather than a nested array prop.
import { useContext, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { Pencil } from "lucide-react";
import { NoteIdContext } from "../editor/noteIdContext";
import { useButtonClick } from "@/lib/database/useButtonClick";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ButtonActionChainEditor } from "./ButtonActionChainEditor";
import { BUTTON_BLOCK_ACTION_TYPES } from "@/lib/database/types";
import type { ButtonBlockAction, InsertBlocksPlacement } from "@/lib/database/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

export const ButtonBlockSpec = createReactBlockSpec(
  {
    type: "button",
    propSchema: {
      label: { default: "Button" },
      icon: { default: "⚡" },
      actionsJson: { default: "[]" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }: { block: AnyBlock; editor: AnyBlock }) => (
      <div contentEditable={false}>
        <ButtonBlockView block={block} editor={editor} />
      </div>
    ),
  }
);

/** Inserts a fresh `button` block immediately after `afterBlockId`, or at the
 * end of the document when no block id is given — same testable-extraction
 * convention as DatabaseBlock.tsx's `insertDatabaseBlock`. */
export function insertButtonBlock(editor: AnyBlock, afterBlockId: string | undefined) {
  const newBlock = { type: "button", props: { label: "Button", icon: "⚡", actionsJson: "[]" } };
  if (afterBlockId) {
    editor.insertBlocks([newBlock], afterBlockId, "after");
    return;
  }
  const doc = editor.document as AnyBlock[];
  const last = doc[doc.length - 1];
  if (last) {
    editor.insertBlocks([newBlock], last.id, "after");
  } else {
    editor.replaceBlocks(editor.document, [newBlock]);
  }
}

/** Decision 4's `insert_blocks` handling for the block surface — the 4
 * named placements: `above_button`/`below_button` relative to THIS button
 * block itself, `top_of_page`/`bottom_of_page` relative to the whole
 * document (mirroring `BlockEditorHandle.insertBlocksAtEnd`'s own "last
 * top-level block, or replaceBlocks on an empty document" fallback for
 * "bottom_of_page"). Exported so ButtonBlock.test.tsx can assert on it
 * directly — same "extract a testable function" convention as
 * `insertButtonBlock`/DatabaseBlock.tsx's `insertDatabaseBlock`. */
export function insertBlocksForButtonClick(
  editor: AnyBlock,
  block: AnyBlock,
  blocks: AnyBlock[],
  placement: InsertBlocksPlacement
) {
  if (blocks.length === 0) return;
  if (placement === "above_button") {
    editor.insertBlocks(blocks, block.id, "before");
    return;
  }
  if (placement === "below_button") {
    editor.insertBlocks(blocks, block.id, "after");
    return;
  }
  const doc = editor.document as AnyBlock[];
  if (placement === "top_of_page") {
    const first = doc[0];
    if (first) editor.insertBlocks(blocks, first.id, "before");
    else editor.replaceBlocks(editor.document, blocks);
    return;
  }
  // bottom_of_page
  const last = doc[doc.length - 1];
  if (last) editor.insertBlocks(blocks, last.id, "after");
  else editor.replaceBlocks(editor.document, blocks);
}

function parseActions(actionsJson: string): ButtonBlockAction[] {
  try {
    const parsed = JSON.parse(actionsJson);
    return Array.isArray(parsed) ? (parsed as ButtonBlockAction[]) : [];
  } catch {
    return [];
  }
}

// Exported (not just used internally by ButtonBlockSpec's render) so
// ButtonBlock.test.tsx can mount it directly, same convention as
// DatabaseBlock.tsx's exported InlineDatabaseView.
export function ButtonBlockView({ block, editor }: { block: AnyBlock; editor: AnyBlock }) {
  const noteId = useContext(NoteIdContext);
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState<string>(block.props.label ?? "Button");
  const [iconDraft, setIconDraft] = useState<string>(block.props.icon ?? "⚡");

  const actions = parseActions(block.props.actionsJson);

  const { click, pending, confirmationMessage, confirmAndRun, cancelConfirm } = useButtonClick({
    postClick: (confirmed) =>
      fetch("/api/db/buttons/block-click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note_id: noteId, actions, confirmed }),
      }),
    onInsertBlocks: (blocks, placement) => insertBlocksForButtonClick(editor, block, blocks as AnyBlock[], placement),
  });

  function saveActions(next: ButtonBlockAction[]) {
    editor.updateBlock(block, {
      props: { label: labelDraft || "Button", icon: iconDraft || "⚡", actionsJson: JSON.stringify(next) },
    });
  }

  function saveLabelIcon() {
    editor.updateBlock(block, {
      props: { label: labelDraft || "Button", icon: iconDraft || "⚡", actionsJson: block.props.actionsJson },
    });
  }

  const label = block.props.label || "Button";

  return (
    <div className="group relative inline-flex flex-col gap-2 my-1">
      <div className="inline-flex items-center gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={click}
          className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 text-white disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          <span aria-hidden>{block.props.icon}</span>
          {label}
        </button>
        <button
          type="button"
          aria-label="Edit button"
          onClick={() => {
            setLabelDraft(block.props.label ?? "Button");
            setIconDraft(block.props.icon ?? "⚡");
            setEditing((e) => !e);
          }}
          className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-opacity"
        >
          <Pencil size={14} />
        </button>
      </div>
      {editing && (
        <div className="w-96 max-w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-3 text-sm space-y-3">
          <div className="flex items-center gap-2">
            <input
              aria-label="Button icon"
              value={iconDraft}
              onChange={(e) => setIconDraft(e.target.value)}
              onBlur={saveLabelIcon}
              className="w-12 text-center text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            />
            <input
              aria-label="Button label"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              onBlur={saveLabelIcon}
              className="flex-1 text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            />
          </div>
          {/* No known host data source for a button block (there is no
           * frontend lookup from noteId -> data_source_id — resolving that
           * is the click endpoint's own server-side job,
           * resolve_trigger_data_source_id) — edit_property degrades to
           * "No properties available", the same empty state
           * AutomationEditor's own picker already has. Flagged in
           * task-42-report.md. */}
          <ButtonActionChainEditor
            actions={actions}
            allowed={BUTTON_BLOCK_ACTION_TYPES}
            properties={[]}
            dataSourceId=""
            onChange={saveActions}
          />
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="text-xs px-2.5 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
          >
            Done
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirmationMessage !== null}
        title={`Run "${label}"?`}
        description={confirmationMessage ?? undefined}
        confirmLabel="Continue"
        danger={false}
        onConfirm={confirmAndRun}
        onCancel={cancelConfirm}
      />
    </div>
  );
}
