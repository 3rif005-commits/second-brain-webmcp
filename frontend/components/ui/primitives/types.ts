// The data contract every menu-shaped surface in the database UI is built from.
//
// Panels are DATA, not components. The same MenuPanel renders into a Popover
// (toolbar Sort), into the config sidebar's panel stack (Settings -> Sort), or
// as a flyout beside a parent menu (header menu -> Change type). That is not a
// design preference — it is what live Notion does, and building a bespoke
// component per host is how this codebase ended up with 40 native <select>s.
// Evidence: docs/ui-specs/raw-dom/filter-entry.txt, "ONE PANEL, TWO HOSTS".

import type { ReactNode } from "react";

export interface MenuRow {
  id: string;
  icon?: ReactNode;
  label: string;
  /** Rendered in place of the text label. `label` still drives search matching
   * and the accessible name, so this is presentation only.
   *
   * Exists because Notion renders a select option's row as the option's own
   * COLOURED PILL, not as swatch-plus-text — and the same pill reappears in the
   * filter value picker and the group panel. Widening `label` to a ReactNode
   * instead would have broken search, which needs a string. */
  labelNode?: ReactNode;
  /** Caption line under the label. Live example: "This improves performance
   * for large databases." under the "Show large counts as 99+" toggle. */
  description?: string;
  /** A second line under `description`, styled as a link — distinct from it
   * because it carries its own click target. Live example: "Open pages in"
   * -> "Side peek" shows both "Open pages on the side. Keeps the view behind
   * interactive." (description) AND "Default for Table" (annotation) under
   * the currently-selected row. */
  annotation?: { label: string; onSelect?: () => void };
  /** Inline pill after the label — "Basic", "Now with agents". */
  badge?: string;
  /** Right-aligned secondary text. NOT strictly a keyboard shortcut: Notion
   * puts "Alt+Click" in the same slot as "Ctrl+D". */
  hint?: string;
  /** Right-aligned current value — "Table", "Side peek", a count like "11". */
  value?: string;
  /** A row can be a switch, not only an activatable row. */
  kind?: "row" | "toggle";
  /** Trailing checkmark (current type, current calculation) or toggle state. */
  checked?: boolean;
  danger?: boolean;
  /** Semantic, not cosmetic: Text -> Relation is disabled because that
   * conversion is illegal, not because it is unavailable right now. */
  disabled?: boolean;
  disabledReason?: string;
  /** Opens a nested panel. Depth is unbounded — live Notion nests at least
   * three levels (Calculate -> Count -> the count functions). */
  submenu?: () => MenuPanel;
  onSelect?: () => void;
}

export interface MenuSection {
  label?: string;
  /** Whether this section participates in the panel's search. Notion's type
   * picker filters "Select type" while leaving "AI Autofill" above it intact,
   * so search scope is per-section rather than per-panel. Defaults to true. */
  searchable?: boolean;
  /** Right-aligned bulk action on the section header, e.g. "Hide all".
   *
   * `label` is a ReactNode, not a string, because the action is not always
   * text: the select/status option editor's "Options" header carries a bare
   * `+` icon button (captured 2026-08-31, raw-dom/20-edit-property-panel.md),
   * while the property-visibility panel's carries the words "Hide all".
   * `aria` names the icon form, which has no readable text of its own. */
  action?: { label: ReactNode; aria?: string; onSelect: () => void };
  rows: MenuRow[];
  /** Arbitrary content rendered AFTER this section's rows, inside the same
   * section (so it gets no divider of its own).
   *
   * Exists for the parts of a real Notion panel that are not rows at all: the
   * number property's `Show as` card triplet and the Color / Divide by / Show
   * number sub-form it reveals, and the trailing "Changes apply to all views
   * showing this property." disclaimer. Putting those in `MenuPanel.footer`
   * would be wrong twice over — the footer is muted (these cards are
   * interactive) and it draws a divider the captured panel does not have. */
  content?: ReactNode;
}

export interface MenuPanel {
  title?: string;
  /** Rendered above the search and rows.
   *
   * Exists because Notion names things IN their own config panel rather than
   * through a "Rename" row: a property's name is an editable input at the top
   * of its column header menu, and a view's name at the top of the settings
   * sidebar. `title` is a string and cannot carry an input. */
  header?: ReactNode;
  /** Per-panel, not global: the property type list is a 2-column grid in the
   * "+ Add property" popover and a 1-column list in "Change type". */
  columns?: 1 | 2;
  /** `scope: "section"` matches Notion's type picker, where the magnifier sits
   * on the "Select type" section header and the AI Autofill section above is
   * left unfiltered. */
  search?: {
    placeholder: string;
    scope?: "panel" | "section";
    /** Defaults to true. Set false when the HOST owns the primary input —
     * property creation focuses the name field in the header cell, and a
     * self-focusing search inside the panel would steal it. */
    autoFocus?: boolean;
  };
  sections: MenuSection[];
  footer?: ReactNode;
  /** Overrides the host's default width for THIS panel.
   *
   * Widths are per-panel in Notion, not per-menu: the column header menu is
   * 248px, but the `Edit property` flyout it opens measured 299px — wide
   * enough for "Changes apply to all views showing this property." to sit on
   * one line. A flyout that inherited its parent's width would wrap it.
   * Matches `PopoverWidth`; omitted means the host decides. */
  width?: "sm" | "md" | "lg";
}

/** How a submenu is presented.
 *  - "flyout": a second panel beside the parent, parent stays visible.
 *             Used by popover-hosted menus (column header, row menu).
 *  - "push":  replaces the panel, with a back arrow beside the title.
 *             Used by the docked config sidebar.
 *  Both exist in Notion; neither is "the" pattern. */
export type MenuNav = "flyout" | "push";
