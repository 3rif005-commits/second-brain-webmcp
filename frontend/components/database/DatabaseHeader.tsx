"use client";

// M8 — database creation, title, icon, description (database-header.md).
//
// SCOPED DOWN FROM THE FULL CAPTURE, deliberately, and noted here rather
// than silently:
//  - The creation flow (a full-viewport data-source-picker modal with LIVE
//    mini-previews of existing sources) is NOT built. The spec itself flags
//    the previews as "a real build cost, flag before committing" — Sidebar's
//    existing "New Database" already creates an empty database and
//    navigates, which is the one card ("Empty database") that matters
//    functionally; the picker chrome around it is presentation, not new
//    capability.
//  - Cover is deferred entirely (spec's own call: no upload pipeline).
//  - The page-level `⋯` menu is DatabasePageMenu.tsx, scoped down for the
//    same "most rows already have a home elsewhere" reason — see its own
//    comment.
//
// What IS built: a database can be renamed, iconed and described for the
// first time ever (Phase 0b's B2 had nowhere to be called from before this).
import { useState } from "react";
import { useToast } from "@/app/providers";
import { HoverAffordance, IconPicker, Popover, randomEmoji } from "@/components/ui/primitives";
import type { DatabaseResponse, DataSourceResponse } from "@/lib/database/types";
import { DatabasePageMenu } from "./DatabasePageMenu";

/** `DatabaseResponse.description` is JSONB rich text (`list[Any]`), with no
 * shown/hidden flag of its own (database-header.md's own TBD). Nothing else
 * in this codebase reads or writes this field yet, so this picks the
 * simplest internally-consistent shape — one plain-text block — rather than
 * modelling real rich text no editor here produces. */
function descriptionText(description: unknown[]): string {
  const first = description[0];
  return first && typeof first === "object" && "text" in (first as Record<string, unknown>)
    ? String((first as Record<string, unknown>).text ?? "")
    : "";
}
function toDescription(text: string): unknown[] {
  return text ? [{ text }] : [];
}

export interface DatabaseHeaderProps {
  database: DatabaseResponse;
  dataSource: DataSourceResponse;
  editable: boolean;
  onUpdate: (patch: Partial<Pick<DatabaseResponse, "title" | "icon" | "description" | "is_locked">>) => Promise<unknown>;
  onDelete: () => Promise<void>;
  /** DatabaseShell's existing gear-icon DatabaseSettingsMenu — rendered
   * alongside DatabasePageMenu in the same right-aligned slot, same
   * `trailing` pattern ViewTabs.tsx already uses for its own toolbar. */
  trailing?: React.ReactNode;
}

export function DatabaseHeader({ database, dataSource, editable, onUpdate, onDelete, trailing }: DatabaseHeaderProps) {
  const { showToast } = useToast();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(database.title);
  const [describing, setDescribing] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState(() => descriptionText(database.description));

  const hasDescription = descriptionText(database.description).length > 0;
  // Can rename/icon/describe an ORDINARY database; All Notes has no
  // `db_databases` row at all to PATCH — hidden, not disabled, matching
  // DatabaseShell.tsx:400's own established rule for this exact source.
  const canEditHeader = editable && !dataSource.is_virtual;

  async function addIcon() {
    try {
      await onUpdate({ icon: randomEmoji() });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not set the icon", "error");
    }
  }
  async function pickIcon(emoji: string) {
    try {
      await onUpdate({ icon: emoji });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not set the icon", "error");
    }
  }
  async function removeIcon() {
    setIconPickerOpen(false);
    try {
      await onUpdate({ icon: null });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not remove the icon", "error");
    }
  }
  async function commitTitle() {
    const trimmed = titleDraft.trim();
    if (!trimmed) {
      setTitleDraft(database.title);
      return;
    }
    if (trimmed === database.title) return;
    try {
      await onUpdate({ title: trimmed });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not rename the database", "error");
      setTitleDraft(database.title);
    }
  }
  async function commitDescription() {
    if (descriptionDraft === descriptionText(database.description)) return;
    try {
      await onUpdate({ description: toDescription(descriptionDraft) });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not save the description", "error");
    }
  }

  // ONE Popover, rendered at exactly one location depending on whether an
  // icon exists yet — never both. Two separate `<Popover>` elements sharing
  // one `open` boolean would each independently mount their own Content
  // when true, showing two pickers at once; a single shared JSX value
  // placed at one of two possible spots avoids that outright rather than
  // needing to coordinate two Radix roots.
  const iconPopover = (
    <Popover
      open={iconPickerOpen}
      onOpenChange={setIconPickerOpen}
      label="Database icon"
      trigger={
        database.icon ? (
          <button type="button" aria-label="Change icon" className="text-lg leading-none">
            {database.icon}
          </button>
        ) : (
          <button type="button" onClick={addIcon} className="hover:text-gray-600 dark:hover:text-gray-300">
            Add icon
          </button>
        )
      }
    >
      <IconPicker value={database.icon} onPick={pickIcon} onRemove={database.icon ? removeIcon : undefined} />
    </Popover>
  );

  return (
    <div className="group">
      {canEditHeader && (
        // Reserved space, opacity-toggled — must not shift the title below
        // it when it appears (same rule as row-affordances.md's gutter).
        // Only carries the icon trigger while there's NO icon yet — once
        // one exists, the icon rendered beside the title (below) is itself
        // the trigger to reopen the picker (database-header.md's own
        // States table: "Icon set... hovering it reopens the picker").
        <HoverAffordance className="mb-1 flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
          {!database.icon && iconPopover}
          <button
            type="button"
            onClick={() => setDescribing((d) => !d)}
            className="hover:text-gray-600 dark:hover:text-gray-300"
          >
            {describing || hasDescription ? "Hide description" : "Add description"}
          </button>
        </HoverAffordance>
      )}

      <div className="flex items-center gap-2">
        {database.icon && (canEditHeader ? iconPopover : <span className="text-lg leading-none">{database.icon}</span>)}

        {canEditHeader ? (
          <input
            aria-label="Database title"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setTitleDraft(database.title);
            }}
            placeholder="New database"
            className="min-w-0 flex-1 rounded px-1 -mx-1 text-base font-semibold text-gray-900 outline-none hover:bg-gray-50 focus:bg-gray-50 dark:text-gray-100 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
          />
        ) : (
          <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">{database.title}</h1>
        )}

        {dataSource.is_virtual && (
          <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
            Read only
          </span>
        )}

        {(canEditHeader || trailing) && (
          <div className="ml-auto flex items-center gap-1">
            {canEditHeader && (
              <DatabasePageMenu
                databaseId={database.id}
                databaseTitle={database.title}
                isLocked={database.is_locked}
                onToggleLocked={() => onUpdate({ is_locked: !database.is_locked })}
                onDelete={onDelete}
              />
            )}
            {trailing}
          </div>
        )}
      </div>

      {canEditHeader && (describing || hasDescription) && (
        <input
          aria-label="Database description"
          value={descriptionDraft}
          onChange={(e) => setDescriptionDraft(e.target.value)}
          onBlur={commitDescription}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="Add a description…"
          className="mt-1 w-full rounded px-1 -mx-1 text-sm text-gray-600 outline-none hover:bg-gray-50 focus:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800 dark:focus:bg-gray-800"
        />
      )}
    </div>
  );
}
