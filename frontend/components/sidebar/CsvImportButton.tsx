"use client";

// Milestone 14 (task-47): "Import → CSV" — always creates a BRAND NEW database from the
// uploaded file (research §7.1). Placed as a sibling action next to "New Database" in
// Sidebar.tsx, NOT inside DatabaseSettingsMenu.tsx — that menu is scoped to an
// ALREADY-OPEN database's own per-column settings, whereas this creates a brand-new one.
//
// "Merge with CSV" onto an EXISTING database's existing properties is explicitly out of
// scope for this task (see routers/db_import.py's module docstring) — this button only
// ever calls POST /api/db/import/csv, never anything data-source-scoped.
//
// A plain native `<input type="file" accept=".csv">` (a real OS file picker, not a
// window.confirm/alert-style native dialog) — same FormData-upload-via-fetch pattern as
// components/ingestion/IngestStreamDialog.tsx. On success, the per-column inference
// report is shown as a simple in-page list (no native dialog either) before routing to
// the new database; on failure, `showToast` matches every other error-handling call site
// in components/database/.
import { useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { useToast } from "@/app/providers";

interface ColumnImportReport {
  header: string;
  inferred_type: string;
  non_empty_count: number;
  empty_count: number;
}

interface CsvImportResponse {
  database_id: string;
  row_count: number;
  columns: ColumnImportReport[];
}

interface CsvImportButtonProps {
  /** Called right after a successful import, e.g. Sidebar's `loadDatabases` — so the new
   * database appears in the sidebar list the moment its report is dismissed, matching
   * `handleNewDatabase`'s existing "refresh then navigate" convention. */
  onImported?: () => void;
}

export function CsvImportButton({ onImported }: CsvImportButtonProps) {
  const router = useRouter();
  const { showToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [report, setReport] = useState<CsvImportResponse | null>(null);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input's value so selecting the SAME file twice in a row still fires
    // onChange the second time (browsers otherwise treat it as a no-op change).
    e.target.value = "";
    if (!file) return;

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("database_title", file.name.replace(/\.csv$/i, ""));

      const res = await fetch("/api/db/import/csv", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.error || `Request failed (${res.status})`);
      }
      const data: CsvImportResponse = await res.json();
      setReport(data);
      onImported?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not import CSV", "error");
    } finally {
      setUploading(false);
    }
  }

  function handleOpenDatabase() {
    if (!report) return;
    const databaseId = report.database_id;
    setReport(null);
    router.push(`/brain/db/${databaseId}`);
  }

  return (
    <>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-all disabled:opacity-50"
      >
        <Upload size={15} strokeWidth={2} />
        {uploading ? "Importing CSV…" : "Import CSV"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        onChange={handleFileChange}
        className="hidden"
        aria-label="Import CSV"
      />

      {report && (
        <div
          role="dialog"
          aria-label="CSV import summary"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-4 w-full max-w-sm max-h-[70vh] overflow-y-auto">
            <h2 className="text-sm font-semibold text-white mb-1">
              Imported {report.row_count} row{report.row_count === 1 ? "" : "s"}
            </h2>
            <p className="text-xs text-slate-500 mb-3">Here&apos;s what each column became:</p>
            <ul className="space-y-1.5 mb-4">
              {report.columns.map((col) => (
                <li key={col.header} className="text-xs flex items-center justify-between gap-2">
                  <span className="truncate text-slate-300">{col.header}</span>
                  <span className="text-slate-500 shrink-0">
                    {col.inferred_type} &middot; {col.non_empty_count} filled, {col.empty_count} empty
                  </span>
                </li>
              ))}
            </ul>
            <button
              onClick={handleOpenDatabase}
              className="w-full px-3 py-1.5 text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
            >
              Open database
            </button>
          </div>
        </div>
      )}
    </>
  );
}
