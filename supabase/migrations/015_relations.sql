-- Migration 015: Notion Databases — relations, two-way pairs, sub-items, dependencies
-- Table: db_relation_links
-- Indexes on the existing db_properties table for relation-pair integrity
--
-- Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §9
-- Plan: docs/plans/2026-08-08-notion-databases.md (Migration Gates, G2)
-- Research: docs/research/notion-databases-research.md §3 (sub-items), §4 (dependencies)
--
-- This migration does not reference `vector`, so the
-- `SET LOCAL search_path = public, extensions;` rule does not apply here.
--
-- Out of scope for 015 (see the plan's Migration Gates table):
--   db_row_props.computed expression indexes → 016 (Gate G3)
--   db_row_templates, db_automations          → 017 (Gate G4)
--   public form submission policy             → 018 (Gate G5)
--
-- Note on numbering: 019 (notes_excluding_database_rows) is already applied in
-- production, ahead of this file. That is intentional and harmless — 019
-- depends only on 014, and this file depends only on 014, so there is no
-- ordering hazard. A replay from scratch applies 015 then 019 and reaches the
-- same state.
--
--
-- ---------------------------------------------------------------------------
-- THE ONE IDEA IN THIS FILE: a link is stored ONCE, keyed by the relation PAIR.
-- ---------------------------------------------------------------------------
--
-- Notion presents a two-way relation as two properties — "Tasks" on one side,
-- "Project" on the other — and its own docs never resolve what happens when the
-- two copies disagree (research §L.1 #11: two-way deletion semantics are
-- undocumented). We sidestep the question instead of answering it: there is no
-- second copy. One `db_relation_links` row IS the link. Both properties are
-- views onto it, distinguished only by which end they read:
--
--   forward side  →  SELECT to_row_id   WHERE relation_id = $1 AND from_row_id = $row
--   reverse side  →  SELECT from_row_id WHERE relation_id = $1 AND to_row_id   = $row
--
-- So two-way sync is *structural, not synchronised*. Create and delete cannot
-- desync because there is nothing to keep in step, and "deleting from either
-- side deletes the pair" falls out for free rather than needing trigger logic.
--
-- The corollary, stated plainly for whoever writes the query code: **the JSONB
-- is not the source of truth for relations.** `db_row_props.properties->key`
-- must not be treated as the link list. `backend/services/db/properties/base.py`
-- currently lists "relation" in `_ARRAY_VALUED`, and
-- `backend/services/db/query/operators.py` compiles relation filters against a
-- JSONB array — both are Milestone-1/3 placeholders written before this table
-- existed. Milestone 7 must repoint them at an EXISTS subquery over this table.
-- The indexes below are chosen to make exactly that subquery cheap.
--
--
-- ---------------------------------------------------------------------------
-- CONFIG CONVENTION on db_properties (type = 'relation')
-- ---------------------------------------------------------------------------
--
-- The two partial indexes at the bottom of this file reference these JSONB keys
-- by name, which makes the convention load-bearing schema, not just a comment:
--
--   config.relation_id  UUID   — the pair identity. BOTH property rows of a
--                                two-way relation carry the same value. This is
--                                what `db_relation_links.relation_id` points at.
--                                It is deliberately NOT a foreign key: the links
--                                belong to the pair, not to either property row,
--                                so a property can be deleted and re-created on
--                                the same relation_id without touching the data.
--   config.side         TEXT   — 'forward' | 'reverse'. Which end this property
--                                reads. A one-way relation has a forward row and
--                                no reverse row.
--   config.system       TEXT   — absent for ordinary user-created relations.
--                                'sub_item'   → the built-in hierarchy pair
--                                               (Notion's "Sub-item"/"Parent item")
--                                'dependency' → the built-in blocking pair
--                                               (Notion's blocking/blocked-by)
--
-- Sub-items and dependencies are **self-relations wearing a label**, not
-- separate mechanisms (spec §9; research §3.1 and §4.1 both confirm Notion
-- builds them on ordinary relation properties). That is why they inherit
-- rollups, filters and the cycle checker without any code of their own. The
-- only thing this schema adds for them is the uniqueness guarantee below.
--
-- Dependency behaviour settings — the three mutually exclusive automatic
-- date-shifting modes, whose exact Notion names are
--   'Shift only when dates overlap', 'Shift & maintain time between items',
--   'Do not automatically shift'
-- — plus the independent 'Avoid weekends' toggle and the date property they act
-- on, live in the *forward* dependency property's `config` as well. Their
-- encoding is deliberately left to Milestone 7: no index here depends on them,
-- so pinning key names in DDL would be authority this file has not earned.
--
--
-- ---------------------------------------------------------------------------
-- WHAT THIS SCHEMA DOES NOT ENFORCE (all of it on purpose)
-- ---------------------------------------------------------------------------
--
-- 1. **No CHECK (from_row_id <> to_row_id).** A row linking to itself is a
--    length-1 cycle, and the plan requires cycles to be "rejected with the cycle
--    path" — an application-level error message a CHECK constraint cannot
--    produce. Enforcing it here would turn that specified 400 into an opaque
--    IntegrityError. It is also only wrong for the *hierarchical* relations
--    (sub_item/dependency); an ordinary relation may legitimately point a row at
--    itself. M7's cycle checker owns this, including the degenerate case.
--
-- 2. **No cycle prevention of any kind.** Reachability is not expressible as a
--    constraint without a recursive trigger, which would serialise writes and
--    still race. M7 checks the graph before inserting.
--
-- 3. **No depth cap.** The plan caps sub-item nesting at 10. Note that research
--    §3.3 is explicit that Notion documents *no* maximum, and that the
--    frequently-quoted "three levels" belongs to database templates, a
--    different feature — so 10 is our own decision, not a copied constant, and
--    it belongs in application code where it can be explained and changed.
--
-- 4. **No FK from db_relation_links.relation_id to db_properties.** See the
--    config convention above: relation_id identifies the pair, and there is no
--    single row it could reference. The cost is that deleting both sides of a
--    relation orphans its links; M7's relation delete path is responsible for
--    sweeping them, and the UNIQUE index below makes `WHERE relation_id = $1`
--    an index scan.
--
-- 5. **Soft-deleted (trashed) rows keep their links.** `notes.deleted_at` is a
--    soft delete; the FKs below cascade only on a real DELETE. This is correct:
--    restoring a trashed row restores its relationships. Query code filters
--    `deleted_at IS NULL` at read time, as it already does elsewhere.

BEGIN;

-- ---- db_relation_links ----
-- Column list is spec §9's DDL verbatim. `position` is the manual drag order of
-- linked rows within one side of one link list (Notion lets you reorder related
-- pages); DOUBLE PRECISION so an insert between two neighbours is a midpoint,
-- matching db_row_props.position.

CREATE TABLE IF NOT EXISTS db_relation_links (
  id          UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID             NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- the relation PAIR, not one side of it (see the header)
  relation_id UUID             NOT NULL,
  from_row_id UUID             NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_row_id   UUID             NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  position    DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  CONSTRAINT db_relation_links_pair_uniq UNIQUE (relation_id, from_row_id, to_row_id)
);

-- Index set, and why each one exists. Postgres does NOT auto-index the
-- referencing side of a foreign key, so every ON DELETE CASCADE above needs a
-- covering index or deleting one note sequentially scans this whole table.
--
--   db_relation_links_pair_uniq   (relation_id, from_row_id, to_row_id)
--       The constraint itself, plus the orphan sweep in note 4 above — its bare
--       relation_id prefix is the only index that serves `WHERE relation_id=$1`
--       alone. It can also serve the forward read; in practice the planner
--       tends to pick from_idx below for that, and either is an index scan.
--   db_relation_links_from_idx    (from_row_id, relation_id)
--       Cascade support for the notes FK on from_row_id, and "every relation
--       this row participates in as a source" (the row-page relation panel).
--   db_relation_links_to_idx      (to_row_id, relation_id)
--       Same for to_row_id, and the reverse read `WHERE relation_id=$1 AND
--       to_row_id=$2` — the one query the pair-unique index cannot serve,
--       because to_row_id is its trailing column.
--   db_relation_links_user_idx    (user_id)
--       Cascade support for the profiles FK, and tenancy-scoped scans.
--
-- `position` is deliberately not in any index: link lists per row are small
-- enough that sorting them is free, and carrying it would widen three indexes
-- for no measured gain.

CREATE INDEX IF NOT EXISTS db_relation_links_from_idx ON db_relation_links (from_row_id, relation_id);
CREATE INDEX IF NOT EXISTS db_relation_links_to_idx   ON db_relation_links (to_row_id, relation_id);
CREATE INDEX IF NOT EXISTS db_relation_links_user_idx ON db_relation_links (user_id);

-- RLS is defence in depth for the PostgREST path only. The backend reaches this
-- table through asyncpg as the service role, which is BYPASSRLS — tenancy there
-- is the query builder's `_scope()`, mandatory on every generated query (spec
-- §8.3, and the same warning migration 019 carries). The `(SELECT auth.uid())`
-- form is required for the InitPlan optimisation; do not "simplify" it to a
-- bare auth.uid().
ALTER TABLE db_relation_links ENABLE ROW LEVEL SECURITY;

-- Wrapped in a pg_policies existence check because Postgres has no
-- `CREATE POLICY IF NOT EXISTS` — and `CREATE POLICY IF NOT EXISTS` is not a
-- hypothetical mistake here, it is the exact syntax error that has kept
-- 005_notion_phase.sql's anon_read_public_notes policy from ever being created
-- (see the plan's pre-existing-bugs list). Migration 014 used a bare
-- CREATE POLICY, which is correct on a first apply but aborts a re-apply; its
-- review asked for this pattern from 015 onward, so here it is.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'db_relation_links'
      AND policyname = 'db_relation_links_owner_all'
  ) THEN
    CREATE POLICY db_relation_links_owner_all ON db_relation_links
      FOR ALL TO authenticated
      USING (user_id = (SELECT auth.uid()))
      WITH CHECK (user_id = (SELECT auth.uid()));
  END IF;
END $$;

COMMENT ON TABLE db_relation_links IS
  'One row per relation link, keyed by the relation PAIR (relation_id), not by '
  'either side''s property. Two-way relations are structural, not synchronised: '
  'the forward property reads to_row_id, the reverse reads from_row_id, and '
  'deleting from either side deletes the single underlying row. Sub-items and '
  'dependencies are self-relations stored here like any other.';


-- ---- db_properties: relation-pair integrity ----
-- Two partial unique indexes over the existing table from migration 014. Both
-- predicates exclude every row that exists today (no relation property can be
-- created yet — create_property has no relation path), so neither can fail on
-- apply against current production data. They exist to make the invariants the
-- header describes unfalsifiable by application bugs rather than merely
-- intended by them.

-- (1) A relation_id has at most ONE forward property and at most ONE reverse
--     property, globally. This is what makes "the pair" a well-defined thing:
--     without it, a bug could mint two forward properties on one relation_id
--     and every link would silently appear in both. Also the lookup index for
--     "given this relation_id, find the other side", which M7 runs constantly —
--     the relation_id prefix serves it.
--     One-way relations are unaffected: a forward row with no reverse row is
--     perfectly legal here.
CREATE UNIQUE INDEX IF NOT EXISTS db_properties_relation_pair_uniq
  ON db_properties ((config->>'relation_id'), (config->>'side'))
  WHERE type = 'relation' AND config->>'relation_id' IS NOT NULL;

-- (2) A data source has at most one sub-item pair and at most one dependency
--     pair. Research §3.2 is explicit that the sub-item property choice is
--     database-global — "The same property will be used to display sub-items
--     for all views of your database" — so a second one is not a feature, it is
--     a corrupt state. Four rows maximum per data source: sub_item/forward,
--     sub_item/reverse, dependency/forward, dependency/reverse.
--     `config->>'system' IS NOT NULL` rather than the `?` existence operator:
--     same result, and it keeps the predicate free of an operator that some
--     drivers mangle when this file is pasted somewhere other than psql.
CREATE UNIQUE INDEX IF NOT EXISTS db_properties_system_relation_uniq
  ON db_properties (data_source_id, (config->>'system'), (config->>'side'))
  WHERE type = 'relation' AND config->>'system' IS NOT NULL;

COMMIT;


-- ---- proof it applied ----
-- The plan's Migration Gates table names `SELECT count(*) FROM
-- db_relation_links;` as G2's proof query; that is `link_count` below (0 on a
-- fresh apply — the point is that the relation resolves at all). The other
-- three columns check the parts a bare count would not notice.
--
-- Expected on a successful apply:
--   link_count = 0, policy_count = 1, link_index_count = 5, pair_index_count = 2
--
-- link_index_count is 5, not 3: the primary key and the pair UNIQUE constraint
-- each own an index in addition to the three CREATE INDEX statements. Named so
-- a reader does not have to recount — db_relation_links_pkey,
-- db_relation_links_pair_uniq, db_relation_links_from_idx,
-- db_relation_links_to_idx, db_relation_links_user_idx.

SELECT 'migration 015 applied' AS status,
       (SELECT count(*) FROM db_relation_links) AS link_count,
       (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'db_relation_links') AS policy_count,
       (SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'db_relation_links') AS link_index_count,
       (SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'db_properties'
          AND indexname IN ('db_properties_relation_pair_uniq',
                            'db_properties_system_relation_uniq')) AS pair_index_count;
