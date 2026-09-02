"use client";

// Milestone 12 (task-42) decision 1: the button PROPERTY's cell renderer.
// research §25: "every row shows the same button" — there is no per-row
// value, unlike every other cell in this directory, so this component takes
// its own button-specific props (`property`/`noteId`/`editable`) rather
// than conforming to `CellProps<V>` (see ../cells/CellProps.ts — its
// `value`/`onChange` shape has no natural meaning for a valueless button;
// task-42-report.md documents this as the flagged judgment call).
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { PropertyResponse } from "@/lib/database/types";
import { useButtonClick } from "@/lib/database/useButtonClick";

export interface ButtonCellProps {
  property: PropertyResponse;
  /** This row's id — a button property has no `value` to read out of
   * `row.properties[key]`, so the one thing it actually needs from the row
   * is which note the click endpoint should act on. */
  noteId: string;
  /** All Notes (the one non-editable source, CellProps.ts's own docstring)
   * has no write endpoint for anything, buttons included — mirrors every
   * other cell's own `editable` gate. */
  editable: boolean;
}

export function ButtonCell({ property, noteId, editable }: ButtonCellProps) {
  const label = property.name || "Button";
  const { click, pending, confirmationMessage, confirmAndRun, cancelConfirm } = useButtonClick({
    postClick: (confirmed) =>
      fetch(`/api/db/data-sources/${property.data_source_id}/rows/${noteId}/buttons/${property.key}/click`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed }),
      }),
  });

  return (
    <>
      <button
        type="button"
        disabled={!editable || pending}
        onClick={click}
        className="text-xs px-2.5 py-1 rounded bg-indigo-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {label}
      </button>
      <ConfirmDialog
        open={confirmationMessage !== null}
        title={`Run "${label}"?`}
        description={confirmationMessage ?? undefined}
        confirmLabel="Continue"
        danger={false}
        onConfirm={confirmAndRun}
        onCancel={cancelConfirm}
      />
    </>
  );
}
