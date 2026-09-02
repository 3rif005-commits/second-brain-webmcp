// Workspace feature — shared types + thin API client over the /api/ws proxy.
// One note, many sources: sources attach directly to a note and one AI
// synthesis comes out. No workspaces, no pages, no canvas positions.

export type ResourceKind = "pdf" | "document" | "youtube" | "video" | "website";
export type ResourceStatus = "queued" | "processing" | "ready" | "failed";
export type AnchorType = "time" | "page" | "section";
export type SynthesisStatus = "none" | "queued" | "running" | "ready" | "failed";

export interface NoteSource {
  id: string;
  note_id: string;
  kind: ResourceKind;
  title: string;
  source_url: string | null;
  storage_path: string | null;
  mime_type?: string | null;
  status: ResourceStatus;
  error: string | null;
  meta: {
    pages?: number;
    page_sizes?: [number, number][];
    duration?: number;
    author?: string;
    has_transcript?: boolean;
    thumbnail_path?: string;
    [k: string]: unknown;
  };
  order_index: number;
  thumbnail_url?: string;
  elements?: WsElement[];
}

export interface WsElement {
  id: string;
  resource_id: string;
  page: number;
  element_type: "text" | "heading" | "image" | "table" | "formula";
  order_index: number;
  bbox: [number, number, number, number] | null;
  content: string | null;
  image_path: string | null;
  image_url?: string;
}

export interface NoteAnchor {
  id?: string;
  note_id?: string;
  block_id: string;
  resource_id: string;
  anchor_type: AnchorType;
  anchor_start: number;
  anchor_end: number;
}

export interface Citation {
  n: number;
  resource_id: string;
  title: string;
  anchor_type: AnchorType;
  anchor_start: number;
  anchor_end: number;
  snippet?: string;
}

export interface Synthesis {
  status: SynthesisStatus;
  html?: string | null;
  source_ids: string[];
  title_suggestion?: string | null;
  error?: string | null;
  applied_at?: string | null;
  updated_at?: string | null;
}

export interface RecentSession {
  note_id: string;
  title: string;
  source_count: number;
  kinds: ResourceKind[];
  updated_at?: string;
}

export type SendAction =
  | { type: "text"; text: string }
  | { type: "image"; url: string; caption?: string }
  | { type: "table"; markdown: string }
  | { type: "latex"; latex: string }
  | { type: "checkpoint"; anchorType: AnchorType; value: number; label?: string }
  | { type: "clip"; url: string; label?: string }
  | { type: "audio"; url: string; label?: string };

// ── API helpers ──────────────────────────────────────────────────────────────

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body?.detail?.error || body?.error || msg;
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  return res.json();
}

export const wsApi = {
  /** Attach a file or URL. Without noteId the backend creates the note first. */
  addSource: (input: { file?: File; url?: string; noteId?: string | null; defer?: boolean }) => {
    const fd = new FormData();
    if (input.file) fd.set("file", input.file);
    if (input.url) fd.set("url", input.url);
    if (input.noteId) fd.set("note_id", input.noteId);
    if (input.defer) fd.set("defer", "true");
    return fetch("/api/ws/sources", { method: "POST", body: fd })
      .then((r) => j<{ note_id: string; source: NoteSource; deferred: boolean }>(r));
  },
  listSources: (noteId: string) =>
    fetch(`/api/ws/notes/${noteId}/sources`).then((r) => j<NoteSource[]>(r)),
  processSources: (noteId: string) =>
    fetch(`/api/ws/notes/${noteId}/process-sources`, { method: "POST" })
      .then((r) => j<{ ok: boolean; queued: number }>(r)),
  getSource: (sid: string) =>
    fetch(`/api/ws/sources/${sid}`).then((r) => j<NoteSource>(r)),
  sourceFileUrl: (sid: string) =>
    fetch(`/api/ws/sources/${sid}/file`).then((r) => j<{ url: string }>(r)),
  deleteSource: (sid: string) =>
    fetch(`/api/ws/sources/${sid}`, { method: "DELETE" })
      .then((r) => j<{ ok: boolean; note_id: string }>(r)),
  reprocessSource: (sid: string) =>
    fetch(`/api/ws/sources/${sid}/reprocess`, { method: "POST" }).then((r) => j(r)),
  capture: (sid: string, type: "frame" | "clip" | "audio", start: number, end?: number) =>
    fetch(`/api/ws/sources/${sid}/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, start, end }),
    }).then((r) => j<{ path: string; url: string; mime: string }>(r)),
  formulaLatex: (sid: string, elementId: string) =>
    fetch(`/api/ws/sources/${sid}/formula-latex`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ element_id: elementId }),
    }).then((r) => j<{ latex: string }>(r)),

  synthesize: (noteId: string, mode: "replace" | "append") =>
    fetch(`/api/ws/notes/${noteId}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }).then((r) => j<{ ok: boolean; status: string }>(r)),
  getSynthesis: (noteId: string) =>
    fetch(`/api/ws/notes/${noteId}/synthesis`).then((r) => j<Synthesis>(r)),
  markSynthesisApplied: (noteId: string) =>
    fetch(`/api/ws/notes/${noteId}/synthesis/applied`, { method: "POST" })
      .then((r) => j(r)),

  getAnchors: (noteId: string) =>
    fetch(`/api/ws/notes/${noteId}/anchors`).then((r) => j<NoteAnchor[]>(r)),
  putAnchors: (noteId: string, anchors: NoteAnchor[]) =>
    fetch(`/api/ws/notes/${noteId}/anchors`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(anchors),
    }).then((r) => j(r)),

  recentSessions: () =>
    fetch("/api/ws/sessions/recent").then((r) => j<RecentSession[]>(r)),
};

// ── display helpers ──────────────────────────────────────────────────────────

/** Stable per-source accent, keyed off order_index. With 4 sources in play,
 *  "which source is this from?" has to be answerable at a glance, and a colour
 *  dot is cheaper than repeating titles in every chip. */
export const SOURCE_COLORS = [
  "#6366f1", // indigo
  "#0ea5e9", // sky
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // violet
];

export function sourceColor(orderIndex: number): string {
  const n = SOURCE_COLORS.length;
  return SOURCE_COLORS[(((orderIndex ?? 0) % n) + n) % n];
}

/** Source-indexed anchor: "2:p:14" → { sourceIndex: 2, type: "page", value: 14 } */
export function parseSourceAnchor(
  v: string
): { sourceIndex: number; type: AnchorType; value: number } | null {
  const m = v.match(/^(\d+):([tps]):([\d.]+)$/);
  if (!m) return null;
  const type: AnchorType = m[2] === "t" ? "time" : m[2] === "p" ? "page" : "section";
  return { sourceIndex: parseInt(m[1], 10), type, value: parseFloat(m[3]) };
}

export function youtubeVideoId(url: string): string | null {
  const patterns = [
    /youtube\.com\/watch\?.*v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

export function fmtTime(seconds: number): string {
  const s = Math.floor(seconds);
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function anchorLabel(type: AnchorType, value: number): string {
  if (type === "time") return fmtTime(value);
  if (type === "page") return `p. ${Math.round(value)}`;
  return `§${Math.round(value)}`;
}
