"use client";

// Milestone 12 (task-42) decisions 2/3: the action-chain editor shared by the
// button PROPERTY's config popover (ButtonPropertyConfigPopover.tsx) and the
// button BLOCK's own edit panel (ButtonBlock.tsx) — same visual/UX shape
// AutomationEditor.tsx's own "Action chain" section already established
// (task-41), parameterized by `allowed` (BUTTON_ACTION_TYPES, 8, for the
// property surface; BUTTON_BLOCK_ACTION_TYPES, 9 — +insert_blocks — for the
// block surface). Reuses AutomationEditor's own exported
// PropertyValueOrFormulaField/TextOrFormulaField (task-42-brief.md's "what
// genuinely IS reusable") for the 6 shared action kinds' value fields;
// everything else (the type dropdown, add/remove/reorder chrome, and the 3
// button-only kinds' own mini-forms) is this task's own code — NOT shared
// with AutomationEditor's `renderActionForm`, which is closure-coupled to
// that component's own local state and not worth refactoring for this task
// (task-42-brief.md's own explicit stance, mirroring Task 41's identical
// call on Task 40 one level down).
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/app/providers";
import { isKnownPropertyType } from "@/lib/database/types";
import type {
  ButtonBlockAction,
  ButtonBlockActionType,
  DatabaseDetailResponse,
  DatabaseListResponse,
  DatabaseSummary,
  DefineVariablesAction,
  FormulaValueWrapper,
  InsertBlocksPlacement,
  PropertyResponse,
  PropertyValue,
  ValueOrFormula,
} from "@/lib/database/types";
import { INSERT_BLOCKS_PLACEMENTS } from "@/lib/database/types";
import { PropertyValueOrFormulaField, TextOrFormulaField } from "./AutomationEditor";
import { FormulaEditor } from "./FormulaEditor";

interface ButtonActionChainEditorProps {
  actions: ButtonBlockAction[];
  /** `BUTTON_ACTION_TYPES` (8) for a button property, `BUTTON_BLOCK_ACTION_TYPES`
   * (9, +insert_blocks) for a button block — task-42-brief.md decisions 2/3. */
  allowed: readonly ButtonBlockActionType[];
  /** The host data source's own properties — `edit_property`'s picker
   * target (research §J.6.6: always the trigger row/block's own host, never
   * cross-data-source). `[]` when there's no known host data source (a
   * button block on a plain, non-database note) — degrades to "No
   * properties available", the same empty state AutomationEditor's own
   * `edit_property` picker already has. */
  properties: PropertyResponse[];
  /** `""` in the same "no known host" case above — `FormulaEditor`/
   * `PropertyValueOrFormulaField` degrade gracefully (empty validation)
   * rather than crash on an empty data source id. */
  dataSourceId: string;
  onChange: (next: ButtonBlockAction[]) => void;
}

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

/** `services/db/automations.py`'s own `_is_formula_ref`: a dict with ONLY a
 * `formula` string key. Reimplemented here rather than imported from
 * AutomationEditor.tsx — that helper is module-private there and this
 * task's own reuse boundary (task-42-brief.md's opening section) is
 * `PropertyValueOrFormulaField`/`TextOrFormulaField` only. */
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

const ACTION_TYPE_LABELS: Record<ButtonBlockActionType, string> = {
  edit_property: "Edit property",
  add_page_to: "Add a page to…",
  edit_pages_in: "Edit pages in…",
  send_notification: "Send a notification",
  send_webhook: "Send a webhook",
  define_variables: "Define a variable",
  show_confirmation: "Show a confirmation",
  open_page_or_url: "Open a page or URL",
  insert_blocks: "Insert blocks",
};

const PLACEMENT_LABELS: Record<InsertBlocksPlacement, string> = {
  above_button: "Above this button",
  below_button: "Below this button",
  top_of_page: "Top of the page",
  bottom_of_page: "Bottom of the page",
};

const fieldClass =
  "text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100";

function defaultActionForType(type: ButtonBlockActionType, knownProperties: PropertyResponse[]): ButtonBlockAction {
  switch (type) {
    case "edit_property": {
      const firstProp = knownProperties[0];
      return { type: "edit_property", property_key: firstProp?.key ?? "", value: defaultValueForProperty(firstProp) };
    }
    case "add_page_to":
      return { type: "add_page_to", data_source_id: "", properties: {} };
    case "edit_pages_in":
      return {
        type: "edit_pages_in",
        target: "trigger_row",
        data_source_id: "",
        property_key: "",
        value: { type: "rich_text", rich_text: "" },
      };
    case "send_notification":
      return { type: "send_notification", message: "" };
    case "send_webhook":
      return { type: "send_webhook", url: "" };
    case "define_variables":
      return { type: "define_variables", name: "", formula: { formula: "" } };
    case "show_confirmation":
      return { type: "show_confirmation", message: "" };
    case "open_page_or_url":
      return { type: "open_page_or_url", target: { kind: "url", url: "" } };
    case "insert_blocks":
      return { type: "insert_blocks", blocks: [], placement: "below_button" };
  }
}

/** Local draft state for `insert_blocks.blocks`' raw-JSON textarea — kept
 * separate from the committed `blocks` array so an in-progress (invalid)
 * edit doesn't get clobbered by a `JSON.stringify(blocks)` re-render on
 * every keystroke (only valid, array-shaped JSON ever calls `onCommit`). */
function InsertBlocksJsonField({ blocks, onCommit }: { blocks: unknown[]; onCommit: (blocks: unknown[]) => void }) {
  const [draft, setDraft] = useState(() => JSON.stringify(blocks, null, 2));
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-1">
      <textarea
        aria-label="Blocks JSON"
        value={draft}
        rows={4}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          try {
            const parsed = JSON.parse(next);
            if (Array.isArray(parsed)) {
              setError(null);
              onCommit(parsed);
            } else {
              setError("Must be a JSON array of blocks");
            }
          } catch {
            setError("Invalid JSON");
          }
        }}
        className={`${fieldClass} font-mono w-full`}
      />
      {error ? (
        <p className="text-[11px] text-red-500">{error}</p>
      ) : (
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          Raw BlockNote block array — literal only, opaque to the backend.
        </p>
      )}
    </div>
  );
}

export function ButtonActionChainEditor({ actions, allowed, properties, dataSourceId, onChange }: ButtonActionChainEditorProps) {
  const { showToast } = useToast();
  const knownProperties = properties.filter((p) => isKnownPropertyType(p.type));

  // Cross-data-source property lookups for add_page_to/edit_pages_in — same
  // pattern AutomationEditor.tsx's own identically-purposed effects use
  // (task-41 precedent), duplicated here rather than shared, per this
  // task's own "own the code" convention (decisions 2/3's own text).
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

  function patch(index: number, fields: Record<string, unknown>) {
    onChange(actions.map((a, i) => (i === index ? ({ ...a, ...fields } as ButtonBlockAction) : a)));
  }

  function handleAdd() {
    onChange([...actions, defaultActionForType(allowed[0], knownProperties)]);
  }
  function handleRemove(index: number) {
    onChange(actions.filter((_, i) => i !== index));
  }
  function handleMove(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= actions.length) return;
    const next = [...actions];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }
  function handleTypeChange(index: number, type: ButtonBlockActionType) {
    onChange(actions.map((a, i) => (i === index ? defaultActionForType(type, knownProperties) : a)));
  }

  function renderActionForm(action: ButtonBlockAction, index: number) {
    switch (action.type) {
      case "edit_property": {
        const selectedProp = knownProperties.find((p) => p.key === action.property_key);
        return (
          <div className="flex flex-col gap-1.5">
            <select
              aria-label="Property to edit"
              value={action.property_key}
              onChange={(e) =>
                patch(index, {
                  property_key: e.target.value,
                  value: defaultValueForProperty(knownProperties.find((p) => p.key === e.target.value)),
                })
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
              onCommit={(v: ValueOrFormula) => patch(index, { value: v })}
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
              onChange={(e) => patch(index, { data_source_id: e.target.value, properties: {} })}
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
                      onCommit={(v: ValueOrFormula) => patch(index, { properties: { ...action.properties, [p.key]: v } })}
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
                patch(index, { target: val === "trigger_row" ? "trigger_row" : { variable_ref: val.slice(4) } });
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
              onChange={(e) => patch(index, { data_source_id: e.target.value, property_key: "" })}
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
                patch(index, {
                  property_key: e.target.value,
                  value: defaultValueForProperty(targetProps.find((p) => p.key === e.target.value)),
                })
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
              onCommit={(v: ValueOrFormula) => patch(index, { value: v })}
            />
          </div>
        );
      }
      case "send_notification":
        return (
          <TextOrFormulaField
            dataSourceId={dataSourceId}
            value={action.message}
            onCommit={(v) => patch(index, { message: v })}
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
              onChange={(e) => patch(index, { url: e.target.value })}
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
              onChange={(e) => patch(index, { name: e.target.value })}
              className={fieldClass}
            />
            <FormulaEditor
              dataSourceId={dataSourceId}
              expression={formulaValue}
              onExpressionChange={(next) => patch(index, { formula: { formula: next } })}
            />
          </div>
        );
      }
      case "show_confirmation":
        return (
          <input
            aria-label="Confirmation message"
            value={action.message ?? ""}
            placeholder="Are you sure you want to continue?"
            onChange={(e) => patch(index, { message: e.target.value })}
            className={fieldClass}
          />
        );
      case "open_page_or_url": {
        const kind = action.target.kind;
        return (
          <div className="flex flex-col gap-1.5">
            <select
              aria-label="Open kind"
              value={kind}
              onChange={(e) => {
                const nextKind = e.target.value as "url" | "note";
                patch(index, {
                  target: nextKind === "url" ? { kind: "url", url: "" } : { kind: "note", note_id: "" },
                });
              }}
              className={fieldClass}
            >
              <option value="url">A URL</option>
              <option value="note">A note</option>
            </select>
            {kind === "url" ? (
              <input
                aria-label="URL"
                value={action.target.url}
                placeholder="https://…"
                onChange={(e) => patch(index, { target: { kind: "url", url: e.target.value } })}
                className={fieldClass}
              />
            ) : (
              <input
                aria-label="Note id"
                value={action.target.note_id}
                placeholder="Note id"
                onChange={(e) => patch(index, { target: { kind: "note", note_id: e.target.value } })}
                className={fieldClass}
              />
            )}
            <p className="text-[11px] text-gray-400 dark:text-gray-500">
              Literal only — this field can&apos;t reference a formula.
            </p>
          </div>
        );
      }
      case "insert_blocks":
        return (
          <div className="flex flex-col gap-1.5">
            <select
              aria-label="Where to insert"
              value={action.placement}
              onChange={(e) => patch(index, { placement: e.target.value as InsertBlocksPlacement })}
              className={fieldClass}
            >
              {INSERT_BLOCKS_PLACEMENTS.map((p) => (
                <option key={p} value={p}>
                  {PLACEMENT_LABELS[p]}
                </option>
              ))}
            </select>
            <InsertBlocksJsonField blocks={action.blocks} onCommit={(blocks) => patch(index, { blocks })} />
          </div>
        );
    }
  }

  return (
    <div className="space-y-3">
      {actions.map((action, index) => (
        <div key={index} className="rounded-lg border border-gray-100 dark:border-gray-700 p-2.5 space-y-2">
          <div className="flex items-center gap-2">
            <select
              aria-label={`Action ${index + 1} type`}
              value={action.type}
              onChange={(e) => handleTypeChange(index, e.target.value as ButtonBlockActionType)}
              className={fieldClass}
            >
              {allowed.map((kind) => (
                <option key={kind} value={kind}>
                  {ACTION_TYPE_LABELS[kind]}
                </option>
              ))}
            </select>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={() => handleMove(index, -1)}
                disabled={index === 0}
                aria-label={`Move action ${index + 1} up`}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 px-1"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => handleMove(index, 1)}
                disabled={index === actions.length - 1}
                aria-label={`Move action ${index + 1} down`}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 px-1"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => handleRemove(index)}
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
      <button type="button" onClick={handleAdd} className="text-xs px-2.5 py-1 rounded bg-indigo-600 text-white">
        + Add action
      </button>
    </div>
  );
}
