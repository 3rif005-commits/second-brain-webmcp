"use client";

// YouTube source viewer — official IFrame Player API wrapper.
// Cross-origin video means frames/clips/audio are captured server-side
// (yt-dlp section download + ffmpeg) via /capture.
import { useEffect, useRef, useState } from "react";
import { fmtTime, wsApi, youtubeVideoId, type SendAction, type NoteSource } from "@/lib/workspace";
import { useToast } from "@/app/providers";
import { CaptureDock, type CaptureKind } from "./CaptureDock";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    YT: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;
function loadYouTubeApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    });
  }
  return apiPromise;
}

interface YouTubePlayerProps {
  resource: NoteSource;
  onPosition: (seconds: number) => void;
  onAction: (action: SendAction) => void;
  seekRef: React.MutableRefObject<((value: number) => void) | null>;
}

export function YouTubePlayer({ resource, onPosition, onAction, seekRef }: YouTubePlayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [clipStart, setClipStart] = useState<number | null>(null);
  const [busy, setBusy] = useState<CaptureKind | null>(null);
  // timeRef is what the capture calls read (no re-render needed); `time` is the
  // rendered copy, so the dock's readout actually ticks instead of sitting on
  // whatever it happened to be at the last render.
  const [time, setTime] = useState(0);
  const timeRef = useRef(0);
  const { showToast } = useToast();

  const videoId = youtubeVideoId(resource.source_url || "");

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    loadYouTubeApi().then(() => {
      if (cancelled || !hostRef.current || !videoId) return;
      playerRef.current = new window.YT.Player(hostRef.current, {
        videoId,
        width: "100%",
        height: "100%",
        // fs: 0 drops YouTube's own fullscreen button. Its button fullscreens
        // the iframe, which would leave the capture rail behind — the rail's
        // button fullscreens the wrapper instead. See CaptureDock.
        playerVars: { rel: 0, modestbranding: 1, fs: 0 },
        events: {
          onReady: () => {
            setReady(true);
            interval = setInterval(() => {
              try {
                const t = playerRef.current?.getCurrentTime?.() ?? 0;
                if (Math.abs(t - timeRef.current) > 0.4) {
                  timeRef.current = t;
                  setTime(t);
                  onPosition(t);
                }
              } catch { /* player not ready */ }
            }, 500);
          },
        },
      });
    });
    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      try { playerRef.current?.destroy?.(); } catch { /* already gone */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  useEffect(() => {
    seekRef.current = (t: number) => {
      try {
        playerRef.current?.seekTo?.(t, true);
        playerRef.current?.playVideo?.();
      } catch { /* not ready */ }
    };
    return () => { seekRef.current = null; };
  }, [seekRef]);

  async function captureFrame() {
    const t = timeRef.current;
    setBusy("frame");
    try {
      const r = await wsApi.capture(resource.id, "frame", t);
      onAction({ type: "image", url: r.url, caption: `Frame @ ${fmtTime(t)}` });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Frame capture failed");
    } finally { setBusy(null); }
  }

  // Clips and audio need a range: the first press marks the start, the second
  // closes it. Either button can close a range that the other one opened.
  async function captureRange(type: "clip" | "audio") {
    const t = timeRef.current;
    if (clipStart === null) {
      setClipStart(t);
      return;
    }
    const [a, b] = clipStart < t ? [clipStart, t] : [t, clipStart];
    setClipStart(null);
    setBusy(type);
    try {
      const r = await wsApi.capture(resource.id, type, a, b);
      onAction({ type, url: r.url, label: `${type} ${fmtTime(a)}–${fmtTime(b)}` });
    } catch (e) {
      showToast(e instanceof Error ? e.message : `${type} capture failed`);
    } finally { setBusy(null); }
  }

  if (!videoId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-red-400">
        Invalid YouTube URL
      </div>
    );
  }

  // Keys the iframe can no longer act on for itself, now that the rail keeps
  // focus in this document (see CaptureDock).
  function togglePlay() {
    const p = playerRef.current;
    try {
      // 1 === YT.PlayerState.PLAYING
      if (p?.getPlayerState?.() === 1) p.pauseVideo();
      else p?.playVideo?.();
    } catch { /* not ready */ }
  }

  function seekBy(delta: number) {
    const p = playerRef.current;
    try {
      p?.seekTo?.(Math.max(0, (p.getCurrentTime?.() ?? 0) + delta), true);
    } catch { /* not ready */ }
  }

  return (
    <div
      ref={stageRef}
      tabIndex={-1}
      className="relative flex-1 min-h-0 bg-[#08090d] outline-none"
    >
      <div ref={hostRef} className="w-full h-full" />
      <CaptureDock
        containerRef={stageRef}
        time={time}
        ready={ready}
        busy={busy}
        clipStart={clipStart}
        onCheckpoint={() => onAction({
          type: "checkpoint", anchorType: "time", value: timeRef.current,
        })}
        onFrame={captureFrame}
        onRange={captureRange}
        onCancelRange={() => setClipStart(null)}
        onTogglePlay={togglePlay}
        onSeekBy={seekBy}
      />
    </div>
  );
}
