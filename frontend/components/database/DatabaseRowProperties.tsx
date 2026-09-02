"use client";

// RowPeek's deferred phase 2 (see RowPeek.tsx's own comment): makes
// `/brain/{noteId}` (the plain note page, `NoteEditorPage.tsx`) show a
// row's properties too, not just its body — the gap that made "Open as
// full page" a real, if smaller, downgrade from the peek. Self-contained
// (owns its own fetch/write), so `NoteEditorPage.tsx` needs only one new
// line rather than threading new state through an already-large,
// established file — mirrors how `NoteProperties.tsx` (the OLD notes.
// topics/mastery_status fields, unrelated to this feature) is already its
// own small component taking just a note id/note.
//
// Renders nothing at all for an ordinary, non-database note (`GET
// /api/db/notes/{noteId}/row` 404s) — the exact same silent, zero-diff
// degradation this codebase's other "optional relation/button props"
// components already use elsewhere, not a loading flash or an error state
// for the overwhelmingly common case.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useToast } from "@/app/providers";
import { renderCellValue } from "./cells/renderCellValue";
import type { PropertyResponse, PropertyValue } from "@/lib/database/types";

interface NoteRowInfo {
  data_source_id: string;
  database_id: string;
  database_title: string;
  properties: PropertyResponse[];
  values: Record<string, PropertyValue>;
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
    if (typeof body?.error === "string") return body.error;
  } catch {
    // body wasn't JSON (or was empty) — fall through to the generic message
  }
  return `Request failed (${res.status})`;
}

export interface DatabaseRowPropertiesProps {
  noteId: string;
}

export function DatabaseRowProperties({ noteId }: DatabaseRowPropertiesProps) {
  const { showToast } = useToast();
  const [rowInfo, setRowInfo] = useState<NoteRowInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/db/notes/${noteId}/row`)
      .then((res) => (res.ok ? res.json() : null))
      .then((info) => {
        if (!cancelled) setRowInfo(info);
      })
      .catch(() => {
        // Not a database row (or a transient failure) — render nothing,
        // same as a genuine 404. This is a read-only enhancement on top of
        // the note page, never worth an error state of its own.
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  if (!rowInfo) return null;

  // The title property is deliberately not rendered here — NoteEditorPage.tsx
  // already has its own title input at the top of the page, and this app's
  // title<->notes.title sync convention (services/db/rows.py) means editing
  // it there already keeps the row's title property in sync. A second,
  // separate title field here would be a real duplicate, not a convenience.
  const otherProperties = rowInfo.properties
    .filter((p) => p.type !== "title")
    .slice()
    .sort((a, b) => a.position - b.position);

  async function handleChange(property: PropertyResponse, value: PropertyValue | null) {
    if (!rowInfo) return;
    const previousValues = rowInfo.values;
    setRowInfo({ ...rowInfo, values: { ...rowInfo.values, [property.key]: value as PropertyValue } });

    try {
      const res = await fetch(`/api/db/data-sources/${rowInfo.data_source_id}/rows/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ property_key: property.key, value }),
      });
      if (!res.ok) throw new Error(await errorMessage(res));
    } catch (e) {
      setRowInfo({ ...rowInfo, values: previousValues });
      showToast(e instanceof Error ? e.message : "Could not save property", "error");
    }
  }

  return (
    <div className="mb-6 pb-4 border-b border-gray-100 dark:border-gray-800">
      <Link
        href={`/brain/db/${rowInfo.database_id}`}
        className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
      >
        {rowInfo.database_title}
      </Link>
      {otherProperties.length > 0 && (
        <div className="space-y-2 mt-2">
          {otherProperties.map((property) => (
            <div key={property.key} className="grid grid-cols-[120px_1fr] items-center gap-3 text-sm">
              <span className="text-gray-500 dark:text-gray-400 truncate">{property.name}</span>
              <div>
                {renderCellValue(property, rowInfo.values[property.key], true, (value) =>
                  handleChange(property, value)
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
