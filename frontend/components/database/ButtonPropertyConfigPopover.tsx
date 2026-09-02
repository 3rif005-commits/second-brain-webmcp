"use client";

// Milestone 12 (task-42) decision 2: the button PROPERTY's config entry
// point — clicking a button-typed column's header opens a small popover
// (this codebase's first per-column "configure this property" affordance;
// deliberately scoped to button columns only, not a general
// property-settings menu for the other 9 addable types — task-42-brief.md's
// own explicit scope cut, and its "no existing per-column entry point"
// reference fact) containing this task's own ButtonActionChainEditor,
// scoped to `BUTTON_ACTION_TYPES` (8 kinds — no `insert_blocks`: research
// §J.6.2/§25, a button property has no page of its own to insert blocks
// into). Saves via `PATCH /db/properties/{id}` with the updated
// `config.actions` — the first frontend call site for that endpoint
// (grepped; none pre-existed — see task-42-report.md's "Concerns" section).
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/app/providers";
import { BUTTON_ACTION_TYPES } from "@/lib/database/types";
import type { ButtonAction, ButtonBlockAction, PropertyResponse } from "@/lib/database/types";
import { ButtonActionChainEditor } from "./ButtonActionChainEditor";

interface ButtonPropertyConfigPopoverProps {
  property: PropertyResponse;
  /** This data source's own properties — `edit_property`'s picker target. */
  properties: PropertyResponse[];
  /** Called after a successful save so the caller can refresh its own
   * `properties` list — mirrors `DatabaseSettingsMenu`'s own
   * `onPropertiesChanged` convention. */
  onSaved?: () => void | Promise<void>;
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

function actionsFromConfig(config: Record<string, unknown> | null | undefined): ButtonAction[] {
  return Array.isArray(config?.actions) ? (config!.actions as ButtonAction[]) : [];
}

export function ButtonPropertyConfigPopover({ property, properties, onSaved }: ButtonPropertyConfigPopoverProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  // Typed ButtonBlockAction[] (the shared editor's own onChange type),
  // even though a button PROPERTY's `allowed` (BUTTON_ACTION_TYPES) never
  // actually admits `insert_blocks` at runtime — see task-42-report.md.
  const [actions, setActions] = useState<ButtonBlockAction[]>(() => actionsFromConfig(property.config));
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) setActions(actionsFromConfig(property.config));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, property.id]);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  async function save(next: ButtonBlockAction[]) {
    setSaving(true);
    try {
      const res = await fetch(`/api/db/properties/${property.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: { ...property.config, actions: next } }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await onSaved?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save this button's actions", "error");
    } finally {
      setSaving(false);
    }
  }

  // A single, uniform debounce for every ButtonActionChainEditor change
  // (structural or a literal-field keystroke alike) — simpler than
  // AutomationEditor's own immediate-vs-debounced split, a deliberate
  // simplification for this smaller, self-contained popover (flagged in
  // task-42-report.md).
  function handleActionsChange(next: ButtonBlockAction[]) {
    setActions(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(next), 500);
  }

  const label = property.name || "Button";

  return (
    <div className="relative inline-block" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="font-medium text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 flex items-center gap-1"
        aria-label={`Configure ${label} column`}
      >
        {label}
        <span aria-hidden className="text-[10px]">
          ⚙
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Configure ${label}`}
          className="absolute left-0 top-full mt-1 z-20 w-80 max-h-96 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl p-3 text-sm"
        >
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
              Button actions
            </h3>
            {saving && <span className="text-[10px] text-gray-400">Saving…</span>}
          </div>
          <ButtonActionChainEditor
            actions={actions}
            allowed={BUTTON_ACTION_TYPES}
            properties={properties}
            dataSourceId={property.data_source_id}
            onChange={handleActionsChange}
          />
        </div>
      )}
    </div>
  );
}
