"use client";

// Database tools, generated from the live schema.
//
// The naive version of this file exports one `db.create-row` taking
// `{ databaseId, values: object }` and leaves the model to guess what goes
// in `values`. It guesses wrong: invented property names, select values that
// aren't options, dates in the wrong shape.
//
// Instead, every tool here is generated from the database the user actually
// has open. `create-row` for a Reading List advertises `Status` with its real
// enum, `Rating` with its real bounds, and nothing else. The model cannot
// name a property that doesn't exist because the schema won't let it, and
// the description tells it what the database is for. Opening a different
// database swaps the whole set and fires `toolchange`.
//
// Writes go through the same functions the UI calls — `updateCell`,
// `updateView` — so optimistic updates, rollback on failure and toasts all
// behave exactly as they do for a human edit.

import type {
  DatabaseRow,
  Group,
  PropertyResponse,
  PropertyValue,
  ViewResponse,
} from "@/lib/database/types";
// Grouping and filtering have exact stored shapes with their own constructors
// and readers (`getGroupBySpec`, `asFilterNode`). Writing those objects by hand
// here is how an agent surface silently drifts from the UI: a malformed
// `group_by` is not rejected, it is just ignored, and the board renders "no
// groupable property yet" while the tool call reports success. Reuse the
// helpers the UI itself uses.
import { defaultGroupBySpec } from "@/lib/database/types";
import { isFilterableType, operatorsForType } from "@/lib/database/filterOperators";
import type { JsonSchema, WebMcpToolDef } from "../types";
import { errorResult, json, text } from "../types";
import { projectGroups, projectProperty, projectRow, projectView } from "../project";

export interface DatabaseToolContext {
  databaseName: string;
  dataSourceId: string;
  properties: PropertyResponse[];
  views: ViewResponse[];
  activeView: ViewResponse | undefined;
  activeViewId: string | null;
  rows: DatabaseRow[];
  groups: Group[] | null;
  setActiveViewId: (id: string) => void;
  updateCell: (rowId: string, propertyKey: string, value: PropertyValue | null) => Promise<void>;
  updateView: (viewId: string, patch: Record<string, unknown>) => Promise<ViewResponse>;
  refetchRows: () => Promise<void> | void;
}

/** Tool names have to be stable and readable. The database's own name is the
 *  most meaningful thing to key on — a model reading `db.reading-list.*`
 *  already knows what it is holding. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "database";
}

/** Property types whose values are computed, not written. Offering them on a
 *  write tool would invite calls that can only fail. */
const READ_ONLY_TYPES = new Set([
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "button",
  "relation",
  "unique_id",
]);

function optionNames(prop: PropertyResponse): string[] {
  const raw = (prop.config?.options ?? prop.config?.groups) as
    | { name?: string }[]
    | undefined;
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => o?.name).filter((n): n is string => typeof n === "string");
}

/** One property becomes one JSON Schema entry, carrying its real constraints
 *  — this is the whole point of generating rather than hand-writing. */
function propertySchema(prop: PropertyResponse): JsonSchema | null {
  const description = prop.description ?? undefined;
  switch (prop.type) {
    case "title":
    case "rich_text":
    case "url":
    case "email":
    case "phone_number":
      return { type: "string", description };
    case "number":
      return { type: "number", description };
    case "checkbox":
      return { type: "boolean", description };
    case "date":
      return {
        type: "string",
        description: description ?? "ISO 8601 date, e.g. 2026-09-03",
      };
    case "select":
    case "status": {
      const options = optionNames(prop);
      return options.length
        ? { type: "string", enum: options, description }
        : { type: "string", description };
    }
    case "multi_select": {
      const options = optionNames(prop);
      return {
        type: "array",
        description,
        items: options.length ? { type: "string", enum: options } : { type: "string" },
      };
    }
    default:
      return null;
  }
}

/** Turn a plain agent-supplied value into the `{type, [type]: inner}` wrapper
 *  the API speaks. */
function toWireValue(prop: PropertyResponse, raw: unknown): PropertyValue | null {
  if (raw === null || raw === undefined || raw === "") return null;
  switch (prop.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n)
        ? ({ type: "number", number: n } as PropertyValue)
        : null;
    }
    case "checkbox":
      return { type: "checkbox", checkbox: Boolean(raw) } as PropertyValue;
    case "multi_select":
      return {
        type: "multi_select",
        multi_select: Array.isArray(raw) ? raw.map(String) : [String(raw)],
      } as PropertyValue;
    case "date":
      return {
        type: "date",
        date: { start: String(raw), end: null, time_zone: null },
      } as PropertyValue;
    default:
      return { type: prop.type, [prop.type]: String(raw) } as unknown as PropertyValue;
  }
}

function writableProperties(properties: PropertyResponse[]): PropertyResponse[] {
  return properties.filter((p) => !READ_ONLY_TYPES.has(p.type) && propertySchema(p) !== null);
}

function rowValueSchema(properties: PropertyResponse[]): {
  schema: JsonSchema;
  titleName: string | null;
} {
  const props: Record<string, JsonSchema> = {};
  let titleName: string | null = null;
  for (const prop of writableProperties(properties)) {
    const schema = propertySchema(prop);
    if (!schema) continue;
    props[prop.name] = schema;
    if (prop.type === "title") titleName = prop.name;
  }
  return {
    schema: { type: "object", properties: props },
    titleName,
  };
}

/** Match an agent-supplied key to a property. Models are inconsistent about
 *  case and spacing, and failing a whole call over "due date" vs "Due Date"
 *  is a bad trade. */
function findProperty(properties: PropertyResponse[], key: string): PropertyResponse | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    properties.find((p) => p.name === key) ??
    properties.find((p) => norm(p.name) === norm(key)) ??
    properties.find((p) => p.key === key)
  );
}

export function buildDatabaseTools(ctx: DatabaseToolContext): WebMcpToolDef[] {
  const slug = slugify(ctx.databaseName);
  const ns = `db.${slug}`;
  const { schema: valueSchema, titleName } = rowValueSchema(ctx.properties);
  const writable = writableProperties(ctx.properties);
  const rowCount = ctx.groups
    ? ctx.groups.reduce((n, g) => n + g.row_count, 0)
    : ctx.rows.length;

  /** Reject a select/status/multi_select value that is not one of the
   *  property's configured options.
   *
   *  The generated inputSchema already advertises the valid enum, but an
   *  advertised enum is guidance, not enforcement: nothing in the browser
   *  validates a tool's arguments against its schema before `execute` runs,
   *  and the API accepts an unknown option name verbatim. Without this, a
   *  model that guesses "In Progress" for a database whose option is
   *  "Reading" silently writes a status no filter will ever match. */
  const invalidOption = (prop: PropertyResponse, raw: unknown): string | null => {
    if (!["select", "status", "multi_select"].includes(prop.type)) return null;
    const options = optionNames(prop);
    if (!options.length) return null;
    const given = Array.isArray(raw) ? raw.map(String) : [String(raw)];
    const bad = given.filter((v) => v !== "" && !options.includes(v));
    if (!bad.length) return null;
    return `${prop.name} has no option ${bad.map((b) => `"${b}"`).join(", ")}. ` +
      `Valid: ${options.join(" | ")}`;
  };

  const applyValues = async (rowId: string, values: Record<string, unknown>) => {
    const applied: string[] = [];
    const skipped: string[] = [];
    const rejected: string[] = [];
    for (const [key, raw] of Object.entries(values ?? {})) {
      const prop = findProperty(ctx.properties, key);
      if (!prop || READ_ONLY_TYPES.has(prop.type)) {
        skipped.push(key);
        continue;
      }
      const problem = invalidOption(prop, raw);
      if (problem) {
        rejected.push(problem);
        continue;
      }
      await ctx.updateCell(rowId, prop.key, toWireValue(prop, raw));
      applied.push(prop.name);
    }
    return { applied, skipped, rejected };
  };

  const tools: WebMcpToolDef[] = [
    {
      name: `${ns}.describe`,
      description:
        `Describe the "${ctx.databaseName}" database the user has open: its properties and ` +
        `their allowed values, the views available, and which view is active with its filters, ` +
        `sorting and grouping. Call this first if you are unsure how to write to this database.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: () =>
        text(
          [
            `Database: ${ctx.databaseName} (${rowCount} rows)`,
            "",
            "Properties:",
            ...ctx.properties.map((p) => `  - ${projectProperty(p)}`),
            "",
            `Views: ${ctx.views.map((v) => `${v.name} (${v.type})`).join(", ") || "none"}`,
            `Active: ${projectView(ctx.activeView, ctx.properties)}`,
          ].join("\n")
        ),
    },

    {
      name: `${ns}.list-visible-rows`,
      description:
        `Return the rows currently visible in the active view of "${ctx.databaseName}" — after ` +
        `its filters, sorting and grouping have been applied. This is what the user can see on ` +
        `screen right now, which is not the same as every row in the database.`,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
        },
      },
      annotations: { readOnlyHint: true },
      execute: (input) => {
        const limit = Math.min(Number(input?.limit ?? 50) || 50, 200);
        if (ctx.groups) {
          return json({
            view: projectView(ctx.activeView, ctx.properties),
            grouped: true,
            groups: projectGroups(ctx.groups, ctx.properties).map((g) => ({
              ...g,
              rows: g.rows.slice(0, limit),
            })),
          });
        }
        return json({
          view: projectView(ctx.activeView, ctx.properties),
          grouped: false,
          row_count: ctx.rows.length,
          rows: ctx.rows.slice(0, limit).map((r) => projectRow(r, ctx.properties)),
        });
      },
    },

    {
      name: `${ns}.create-row`,
      description:
        `Add a row to "${ctx.databaseName}". Property names and their allowed values are in this ` +
        `tool's schema — use them exactly.` +
        (titleName ? ` "${titleName}" is the row's title.` : ""),
      inputSchema: {
        type: "object",
        properties: { values: valueSchema },
        required: titleName ? ["values"] : [],
      },
      execute: async (input) => {
        const values = (input?.values ?? {}) as Record<string, unknown>;
        const res = await fetch(`/api/db/data-sources/${ctx.dataSourceId}/rows`, {
          method: "POST",
        });
        if (!res.ok) {
          return errorResult(`Could not create the row (HTTP ${res.status}).`);
        }
        const created = (await res.json()) as { id: string };
        const { applied, skipped, rejected } = await applyValues(created.id, values);
        await ctx.refetchRows();
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Created row ${created.id} in ${ctx.databaseName}` +
                (applied.length ? `, set ${applied.join(", ")}` : "") +
                (skipped.length
                  ? `. Ignored unknown or computed properties: ${skipped.join(", ")}`
                  : ".") +
                (rejected.length ? ` NOT set — ${rejected.join(" ")}` : ""),
            },
          ],
          isError: rejected.length > 0,
        };
      },
    },

    {
      name: `${ns}.update-row`,
      description:
        `Change property values on an existing row of "${ctx.databaseName}". Get row ids from ` +
        `${ns}.list-visible-rows.`,
      inputSchema: {
        type: "object",
        properties: {
          rowId: { type: "string", description: "The row's id." },
          values: valueSchema,
        },
        required: ["rowId", "values"],
      },
      execute: async (input) => {
        const rowId = String(input?.rowId ?? "");
        if (!rowId) return errorResult("rowId is required.");
        const { applied, skipped, rejected } = await applyValues(
          rowId,
          (input?.values ?? {}) as Record<string, unknown>
        );
        if (!applied.length) {
          return errorResult(
            rejected.length
              ? rejected.join(" ")
              : `Nothing was written. Writable properties are: ${writable.map((p) => p.name).join(", ")}`
          );
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Updated ${applied.join(", ")} on row ${rowId}` +
                (skipped.length ? `. Ignored: ${skipped.join(", ")}` : ".") +
                (rejected.length ? ` NOT set — ${rejected.join(" ")}` : ""),
            },
          ],
          isError: rejected.length > 0,
        };
      },
    },

    {
      name: `${ns}.switch-view`,
      description:
        `Switch "${ctx.databaseName}" to a different view. This changes what the user sees on ` +
        `screen. Available: ${ctx.views.map((v) => v.name).join(", ") || "none"}.`,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            enum: ctx.views.map((v) => v.name),
            description: "The view to show.",
          },
        },
        required: ["name"],
      },
      execute: (input) => {
        const wanted = String(input?.name ?? "");
        const view =
          ctx.views.find((v) => v.name === wanted) ??
          ctx.views.find((v) => v.name.toLowerCase() === wanted.toLowerCase());
        if (!view) {
          return errorResult(
            `No view called "${wanted}". Available: ${ctx.views.map((v) => v.name).join(", ")}`
          );
        }
        ctx.setActiveViewId(view.id);
        return text(`Switched to the "${view.name}" ${view.type} view.`);
      },
    },

    {
      name: `${ns}.set-grouping`,
      description:
        `Group the active view of "${ctx.databaseName}" by a property — the columns of a board, ` +
        `or the sections of a list. Pass null to remove grouping.`,
      inputSchema: {
        type: "object",
        properties: {
          property: {
            type: "string",
            enum: ctx.properties
              .filter((p) => ["select", "status", "checkbox", "multi_select"].includes(p.type))
              .map((p) => p.name),
            description: "Property to group by, or omit to ungroup.",
          },
        },
      },
      execute: async (input) => {
        if (!ctx.activeViewId) return errorResult("No view is active.");
        const wanted = input?.property ? String(input.property) : null;
        if (!wanted) {
          await ctx.updateView(ctx.activeViewId, {
            config: { ...(ctx.activeView?.config ?? {}), group_by: null },
          });
          return text("Removed grouping from the active view.");
        }
        const prop = findProperty(ctx.properties, wanted);
        if (!prop) return errorResult(`No property called "${wanted}".`);
        await ctx.updateView(ctx.activeViewId, {
          config: {
            ...(ctx.activeView?.config ?? {}),
            group_by: defaultGroupBySpec(prop),
          },
        });
        // See the note in set-filter: the hook's own effect re-queries on a
        // config change, and a redundant refetch here races it with stale args.
        return text(`Grouped the active view by ${prop.name}.`);
      },
    },

    {
      name: `${ns}.set-filter`,
      description:
        `Filter the active view of "${ctx.databaseName}" so only matching rows are shown. The ` +
        `user sees the grid change. Omit both arguments to clear the filter.`,
      inputSchema: {
        type: "object",
        properties: {
          property: {
            type: "string",
            enum: writable.filter((p) => isFilterableType(p.type)).map((p) => p.name),
            description: "Property to filter on.",
          },
          operator: {
            type: "string",
            // Union across the filterable properties; validated per-property
            // at execution, where the property is actually known.
            enum: [
              ...new Set(
                writable
                  .filter((p) => isFilterableType(p.type))
                  .flatMap((p) => operatorsForType(p.type).map((o) => o.name))
              ),
            ],
            default: "equals",
          },
          value: { type: "string", description: "Value to compare against." },
        },
      },
      execute: async (input) => {
        if (!ctx.activeViewId) return errorResult("No view is active.");
        if (!input?.property) {
          await ctx.updateView(ctx.activeViewId, { filter: null });
          return text("Cleared the filter — all rows are visible again.");
        }
        const prop = findProperty(ctx.properties, String(input.property));
        if (!prop) return errorResult(`No property called "${String(input.property)}".`);
        const allowed = operatorsForType(prop.type);
        if (!allowed.length) {
          return errorResult(`${prop.name} (${prop.type}) cannot be filtered on.`);
        }
        const operator = String(input.operator ?? "equals");
        if (!allowed.some((o) => o.name === operator)) {
          return errorResult(
            `"${operator}" is not valid for ${prop.name} (${prop.type}). ` +
              `Valid: ${allowed.map((o) => o.name).join(", ")}`
          );
        }
        await ctx.updateView(ctx.activeViewId, {
          // `type: "condition"` is required — asFilterNode returns null without
          // it and the view silently renders unfiltered.
          filter: {
            type: "condition",
            property: prop.key,
            operator,
            value: input.value ?? null,
          },
        });
        // No refetch here on purpose. useDatabaseView already re-queries when
        // the active view's filter/config changes (its loadRows effect is keyed
        // on exactly that). Calling refetchRows() as well runs the closure
        // captured BEFORE this write, so it issues a query with the previous
        // filter — and that stale response can land after the correct one,
        // leaving the grid showing unfiltered rows while the view really is
        // filtered.
        return text(
          `Filtered the active view to rows where ${prop.name} ${operator} ${
            input.value ?? "∅"
          }.`
        );
      },
    },
  ];

  return tools;
}
