"use client";

// The heart of the primitive layer. Renders a MenuPanel; every menu-shaped
// surface in the database UI is one of these plus a host.
//
// Three things here came directly from capturing live Notion, and each would
// have been wrong if designed from memory (docs/ui-specs/raw-dom/):
//
//  1. SUBMENUS ARE FLYOUTS *OR* PUSH PANELS. Popover-hosted menus (column
//     header, row menu) open a second panel beside the parent with the parent
//     still visible; the docked config sidebar replaces its contents and shows
//     a back arrow. Both exist. `nav` picks one.
//  2. NESTING IS UNBOUNDED and each level flips independently — Calculate ->
//     Count -> the functions, where level three opens LEFTWARD for want of
//     room. Each submenu is therefore its own Radix Popover, so collision
//     handling is per level rather than computed once.
//  3. COLUMN COUNT IS PER-PANEL. The same property-type list is a 2-column
//     grid in "+ Add property" and a 1-column list in "Change type".
//
// KEYBOARD IS A DELIBERATE DEVIATION. Notion's column header menu has no
// arrow-key navigation at all — focus sits in the name field and the arrows
// move the text caret (verified with real key events). We implement arrow
// navigation on EVERY panel regardless: a 14-row menu that cannot be driven
// from the keyboard is an accessibility regression against the native <select>
// elements this work replaces. See docs/ui-specs/table-column-header.md.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Popover } from "./Popover";
import type { MenuNav, MenuPanel, MenuRow } from "./types";

export interface MenuListProps {
  root: MenuPanel;
  /** "flyout" for popover hosts, "push" for the docked config sidebar. */
  nav?: MenuNav;
  onClose: () => void;
  label?: string;
  /** Which side this panel's own flyouts open on.
   *
   * Normally left unset: a panel READS the side it was itself placed on (Radix
   * stamps `data-side` on the popover content) and hands that to its children,
   * so a chain that has flipped leftward keeps going leftward. Without this,
   * the third level bounces back rightward over the grandparent menu and hides
   * it — Notion's keeps travelling in one direction. */
  side?: "left" | "right";
  /** Renders a persistent × that always fully closes the host, regardless of
   * push depth — distinct from the back arrow's `pop`. Only the docked config
   * sidebar needs this (view-options-panel.md's ×): every popover-hosted menu
   * dismisses via outside-click/Esc on the Popover itself, so this defaults
   * to false and leaves every other surface's title row byte-for-byte
   * unchanged. */
  dismissible?: boolean;
}

interface FlatRow {
  row: MenuRow;
  index: number;
}

function matches(row: MenuRow, query: string): boolean {
  if (!query) return true;
  return row.label.toLowerCase().includes(query.toLowerCase());
}

/** Walks `root` through a path of row ids, calling each level's `submenu()`
 * fresh, so a pushed panel is always derived from LIVE data rather than a
 * snapshot frozen at push time. Stops early (shrinking the effective stack)
 * if a row along the path has vanished or lost its submenu — a host whose
 * data changed out from under an open path degrades to "as deep as still
 * makes sense" rather than throwing. */
function resolveStack(root: MenuPanel, ids: string[]): MenuPanel[] {
  const out: MenuPanel[] = [];
  let current = root;
  for (const id of ids) {
    const row = current.sections.flatMap((s) => s.rows).find((r) => r.id === id);
    if (!row?.submenu) break;
    current = row.submenu();
    out.push(current);
  }
  return out;
}

export function MenuList({ root, nav = "flyout", onClose, label, side, dismissible = false }: MenuListProps) {
  // `push` keeps a stack so the back arrow has somewhere to go. `flyout`
  // never pushes — its submenus are nested Popovers rendered by the row.
  //
  // State holds only the PATH of pushed row ids, never resolved MenuPanel
  // objects. The panels themselves are re-resolved from the LIVE `root` on
  // every render by walking that path (`resolveStack` below) — the same
  // "the base level always reads live root, never a snapshot" rule the
  // flyout side of this file already followed, extended to every pushed
  // level too.
  //
  // Storing resolved panels here first (i.e. calling `row.submenu()` once,
  // at push time, and keeping the result) was tried and is why this
  // exists: a live drag-reorder inside a pushed panel (M3's Property
  // visibility) wrote the new order through `onPatchConfig` — the HOST
  // re-rendered with fresh data and a fresh `root`, but the ALREADY-PUSHED
  // panel sitting in state was a frozen React element from the render that
  // pushed it, so it kept showing the pre-drag order until popped and
  // pushed again. Re-deriving from `root` by id every render is what makes
  // a pushed panel behave exactly like the base level: always current.
  const [stackIds, setStackIds] = useState<string[]>([]);
  const stack = useMemo(() => resolveStack(root, stackIds), [root, stackIds]);
  const panel = stack.length > 0 ? stack[stack.length - 1] : root;

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const baseId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // The side Radix actually placed THIS panel on, after its own collision
  // handling. Read from the DOM because it is only known post-placement — an
  // explicit `side` prop wins when a host has an opinion. Falls back to
  // "right", which is where a first-level flyout opens when there is room.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [placedSide, setPlacedSide] = useState<"left" | "right" | null>(null);
  useEffect(() => {
    const host = rootRef.current?.closest("[data-side]");
    if (!host) return;
    // MUST be observed, not read once. Radix stamps a provisional `data-side`
    // on mount and rewrites it after floating-ui measures — a single read on
    // mount catches the pre-flip value, which is how the third level ended up
    // bouncing back rightward over the header menu it had already flipped away
    // from. Only left/right matter here; a first-level flyout sits on "bottom".
    const read = () => {
      const attr = host.getAttribute("data-side");
      if (attr === "left" || attr === "right") setPlacedSide(attr);
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(host, { attributes: true, attributeFilter: ["data-side"] });
    return () => observer.disconnect();
  }, []);
  const childSide: "left" | "right" = side ?? placedSide ?? "right";

  const columns = panel.columns ?? 1;
  const canPop = nav === "push" && stack.length > 0;

  // Visible rows, flattened in DOM order, so arrow keys can walk them
  // regardless of section boundaries. Disabled rows stay in the list and are
  // skipped when moving — they are semantic (an illegal type conversion), not
  // absent, so they must remain visible and announced.
  const sections = useMemo(
    () =>
      panel.sections.map((section) => {
        const filtered =
          section.searchable === false ? section.rows : section.rows.filter((r) => matches(r, query));
        return { ...section, rows: filtered };
      }),
    [panel, query]
  );

  const flat = useMemo(() => {
    const out: FlatRow[] = [];
    let i = 0;
    for (const section of sections) for (const row of section.rows) out.push({ row, index: i++ });
    return out;
  }, [sections]);

  const move = useCallback(
    (delta: number) => {
      if (flat.length === 0) return;
      let next = active;
      for (let guard = 0; guard < flat.length; guard++) {
        next = (next + delta + flat.length) % flat.length;
        if (!flat[next].row.disabled) break;
      }
      setActive(next);
    },
    [active, flat]
  );

  const activate = useCallback(
    (row: MenuRow) => {
      if (row.disabled) return;
      if (row.submenu && nav === "push") {
        setStackIds((ids) => [...ids, row.id]);
        setQuery("");
        setActive(0);
        return;
      }
      row.onSelect?.();
      // A toggle keeps the panel open — you often flip several in a row
      // ("Show vertical lines", "Show page icon", "Wrap all content").
      if (row.kind !== "toggle" && !row.submenu) onClose();
    },
    [nav, onClose]
  );

  const pop = useCallback(() => {
    setStackIds((ids) => (ids.length > 0 ? ids.slice(0, -1) : ids));
    setQuery("");
    setActive(0);
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    const current = flat[active]?.row;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(columns);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-columns);
        break;
      case "ArrowRight":
        if (columns > 1) {
          e.preventDefault();
          move(1);
        } else if (current?.submenu && nav === "push") {
          e.preventDefault();
          activate(current);
        }
        break;
      case "ArrowLeft":
        if (columns > 1) {
          e.preventDefault();
          move(-1);
        } else if (canPop) {
          e.preventDefault();
          pop();
        }
        break;
      case "Enter":
        if (current) {
          e.preventDefault();
          activate(current);
        }
        break;
      case "Escape":
        e.preventDefault();
        // Esc pops one level before closing, so a nested panel does not throw
        // away the whole menu.
        if (canPop) pop();
        else onClose();
        break;
      case "Tab":
        onClose();
        break;
      default:
        break;
    }
  }

  // "No results" keys off the SEARCHABLE sections only. A section exempt from
  // search (Notion's "AI Autofill" stays put while "Select type" filters) is
  // still on screen, so reporting "no results" because only it survived would
  // be a lie — but reporting nothing when the searched section is empty is
  // worse. So: query present, and every searchable section came back empty.
  const noSearchResults =
    query.trim().length > 0 &&
    sections.filter((sec) => sec.searchable !== false).every((sec) => sec.rows.length === 0);

  const activeId = flat[active] ? `${baseId}-row-${flat[active].index}` : undefined;
  const listboxId = `${baseId}-listbox`;

  return (
    <div ref={rootRef} className="py-1 text-menu text-menu-fg" onKeyDown={onKeyDown} data-testid="menu-list">
      {dismissible ? (
        (panel.title || canPop || panel.header) && (
          <div className="flex items-center gap-1 px-2 pb-1">
            {canPop && (
              <button
                type="button"
                aria-label="Back"
                onClick={pop}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-menu-hover"
              >
                ←
              </button>
            )}
            {panel.title && <span className="flex-1 truncate font-medium">{panel.title}</span>}
            {panel.header && <div className="min-w-0 flex-1">{panel.header}</div>}
            {!panel.title && !panel.header && <span className="flex-1" />}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-menu-disabled hover:bg-menu-hover hover:text-menu-fg"
            >
              ×
            </button>
          </div>
        )
      ) : (
        <>
          {(panel.title || canPop) && (
            <div className="flex items-center gap-1 px-2 pb-1">
              {canPop && (
                <button
                  type="button"
                  aria-label="Back"
                  onClick={pop}
                  className="flex h-5 w-5 items-center justify-center rounded hover:bg-menu-hover"
                >
                  ←
                </button>
              )}
              {panel.title && <span className="font-medium">{panel.title}</span>}
            </div>
          )}

          {panel.header && <div className="px-2 pb-1">{panel.header}</div>}
        </>
      )}

      {panel.search && (
        <div className="px-2 pb-1">
          <input
            ref={searchRef}
            autoFocus={panel.search.autoFocus !== false}
            role="combobox"
            aria-expanded
            aria-controls={listboxId}
            aria-activedescendant={activeId}
            aria-label={panel.search.placeholder}
            placeholder={panel.search.placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="h-menu-row w-full rounded bg-menu-field px-2 text-menu outline-none placeholder:text-menu-disabled"
          />
        </div>
      )}

      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label={label ?? panel.title}
        aria-activedescendant={panel.search ? undefined : activeId}
        tabIndex={panel.search ? -1 : 0}
        className="outline-none"
      >
        {sections.map((section, si) => (
          <div key={section.label ?? si}>
            {si > 0 && <div role="separator" className="my-1 h-px bg-menu-divider" />}
            {(section.label || section.action) && (
              <div className="flex items-center justify-between px-2 py-1 text-menu-disabled">
                {section.label && <span>{section.label}</span>}
                {section.action && (
                  <button
                    type="button"
                    aria-label={section.action.aria}
                    onClick={section.action.onSelect}
                    className="hover:text-menu-fg"
                  >
                    {section.action.label}
                  </button>
                )}
              </div>
            )}
            <div className={columns === 2 ? "grid grid-cols-2" : ""}>
              {section.rows.map((row) => {
                const flatIndex = flat.find((f) => f.row === row)?.index ?? -1;
                return (
                  <Row
                    key={row.id}
                    row={row}
                    id={`${baseId}-row-${flatIndex}`}
                    isActive={flatIndex === active}
                    nav={nav}
                    onActivate={() => activate(row)}
                    onHover={() => flatIndex >= 0 && !row.disabled && setActive(flatIndex)}
                    onClose={onClose}
                    side={childSide}
                  />
                );
              })}
            </div>
            {section.content}
          </div>
        ))}
        {noSearchResults && (
          <div className="px-2 py-2 text-menu-disabled">No results</div>
        )}
      </div>

      {panel.footer && (
        <>
          <div role="separator" className="my-1 h-px bg-menu-divider" />
          <div className="px-2 py-1 text-menu-disabled">{panel.footer}</div>
        </>
      )}
    </div>
  );
}

interface RowProps {
  row: MenuRow;
  id: string;
  isActive: boolean;
  nav: MenuNav;
  onActivate: () => void;
  onHover: () => void;
  onClose: () => void;
  /** Which side this row's flyout opens on — inherited from the panel so a
   * chain that flipped leftward keeps going leftward. */
  side: "left" | "right";
}

function Row({ row, id, isActive, nav, onActivate, onHover, onClose, side }: RowProps) {
  const body = (
    <div
      id={id}
      role="option"
      aria-selected={isActive}
      aria-disabled={row.disabled || undefined}
      title={row.disabled ? row.disabledReason : undefined}
      onMouseEnter={onHover}
      onClick={onActivate}
      // min-h, not h: rows carrying a description are taller than the 28px base.
      className={[
        "flex min-h-menu-row cursor-pointer select-none items-center gap-2 px-2",
        isActive && !row.disabled ? "bg-menu-hover" : "",
        row.disabled ? "cursor-default text-menu-disabled" : "",
        row.danger && !row.disabled ? "text-red-500" : "",
      ].join(" ")}
    >
      {/* The box is ALWAYS reserved, even when the row has no icon. Rendering
        * it conditionally let icon-less rows pull their labels left, giving
        * the menu a ragged left edge — the single most visible parity break in
        * M1's first visual diff. */}
      <span className="flex w-menu-icon shrink-0 items-center justify-center">{row.icon}</span>
      <span className="flex min-w-0 flex-col py-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate">{row.labelNode ?? row.label}</span>
          {row.badge && (
            <span className="shrink-0 rounded bg-menu-badge px-1 text-[11px]">{row.badge}</span>
          )}
        </span>
        {row.description && (
          <span className="text-[12px] text-menu-disabled">{row.description}</span>
        )}
        {row.annotation && (
          <span
            role={row.annotation.onSelect ? "button" : undefined}
            onClick={
              row.annotation.onSelect
                ? (e) => {
                    e.stopPropagation();
                    row.annotation!.onSelect!();
                  }
                : undefined
            }
            className="text-[12px] text-brand hover:underline"
          >
            {row.annotation.label}
          </span>
        )}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-menu-disabled">
        {row.value && <span>{row.value}</span>}
        {row.hint && <span>{row.hint}</span>}
        {row.kind === "toggle" && (
          <span
            role="switch"
            aria-checked={Boolean(row.checked)}
            aria-label={row.label}
            className={`h-3.5 w-6 rounded-full ${row.checked ? "bg-brand" : "bg-menu-divider"}`}
          />
        )}
        {row.kind !== "toggle" && row.checked && <span aria-hidden>✓</span>}
        {row.submenu && <span aria-hidden>›</span>}
      </span>
    </div>
  );

  // In flyout mode a submenu row is itself a Popover trigger, so every level
  // gets its own collision handling — which is what makes a third level able
  // to flip leftward independently of its parent.
  if (row.submenu && nav === "flyout" && !row.disabled) {
    // Built once and reused, rather than called twice — `submenu()` is a pure
    // builder, but reading `width` off a second invocation would silently
    // double the work on every render of every row that has one.
    const submenu = row.submenu();
    return (
      <Popover
        trigger={body}
        side={side}
        align="start"
        sideOffset={2}
        width={submenu.width ?? "sm"}
        label={row.label}
      >
        {/* The child is NOT given `side` — it reads the side Radix actually
          * placed it on. Forcing the parent's side down would keep telling a
          * panel that itself had to flip back the other way to go on opening
          * its own children in the impossible direction. */}
        <MenuList root={submenu} nav="flyout" onClose={onClose} label={row.label} />
      </Popover>
    );
  }

  return body;
}
