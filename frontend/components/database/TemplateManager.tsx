"use client";

// Milestone 12 (task-40): "Manage templates" modal, opened from a new
// "Templates" section in DatabaseSettingsMenu.tsx (decision 1). Follows
// components/search/SearchModal.tsx's full-screen-overlay convention
// (open/onClose props, an `open && (...)` conditional render) rather than
// ConfirmDialog's createPortal+document-check shape — that one is sized for
// a small confirm/prompt box, not a list plus a nested BlockEditor-carrying
// editor (decision 2).
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useToast } from "@/app/providers";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { TemplateEditor } from "./TemplateEditor";
import type { PropertyResponse, RepeatConfig, RowTemplatePatch, RowTemplateResponse } from "@/lib/database/types";

interface TemplateManagerProps {
  open: boolean;
  onClose: () => void;
  templates: RowTemplateResponse[];
  properties: PropertyResponse[];
  onCreateTemplate: (name: string, icon?: string | null) => Promise<RowTemplateResponse>;
  onUpdateTemplate: (id: string, patch: RowTemplatePatch) => Promise<RowTemplateResponse>;
  onDeleteTemplate: (id: string) => Promise<void>;
}

const FREQUENCY_UNIT: Record<RepeatConfig["frequency"], string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

/** e.g. "Every day at 09:00" / "Every 2 weeks at 09:00" — proves the repeat
 * config round-trips without re-deriving date math client-side (the list
 * row's own "at a glance" summary; TemplateEditor shows the server-computed
 * `next_run_at` for the same reason). */
function describeRepeat(config: RepeatConfig): string {
  const unit = FREQUENCY_UNIT[config.frequency];
  const every = config.interval > 1 ? `Every ${config.interval} ${unit}s` : `Every ${unit}`;
  return `${every} at ${config.time_of_day}`;
}

export function TemplateManager({
  open,
  onClose,
  templates,
  properties,
  onCreateTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
}: TemplateManagerProps) {
  const { showToast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setEditingId(null);
      setConfirmDeleteId(null);
    }
  }, [open]);

  if (!open) return null;

  // "New template" creates immediately (POST with just a name, no
  // property/content collection up front) and opens TemplateEditor on the
  // freshly-created id — same "create immediately, edit in place"
  // convention this codebase already uses for databases themselves
  // (Sidebar.tsx's handleNewDatabase), decision 2.
  async function handleNewTemplate() {
    setCreating(true);
    try {
      const created = await onCreateTemplate("Untitled template");
      setEditingId(created.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not create template", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDeleteId) return;
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    try {
      await onDeleteTemplate(id);
      if (editingId === id) setEditingId(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete template", "error");
    }
  }

  const editingTemplate = editingId ? (templates.find((t) => t.id === editingId) ?? null) : null;
  const deletingTemplate = confirmDeleteId ? (templates.find((t) => t.id === confirmDeleteId) ?? null) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] px-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Templates"
        className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {editingTemplate && (
              <button
                type="button"
                aria-label="Back to templates"
                onClick={() => setEditingId(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                ←
              </button>
            )}
            Templates
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {editingTemplate ? (
            <TemplateEditor
              key={editingTemplate.id}
              template={editingTemplate}
              properties={properties}
              onUpdateTemplate={onUpdateTemplate}
            />
          ) : (
            <div className="p-4 space-y-3">
              <Button type="button" size="sm" onClick={handleNewTemplate} disabled={creating}>
                + New template
              </Button>
              {templates.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-gray-500">No templates yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                  {templates.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 py-2">
                      {t.icon && <span className="text-base leading-none">{t.icon}</span>}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                            {t.name}
                          </span>
                          {t.is_default && (
                            <span className="text-[10px] font-medium uppercase tracking-wide text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/40 px-1.5 py-0.5 rounded">
                              Default
                            </span>
                          )}
                        </div>
                        {t.repeat_config && (
                          <p className="text-xs text-gray-400 dark:text-gray-500">
                            {describeRepeat(t.repeat_config)}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditingId(t.id)}
                        className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-2 py-1"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(t.id)}
                        className="text-xs text-red-500 hover:text-red-700 px-2 py-1"
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDeleteId !== null}
        title="Delete this template?"
        description={deletingTemplate ? `"${deletingTemplate.name}" will be permanently deleted.` : undefined}
        confirmLabel="Delete"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
