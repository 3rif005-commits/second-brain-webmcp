-- Group B: Chunk-level retrieval
-- Run in Supabase Dashboard → SQL Editor

-- One row per chunk (section) of a note
CREATE TABLE IF NOT EXISTS note_chunks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id     UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  chunk_index INT         NOT NULL,
  chunk_text  TEXT        NOT NULL,
  embedding   vector(768),
  indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (note_id, chunk_index)
);

-- HNSW index for fast cosine similarity search on chunks
CREATE INDEX IF NOT EXISTS note_chunks_embedding_hnsw
  ON note_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS note_chunks_user_id_idx ON note_chunks (user_id);
CREATE INDEX IF NOT EXISTS note_chunks_note_id_idx ON note_chunks (note_id);

-- Retrieval function — returns best-matching chunks with their note metadata
CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding vector(768),
  match_user_id   uuid,
  match_threshold float DEFAULT 0.50,
  match_count     int   DEFAULT 12
)
RETURNS TABLE (
  note_id    uuid,
  title      text,
  deep_link  text,
  chunk_text text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    nc.note_id,
    n.title,
    '/brain/' || nc.note_id::text AS deep_link,
    nc.chunk_text,
    1 - (nc.embedding <=> query_embedding) AS similarity
  FROM note_chunks nc
  JOIN notes n ON n.id = nc.note_id
  WHERE nc.user_id = match_user_id
    AND n.deleted_at IS NULL
    AND nc.embedding IS NOT NULL
    AND 1 - (nc.embedding <=> query_embedding) > match_threshold
  ORDER BY nc.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- RLS
ALTER TABLE note_chunks ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can read own chunks"   ON note_chunks FOR SELECT USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Users can insert own chunks" ON note_chunks FOR INSERT WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Users can update own chunks" ON note_chunks FOR UPDATE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY "Users can delete own chunks" ON note_chunks FOR DELETE USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
