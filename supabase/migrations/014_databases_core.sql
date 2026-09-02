-- Migration 014: Notion Databases — core schema
-- Tables: db_databases, db_data_sources, db_properties, db_row_props, db_views
--
-- Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §3.2, §10
-- Plan: docs/plans/2026-08-08-notion-databases.md (Migration Gates, G1)
--
-- A database row *is* a `notes` row (db_row_props is a 1:1 companion keyed by
-- note_id); property values live in `db_row_props.properties` as JSONB keyed
-- by short opaque property keys (see backend/services/db/keys.py). Formula and
-- rollup results are materialised separately into `db_row_props.computed`.
--
-- Tenancy is enforced in the query builder (asyncpg uses the service role, so
-- RLS does not apply there — see spec §8.3), but RLS is still enabled here as
-- defence in depth for PostgREST access, using the `(SELECT auth.uid())` form
-- for the InitPlan optimisation (do not copy 012_workspaces.sql's bare
-- `auth.uid()` — that is the older, slower pattern).
--
-- This migration does not reference `vector`, so the
-- `SET LOCAL search_path = public, extensions;` rule does not apply here.
--
-- Out of scope for 014 (see plan's Migration Gates table):
--   db_relation_links            → 015 (Gate G2)
--   db_row_templates, db_automations → 017 (Gate G4)

BEGIN;

-- ---- db_databases ----
-- Container (Notion's post-2025-09-03 "database"). One database may hold
-- several data sources (§3.1); the UI currently always creates exactly one.

CREATE TABLE IF NOT EXISTS db_databases (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title          TEXT        NOT NULL DEFAULT 'Untitled',
  description    JSONB       NOT NULL DEFAULT '[]',   -- rich text
  icon           TEXT,
  cover_url      TEXT,
  is_inline      BOOLEAN     NOT NULL DEFAULT FALSE,
  parent_note_id UUID        REFERENCES notes(id) ON DELETE CASCADE,  -- inline host
  is_locked      BOOLEAN     NOT NULL DEFAULT FALSE,
  position       INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS db_databases_user_idx ON db_databases(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS db_databases_parent_note_idx ON db_databases(parent_note_id) WHERE parent_note_id IS NOT NULL;

ALTER TABLE db_databases ENABLE ROW LEVEL SECURITY;
CREATE POLICY db_databases_owner_all ON db_databases
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));


-- ---- db_data_sources ----
-- Schema + row set (Notion's "data source"). system_kind='notes' marks the
-- built-in virtual "All Notes" source (spec §6) that has zero migrated rows.

CREATE TABLE IF NOT EXISTS db_data_sources (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id UUID        NOT NULL REFERENCES db_databases(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL DEFAULT 'Default',
  -- NULL for ordinary sources; 'notes' marks the built-in virtual source (§6)
  system_kind TEXT        CHECK (system_kind IN ('notes')),
  position    INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS db_data_sources_database_idx ON db_data_sources(database_id);
CREATE INDEX IF NOT EXISTS db_data_sources_user_idx ON db_data_sources(user_id);

ALTER TABLE db_data_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY db_data_sources_owner_all ON db_data_sources
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));


-- ---- db_properties ----
-- Property registry (the schema). `key` is a short opaque 8-char base62
-- identifier, minted and kept immutable at the application layer
-- (backend/services/db/keys.py) — this migration only enforces uniqueness.

CREATE TABLE IF NOT EXISTS db_properties (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id UUID        NOT NULL REFERENCES db_data_sources(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- The JSONB key. Short, opaque, immutable. Notion's lesson (§4.2).
  key            TEXT        NOT NULL,
  name           TEXT        NOT NULL,
  type           TEXT        NOT NULL,
  config         JSONB       NOT NULL DEFAULT '{}',   -- per-type; see §5
  description    TEXT,
  -- 'jsonb' → db_row_props.properties->key ; 'column' → a notes column (§6)
  storage        TEXT        NOT NULL DEFAULT 'jsonb'
                 CHECK (storage IN ('jsonb','column')),
  column_name    TEXT,                          -- allow-listed, storage='column' only
  -- Materialised formula/rollup result type, set by the type checker
  result_type    TEXT,
  is_volatile    BOOLEAN     NOT NULL DEFAULT FALSE, -- references now()/today()
  position       INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (data_source_id, key)
);

CREATE INDEX IF NOT EXISTS db_properties_data_source_idx ON db_properties(data_source_id);
CREATE INDEX IF NOT EXISTS db_properties_user_idx ON db_properties(user_id);

ALTER TABLE db_properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY db_properties_owner_all ON db_properties
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));


-- ---- db_row_props ----
-- 1:1 companion to `notes` — a database row *is* a note. `properties` holds
-- user-authored values; `computed` holds materialised formula/rollup results
-- (§7). jsonb_path_ops is chosen over the default GIN opclass: smaller and
-- faster for the `@>` containment queries that select/multi-select/status/
-- checkbox filters compile to, at the cost of the key-existence operators we
-- do not use (spec §3.2, PG docs).

CREATE TABLE IF NOT EXISTS db_row_props (
  note_id        UUID             PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  data_source_id UUID             NOT NULL REFERENCES db_data_sources(id) ON DELETE CASCADE,
  user_id        UUID             NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  properties     JSONB            NOT NULL DEFAULT '{}',  -- user-authored values
  computed       JSONB            NOT NULL DEFAULT '{}',  -- formula/rollup results (§7)
  position       DOUBLE PRECISION NOT NULL DEFAULT 0,  -- manual drag order
  created_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS db_row_props_ds_pos_idx ON db_row_props (data_source_id, position);
CREATE INDEX IF NOT EXISTS db_row_props_props_gin  ON db_row_props USING gin (properties jsonb_path_ops);
CREATE INDEX IF NOT EXISTS db_row_props_comp_gin   ON db_row_props USING gin (computed  jsonb_path_ops);
CREATE INDEX IF NOT EXISTS db_row_props_user_idx   ON db_row_props(user_id);

ALTER TABLE db_row_props ENABLE ROW LEVEL SECURITY;
CREATE POLICY db_row_props_owner_all ON db_row_props
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));


-- ---- db_views ----
-- Saved views, JSONB config. Views are shared, not per-user (spec §10 — the
-- app has one user per account, so per-user views would be complexity with
-- no consumer).

CREATE TABLE IF NOT EXISTS db_views (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id UUID        NOT NULL REFERENCES db_data_sources(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL DEFAULT 'Default view',
  icon           TEXT,
  type           TEXT        NOT NULL,       -- table|board|list|calendar|timeline|gallery
                                             -- |chart|form|map|feed|dashboard
  config         JSONB       NOT NULL DEFAULT '{}',
  filter         JSONB,
  sorts          JSONB       NOT NULL DEFAULT '[]',
  is_locked      BOOLEAN     NOT NULL DEFAULT FALSE,
  position       INTEGER     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS db_views_data_source_idx ON db_views(data_source_id);
CREATE INDEX IF NOT EXISTS db_views_user_idx ON db_views(user_id);

ALTER TABLE db_views ENABLE ROW LEVEL SECURITY;
CREATE POLICY db_views_owner_all ON db_views
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));


COMMIT;


-- ---- proof it applied ----

SELECT 'migration 014 applied' AS status,
       (SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name LIKE 'db\_%') AS db_tables_created;
