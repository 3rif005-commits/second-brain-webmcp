export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ── Row types (what SELECT returns) ─────────────────────────────────────────

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  preferences: Json;
  subscription_tier: "free" | "pro" | "enterprise";
  created_at: string;
  updated_at: string;
}

export interface Collection {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  icon: string;
  color: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Note {
  id: string;
  user_id: string;
  collection_id: string | null;
  title: string;
  content: Json; // BlockNote Block[]
  content_text: string | null;
  source_type: "manual" | "pdf" | "video" | "audio" | "url" | "text" | null;
  source_url: string | null;
  source_filename: string | null;
  topics: string[];
  mastery_status: "not_started" | "learning" | "reviewing" | "mastered";
  icon: string;
  is_favorited: boolean;
  last_viewed_at: string | null;
  position: number;
  is_indexed: boolean;
  is_public: boolean;
  local_only: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteIndex {
  id: string;
  note_id: string;
  user_id: string;
  embedding: number[] | null; // vector(768)
  summary: string;
  topics: string[];
  prerequisites: string[];
  deep_link: string;
  indexed_at: string;
}

export interface ChatSession {
  id: string;
  user_id: string;
  title: string | null;
  messages: Json; // array of {role, content} objects
  context_note_ids: string[];
  created_at: string;
  updated_at: string;
}

// ── Insert types (what INSERT/UPDATE accepts) ────────────────────────────────

export type NoteInsert = Pick<Note, "user_id" | "title"> &
  Partial<
    Pick<
      Note,
      | "collection_id"
      | "content"
      | "content_text"
      | "source_type"
      | "source_url"
      | "source_filename"
      | "topics"
      | "mastery_status"
    >
  >;

export type NoteUpdate = Partial<
  Pick<
    Note,
    | "collection_id"
    | "title"
    | "icon"
    | "is_favorited"
    | "last_viewed_at"
    | "content"
    | "content_text"
    | "source_type"
    | "source_url"
    | "source_filename"
    | "topics"
    | "mastery_status"
    | "is_indexed"
    | "is_public"
    | "local_only"
    | "position"
  >
>;

export type CollectionInsert = Pick<Collection, "user_id" | "name"> &
  Partial<
    Pick<Collection, "parent_id" | "description" | "icon" | "color" | "position">
  >;

export type CollectionUpdate = Partial<
  Pick<Collection, "name" | "description" | "icon" | "color" | "position" | "parent_id">
>;
