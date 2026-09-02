"use client";

// Form view (Milestone 13, task-44) — the AUTHENTICATED owner's editor for
// what a public form (Task 43, running in parallel against the same
// `config` contract) looks like. Notion's Form view is a data-*entry*
// surface, not a data-*display* layout (research §12: "has no `properties`
// array and cannot group/sort/filter data") — this component is a builder
// over the view's own `config` JSONB, never a TableView-style grid.
//
// `config` contract (task-44-brief.md, agreed with Task 43 — do not
// diverge):
//   is_form_closed: boolean               // default false
//   submission_permissions: "none"        // the ONLY value this app ever writes
//   questions: [{ property_key, required }]   // display order = array order
//   submit_screen: { button_text, button_color, confirmation_title, confirmation_body }
//
// submission_permissions ("why only one value is real", task-44-brief.md):
// Notion's 5 levels need respondent accounts this single-owner app has no
// concept of. Per the standing rule against options that quietly do
// nothing, this picks treatment (a) from the brief — no picker at all, just
// static text describing the one real behaviour — over rendering all 5
// names with 4 permanently disabled. Every `onConfigChange` call below
// still forces `submission_permissions: "none"` into the outgoing patch
// explicitly (never left to fall out of a stored default), so the
// contract's invariant holds no matter which control triggered the save —
// see FormView.test.tsx's dedicated assertions across every save path.
//
// Property picker: same list-editing interaction ButtonActionChainEditor.tsx
// already uses for its own action chain (↑/↓ reorder buttons + a Delete
// button, no drag-and-drop library pulled in for one list) rather than
// inventing a new convention. Available properties are filtered with the
// same `isKnownPropertyType` allow-list TemplateEditor.tsx uses for its own
// property list — excludes formula/rollup/relation/button/computed-and-
// otherwise-unwritable types, reused rather than re-derived.
//
// Debounce: submit-screen text/color fields debounce-PATCH at 600ms,
// matching TemplateEditor.tsx's own name/icon/properties debounce exactly
// (same duration, same on-blur-flush). Structural changes (questions add/
// remove/reorder/required, is_form_closed) PATCH immediately, matching
// Board's/TemplateEditor's own toggle convention.
//
// Copy link: `${window.location.origin}/forms/{viewId}` (Task 43's public
// route — no `/api` prefix, that's the submit route only), same clipboard-
// write + "Copied!" 2s transient state NoteEditorPage.tsx's own share-link
// button already uses (matched rather than inventing a new copy-link
// affordance).
import { useRef, useState } from "react";
import { Check, Link as LinkIcon } from "lucide-react";
import { isKnownPropertyType } from "@/lib/database/types";
import type { PropertyResponse } from "@/lib/database/types";

export interface FormQuestion {
  property_key: string;
  required: boolean;
}

export interface FormSubmitScreen {
  button_text: string;
  button_color: string;
  confirmation_title: string;
  confirmation_body: string;
}

// This app's existing primary-button colour — tailwind.config.ts's own
// `brand.600` design-token comment: "indigo-600 is the primary brand
// colour" (`#4f46e5`). Default `submit_screen.button_color`.
export const DEFAULT_BUTTON_COLOR = "#4f46e5";

const DEFAULT_SUBMIT_SCREEN: FormSubmitScreen = {
  button_text: "Submit",
  button_color: DEFAULT_BUTTON_COLOR,
  confirmation_title: "Thanks!",
  confirmation_body: "",
};

/** Tolerates a missing/malformed shape (default `false`, never a throw) —
 * same "tolerates unknown... drops them at read" spirit spec §10 already
 * states for view config generally (see `getGroupBySpec` etc. in
 * `lib/database/types.ts`). */
export function readIsFormClosed(config: Record<string, unknown>): boolean {
  return config.is_form_closed === true;
}

export function readFormQuestions(config: Record<string, unknown>): FormQuestion[] {
  if (!Array.isArray(config.questions)) return [];
  return config.questions
    .filter(
      (q): q is Record<string, unknown> =>
        !!q && typeof q === "object" && typeof (q as Record<string, unknown>).property_key === "string"
    )
    .map((q) => ({ property_key: q.property_key as string, required: q.required === true }));
}

export function readSubmitScreen(config: Record<string, unknown>): FormSubmitScreen {
  const raw = config.submit_screen;
  if (!raw || typeof raw !== "object") return DEFAULT_SUBMIT_SCREEN;
  const r = raw as Record<string, unknown>;
  return {
    button_text: typeof r.button_text === "string" ? r.button_text : DEFAULT_SUBMIT_SCREEN.button_text,
    button_color: typeof r.button_color === "string" ? r.button_color : DEFAULT_SUBMIT_SCREEN.button_color,
    confirmation_title:
      typeof r.confirmation_title === "string" ? r.confirmation_title : DEFAULT_SUBMIT_SCREEN.confirmation_title,
    confirmation_body:
      typeof r.confirmation_body === "string" ? r.confirmation_body : DEFAULT_SUBMIT_SCREEN.confirmation_body,
  };
}

export interface FormViewProps {
  viewId: string;
  properties: PropertyResponse[];
  config: Record<string, unknown>;
  onConfigChange: (patch: Record<string, unknown>) => void;
}

export function FormView({ viewId, properties, config, onConfigChange }: FormViewProps) {
  const isFormClosed = readIsFormClosed(config);
  const questions = readFormQuestions(config);
  const submitScreen = readSubmitScreen(config);

  // Same skip-list TemplateEditor.tsx's own property section already makes
  // (formula/rollup/relation/button/computed-and-otherwise-unwritable) —
  // reused via `isKnownPropertyType`, not re-derived here.
  const knownProperties = properties.filter((p) => isKnownPropertyType(p.type));
  const selectedKeys = new Set(questions.map((q) => q.property_key));
  const availableProperties = knownProperties.filter((p) => !selectedKeys.has(p.key));
  const propertyByKey = new Map(knownProperties.map((p) => [p.key, p]));

  function saveQuestions(next: FormQuestion[]) {
    onConfigChange({ questions: next, submission_permissions: "none" });
  }

  function handleAddQuestion(propertyKey: string) {
    saveQuestions([...questions, { property_key: propertyKey, required: false }]);
  }
  function handleRemoveQuestion(index: number) {
    saveQuestions(questions.filter((_, i) => i !== index));
  }
  function handleMoveQuestion(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[index], next[target]] = [next[target], next[index]];
    saveQuestions(next);
  }
  function handleToggleRequired(index: number, checked: boolean) {
    saveQuestions(questions.map((q, i) => (i === index ? { ...q, required: checked } : q)));
  }

  function handleToggleClosed(checked: boolean) {
    onConfigChange({ is_form_closed: checked, submission_permissions: "none" });
  }

  // ── Submit-screen fields: local draft + 600ms debounce, mirrors
  // TemplateEditor.tsx's name/icon inputs exactly (same duration, same
  // on-blur-flush pattern) rather than PATCHing on every keystroke. Not
  // re-synced from `config` after mount — same as TemplateEditor's own
  // `name`/`icon` state — since the only writer of `config.submit_screen`
  // this app has is this component's own debounced save.
  const [draftSubmitScreen, setDraftSubmitScreen] = useState<FormSubmitScreen>(submitScreen);
  const submitScreenDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function scheduleSaveSubmitScreen(next: FormSubmitScreen) {
    if (submitScreenDebounceRef.current) clearTimeout(submitScreenDebounceRef.current);
    submitScreenDebounceRef.current = setTimeout(() => {
      onConfigChange({ submit_screen: next, submission_permissions: "none" });
    }, 600);
  }

  function handleSubmitScreenChange(field: keyof FormSubmitScreen, value: string) {
    setDraftSubmitScreen((prev) => {
      const next = { ...prev, [field]: value };
      scheduleSaveSubmitScreen(next);
      return next;
    });
  }

  function handleSubmitScreenBlur() {
    if (submitScreenDebounceRef.current) clearTimeout(submitScreenDebounceRef.current);
    onConfigChange({ submit_screen: draftSubmitScreen, submission_permissions: "none" });
  }

  // ── Share / copy link ───────────────────────────────────────────────
  const [linkCopied, setLinkCopied] = useState(false);
  const formUrl = typeof window !== "undefined" ? `${window.location.origin}/forms/${viewId}` : `/forms/${viewId}`;

  async function copyFormLink() {
    await navigator.clipboard.writeText(formUrl);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  return (
    <div data-testid="form-view" className="h-full overflow-auto p-4 space-y-6 text-sm">
      {/* Questions */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Questions
        </h3>
        {questions.length === 0 && (
          <p className="text-xs text-gray-400 dark:text-gray-500">No questions yet — add a property below.</p>
        )}
        <div className="space-y-1.5">
          {questions.map((q, index) => {
            const property = propertyByKey.get(q.property_key);
            return (
              <div
                key={`${q.property_key}-${index}`}
                className="flex items-center gap-2 rounded-lg border border-gray-100 dark:border-gray-700 p-2"
              >
                <span className="flex-1 min-w-0 truncate text-gray-900 dark:text-gray-100">
                  {property?.name ?? q.property_key}
                </span>
                <label className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                  <input
                    type="checkbox"
                    aria-label={`Question ${index + 1} required`}
                    checked={q.required}
                    onChange={(e) => handleToggleRequired(index, e.target.checked)}
                  />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => handleMoveQuestion(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move question ${index + 1} up`}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 px-1"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => handleMoveQuestion(index, 1)}
                  disabled={index === questions.length - 1}
                  aria-label={`Move question ${index + 1} down`}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 disabled:opacity-30 px-1"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveQuestion(index)}
                  aria-label={`Remove question ${index + 1}`}
                  className="text-xs text-red-500 hover:text-red-700 px-1.5 py-0.5"
                >
                  Remove
                </button>
              </div>
            );
          })}
        </div>

        {availableProperties.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] text-gray-400 dark:text-gray-500">Add a question</p>
            <div className="flex flex-wrap gap-1.5">
              {availableProperties.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => handleAddQuestion(p.key)}
                  className="text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  + {p.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Settings */}
      <section className="space-y-3">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Settings
        </h3>

        <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            aria-label="Closed for submissions"
            checked={isFormClosed}
            onChange={(e) => handleToggleClosed(e.target.checked)}
          />
          Closed — stop accepting new responses
        </label>

        {/* submission_permissions: static text (treatment (a) from
         * task-44-brief.md — no picker at all) rather than 5 Notion option
         * names with 4 permanently disabled. `none` is the only real
         * behaviour this single-owner app can offer (no respondent-account
         * concept to grant `reader`/`editor` access to). */}
        <p className="text-[11px] text-gray-400 dark:text-gray-500">
          Respondents cannot view their submission afterward.
        </p>

        <div className="space-y-2 pl-0.5">
          <p className="text-[11px] font-medium text-gray-500 dark:text-gray-400">Submit screen</p>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-32 shrink-0 text-gray-500 dark:text-gray-400">Button text</span>
            <input
              aria-label="Submit button text"
              value={draftSubmitScreen.button_text}
              onChange={(e) => handleSubmitScreenChange("button_text", e.target.value)}
              onBlur={handleSubmitScreenBlur}
              className="flex-1 text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-32 shrink-0 text-gray-500 dark:text-gray-400">Button color</span>
            <input
              aria-label="Submit button color"
              type="color"
              value={draftSubmitScreen.button_color}
              onChange={(e) => handleSubmitScreenChange("button_color", e.target.value)}
              onBlur={handleSubmitScreenBlur}
              className="h-7 w-10 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-32 shrink-0 text-gray-500 dark:text-gray-400">Confirmation title</span>
            <input
              aria-label="Confirmation title"
              value={draftSubmitScreen.confirmation_title}
              onChange={(e) => handleSubmitScreenChange("confirmation_title", e.target.value)}
              onBlur={handleSubmitScreenBlur}
              className="flex-1 text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-32 shrink-0 text-gray-500 dark:text-gray-400">Confirmation body</span>
            <input
              aria-label="Confirmation body"
              value={draftSubmitScreen.confirmation_body}
              onChange={(e) => handleSubmitScreenChange("confirmation_body", e.target.value)}
              onBlur={handleSubmitScreenBlur}
              className="flex-1 text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
            />
          </label>
        </div>
      </section>

      {/* Share */}
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">
          Share
        </h3>
        {isFormClosed && (
          <div
            data-testid="form-closed-badge"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 rounded"
          >
            Closed — not accepting responses
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            readOnly
            aria-label="Form link"
            value={formUrl}
            className="flex-1 text-xs px-2 py-1 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400"
          />
          <button
            type="button"
            onClick={copyFormLink}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-indigo-600 text-white"
          >
            {linkCopied ? <Check size={13} /> : <LinkIcon size={13} />}
            {linkCopied ? "Copied!" : "Copy link"}
          </button>
        </div>
      </section>
    </div>
  );
}
