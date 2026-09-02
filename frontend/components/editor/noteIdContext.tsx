"use client";

// Lets a block rendered deep inside BlockNoteView's tree (e.g. DatabaseBlock,
// task-36) know which note hosts it — BlockEditor already has this in scope
// as its `noteId` prop, but nothing below the top-level component can read
// props directly. Default "" mirrors DatabaseBlock's own "unset" convention
// for propSchema string fields.
import { createContext } from "react";

export const NoteIdContext = createContext<string>("");
