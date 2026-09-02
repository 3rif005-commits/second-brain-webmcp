"use client";

// M8's page-level `⋯` menu (database-header.md). Scoped down from the
// captured 15-row menu: most of its rows already have an equivalent home
// elsewhere in this app (Export -> DatabaseSettingsMenu's own "Export CSV",
// Merge with CSV -> Sidebar's CSV import, Lock database was already wired
// in M3's view settings sidebar) or are flagged out of scope in the spec
// itself (Move to — no page tree; Updates & analytics/Version history/
// Notify me/Connections — explicitly out of scope). Duplicating all of that
// into a second menu here would be a second copy to drift, not new
// capability — this menu only owns what is genuinely new: Copy link,
// Lock database (same PATCH `is_locked` ViewSettingsSidebar already
// toggles — reused, not duplicated), and Move to Trash (needs B2's DELETE,
// which had nowhere to live before this milestone).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Lock, MoreHorizontal, Trash2 } from "lucide-react";
import { useToast } from "@/app/providers";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { MenuList, Popover } from "@/components/ui/primitives";
import type { MenuPanel } from "@/components/ui/primitives";

export interface DatabasePageMenuProps {
  databaseId: string;
  databaseTitle: string;
  isLocked: boolean;
  onToggleLocked: () => Promise<unknown>;
  onDelete: () => Promise<void>;
}

export function DatabasePageMenu({ databaseId, databaseTitle, isLocked, onToggleLocked, onDelete }: DatabasePageMenuProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/brain/db/${databaseId}`);
      showToast("Link copied to clipboard", "info");
    } catch {
      showToast("Could not copy the link", "error");
    }
  }

  async function confirmDelete() {
    setConfirmingDelete(false);
    try {
      await onDelete();
      router.push("/brain");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not move the database to Trash", "error");
    }
  }

  const panel: MenuPanel = {
    sections: [
      {
        rows: [
          { id: "copy-link", icon: <Copy size={14} />, label: "Copy link", onSelect: copyLink },
          {
            id: "lock",
            icon: <Lock size={14} />,
            label: "Lock database",
            kind: "toggle",
            checked: isLocked,
            onSelect: () => onToggleLocked().catch((e) => showToast(e instanceof Error ? e.message : "Could not update the lock", "error")),
          },
        ],
      },
      {
        rows: [
          {
            id: "trash",
            icon: <Trash2 size={14} />,
            label: "Move to Trash",
            danger: true,
            onSelect: () => {
              setOpen(false);
              setConfirmingDelete(true);
            },
          },
        ],
      },
    ],
  };

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        width="sm"
        label="Database options"
        trigger={
          <button
            type="button"
            aria-label="Database options"
            aria-haspopup="menu"
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <MoreHorizontal size={16} />
          </button>
        }
      >
        <MenuList root={panel} nav="flyout" onClose={() => setOpen(false)} label="Database options" />
      </Popover>

      <ConfirmDialog
        open={confirmingDelete}
        title={`Move "${databaseTitle}" to Trash?`}
        description="The database, its properties and views will be trashed. Its rows are unaffected — they have their own Trash."
        confirmLabel="Move to Trash"
        onConfirm={confirmDelete}
        onCancel={() => setConfirmingDelete(false)}
      />
    </>
  );
}
