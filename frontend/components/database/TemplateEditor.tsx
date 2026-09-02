"use client";

// Milestone 12 (task-40): the editor for one row template — opened by
// TemplateManager for a specific template id. Four sections (task-40-brief.md
// decision 4): header (name/icon/is_default), properties (reusing the exact
// per-type cell components TableView already has, against LOCAL draft state
// rather than a live row), page body (BlockEditor, same as a real note),
// and a repeat schedule.
import dynamic from "next/dynamic";
import { type ChangeEvent, useRef, useState } from "react";
import { useToast } from "@/app/providers";
import { isKnownPropertyType, REPEAT_FREQUENCIES, REPEAT_TIMEZONE } from "@/lib/database/types";
import type {
  PropertyResponse,
  PropertyValue,
  RepeatConfig,
  RepeatFrequency,
  RowTemplatePatch,
  RowTemplateResponse,
} from "@/lib/database/types";
import { renderCellValue } from "./cells/renderCellValue";

// Same dynamic-import + `ssr: false` convention `NoteEditorPage.tsx`/
// `NotePane.tsx` already use for every standalone `BlockEditor` mount in
// this codebase (task-40-brief.md's reference facts) — BlockNote/its deps
// aren't SSR-safe, so this avoids the same crash those two components already
// route around, rather than re-deriving a new workaround here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BlockEditor: any = dynamic(
  () => import("@/components/editor/BlockEditor").then((m) => m.BlockEditor),
  { ssr: false, loading: () => <div className="h-40 animate-pulse bg-gray-50 dark:bg-gray-800 rounded-lg" /> }
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBlock = any;

interface TemplateEditorProps {
  template: RowTemplateResponse;
  properties: PropertyResponse[];
  onUpdateTemplate: (id: string, patch: RowTemplatePatch) => Promise<RowTemplateResponse>;
}

const FREQUENCY_UNIT: Record<RepeatFrequency, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
  yearly: "year",
};

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];

function defaultRepeatConfig(): RepeatConfig {
  const today = new Date().toISOString().slice(0, 10);
  return { frequency: "daily", interval: 1, start_date: today, time_of_day: "09:00", timezone: REPEAT_TIMEZONE };
}

export function TemplateEditor({ template, properties, onUpdateTemplate }: TemplateEditorProps) {
  const { showToast } = useToast();

  async function persistField(patch: RowTemplatePatch, message: string): Promise<RowTemplateResponse | null> {
    try {
      return await onUpdateTemplate(template.id, patch);
    } catch (e) {
      showToast(e instanceof Error ? e.message : message, "error");
      return null;
    }
  }

  // ── Name / icon: on-blur save, 600ms debounce on change — mirrors
  // NoteEditorPage.tsx's title input (persistTitle/handleTitleChange/
  // handleTitleBlur) verbatim, the precedent decision 4 asks this to match
  // rather than picking a new timing.
  const [name, setName] = useState(template.name);
  const [icon, setIcon] = useState(template.icon ?? "");
  const nameDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iconDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleNameChange(e: ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setName(val);
    if (nameDebounceRef.current) clearTimeout(nameDebounceRef.current);
    nameDebounceRef.current = setTimeout(() => persistField({ name: val }, "Could not save the name"), 600);
  }
  function handleNameBlur() {
    if (nameDebounceRef.current) clearTimeout(nameDebounceRef.current);
    persistField({ name }, "Could not save the name");
  }

  function handleIconChange(e: ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setIcon(val);
    if (iconDebounceRef.current) clearTimeout(iconDebounceRef.current);
    iconDebounceRef.current = setTimeout(
      () => persistField({ icon: val || null }, "Could not save the icon"),
      600
    );
  }
  function handleIconBlur() {
    if (iconDebounceRef.current) clearTimeout(iconDebounceRef.current);
    persistField({ icon: icon || null }, "Could not save the icon");
  }

  // ── is_default: PATCHes immediately; useDatabaseView's updateTemplate has
  // no optimistic-apply-then-rollback of its own for this field (unlike
  // updateCell), so the revert-on-400 lives here (decision 4).
  const [isDefault, setIsDefault] = useState(template.is_default);
  async function handleDefaultChange(checked: boolean) {
    const previous = isDefault;
    setIsDefault(checked);
    try {
      await onUpdateTemplate(template.id, { is_default: checked });
    } catch (e) {
      setIsDefault(previous);
      showToast(e instanceof Error ? e.message : "Could not update the default template", "error");
    }
  }

  // ── Properties: one row per writable property type, reusing the exact
  // check TableView already has for "does this type get a real cell
  // component" (isKnownPropertyType/KNOWN_PROPERTY_TYPES) instead of a new
  // allow-list — this already excludes relation/formula/rollup (decision 4's
  // explicit skip list; relation is skipped because prefilling it would make
  // every instantiated row relate to the same page, research §J.5.1) and any
  // future computed-and-otherwise-unwritable type (e.g. "button", Task 42)
  // without needing to name it here.
  const editableProperties = properties.filter((p) => isKnownPropertyType(p.type));
  const [draftProperties, setDraftProperties] = useState<Record<string, PropertyValue>>(template.properties);
  const propertiesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleSaveProperties(draft: Record<string, PropertyValue>) {
    if (propertiesDebounceRef.current) clearTimeout(propertiesDebounceRef.current);
    propertiesDebounceRef.current = setTimeout(() => {
      persistField({ properties: draft }, "Could not save that property");
    }, 600);
  }

  function handlePropertyChange(key: string, value: PropertyValue | null) {
    setDraftProperties((prev) => {
      const next = { ...prev };
      if (value === null) delete next[key];
      else next[key] = value;
      scheduleSaveProperties(next);
      return next;
    });
  }

  // ── Page body ────────────────────────────────────────────────────────
  async function handleSaveContent(blocks: AnyBlock[]) {
    persistField({ content: blocks }, "Could not save the template body");
  }

  // ── Repeat schedule: turning it off clears repeat_config immediately
  // (matches the backend's own nullable-field convention); turning it on
  // only seeds a local draft. Nothing else is sent until "Save schedule" —
  // decision 4 explicitly allows a save button here instead of a PATCH per
  // field/keystroke.
  const [repeatEnabled, setRepeatEnabled] = useState(template.repeat_config !== null);
  const [repeatDraft, setRepeatDraft] = useState<RepeatConfig>(template.repeat_config ?? defaultRepeatConfig());
  const [nextRunAt, setNextRunAt] = useState(template.next_run_at);
  const [savingSchedule, setSavingSchedule] = useState(false);

  async function handleToggleRepeat(checked: boolean) {
    setRepeatEnabled(checked);
    if (checked) {
      setRepeatDraft((prev) => prev ?? defaultRepeatConfig());
      return;
    }
    try {
      const updated = await onUpdateTemplate(template.id, { repeat_config: null });
      setNextRunAt(updated.next_run_at);
    } catch (e) {
      setRepeatEnabled(true);
      showToast(e instanceof Error ? e.message : "Could not turn off the repeat schedule", "error");
    }
  }

  async function handleSaveSchedule() {
    setSavingSchedule(true);
    try {
      const config: RepeatConfig = { ...repeatDraft, timezone: REPEAT_TIMEZONE };
      const updated = await onUpdateTemplate(template.id, { repeat_config: config });
      setNextRunAt(updated.next_run_at);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save the repeat schedule", "error");
    } finally {
      setSavingSchedule(false);
    }
  }

  function toggleWeekday(day: number) {
    setRepeatDraft((prev) => {
      const weekdays = prev.weekdays ?? [];
      const next = weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day].sort();
      return { ...prev, weekdays: next };
    });
  }

  return (
    <div className="p-4 space-y-6 text-sm">
      {/* Header */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            aria-label="Template icon"
            value={icon}
            onChange={handleIconChange}
            onBlur={handleIconBlur}
            placeholder="🗒️"
            className="w-10 text-center text-base px-1 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
          />
          <input
            aria-label="Template name"
            value={name}
            onChange={handleNameChange}
            onBlur={handleNameBlur}
            placeholder="Untitled template"
            className="flex-1 text-sm px-2 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={isDefault} onChange={(e) => handleDefaultChange(e.target.checked)} />
          Default template for new rows
        </label>
      </section>

      {/* Properties */}
      {editableProperties.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Properties
          </h3>
          <div className="space-y-1.5">
            {editableProperties.map((property) => (
              <div key={property.id} className="flex items-center gap-2">
                <span className="w-28 shrink-0 text-xs text-gray-500 dark:text-gray-400 truncate">
                  {property.name}
                </span>
                <div className="flex-1 min-w-0">
                  {renderCellValue(property, draftProperties[property.key], true, (value) =>
                    handlePropertyChange(property.key, value)
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Page body */}
      <section className="space-y-1.5">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Page body
        </h3>
        <div className="border border-gray-100 dark:border-gray-700 rounded-lg">
          <BlockEditor
            noteId={template.id}
            initialContent={template.content as AnyBlock[]}
            onSave={handleSaveContent}
          />
        </div>
      </section>

      {/* Repeat schedule */}
      <section className="space-y-2">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          <input
            type="checkbox"
            checked={repeatEnabled}
            onChange={(e) => handleToggleRepeat(e.target.checked)}
          />
          Repeat
        </label>
        {repeatEnabled && (
          <div className="space-y-2 pl-1">
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <span>Every</span>
              <input
                type="number"
                min={1}
                aria-label="Repeat interval"
                value={repeatDraft.interval}
                onChange={(e) =>
                  setRepeatDraft((prev) => ({ ...prev, interval: Math.max(1, Number(e.target.value) || 1) }))
                }
                className="w-14 text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
              />
              <select
                aria-label="Repeat frequency"
                value={repeatDraft.frequency}
                onChange={(e) =>
                  setRepeatDraft((prev) => ({ ...prev, frequency: e.target.value as RepeatFrequency }))
                }
                className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
              >
                {REPEAT_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_UNIT[f]}
                    {repeatDraft.interval > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
            </div>

            {repeatDraft.frequency === "weekly" && (
              <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Repeat on weekdays">
                {WEEKDAYS.map((d) => (
                  <label key={d.value} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={(repeatDraft.weekdays ?? []).includes(d.value)}
                      onChange={() => toggleWeekday(d.value)}
                    />
                    {d.label}
                  </label>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                Start
                <input
                  type="date"
                  aria-label="Repeat start date"
                  value={repeatDraft.start_date}
                  onChange={(e) => setRepeatDraft((prev) => ({ ...prev, start_date: e.target.value }))}
                  className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
                />
              </label>
              <label className="flex items-center gap-1.5">
                Time
                <input
                  type="time"
                  aria-label="Repeat time of day"
                  value={repeatDraft.time_of_day}
                  onChange={(e) => setRepeatDraft((prev) => ({ ...prev, time_of_day: e.target.value }))}
                  className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
                />
              </label>
            </div>

            <button
              type="button"
              onClick={handleSaveSchedule}
              disabled={savingSchedule}
              className="text-xs px-2.5 py-1 rounded bg-indigo-600 text-white disabled:opacity-40"
            >
              Save schedule
            </button>

            {nextRunAt && (
              <p className="text-[11px] text-gray-400 dark:text-gray-500">
                Next: {new Date(nextRunAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
