"use client";

// @dnd-kit wrapper, used identically for row, property, column and group
// reorder so the drop treatment is defined once.
//
// NOTE ON THE ROW GUTTER: in Notion the drag handle carries THREE gestures —
// click opens the row menu, drag reorders, and clicking also selects the row.
// This component owns only the drag. The click behaviour is the caller's, via
// `onClick`; do not add a menu here, or the same handle in a different context
// (property list, group list) would sprout a menu it should not have.
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";

export interface DragHandleProps {
  id: string;
  children?: ReactNode;
  /** Rendered as the draggable body. Omit to render just the grip. */
  wrapper?: (args: { isDragging: boolean; handle: ReactNode }) => ReactNode;
  label?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export function DragHandle({
  id,
  children,
  wrapper,
  label = "Drag to reorder",
  onClick,
  disabled,
  className = "",
}: DragHandleProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  });

  const handle = (
    <span
      {...attributes}
      {...listeners}
      role="button"
      aria-label={label}
      tabIndex={disabled ? -1 : 0}
      onClick={onClick}
      className={`cursor-grab select-none text-menu-disabled hover:text-menu-fg ${className}`}
      data-testid="drag-handle"
    >
      {children ?? "⠿"}
    </span>
  );

  if (!wrapper) return handle;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-50" : ""}
    >
      {wrapper({ isDragging, handle })}
    </div>
  );
}
