"use client";

// Website source viewer — clean readable sections extracted server-side
// (trafilatura). Every section is a selectable element with one-click send.
import { useCallback, useEffect, useRef, useState } from "react";
import { Bookmark, Copy, CornerDownRight, ExternalLink, X } from "lucide-react";
import type { SendAction, WsElement, NoteSource } from "@/lib/workspace";
import { ActionBar, ActionButton, ActionSeparator } from "./ActionBar";

interface WebsiteViewerProps {
  resource: NoteSource;
  onPosition: (sectionIndex: number) => void;
  onAction: (action: SendAction) => void;
  seekRef: React.MutableRefObject<((value: number) => void) | null>;
}

export function WebsiteViewer({ resource, onPosition, onAction, seekRef }: WebsiteViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [active, setActive] = useState<{ el: WsElement; x: number; y: number } | null>(null);
  const currentSection = useRef(0);

  const elements = resource.elements ?? [];

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const top = container.scrollTop + 80;
    let idx = 0;
    for (const [num, el] of Object.entries(sectionRefs.current)) {
      if (el && el.offsetTop <= top) idx = Math.max(idx, Number(num));
    }
    if (idx !== currentSection.current) {
      currentSection.current = idx;
      onPosition(idx);
    }
    setActive(null);
  }, [onPosition]);

  useEffect(() => {
    seekRef.current = (idx: number) => {
      sectionRefs.current[Math.round(idx)]?.scrollIntoView({
        behavior: "smooth", block: "start",
      });
    };
    return () => { seekRef.current = null; };
  }, [seekRef]);

  function sectionClick(e: React.MouseEvent, el: WsElement) {
    const container = containerRef.current;
    if (!container) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const crect = container.getBoundingClientRect();
    setActive({
      el,
      x: rect.left + rect.width / 2 - crect.left,
      y: rect.top - crect.top + container.scrollTop,
    });
  }

  return (
    <div
      ref={containerRef}
      className="relative flex-1 overflow-y-auto bg-white dark:bg-gray-900"
      onScroll={handleScroll}
    >
      <div className="max-w-2xl mx-auto px-6 py-6">
        <a
          href={resource.source_url ?? "#"}
          target="_blank"
          rel="noreferrer"
          title={resource.source_url ?? ""}
          className="inline-flex max-w-full items-center gap-1.5 mb-5 px-2.5 py-1 rounded-full
            bg-gray-100 dark:bg-gray-800/70 text-[11px] text-gray-500 dark:text-gray-400
            hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors"
        >
          <ExternalLink size={11} className="shrink-0" />
          <span className="truncate">{resource.source_url}</span>
        </a>
        {elements.map((el) => (
          <div
            key={el.id}
            ref={(node) => { sectionRefs.current[el.order_index] = node; }}
            className="group rounded-md px-2 -mx-2 py-1 cursor-pointer hover:bg-indigo-50/60 dark:hover:bg-indigo-900/20 transition-colors"
            onClick={(e) => sectionClick(e, el)}
          >
            {el.element_type === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={el.content ?? ""} alt="" className="max-w-full rounded-lg my-2" />
            ) : el.element_type === "heading" ? (
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mt-4 mb-1">
                {el.content}
              </h2>
            ) : (
              <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-300 mb-2">
                {el.content}
              </p>
            )}
          </div>
        ))}
        {elements.length === 0 && (
          <p className="text-sm text-gray-400 py-8">No readable content extracted.</p>
        )}
      </div>

      {active && (
        <ActionBar x={active.x} y={active.y}>
          <ActionButton primary title="Send this section to the note" onClick={() => {
            const el = active.el;
            setActive(null);
            if (el.element_type === "image") {
              onAction({ type: "image", url: el.content ?? "" });
            } else {
              onAction({ type: "text", text: el.content ?? "" });
            }
          }}>
            <CornerDownRight size={12} /> Send to note
          </ActionButton>
          <ActionButton title="Copy to clipboard" onClick={() => {
            navigator.clipboard.writeText(active.el.content ?? "").catch(() => {});
            setActive(null);
          }}>
            <Copy size={12} /> Copy
          </ActionButton>
          <ActionButton title="Bookmark this section in the note" onClick={() => {
            onAction({
              type: "checkpoint", anchorType: "section",
              value: active.el.order_index,
              label: (active.el.content ?? "").slice(0, 40),
            });
            setActive(null);
          }}>
            <Bookmark size={12} /> Checkpoint
          </ActionButton>
          <ActionSeparator />
          <ActionButton title="Dismiss" onClick={() => setActive(null)}>
            <X size={12} />
          </ActionButton>
        </ActionBar>
      )}
    </div>
  );
}
