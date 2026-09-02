"use client";

// In-page replacement for window.prompt(). Native dialogs block the tab
// (including in browser automation) — this renders via a portal instead,
// same visual language as ConfirmDialog / the note delete confirmation.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";

export interface PromptDialogProps {
  open: boolean;
  title: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptDialog({
  open, title, label, placeholder, defaultValue = "",
  confirmLabel = "OK", cancelLabel = "Cancel", onSubmit, onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  if (!open || typeof document === "undefined") return null;

  function submit() {
    const trimmed = value.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-dialog-title"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 w-full max-w-sm">
        <h2 id="prompt-dialog-title"
          className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
          {title}
        </h2>
        {label && (
          <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
            {label}
          </label>
        )}
        <input
          autoFocus
          className="w-full text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-gray-800 dark:text-gray-200 outline-none focus:border-indigo-400"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
        <div className="flex justify-end gap-2 mt-5">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}
