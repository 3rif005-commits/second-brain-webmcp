-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;

-- profiles: one row per auth.users entry
CREATE TABLE profiles (
  id                UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email             TEXT        NOT NULL,
  full_name         TEXT,
  avatar_url        TEXT,
  preferences       JSONB       NOT NULL DEFAULT '{}',
  subscription_tier TEXT        NOT NULL DEFAULT 'free'
                    CHECK (subscription_tier IN ('free','pro','enterprise')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- collections: folders that group notes (supports nesting via parent_id)
CREATE TABLE collections (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  parent_id   UUID        REFERENCES collections(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  description TEXT,
  icon        TEXT        NOT NULL DEFAULT '📁',
  color       TEXT        NOT NULL DEFAULT '#6366f1',
  position    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- notes: main content table; content stored as BlockNote JSON in JSONB
CREATE TABLE notes (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  collection_id   UUID        REFERENCES collections(id) ON DELETE SET NULL,
  title           TEXT        NOT NULL DEFAULT 'Untitled',
  content         JSONB       NOT NULL DEFAULT '[]',
  content_text    TEXT,
  source_type     TEXT        CHECK (source_type IN ('manual','pdf','video','audio','url','text')),
  source_url      TEXT,
  source_filename TEXT,
  topics          TEXT[]      NOT NULL DEFAULT '{}',
  mastery_status  TEXT        NOT NULL DEFAULT 'not_started'
                  CHECK (mastery_status IN ('not_started','learning','reviewing','mastered')),
  is_indexed      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- note_index: semantic search index; one row per note
CREATE TABLE note_index (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id       UUID        NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  embedding     vector(768),               -- Google text-embedding-004
  summary       TEXT        NOT NULL DEFAULT '',
  topics        TEXT[]      NOT NULL DEFAULT '{}',
  prerequisites TEXT[]      NOT NULL DEFAULT '{}',
  deep_link     TEXT        NOT NULL DEFAULT '',
  indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- chat_sessions: persisted conversation history with context tracking
CREATE TABLE chat_sessions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title            TEXT,
  messages         JSONB       NOT NULL DEFAULT '[]',
  context_note_ids UUID[]      NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- updated_at triggers
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_collections_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_chat_sessions_updated_at
  BEFORE UPDATE ON chat_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Auto-create profile row when a new auth.users row is inserted
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, email, full_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
