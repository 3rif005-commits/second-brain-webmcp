"use client";

// spec §7.1: the frontend gets NO evaluator, only this debounced call to
// `POST .../formulas/validate` — deliberately minimal (task-28-brief.md
// §4): a plain textarea, an error list with positions, and the inferred
// result type. No syntax highlighting, no autocomplete — both flagged as
// not-built rather than half-building either one.
//
// Fetches through `/api/db/...` (this app's own proxy — see
// `app/api/db/[...path]/route.ts`), never `FASTAPI_URL` directly, matching
// every other data call in `lib/database/useDatabaseView.ts`.
import { useEffect, useRef, useState } from "react";
import type { FormulaValidateResponse } from "@/lib/database/types";

const DEFAULT_DEBOUNCE_MS = 400;

/** Same best-effort message extraction `useDatabaseView.ts`'s own
 * `errorMessage` uses — duplicated per this codebase's established
 * per-file-helper convention (see e.g. `test_db_computed_query.py`'s
 * docstring on the backend side for the same convention). */
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

export interface FormulaEditorProps {
  dataSourceId: string;
  expression: string;
  onExpressionChange: (expression: string) => void;
  /** Fires with the latest validate response every time one lands, and with
   * `null` whenever there is no current result to trust (the textarea is
   * empty, or the in-flight request failed at the network level — a
   * malformed FORMULA is still a real result, `valid: false`, not `null`).
   * Lets a caller (e.g. a future property-save form) read the inferred
   * result type or referenced properties without this component owning a
   * "Save" button itself — spec §7.1/research §1.9 both treat "does it
   * validate" and "can it be saved" as separate questions. */
  onValidated?: (result: FormulaValidateResponse | null) => void;
  debounceMs?: number;
  /** Textarea id, for an external `<label htmlFor>`. */
  id?: string;
}

export function FormulaEditor({
  dataSourceId,
  expression,
  onExpressionChange,
  onValidated,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  id,
}: FormulaEditorProps) {
  const [result, setResult] = useState<FormulaValidateResponse | null>(null);
  const [validating, setValidating] = useState(false);
  const [networkError, setNetworkError] = useState<string | null>(null);
  // Guards a stale keystroke's response landing AFTER a newer one already
  // did — only the response matching the most recently issued request is
  // ever applied to state.
  const requestIdRef = useRef(0);

  useEffect(() => {
    const trimmed = expression.trim();
    if (trimmed === "") {
      requestIdRef.current += 1; // invalidate any request already in flight
      setResult(null);
      setValidating(false);
      setNetworkError(null);
      onValidated?.(null);
      return;
    }

    const thisRequestId = ++requestIdRef.current;
    setValidating(true);
    const timer = setTimeout(() => {
      fetch(`/api/db/data-sources/${dataSourceId}/formulas/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expression }),
      })
        .then(async (res) => {
          if (thisRequestId !== requestIdRef.current) return; // superseded
          if (!res.ok) {
            setNetworkError(await errorMessage(res));
            setResult(null);
            onValidated?.(null);
            return;
          }
          const body: FormulaValidateResponse = await res.json();
          setNetworkError(null);
          setResult(body);
          onValidated?.(body);
        })
        .catch((e: unknown) => {
          if (thisRequestId !== requestIdRef.current) return;
          setNetworkError(e instanceof Error ? e.message : "Could not validate formula");
          setResult(null);
          onValidated?.(null);
        })
        .finally(() => {
          if (thisRequestId === requestIdRef.current) setValidating(false);
        });
    }, debounceMs);

    // Debounce: a keystroke before `debounceMs` elapses cancels this timer
    // (the effect's own cleanup) before it ever fires a request — only the
    // last keystroke in a burst actually calls the backend.
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expression, dataSourceId, debounceMs]);

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        id={id}
        aria-label="Formula expression"
        value={expression}
        onChange={(e) => onExpressionChange(e.target.value)}
        rows={4}
        spellCheck={false}
        placeholder='prop("Price") * 2'
        className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-2 py-1.5 font-mono text-sm outline-none focus:border-indigo-400 dark:focus:border-indigo-500"
      />
      <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
        {validating && <span>Checking…</span>}
        {!validating && result?.valid && (
          <span className="text-green-600 dark:text-green-400">
            Valid{result.result_type ? ` — ${result.result_type}` : ""}
          </span>
        )}
        {!validating && result && !result.valid && (
          <span className="text-amber-600 dark:text-amber-400">
            {result.errors.length} {result.errors.length === 1 ? "error" : "errors"}
          </span>
        )}
        {networkError && <span className="text-red-600 dark:text-red-400">{networkError}</span>}
      </div>
      {result && result.errors.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-red-600 dark:text-red-400">
          {result.errors.map((err, i) => (
            <li key={i}>
              Line {err.line}, col {err.col}: {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
