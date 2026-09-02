"use client";

// Emoji picker for database, view and row icons.
//
// SCOPED DELIBERATELY. Notion's picker has three tabs (Emoji / Icons / Upload),
// a shuffle, a skin-tone selector and a category jump bar. We ship Emoji +
// search + categories + Remove + shuffle; "Icons" needs an icon set we do not
// have and "Upload" needs an asset pipeline. Reasons in
// docs/ui-specs/database-header.md.
//
// Notion applies a RANDOM icon the moment you click "Add icon" and only then
// opens the picker — assign-now, refine-later, the same spirit as its
// create-first view creation. `onPick` fires immediately; callers wanting that
// behaviour should seed with `randomEmoji()` before opening.
//
// This extends NoteEditorPage's fixed EMOJIS array rather than forking it: same
// idea, plus keywords and categories. The list is intentionally curated, not a
// full Unicode dataset — a searchable dataset is ~1MB and the design doc
// rejected that. Add entries here as they are wanted.
import { useMemo, useState } from "react";

interface Emoji {
  char: string;
  name: string;
  keywords: string;
}

const CATEGORIES: { label: string; emojis: Emoji[] }[] = [
  {
    label: "Objects",
    emojis: [
      { char: "📄", name: "page", keywords: "document file note" },
      { char: "📁", name: "folder", keywords: "directory group" },
      { char: "📊", name: "chart", keywords: "graph data stats analytics" },
      { char: "📈", name: "up chart", keywords: "growth trend increase" },
      { char: "📌", name: "pin", keywords: "pinned important" },
      { char: "📎", name: "paperclip", keywords: "attach file" },
      { char: "🔖", name: "bookmark", keywords: "save tag label" },
      { char: "📚", name: "books", keywords: "library reading study" },
      { char: "📝", name: "memo", keywords: "note write edit" },
      { char: "🗓️", name: "calendar", keywords: "date schedule plan" },
      { char: "⏰", name: "alarm", keywords: "time reminder clock" },
      { char: "🔗", name: "link", keywords: "url chain reference" },
      { char: "🗃️", name: "card box", keywords: "database archive records" },
      { char: "🧰", name: "toolbox", keywords: "tools utilities" },
      { char: "🔒", name: "lock", keywords: "secure private locked" },
    ],
  },
  {
    label: "Symbols",
    emojis: [
      { char: "✅", name: "check", keywords: "done complete yes ok" },
      { char: "❌", name: "cross", keywords: "no cancel remove fail" },
      { char: "⭐", name: "star", keywords: "favourite favorite important" },
      { char: "🔥", name: "fire", keywords: "hot urgent trending" },
      { char: "💡", name: "bulb", keywords: "idea insight tip" },
      { char: "⚡", name: "bolt", keywords: "fast automation trigger" },
      { char: "🎯", name: "target", keywords: "goal aim objective" },
      { char: "🚀", name: "rocket", keywords: "launch ship fast" },
      { char: "🏷️", name: "label", keywords: "tag category" },
      { char: "❓", name: "question", keywords: "help unknown ask" },
      { char: "⚠️", name: "warning", keywords: "caution alert risk" },
      { char: "🔴", name: "red circle", keywords: "status stop blocked" },
      { char: "🟡", name: "yellow circle", keywords: "status pending" },
      { char: "🟢", name: "green circle", keywords: "status go ready" },
      { char: "🔵", name: "blue circle", keywords: "status info" },
    ],
  },
  {
    label: "Work",
    emojis: [
      { char: "💼", name: "briefcase", keywords: "work business job" },
      { char: "🧠", name: "brain", keywords: "think knowledge learn ai" },
      { char: "🛠️", name: "tools", keywords: "build fix engineering" },
      { char: "🧪", name: "test tube", keywords: "experiment research lab" },
      { char: "🔬", name: "microscope", keywords: "research science analysis" },
      { char: "📐", name: "triangle ruler", keywords: "design measure spec" },
      { char: "🗂️", name: "dividers", keywords: "organise sort category" },
      { char: "🧾", name: "receipt", keywords: "invoice record log" },
      { char: "💰", name: "money", keywords: "budget cost finance" },
      { char: "🤝", name: "handshake", keywords: "meeting partner deal" },
    ],
  },
  {
    label: "Nature",
    emojis: [
      { char: "🌱", name: "seedling", keywords: "new grow start" },
      { char: "🌍", name: "globe", keywords: "world earth global" },
      { char: "🌊", name: "wave", keywords: "water flow ocean" },
      { char: "☀️", name: "sun", keywords: "day light weather" },
      { char: "🌙", name: "moon", keywords: "night dark sleep" },
      { char: "🍀", name: "clover", keywords: "luck lucky" },
      { char: "🐛", name: "bug", keywords: "issue defect problem" },
      { char: "🦉", name: "owl", keywords: "wisdom night" },
    ],
  },
  {
    label: "People",
    emojis: [
      { char: "😀", name: "grin", keywords: "happy smile" },
      { char: "🙂", name: "slight smile", keywords: "ok fine" },
      { char: "🤔", name: "thinking", keywords: "consider question hmm" },
      { char: "😴", name: "sleeping", keywords: "idle paused inactive" },
      { char: "🎉", name: "party", keywords: "celebrate done launch" },
      { char: "👀", name: "eyes", keywords: "review watch look" },
      { char: "👤", name: "person", keywords: "user owner assignee" },
      { char: "👥", name: "people", keywords: "team group members" },
    ],
  },
];

const ALL = CATEGORIES.flatMap((c) => c.emojis);

export function randomEmoji(): string {
  return ALL[Math.floor(Math.random() * ALL.length)].char;
}

export interface IconPickerProps {
  value?: string | null;
  onPick: (emoji: string) => void;
  onRemove?: () => void;
}

export function IconPicker({ value, onPick, onRemove }: IconPickerProps) {
  const [query, setQuery] = useState("");

  const categories = useMemo(() => {
    if (!query.trim()) return CATEGORIES;
    const q = query.toLowerCase();
    return CATEGORIES.map((c) => ({
      ...c,
      emojis: c.emojis.filter((e) => e.name.includes(q) || e.keywords.includes(q)),
    })).filter((c) => c.emojis.length > 0);
  }, [query]);

  const empty = categories.length === 0;

  return (
    <div className="p-2 text-menu text-menu-fg" data-testid="icon-picker">
      <div className="mb-2 flex items-center gap-1">
        <input
          autoFocus
          aria-label="Filter icons"
          placeholder="Filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-menu-row min-w-0 flex-1 rounded bg-menu-field px-2 outline-none placeholder:text-menu-disabled"
        />
        <button
          type="button"
          aria-label="Random icon"
          onClick={() => onPick(randomEmoji())}
          className="flex h-menu-row w-menu-row items-center justify-center rounded hover:bg-menu-hover"
        >
          🔀
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="h-menu-row rounded px-2 hover:bg-menu-hover"
          >
            Remove
          </button>
        )}
      </div>

      {empty && <div className="px-1 py-2 text-menu-disabled">No icons found</div>}

      <div className="max-h-64 overflow-y-auto">
        {categories.map((c) => (
          <div key={c.label}>
            <div className="px-1 py-1 text-menu-disabled">{c.label}</div>
            <div className="grid grid-cols-8 gap-0.5">
              {c.emojis.map((e) => (
                <button
                  key={e.char}
                  type="button"
                  aria-label={e.name}
                  onClick={() => onPick(e.char)}
                  className={`flex h-7 w-7 items-center justify-center rounded hover:bg-menu-hover ${
                    value === e.char ? "bg-menu-hover" : ""
                  }`}
                >
                  {e.char}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
