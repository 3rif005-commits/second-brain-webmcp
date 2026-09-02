// Per-column view state: visibility, wrap, calculation, order.
//
// All of it lives in `db_views.config`, which is an unvalidated JSONB
// pass-through (`ViewUpdate`). That is deliberate and it is also what Notion
// does — property order, visibility and width are PER VIEW there, which is why
// the "Property visibility" panel is where you reorder columns. So none of
// this needs a backend change, and none of it belongs on
// `db_properties.position`: the same property can be third in one view and
// hidden in another.
//
// WRITERS RETURN A PATCH, not a whole config. `DatabaseShell.patchViewConfig`
// merges `{...latest, ...patch}` onto the freshest known config and chains
// same-view writes, which is what fixed a real bug where two rapid config
// changes each read the same stale render-time config and the second silently
// dropped the first. Handing that merger a FULL config would defeat it: the
// full object would overwrite keys a concurrent write had just set.
//
// Readers are tolerant by design. A view's config is written by several
// surfaces (M1's header menu, M3's settings sidebar, M11's drag-resize) and
// read by all of them, so an absent or malformed key must degrade to the
// default rather than throw.
import type { PropertyResponse, ViewResponse } from "./types";

/** `view.sorts`' element shape — a top-level field, not part of `config`,
 * but shared here since every writer of it already imports from this file. */
export type Sort = { property: string; direction: "asc" | "desc" };

/** `sorts` is a whole-array REPLACE, not a mergeable object like `config`, so
 * a caller cannot just hand over a finished array the way `onPatchConfig`
 * takes a patch — two writers computing "the new array" from the same
 * stale render-time `sorts` is exactly `patchViewConfig`'s own bug, one
 * field over (M1's header menu, M3's toolbar Sort popover and settings
 * sidebar Sort panel can all be reached in one session now). The updater
 * receives whatever `DatabaseShell`'s queue knows is LATEST at the moment
 * it actually runs, not what was current when the row was clicked. */
export type SortsUpdater = (current: Sort[]) => Sort[];

/** Keys hidden in this view. Absent means "nothing hidden". */
export function getHiddenKeys(config: Record<string, unknown>): string[] {
  const raw = config.hidden_properties;
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
}

export function isHidden(config: Record<string, unknown>, key: string): boolean {
  return getHiddenKeys(config).includes(key);
}

export function patchHidden(
  config: Record<string, unknown>,
  key: string,
  hidden: boolean
): Record<string, unknown> {
  const current = getHiddenKeys(config).filter((k) => k !== key);
  return { hidden_properties: hidden ? [...current, key] : current };
}

/** View-level default for content wrapping — M3's "Wrap all content" toggle
 * in the Layout panel. Falls back to TRUE, matching `isWrapped`'s own prior
 * hardcoded default, so a view that has never touched either setting still
 * renders wrapped. */
export function getWrapAllContent(config: Record<string, unknown>): boolean {
  return config.wrap_all_content !== false;
}

export function patchWrapAllContent(config: Record<string, unknown>, wrapped: boolean): Record<string, unknown> {
  return { wrap_all_content: wrapped };
}

/** Content wrapping, per column.
 *
 * A PER-COLUMN override (`wrapped_properties`, set by the column header
 * menu's "Unwrap content") beats the VIEW-level default (`wrap_all_content`,
 * set by the Layout panel's "Wrap all content") — the same two-entry-points
 * shape "Show page icon" has (table-column-header.md vs view-options-panel.md
 * writing the same key). Absent either, both default to wrapped, because
 * Notion's header menu offers "Unwrap content" on a fresh column — the label
 * names the ACTION, so the current state is wrapped. */
export function isWrapped(config: Record<string, unknown>, key: string): boolean {
  const raw = config.wrapped_properties;
  if (raw && typeof raw === "object" && key in (raw as Record<string, unknown>)) {
    return Boolean((raw as Record<string, boolean>)[key]);
  }
  return getWrapAllContent(config);
}

export function patchWrapped(
  config: Record<string, unknown>,
  key: string,
  wrapped: boolean
): Record<string, unknown> {
  const raw = (config.wrapped_properties ?? {}) as Record<string, boolean>;
  return { wrapped_properties: { ...raw, [key]: wrapped } };
}

/** Column separator lines, view-wide. Defaults to TRUE — Notion ships every
 * fresh table with vertical lines on. */
export function getShowVerticalLines(config: Record<string, unknown>): boolean {
  return config.show_vertical_lines !== false;
}

export function patchShowVerticalLines(config: Record<string, unknown>, shown: boolean): Record<string, unknown> {
  return { show_vertical_lines: shown };
}

/** The 📄 page icon in the title cell. Two entry points write the SAME key:
 * the title column's own header-menu toggle (table-column-header.md) and
 * this view's Layout panel (view-options-panel.md) — both read/write
 * `show_page_icon`, matching how Filter/Sort are reachable from both the
 * toolbar and this sidebar. Defaults to TRUE. */
export function getShowPageIcon(config: Record<string, unknown>): boolean {
  return config.show_page_icon !== false;
}

export function patchShowPageIcon(config: Record<string, unknown>, shown: boolean): Record<string, unknown> {
  return { show_page_icon: shown };
}

export type OpenPagesInMode = "side" | "center" | "full";

/** Where a row opens when clicked. Defaults to "side" — Notion's own default
 * for Table, and the only mode that keeps the table "behind interactive"
 * (Notion's own copy, view-options-panel.md §C). */
export function getOpenPagesInMode(config: Record<string, unknown>): OpenPagesInMode {
  const raw = config.open_pages_in;
  return raw === "center" || raw === "full" ? raw : "side";
}

export function patchOpenPagesInMode(config: Record<string, unknown>, mode: OpenPagesInMode): Record<string, unknown> {
  return { open_pages_in: mode };
}

/** The column footer's calculation, per column. `undefined` = none. */
export function getCalculation(
  config: Record<string, unknown>,
  key: string
): string | undefined {
  const raw = config.calculations;
  if (!raw || typeof raw !== "object") return undefined;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function patchCalculation(
  config: Record<string, unknown>,
  key: string,
  aggregator: string | undefined
): Record<string, unknown> {
  const raw = { ...((config.calculations ?? {}) as Record<string, string>) };
  if (aggregator) raw[key] = aggregator;
  else delete raw[key];
  return { calculations: raw };
}

/** M11 (table-drag-resize.md): per-view column widths, keyed by property
 * key — the same JSONB-pass-through shape `calculations` above uses,
 * **not** a schema-level field ("the same property can be a different
 * width in different views, exactly as with order and visibility" — the
 * spec's own reasoning). Missing entries fall back to whatever default
 * `@tanstack/react-table`'s own `size` would use for that column. */
export function getColumnWidths(config: Record<string, unknown>): Record<string, number> {
  const raw = config.column_widths;
  if (!raw || typeof raw !== "object") return {};
  const widths: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number") widths[key] = value;
  }
  return widths;
}

export function patchColumnWidths(
  config: Record<string, unknown>,
  widths: Record<string, number>
): Record<string, unknown> {
  return { column_widths: widths };
}

/** Column order for this view. Falls back to schema `position` order for any
 * property the config does not mention, so adding a property never leaves it
 * unrendered. */
export function orderProperties(
  properties: PropertyResponse[],
  config: Record<string, unknown>
): PropertyResponse[] {
  const byPosition = [...properties].sort((a, b) => a.position - b.position);
  const raw = config.property_order;
  if (!Array.isArray(raw)) return byPosition;

  const order = raw.filter((k): k is string => typeof k === "string");
  const indexOf = (p: PropertyResponse) => {
    const i = order.indexOf(p.key);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return byPosition.sort((a, b) => indexOf(a) - indexOf(b));
}

/** Insert `key` immediately before or after `anchorKey` in this view's order.
 *
 * Writes an EXPLICIT full order, including properties that were previously
 * implicit, because a partial order plus a position fallback cannot express
 * "third, regardless of when it was created". */
export function patchInsertedNear(
  config: Record<string, unknown>,
  properties: PropertyResponse[],
  key: string,
  anchorKey: string,
  side: "left" | "right"
): Record<string, unknown> {
  const current = orderProperties(properties, config)
    .map((p) => p.key)
    .filter((k) => k !== key);
  const at = current.indexOf(anchorKey);
  const insertAt = at === -1 ? current.length : side === "left" ? at : at + 1;
  current.splice(insertAt, 0, key);
  return { property_order: current };
}

/** The view's config, or an empty object. Views are sometimes null while a
 * database is still loading. */
export function configOf(view: ViewResponse | null | undefined): Record<string, unknown> {
  return view?.config ?? {};
}
