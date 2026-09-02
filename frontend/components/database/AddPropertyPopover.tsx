"use client";

// M2 — property creation.
//
// Replaces the trailing-column inline form (TableView.tsx, pre-M2): a name
// input, a native <select>, and every type's conditional fields crammed into
// one flex-wrap row. Five of the app's 40 native selects lived here.
//
// Shape from live capture (docs/ui-specs/property-create-edit.md):
//  * THE NAME FIELD IS NOT IN THE POPOVER. Clicking "+" turns the header cell
//    itself into a text input; the popover hangs below it. Notion separates
//    the two, and putting them side by side is what made the old form feel
//    like a form rather than a menu.
//  * The type list is a TWO-COLUMN grid, and stays two columns when filtered —
//    a single match fills one cell rather than collapsing to a list.
//  * Picking a type with configuration (relation, formula, rollup) does not
//    create anything yet; it pushes a config step.
//
// TWO DELIBERATE DEVIATIONS, both documented rather than accidental:
//  1. SEARCH IS ALWAYS VISIBLE. Notion hides the type search behind a
//     magnifier on the "Select type" section header, and that expansion does
//     not survive a reopen — a quirk I captured and would rather not
//     reproduce. An always-visible field is strictly more discoverable.
//  2. CONFIG IS PUSHED INTO THIS POPOVER, not into the 483px docked sidebar
//     Notion uses. That sidebar is M3's surface and does not exist yet;
//     building half of it here to host one panel would be worse than pushing.
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/app/providers";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { MenuPanel } from "@/components/ui/primitives";
import { ROLLUP_FUNCTIONS } from "@/lib/database/types";
import type {
  DatabaseDetailResponse,
  DatabaseListResponse,
  DatabaseSummary,
  PropertyResponse,
} from "@/lib/database/types";
import { FormulaEditor } from "./FormulaEditor";
import { propertyTypeIcon } from "./ColumnHeaderMenu";

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

/** The types this milestone offers. Notion shows 26; adopting the 11 further
 * types our backend already implements is M2b, deliberately split so a picker
 * rewrite and eleven new cell renderers are not reviewed together. */
const ADDABLE: { type: string; label: string }[] = [
  { type: "rich_text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" },
  { type: "status", label: "Status" },
  { type: "date", label: "Date" },
  { type: "checkbox", label: "Checkbox" },
  // M2b — types the backend has always implemented but the picker never
  // offered. Six of the eleven ship here. The other five are held back with
  // reasons rather than shipped broken: `people`, `created_by` and
  // `last_edited_by` would render a raw user id until there is a name lookup;
  // `files` needs an upload pipeline; `place` needs geocoding, which is why
  // Map view was cut in the first place.
  { type: "url", label: "URL" },
  { type: "email", label: "Email" },
  { type: "phone_number", label: "Phone" },
  { type: "unique_id", label: "ID" },
  { type: "created_time", label: "Created time" },
  { type: "last_edited_time", label: "Last edited time" },
  { type: "relation", label: "Relation" },
  { type: "formula", label: "Formula" },
  { type: "rollup", label: "Rollup" },
  { type: "button", label: "Button" },
];

/** Types that cannot be created from the grid alone. */
const NEEDS_CONFIG = new Set(["relation", "formula", "rollup"]);

export interface AddPropertyPopoverProps {
  dataSourceId: string;
  properties: PropertyResponse[];
  onCreated: () => void | Promise<void>;
  /** row-peek.md: "single-column in narrow hosts (peek, sidebar), two-column
   * in wide ones, and ONE shared copy string" — only the grid width varies
   * per host; every label/placeholder below stays the same either way.
   * Defaults to 2, the table header's existing (only, before M10) shape. */
  columns?: 1 | 2;
  /** row-peek.md checklist #13: "+ Add a property" must carry a scope
   * disclaimer, since — unlike editing a value — it writes schema, affecting
   * every view. Omitted (as before) by the table header's own usage. */
  scopeNote?: string;
  /** The row peek's collapsed trigger is a full-width text row ("+ Add a
   * property"), not the table header's bare "+" icon button — same popover,
   * a different anchor shape for a different host. */
  triggerLabel?: string;
}

export function AddPropertyPopover({
  dataSourceId,
  properties,
  onCreated,
  columns = 2,
  scopeNote,
  triggerLabel,
}: AddPropertyPopoverProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  // MenuList closes itself after activating a row, which is right for a
  // simple type but wrong for one that pushes a config step — the close would
  // reset the very state the selection just set. Recorded synchronously so
  // the close handler can see it, since a state update would land too late.
  const pendingConfigRef = useRef(false);

  // Relation and rollup both need the user's other data sources. Fetched
  // lazily on first need, not on every open — an ordinary Text property
  // should not pay for a request it never reads. (Same reasoning, and the
  // same ref-guard against self-cancellation, as the form this replaces.)
  const [databases, setDatabases] = useState<DatabaseSummary[] | null>(null);
  const [targetProperties, setTargetProperties] = useState<PropertyResponse[] | null>(null);
  const databasesFetchStarted = useRef(false);

  const [targetDataSourceId, setTargetDataSourceId] = useState("");
  const [twoWay, setTwoWay] = useState(true);
  const [reverseName, setReverseName] = useState("");
  const [expression, setExpression] = useState("");
  const [rollupRelationKey, setRollupRelationKey] = useState("");
  const [rollupTargetKey, setRollupTargetKey] = useState("");
  const [rollupFunction, setRollupFunction] = useState("");

  const relationProperties = properties.filter((p) => p.type === "relation");

  useEffect(() => {
    if (!configuring || !NEEDS_CONFIG.has(configuring)) return;
    if (configuring === "formula") return;
    if (databasesFetchStarted.current) return;
    databasesFetchStarted.current = true;
    let cancelled = false;
    fetch("/api/db/databases")
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorMessage(res));
        const data: DatabaseListResponse = await res.json();
        if (!cancelled) setDatabases(data.databases);
      })
      .catch((e) => {
        if (!cancelled) showToast(e instanceof Error ? e.message : "Could not load databases", "error");
      });
    return () => {
      cancelled = true;
    };
  }, [configuring, showToast]);

  // A rollup aggregates a property on the relation's TARGET source, so the
  // target's own properties have to be resolved once a relation is chosen.
  useEffect(() => {
    setTargetProperties(null);
    if (configuring !== "rollup" || !rollupRelationKey || !databases) return;
    const relation = properties.find((p) => p.type === "relation" && p.key === rollupRelationKey);
    const targetDsId =
      typeof relation?.config?.target_data_source_id === "string"
        ? (relation.config.target_data_source_id as string)
        : undefined;
    const targetDb = targetDsId ? databases.find((d) => d.data_source.id === targetDsId) : undefined;
    if (!targetDb) return;
    let cancelled = false;
    fetch(`/api/db/databases/${targetDb.database.id}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorMessage(res));
        const data: DatabaseDetailResponse = await res.json();
        if (!cancelled) setTargetProperties(data.properties);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [configuring, rollupRelationKey, databases, properties]);

  function reset() {
    setOpen(false);
    setName("");
    setConfiguring(null);
    setSubmitting(false);
    setTargetDataSourceId("");
    setTwoWay(true);
    setReverseName("");
    setExpression("");
    setRollupRelationKey("");
    setRollupTargetKey("");
    setRollupFunction("");
  }

  async function create(type: string, extra?: Record<string, unknown>) {
    if (submitting) return;
    setSubmitting(true);
    try {
      // A relation must go through POST .../relations: the generic properties
      // endpoint mints no relation_id or side, and every filter on the
      // resulting property would 400.
      const url =
        type === "relation"
          ? `/api/db/data-sources/${dataSourceId}/relations`
          : `/api/db/data-sources/${dataSourceId}/properties`;
      const body =
        type === "relation"
          ? {
              name: name.trim() || "Relation",
              target_data_source_id: targetDataSourceId,
              two_way: twoWay,
              reverse_name: twoWay ? reverseName.trim() : null,
            }
          : { name: name.trim() || defaultName(type), type, ...(extra ?? {}) };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      reset();
      await onCreated();
    } catch (e) {
      setSubmitting(false);
      showToast(e instanceof Error ? e.message : "Could not add the property", "error");
    }
  }

  function defaultName(type: string): string {
    return ADDABLE.find((t) => t.type === type)?.label ?? "Property";
  }

  const typePanel: MenuPanel = {
    columns,
    // The host owns the primary input (the name field in the header cell),
    // so this must not autofocus over it.
    search: { placeholder: "Search for a property type…", autoFocus: false },
    sections: [
      {
        label: "Select type",
        rows: ADDABLE.map((t) => ({
          id: t.type,
          icon: propertyTypeIcon(t.type),
          label: t.label,
          onSelect: () => {
            if (NEEDS_CONFIG.has(t.type)) {
              pendingConfigRef.current = true;
              setConfiguring(t.type);
            } else {
              create(t.type);
            }
          },
        })),
        content: scopeNote ? <div className="pt-2 text-menu-disabled">{scopeNote}</div> : undefined,
      },
    ],
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : reset())}
      width="lg"
      label="New property"
      // The trigger IS the primary input here.
      preventAutoFocus
      trigger={
        open ? (
          <div className="flex items-center gap-1 px-1">
            <span className="flex w-menu-icon items-center justify-center text-menu-disabled">
              ＋
            </span>
            <input
              ref={nameRef}
              autoFocus
              aria-label="Property name"
              placeholder="Type property name…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              // The name field owns its own keys: arrows move the caret and
              // Tab moves on, neither should drive or close the menu below.
              onKeyDown={(e) => {
                if (e.key.startsWith("Arrow") || e.key === "Tab") e.stopPropagation();
              }}
              // The input sits INSIDE the Radix trigger so the popover anchors
              // to the header cell — but it must not toggle it. Without this,
              // clicking into the field to place the caret closes the menu,
              // which is the first thing a user does.
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="h-menu-row min-w-0 flex-1 rounded bg-menu-field px-2 text-menu outline-none"
            />
          </div>
        ) : triggerLabel ? (
          <button
            type="button"
            aria-label={triggerLabel}
            className="flex w-full items-center gap-1.5 px-1 py-1 text-left text-sm text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            {triggerLabel}
          </button>
        ) : (
          <button
            type="button"
            aria-label="Add property"
            className="px-2 py-1 font-medium text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
          >
            +
          </button>
        )
      }
    >
      {configuring === null ? (
        <MenuList
          root={typePanel}
          nav="flyout"
          onClose={() => {
            if (pendingConfigRef.current) {
              pendingConfigRef.current = false;
              return;
            }
            reset();
          }}
          label="Select type"
        />
      ) : (
        <div className="p-2 text-menu text-menu-fg">
          <div className="mb-2 flex items-center gap-1">
            <button
              type="button"
              aria-label="Back"
              onClick={() => setConfiguring(null)}
              className="flex h-5 w-5 items-center justify-center rounded hover:bg-menu-hover"
            >
              ←
            </button>
            <span className="font-medium">{defaultName(configuring)}</span>
          </div>

          {configuring === "relation" && (
            <RelationConfig
              databases={databases}
              dataSourceId={dataSourceId}
              targetDataSourceId={targetDataSourceId}
              setTargetDataSourceId={setTargetDataSourceId}
              twoWay={twoWay}
              setTwoWay={setTwoWay}
              reverseName={reverseName}
              setReverseName={setReverseName}
            />
          )}

          {configuring === "formula" && (
            <FormulaEditor
              dataSourceId={dataSourceId}
              expression={expression}
              onExpressionChange={setExpression}
            />
          )}

          {configuring === "rollup" && (
            <RollupConfig
              relationProperties={relationProperties}
              targetProperties={targetProperties}
              rollupRelationKey={rollupRelationKey}
              setRollupRelationKey={(k) => {
                setRollupRelationKey(k);
                setRollupTargetKey("");
              }}
              rollupTargetKey={rollupTargetKey}
              setRollupTargetKey={setRollupTargetKey}
              rollupFunction={rollupFunction}
              setRollupFunction={setRollupFunction}
            />
          )}

          <button
            type="button"
            disabled={submitting || !canSubmit(configuring)}
            onClick={() => submitConfigured(configuring)}
            className="mt-2 w-full rounded bg-brand px-2 py-1 text-white disabled:opacity-40"
          >
            Add property
          </button>
        </div>
      )}
    </Popover>
  );

  function canSubmit(type: string): boolean {
    if (type === "relation") return Boolean(targetDataSourceId) && (!twoWay || Boolean(reverseName.trim()));
    // Deliberately NOT gated on the formula being valid: research §1.9 —
    // "a formula with errors can still be saved". Only an empty expression is
    // refused, which is the one thing the backend hard-rejects too.
    if (type === "formula") return Boolean(expression.trim());
    return Boolean(rollupRelationKey && rollupTargetKey && rollupFunction);
  }

  function submitConfigured(type: string) {
    if (type === "relation") return create("relation");
    if (type === "formula") return create("formula", { config: { expression } });
    const relation = properties.find((p) => p.type === "relation" && p.key === rollupRelationKey);
    const targetDsId =
      typeof relation?.config?.target_data_source_id === "string"
        ? (relation.config.target_data_source_id as string)
        : undefined;
    if (!targetDsId) {
      showToast("The chosen relation has no configured target database", "error");
      return;
    }
    return create("rollup", {
      config: {
        relation_key: rollupRelationKey,
        target_data_source_id: targetDsId,
        target_key: rollupTargetKey,
        function: rollupFunction,
      },
    });
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block">
      <span className="mb-0.5 block text-menu-disabled">{label}</span>
      {children}
    </label>
  );
}

const SELECT_CLASS =
  "h-menu-row w-full rounded bg-menu-field px-2 text-menu outline-none";

function RelationConfig(props: {
  databases: DatabaseSummary[] | null;
  dataSourceId: string;
  targetDataSourceId: string;
  setTargetDataSourceId: (v: string) => void;
  twoWay: boolean;
  setTwoWay: (v: boolean) => void;
  reverseName: string;
  setReverseName: (v: string) => void;
}) {
  return (
    <>
      <Field label="Related to">
        <select
          aria-label="Target database"
          value={props.targetDataSourceId}
          onChange={(e) => props.setTargetDataSourceId(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">{props.databases === null ? "Loading…" : "Choose a database…"}</option>
          {props.databases?.map((d) => (
            <option key={d.data_source.id} value={d.data_source.id}>
              {d.database.title || "Untitled"}
              {d.data_source.id === props.dataSourceId ? " (this database)" : ""}
            </option>
          ))}
        </select>
      </Field>
      <label className="mb-2 flex items-center gap-1.5">
        <input
          type="checkbox"
          aria-label="Two-way relation"
          checked={props.twoWay}
          onChange={(e) => props.setTwoWay(e.target.checked)}
        />
        Show on both databases
      </label>
      {props.twoWay && (
        <Field label="Name on the other side">
          <input
            aria-label="Reverse property name"
            value={props.reverseName}
            onChange={(e) => props.setReverseName(e.target.value)}
            className={SELECT_CLASS}
          />
        </Field>
      )}
    </>
  );
}

function RollupConfig(props: {
  relationProperties: PropertyResponse[];
  targetProperties: PropertyResponse[] | null;
  rollupRelationKey: string;
  setRollupRelationKey: (v: string) => void;
  rollupTargetKey: string;
  setRollupTargetKey: (v: string) => void;
  rollupFunction: string;
  setRollupFunction: (v: string) => void;
}) {
  if (props.relationProperties.length === 0) {
    return (
      <p className="text-amber-600 dark:text-amber-400">
        Add a relation property first — a rollup needs one to roll up through.
      </p>
    );
  }
  return (
    <>
      <Field label="Relation">
        <select
          aria-label="Rollup relation"
          value={props.rollupRelationKey}
          onChange={(e) => props.setRollupRelationKey(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">Choose a relation…</option>
          {props.relationProperties.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Property">
        <select
          aria-label="Rollup target property"
          value={props.rollupTargetKey}
          onChange={(e) => props.setRollupTargetKey(e.target.value)}
          disabled={!props.rollupRelationKey}
          className={`${SELECT_CLASS} disabled:opacity-40`}
        >
          <option value="">
            {props.targetProperties === null ? "Loading…" : "Choose a property…"}
          </option>
          {props.targetProperties?.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Calculate">
        <select
          aria-label="Rollup function"
          value={props.rollupFunction}
          onChange={(e) => props.setRollupFunction(e.target.value)}
          className={SELECT_CLASS}
        >
          <option value="">Choose a function…</option>
          {ROLLUP_FUNCTIONS.map((fn) => (
            <option key={fn} value={fn}>
              {fn}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
