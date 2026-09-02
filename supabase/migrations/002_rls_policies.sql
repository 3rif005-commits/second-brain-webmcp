-- Enable Row Level Security on all user-data tables
ALTER TABLE profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections   ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_index    ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

-- ── profiles ────────────────────────────────────────────────────────────────
CREATE POLICY "profiles: owner select"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "profiles: owner update"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

-- ── collections ─────────────────────────────────────────────────────────────
CREATE POLICY "collections: owner select"
  ON collections FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "collections: owner insert"
  ON collections FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "collections: owner update"
  ON collections FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "collections: owner delete"
  ON collections FOR DELETE
  USING (auth.uid() = user_id);

-- ── notes ────────────────────────────────────────────────────────────────────
CREATE POLICY "notes: owner select"
  ON notes FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "notes: owner insert"
  ON notes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "notes: owner update"
  ON notes FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "notes: owner delete"
  ON notes FOR DELETE
  USING (auth.uid() = user_id);

-- ── note_index ───────────────────────────────────────────────────────────────
CREATE POLICY "note_index: owner select"
  ON note_index FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "note_index: owner insert"
  ON note_index FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "note_index: owner update"
  ON note_index FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "note_index: owner delete"
  ON note_index FOR DELETE
  USING (auth.uid() = user_id);

-- ── chat_sessions ────────────────────────────────────────────────────────────
CREATE POLICY "chat_sessions: owner select"
  ON chat_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "chat_sessions: owner insert"
  ON chat_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "chat_sessions: owner update"
  ON chat_sessions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "chat_sessions: owner delete"
  ON chat_sessions FOR DELETE
  USING (auth.uid() = user_id);
