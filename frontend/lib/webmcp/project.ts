"use client";

// The agent's renderer.
//
// The app encodes a lot of meaning in visual channels: a callout's semantic
// type reaches the human as a colour and an icon, a section's importance as
// a background tint, a row's group as a column position. An agent working
// from pixels has to infer all of it, and infers it badly.
//
// These functions emit the same meaning as text. They are the counterpart to
// the React components: same state, different medium. Where a component
// chooses a colour, the function here names what that colour stands for.

import { CALLOUT_PALETTE, type CalloutType } from "@/components/editor/customBlocks";
import type {
  DatabaseRow,
  Group,
  PropertyResponse,
  PropertyValue,
  ViewResponse,
} from "@/lib/database/types";
import { getGroupBySpec } from "@/lib/database/types";

// ── Notes ────────────────────────────────────────────────────────────────

/** `data-importance` is a 0-6 scale the editor renders as a block background
 *  tint. The number alone is not self-explanatory to a model that has never
 *  seen the legend, so the projection carries the scale and its meaning. */
export function projectImportance(raw: unknown): string | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const meaning =
    n >= 6 ? "critical" :
    n >= 5 ? "near-critical" :
    n >= 4 ? "high" :
    n >= 3 ? "moderate" :
    n >= 2 ? "supporting" : "background";
  return `importance ${n} of 6 (${meaning})`;
}

/** A callout's type is stored, but only its colour and icon are rendered.
 *  This is the clearest case in the codebase of meaning that survives in the
 *  data and is lost in the picture. */
export function projectCallout(rawType: unknown): string {
  const key = String(rawType ?? "NOTE").toUpperCase() as CalloutType;
  const entry = CALLOUT_PALETTE[key];
  if (!entry) return "callout (NOTE)";
  return `callout ${key} — "${entry.label}", shown to the reader as a ${entry.color} box with ${entry.icon}`;
}

export function projectMastery(status: unknown): string {
  switch (String(status)) {
    case "mastered":    return "mastery: mastered";
    case "reviewing":   return "mastery: reviewing";
    case "learning":    return "mastery: learning";
    case "not_started": return "mastery: not started";
    default:            return `mastery: ${String(status ?? "unknown")}`;
  }
}

interface BlockLike {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: BlockLike[];
}

/** Flatten BlockNote content (inline styled runs, links, mentions) to plain
 *  text. Styling is deliberately dropped — bold carries no meaning a model
 *  needs, unlike callout type or importance, which are preserved above. */
function inlineText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((node) => {
      if (typeof node === "string") return node;
      if (node && typeof node === "object") {
        const n = node as Record<string, unknown>;
        if (typeof n.text === "string") return n.text;
        if (n.type === "link") return inlineText(n.content);
        // @-mentions of other notes are a real edge in the graph; keep them.
        if (n.type === "mention" || n.type === "noteLink") {
          const props = (n.props ?? {}) as Record<string, unknown>;
          const label = props.title ?? props.noteTitle ?? props.id ?? "note";
          return `[[${String(label)}]]`;
        }
      }
      return "";
    })
    .join("");
}

/** Render a note's blocks as an annotated outline: the text a reader sees,
 *  plus the semantics the styling stands for. */
export function projectBlocks(blocks: BlockLike[], depth = 0): string[] {
  const lines: string[] = [];
  for (const block of blocks ?? []) {
    const indent = "  ".repeat(depth);
    const props = block.props ?? {};
    const body = inlineText(block.content).trim();
    const annotations: string[] = [];

    const importance = projectImportance(
      props.importance ?? props["data-importance"]
    );
    if (importance) annotations.push(importance);

    let prefix = "";
    switch (block.type) {
      case "heading": {
        const level = Number(props.level ?? 1);
        prefix = `${"#".repeat(Math.min(level, 6))} `;
        break;
      }
      case "bulletListItem":  prefix = "- "; break;
      case "numberedListItem": prefix = "1. "; break;
      case "checkListItem":
        prefix = props.checked ? "- [x] " : "- [ ] ";
        break;
      case "callout":
        annotations.unshift(projectCallout(props.calloutType));
        break;
      case "codeBlock":
        prefix = "```" + String(props.language ?? "") + "\n";
        break;
      case "table":
        annotations.push("table");
        break;
      default:
        break;
    }

    if (body || annotations.length) {
      const suffix = annotations.length ? `   ⟨${annotations.join("; ")}⟩` : "";
      lines.push(`${indent}${prefix}${body}${suffix}`);
    }
    if (block.children?.length) {
      lines.push(...projectBlocks(block.children, depth + 1));
    }
  }
  return lines;
}

export function projectNote(note: {
  id?: string;
  title?: string;
  mastery_status?: unknown;
  topics?: string[] | null;
  content?: BlockLike[] | null;
}): string {
  const head = [
    `# ${note.title ?? "Untitled"}`,
    note.id ? `id: ${note.id}` : null,
    projectMastery(note.mastery_status),
    note.topics?.length ? `topics: ${note.topics.join(", ")}` : null,
  ].filter(Boolean);
  const body = projectBlocks(note.content ?? []);
  return [...head, "", ...body].join("\n");
}

// ── Databases ────────────────────────────────────────────────────────────

/** Every cell arrives as `{ type: T, [T]: inner }`, so one unwrap covers the
 *  whole union including types this UI renders generically. */
export function projectPropertyValue(value: PropertyValue | null | undefined): string {
  if (value == null) return "";
  const inner = (value as Record<string, unknown>)[value.type];
  if (inner == null) return "";
  if (Array.isArray(inner)) return inner.join(", ");
  if (typeof inner === "object") {
    const date = inner as { start?: string; end?: string | null };
    if (date.start) return date.end ? `${date.start} → ${date.end}` : date.start;
    return JSON.stringify(inner);
  }
  if (typeof inner === "boolean") return inner ? "yes" : "no";
  return String(inner);
}

export function projectRow(
  row: DatabaseRow,
  properties: PropertyResponse[]
): Record<string, string> {
  const out: Record<string, string> = { id: row.id };
  for (const prop of properties) {
    const rendered = projectPropertyValue(row.properties?.[prop.key]);
    if (rendered !== "") out[prop.name] = rendered;
  }
  return out;
}

/** A property's schema, in the form an agent needs to write a valid value:
 *  the type, and for selects the options it is allowed to choose from. */
export function projectProperty(prop: PropertyResponse): string {
  const parts = [`${prop.name} (${prop.type}`];
  const options = (prop.config?.options ?? prop.config?.groups) as
    | { name?: string }[]
    | undefined;
  if (Array.isArray(options) && options.length) {
    const names = options.map((o) => o?.name).filter(Boolean);
    if (names.length) parts.push(`: ${names.join(" | ")}`);
  }
  if (prop.result_type) parts.push(` → ${prop.result_type}`);
  parts.push(")");
  if (prop.description) parts.push(` — ${prop.description}`);
  return parts.join("");
}

/** Describe what the user is currently looking at: not the whole database,
 *  but this view's slice of it. Filters and grouping are the state a backend
 *  API cannot see and a screenshot cannot convey precisely. */
export function projectView(view: ViewResponse | undefined, properties: PropertyResponse[]): string {
  if (!view) return "no active view";
  const nameOf = (key: unknown) =>
    properties.find((p) => p.key === key)?.name ?? String(key ?? "?");

  const bits = [`view "${view.name}" (${view.type})`];
  if (view.filter && Object.keys(view.filter).length) {
    bits.push(`filtered: ${describeFilter(view.filter, nameOf)}`);
  }
  if (Array.isArray(view.sorts) && view.sorts.length) {
    const sorts = view.sorts
      .map((s) => {
        const sort = s as { property?: string; direction?: string };
        return `${nameOf(sort.property)} ${sort.direction ?? "asc"}`;
      })
      .join(", ");
    bits.push(`sorted by ${sorts}`);
  }
  // `getGroupBySpec` rather than reading config.group_by by hand: the stored
  // key is `property_key`, and guessing `property` here made every grouped
  // view project as "grouped by ?" while looking perfectly fine in the UI.
  const groupBy = getGroupBySpec(view.config ?? {});
  if (groupBy) bits.push(`grouped by ${nameOf(groupBy.property_key)}`);
  return bits.join("; ");
}

function describeFilter(
  node: Record<string, unknown>,
  nameOf: (key: unknown) => string
): string {
  if (Array.isArray(node.and)) {
    return node.and.map((n) => describeFilter(n as Record<string, unknown>, nameOf)).join(" AND ");
  }
  if (Array.isArray(node.or)) {
    return `(${node.or.map((n) => describeFilter(n as Record<string, unknown>, nameOf)).join(" OR ")})`;
  }
  const prop = nameOf(node.property);
  const op = String(node.operator ?? node.op ?? "=");
  const value = node.value;
  return `${prop} ${op} ${
    value === undefined || value === null ? "∅" : JSON.stringify(value)
  }`;
}

/** Board columns, as text. The human reads position; the agent reads this. */
export function projectGroups(groups: Group[], properties: PropertyResponse[]) {
  return groups.map((g) => ({
    group: g.label,
    row_count: g.row_count,
    rows: g.rows.map((r) => projectRow(r, properties)),
  }));
}
