"use client";

// The capture rail — one control surface shared by every time-based viewer
// (YouTube, uploaded video). A column of icon buttons pinned to the right edge
// of the media, hidden until the pointer is over it, driven by single-key
// shortcuts, and alive in fullscreen.
//
// Three things make that work, and each is load-bearing:
//
// 1. FULLSCREEN. The rail is a sibling of the media inside a wrapper, and it is
//    the *wrapper* that goes fullscreen — `Element.requestFullscreen()` shows
//    only that element's subtree, so fullscreening the <video> or the YouTube
//    <iframe> itself would leave the rail behind. Both players therefore hide
//    their own fullscreen button (`fs: 0` for the YouTube IFrame API,
//    `controlsList="nofullscreen"` for <video>, Chromium-only) and defer to the
//    rail's, which fullscreens the wrapper.
//
// 2. KEYBOARD. A cross-origin iframe keeps every keystroke to itself: once the
//    user clicks the YouTube player, keydown never reaches this document again
//    and the shortcuts die silently. So while the pointer is over the media we
//    take focus back off the iframe. That trades YouTube's own key handling for
//    ours — which is why the rail reimplements the essentials (play/pause,
//    ±5s). Mouse control of the YouTube UI is untouched.
//
// 3. VISIBILITY. A cross-origin iframe eats *every* pointer event, boundary
//    events included — measured, not assumed: with the YouTube player mounted,
//    the wrapper's `mouseenter` never fires at all, so a wrapper-hover trigger
//    leaves the rail permanently invisible. The only slice of the media that
//    can still report the pointer is one this document paints itself, so the
//    rail lives inside a narrow transparent hover zone along the right edge
//    (stopping short of the bottom, where every player keeps its transport
//    controls). A thin pull-tab marks the zone while the rail is hidden.
//    The wrapper is *also* watched, which is what drives the uploaded-video
//    player — no iframe there, so the whole surface reports hover normally.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines, Bookmark, Camera, Film, Keyboard, Loader2, Maximize2,
  Minimize2, Square, X,
} from "lucide-react";
import { fmtTime } from "@/lib/workspace";

export type CaptureKind = "frame" | "clip" | "audio";

/** Single keys, no modifiers — shown in every tooltip so they stay discoverable. */
const KEY = {
  checkpoint: "C",
  frame: "S",
  clip: "V",
  audio: "A",
  fullscreen: "F",
} as const;

interface CaptureDockProps {
  /** The element that goes fullscreen, and the hover scope for the shortcuts.
   *  Must be positioned (`relative`) and focusable (`tabIndex={-1}`). */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Current playhead, in seconds. */
  time: number;
  /** False while the player is still booting — every action is disabled. */
  ready?: boolean;
  /** Which capture is in flight, if any. */
  busy: CaptureKind | null;
  /** Start of an open clip/audio range, or null when none is open. */
  clipStart: number | null;
  onCheckpoint: () => void;
  onFrame: () => void;
  onRange: (kind: "clip" | "audio") => void;
  onCancelRange: () => void;
  /** Play/pause, for the keys the iframe can no longer receive itself. */
  onTogglePlay?: () => void;
  /** Seek by a delta in seconds (negative = back). */
  onSeekBy?: (delta: number) => void;
}

function RailButton({
  icon, label, shortcut, onClick, disabled, tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "accent" | "danger";
}) {
  return (
    <div className="relative group/rb">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={shortcut ? `${label} (shortcut ${shortcut})` : label}
        aria-keyshortcuts={shortcut?.toLowerCase()}
        className={`w-9 h-9 flex items-center justify-center rounded-xl transition-all duration-150
          active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed disabled:active:scale-100
          focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${
          tone === "accent"
            ? "ws-accent"
            : tone === "danger"
              ? "bg-red-500 text-white hover:bg-red-400 shadow-[0_4px_14px_-4px_rgba(239,68,68,0.9)]"
              : "text-white/65 hover:text-white hover:bg-white/12"
        }`}
      >
        {icon}
      </button>
      {/* tooltip, to the left — the rail hugs the right edge */}
      <span
        className="pointer-events-none absolute right-full top-1/2 -translate-y-1/2 mr-2.5
          hidden group-hover/rb:flex group-focus-within/rb:flex items-center gap-1.5
          whitespace-nowrap px-2 py-1 rounded-lg ws-glass-dark text-[11px] font-medium text-white/90"
      >
        {label}
        {shortcut && (
          <kbd className="px-1.5 py-px rounded bg-white/15 font-mono text-[10px] leading-4 text-white/80">
            {shortcut}
          </kbd>
        )}
      </span>
    </div>
  );
}

export function CaptureDock({
  containerRef, time, ready = true, busy, clipStart,
  onCheckpoint, onFrame, onRange, onCancelRange, onTogglePlay, onSeekBy,
}: CaptureDockProps) {
  const [zoneHover, setZoneHover] = useState(false);
  const [stageHover, setStageHover] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const recording = clipStart !== null;
  const locked = !ready || busy !== null;
  const hovering = zoneHover || stageHover;
  // Never hide the rail out from under work in progress.
  const visible = hovering || focusWithin || recording || busy !== null;

  // ── fullscreen (on the wrapper, so this rail comes along) ──────────────────
  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => {});
    }
  }, [containerRef]);

  useEffect(() => {
    function onChange() {
      const full = document.fullscreenElement === containerRef.current;
      setIsFullscreen(full);
      // Entering fullscreen does not fire mouseenter, so reveal the rail
      // explicitly — otherwise the tools are invisible at the exact moment the
      // user has committed to the video.
      if (full) setZoneHover(true);
    }
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [containerRef]);

  // ── pointer presence over the wrapper ─────────────────────────────────────
  // Real for the uploaded-video player; silent whenever a cross-origin iframe
  // covers the wrapper, which is what the hover zone below exists for.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const enter = () => setStageHover(true);
    const leave = () => setStageHover(false);
    el.addEventListener("mouseenter", enter);
    el.addEventListener("mouseleave", leave);
    return () => {
      el.removeEventListener("mouseenter", enter);
      el.removeEventListener("mouseleave", leave);
    };
  }, [containerRef]);

  // ── take the keyboard back from a cross-origin iframe ─────────────────────
  // Clicking the YouTube player moves focus into its iframe, and from then on
  // every keystroke belongs to YouTube — this document stops seeing keydown at
  // all. Focus *is* observable from out here though: the top window blurs and
  // `document.activeElement` becomes the iframe element. Catch that and hand
  // focus back to the wrapper, which is also what makes the shortcuts "hot".
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function reclaim() {
      // activeElement settles a tick after the focus actually moves.
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active.tagName === "IFRAME" && el?.contains(active)) {
          (active as HTMLElement).blur();
          el.focus({ preventScroll: true });
        }
      }, 0);
    }
    window.addEventListener("blur", reclaim);
    document.addEventListener("focusin", reclaim);
    return () => {
      window.removeEventListener("blur", reclaim);
      document.removeEventListener("focusin", reclaim);
    };
  }, [containerRef]);

  // ── shortcuts ─────────────────────────────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable
        || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

      const el = containerRef.current;
      if (!el) return;
      // Scoped, so these letters stay usable everywhere else in the app: the
      // player must be fullscreen, hovered, or holding focus.
      const hot = document.fullscreenElement === el
        || hovering
        || el.contains(document.activeElement);
      if (!hot) return;

      const key = e.key.toLowerCase();
      const run = (fn: () => void) => { e.preventDefault(); fn(); };

      if (key === "escape" && recording) return run(onCancelRange);
      if (key === " " || key === "k") return onTogglePlay ? run(onTogglePlay) : undefined;
      if (key === "arrowleft") return onSeekBy ? run(() => onSeekBy(-5)) : undefined;
      if (key === "arrowright") return onSeekBy ? run(() => onSeekBy(5)) : undefined;
      if (key === KEY.fullscreen.toLowerCase()) return run(toggleFullscreen);
      if (!ready) return;
      if (key === KEY.checkpoint.toLowerCase()) return run(onCheckpoint);
      if (busy !== null) return;
      if (key === KEY.frame.toLowerCase()) return run(onFrame);
      if (key === KEY.clip.toLowerCase()) return run(() => onRange("clip"));
      if (key === KEY.audio.toLowerCase()) return run(() => onRange("audio"));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    containerRef, hovering, recording, ready, busy, toggleFullscreen,
    onCheckpoint, onFrame, onRange, onCancelRange, onTogglePlay, onSeekBy,
  ]);

  const spin = <Loader2 size={16} className="animate-spin" />;

  return (
    <>
      {/* the open range — never auto-hidden, it is state the user must see */}
      {recording && (
        <div className="ws-glass-dark ws-rise absolute top-3 right-3 z-40 flex items-center gap-2
          h-8 pl-2.5 pr-3 rounded-full text-[12px] text-white">
          <span className="ws-recording w-2 h-2 rounded-full bg-red-500 shrink-0" />
          <span className="font-mono tabular-nums tracking-tight">
            {fmtTime(clipStart)} → {fmtTime(Math.max(time, clipStart))}
          </span>
        </div>
      )}

      {/* The hover zone. It stops 4rem short of the bottom so the player's own
          transport controls stay clickable; in exchange, clicks on this narrow
          right-edge strip go to the rail instead of to the video. */}
      <div
        onMouseEnter={() => setZoneHover(true)}
        onMouseLeave={() => setZoneHover(false)}
        className="absolute right-0 top-0 bottom-16 w-16 z-40 flex items-center justify-end pr-2"
      >
        {/* pull tab — the only thing on screen while the rail is away */}
        <span
          aria-hidden
          className={`absolute right-2 w-1 h-10 rounded-full bg-white/30 transition-opacity duration-200 ${
            visible ? "opacity-0" : "opacity-100"
          }`}
        />

        <div
          role="toolbar"
          aria-label="Capture tools"
          aria-hidden={!visible}
          onFocus={() => setFocusWithin(true)}
          onBlur={() => setFocusWithin(false)}
          className={`ws-glass-dark flex flex-col items-center gap-1 p-1.5 rounded-2xl
            transition-all duration-200 ease-out ${
            visible
              ? "opacity-100 translate-x-0"
              : "opacity-0 translate-x-5 pointer-events-none"
          }`}
        >
          <RailButton
            tone="accent"
            label="Checkpoint"
            shortcut={KEY.checkpoint}
            disabled={!ready}
            icon={<Bookmark size={16} />}
            onClick={onCheckpoint}
          />

          <span className="w-5 h-px bg-white/12 my-0.5" />

          <RailButton
            label="Capture frame"
            shortcut={KEY.frame}
            disabled={locked}
            icon={busy === "frame" ? spin : <Camera size={16} />}
            onClick={onFrame}
          />
          <RailButton
            tone={recording ? "danger" : "default"}
            label={recording ? "End clip here" : "Start a clip"}
            shortcut={KEY.clip}
            disabled={locked}
            icon={busy === "clip" ? spin
              : recording ? <Square size={13} fill="currentColor" />
              : <Film size={16} />}
            onClick={() => onRange("clip")}
          />
          <RailButton
            tone={recording ? "danger" : "default"}
            label={recording ? "End audio here" : "Start an audio excerpt"}
            shortcut={KEY.audio}
            disabled={locked}
            icon={busy === "audio" ? spin : <AudioLines size={16} />}
            onClick={() => onRange("audio")}
          />
          {recording && (
            <RailButton
              label="Discard this range"
              shortcut="Esc"
              icon={<X size={16} />}
              onClick={onCancelRange}
            />
          )}

          <span className="w-5 h-px bg-white/12 my-0.5" />

          <RailButton
            label={isFullscreen ? "Leave fullscreen" : "Fullscreen"}
            shortcut={KEY.fullscreen}
            icon={isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            onClick={toggleFullscreen}
          />

          {/* the whole shortcut sheet, on hover */}
          <div className="relative group/keys">
            <span className="w-9 h-7 flex items-center justify-center rounded-xl text-white/35
              hover:text-white/80 transition-colors cursor-help">
              <Keyboard size={15} />
            </span>
            <span className="pointer-events-none absolute right-full bottom-0 mr-2.5 hidden
              group-hover/keys:grid grid-cols-[auto_auto] items-center gap-x-3 gap-y-1
              whitespace-nowrap px-3 py-2.5 rounded-xl ws-glass-dark text-[11px] text-white/85">
              {([
                ["Play / pause", "Space"],
                ["Back / forward 5s", "← →"],
                ["Checkpoint", KEY.checkpoint],
                ["Capture frame", KEY.frame],
                ["Clip start / end", KEY.clip],
                ["Audio start / end", KEY.audio],
                ["Fullscreen", KEY.fullscreen],
              ] as const).map(([label, key]) => (
                <span key={label} className="contents">
                  <span className="text-white/60">{label}</span>
                  <kbd className="justify-self-end px-1.5 py-px rounded bg-white/15 font-mono text-[10px] leading-4">
                    {key}
                  </kbd>
                </span>
              ))}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
