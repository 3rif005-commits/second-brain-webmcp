"use client";

// Uploaded-video viewer — plain <video> over a signed storage URL.
// Frame capture is instant and client-side (same-origin canvas grab);
// clips and audio segments go through the server ffmpeg pipeline.
import { useEffect, useRef, useState } from "react";
import { fmtTime, wsApi, type SendAction, type NoteSource } from "@/lib/workspace";
import { useToast } from "@/app/providers";
import { CaptureDock, type CaptureKind } from "./CaptureDock";

interface VideoPlayerProps {
  resource: NoteSource;
  onPosition: (seconds: number) => void;
  onAction: (action: SendAction) => void;
  seekRef: React.MutableRefObject<((value: number) => void) | null>;
}

export function VideoPlayer({ resource, onPosition, onAction, seekRef }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [clipStart, setClipStart] = useState<number | null>(null);
  const [busy, setBusy] = useState<CaptureKind | null>(null);
  const [time, setTime] = useState(0);
  const { showToast } = useToast();

  useEffect(() => {
    wsApi.sourceFileUrl(resource.id).then((r) => setSrc(r.url)).catch(() => {});
  }, [resource.id]);

  useEffect(() => {
    seekRef.current = (t: number) => {
      const v = videoRef.current;
      if (v) { v.currentTime = t; v.play().catch(() => {}); }
    };
    return () => { seekRef.current = null; };
  }, [seekRef]);

  async function captureFrame() {
    const v = videoRef.current;
    const t = v?.currentTime ?? 0;
    setBusy("frame");
    try {
      const r = await wsApi.capture(resource.id, "frame", t);
      onAction({ type: "image", url: r.url, caption: `Frame @ ${fmtTime(t)}` });
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Frame capture failed");
    } finally { setBusy(null); }
  }

  async function captureRange(type: "clip" | "audio") {
    const t = videoRef.current?.currentTime ?? 0;
    if (clipStart === null) { setClipStart(t); return; }
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

  if (!src) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-sm text-gray-400">
        <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
        Loading video…
      </div>
    );
  }

  function togglePlay() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }

  function seekBy(delta: number) {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, v.currentTime + delta);
  }

  return (
    <div
      ref={stageRef}
      tabIndex={-1}
      className="relative flex-1 min-h-0 flex items-center justify-center bg-[#08090d] outline-none"
    >
      <video
        ref={videoRef}
        src={src}
        controls
        // Chromium-only, and that is fine: it drops the native fullscreen
        // button, which would fullscreen the <video> alone and leave the
        // capture rail behind. Where it is ignored (Firefox, Safari) the rail's
        // own fullscreen button is still the one that keeps the tools on screen.
        controlsList="nofullscreen nodownload"
        className="max-w-full max-h-full"
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setTime(t);
          onPosition(t);
        }}
      />
      <CaptureDock
        containerRef={stageRef}
        time={time}
        busy={busy}
        clipStart={clipStart}
        onCheckpoint={() => onAction({ type: "checkpoint", anchorType: "time", value: time })}
        onFrame={captureFrame}
        onRange={captureRange}
        onCancelRange={() => setClipStart(null)}
        onTogglePlay={togglePlay}
        onSeekBy={seekBy}
      />
    </div>
  );
}
