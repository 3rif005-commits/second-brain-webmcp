"use client";

// In-page replacement for window.confirm(). Native dialogs block the tab
// (including in browser automation) — this renders the same way the note
// delete confirmation does, via a portal.
import { createPortal } from "react-dom";
import { Button } from "./button";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel",
  danger = true, onConfirm, onCancel,
}: ConfirmDialogProps) {
  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 w-full max-w-sm">
        <h2 id="confirm-dialog-title"
          className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {title}
        </h2>
        {description && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-5">{description}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "danger" : "primary"} size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
