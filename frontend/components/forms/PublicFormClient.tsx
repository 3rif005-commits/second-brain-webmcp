"use client";

// The actual form UI + submit flow for `app/forms/[viewId]/page.tsx` — a
// plain client component (not the authenticated `useDatabaseView` stack;
// this is a brand-new, unauthenticated page tree, per task-43-brief.md).
// One input per `config.questions[]` entry, in array order; POSTs to
// `app/api/forms/[viewId]/submit/route.ts`; on success, swaps the form out
// for the confirmation screen in place (no navigation — a single-page
// flow). No native window.alert/confirm/prompt anywhere: a failed
// submission renders its error inline, below the submit button.

import { useState } from "react";
import type {
  CheckboxValue,
  DateValue,
  MultiSelectValue,
  NumberValue,
  PropertyResponse,
  PropertyValue,
  RichTextValue,
  SelectValue,
  StatusValue,
  TitleValue,
} from "@/lib/database/types";
import type { FormViewConfig } from "@/lib/forms/types";

interface Props {
  viewId: string;
  config: FormViewConfig;
  questionProperties: PropertyResponse[]; // pre-filtered + ordered to match config.questions[]
}

type Answers = Record<string, PropertyValue>;

function emptyValueFor(type: string): PropertyValue {
  switch (type) {
    case "title":
      return { type: "title", title: "" };
    case "rich_text":
      return { type: "rich_text", rich_text: "" };
    case "number":
      return { type: "number", number: null };
    case "select":
      return { type: "select", select: null };
    case "multi_select":
      return { type: "multi_select", multi_select: [] };
    case "status":
      return { type: "status", status: null };
    case "date":
      return { type: "date", date: null };
    case "checkbox":
      return { type: "checkbox", checkbox: false };
    default:
      return { type, value: "" } as PropertyValue;
  }
}

// `PropertyValue`'s `UnknownValue` arm has a `type: string` index signature,
// which defeats TypeScript's discriminated-union narrowing on `.type` (every
// literal is assignable to `string`) — so these cast explicitly per case
// rather than relying on narrowing to do it, same reasoning in QuestionInput
// below.
function isAnswered(value: PropertyValue | undefined): boolean {
  if (!value) return false;
  switch (value.type) {
    case "title":
      return (value as TitleValue).title.trim() !== "";
    case "rich_text":
      return (value as RichTextValue).rich_text.trim() !== "";
    case "number":
      return (value as NumberValue).number !== null;
    case "select":
      return !!(value as SelectValue).select;
    case "multi_select":
      return (value as MultiSelectValue).multi_select.length > 0;
    case "status":
      return !!(value as StatusValue).status;
    case "date":
      return !!(value as DateValue).date;
    case "checkbox":
      return true; // a checkbox always has a definite value
    default:
      return true;
  }
}

function QuestionInput({
  id,
  property,
  value,
  onChange,
}: {
  id: string;
  property: PropertyResponse;
  value: PropertyValue;
  onChange: (v: PropertyValue) => void;
}) {
  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-gray-300 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500";

  // Switches on `property.type` (a plain string from db_properties, not
  // part of the PropertyValue union) rather than `value.type`: PropertyValue's
  // `UnknownValue` arm has a `type: string` index signature that defeats
  // TypeScript's discriminated-union narrowing on `.type` (every literal is
  // assignable to `string`), so `value` is cast explicitly per case instead.
  switch (property.type) {
    case "title": {
      const v = value as TitleValue;
      return (
        <input
          type="text"
          id={id}
          className={inputClass}
          value={v.title}
          onChange={(e) => onChange({ type: "title", title: e.target.value })}
        />
      );
    }
    case "rich_text": {
      const v = value as RichTextValue;
      return (
        <textarea
          id={id}
          className={inputClass}
          rows={3}
          value={v.rich_text}
          onChange={(e) => onChange({ type: "rich_text", rich_text: e.target.value })}
        />
      );
    }
    case "number": {
      const v = value as NumberValue;
      return (
        <input
          type="number"
          id={id}
          className={inputClass}
          value={v.number ?? ""}
          onChange={(e) =>
            onChange({ type: "number", number: e.target.value === "" ? null : Number(e.target.value) })
          }
        />
      );
    }
    case "select": {
      const v = value as SelectValue;
      return (
        <input
          type="text"
          id={id}
          className={inputClass}
          value={v.select ?? ""}
          onChange={(e) => onChange({ type: "select", select: e.target.value || null })}
        />
      );
    }
    case "multi_select": {
      const v = value as MultiSelectValue;
      return (
        <input
          type="text"
          id={id}
          className={inputClass}
          placeholder="Comma-separated"
          value={v.multi_select.join(", ")}
          onChange={(e) =>
            onChange({
              type: "multi_select",
              multi_select: e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      );
    }
    case "status": {
      const v = value as StatusValue;
      return (
        <input
          type="text"
          id={id}
          className={inputClass}
          value={v.status ?? ""}
          onChange={(e) => onChange({ type: "status", status: e.target.value || null })}
        />
      );
    }
    case "date": {
      const v = value as DateValue;
      return (
        <input
          type="date"
          id={id}
          className={inputClass}
          value={v.date?.start ?? ""}
          onChange={(e) =>
            onChange(
              e.target.value
                ? { type: "date", date: { start: e.target.value, end: null, time_zone: null } }
                : { type: "date", date: null }
            )
          }
        />
      );
    }
    case "checkbox": {
      const v = value as CheckboxValue;
      return (
        <input
          type="checkbox"
          id={id}
          className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
          checked={v.checkbox}
          onChange={(e) => onChange({ type: "checkbox", checkbox: e.target.checked })}
        />
      );
    }
    default: {
      const raw = value as Record<string, unknown>;
      return (
        <input
          type="text"
          id={id}
          className={inputClass}
          value={typeof raw.value === "string" ? raw.value : ""}
          onChange={(e) => onChange({ type: property.type, value: e.target.value } as PropertyValue)}
        />
      );
    }
  }
}

export function PublicFormClient({ viewId, config, questionProperties }: Props) {
  const [answers, setAnswers] = useState<Answers>(() => {
    const initial: Answers = {};
    for (const property of questionProperties) {
      initial[property.key] = emptyValueFor(property.type);
    }
    return initial;
  });
  const [status, setStatus] = useState<"form" | "submitting" | "success" | "error">("form");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const questions = config.questions ?? [];
  const submitScreen = config.submit_screen ?? {
    button_text: "Submit",
    button_color: "#4f46e5",
    confirmation_title: "Thanks!",
    confirmation_body: "",
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    for (const question of questions) {
      if (question.required && !isAnswered(answers[question.property_key])) {
        setErrorMessage("Please fill in all required questions.");
        return;
      }
    }

    setStatus("submitting");
    try {
      const res = await fetch(`/api/forms/${viewId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ properties: answers }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMessage(body.error || "Something went wrong. Please try again.");
        setStatus("error");
        return;
      }
      setStatus("success");
    } catch {
      setErrorMessage("Something went wrong. Please try again.");
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <div className="text-center py-12">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">{submitScreen.confirmation_title}</h1>
        {submitScreen.confirmation_body && (
          <p className="text-gray-600">{submitScreen.confirmation_body}</p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {questionProperties.map((property) => {
        const question = questions.find((q) => q.property_key === property.key);
        return (
          <div key={property.key}>
            <label htmlFor={property.key} className="block text-sm font-medium text-gray-800 mb-1">
              {property.name}
              {question?.required && <span className="text-red-500 ml-0.5">*</span>}
            </label>
            <QuestionInput
              id={property.key}
              property={property}
              value={answers[property.key]}
              onChange={(v) => setAnswers((prev) => ({ ...prev, [property.key]: v }))}
            />
          </div>
        );
      })}

      {errorMessage && (
        <div className="text-sm text-red-600" role="alert">
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        style={{ backgroundColor: submitScreen.button_color }}
        className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-60"
      >
        {status === "submitting" ? "Submitting…" : submitScreen.button_text}
      </button>
    </form>
  );
}
