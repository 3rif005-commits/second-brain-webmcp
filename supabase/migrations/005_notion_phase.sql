-- Notion UX Phase migrations
-- Run via: supabase db push  OR paste into Supabase dashboard SQL editor
-- Status: RUN 2026-05-09

-- ── P1.1 Trash / soft delete ────────────────────────────────────────────────
ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ── P1.3 Page icon ──────────────────────────────────────────────────────────
ALTER TABLE notes ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '📄';

-- ── P1.5 Favorites + recents ────────────────────────────────────────────────
ALTER TABLE notes ADD COLUMN IF NOT EXISTS is_favorited BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;

-- ── P1.6 Drag-to-reorder ────────────────────────────────────────────────────
ALTER TABLE notes ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;

-- ── P2.4 Cover image ────────────────────────────────────────────────────────
ALTER TABLE notes ADD COLUMN IF NOT EXISTS cover_image_url TEXT;

-- ── P3.3 Public share link ───────────────────────────────────────────────────
ALTER TABLE notes ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;

-- Allow anonymous users to read notes that have been explicitly made public
CREATE POLICY IF NOT EXISTS "anon_read_public_notes" ON notes
  FOR SELECT
  TO anon
  USING (is_public = true AND deleted_at IS NULL);
