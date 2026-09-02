-- Migration 012: Workspaces
-- Study/work areas that group input resources (pdf, youtube, video, website)
-- with output note pages on a freeform canvas.
--
-- Tables: workspaces, workspace_resources, workspace_pages, resource_elements,
--         resource_chunks (+ match_workspace_chunks RPC), note_anchors, ai_providers
-- Storage: private bucket 'workspace-resources'

BEGIN;

-- ---- workspaces ----

CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL DEFAULT 'Untitled Workspace',
  icon        TEXT        NOT NULL DEFAULT '🗂️',
  viewport    JSONB       NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS workspaces_user_idx ON workspaces(user_id) WHERE deleted_at IS NULL;

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_owner_all ON workspaces
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());


-- ---- workspace_resources ----

CREATE TABLE IF NOT EXISTS workspace_resources (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind          TEXT        NOT NULL CHECK (kind IN ('pdf','document','youtube','video','website')),
  title         TEXT        NOT NULL DEFAULT 'Untitled resource',
  source_url    TEXT,
  storage_path  TEXT,
  mime_type     TEXT,
  status        TEXT        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','processing','ready','failed')),
  error         TEXT,
  meta          JSONB       NOT NULL DEFAULT '{}',
  summary_html  TEXT,
  note_id       UUID        REFERENCES notes(id) ON DELETE SET NULL,
  pos_x         DOUBLE PRECISION NOT NULL DEFAULT 0,
  pos_y         DOUBLE PRECISION NOT NULL DEFAULT 0,
  width         DOUBLE PRECISION NOT NULL DEFAULT 280,
  height        DOUBLE PRECISION NOT NULL DEFAULT 180,
  z_index       INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_resources_ws_idx ON workspace_resources(workspace_id);
CREATE INDEX IF NOT EXISTS workspace_resources_user_idx ON workspace_resources(user_id);

ALTER TABLE workspace_resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_resources_owner_all ON workspace_resources
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());


-- ---- workspace_pages (note cards on the canvas) ----

CREATE TABLE IF NOT EXISTS workspace_pages (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  note_id       UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  pos_x         DOUBLE PRECISION NOT NULL DEFAULT 0,
  pos_y         DOUBLE PRECISION NOT NULL DEFAULT 0,
  width         DOUBLE PRECISION NOT NULL DEFAULT 280,
  height        DOUBLE PRECISION NOT NULL DEFAULT 200,
  z_index       INTEGER     NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, note_id)
);

CREATE INDEX IF NOT EXISTS workspace_pages_ws_idx ON workspace_pages(workspace_id);

ALTER TABLE workspace_pages ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_pages_owner_all ON workspace_pages
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());


-- ---- resource_elements (selectable elements: text blocks, images, tables, formulas) ----

CREATE TABLE IF NOT EXISTS resource_elements (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id   UUID        NOT NULL REFERENCES workspace_resources(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  page          INTEGER     NOT NULL DEFAULT 0,
  element_type  TEXT        NOT NULL CHECK (element_type IN ('text','heading','image','table','formula')),
  order_index   INTEGER     NOT NULL DEFAULT 0,
  bbox          JSONB,               -- [x0, y0, x1, y1] in PDF points / relative units
  content       TEXT,                -- text / markdown table / latex
  image_path    TEXT                 -- storage path for image/formula crops
);

CREATE INDEX IF NOT EXISTS resource_elements_res_idx ON resource_elements(resource_id, page);

ALTER TABLE resource_elements ENABLE ROW LEVEL SECURITY;
CREATE POLICY resource_elements_owner_all ON resource_elements
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());


-- ---- resource_chunks (anchored chunks for grounded chat) ----

CREATE TABLE IF NOT EXISTS resource_chunks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id   UUID        NOT NULL REFERENCES workspace_resources(id) ON DELETE CASCADE,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  chunk_index   INTEGER     NOT NULL,
  chunk_text    TEXT        NOT NULL,
  anchor_type   TEXT        NOT NULL CHECK (anchor_type IN ('time','page','section')),
  anchor_start  DOUBLE PRECISION NOT NULL DEFAULT 0,
  anchor_end    DOUBLE PRECISION NOT NULL DEFAULT 0,
  embedding     vector(768),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS resource_chunks_ws_idx ON resource_chunks(workspace_id);
CREATE INDEX IF NOT EXISTS resource_chunks_embedding_hnsw ON resource_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64);

ALTER TABLE resource_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY resource_chunks_owner_all ON resource_chunks
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION match_workspace_chunks(
  query_embedding      vector(768),
  match_user_id        uuid,
  target_workspace_id  uuid,
  match_count          int DEFAULT 10
)
RETURNS TABLE (
  id            uuid,
  resource_id   uuid,
  chunk_text    text,
  anchor_type   text,
  anchor_start  double precision,
  anchor_end    double precision,
  similarity    double precision
)
LANGUAGE sql STABLE
AS $$
  SELECT rc.id, rc.resource_id, rc.chunk_text,
         rc.anchor_type, rc.anchor_start, rc.anchor_end,
         1 - (rc.embedding <=> query_embedding) AS similarity
  FROM resource_chunks rc
  WHERE rc.workspace_id = target_workspace_id
    AND rc.user_id      = match_user_id
    AND rc.embedding IS NOT NULL
  ORDER BY rc.embedding <=> query_embedding
  LIMIT match_count;
$$;


-- ---- note_anchors (summary block ↔ source position sync) ----

CREATE TABLE IF NOT EXISTS note_anchors (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id       UUID        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  resource_id   UUID        NOT NULL REFERENCES workspace_resources(id) ON DELETE CASCADE,
  block_id      TEXT        NOT NULL,
  anchor_type   TEXT        NOT NULL CHECK (anchor_type IN ('time','page','section')),
  anchor_start  DOUBLE PRECISION NOT NULL DEFAULT 0,
  anchor_end    DOUBLE PRECISION NOT NULL DEFAULT 0,
  UNIQUE (note_id, block_id)
);

CREATE INDEX IF NOT EXISTS note_anchors_note_idx ON note_anchors(note_id);

ALTER TABLE note_anchors ENABLE ROW LEVEL SECURITY;
CREATE POLICY note_anchors_owner_all ON note_anchors
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());


-- ---- ai_providers (user-configured model API keys) ----

CREATE TABLE IF NOT EXISTS ai_providers (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  provider    TEXT        NOT NULL CHECK (provider IN ('gemini','anthropic','openai','openai_compatible')),
  label       TEXT        NOT NULL DEFAULT '',
  base_url    TEXT,                          -- openai_compatible only
  api_key     TEXT        NOT NULL,
  chat_model  TEXT,                          -- override default model
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_providers_user_idx ON ai_providers(user_id);

ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY ai_providers_owner_all ON ai_providers
  FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());


-- ---- storage bucket for uploaded resources & media captures ----

INSERT INTO storage.buckets (id, name, public)
VALUES ('workspace-resources', 'workspace-resources', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "workspace-resources owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'workspace-resources' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "workspace-resources owner write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'workspace-resources' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "workspace-resources owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'workspace-resources' AND (storage.foldername(name))[1] = auth.uid()::text);

COMMIT;
