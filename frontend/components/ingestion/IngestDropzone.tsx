"use client";

import { useRef, useState, DragEvent, ChangeEvent } from "react";

export type IngestSource =
  | { type: "file"; file: File }
  | { type: "url"; url: string };

interface IngestDropzoneProps {
  onSubmit: (source: IngestSource) => void;
  disabled?: boolean;
}

const ACCEPTED = ".pdf,.txt,.md,.rst,.csv,.pptx,.docx";

export function IngestDropzone({ onSubmit, disabled }: IngestDropzoneProps) {
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onSubmit({ type: "file", file });
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onSubmit({ type: "file", file });
  }

  function handleUrlSubmit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    onSubmit({ type: "url", url: trimmed });
    setUrl("");
  }

  return (
    <div className="space-y-4">
      {/* Drag-and-drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`flex flex-col items-center justify-center gap-2 h-36 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${
          dragging ? "border-brand bg-brand-50" : "border-gray-300 hover:border-brand hover:bg-gray-50"
        } ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      >
        <span className="text-2xl">📎</span>
        <p className="text-sm text-gray-600 font-medium">Drop a file or click to browse</p>
        <p className="text-xs text-gray-400">PDF · TXT · MD · PPTX · DOCX · CSV</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          onChange={handleFileChange}
          className="hidden"
          disabled={disabled}
        />
      </div>

      {/* URL input */}
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleUrlSubmit()}
          placeholder="YouTube URL or article link"
          disabled={disabled}
          className="flex-1 px-3 py-2 text-sm text-gray-900 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent disabled:opacity-50"
        />
        <button
          onClick={handleUrlSubmit}
          disabled={disabled || !url.trim()}
          className="px-4 py-2 text-sm font-medium bg-brand text-white rounded-lg hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Import
        </button>
      </div>
    </div>
  );
}
