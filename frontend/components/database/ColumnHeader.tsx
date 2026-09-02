"use client";

// The table column header cell — M1's trigger.
//
// A plain LEFT-CLICK anywhere on the cell opens the menu; so does a
// RIGHT-CLICK. There is no separate chevron and none appears on hover, and
// right-click is not a different menu — Notion has no bespoke context menus in
// a database table at all (docs/ui-specs/raw-dom/new-button-and-context-menus.txt).
import { useState } from "react";
import { useToast } from "@/app/providers";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { PropertyResponse, ViewResponse } from "@/lib/database/types";
import { patchInsertedNear } from "@/lib/database/viewConfig";
import type { SortsUpdater } from "@/lib/database/viewConfig";
import {
  ColumnRenameHeader,
  buildColumnHeaderMenu,
  propertyTypeIcon,
} from "./ColumnHeaderMenu";
import type { GroupByUpdater } from "./GroupBuilder";

async function errorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  return body?.detail || body?.error || `Request failed (${res.status})`;
}

export interface ColumnHeaderProps {
  property: PropertyResponse;
  properties: PropertyResponse[];
  dataSourceId: string;
  view: ViewResponse | null;
  /** Receives a PATCH (only the changed keys), which DatabaseShell merges
   * onto the freshest known config through its serialised queue. */
  onPatchConfig: (patch: Record<string, unknown>) => void;
  onSetSorts: (updater: SortsUpdater) => void;
  onPropertiesChanged: () => void | Promise<void>;
  /** M4 supplies this; until then the Filter row is disabled with a reason. */
  onFilter?: () => void;
  /** The "Group" row's own updater-based write — see `GroupByUpdater`'s own
   * doc comment (GroupBuilder.tsx). Optional on the same "degrade gracefully"
   * convention as `onFilter`: omitted, the row still fires (it was always a
   * plain replace, not a merge) but falls back to `onPatchConfig` instead. */
  onSetGroupBy?: (updater: GroupByUpdater) => void;
}

export function ColumnHeader({
  property,
  properties,
  dataSourceId,
  view,
  onPatchConfig,
  onSetSorts,
  onPropertiesChanged,
  onFilter,
  onSetGroupBy,
}: ColumnHeaderProps) {
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const config = view?.config ?? {};

  async function patchProperty(patch: Record<string, unknown>) {
    try {
      const res = await fetch(`/api/db/properties/${property.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await onPropertiesChanged();
    } catch (e) {
      // A refused type conversion arrives here with the server's own reason,
      // which is the message the user needs — do not replace it.
      showToast(e instanceof Error ? e.message : "Could not update the property", "error");
    }
  }

  async function insertProperty(side: "left" | "right") {
    try {
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/properties`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Property", type: "rich_text" }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      const created: PropertyResponse = await res.json();
      // Order is PER VIEW, so placement is a view-config write, not a schema
      // `position` write — the same property can sit third in one view and be
      // hidden in another.
      onPatchConfig(
        patchInsertedNear(config, [...properties, created], created.key, property.key, side)
      );
      await onPropertiesChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not add the property", "error");
    }
  }

  async function duplicateProperty() {
    try {
      const res = await fetch(`/api/db/data-sources/${dataSourceId}/properties`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${property.name} (1)`,
          type: property.type,
          config: property.config,
        }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
      await onPropertiesChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not duplicate the property", "error");
    }
  }

  async function deleteProperty() {
    setConfirmingDelete(false);
    try {
      const res = await fetch(`/api/db/properties/${property.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await errorMessage(res));
      await onPropertiesChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete the property", "error");
    }
  }

  const panel = buildColumnHeaderMenu({
    property,
    properties,
    view,
    config,
    onPatchConfig,
    onSetSorts,
    onChangeType: (targetType) => patchProperty({ type: targetType }),
    // `config` is merged server-side, so only the changed keys go over the
    // wire — the same patch-not-whole-object rule the view-config queue uses.
    onPatchPropertyConfig: (patch) =>
      patchProperty({ config: { ...(property.config ?? {}), ...patch } }),
    onInsert: insertProperty,
    onDuplicate: duplicateProperty,
    onDelete: () => setConfirmingDelete(true),
    onFilter,
    onSetGroupBy,
    renameHeader: (
      <ColumnRenameHeader
        property={property}
        onRename={(name) => patchProperty({ name })}
        onDescribe={(description) => patchProperty({ description })}
      />
    ),
  });

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        width="sm"
        label={`${property.name} column options`}
        trigger={
          <button
            type="button"
            aria-label={`${property.name} column options`}
            aria-haspopup="menu"
            onContextMenu={(e) => {
              // Right-click opens the SAME menu. Not a separate surface.
              e.preventDefault();
              setOpen(true);
            }}
            className="flex w-full items-center gap-1.5 px-1 py-1 text-left font-medium text-gray-500 hover:bg-menu-hover dark:text-gray-400"
          >
            <span className="flex w-menu-icon shrink-0 items-center justify-center">
              {propertyTypeIcon(property.type)}
            </span>
            <span className="truncate">{property.name}</span>
          </button>
        }
      >
        <MenuList root={panel} nav="flyout" onClose={() => setOpen(false)} />
      </Popover>

      {/* Deleting a property destroys every row's value for it and there is no
        * trash for properties, so this confirms — unlike the reversible rows
        * above it. No native dialog: those freeze the tab. */}
      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete "${property.name}"?`}
        description="Every row's value for this property will be removed. This cannot be undone."
        confirmLabel="Delete property"
        onConfirm={deleteProperty}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
  );
}
