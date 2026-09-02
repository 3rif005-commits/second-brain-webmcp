// M4's filter tree — mirrors `backend/services/db/query/ast.py` exactly:
//
//   FilterCondition { type: "condition", property, operator, value }
//   FilterGroup     { type: "group", op: "and" | "or", children: [FilterNode] }
//
// `view.filter` (a plain JSONB `Record<string, unknown> | null`) holds
// either shape directly, or `null` for "no filter" — no wrapper, no ids.
// Editing an arbitrary tree needs SOME way to address "this one node" from
// the UI; rather than inventing an id field the backend doesn't have, every
// write here is addressed by PATH — an array of child indices from the
// root, walked fresh on each edit. The tree is rebuilt from `view.filter`
// on every render, so a path is only ever used within the same render pass
// that produced it (no path is ever held across a re-render).
import type { FilterOperator } from "./filterOperators";
import { defaultValueForOperator, isFilterableType, operatorFor, operatorsForType } from "./filterOperators";
import type { PropertyResponse } from "./types";

export interface FilterCondition {
  type: "condition";
  property: string;
  operator: string;
  value?: unknown;
}

export interface FilterGroup {
  type: "group";
  op: "and" | "or";
  children: FilterNode[];
}

export type FilterNode = FilterCondition | FilterGroup;

export function isFilterGroup(node: FilterNode | null | undefined): node is FilterGroup {
  return Boolean(node) && (node as FilterNode).type === "group";
}

export function isFilterCondition(node: FilterNode | null | undefined): node is FilterCondition {
  return Boolean(node) && (node as FilterNode).type === "condition";
}

/** Reads `view.filter`'s opaque JSONB as a `FilterNode`, tolerating a
 * missing/malformed shape as `null` — same "tolerant reader" convention
 * every other `config` reader in this file's siblings (types.ts) follows. */
export function asFilterNode(raw: Record<string, unknown> | null | undefined): FilterNode | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "condition" && typeof raw.property === "string" && typeof raw.operator === "string") {
    return raw as unknown as FilterCondition;
  }
  if (raw.type === "group" && (raw.op === "and" || raw.op === "or") && Array.isArray(raw.children)) {
    return raw as unknown as FilterGroup;
  }
  return null;
}

/** Every condition in the tree, depth-first — the filter bar's rule COUNT
 * ("1 rule" / "2 rules", filter-panel.md's chip) counts leaves, not
 * top-level children, so a nested group with 2 conditions inside a
 * 1-child top group still reads "2 rules". */
export function countConditions(node: FilterNode | null): number {
  if (!node) return 0;
  if (isFilterCondition(node)) return 1;
  return node.children.reduce((sum, child) => sum + countConditions(child), 0);
}

function cloneNode(node: FilterNode): FilterNode {
  return isFilterGroup(node) ? { ...node, children: [...node.children] } : { ...node };
}

/** Returns a NEW tree with `updater` applied to the node at `path` (empty
 * path = the root itself). Never mutates `root`. */
export function updateAtPath(root: FilterNode, path: number[], updater: (node: FilterNode) => FilterNode): FilterNode {
  if (path.length === 0) return updater(root);
  if (!isFilterGroup(root)) return root;
  const [head, ...rest] = path;
  const children = [...root.children];
  if (head < 0 || head >= children.length) return root;
  children[head] = updateAtPath(children[head], rest, updater);
  return { ...root, children };
}

/** Returns a new tree with the node at `path` removed, or `null` if that
 * was the root itself. A group left with zero children is pruned from ITS
 * OWN parent in the same pass (removing the last rule inside a nested group
 * removes the now-empty group too, rather than leaving a dangling
 * `children: []}` the UI has no row for). */
export function removeAtPath(root: FilterNode, path: number[]): FilterNode | null {
  if (path.length === 0) return null;
  if (!isFilterGroup(root)) return root;
  if (path.length === 1) {
    const children = root.children.filter((_, i) => i !== path[0]);
    return children.length === 0 ? null : { ...root, children };
  }
  const [head, ...rest] = path;
  const children = [...root.children];
  if (head < 0 || head >= children.length) return root;
  const updatedChild = removeAtPath(children[head], rest);
  if (updatedChild === null) {
    children.splice(head, 1);
    return children.length === 0 ? null : { ...root, children };
  }
  children[head] = updatedChild;
  return { ...root, children };
}

/** Appends `node` as a new child of the group at `path` (path must resolve
 * to a group — the root's own path `[]` when the root is already a group,
 * or a nested group's path otherwise). */
export function appendChild(root: FilterNode, path: number[], node: FilterNode): FilterNode {
  return updateAtPath(root, path, (target) =>
    isFilterGroup(target) ? { ...target, children: [...target.children, node] } : target
  );
}

// filter-panel.md's own capture (line 84, `Where [Aa Name ▾] [Contains ▾] [Value]`,
// re-asserted by the panel's checklist step 6) is explicit that a freshly-picked
// Text/Title property defaults to "Contains" — NOT the first entry in its operator
// list (`equals`/"Is"). Live-verified reachable and materially wrong, not cosmetic:
// picking Title and typing a substring (e.g. "Article" against a row titled "Article
// one") silently matched ZERO rows instead of narrowing, because the condition was
// applying `equals` under the hood. Every other type's default is `filter-panel.md`'s
// own explicit `TBD` — list-order-as-default stays their behavior until one is
// captured, per this workstream's "no invented numbers" rule.
const _TEXT_SHAPE_TYPES_FOR_DEFAULT = new Set(["title", "rich_text", "url", "email", "phone_number"]);

/** The default operator for a freshly-picked property — "Contains" for the five
 * text-shaped types (confirmed against Notion, see the comment above), the first
 * entry in the type's operator list for everything else (`filter-panel.md`'s own
 * `TBD` for those, not yet captured). */
export function defaultOperatorFor(type: string): FilterOperator | undefined {
  const operators = operatorsForType(type);
  if (_TEXT_SHAPE_TYPES_FOR_DEFAULT.has(type)) {
    return operators.find((o) => o.name === "contains") ?? operators[0];
  }
  return operators[0];
}

export function defaultConditionFor(property: PropertyResponse): FilterCondition {
  const operator = defaultOperatorFor(property.type);
  // `defaultValueForOperator` — bool/verification_status only, see its own
  // doc comment: without this the condition looks complete (its value
  // editor shows a real option selected) but silently never filters.
  const value = operator ? defaultValueForOperator(operator) : undefined;
  return {
    type: "condition",
    property: property.key,
    operator: operator?.name ?? "is_empty",
    ...(value !== undefined ? { value } : {}),
  };
}

/** Every property this app can filter by at all — mirrors the backend's own
 * "type not in TYPE_OPERATORS -> 400" signal: an unfilterable type is
 * simply absent from the map, formula/rollup included until Milestone 8
 * dispatches them by `result_type`. Re-exported here so callers building a
 * filter tree don't need a second import from filterOperators.ts. */
export function isFilterableProperty(property: Pick<PropertyResponse, "type">): boolean {
  return isFilterableType(property.type);
}

/** Drops every node the backend would 400 on before `POST .../query` ever
 * sees it — a `FilterGroup` with zero children (`ast.py`'s
 * `Field(min_length=1)`) or a `FilterCondition` whose operator needs a
 * value it doesn't have yet (`operators.py`'s `coerce_value`, e.g. "Is"
 * with no value typed in). Both are ordinary, reachable MID-EDIT states —
 * "+ Add advanced filter" starts an intentionally empty group
 * (FilterBuilder.tsx), and picking a property applies its default operator
 * before any value has been entered — and this app persists the filter
 * tree to `view.filter` on every edit (there is no separate "draft" state
 * a half-built rule could live in instead), so without this pass every
 * such mid-edit moment reaches the compiler and 400s the row query, which
 * `useDatabaseView.loadRows` catches into `error` and never surfaces (no
 * toast, no visible banner once a database has already loaded) — rows just
 * silently stop updating until the rule is completed or removed. This
 * function does NOT touch what's persisted (`view.filter` keeps the
 * in-progress node so the builder keeps showing it to edit) — only what's
 * actually sent to the query endpoint; an incomplete rule is treated as not
 * filtering yet, not as an error. */
export function sanitizeFilterForQuery(
  node: FilterNode | null,
  properties: PropertyResponse[]
): FilterNode | null {
  if (!node) return null;
  if (isFilterCondition(node)) {
    const property = properties.find((p) => p.key === node.property);
    const operator = operatorFor(property?.type ?? "", node.operator);
    if (!operator) return null;
    if (operator.argType === "none") return node;
    if (node.value === undefined || node.value === null) return null;
    if (Array.isArray(node.value) && node.value.length === 0) return null;
    return node;
  }
  const children = node.children
    .map((child) => sanitizeFilterForQuery(child, properties))
    .filter((child): child is FilterNode => child !== null);
  if (children.length === 0) return null;
  return { ...node, children };
}
