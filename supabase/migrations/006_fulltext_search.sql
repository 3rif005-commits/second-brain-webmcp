-- Full-text search index on notes
-- Run via: paste into Supabase dashboard SQL editor

-- Generated tsvector column: title weighted A (higher), content_text weighted B
ALTER TABLE notes ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content_text, '')), 'B')
  ) STORED;

CREATE INDEX IF NOT EXISTS notes_fts_idx ON notes USING GIN(fts);
