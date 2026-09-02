"use client";

// Database header settings menu (task-22-brief.md §4): turn on sub-items
// (+ pick a display mode), turn on dependencies (+ the three date-shift
// modes by Notion's exact names, "avoid weekends", and which date property
// the shift acts on). No native confirm/alert anywhere — "turn on" isn't
// destructive (nothing to undo-by-confirming; the property just appears),
// so this doesn't need ConfirmDialog either, only a plain error toast on
// a failed POST/PATCH.
import { useState } from "react";
import { useToast } from "@/app/providers";
import { DATE_SHIFT_MODES, findSystemRelationProperty } from "@/lib/database/types";
import type {
  AutomationPatch,
  AutomationResponse,
  PropertyResponse,
  RowTemplatePatch,
  RowTemplateResponse,
  ViewResponse,
} from "@/lib/database/types";
import { TemplateManager } from "./TemplateManager";
import { AutomationManager } from "./AutomationManager";

interface DatabaseSettingsMenuProps {
  dataSourceId: string;
  properties: PropertyResponse[];
  /** The currently active view — sub-item display mode lives on *its*
   * config (task-22-brief.md §3: "the mode lives in the view's config"),
   * so there's nothing to show/edit here without one. */
  activeView: ViewResponse | null;
  /** Called after a successful enable/PATCH so the caller's `properties`
   * (and, for the display-mode select, `activeView`) reflect the change —
   * useDatabaseView's `refetch`. */
  onPropertiesChanged: () => void | Promise<void>;
  onUpdateView: (viewId: string, patch: { config: Record<string, unknown> }) => Promise<ViewResponse>;
  // Milestone 12 (task-40): row templates. Threaded straight through to
  // TemplateManager (decision 1: this menu is too small — fixed `w-72` —
  // to host a template list, let alone a nested BlockEditor, so it only
  // owns the "open the modal" entry point, not the template list/editor
  // themselves).
  templates: RowTemplateResponse[];
  onCreateTemplate: (name: string, icon?: string | null) => Promise<RowTemplateResponse>;
  onUpdateTemplate: (id: string, patch: RowTemplatePatch) => Promise<RowTemplateResponse>;
  onDeleteTemplate: (id: string) => Promise<void>;
  // Milestone 12 (task-41): database automations. Same "this menu only owns
  // the entry point" reasoning as templates above — threaded straight
  // through to AutomationManager.
  automations: AutomationResponse[];
  onCreateAutomation: (name: string) => Promise<AutomationResponse>;
  onUpdateAutomation: (id: string, patch: AutomationPatch) => Promise<AutomationResponse>;
  onDeleteAutomation: (id: string) => Promise<void>;
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

export function DatabaseSettingsMenu({
  dataSourceId,
  properties,
  activeView,
  onPropertiesChanged,
  onUpdateView,
  templates,
  onCreateTemplate,
  onUpdateTemplate,
  onDeleteTemplate,
  automations,
  onCreateAutomation,
  onUpdateAutomation,
  onDeleteAutomation,
}: DatabaseSettingsMenuProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [enablingSubItems, setEnablingSubItems] = useState(false);
  const [enablingDependencies, setEnablingDependencies] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [automationsOpen, setAutomationsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const subItemForward = findSystemRelationProperty(properties, "sub_item", "forward");
  const dependencyForward = findSystemRelationProperty(properties, "dependency", "forward");
  const dateProperties = properties.filter((p) => p.type === "date");

  async function enableSubItems() {
    setEnablingSubItems(true);
    try {
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/sub-items`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      await onPropertiesChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not turn on sub-items", "error");
    } finally {
      setEnablingSubItems(false);
    }
  }

  async function enableDependencies() {
    setEnablingDependencies(true);
    try {
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/dependencies`, { method: "POST" });
      if (!res.ok) throw new Error(await errorMessage(res));
      await onPropertiesChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not turn on dependencies", "error");
    } finally {
      setEnablingDependencies(false);
    }
  }

  async function patchDependencySettings(patch: Record<string, unknown>) {
    if (!dependencyForward) return;
    const relationId = dependencyForward.config.relation_id;
    try {
      const res = await fetch(`/api/db/relations/${relationId}/dependency-settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await onPropertiesChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not update dependency settings", "error");
    }
  }

  const subtasksConfig =
    activeView && typeof activeView.config.subtasks === "object" && activeView.config.subtasks !== null
      ? (activeView.config.subtasks as Record<string, unknown>)
      : undefined;
  const displayMode = typeof subtasksConfig?.display_mode === "string" ? subtasksConfig.display_mode : "show";

  async function setDisplayMode(mode: string) {
    if (!activeView) return;
    await onUpdateView(activeView.id, {
      config: { ...activeView.config, subtasks: { display_mode: mode } },
    });
  }

  // task-48-brief.md: export honors the CURRENTLY OPEN view's filter/sort --
  // it acts on `activeView`, matching this menu's existing scope for other
  // activeView-specific actions (the sub-item display-mode picker above),
  // unlike CSV *import* (task-47), which creates a whole new database and
  // lives in Sidebar.tsx instead. Follows BlockEditor.tsx's exact
  // Blob/createObjectURL/`<a download>` client-side download shape (~lines
  // 246-259) rather than inventing a different download mechanism -- no
  // native dialogs anywhere.
  async function exportCsv() {
    if (!activeView || exporting) return;
    setExporting(true);
    try {
      const res = await fetch(
        `/api/db/data-sources/${dataSourceId}/export?view_id=${activeView.id}`
      );
      if (!res.ok) throw new Error(await errorMessage(res));
      // task-51 Fix 5 (M14 final cross-cutting review): export silently truncated at
      // 500 rows with no signal, while CSV import allows far more -- the backend now
      // flags a truncated export with this header (proxied through unchanged by
      // `/api/db/[...path]`'s route.ts); still trigger the download either way (a
      // truncated-but-present export is still useful), just warn honestly alongside it.
      if (res.headers.get("X-Export-Truncated")) {
        showToast(
          "Export limited to the first 500 rows -- some rows may be missing",
          "info"
        );
      }
      const blob = await res.blob();
      const safeName = activeView.name.replace(/[^a-z0-9]/gi, "_").toLowerCase() || "export";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not export CSV", "error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Database settings"
        onClick={() => setOpen((o) => !o)}
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 text-sm px-1.5 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        ⚙
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Database settings"
          className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg p-3 text-xs space-y-4"
        >
          <section>
            <h3 className="font-semibold text-gray-700 dark:text-gray-200 mb-1.5">Sub-items</h3>
            {!subItemForward ? (
              <button
                type="button"
                onClick={enableSubItems}
                disabled={enablingSubItems}
                className="text-xs px-2 py-1 rounded bg-indigo-600 text-white disabled:opacity-40"
              >
                Turn on sub-items
              </button>
            ) : !activeView ? (
              <p className="text-gray-400">No active view to configure.</p>
            ) : (
              <div>
                <label className="block text-gray-500 dark:text-gray-400 mb-1">Display as</label>
                <select
                  aria-label="Sub-item display mode"
                  value={displayMode}
                  onChange={(e) => setDisplayMode(e.target.value)}
                  className="w-full text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                >
                  <option value="show">Nested in toggle</option>
                  <option value="flattened">Flattened list</option>
                </select>
              </div>
            )}
          </section>

          <section>
            <h3 className="font-semibold text-gray-700 dark:text-gray-200 mb-1.5">Dependencies</h3>
            {!dependencyForward ? (
              <button
                type="button"
                onClick={enableDependencies}
                disabled={enablingDependencies}
                className="text-xs px-2 py-1 rounded bg-indigo-600 text-white disabled:opacity-40"
              >
                Turn on dependencies
              </button>
            ) : (
              <div className="space-y-2">
                <div>
                  <label className="block text-gray-500 dark:text-gray-400 mb-1">Date property</label>
                  <select
                    aria-label="Dependency date property"
                    value={
                      typeof dependencyForward.config.date_property_key === "string"
                        ? (dependencyForward.config.date_property_key as string)
                        : ""
                    }
                    onChange={(e) => patchDependencySettings({ date_property_key: e.target.value || null })}
                    className="w-full text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
                  >
                    <option value="">None</option>
                    {dateProperties.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <fieldset>
                  <legend className="block text-gray-500 dark:text-gray-400 mb-1">Move dependent dates</legend>
                  <div role="radiogroup" aria-label="Date shift mode" className="space-y-1">
                    {DATE_SHIFT_MODES.map((mode) => (
                      <label key={mode} className="flex items-center gap-1.5">
                        <input
                          type="radio"
                          name="date-shift-mode"
                          value={mode}
                          checked={dependencyForward.config.date_shift_mode === mode}
                          onChange={() => patchDependencySettings({ date_shift_mode: mode })}
                        />
                        {mode}
                      </label>
                    ))}
                  </div>
                </fieldset>

                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={Boolean(dependencyForward.config.avoid_weekends)}
                    onChange={(e) => patchDependencySettings({ avoid_weekends: e.target.checked })}
                  />
                  Avoid weekends
                </label>

                <p className="text-[10px] text-gray-400 dark:text-gray-500 pt-1 border-t border-gray-100 dark:border-gray-700">
                  Dependency arrows only appear in the Timeline view — enable arrows from any
                  Timeline view&apos;s settings.
                </p>
              </div>
            )}
          </section>

          <section>
            <h3 className="font-semibold text-gray-700 dark:text-gray-200 mb-1.5">Templates</h3>
            <button
              type="button"
              onClick={() => {
                setTemplatesOpen(true);
                setOpen(false);
              }}
              className="text-xs px-2 py-1 rounded bg-indigo-600 text-white"
            >
              Manage templates
            </button>
          </section>

          <section>
            <h3 className="font-semibold text-gray-700 dark:text-gray-200 mb-1.5">Automations</h3>
            <button
              type="button"
              onClick={() => {
                setAutomationsOpen(true);
                setOpen(false);
              }}
              className="text-xs px-2 py-1 rounded bg-indigo-600 text-white"
            >
              Manage automations
            </button>
          </section>

          <section>
            <h3 className="font-semibold text-gray-700 dark:text-gray-200 mb-1.5">Export</h3>
            <button
              type="button"
              onClick={exportCsv}
              disabled={!activeView || exporting}
              className="text-xs px-2 py-1 rounded bg-indigo-600 text-white disabled:opacity-40"
            >
              {exporting ? "Exporting…" : "Export CSV"}
            </button>
          </section>
        </div>
      )}

      <TemplateManager
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        templates={templates}
        properties={properties}
        onCreateTemplate={onCreateTemplate}
        onUpdateTemplate={onUpdateTemplate}
        onDeleteTemplate={onDeleteTemplate}
      />

      <AutomationManager
        open={automationsOpen}
        onClose={() => setAutomationsOpen(false)}
        automations={automations}
        properties={properties}
        dataSourceId={dataSourceId}
        onCreateAutomation={onCreateAutomation}
        onUpdateAutomation={onUpdateAutomation}
        onDeleteAutomation={onDeleteAutomation}
      />
    </div>
  );
}
