"use client";

import { useEffect, useState } from "react";
import { Plus, Lock, Edit2, Trash2, Copy, Save, X } from "lucide-react";

interface Skill {
  name: string;
  description: string;
  body: string;
  tools: string[] | null;
  priority: number;
  source: "bundled" | "user";
  readonly: boolean;
}

type View = "list" | "edit" | "new";

export default function SkillsSettingsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("list");
  const [selected, setSelected] = useState<Skill | null>(null);
  const [draft, setDraft] = useState({ name: "", description: "", body: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadSkills() {
    setLoading(true);
    const res = await fetch("/api/skills");
    if (res.ok) setSkills((await res.json()).skills);
    setLoading(false);
  }

  useEffect(() => { loadSkills(); }, []);

  function openEdit(skill: Skill) {
    setSelected(skill);
    setDraft({ name: skill.name, description: skill.description, body: skill.body });
    setView("edit");
    setError("");
  }

  function openClone(skill: Skill) {
    setSelected(null);
    setDraft({ name: `${skill.name}-custom`, description: skill.description, body: skill.body });
    setView("new");
    setError("");
  }

  function openNew() {
    setSelected(null);
    setDraft({ name: "", description: "", body: "" });
    setView("new");
    setError("");
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      let res: Response;
      if (view === "new") {
        res = await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, tools: null, priority: 0 }),
        });
      } else {
        res = await fetch(`/api/skills/${selected!.name}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, tools: null, priority: 0 }),
        });
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.detail ?? `Error ${res.status}`);
        return;
      }
      await loadSkills();
      setView("list");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSkill(name: string) {
    if (!confirm(`Delete skill "${name}"?`)) return;
    await fetch(`/api/skills/${name}`, { method: "DELETE" });
    await loadSkills();
  }

  if (view !== "list") {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-8">
          <div className="flex items-center gap-3 mb-6">
            <button onClick={() => setView("list")} className="text-gray-400 hover:text-gray-700">
              <X size={18} />
            </button>
            <h1 className="text-lg font-semibold text-gray-900">
              {view === "new" ? "New Skill" : `Edit: ${selected?.name}`}
            </h1>
          </div>
          <div className="space-y-4">
            {view === "new" && (
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Skill name (kebab-case)</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  placeholder="my-custom-skill"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Description (used for auto-activation)</label>
              <input
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400"
                placeholder="Use when the user is reviewing for an exam…"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Instructions (markdown)</label>
              <textarea
                value={draft.body}
                onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
                rows={14}
                className="w-full px-3 py-2 text-sm font-mono border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-y"
                placeholder="When invoked, always…"
              />
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setView("list")} className="px-4 py-2 text-sm text-gray-500 hover:text-gray-800 transition-colors">
                Cancel
              </button>
              <button
                onClick={save}
                disabled={saving || !draft.description.trim() || !draft.body.trim() || (view === "new" && !draft.name.trim())}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
              >
                <Save size={14} />
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Skills</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              Skills tell the AI how to behave in specific contexts.
            </p>
          </div>
          <button
            onClick={openNew}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
          >
            <Plus size={14} />
            New skill
          </button>
        </div>
        {loading ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : (
          <ul className="divide-y divide-gray-100 border border-gray-100 rounded-xl overflow-hidden">
            {skills.map((skill) => (
              <li key={skill.name} className="flex items-start gap-3 px-4 py-3 bg-white hover:bg-gray-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-900">{skill.name}</span>
                    {skill.readonly && (
                      <span className="flex items-center gap-0.5 text-xs text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                        <Lock size={10} /> bundled
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{skill.description}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0 mt-0.5">
                  {skill.readonly ? (
                    <button onClick={() => openClone(skill)} title="Clone to customize"
                      className="p-1.5 text-gray-400 hover:text-indigo-600 transition-colors">
                      <Copy size={14} />
                    </button>
                  ) : (
                    <>
                      <button onClick={() => openEdit(skill)} title="Edit"
                        className="p-1.5 text-gray-400 hover:text-indigo-600 transition-colors">
                        <Edit2 size={14} />
                      </button>
                      <button onClick={() => deleteSkill(skill.name)} title="Delete"
                        className="p-1.5 text-gray-400 hover:text-red-500 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
