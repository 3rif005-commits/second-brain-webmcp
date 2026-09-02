"use client";

// Note tools.
//
// The interesting one here is `read`. The app encodes a lot of a note's
// meaning in visual channels — a callout's semantic type reaches the reader as
// a coloured box with an icon, a section's weight as a 0-6 background tint —
// and an agent working from a screenshot gets none of it reliably. `read`
// returns the projection instead, so the agent receives what the colour stands
// for rather than the colour.
//
// It also reads the *live* editor document rather than the persisted copy.
// Autosave is on a two-second debounce, so anything else would answer about
// the note as it was a moment ago, which is exactly when a user is most likely
// to be asking about the sentence they just typed.

import type { WebMcpToolDef } from "../types";
import { errorResult, json, text } from "../types";
import { projectBlocks, projectMastery } from "../project";

interface BlockLike {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: BlockLike[];
}

export interface NoteToolContext {
  noteId: string;
  title: string;
  mastery: string | null;
  topics: string[];
  /** The live document. Null while the editor is still mounting. */
  getBlocks: () => BlockLike[] | null;
  appendMarkdown: (markdown: string) => Promise<void>;
  setMastery: (status: string) => Promise<void>;
  openNote: (noteId: string) => void;
}

const MASTERY = ["not_started", "learning", "reviewing", "mastered"];

export function buildNoteTools(ctx: NoteToolContext): WebMcpToolDef[] {
  return [
    {
      name: "note.read",
      description:
        `Read the note the user currently has open ("${ctx.title}"), as an annotated ` +
        `outline. Includes what the formatting means — callout types such as EXAM or ` +
        `CAUTION, and the 0-6 importance scale rendered as a background tint — which a ` +
        `screenshot of the page would not tell you. Reflects unsaved edits.`,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: () => {
        const blocks = ctx.getBlocks();
        if (!blocks) return errorResult("The editor is still loading.");
        return text(
          [
            `# ${ctx.title}`,
            `id: ${ctx.noteId}`,
            projectMastery(ctx.mastery),
            ctx.topics.length ? `topics: ${ctx.topics.join(", ")}` : null,
            "",
            ...projectBlocks(blocks),
          ]
            .filter((line) => line !== null)
            .join("\n")
        );
      },
    },

    {
      name: "note.get-open",
      description:
        "Which note the user is looking at right now — id, title and mastery status. " +
        "Cheap; call it when you need to know what 'this note' refers to.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: () =>
        json({
          id: ctx.noteId,
          title: ctx.title,
          mastery: ctx.mastery,
          topics: ctx.topics,
        }),
    },

    {
      name: "note.append",
      description:
        `Append content to the end of "${ctx.title}". Takes Markdown — headings, lists, ` +
        `code fences and tables all convert. The text lands in the editor immediately and ` +
        `saves the way a typed edit does, so the user can undo it.`,
      inputSchema: {
        type: "object",
        properties: {
          markdown: { type: "string", description: "Markdown to append." },
        },
        required: ["markdown"],
      },
      execute: async (input) => {
        const markdown = String(input?.markdown ?? "").trim();
        if (!markdown) return errorResult("markdown is required.");
        await ctx.appendMarkdown(markdown);
        return text(`Appended ${markdown.length} characters to "${ctx.title}".`);
      },
    },

    {
      name: "note.set-mastery",
      description:
        `Set how well the user knows "${ctx.title}". Shown in the UI as a coloured badge.`,
      inputSchema: {
        type: "object",
        properties: { status: { type: "string", enum: MASTERY } },
        required: ["status"],
      },
      execute: async (input) => {
        const status = String(input?.status ?? "");
        if (!MASTERY.includes(status)) {
          return errorResult(`status must be one of: ${MASTERY.join(", ")}`);
        }
        await ctx.setMastery(status);
        return text(`Set mastery of "${ctx.title}" to ${status}.`);
      },
    },

    {
      name: "note.search",
      description:
        "Search the user's notes by keyword and return matches with their ids and titles. " +
        "Use note.open to take the user to one.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for." },
        },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
      execute: async (input) => {
        const query = String(input?.query ?? "").trim();
        if (!query) return errorResult("query is required.");
        const res = await fetch(`/api/notes/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) return errorResult(`Search failed (HTTP ${res.status}).`);
        const body = await res.json();
        const rows = Array.isArray(body) ? body : (body?.notes ?? body?.results ?? []);
        if (!rows.length) return text(`No notes matched "${query}".`);
        return json(
          rows.slice(0, 10).map((n: Record<string, unknown>) => ({
            id: n.id,
            title: n.title,
            mastery: n.mastery_status,
          }))
        );
      },
    },

    {
      name: "note.open",
      description:
        "Navigate the user to a note by id. This moves what is on their screen — use it " +
        "when your answer is about a note they are not currently looking at.",
      inputSchema: {
        type: "object",
        properties: { noteId: { type: "string" } },
        required: ["noteId"],
      },
      execute: (input) => {
        const id = String(input?.noteId ?? "").trim();
        if (!id) return errorResult("noteId is required.");
        ctx.openNote(id);
        return text(`Opened note ${id}.`);
      },
    },
  ];
}
