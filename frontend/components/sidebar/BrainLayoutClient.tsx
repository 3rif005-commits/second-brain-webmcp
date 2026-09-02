"use client";

import { useState, useEffect } from "react";
import { Menu, PanelLeftOpen } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { SearchModal } from "@/components/search/SearchModal";
import { SidePanel, SidePanelToggleButton } from "@/components/ai/SidePanel";
import { CommandK, CommandKFAB, type CommandKStage } from "@/components/ai/CommandK";
import { AIThreadProvider } from "@/context/AIThreadContext";
import { IngestStreamDialog } from "@/components/ingestion/IngestStreamDialog";
import type { IngestSource } from "@/components/ingestion/IngestDropzone";

const AI_PANEL_DEFAULT_WIDTH = 360;
const AI_PANEL_MIN_WIDTH = 280;
const AI_PANEL_MAX_WIDTH = 600;

export function BrainLayoutClient({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [aiOpen, setAiOpen] = useState<boolean | null>(null);
  const [aiPanelWidth, setAiPanelWidth] = useState(AI_PANEL_DEFAULT_WIDTH);
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth >= 768 : true
  );
  const [commandKStage, setCommandKStage] = useState<CommandKStage>("closed");
  const [searchOpen, setSearchOpen] = useState(false);
  const [ingestSource, setIngestSource] = useState<IngestSource | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-open");
    setOpen(stored !== null ? stored === "true" : window.innerWidth >= 768);

    const aiStored = localStorage.getItem("ai-panel-open");
    let aiInitial = aiStored !== null ? aiStored === "true" : false;

    const widthStored = localStorage.getItem("ai-panel-width");
    if (widthStored) {
      const w = parseInt(widthStored);
      if (w >= AI_PANEL_MIN_WIDTH && w <= AI_PANEL_MAX_WIDTH) setAiPanelWidth(w);
    }

    // ?ai=open in URL → auto-open AI panel and strip the param
    const params = new URLSearchParams(window.location.search);
    if (params.get("ai") === "open") {
      aiInitial = true;
      params.delete("ai");
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params}`
        : window.location.pathname;
      window.history.replaceState(null, "", newUrl);
    }
    setAiOpen(aiInitial);

    // Track desktop vs mobile for the push-layout logic
    const mq = window.matchMedia("(min-width: 768px)");
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "k") {
        e.preventDefault();
        setCommandKStage((prev) => prev === "closed" ? "compact" : "closed");
      }
      if (mod && e.key === "p") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    function onDragOver(e: DragEvent) {
      e.preventDefault();
    }
    function onDrop(e: DragEvent) {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) setIngestSource({ type: "file", file });
    }
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      localStorage.setItem("sidebar-open", String(next));
      return next;
    });
  }

  function toggleAi() {
    setAiOpen((prev) => {
      const next = !prev;
      localStorage.setItem("ai-panel-open", String(next));
      return next;
    });
  }

  function handleAiWidthChange(width: number) {
    const clamped = Math.max(AI_PANEL_MIN_WIDTH, Math.min(AI_PANEL_MAX_WIDTH, Math.round(width)));
    setAiPanelWidth(clamped);
    localStorage.setItem("ai-panel-width", String(clamped));
  }

  const isOpen = open ?? true;
  const isAiOpen = aiOpen ?? false;

  return (
    <AIThreadProvider>
      <div className="print-layout flex h-screen overflow-hidden bg-white dark:bg-gray-900">

        {/* Mobile backdrop for notes sidebar */}
        {isOpen && (
          <div
            className="no-print fixed inset-0 z-20 bg-black/40 md:hidden"
            onClick={toggle}
          />
        )}

        {/* Notes sidebar */}
        <div
          className={[
            "no-print transition-all duration-200 ease-in-out flex-shrink-0",
            "fixed inset-y-0 left-0 z-30",
            "md:relative md:inset-auto md:z-auto",
            isOpen
              ? "translate-x-0 md:w-[260px]"
              : "-translate-x-full md:translate-x-0 md:w-0",
          ].join(" ")}
          style={{ overflow: isOpen ? "visible" : "hidden" }}
        >
          <Sidebar onToggle={toggle} onSearchOpen={() => setSearchOpen(true)} />
        </div>

        {/* Desktop: floating reopen button for notes sidebar */}
        {!isOpen && (
          <button
            onClick={toggle}
            aria-label="Open sidebar"
            className="no-print hidden md:flex fixed top-3 left-3 z-10 items-center justify-center w-8 h-8 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 shadow-sm transition-colors"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}

        {/* Main area — shifts right on desktop when AI panel is open */}
        <main
          className="print-main group/shell flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden"
          data-sidebar={isOpen ? "open" : "collapsed"}
          style={{
            marginRight: isAiOpen && isDesktop ? aiPanelWidth : 0,
            transition: "margin-right 200ms ease-in-out",
          }}
        >
          {/* Mobile-only top bar */}
          <div className="no-print md:hidden flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shrink-0">
            <button
              onClick={toggle}
              aria-label="Open menu"
              className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <Menu size={20} />
            </button>
            <span className="font-semibold text-gray-900 dark:text-gray-100 text-sm">Second Brain</span>
          </div>

          {children}
        </main>

        {/* AI side panel — fixed right, width matches content margin */}
        <SidePanel
          open={isAiOpen}
          onToggle={toggleAi}
          width={aiPanelWidth}
          onWidthChange={handleAiWidthChange}
        />

        {/* Floating reopen button for AI panel (desktop, when closed) */}
        {!isAiOpen && <SidePanelToggleButton onClick={toggleAi} />}

        <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />

        <CommandK open={commandKStage} onOpen={setCommandKStage} />
        <CommandKFAB onClick={() => setCommandKStage("compact")} />
      </div>
      <IngestStreamDialog
        source={ingestSource}
        onClose={() => setIngestSource(null)}
      />
    </AIThreadProvider>
  );
}
