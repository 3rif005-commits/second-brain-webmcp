-- Phase 3: Context Protocol — note_index table with pgvector embeddings
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query)

-- Enable pgvector (already on Supabase, but safe to re-run)
CREATE EXTENSION IF NOT EXISTS vector;

-- note_index: one row per note, stores embedding + semantic metadata
CREATE TABLE IF NOT EXISTS note_index (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id       UUID        NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  embedding     vector(768),                         -- Google text-embedding-004
  summary       TEXT        NOT NULL DEFAULT '',
  topics        TEXT[]      NOT NULL DEFAULT '{}',
  prerequisites TEXT[]      NOT NULL DEFAULT '{}',
  deep_link     TEXT        NOT NULL DEFAULT '',
  indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- HNSW index for fast cosine-similarity retrieval
CREATE INDEX IF NOT EXISTS note_index_embedding_hnsw
  ON note_index
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Index for fast user-scoped lookups
CREATE INDEX IF NOT EXISTS note_index_user_id_idx ON note_index (user_id);

-- ── Semantic retrieval function ──────────────────────────────────────────────
-- Called via supabase.rpc("match_notes", {...}) — no direct DB connection needed.

CREATE OR REPLACE FUNCTION match_notes(
  query_embedding vector(768),
  match_user_id   uuid,
  match_threshold float DEFAULT 0.72,
  match_count     int   DEFAULT 8
)
RETURNS TABLE (
  id           uuid,
  title        text,
  content_text text,
  deep_link    text,
  summary      text,
  topics       text[],
  prerequisites text[],
  similarity   float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    n.id,
    n.title,
    n.content_text,
    ni.deep_link,
    ni.summary,
    ni.topics,
    ni.prerequisites,
    1 - (ni.embedding <=> query_embedding) AS similarity
  FROM note_index ni
  JOIN notes n ON n.id = ni.note_id
  WHERE ni.user_id = match_user_id
    AND ni.embedding IS NOT NULL
    AND 1 - (ni.embedding <=> query_embedding) > match_threshold
  ORDER BY ni.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- RLS: users can only see and modify their own index entries
ALTER TABLE note_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own index entries"
  ON note_index FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own index entries"
  ON note_index FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own index entries"
  ON note_index FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own index entries"
  ON note_index FOR DELETE
  USING (auth.uid() = user_id);
