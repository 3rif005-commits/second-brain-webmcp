"use client";

// M4 — the filter panel (filter-panel.md). Two entry points (toolbar button,
// settings sidebar row) share this exact panel-as-data, same pattern M3's
// Sort/Group already established — `filterPanel()` returns the property
// picker (stage 1, nothing filtered yet) or the advanced builder (stage 2),
// mirroring `sortPanel()`'s own two-stage dispatch in ViewSettingsSidebar.tsx.
//
// Stage 2 is NOT `MenuRow[]` data, unlike most of this codebase's panels —
// a rule row needs three independent live dropdowns plus a debounced value
// input, the same reason `SortRowsList.tsx` rendered its own rows as a
// `MenuSection.content` React tree instead of `MenuRow[]`.
import { forwardRef, useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { PropertyResponse } from "@/lib/database/types";
import {
  appendChild,
  asFilterNode,
  countConditions,
  defaultConditionFor,
  isFilterableProperty,
  isFilterCondition,
  isFilterGroup,
  removeAtPath,
  updateAtPath,
  type FilterCondition,
  type FilterNode,
} from "@/lib/database/filterAst";
import {
  configuredOptions,
  defaultValueForOperator,
  operatorFor,
  operatorsForType,
  type FilterOperator,
} from "@/lib/database/filterOperators";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { MenuPanel, MenuRow } from "@/components/ui/primitives";
import { propertyTypeIcon } from "./ColumnHeaderMenu";

/** `FilterNode | null`, whole-tree REPLACE — same "not mergeable, compute
 * inside the updater against whatever's latest" contract `SortsUpdater`
 * documents, and for the identical reason: the toolbar's Filter popover, the
 * settings sidebar's Filter row, and a column header's "Filter" row can all
 * be reached in the same session. */
export type FilterUpdater = (current: FilterNode | null) => FilterNode | null;

// ── Stage 1: property picker ────────────────────────────────────────────

function filterPropertyPicker(
  properties: PropertyResponse[],
  onPick: (property: PropertyResponse) => void,
  onAdvanced: () => void
): MenuPanel {
  const alphabetical = [...properties].sort((a, b) => a.name.localeCompare(b.name));
  const rows: MenuRow[] = alphabetical
    .filter((p) => isFilterableProperty(p))
    .map((p) => ({
      id: p.key,
      icon: propertyTypeIcon(p.type),
      label: p.name,
      onSelect: () => onPick(p),
    }));
  return {
    title: "Filter",
    search: { placeholder: "Filter by…" },
    sections: [
      { rows },
      { rows: [{ id: "advanced", label: "+ Add advanced filter", onSelect: onAdvanced }] },
    ],
  };
}

// ── Stage 2: the advanced builder ───────────────────────────────────────

function ValueEditor({
  operator,
  property,
  value,
  onChange,
}: {
  operator: FilterOperator;
  property: PropertyResponse | undefined;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  // Debounced text/number commits: filter-panel.md's checklist explicitly
  // asserts one PATCH for the whole typed string, not one per keystroke.
  const [draft, setDraft] = useState(() => (value == null ? "" : String(value)));
  useEffect(() => {
    setDraft(value == null ? "" : String(value));
    // Only resync from upstream `value` — not on every `onChange` identity
    // change, or a debounced local edit would get overwritten mid-typing by
    // its own not-yet-committed value once the timer fires and re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  if (operator.argType === "none") return null;

  if (operator.argType === "str") {
    return (
      <DebouncedTextInput
        ariaLabel="Filter value"
        value={draft}
        onChange={setDraft}
        onCommit={(v) => onChange(v)}
        placeholder="Value"
      />
    );
  }

  if (operator.argType === "num") {
    return (
      <DebouncedTextInput
        ariaLabel="Filter value"
        type="number"
        value={draft}
        onChange={setDraft}
        onCommit={(v) => onChange(v === "" ? null : Number(v))}
        placeholder="0"
      />
    );
  }

  if (operator.argType === "bool") {
    const current = value === true;
    return (
      <select
        aria-label="Filter value"
        value={current ? "true" : "false"}
        onChange={(e) => onChange(e.target.value === "true")}
        className="h-menu-row rounded bg-menu-field px-1.5 text-menu outline-none"
      >
        <option value="true">Checked</option>
        <option value="false">Unchecked</option>
      </select>
    );
  }

  if (operator.argType === "date") {
    return (
      <input
        aria-label="Filter value"
        type="date"
        value={typeof value === "string" ? value.slice(0, 10) : ""}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        className="h-menu-row rounded bg-menu-field px-1.5 text-menu outline-none"
      />
    );
  }

  if (operator.argType === "verification_status") {
    return (
      <select
        aria-label="Filter value"
        value={typeof value === "string" ? value : "none"}
        onChange={(e) => onChange(e.target.value)}
        className="h-menu-row rounded bg-menu-field px-1.5 text-menu outline-none"
      >
        <option value="verified">Verified</option>
        <option value="expired">Expired</option>
        <option value="none">None</option>
      </select>
    );
  }

  if (operator.argType === "str_or_list") {
    // Select/Status/Multi-select's "searchable multi-select checkbox list of
    // the property's options, rendered as chips" (filter-panel.md) — but
    // these three properties are FREE TEXT in this app today (SelectCell's
    // own doc comment), not confined to `property.config`'s option list, so
    // this is a chip INPUT (type, Enter/comma to add — MultiSelectCell.tsx's
    // own established convention) with configured options offered as
    // one-click suggestions, not a hard constraint.
    const chips = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : value ? [String(value)] : [];
    const options = property ? configuredOptions(property) : [];
    return (
      <ChipInput
        chips={chips}
        suggestions={options.map((o) => o.name).filter((n) => !chips.includes(n))}
        onChange={(next) => onChange(next.length === 0 ? null : next)}
      />
    );
  }

  // "uuid" / "uuid_or_me" (People/Relation): no dedicated picker exists
  // anywhere in this app yet (no PersonCell; RelationCell's own picker is
  // note-search-driven, not id-entry) — a raw-id text input is the honest,
  // minimal editor until one of those gets built. `uuid_or_me` also accepts
  // the literal string "me".
  return (
    <DebouncedTextInput
      ariaLabel="Filter value"
      value={draft}
      onChange={setDraft}
      onCommit={(v) => onChange(v === "" ? null : v)}
      placeholder={operator.argType === "uuid_or_me" ? "User id, or “me”" : "User id"}
    />
  );
}

function DebouncedTextInput({
  ariaLabel,
  value,
  onChange,
  onCommit,
  placeholder,
  type = "text",
}: {
  ariaLabel: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number";
}) {
  // A timer armed by an effect keyed on `value` fires on MOUNT too — every
  // fresh row would silently commit its untouched value 400ms after
  // appearing. The timer must only ever be armed by an actual keystroke
  // (`handleChange`, called from `onChange`), never by a value/prop change
  // reaching this component some other way — caught by this file's own
  // test suite (FilterBuilder.test.tsx) before it shipped: the mount-fired
  // commit was landing as `onSetFilter`'s call[0], ahead of the click the
  // test was actually asserting on.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  function handleChange(next: string) {
    onChange(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onCommit(next), 400);
  }

  function commitNow() {
    if (timerRef.current) clearTimeout(timerRef.current);
    onCommit(value);
  }

  return (
    <input
      aria-label={ariaLabel}
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => handleChange(e.target.value)}
      onBlur={commitNow}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitNow();
        e.stopPropagation();
      }}
      className="h-menu-row min-w-0 flex-1 rounded bg-menu-field px-1.5 text-menu outline-none"
    />
  );
}

function ChipInput({
  chips,
  suggestions,
  onChange,
}: {
  chips: string[];
  suggestions: string[];
  onChange: (chips: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function add(raw: string) {
    const value = raw.trim();
    if (!value || chips.includes(value)) return;
    onChange([...chips, value]);
    setDraft("");
  }
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded bg-menu-field px-1.5 py-0.5">
      {chips.map((chip) => (
        <span
          key={chip}
          className="flex items-center gap-1 rounded-full bg-menu-badge px-1.5 py-0.5 text-[11px]"
        >
          {chip}
          <button
            type="button"
            aria-label={`Remove ${chip}`}
            onClick={() => onChange(chips.filter((c) => c !== chip))}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        aria-label="Filter value"
        value={draft}
        placeholder={chips.length === 0 ? "Value" : undefined}
        onChange={(e) => {
          if (e.target.value.endsWith(",")) add(e.target.value.slice(0, -1));
          else setDraft(e.target.value);
        }}
        onBlur={() => add(draft)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") add(draft);
          if (e.key === "Backspace" && draft === "" && chips.length > 0) onChange(chips.slice(0, -1));
        }}
        className="h-5 min-w-[3rem] flex-1 bg-transparent text-menu outline-none"
      />
      {suggestions.length > 0 && (
        <div className="flex w-full flex-wrap gap-1 pt-0.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-full border border-menu-divider px-1.5 py-0.5 text-[11px] text-menu-disabled hover:text-menu-fg"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConditionRow({
  condition,
  properties,
  onSetFilter,
  path,
}: {
  condition: FilterCondition;
  properties: PropertyResponse[];
  onSetFilter: (updater: FilterUpdater) => void;
  path: number[];
}) {
  const [propertyMenuOpen, setPropertyMenuOpen] = useState(false);
  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);
  const property = properties.find((p) => p.key === condition.property);
  const operators = operatorsForType(property?.type ?? "");
  const operator = operatorFor(property?.type ?? "", condition.operator) ?? operators[0];
  const alphabetical = [...properties].filter(isFilterableProperty).sort((a, b) => a.name.localeCompare(b.name));

  function replaceCondition(next: Partial<FilterCondition>) {
    onSetFilter((latest) => {
      if (!latest) return latest;
      return updateAtPath(latest, path, (node) =>
        isFilterCondition(node) ? { ...node, ...next } : node
      );
    });
  }

  return (
    <div className="flex min-h-menu-row items-center gap-1">
      <Popover
        open={propertyMenuOpen}
        onOpenChange={setPropertyMenuOpen}
        width="sm"
        label="Filter property"
        trigger={
          <TriggerButton>
            <span className="flex items-center gap-1.5">
              {property ? propertyTypeIcon(property.type) : null}
              {property?.name ?? condition.property}
            </span>
          </TriggerButton>
        }
      >
        <MenuList
          nav="flyout"
          label="Filter property"
          onClose={() => setPropertyMenuOpen(false)}
          root={{
            search: { placeholder: "Filter by…" },
            sections: [
              {
                rows: alphabetical.map((p) => ({
                  id: p.key,
                  icon: propertyTypeIcon(p.type),
                  label: p.name,
                  checked: p.key === condition.property,
                  onSelect: () => {
                    const fresh = defaultConditionFor(p);
                    replaceCondition({ property: fresh.property, operator: fresh.operator, value: fresh.value });
                  },
                })),
              },
            ],
          }}
        />
      </Popover>

      <Popover
        open={operatorMenuOpen}
        onOpenChange={setOperatorMenuOpen}
        width="sm"
        label="Filter operator"
        trigger={<TriggerButton>{operator?.label ?? condition.operator}</TriggerButton>}
      >
        <MenuList
          nav="flyout"
          label="Filter operator"
          onClose={() => setOperatorMenuOpen(false)}
          root={{
            sections: [
              {
                rows: operators.map((op) => ({
                  id: op.name,
                  label: op.label,
                  checked: op.name === condition.operator,
                  onSelect: () => replaceCondition({ operator: op.name, value: defaultValueForOperator(op) }),
                })),
              },
            ],
          }}
        />
      </Popover>

      {operator && (
        <ValueEditor
          operator={operator}
          property={property}
          value={condition.value}
          onChange={(value) => replaceCondition({ value: value ?? undefined })}
        />
      )}

      <button
        type="button"
        aria-label={`Remove filter rule on ${property?.name ?? condition.property}`}
        onClick={() => onSetFilter((latest) => (latest ? removeAtPath(latest, path) : latest))}
        className="shrink-0 rounded p-0.5 text-menu-disabled hover:bg-menu-hover hover:text-menu-fg"
      >
        <X size={12} />
      </button>
    </div>
  );
}

// `forwardRef` + spreading `...rest` are both required here — see
// SortRowsList.tsx's `DropdownButton`, which documents exactly this Radix
// `asChild`-cloning trap (a custom trigger component that only destructures
// its own props silently drops the injected onClick/ref, so the popover
// renders but never opens).
const TriggerButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  function TriggerButton({ children, className = "", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={`flex min-w-0 items-center gap-1 truncate rounded bg-menu-field px-1.5 py-0.5 text-left text-menu hover:bg-menu-hover ${className}`}
      >
        <span className="truncate">{children}</span>
        <span aria-hidden className="shrink-0 text-menu-disabled">
          ▾
        </span>
      </button>
    );
  }
);

function AddRuleMenu({ onAddRule, onAddGroup }: { onAddRule: () => void; onAddGroup: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width="sm"
      label="Add filter rule or group"
      trigger={
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-1 text-menu-disabled hover:bg-menu-hover hover:text-menu-fg"
        >
          <Plus size={12} /> Add filter rule <span aria-hidden>▾</span>
        </button>
      }
    >
      <MenuList
        nav="flyout"
        label="Add filter rule or group"
        onClose={() => setOpen(false)}
        root={{
          sections: [
            {
              rows: [
                { id: "rule", label: "Add filter rule", onSelect: onAddRule },
                {
                  id: "group",
                  label: "Add filter group",
                  description: "A group to nest more filters",
                  onSelect: onAddGroup,
                },
              ],
            },
          ],
        }}
      />
    </Popover>
  );
}

/** Renders one node — a bare condition (only possible at the root, before
 * any second rule ever turned it into a group) or a group's children, each
 * with a leading conjunction slot ("Where" for the first rule; an editable
 * AND/OR selector for every rule after the first WITHIN THE SAME GROUP) —
 * recursing into nested groups with indentation. Every group (root or
 * nested) gets its own "+ Add filter rule ▾" footer, scoped to append at
 * `path`; "🗑 Delete filter" is root-only and lives in `FilterBuilderRoot`
 * instead — removing every rule inside a NESTED group is what removes IT
 * (`removeAtPath`'s own pruning), so it needs no delete affordance of its
 * own. */
function GroupEditor({
  node,
  path,
  properties,
  onSetFilter,
  isRoot,
}: {
  node: FilterNode;
  path: number[];
  properties: PropertyResponse[];
  onSetFilter: (updater: FilterUpdater) => void;
  isRoot: boolean;
}) {
  const firstProperty = defaultFilterableProperty(properties);

  // A lone condition at the ROOT (the very first rule ever picked, before
  // any "+ Add filter rule" turned it into a group) has no `children` to
  // append to — adding a second rule here means WRAPPING it into a
  // 2-child group, the one case `appendChild` can't express since it needs
  // an existing group at `path`. Only reachable when `isRoot`: once
  // anything appends a sibling, the tree is a group from then on, and
  // every OTHER `path` this function recurses into always already points
  // at a real group (nested groups are only ever created as groups).
  if (isFilterCondition(node)) {
    return (
      <div className={isRoot ? "" : "ml-4 border-l border-menu-divider pl-2"}>
        <div className="flex items-center gap-1.5 px-2 py-1">
          <span className="w-10 shrink-0 text-menu-disabled">Where</span>
          <ConditionRow condition={node} properties={properties} onSetFilter={onSetFilter} path={path} />
        </div>
        {isRoot && (
          <div className="flex items-center gap-2 px-2 py-1">
            <AddRuleMenu
              onAddRule={() =>
                firstProperty &&
                onSetFilter((latest) =>
                  isFilterCondition(latest)
                    ? { type: "group", op: "and", children: [latest, defaultConditionFor(firstProperty)] }
                    : latest
                )
              }
              onAddGroup={() =>
                onSetFilter((latest) =>
                  isFilterCondition(latest)
                    ? { type: "group", op: "and", children: [latest, { type: "group", op: "and", children: [] }] }
                    : latest
                )
              }
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={isRoot ? "" : "ml-4 border-l border-menu-divider pl-2"}>
      {node.children.map((child, i) => (
        <div key={i} className="flex items-start gap-1.5 px-2 py-0.5">
          <span className="w-10 shrink-0 pt-1 text-menu-disabled">
            {i === 0 ? (
              "Where"
            ) : (
              <ConjunctionSelector
                value={node.op}
                onChange={(op) => onSetFilter((latest) => (latest ? updateAtPath(latest, path, (n) => (isFilterGroup(n) ? { ...n, op } : n)) : latest))}
              />
            )}
          </span>
          <div className="min-w-0 flex-1">
            {isFilterGroup(child) ? (
              <GroupEditor node={child} path={[...path, i]} properties={properties} onSetFilter={onSetFilter} isRoot={false} />
            ) : (
              <ConditionRow condition={child} properties={properties} onSetFilter={onSetFilter} path={[...path, i]} />
            )}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 px-2 py-1">
        <AddRuleMenu
          onAddRule={() =>
            firstProperty &&
            onSetFilter((latest) => (latest ? appendChild(latest, path, defaultConditionFor(firstProperty)) : latest))
          }
          onAddGroup={() =>
            onSetFilter((latest) =>
              latest ? appendChild(latest, path, { type: "group", op: "and", children: [] }) : latest
            )
          }
        />
      </div>
    </div>
  );
}

function ConjunctionSelector({ value, onChange }: { value: "and" | "or"; onChange: (op: "and" | "or") => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      width="sm"
      label="And/or"
      trigger={<TriggerButton>{value === "and" ? "And" : "Or"}</TriggerButton>}
    >
      <MenuList
        nav="flyout"
        label="And/or"
        onClose={() => setOpen(false)}
        root={{
          sections: [
            {
              rows: [
                { id: "and", label: "And", checked: value === "and", onSelect: () => onChange("and") },
                { id: "or", label: "Or", checked: value === "or", onSelect: () => onChange("or") },
              ],
            },
          ],
        }}
      />
    </Popover>
  );
}

function defaultFilterableProperty(properties: PropertyResponse[]): PropertyResponse | undefined {
  return [...properties].filter(isFilterableProperty).sort((a, b) => a.name.localeCompare(b.name))[0];
}

function FilterBuilderRoot({
  filter,
  properties,
  onSetFilter,
}: {
  filter: FilterNode;
  properties: PropertyResponse[];
  onSetFilter: (updater: FilterUpdater) => void;
}) {
  return (
    <div className="flex flex-col gap-1 pb-1">
      <GroupEditor node={filter} path={[]} properties={properties} onSetFilter={onSetFilter} isRoot />
      <div role="separator" className="my-1 h-px bg-menu-divider" />
      <button
        type="button"
        onClick={() => onSetFilter(() => null)}
        className="flex items-center gap-1.5 px-2 py-1 text-left text-red-500 hover:bg-menu-hover"
      >
        <Trash2 size={13} /> Delete filter
      </button>
    </div>
  );
}

/** The panel `ViewToolbar` and `ViewSettingsSidebar` both host — property
 * picker (stage 1) when `filter` is empty, the advanced builder (stage 2)
 * once it isn't. Mirrors `sortPanel()`'s own two-stage shape exactly. */
export function filterPanel(
  properties: PropertyResponse[],
  filter: Record<string, unknown> | null,
  onSetFilter: (updater: FilterUpdater) => void
): MenuPanel {
  const node = asFilterNode(filter);

  if (!node) {
    return filterPropertyPicker(
      properties,
      (p) => onSetFilter(() => defaultConditionFor(p)),
      () => onSetFilter(() => ({ type: "group", op: "and", children: [] })),
    );
  }

  return {
    title: "Filter",
    sections: [{ rows: [], content: <FilterBuilderRoot filter={node} properties={properties} onSetFilter={onSetFilter} /> }],
  };
}
