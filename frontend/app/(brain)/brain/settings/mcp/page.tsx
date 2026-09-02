"use client";

import { useEffect, useState } from "react";
import { Plus, Trash2, ToggleLeft, ToggleRight, Shield, ShieldCheck } from "lucide-react";

interface McpServer {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  url: string | null;
  enabled: boolean;
  trust_level: "read_only" | "full";
  created_at: string;
}

interface AuditEntry {
  id: string;
  server_name: string;
  tool_name: string;
  args_json: Record<string, unknown>;
  result_code: "ok" | "error" | "denied";
  created_at: string;
}

type Tab = "servers" | "audit";

const EMPTY_FORM = { name: "", transport: "http", command: "", url: "", trust_level: "read_only" as "read_only" | "full" };

export default function McpSettingsPage() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [tab, setTab] = useState<Tab>("servers");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadServers() {
    const res = await fetch("/api/mcp-servers");
    if (res.ok) setServers((await res.json()).servers);
  }

  async function loadAudit() {
    const res = await fetch("/api/mcp-audit-log");
    if (res.ok) setAudit((await res.json()).entries);
  }

  useEffect(() => { loadServers(); }, []);
  useEffect(() => { if (tab === "audit") loadAudit(); }, [tab]);

  async function addServer() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          transport: form.transport,
          command: form.transport === "stdio" ? form.command : null,
          url: form.transport !== "stdio" ? form.url : null,
          trust_level: form.trust_level,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail ?? `Error ${res.status}`);
        return;
      }
      await loadServers();
      setShowAdd(false);
      setForm(EMPTY_FORM);
    } finally {
      setSaving(false);
    }
  }

  async function toggleServer(id: string, enabled: boolean) {
    await fetch(`/api/mcp-servers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await loadServers();
  }

  async function toggleTrust(id: string, trust_level: "read_only" | "full") {
    await fetch(`/api/mcp-servers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trust_level }),
    });
    await loadServers();
  }

  async function deleteServer(id: string, name: string) {
    if (!confirm(`Remove MCP server "${name}"?`)) return;
    await fetch(`/api/mcp-servers/${id}`, { method: "DELETE" });
    await loadServers();
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-lg font-semibold text-gray-900">MCP Servers</h1>
        </div>
        <p className="text-xs text-gray-400 mb-6">
          Connect external MCP servers to give the AI access to web search, calendars, and other tools.
        </p>

        {/* Tabs */}
        <div className="flex gap-4 border-b border-gray-100 mb-6">
          {(["servers", "audit"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t ? "border-indigo-500 text-indigo-600" : "border-transparent text-gray-400 hover:text-gray-700"
              }`}
            >
              {t === "audit" ? "Audit Log" : "Servers"}
            </button>
          ))}
        </div>

        {tab === "servers" && (
          <>
            {servers.length > 0 && (
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden mb-4">
                {servers.map((s) => (
                  <li key={s.id} className="px-4 py-3 bg-white">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-gray-900">{s.name}</span>
                          <span className="text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                            {s.transport}
                          </span>
                          {!s.enabled && (
                            <span className="text-xs text-gray-400">disabled</span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                          {s.command || s.url || "—"}
                        </p>
                      </div>

                      {/* Trust toggle */}
                      <button
                        onClick={() => toggleTrust(s.id, s.trust_level === "read_only" ? "full" : "read_only")}
                        title={s.trust_level === "read_only" ? "Read-only — click to grant full access" : "Full access — click to restrict"}
                        className={`p-1.5 rounded transition-colors ${
                          s.trust_level === "full" ? "text-amber-500 hover:text-amber-700" : "text-gray-400 hover:text-gray-700"
                        }`}
                      >
                        {s.trust_level === "full" ? <ShieldCheck size={16} /> : <Shield size={16} />}
                      </button>

                      {/* Enable toggle */}
                      <button
                        onClick={() => toggleServer(s.id, !s.enabled)}
                        className={`p-1.5 transition-colors ${s.enabled ? "text-indigo-500" : "text-gray-300"}`}
                      >
                        {s.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                      </button>

                      <button
                        onClick={() => deleteServer(s.id, s.name)}
                        className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {showAdd ? (
              <div className="border border-gray-200 rounded-xl p-4 bg-gray-50 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
                    <input
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="websearch"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Transport</label>
                    <select
                      value={form.transport}
                      onChange={(e) => setForm((f) => ({ ...f, transport: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    >
                      <option value="http">HTTP/SSE</option>
                      <option value="stdio">stdio</option>
                    </select>
                  </div>
                </div>
                {form.transport === "stdio" ? (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">Command</label>
                    <input
                      value={form.command}
                      onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 font-mono"
                      placeholder="node /path/to/server.js"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">URL</label>
                    <input
                      value={form.url}
                      onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      placeholder="http://localhost:3001"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Trust level</label>
                  <select
                    value={form.trust_level}
                    onChange={(e) => setForm((f) => ({ ...f, trust_level: e.target.value as "read_only" | "full" }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    <option value="read_only">Read-only</option>
                    <option value="full">Full access</option>
                  </select>
                </div>
                {error && <p className="text-xs text-red-500">{error}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => { setShowAdd(false); setError(""); }}
                    className="text-sm text-gray-500 hover:text-gray-800 px-3 py-2"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={addServer}
                    disabled={saving || !form.name.trim()}
                    className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
                  >
                    {saving ? "Adding…" : "Add server"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
              >
                <Plus size={14} />
                Add MCP server
              </button>
            )}
          </>
        )}

        {tab === "audit" && (
          <div>
            {audit.length === 0 ? (
              <p className="text-sm text-gray-400">No tool calls recorded yet.</p>
            ) : (
              <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
                {audit.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-2.5 bg-white text-xs">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${
                      e.result_code === "ok" ? "bg-green-400" : e.result_code === "error" ? "bg-red-400" : "bg-yellow-400"
                    }`} />
                    <span className="font-mono text-gray-600 flex-1 truncate">
                      {e.server_name}.{e.tool_name}
                    </span>
                    <span className="text-gray-400 shrink-0">
                      {new Date(e.created_at).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
