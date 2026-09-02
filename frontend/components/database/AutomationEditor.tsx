"use client";

// Milestone 12 (task-41): the editor for one database automation — opened
// by AutomationManager for a specific automation id. Mirrors TemplateEditor
// .tsx's own per-field persistence conventions (debounced text inputs,
// immediate structural changes, a revert-on-error pattern for optimistic
// checkboxes) applied to a very different shape: triggers/actions arrays
// instead of a properties record + repeat_config.
//
// Sections (task-41-brief.md decision 2): header (name/is_active/
// last_error), Trigger(s) (a trigger-kind selector per row + that kind's
// own sub-form, a combinator toggle once 2+ non-schedule triggers exist),
// Action chain (an ordered list of 6 possible action kinds, up/down
// reorder, delete). Every field change PATCHes the whole `triggers`/
// `actions` array together — debounced for raw text/number inputs,
// immediate for structural changes (add/remove/reorder/type switch) and
// discrete pickers (checkboxes/selects).
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/app/providers";
import { isKnownPropertyType, PROPERTY_EDITED_CONDITIONS, PROPERTY_EDITED_CONDITION_LABELS, REPEAT_FREQUENCIES, REPEAT_TIMEZONE, AUTOMATION_TRIGGER_TYPES, AUTOMATION_ACTION_TYPES } from "@/lib/database/types";
import type {
  AutomationAction,
  AutomationActionType,
  AutomationPatch,
  AutomationResponse,
  AutomationTrigger,
  AutomationTriggerCombinator,
  AutomationTriggerType,
  DatabaseDetailResponse,
  DatabaseListResponse,
  DatabaseSummary,
  DefineVariablesAction,
  EveryFrequencyTrigger,
  FormulaValueWrapper,
  PropertyEditedTrigger,
  PropertyResponse,
  PropertyValue,
  RepeatFrequency,
  ValueOrFormula,
} from "@/lib/database/types";
import { renderCellValue } from "./cells/renderCellValue";
import { FormulaEditor } from "./FormulaEditor";

interface AutomationEditorProps {
  automation: AutomationResponse;
  /** This data source's own properties — the trigger's property_edited
   * picker, and `edit_property`'s picker (always the trigger row, never a
   * cross-data-source target — research §J.6.6). */
  properties: PropertyResponse[];
  dataSourceId: string;
  onUpdateAutomation: (id: string, patch: AutomationPatch) => Promise<AutomationResponse>;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (typeof body?.error === "string") return body.error;
  } catch {
    // body wasn't JSON — fall through
  }
  return `Request failed (${res.status})`;
}

/** `services/db/automations.py`'s own `_is_formula_ref`: a dict with ONLY a
 * `formula` string key. */
function isFormulaRef(value: unknown): value is FormulaValueWrapper {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 1 &&
    typeof (value as Record<string, unknown>).formula === "string"
  );
}

function defaultValueForProperty(property: PropertyResponse | undefined): PropertyValue {
  switch (property?.type) {
    case "title":
      return { type: "title", title: "" };
    case "number":
      return { type: "number", number: null };
    case "select":
      return { type: "select", select: null };
    case "multi_select":
      return { type: "multi_select", multi_select: [] };
    case "status":
      return { type: "status", status: null };
    case "date":
      return { type: "date", date: null };
    case "checkbox":
      return { type: "checkbox", checkbox: false };
    case "rich_text":
    default:
      return { type: "rich_text", rich_text: "" };
  }
}

function defaultScheduleTrigger(): EveryFrequencyTrigger {
  const today = new Date().toISOString().slice(0, 10);
  return {
    type: "every_frequency",
    frequency: "daily",
    interval: 1,
    start_date: today,
    time_of_day: "09:00",
    timezone: REPEAT_TIMEZONE,
    end_date: null,
  };
}

function defaultAction(knownProperties: PropertyResponse[]): AutomationAction {
  const firstProp = knownProperties[0];
  return { type: "edit_property", property_key: firstProp?.key ?? "", value: defaultValueForProperty(firstProp) };
}

const TRIGGER_TYPE_LABELS: Record<AutomationTriggerType, string> = {
  page_added: "Page added",
  property_edited: "Property edited",
  every_frequency: "On a schedule",
};

const ACTION_TYPE_LABELS: Record<AutomationActionType, string> = {
  edit_property: "Edit property",
  add_page_to: "Add a page to…",
  edit_pages_in: "Edit pages in…",
  send_notification: "Send a notification",
  send_webhook: "Send a webhook",
  define_variables: "Define a variable",
};

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

const fieldClass =
  "text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100";
const toggleBtnClass = (active: boolean) =>
  `text-[11px] px-2 py-0.5 rounded ${active ? "bg-indigo-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"}`;

/** Toggles between a property's own cell editor (literal) and a
 * `FormulaEditor` (formula) — task-41-brief.md's reference facts: every
 * `{"formula": "..."}`-capable config field offers this, except
 * `send_webhook.url` (literal-only, rendered as a plain input, never this
 * component) and `define_variables.formula` (ALWAYS formula, rendered as a
 * bare `FormulaEditor`, never this component either). The formula draft is
 * debounced 600ms before committing (mirrors TemplateEditor's own
 * debounce precedent) — `FormulaEditor`'s own `debounceMs` only gates its
 * internal validate-fetch, not persistence. */
export function PropertyValueOrFormulaField({
  dataSourceId,
  property,
  value,
  onCommit,
}: {
  dataSourceId: string;
  property: PropertyResponse | undefined;
  value: ValueOrFormula | undefined;
  onCommit: (value: ValueOrFormula) => void;
}) {
  const [mode, setMode] = useState<"literal" | "formula">(isFormulaRef(value) ? "formula" : "literal");
  const [formulaDraft, setFormulaDraft] = useState(isFormulaRef(value) ? value.formula : "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleFormulaChange(next: string) {
    setFormulaDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onCommit({ formula: next }), 600);
  }

  if (!property) {
    return <span className="text-xs text-gray-400 dark:text-gray-500">Choose a property first.</span>;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <button type="button" aria-pressed={mode === "literal"} className={toggleBtnClass(mode === "literal")} onClick={() => setMode("literal")}>
          Value
        </button>
        <button type="button" aria-pressed={mode === "formula"} className={toggleBtnClass(mode === "formula")} onClick={() => setMode("formula")}>
          Formula
        </button>
      </div>
      {mode === "literal" ? (
        renderCellValue(property, isFormulaRef(value) ? undefined : (value as PropertyValue | undefined), true, (v) => {
          if (v) onCommit(v);
        })
      ) : (
        <FormulaEditor dataSourceId={dataSourceId} expression={formulaDraft} onExpressionChange={handleFormulaChange} />
      )}
    </div>
  );
}

/** Same literal/formula toggle as `PropertyValueOrFormulaField` above, for
 * `send_notification.message` — task-41-brief.md's own named example of "a
 * plain text input where no richer editor exists" (this field isn't tied to
 * any property, so there's no cell component to reuse). */
export function TextOrFormulaField({
  dataSourceId,
  value,
  onCommit,
  ariaLabel,
  placeholder,
}: {
  dataSourceId: string;
  value: string | FormulaValueWrapper | undefined;
  onCommit: (value: string | FormulaValueWrapper) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const formulaRef = isFormulaRef(value);
  const [mode, setMode] = useState<"literal" | "formula">(formulaRef ? "formula" : "literal");
  const [textDraft, setTextDraft] = useState(!formulaRef && typeof value === "string" ? value : "");
  const [formulaDraft, setFormulaDraft] = useState(formulaRef ? value.formula : "");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function schedule(next: string | FormulaValueWrapper) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onCommit(next), 600);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <button type="button" aria-pressed={mode === "literal"} className={toggleBtnClass(mode === "literal")} onClick={() => setMode("literal")}>
          Value
        </button>
        <button type="button" aria-pressed={mode === "formula"} className={toggleBtnClass(mode === "formula")} onClick={() => setMode("formula")}>
          Formula
        </button>
      </div>
      {mode === "literal" ? (
        <input
          aria-label={ariaLabel}
          value={textDraft}
          placeholder={placeholder}
          onChange={(e) => {
            setTextDraft(e.target.value);
            schedule(e.target.value);
          }}
          className={fieldClass}
        />
      ) : (
        <FormulaEditor
          dataSourceId={dataSourceId}
          expression={formulaDraft}
          onExpressionChange={(next) => {
            setFormulaDraft(next);
            schedule({ formula: next });
          }}
        />
      )}
    </div>
  );
}

export function AutomationEditor({ automation, properties, dataSourceId, onUpdateAutomation }: AutomationEditorProps) {
  const { showToast } = useToast();
  const knownProperties = properties.filter((p) => isKnownPropertyType(p.type));

  async function persistField(patch: AutomationPatch, message: string): Promise<AutomationResponse | null> {
    try {
      return await onUpdateAutomation(automation.id, patch);
    } catch (e) {
      showToast(e instanceof Error ? e.message : message, "error");
      return null;
    }
  }

  // ── Name: on-blur save, 600ms debounce on change — same precedent
  // TemplateEditor's own name field established for task-40.
  const [name, setName] = useState(automation.name);
  const nameDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setName(val);
    if (nameDebounceRef.current) clearTimeout(nameDebounceRef.current);
    nameDebounceRef.current = setTimeout(() => persistField({ name: val }, "Could not save the name"), 600);
  }
  function handleNameBlur() {
    if (nameDebounceRef.current) clearTimeout(nameDebounceRef.current);
    persistField({ name }, "Could not save the name");
  }

  // ── is_active: PATCHes immediately, reverts locally on a rejected
  // request — same pattern TemplateEditor's is_default uses.
  const [isActive, setIsActive] = useState(automation.is_active);
  async function handleActiveChange(checked: boolean) {
    const previous = isActive;
    setIsActive(checked);
    try {
      await onUpdateAutomation(automation.id, { is_active: checked });
    } catch (e) {
      setIsActive(previous);
      showToast(e instanceof Error ? e.message : "Could not update the automation's active state", "error");
    }
  }

  // ── Triggers ─────────────────────────────────────────────────────────
  const [triggers, setTriggers] = useState<AutomationTrigger[]>(automation.triggers);
  const [triggerCombinator, setTriggerCombinator] = useState<AutomationTriggerCombinator>(automation.trigger_combinator);
  const triggerDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function persistTriggersImmediate(next: AutomationTrigger[]) {
    setTriggers(next);
    if (triggerDebounceRef.current) {
      clearTimeout(triggerDebounceRef.current);
      triggerDebounceRef.current = null;
    }
    persistField({ triggers: next }, "Could not save the trigger(s)");
  }
  function persistTriggersDebounced(next: AutomationTrigger[]) {
    setTriggers(next);
    if (triggerDebounceRef.current) clearTimeout(triggerDebounceRef.current);
    triggerDebounceRef.current = setTimeout(() => persistField({ triggers: next }, "Could not save the trigger(s)"), 600);
  }

  function persistCombinator(value: AutomationTriggerCombinator) {
    setTriggerCombinator(value);
    persistField({ trigger_combinator: value }, "Could not save the trigger combinator");
  }

  const hasScheduleTrigger = triggers.some((t) => t.type === "every_frequency");

  function handleAddTrigger() {
    persistTriggersImmediate([...triggers, { type: "page_added" }]);
  }

  function handleRemoveTrigger(index: number) {
    persistTriggersImmediate(triggers.filter((_, i) => i !== index));
  }

  // Decision 2 (task-41-brief.md): picking every_frequency REPLACES the
  // whole triggers array with just that one entry — the research-documented
  // "can't be paired with another type of trigger" rule, surfaced here as a
  // replace rather than a silent 400 on save.
  function handleTriggerTypeChange(index: number, type: AutomationTriggerType) {
    if (type === "every_frequency") {
      persistTriggersImmediate([defaultScheduleTrigger()]);
      return;
    }
    const next = triggers.map((t, i): AutomationTrigger => {
      if (i !== index) return t;
      if (type === "page_added") return { type: "page_added" };
      const firstProp = knownProperties[0];
      return { type: "property_edited", property_key: firstProp?.key ?? "", condition: "any_change" };
    });
    persistTriggersImmediate(next);
  }

  function patchTrigger(index: number, patch: Record<string, unknown>, immediate: boolean) {
    const next = triggers.map((t, i) => (i === index ? ({ ...t, ...patch } as AutomationTrigger) : t));
    if (immediate) persistTriggersImmediate(next);
    else persistTriggersDebounced(next);
  }

  // ── Actions ──────────────────────────────────────────────────────────
  const [actions, setActions] = useState<AutomationAction[]>(automation.actions);
  const actionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function persistActionsImmediate(next: AutomationAction[]) {
    setActions(next);
    if (actionDebounceRef.current) {
      clearTimeout(actionDebounceRef.current);
      actionDebounceRef.current = null;
    }
    persistField({ actions: next }, "Could not save the action(s)");
  }
  function persistActionsDebounced(next: AutomationAction[]) {
    setActions(next);
    if (actionDebounceRef.current) clearTimeout(actionDebounceRef.current);
    actionDebounceRef.current = setTimeout(() => persistField({ actions: next }, "Could not save the action(s)"), 600);
  }

  function handleAddAction() {
    persistActionsImmediate([...actions, defaultAction(knownProperties)]);
  }
  function handleRemoveAction(index: number) {
    persistActionsImmediate(actions.filter((_, i) => i !== index));
  }
  function handleMoveAction(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    [next[index], next[target]] = [next[target], next[index]];
    persistActionsImmediate(next);
  }
  function handleActionTypeChange(index: number, type: AutomationActionType) {
    const next = actions.map((a, i): AutomationAction => {
      if (i !== index) return a;
      switch (type) {
        case "edit_property": {
          const firstProp = knownProperties[0];
          return { type: "edit_property", property_key: firstProp?.key ?? "", value: defaultValueForProperty(firstProp) };
        }
        case "add_page_to":
          return { type: "add_page_to", data_source_id: "", properties: {} };
        case "edit_pages_in":
          return { type: "edit_pages_in", target: "trigger_row", data_source_id: "", property_key: "", value: { type: "rich_text", rich_text: "" } };
        case "send_notification":
          return { type: "send_notification", message: "" };
        case "send_webhook":
          return { type: "send_webhook", url: "" };
        case "define_variables":
          return { type: "define_variables", name: "", formula: { formula: "" } };
      }
    });
    persistActionsImmediate(next);
  }
  function patchAction(index: number, patch: Record<string, unknown>, immediate: boolean) {
    const next = actions.map((a, i) => (i === index ? ({ ...a, ...patch } as AutomationAction) : a));
    if (immediate) persistActionsImmediate(next);
    else persistActionsDebounced(next);
  }

  // ── Cross-data-source property lookups (task-41-brief.md decision 4): a
  // NEW, small hook-level concern local to this component — `add_page_to`/
  // `edit_pages_in`'s target database's properties aren't in
  // useDatabaseView's own `properties` (scoped to THIS data source).
  const [databases, setDatabases] = useState<DatabaseSummary[] | null>(null);
  const databasesFetchStarted = useRef(false);
  useEffect(() => {
    const needsDatabases = actions.some((a) => a.type === "add_page_to" || a.type === "edit_pages_in");
    if (!needsDatabases || databasesFetchStarted.current) return;
    databasesFetchStarted.current = true;
    fetch("/api/db/databases")
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorMessage(res));
        const data: DatabaseListResponse = await res.json();
        setDatabases(data.databases);
      })
      .catch((e) => showToast(e instanceof Error ? e.message : "Could not load databases", "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions]);

  const [targetPropertiesById, setTargetPropertiesById] = useState<Record<string, PropertyResponse[]>>({});
  const targetPropertiesFetching = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!databases) return;
    const neededIds = new Set<string>();
    for (const a of actions) {
      if ((a.type === "add_page_to" || a.type === "edit_pages_in") && a.data_source_id) {
        neededIds.add(a.data_source_id);
      }
    }
    neededIds.forEach((dsId) => {
      if (targetPropertiesById[dsId] || targetPropertiesFetching.current.has(dsId)) return;
      const targetDb = databases.find((d) => d.data_source.id === dsId);
      if (!targetDb) return;
      targetPropertiesFetching.current.add(dsId);
      fetch(`/api/db/databases/${targetDb.database.id}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(await errorMessage(res));
          const data: DatabaseDetailResponse = await res.json();
          setTargetPropertiesById((prev) => ({ ...prev, [dsId]: data.properties }));
        })
        .catch((e) =>
          showToast(e instanceof Error ? e.message : "Could not load the target database's properties", "error")
        )
        .finally(() => {
          targetPropertiesFetching.current.delete(dsId);
        });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databases, actions]);

  function priorVariableNames(index: number): string[] {
    return actions
      .slice(0, index)
      .filter((a): a is DefineVariablesAction => a.type === "define_variables")
      .map((a) => a.name)
      .filter(Boolean);
  }

  // ── Trigger sub-forms ────────────────────────────────────────────────
  function renderTriggerForm(trigger: AutomationTrigger, index: number) {
    if (trigger.type === "page_added") {
      return <p className="text-xs text-gray-400 dark:text-gray-500">Fires whenever a new page is added.</p>;
    }
    if (trigger.type === "property_edited") {
      const t = trigger as PropertyEditedTrigger;
      const selectedProp = knownProperties.find((p) => p.key === t.property_key);
      return (
        <div className="flex flex-col gap-1.5">
          <select
            aria-label="Property to watch"
            value={t.property_key}
            onChange={(e) => patchTrigger(index, { property_key: e.target.value, value: undefined }, true)}
            className={fieldClass}
          >
            {knownProperties.length === 0 && <option value="">No properties available</option>}
            {knownProperties.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Condition"
            value={t.condition}
            onChange={(e) => {
              const condition = e.target.value as PropertyEditedTrigger["condition"];
              patchTrigger(
                index,
                { condition, value: condition === "set_to" ? defaultValueForProperty(selectedProp) : undefined },
                true
              );
            }}
            className={fieldClass}
          >
            {PROPERTY_EDITED_CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {PROPERTY_EDITED_CONDITION_LABELS[c]}
              </option>
            ))}
          </select>
          {t.condition === "set_to" &&
            selectedProp &&
            renderCellValue(selectedProp, t.value, true, (v) => {
              if (v) patchTrigger(index, { value: v }, true);
            })}
        </div>
      );
    }
    // every_frequency
    const t = trigger as EveryFrequencyTrigger;
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span>Every</span>
          <input
            type="number"
            min={1}
            aria-label="Repeat interval"
            value={t.interval}
            onChange={(e) => patchTrigger(index, { interval: Math.max(1, Number(e.target.value) || 1) }, false)}
            className="w-14 text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
          />
          <select
            aria-label="Repeat frequency"
            value={t.frequency}
            onChange={(e) => patchTrigger(index, { frequency: e.target.value as RepeatFrequency }, true)}
            className={fieldClass}
          >
            {REPEAT_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQUENCY_UNIT[f]}
                {t.interval > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </div>
        {t.frequency === "weekly" && (
          <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Repeat on weekdays">
            {WEEKDAYS.map((d) => {
              const weekdays = t.weekdays ?? [];
              const checked = weekdays.includes(d.value);
              return (
                <label key={d.value} className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      patchTrigger(
                        index,
                        { weekdays: checked ? weekdays.filter((w) => w !== d.value) : [...weekdays, d.value].sort() },
                        true
                      )
                    }
                  />
                  {d.label}
                </label>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <label className="flex items-center gap-1.5">
            Start
            <input
              type="date"
              aria-label="Repeat start date"
              value={t.start_date}
              onChange={(e) => patchTrigger(index, { start_date: e.target.value }, false)}
              className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            />
          </label>
          <label className="flex items-center gap-1.5">
            Time
            <input
              type="time"
              aria-label="Repeat time of day"
              value={t.time_of_day}
              onChange={(e) => patchTrigger(index, { time_of_day: e.target.value }, false)}
              className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            />
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={t.end_date != null}
              onChange={(e) => patchTrigger(index, { end_date: e.target.checked ? t.start_date : null }, true)}
            />
            Ends on
          </label>
          {t.end_date != null && (
            <input
              type="date"
              aria-label="Repeat end date"
              value={t.end_date}
              onChange={(e) => patchTrigger(index, { end_date: e.target.value }, false)}
              className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            />
          )}
        </div>
      </div>
    );
  }

  // ── Action sub-forms ─────────────────────────────────────────────────
  function renderActionForm(action: AutomationAction, index: number) {
    switch (action.type) {
      case "edit_property": {
        const selectedProp = knownProperties.find((p) => p.key === action.property_key);
        return (
          <div className="flex flex-col gap-1.5">
            <select
              aria-label="Property to edit"
              value={action.property_key}
              onChange={(e) =>
                patchAction(
                  index,
                  { property_key: e.target.value, value: defaultValueForProperty(knownProperties.find((p) => p.key === e.target.value)) },
                  true
                )
              }
              className={fieldClass}
            >
              {knownProperties.length === 0 && <option value="">No properties available</option>}
              {knownProperties.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
            <PropertyValueOrFormulaField
              dataSourceId={dataSourceId}
              property={selectedProp}
              value={action.value}
              onCommit={(v) => patchAction(index, { value: v }, true)}
            />
          </div>
        );
      }
      case "add_page_to": {
        const targetProps = (targetPropertiesById[action.data_source_id] ?? []).filter((p) => isKnownPropertyType(p.type));
        return (
          <div className="flex flex-col gap-1.5">
            <select
              aria-label="Target database"
              value={action.data_source_id}
              onChange={(e) => patchAction(index, { data_source_id: e.target.value, properties: {} }, true)}
              className={fieldClass}
            >
              <option value="">{databases ? "Choose a database…" : "Loading databases…"}</option>
              {databases?.map((d) => (
                <option key={d.data_source.id} value={d.data_source.id}>
                  {d.database.title || "Untitled"}
                </option>
              ))}
            </select>
            {action.data_source_id &&
              targetProps.map((p) => (
                <div key={p.key} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500 dark:text-gray-400 truncate">{p.name}</span>
                  <div className="flex-1 min-w-0">
                    <PropertyValueOrFormulaField
                      dataSourceId={dataSourceId}
                      property={p}
                      value={action.properties[p.key]}
                      onCommit={(v) => patchAction(index, { properties: { ...action.properties, [p.key]: v } }, true)}
                    />
                  </div>
                </div>
              ))}
          </div>
        );
      }
      case "edit_pages_in": {
        const targetProps = (targetPropertiesById[action.data_source_id] ?? []).filter((p) => isKnownPropertyType(p.type));
        const selectedProp = targetProps.find((p) => p.key === action.property_key);
        const isVariableTarget = typeof action.target === "object";
        const variableNames = priorVariableNames(index);
        return (
          <div className="flex flex-col gap-1.5">
            <select
              aria-label="Rows to edit"
              value={isVariableTarget ? `var:${(action.target as { variable_ref: string }).variable_ref}` : "trigger_row"}
              onChange={(e) => {
                const val = e.target.value;
                patchAction(index, { target: val === "trigger_row" ? "trigger_row" : { variable_ref: val.slice(4) } }, true);
              }}
              className={fieldClass}
            >
              <option value="trigger_row">This page</option>
              {variableNames.map((name) => (
                <option key={name} value={`var:${name}`}>
                  Variable: {name}
                </option>
              ))}
            </select>
            <select
              aria-label="Target database"
              value={action.data_source_id}
              onChange={(e) => patchAction(index, { data_source_id: e.target.value, property_key: "" }, true)}
              className={fieldClass}
            >
              <option value="">{databases ? "Choose a database…" : "Loading databases…"}</option>
              {databases?.map((d) => (
                <option key={d.data_source.id} value={d.data_source.id}>
                  {d.database.title || "Untitled"}
                </option>
              ))}
            </select>
            <select
              aria-label="Property to set"
              value={action.property_key}
              onChange={(e) =>
                patchAction(index, { property_key: e.target.value, value: defaultValueForProperty(targetProps.find((p) => p.key === e.target.value)) }, true)
              }
              className={fieldClass}
            >
              <option value="">{targetProps.length ? "Choose a property…" : "Choose a database first"}</option>
              {targetProps.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
            <PropertyValueOrFormulaField
              dataSourceId={dataSourceId}
              property={selectedProp}
              value={action.value}
              onCommit={(v) => patchAction(index, { value: v }, true)}
            />
          </div>
        );
      }
      case "send_notification":
        return (
          <TextOrFormulaField
            dataSourceId={dataSourceId}
            value={action.message}
            onCommit={(v) => patchAction(index, { message: v }, false)}
            ariaLabel="Notification message"
            placeholder="Message"
          />
        );
      case "send_webhook":
        return (
          <div className="flex flex-col gap-1.5">
            <input
              aria-label="Webhook URL"
              value={action.url}
              placeholder="https://…"
              onChange={(e) => patchAction(index, { url: e.target.value }, false)}
              className={fieldClass}
            />
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              The URL is always a literal value — it can&apos;t reference a formula.
            </p>
          </div>
        );
      case "define_variables": {
        const formulaValue = isFormulaRef(action.formula) ? action.formula.formula : "";
        return (
          <div className="flex flex-col gap-1.5">
            <input
              aria-label="Variable name"
              value={action.name}
              placeholder="Variable name"
              onChange={(e) => patchAction(index, { name: e.target.value }, false)}
              className={fieldClass}
            />
            <FormulaEditor
              dataSourceId={dataSourceId}
              expression={formulaValue}
              onExpressionChange={(next) => patchAction(index, { formula: { formula: next } }, false)}
            />
          </div>
        );
      }
    }
  }

  return (
    <div className="p-4 space-y-6 text-sm">
      {/* Header */}
      <section className="space-y-2">
        <input
          aria-label="Automation name"
          value={name}
          onChange={handleNameChange}
          onBlur={handleNameBlur}
          placeholder="Untitled automation"
          className="w-full text-sm px-2 py-1.5 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
        />
        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input type="checkbox" checked={isActive} onChange={(e) => handleActiveChange(e.target.checked)} />
          Active
        </label>
        {automation.last_error && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 px-3 py-2 text-xs text-red-700 dark:text-red-300"
          >
            Last run failed: {automation.last_error}
          </div>
        )}
      </section>

      {/* Trigger(s) */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Trigger(s)</h3>
        {triggers.filter((t) => t.type !== "every_frequency").length >= 2 && (
          <div role="radiogroup" aria-label="Trigger combinator" className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="trigger-combinator"
                checked={triggerCombinator === "any"}
                onChange={() => persistCombinator("any")}
              />
              Any of these
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="trigger-combinator"
                checked={triggerCombinator === "all"}
                onChange={() => persistCombinator("all")}
              />
              All of these
            </label>
          </div>
        )}
        {hasScheduleTrigger && (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            This automation runs on a schedule — a scheduled trigger can&apos;t be combined with any other trigger.
          </p>
        )}
        <div className="space-y-3">
          {triggers.map((trigger, index) => (
            <div key={index} className="rounded-lg border border-gray-100 dark:border-gray-700 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Trigger ${index + 1} kind`}
                  value={trigger.type}
                  onChange={(e) => handleTriggerTypeChange(index, e.target.value as AutomationTriggerType)}
                  className={fieldClass}
                >
                  {AUTOMATION_TRIGGER_TYPES.map((kind) => (
                    <option key={kind} value={kind}>
                      {TRIGGER_TYPE_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => handleRemoveTrigger(index)}
                  className="ml-auto text-xs text-red-500 hover:text-red-700 px-1.5 py-0.5"
                  aria-label={`Remove trigger ${index + 1}`}
                >
                  Remove
                </button>
              </div>
              {renderTriggerForm(trigger, index)}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={handleAddTrigger}
          disabled={hasScheduleTrigger}
          title={hasScheduleTrigger ? "A scheduled trigger can't be combined with other triggers" : undefined}
          className="text-xs px-2.5 py-1 rounded bg-indigo-600 text-white disabled:opacity-40"
        >
          {triggers.length === 0 ? "+ Add trigger" : "+ Add another trigger"}
        </button>
      </section>

      {/* Action chain */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Action chain</h3>
        <div className="space-y-3">
          {actions.map((action, index) => (
            <div key={index} className="rounded-lg border border-gray-100 dark:border-gray-700 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Action ${index + 1} type`}
                  value={action.type}
                  onChange={(e) => handleActionTypeChange(index, e.target.value as AutomationActionType)}
                  className={fieldClass}
                >
                  {AUTOMATION_ACTION_TYPES.map((kind) => (
                    <option key={kind} value={kind}>
                      {ACTION_TYPE_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleMoveAction(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move action ${index + 1} up`}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 px-1"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => handleMoveAction(index, 1)}
                    disabled={index === actions.length - 1}
                    aria-label={`Move action ${index + 1} down`}
                    className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 px-1"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveAction(index)}
                    aria-label={`Remove action ${index + 1}`}
                    className="text-xs text-red-500 hover:text-red-700 px-1.5 py-0.5"
                  >
                    Delete
                  </button>
                </div>
              </div>
              {renderActionForm(action, index)}
            </div>
          ))}
        </div>
        <button type="button" onClick={handleAddAction} className="text-xs px-2.5 py-1 rounded bg-indigo-600 text-white">
          + Add action
        </button>
      </section>
    </div>
  );
}
