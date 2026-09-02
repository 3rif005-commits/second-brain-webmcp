-- Migration 009: AI substrate
-- Adds:
--   - notes.local_only         (D6 permission flag)
--   - notes.deleted_at         (soft delete; used by brain.delete_note)
--   - chat_sessions → chat_threads (renamed + title, pinned, model_mode, archived_at)
--   - mcp_servers              (registry for Phase 3, created now to avoid double migration)
--   - note_links               (typed links — used by brain.link_notes)

BEGIN;

-- ---- notes: local_only + soft delete ----

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS local_only BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS notes_local_only_idx
  ON notes(local_only) WHERE local_only = TRUE;

CREATE INDEX IF NOT EXISTS notes_deleted_at_idx
  ON notes(deleted_at) WHERE deleted_at IS NULL;


-- ---- chat_sessions → chat_threads ----

ALTER TABLE chat_sessions RENAME TO chat_threads;

ALTER TABLE chat_threads
  ADD COLUMN IF NOT EXISTS title         TEXT,
  ADD COLUMN IF NOT EXISTS pinned        BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS model_mode    TEXT,
  ADD COLUMN IF NOT EXISTS archived_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS chat_threads_user_updated_idx
  ON chat_threads(user_id, updated_at DESC);


-- ---- mcp_servers (Phase 3 prep) ----

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  transport   TEXT        NOT NULL CHECK (transport IN ('stdio','http','sse')),
  command     TEXT,
  url         TEXT,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  trust_level TEXT        NOT NULL DEFAULT 'read_only'
              CHECK (trust_level IN ('read_only','full')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY mcp_servers_owner_all ON mcp_servers
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ---- note_links (typed links between notes) ----

CREATE TABLE IF NOT EXISTS note_links (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  from_note_id  UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_note_id    UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  link_type     TEXT        NOT NULL CHECK (link_type IN ('prereq','related','backlink')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (from_note_id, to_note_id, link_type)
);

CREATE INDEX IF NOT EXISTS note_links_from_idx ON note_links(from_note_id);
CREATE INDEX IF NOT EXISTS note_links_to_idx   ON note_links(to_note_id);

ALTER TABLE note_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY note_links_owner_all ON note_links
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMIT;
