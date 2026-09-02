"use client";

// Settings → AI Providers: user API keys for the provider-agnostic AI layer.
// The backend routes each job (summaries, formula OCR, video understanding,
// chat) to the best configured provider and falls back to the local model.
import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

interface ProviderRow {
  id: string;
  provider: string;
  label: string;
  base_url: string | null;
  chat_model: string | null;
  enabled: boolean;
  api_key_hint: string;
}

const PROVIDER_INFO: Record<string, { name: string; caps: string; keyUrl: string }> = {
  gemini: {
    name: "Google Gemini",
    caps: "text · vision · native video/PDF understanding",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  anthropic: {
    name: "Anthropic Claude",
    caps: "text · vision",
    keyUrl: "https://console.anthropic.com/",
  },
  openai: {
    name: "OpenAI",
    caps: "text · vision",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  openai_compatible: {
    name: "OpenAI-compatible endpoint",
    caps: "text (OpenRouter, Groq, local gateways…)",
    keyUrl: "",
  },
};

export default function AiProvidersPage() {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    provider: "gemini", api_key: "", label: "", base_url: "", chat_model: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderRow | null>(null);

  const load = () =>
    fetch("/api/ws/ai-providers")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setRows)
      .catch((e) => setError(e.message));

  useEffect(() => { load(); }, []);

  async function add() {
    setError(null);
    const res = await fetch("/api/ws/ai-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: form.provider,
        api_key: form.api_key,
        label: form.label || PROVIDER_INFO[form.provider]?.name,
        base_url: form.base_url || null,
        chat_model: form.chat_model || null,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.detail?.error || body?.error || `HTTP ${res.status}`);
      return;
    }
    setForm({ provider: "gemini", api_key: "", label: "", base_url: "", chat_model: "" });
    setShowForm(false);
    load();
  }

  async function toggle(row: ProviderRow) {
    await fetch(`/api/ws/ai-providers/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !row.enabled }),
    });
    load();
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    const row = pendingDelete;
    setPendingDelete(null);
    await fetch(`/api/ws/ai-providers/${row.id}`, { method: "DELETE" });
    load();
  }

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-gray-900">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">AI Providers</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 mb-6">
          Workspace AI (summaries, formula → LaTeX, video understanding, grounded chat)
          picks the best configured provider per job and falls back to the local model.
        </p>

        {error && <p className="text-sm text-red-500 mb-3">{error}</p>}

        <div className="space-y-2 mb-5">
          {rows?.map((row) => (
            <div key={row.id}
              className="flex items-center gap-3 p-3 rounded-xl border border-gray-200 dark:border-gray-700">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-100">
                  {row.label}
                  <span className="ml-2 text-xs text-gray-400">{row.api_key_hint}</span>
                </div>
                <div className="text-xs text-gray-400">
                  {PROVIDER_INFO[row.provider]?.caps}
                  {row.chat_model ? ` · ${row.chat_model}` : ""}
                </div>
              </div>
              <button
                onClick={() => toggle(row)}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors ${
                  row.enabled ? "bg-indigo-500" : "bg-gray-300 dark:bg-gray-600"}`}
              >
                <span className={`inline-block h-4 w-4 translate-y-0.5 rounded-full bg-white shadow transition-transform ${
                  row.enabled ? "translate-x-[18px]" : "translate-x-0.5"}`} />
              </button>
              <button onClick={() => setPendingDelete(row)} className="text-gray-300 hover:text-red-400">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {rows !== null && rows.length === 0 && (
            <p className="text-sm text-gray-400 py-4">
              No providers configured — server .env keys and the local Gemma model are used.
            </p>
          )}
        </div>

        {showForm ? (
          <div className="p-4 rounded-xl border border-indigo-200 dark:border-indigo-800 space-y-3">
            <select
              className="w-full text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-gray-800 dark:text-gray-200"
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}
            >
              {Object.entries(PROVIDER_INFO).map(([k, v]) => (
                <option key={k} value={k}>{v.name}</option>
              ))}
            </select>
            <input
              className="w-full text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-gray-800 dark:text-gray-200"
              placeholder="API key"
              type="password"
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            />
            {form.provider === "openai_compatible" && (
              <input
                className="w-full text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-gray-800 dark:text-gray-200"
                placeholder="Base URL, e.g. https://openrouter.ai/api/v1"
                value={form.base_url}
                onChange={(e) => setForm({ ...form, base_url: e.target.value })}
              />
            )}
            <input
              className="w-full text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 py-2 text-gray-800 dark:text-gray-200"
              placeholder="Model override (optional)"
              value={form.chat_model}
              onChange={(e) => setForm({ ...form, chat_model: e.target.value })}
            />
            {PROVIDER_INFO[form.provider]?.keyUrl && (
              <p className="text-xs text-gray-400">
                Get a key: <a className="text-indigo-500 hover:underline" href={PROVIDER_INFO[form.provider].keyUrl} target="_blank" rel="noreferrer">{PROVIDER_INFO[form.provider].keyUrl}</a>
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={add}
                disabled={!form.api_key.trim()}
                className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm disabled:opacity-40 hover:bg-indigo-700"
              >
                Add provider
              </button>
              <button
                onClick={() => setShowForm(false)}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
          >
            <Plus size={15} /> Add provider
          </button>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Remove ${pendingDelete?.label ?? "this provider"}?`}
        confirmLabel="Remove"
        onConfirm={confirmRemove}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
