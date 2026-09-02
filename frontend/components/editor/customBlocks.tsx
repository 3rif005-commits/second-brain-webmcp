"use client";

// Custom BlockNote blocks used by workspace notes (and available everywhere):
//   math       — KaTeX-rendered LaTeX, click to edit the source
//   checkpoint — deep link to an exact spot in a workspace resource
//                (timestamp for video, page for documents, section for websites)
import { useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import katex from "katex";
import "katex/dist/katex.min.css";

function MathRenderer({ latex }: { latex: string }) {
  let html = "";
  let error = false;
  try {
    html = katex.renderToString(latex || "\\text{empty formula}", {
      displayMode: true,
      throwOnError: false,
    });
  } catch {
    error = true;
  }
  if (error) return <code className="text-red-500 text-sm">{latex}</code>;
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MathBlockView({ block, editor }: { block: any; editor: any }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(block.props.latex ?? "");

  if (editing) {
    return (
      <div className="w-full my-1 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-900/20 p-2">
        <textarea
          autoFocus
          className="w-full bg-transparent font-mono text-sm outline-none resize-y min-h-[48px] text-gray-800 dark:text-gray-200"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              editor.updateBlock(block, { props: { latex: draft } });
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
          placeholder="LaTeX, e.g. \int_0^1 x^2\,dx"
        />
        <div className="flex items-center justify-between mt-1">
          <div className="text-gray-700 dark:text-gray-300 overflow-x-auto">
            <MathRenderer latex={draft} />
          </div>
          <button
            className="text-xs px-2 py-1 rounded bg-indigo-500 text-white hover:bg-indigo-600 shrink-0"
            onClick={() => {
              editor.updateBlock(block, { props: { latex: draft } });
              setEditing(false);
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-full my-1 py-1 px-2 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 overflow-x-auto text-gray-800 dark:text-gray-200"
      title="Click to edit LaTeX"
      onClick={() => {
        setDraft(block.props.latex ?? "");
        setEditing(true);
      }}
    >
      <MathRenderer latex={block.props.latex ?? ""} />
    </div>
  );
}

export const MathBlockSpec = createReactBlockSpec(
  {
    type: "math",
    propSchema: {
      latex: { default: "" },
    },
    content: "none",
  },
  {
    render: (props) => <MathBlockView block={props.block} editor={props.editor} />,
    parse: (element: HTMLElement) => {
      if (element.getAttribute("data-type") !== "math") return undefined;
      // Same defensive pattern as CalloutBlockSpec below: BlockNote auto-maps
      // `data-<kebab-prop>` attributes matching the propSchema onto the block's
      // props AFTER parse() runs, which would silently override whatever parse()
      // returns for any prop whose kebab name is present as a data attribute.
      // `latex` here comes from textContent, not a `data-latex` attribute, so
      // there's no live collision today — but removing `data-type` keeps this
      // element's markup consistent and safe against a future propSchema change.
      element.removeAttribute("data-type");
      return { latex: element.textContent?.trim() || "" };
    },
  }
);

function checkpointHref(p: {
  noteId: string; resourceId: string; anchorType: string; value: string;
}): string {
  const key = p.anchorType === "time" ? "t" : p.anchorType === "page" ? "p" : "s";
  return `/brain/workspace/${p.noteId}?source=${p.resourceId}&${key}=${p.value}`;
}

function fmtAnchor(anchorType: string, value: string): string {
  if (anchorType === "time") {
    const s = Math.floor(Number(value) || 0);
    const mm = Math.floor(s / 60);
    return `${mm}:${String(s % 60).padStart(2, "0")}`;
  }
  if (anchorType === "page") return `p. ${value}`;
  return `§${value}`;
}

export const CheckpointBlockSpec = createReactBlockSpec(
  {
    type: "checkpoint",
    propSchema: {
      noteId: { default: "" },
      // Deprecated: kept in the schema so checkpoint blocks written before the
      // workspaces redesign still parse instead of breaking their note. Such a
      // block has no noteId and renders as a dead pill below.
      workspaceId: { default: "" },
      resourceId: { default: "" },
      anchorType: { default: "time" }, // time | page | section
      value: { default: "0" },
      label: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const p = block.props;
      const body = (
        <>
          <span>{p.anchorType === "time" ? "⏱" : "📍"}</span>
          <span>{p.label || "Checkpoint"}</span>
          <span className="opacity-70">{fmtAnchor(p.anchorType, p.value)}</span>
        </>
      );
      // A checkpoint left behind by the old canvas model has nowhere to link to.
      if (!p.noteId || !p.resourceId) {
        return (
          <span
            title="This checkpoint's source is no longer available"
            className="inline-flex items-center gap-1.5 my-0.5 px-2.5 py-1 rounded-full border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-400 text-xs font-medium"
            contentEditable={false}
          >
            {body}
          </span>
        );
      }
      return (
        <a
          href={checkpointHref(p)}
          className="inline-flex items-center gap-1.5 my-0.5 px-2.5 py-1 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200 text-xs font-medium no-underline hover:bg-amber-100 dark:hover:bg-amber-900/50 transition-colors cursor-pointer"
          contentEditable={false}
        >
          {body}
        </a>
      );
    },
  }
);

export type CalloutType =
  | "OVERVIEW" | "NOTE" | "TIP" | "IMPORTANT" | "WARNING"
  | "CAUTION" | "FORMULA" | "ANALOGY" | "EXAM";

export const CALLOUT_PALETTE: Record<CalloutType, { color: string; icon: string; label: string }> = {
  OVERVIEW:  { color: "blue",   icon: "📋", label: "Overview" },
  NOTE:      { color: "gray",   icon: "ℹ️", label: "Note" },
  TIP:       { color: "green",  icon: "💡", label: "Tip" },
  IMPORTANT: { color: "yellow", icon: "❗", label: "Important" },
  WARNING:   { color: "orange", icon: "⚠️", label: "Warning" },
  CAUTION:   { color: "red",    icon: "🛑", label: "Caution" },
  FORMULA:   { color: "purple", icon: "📐", label: "Formula" },
  ANALOGY:   { color: "brown",  icon: "💭", label: "Analogy" },
  EXAM:      { color: "pink",   icon: "🎯", label: "Exam" },
};

const CALLOUT_COLOR_CLASSES: Record<string, string> = {
  blue:   "bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-700",
  gray:   "bg-gray-50 border-gray-300 dark:bg-gray-800/40 dark:border-gray-600",
  green:  "bg-green-50 border-green-300 dark:bg-green-900/20 dark:border-green-700",
  yellow: "bg-yellow-50 border-yellow-300 dark:bg-yellow-900/20 dark:border-yellow-700",
  orange: "bg-orange-50 border-orange-300 dark:bg-orange-900/20 dark:border-orange-700",
  red:    "bg-red-50 border-red-300 dark:bg-red-900/20 dark:border-red-700",
  purple: "bg-purple-50 border-purple-300 dark:bg-purple-900/20 dark:border-purple-700",
  brown:  "bg-[#f5efe8] border-[#c9a876] dark:bg-[#3a2f22]/40 dark:border-[#7a6142]",
  pink:   "bg-pink-50 border-pink-300 dark:bg-pink-900/20 dark:border-pink-700",
};

function CalloutBlockView({ block }: { block: any }) {
  const rawType = block.props.calloutType as string;
  const type: CalloutType = rawType in CALLOUT_PALETTE ? (rawType as CalloutType) : "NOTE";
  const { color, icon, label } = CALLOUT_PALETTE[type];
  return (
    <div
      className={`w-full my-1 px-3 py-2 rounded-lg border ${CALLOUT_COLOR_CLASSES[color]}`}
      contentEditable={false}
    >
      <div className="flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-200">
        <span>{icon}</span>
        <span>{label}</span>
      </div>
    </div>
  );
}

export const CalloutBlockSpec = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      calloutType: { default: "NOTE" as CalloutType },
    },
    content: "none",
  },
  {
    render: (props) => <CalloutBlockView block={props.block} />,
    parse: (element: HTMLElement) => {
      if (element.getAttribute("data-type") !== "callout") return undefined;
      const raw = element.getAttribute("data-callout-type");
      // BlockNote auto-maps `data-<kebab-prop>` attributes matching the
      // propSchema (here, `data-callout-type` -> `calloutType`) onto the
      // block's props AFTER this parse() function runs. If left in place,
      // that auto-mapping would silently override whatever we return below
      // with the raw, unvalidated `data-callout-type` value — defeating the
      // unknown-calloutType-falls-back-to-NOTE behavior a few lines down.
      // Removing it here makes our validated return value the final answer.
      element.removeAttribute("data-callout-type");
      element.removeAttribute("data-type");
      if (!raw || !(raw in CALLOUT_PALETTE)) {
        return { calloutType: "NOTE" };
      }
      return { calloutType: raw as CalloutType };
    },
  }
);
