"use client";

// Milestone 12 (task-41): "Manage automations" modal, opened from a new
// "Automations" section in DatabaseSettingsMenu.tsx (task-41-brief.md
// decision 1) — mirrors TemplateManager.tsx's own list/create/delete shell
// exactly: same SearchModal-style full-screen overlay convention, same "New
// creates immediately with a default name, then opens the editor in place"
// flow, same ConfirmDialog-gated delete.
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useToast } from "@/app/providers";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { AutomationEditor } from "./AutomationEditor";
import type { AutomationPatch, AutomationResponse, PropertyResponse } from "@/lib/database/types";

interface AutomationManagerProps {
  open: boolean;
  onClose: () => void;
  automations: AutomationResponse[];
  properties: PropertyResponse[];
  dataSourceId: string;
  onCreateAutomation: (name: string) => Promise<AutomationResponse>;
  onUpdateAutomation: (id: string, patch: AutomationPatch) => Promise<AutomationResponse>;
  onDeleteAutomation: (id: string) => Promise<void>;
}

export function AutomationManager({
  open,
  onClose,
  automations,
  properties,
  dataSourceId,
  onCreateAutomation,
  onUpdateAutomation,
  onDeleteAutomation,
}: AutomationManagerProps) {
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

  // "New automation" creates immediately (POST with just a name, empty
  // triggers/actions) and opens AutomationEditor on the freshly-created id —
  // same "create immediately, edit in place" convention TemplateManager's
  // own "New template" already uses (decision 1).
  async function handleNewAutomation() {
    setCreating(true);
    try {
      const created = await onCreateAutomation("Untitled automation");
      setEditingId(created.id);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not create automation", "error");
    } finally {
      setCreating(false);
    }
  }

  async function handleConfirmDelete() {
    if (!confirmDeleteId) return;
    const id = confirmDeleteId;
    setConfirmDeleteId(null);
    try {
      await onDeleteAutomation(id);
      if (editingId === id) setEditingId(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete automation", "error");
    }
  }

  const editingAutomation = editingId ? (automations.find((a) => a.id === editingId) ?? null) : null;
  const deletingAutomation = confirmDeleteId ? (automations.find((a) => a.id === confirmDeleteId) ?? null) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] px-4 bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Automations"
        className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-white dark:bg-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {editingAutomation && (
              <button
                type="button"
                aria-label="Back to automations"
                onClick={() => setEditingId(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                ←
              </button>
            )}
            Automations
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
          {editingAutomation ? (
            <AutomationEditor
              key={editingAutomation.id}
              automation={editingAutomation}
              properties={properties}
              dataSourceId={dataSourceId}
              onUpdateAutomation={onUpdateAutomation}
            />
          ) : (
            <div className="p-4 space-y-3">
              <Button type="button" size="sm" onClick={handleNewAutomation} disabled={creating}>
                + New automation
              </Button>
              {automations.length === 0 ? (
                <p className="text-sm text-gray-400 dark:text-gray-500">No automations yet.</p>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                  {automations.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                            {a.name}
                          </span>
                          {!a.is_active && (
                            <span className="text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">
                              Inactive
                            </span>
                          )}
                          {a.last_error && (
                            <span className="text-[10px] font-medium uppercase tracking-wide text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/40 px-1.5 py-0.5 rounded">
                              Failed
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          {a.triggers.length === 0
                            ? "No trigger yet"
                            : `${a.triggers.length} trigger${a.triggers.length > 1 ? "s" : ""} · ${a.actions.length} action${a.actions.length === 1 ? "" : "s"}`}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditingId(a.id)}
                        className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 px-2 py-1"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(a.id)}
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
        title="Delete this automation?"
        description={deletingAutomation ? `"${deletingAutomation.name}" will be permanently deleted.` : undefined}
        confirmLabel="Delete"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </div>
  );
}
