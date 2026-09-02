-- Migration 008: 384-dim on-device embedding support
-- Adds a second embedding column to note_chunks for all-MiniLM-L6-v2 (Android on-device inference)
-- Run in Supabase Dashboard → SQL Editor

ALTER TABLE note_chunks ADD COLUMN IF NOT EXISTS embedding_384 vector(384);

-- HNSW index for fast cosine similarity on 384-dim vectors
CREATE INDEX IF NOT EXISTS note_chunks_embedding_384_hnsw
    ON note_chunks
    USING hnsw (embedding_384 vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

-- Retrieval function for 384-dim (Android) embeddings
CREATE OR REPLACE FUNCTION match_chunks_384(
    query_embedding vector(384),
    match_user_id   uuid,
    match_threshold float DEFAULT 0.45,
    match_count     int   DEFAULT 5
)
RETURNS TABLE (
    note_id    uuid,
    title      text,
    chunk_text text,
    similarity float
)
LANGUAGE sql STABLE
AS $$
    SELECT
        nc.note_id,
        n.title,
        nc.chunk_text,
        1 - (nc.embedding_384 <=> query_embedding) AS similarity
    FROM note_chunks nc
    JOIN notes n ON n.id = nc.note_id
    WHERE nc.user_id = match_user_id
      AND n.deleted_at IS NULL
      AND nc.embedding_384 IS NOT NULL
      AND 1 - (nc.embedding_384 <=> query_embedding) > match_threshold
    ORDER BY nc.embedding_384 <=> query_embedding
    LIMIT match_count;
$$;
