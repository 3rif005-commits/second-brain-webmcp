"use client";

import { useEffect, useState } from "react";

export type IngestionStep =
  | "idle"
  | "uploading"
  | "extracting"
  | "generating"
  | "streaming"
  | "done"
  | "error";

export interface IngestErrorDetail {
  error: string;
  error_code?: string;
  model?: string;
  suggestion?: string;
}

interface IngestionProgressProps {
  step: IngestionStep;
  errorDetail?: IngestErrorDetail;
  model?: string;
}

const STEPS: { key: IngestionStep; label: string }[] = [
  { key: "uploading",  label: "Uploading" },
  { key: "extracting", label: "Extracting" },
  { key: "generating", label: "Generating" },
  { key: "done",       label: "Done" },
];

const ORDER: IngestionStep[] = ["uploading", "extracting", "generating", "done"];

const ERROR_CODE_LABELS: Record<string, string> = {
  MISSING_INPUT:        "No file or URL provided",
  RATE_LIMITED:         "Rate limited",
  TIMEOUT:              "Request timed out",
  MODEL_UNAVAILABLE:    "Model unavailable",
  EMPTY_RESPONSE:       "Empty response",
  BAD_GATEWAY:          "Bad gateway",
  CONNECTION_ERROR:     "Connection error",
  OPENROUTER_ERROR:     "OpenRouter error",
  LLAMACPP_UNAVAILABLE: "Local server busy",
  LLAMACPP_EMPTY:       "Local model returned nothing",
  GEMINI_QUOTA:         "Gemini quota exceeded",
  GEMINI_ERROR:         "Gemini error",
  PDF_NO_TEXT:          "PDF has no extractable text",
  URL_EXTRACT_FAILED:   "Could not fetch URL",
  AUTH_INVALID:         "Session expired",
  SERVER_ERROR:         "Server error",
  CLIENT_ERROR:         "Network error",
};

function ElapsedTimer({ running }: { running: boolean }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!running) return;
    setSecs(0);
    const id = setInterval(() => setSecs(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return <span>{m}:{String(s).padStart(2, "0")}</span>;
}

export function IngestionProgress({ step, errorDetail, model }: IngestionProgressProps) {
  if (step === "idle") return null;

  const isLocal = model === "llamacpp";
  const isGenerating = step === "generating";
  const currentIdx = ORDER.indexOf(step);

  if (step === "error") {
    const errorCode = errorDetail?.error_code;
    const label = errorCode ? (ERROR_CODE_LABELS[errorCode] ?? errorCode) : "Error";
    const hasHumanLabel = errorCode ? errorCode in ERROR_CODE_LABELS : false;
    const isBusy = errorCode === "LLAMACPP_UNAVAILABLE" || errorCode === "SERVER_ERROR";

    return (
      <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 space-y-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-red-700">{label}</span>
          {hasHumanLabel && errorCode && (
            <code className="text-[10px] bg-red-100 text-red-500 px-1.5 py-0.5 rounded font-mono">
              {errorCode}
            </code>
          )}
          {errorDetail?.model && (
            <code className="text-[10px] bg-red-100 text-red-500 px-1.5 py-0.5 rounded font-mono">
              {errorDetail.model}
            </code>
          )}
        </div>

        <p className="text-sm text-red-700 leading-snug">
          {isBusy && isLocal
            ? "The local model is still generating a previous note. Wait for it to finish, then try again."
            : (errorDetail?.error ?? "Something went wrong.")}
        </p>

        {!isBusy && errorDetail?.suggestion && (
          <p className="text-xs text-red-600 border-t border-red-200 pt-2 leading-snug">
            {errorDetail.suggestion}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      {/* Step pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {STEPS.map(({ key, label }, i) => {
          const done   = i < currentIdx || step === "done";
          const active = key === step;
          return (
            <div key={key} className="flex items-center gap-2">
              <div className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${
                done   ? "bg-green-100 text-green-700" :
                active ? "bg-indigo-100 text-indigo-700 animate-pulse" :
                         "bg-gray-100 text-gray-400"
              }`}>
                {done ? "✓" : active ? "●" : "○"} {label}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-px w-4 ${i < currentIdx ? "bg-green-400" : "bg-gray-200"}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Local LLM warning while generating */}
      {isLocal && isGenerating && (
        <div className="flex items-start gap-2.5 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5">
          <span className="text-amber-500 mt-0.5 shrink-0">⏱</span>
          <div className="text-xs text-amber-700 space-y-0.5">
            <p className="font-semibold">
              Local model generating — <ElapsedTimer running={true} />
            </p>
            <p className="text-amber-600">
              Gemma 4 E2B on CPU takes 8–15 min per note. Do not close this tab or submit again.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
