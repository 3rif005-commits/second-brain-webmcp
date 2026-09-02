"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Trash2, Star, GripVertical } from "lucide-react";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  DragOverlay,
  DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Collection, Note } from "@/lib/types/database";
import type { NoteSummary } from "@/lib/hooks/useNotes";

interface NoteTreeProps {
  notes: NoteSummary[];
  collections: Collection[];
  onDeleteNote: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  onReorder?: (reordered: NoteSummary[]) => void;
}

interface NoteItemProps {
  note: NoteSummary;
  onDeleteNote: (id: string) => void;
  onToggleFavorite?: (id: string) => void;
  confirmingId: string | null;
  setConfirmingId: (id: string | null) => void;
  isDragOverlay?: boolean;
}

function NoteItem({
  note,
  onDeleteNote,
  onToggleFavorite,
  confirmingId,
  setConfirmingId,
  isDragOverlay = false,
}: NoteItemProps) {
  const pathname = usePathname();
  const active = pathname === `/brain/${note.id}`;
  const confirming = confirmingId === note.id;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: note.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={isDragOverlay ? undefined : style}
      className={`group flex items-center justify-between px-1 py-1 rounded-md text-sm cursor-pointer transition-colors ${
        active
          ? "bg-white/10 text-white font-medium"
          : "text-slate-400 hover:text-slate-100 hover:bg-white/5"
      } ${isDragOverlay ? "bg-slate-700/80 shadow-lg" : ""}`}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="shrink-0 p-1 text-slate-700 hover:text-slate-400 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity touch-none"
        aria-label="Drag to reorder"
        tabIndex={-1}
      >
        <GripVertical size={11} />
      </button>

      <Link
        href={`/brain/${note.id}`}
        className="flex-1 flex items-center gap-1.5 truncate min-w-0 px-1"
      >
        <span className="shrink-0 text-sm leading-none">{note.icon || "📄"}</span>
        <span className="truncate">{note.title || "Untitled"}</span>
      </Link>

      {confirming ? (
        <div className="flex items-center gap-1 ml-1 shrink-0">
          <button
            onClick={(e) => {
              e.preventDefault();
              onDeleteNote(note.id);
              setConfirmingId(null);
            }}
            className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors font-medium"
          >
            Del
          </button>
          <button
            onClick={(e) => {
              e.preventDefault();
              setConfirmingId(null);
            }}
            className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 hover:bg-slate-600 transition-colors"
          >
            ✕
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-0.5 ml-1 shrink-0 opacity-0 group-hover:opacity-100 transition-all">
          {onToggleFavorite && (
            <button
              onClick={(e) => {
                e.preventDefault();
                onToggleFavorite(note.id);
              }}
              className={`p-0.5 rounded transition-colors ${
                note.is_favorited
                  ? "text-amber-400 opacity-100"
                  : "text-slate-600 hover:text-amber-400"
              }`}
              aria-label={note.is_favorited ? "Unstar" : "Star"}
            >
              <Star size={11} fill={note.is_favorited ? "currentColor" : "none"} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.preventDefault();
              setConfirmingId(note.id);
            }}
            className="p-0.5 rounded text-slate-600 hover:text-red-400 transition-colors"
            aria-label={`Delete "${note.title || "Untitled"}"`}
          >
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

export function NoteTree({
  notes,
  collections,
  onDeleteNote,
  onToggleFavorite,
  onReorder,
}: NoteTreeProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [activeNote, setActiveNote] = useState<NoteSummary | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Require 5px movement before drag starts — prevents accidental drags on click
      activationConstraint: { distance: 5 },
    })
  );

  const uncollected = notes.filter((n) => !n.collection_id);
  const byCollection = (colId: string) => notes.filter((n) => n.collection_id === colId);

  function handleDragStart(event: DragStartEvent) {
    const note = notes.find((n) => n.id === event.active.id);
    setActiveNote(note ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveNote(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const uncollectedIds = uncollected.map((n) => n.id);
    const oldIdx = uncollectedIds.indexOf(active.id as string);
    const newIdx = uncollectedIds.indexOf(over.id as string);
    if (oldIdx === -1 || newIdx === -1) return;

    const reordered = arrayMove(uncollected, oldIdx, newIdx);
    onReorder?.(reordered);
  }

  return (
    <div className="space-y-0.5">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={uncollected.map((n) => n.id)}
          strategy={verticalListSortingStrategy}
        >
          {uncollected.map((note) => (
            <NoteItem
              key={note.id}
              note={note}
              onDeleteNote={onDeleteNote}
              onToggleFavorite={onToggleFavorite}
              confirmingId={confirmingId}
              setConfirmingId={setConfirmingId}
            />
          ))}
        </SortableContext>

        {/* Ghost shown while dragging */}
        <DragOverlay>
          {activeNote && (
            <NoteItem
              note={activeNote}
              onDeleteNote={() => {}}
              confirmingId={null}
              setConfirmingId={() => {}}
              isDragOverlay
            />
          )}
        </DragOverlay>
      </DndContext>

      {collections.map((col) => (
        <div key={col.id}>
          <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold text-slate-500 uppercase tracking-widest mt-3">
            {col.icon && <span>{col.icon}</span>}
            <span className="truncate">{col.name}</span>
          </div>
          {byCollection(col.id).map((note) => (
            <div key={note.id} className="pl-3">
              <NoteItem
                note={note}
                onDeleteNote={onDeleteNote}
                onToggleFavorite={onToggleFavorite}
                confirmingId={confirmingId}
                setConfirmingId={setConfirmingId}
              />
            </div>
          ))}
          {byCollection(col.id).length === 0 && (
            <p className="pl-6 text-xs text-slate-600 py-1">Empty</p>
          )}
        </div>
      ))}
    </div>
  );
}
