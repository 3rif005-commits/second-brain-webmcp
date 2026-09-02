"use client";

// M2 (completion) — the `Edit property` panel.
//
// Captured live 2026-08-31: docs/ui-specs/raw-dom/20-edit-property-panel.md.
//
// THREE THINGS THAT LOOK LIKE MISTAKES BUT ARE NOT:
//
//  1. THE ROW IS NOT ALWAYS THERE. A Text column's header menu opens straight
//     onto `Change type` — Notion shows no `Edit property` row at all for a
//     type with no per-type config. `editPropertyRow` returns null for those,
//     and that is faithful, not a gap. An always-present row opening an empty
//     panel is the failure mode this avoids.
//  2. THE PANEL IS DIFFERENT PER TYPE. There is no shared "property settings"
//     form. Number gets format/decimals/show-as; select-likes get the option
//     editor. Deriving per type beats one panel with everything hidden.
//  3. NUMBER'S PANEL HAS NO DIVIDERS. Its rows, the `Show as` cards and the
//     scope disclaimer are one section — which is why they use
//     `MenuSection.content` rather than `MenuPanel.footer` (the footer draws a
//     rule the captured panel does not have).
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  BAR_COLORS,
  NUMBER_FORMATS,
  barColorClass,
  numberFormatLabel,
  ringStyle,
  type NumberConfig,
} from "@/lib/database/numberFormat";
import { pillStyleForOption } from "./cells/CellProps";
import type { MenuPanel, MenuRow } from "@/components/ui/primitives";

/** The 10 option colors, in Notion's own order. Captured, not recalled. */
export const OPTION_COLORS: readonly (readonly [string, string])[] = [
  ["default", "Default"],
  ["gray", "Gray"],
  ["brown", "Brown"],
  ["orange", "Orange"],
  ["yellow", "Yellow"],
  ["green", "Green"],
  ["blue", "Blue"],
  ["purple", "Purple"],
  ["pink", "Pink"],
  ["red", "Red"],
];

const OPTION_SWATCHES: Record<string, string> = {
  default: "bg-gray-200 dark:bg-gray-600",
  gray: "bg-gray-400",
  brown: "bg-amber-700",
  orange: "bg-orange-300",
  yellow: "bg-yellow-300",
  green: "bg-green-300",
  blue: "bg-blue-300",
  purple: "bg-purple-300",
  pink: "bg-pink-300",
  red: "bg-red-300",
};

export function optionSwatch(color: string | undefined): React.ReactNode {
  return (
    <span
      className={`h-3 w-3 rounded-sm ${OPTION_SWATCHES[color ?? "default"] ?? OPTION_SWATCHES.default}`}
    />
  );
}

export interface SelectOption {
  id: string;
  name: string;
  color?: string;
  /** `status` only. The backend's `StatusOption` closes this to exactly three
   * groups (choice.py) — a deliberate simplification of Notion's parallel
   * options[]/groups[] schema, recorded there, not invented here. */
  group?: StatusGroup;
}

export type StatusGroup = "To-do" | "In progress" | "Complete";

export const STATUS_GROUPS: readonly StatusGroup[] = ["To-do", "In progress", "Complete"];

/** Every type whose `Edit property` panel has something in it. A type absent
 * from this list gets NO `Edit property` row — see note 1 above.
 *
 * `formula`, `relation` and `rollup` are deliberately NOT here: their config is
 * already reachable through the push-panel the creation popover uses, and
 * routing the same editor through two different entry points with two
 * different shapes is how the old inline forms drifted apart. Tracked as the
 * one named follow-up in docs/ui-specs/property-create-edit.md. */
const TYPES_WITH_CONFIG = ["number", "select", "multi_select", "status"] as const;

export function hasEditableConfig(type: string): boolean {
  return (TYPES_WITH_CONFIG as readonly string[]).includes(type);
}

export interface EditPropertyArgs {
  type: string;
  config: Record<string, unknown>;
  /** Writes a PATCH onto the property's `config`. Merged server-side by
   * PATCH /db/properties/{id}, so callers pass only what changed. */
  onPatchConfig: (patch: Record<string, unknown>) => void;
}

/** The literal disclaimer Notion prints under the number panel. A property's
 * config is schema-level, so this is true of every panel here — but Notion
 * only shows it on the number one, and this matches that. */
/** Exported for row-peek.md's "+ Add a property" (RowPeek.tsx), which needs
 * the same disclaimer for the same reason — a schema write from a
 * non-obviously-schema-scoped surface. */
export const SCOPE_NOTE = "Changes apply to all views showing this property.";

// ---------------------------------------------------------------- number ---

function numberPanel(args: EditPropertyArgs): MenuPanel {
  const config = args.config as NumberConfig;
  const showAs = config.show_as ?? "number";

  const formatRow: MenuRow = {
    id: "number-format",
    label: "Number format",
    value: numberFormatLabel(config.format),
    submenu: () => ({
      // Notion's own list is long enough to need its own search — the row
      // count is 39 here and 45 there, so the search is not optional chrome.
      search: { placeholder: "Filter formats…" },
      sections: [
        {
          rows: NUMBER_FORMATS.map(([value, label]) => ({
            id: value,
            label,
            checked: (config.format ?? "number") === value,
            onSelect: () => args.onPatchConfig({ format: value }),
          })),
        },
      ],
    }),
  };

  const decimalsRow: MenuRow = {
    id: "decimal-places",
    label: "Decimal places",
    value: config.decimal_places === null || config.decimal_places === undefined
      ? "Default"
      : String(config.decimal_places),
    submenu: () => ({
      sections: [
        {
          rows: [
            {
              id: "default",
              label: "Default",
              checked: config.decimal_places === null || config.decimal_places === undefined,
              // `null`, not absent: the PATCH has to CLEAR a previously set
              // value, and an omitted key would merge to a no-op.
              onSelect: () => args.onPatchConfig({ decimal_places: null }),
            },
            ...[0, 1, 2, 3, 4, 5].map((n) => ({
              id: String(n),
              label: String(n),
              checked: config.decimal_places === n,
              onSelect: () => args.onPatchConfig({ decimal_places: n }),
            })),
          ],
        },
      ],
    }),
  };

  return {
    // Measured at 299px in the capture; `md` (285px) is the token that fits,
    // and the point of it is the scope disclaimer sitting on one line.
    width: "md",
    sections: [
      {
        rows: [formatRow, decimalsRow],
        content: <ShowAsBlock config={config} showAs={showAs} onPatchConfig={args.onPatchConfig} />,
      },
    ],
  };
}

/** The `Show as` card triplet and the sub-form Bar/Ring reveal. Not rows —
 * three side-by-side cards, then a bordered block with a color picker, a
 * numeric `Divide by` and a `Show number` switch. */
function ShowAsBlock({
  config,
  showAs,
  onPatchConfig,
}: {
  config: NumberConfig;
  showAs: string;
  onPatchConfig: (patch: Record<string, unknown>) => void;
}) {
  // Notion pre-fills 100 the moment Bar or Ring is chosen. That default is the
  // UI's, not the stored config's, so it is applied here on selection rather
  // than as a model default.
  function selectShowAs(next: "number" | "bar" | "ring") {
    if (next === "number") {
      onPatchConfig({ show_as: "number" });
      return;
    }
    onPatchConfig({
      show_as: next,
      ...(config.divide_by === null || config.divide_by === undefined ? { divide_by: 100 } : {}),
    });
  }

  const cards: { id: "number" | "bar" | "ring"; label: string; preview: React.ReactNode }[] = [
    { id: "number", label: "Number", preview: <span className="text-sm tabular-nums">42</span> },
    {
      id: "bar",
      label: "Bar",
      preview: <span className={`block h-1 w-10 rounded-full ${barColorClass(config.bar_color)}`} />,
    },
    {
      id: "ring",
      label: "Ring",
      preview: (
        // Same helper the cell uses, so the preview cannot promise a ring the
        // column then renders as a pie.
        <span className="block h-4 w-4 rounded-full" style={ringStyle(0.7, config.bar_color)} />
      ),
    },
  ];

  return (
    <div className="px-2 pt-2">
      <div className="pb-1 text-menu-disabled">Show as</div>
      <div className="grid grid-cols-3 gap-1.5">
        {cards.map((card) => (
          <button
            key={card.id}
            type="button"
            // Named explicitly: the Number card's preview is the literal "42",
            // so without this its accessible name is "42 Number", and Bar's
            // and Ring's previews are decoration with no text at all.
            aria-label={card.label}
            aria-pressed={showAs === card.id}
            onClick={() => selectShowAs(card.id)}
            className={`flex h-12 flex-col items-center justify-center gap-1 rounded border ${
              showAs === card.id
                ? "border-brand text-brand"
                : "border-menu-divider text-menu-disabled hover:bg-menu-hover"
            }`}
          >
            <span aria-hidden>{card.preview}</span>
            <span aria-hidden className="text-[11px]">
              {card.label}
            </span>
          </button>
        ))}
      </div>

      {(showAs === "bar" || showAs === "ring") && (
        <div className="mt-2 rounded border border-menu-divider">
          <BarColorRow
            color={config.bar_color ?? "green"}
            onChange={(bar_color) => onPatchConfig({ bar_color })}
          />
          <label className="flex h-menu-row items-center justify-between gap-2 px-2">
            <span>Divide by</span>
            <input
              type="number"
              aria-label="Divide by"
              value={config.divide_by ?? ""}
              onChange={(e) =>
                onPatchConfig({
                  divide_by: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              // The menu owns arrows and Tab; this field owns them while it has
              // focus, or typing in it navigates the rows behind it.
              onKeyDown={(e) => e.stopPropagation()}
              className="w-16 rounded bg-menu-field px-1 text-right tabular-nums outline-none"
            />
          </label>
          <label className="flex h-menu-row items-center justify-between gap-2 px-2">
            <span>Show number</span>
            <input
              type="checkbox"
              aria-label="Show number"
              checked={config.show_number !== false}
              onChange={(e) => onPatchConfig({ show_number: e.target.checked })}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </label>
        </div>
      )}

      <div className="pt-2 text-menu-disabled">{SCOPE_NOTE}</div>
    </div>
  );
}

/** Notion's `Color` control inside the bar/ring block. Deliberately NOT a
 * native `<select>`: replacing the 40 native selects in this feature is the
 * whole point of this phase, and a native one here would also render the color
 * names without their swatches. Expands in place rather than opening a nested
 * popover — a popover inside a popover inside a flyout is three dismissal
 * layers deep, and Escape would become ambiguous. */
function BarColorRow({
  color,
  onChange,
}: {
  color: string;
  onChange: (color: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = BAR_COLORS.find(([value]) => value === color)?.[1] ?? "Green";

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-menu-row w-full items-center justify-between gap-2 px-2 hover:bg-menu-hover"
      >
        <span>Color</span>
        <span className="flex items-center gap-1.5 text-menu-disabled">
          <span className={`h-3 w-3 rounded-sm ${barColorClass(color)}`} />
          {label}
        </span>
      </button>
      {open && (
        <div role="listbox" aria-label="Bar color">
          {BAR_COLORS.map(([value, name]) => (
            <button
              key={value}
              type="button"
              role="option"
              aria-selected={value === color}
              onClick={() => {
                onChange(value);
                setOpen(false);
              }}
              className="flex h-menu-row w-full items-center gap-1.5 px-2 hover:bg-menu-hover"
            >
              <span className={`h-3 w-3 rounded-sm ${barColorClass(value)}`} />
              <span className="flex-1 text-left">{name}</span>
              {value === color && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------- select-likes ---

/** Option list sort. Sorts the OPTIONS, not the rows — distinct from the
 * header menu's own `Sort` row, which sorts the table. */
type OptionSort = "manual" | "alphabetical" | "reverse_alphabetical";

export function sortOptions(options: SelectOption[], sort: OptionSort): SelectOption[] {
  if (sort === "manual") return options;
  const sorted = [...options].sort((a, b) => a.name.localeCompare(b.name));
  return sort === "reverse_alphabetical" ? sorted.reverse() : sorted;
}

const OPTION_SORT_LABELS: Record<OptionSort, string> = {
  manual: "Manual",
  alphabetical: "Alphabetical",
  reverse_alphabetical: "Reverse alphabetical",
};

function selectPanel(args: EditPropertyArgs): MenuPanel {
  const options = (args.config.options as SelectOption[] | undefined) ?? [];
  const sort = (args.config.option_sort as OptionSort | undefined) ?? "manual";

  function writeOptions(next: SelectOption[]) {
    args.onPatchConfig({ options: next });
  }

  /** Ids are server-minted for options created through the API, but the option
   * editor mints locally so a new option is usable before the round-trip. The
   * shape (8 chars, base62-ish) matches `mint_key`'s, and the server does not
   * re-key an option that already has an id. */
  function mintId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  const sortRow: MenuRow = {
    id: "option-sort",
    label: "Sort",
    value: OPTION_SORT_LABELS[sort],
    submenu: () => ({
      sections: [
        {
          rows: (Object.keys(OPTION_SORT_LABELS) as OptionSort[]).map((key) => ({
            id: key,
            label: OPTION_SORT_LABELS[key],
            checked: sort === key,
            onSelect: () => {
              // Alphabetical sorts are APPLIED to the stored order, not kept as
              // a display-time flag — otherwise switching back to Manual would
              // silently restore an order the user last saw two edits ago.
              if (key === "manual") args.onPatchConfig({ option_sort: "manual" });
              else args.onPatchConfig({ option_sort: key, options: sortOptions(options, key) });
            },
          })),
        },
      ],
    }),
  };

  const optionRows: MenuRow[] = sortOptions(options, sort).map((option) => ({
    id: option.id,
    // Notion renders the option row AS the option's own pill — the same pill
    // the cell shows — rather than as a swatch beside plain text. `label` is
    // kept as the plain name so search and the accessible name still work.
    label: option.name,
    labelNode: (
      <span
        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${pillStyleForOption(
          option.name,
          options
        )}`}
      >
        {option.name}
      </span>
    ),
    submenu: () => optionEditorPanel(option, options, writeOptions),
  }));

  function addOption(group?: StatusGroup) {
    writeOptions([
      ...options,
      {
        id: mintId(),
        name: `Option ${options.length + 1}`,
        color: "default",
        ...(group ? { group } : {}),
      },
    ]);
  }

  // A status property's options are GROUPED. Flattening them into one
  // "Options" list would drop the only thing that distinguishes status from
  // select — and `group` is a real, persisted field on the backend's
  // StatusOption, so a flat editor could never set it and every option a user
  // created here would silently land in "To-do".
  if (args.type === "status") {
    return {
      sections: [
        { rows: [sortRow] },
        ...STATUS_GROUPS.map((group) => ({
          label: group,
          action: {
            label: <Plus size={14} />,
            aria: `Add an option to ${group}`,
            onSelect: () => addOption(group),
          },
          rows: optionRows.filter((row) => {
            const option = options.find((o) => o.id === row.id);
            return (option?.group ?? "To-do") === group;
          }),
        })),
      ],
    };
  }

  return {
    sections: [
      { rows: [sortRow] },
      {
        label: "Options",
        action: {
          label: <Plus size={14} />,
          aria: "Add an option",
          onSelect: () => addOption(),
        },
        rows: optionRows,
      },
    ],
  };
}

/** One option: rename, delete, recolor. Three levels deep from the column
 * header (header menu -> Edit property -> this), which the flyout host already
 * handles. */
function optionEditorPanel(
  option: SelectOption,
  all: SelectOption[],
  writeOptions: (next: SelectOption[]) => void
): MenuPanel {
  return {
    header: (
      <OptionRenameHeader
        option={option}
        onRename={(name) =>
          writeOptions(all.map((o) => (o.id === option.id ? { ...o, name } : o)))
        }
      />
    ),
    sections: [
      {
        rows: [
          {
            id: "delete",
            icon: <Trash2 size={14} />,
            label: "Delete",
            danger: true,
            // No confirm. Notion deletes an option outright, and unlike
            // deleting the whole property this loses one label, not every
            // row's value for the column.
            onSelect: () => writeOptions(all.filter((o) => o.id !== option.id)),
          },
        ],
      },
      {
        label: "Colors",
        rows: OPTION_COLORS.map(([value, label]) => ({
          id: value,
          icon: optionSwatch(value),
          label,
          checked: (option.color ?? "default") === value,
          onSelect: () =>
            writeOptions(all.map((o) => (o.id === option.id ? { ...o, color: value } : o))),
        })),
      },
    ],
  };
}

/** The option's name field. Autofocused with its text selected, exactly as
 * captured — the common case is renaming, not appending. */
export function OptionRenameHeader({
  option,
  onRename,
}: {
  option: SelectOption;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(option.name);
  return (
    <input
      autoFocus
      aria-label="Option name"
      value={name}
      onChange={(e) => setName(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => name.trim() && name !== option.name && onRename(name.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        // Same reason as ColumnRenameHeader: without stopping Tab, the menu
        // closes before blur can commit and the rename is silently lost.
        if (e.key.startsWith("Arrow") || e.key === "Tab") e.stopPropagation();
      }}
      className="h-menu-row w-full rounded bg-menu-field px-2 outline-none"
    />
  );
}

// ------------------------------------------------------------------ entry ---

export function editPropertyPanel(args: EditPropertyArgs): MenuPanel | null {
  switch (args.type) {
    case "number":
      return numberPanel(args);
    case "select":
    case "multi_select":
    case "status":
      return selectPanel(args);
    default:
      return null;
  }
}
