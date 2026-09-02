-- 011_block_chunks.sql
-- Phase 4: block-level indexing + note descriptors

-- Add descriptor fields to notes
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS descriptor          TEXT,
  ADD COLUMN IF NOT EXISTS descriptor_embedding vector(768);

CREATE INDEX IF NOT EXISTS notes_descriptor_embedding_hnsw
  ON notes USING hnsw (descriptor_embedding vector_cosine_ops)
  WITH (m=16, ef_construction=64);

-- Add block_id to note_chunks (nullable — old chunks have no block_id)
ALTER TABLE note_chunks
  ADD COLUMN IF NOT EXISTS block_id TEXT;

-- RLS: service role can bypass for reindex writes (service key already bypasses RLS)

-- Pass 1: match notes by descriptor embedding
CREATE OR REPLACE FUNCTION match_note_descriptors(
  query_embedding     vector(768),
  match_user_id       uuid,
  match_count         int DEFAULT 5
)
RETURNS TABLE (
  id          uuid,
  title       text,
  descriptor  text,
  dist        float
)
LANGUAGE sql STABLE
AS $$
  SELECT id, title, descriptor,
         descriptor_embedding <=> query_embedding AS dist
  FROM notes
  WHERE user_id    = match_user_id
    AND deleted_at IS NULL
    AND descriptor_embedding IS NOT NULL
  ORDER BY dist
  LIMIT match_count;
$$;

-- Pass 2: match blocks within a set of notes
CREATE OR REPLACE FUNCTION match_blocks_in_notes(
  query_embedding vector(768),
  match_user_id   uuid,
  note_ids        uuid[],
  match_count     int DEFAULT 15
)
RETURNS TABLE (
  note_id     uuid,
  block_id    text,
  chunk_text  text,
  chunk_index int,
  dist        float
)
LANGUAGE sql STABLE
AS $$
  SELECT nc.note_id, nc.block_id, nc.chunk_text, nc.chunk_index,
         nc.embedding <=> query_embedding AS dist
  FROM note_chunks nc
  WHERE nc.note_id  = ANY(note_ids)
    AND nc.user_id  = match_user_id
    AND nc.embedding IS NOT NULL
  ORDER BY dist
  LIMIT match_count;
$$;
