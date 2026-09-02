-- Migration 016: Notion Databases — computed values (formulas + rollups)
--
-- Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.3
-- Plan: docs/plans/2026-08-08-notion-databases.md (Migration Gates, G3)
-- Benchmark: docs/research/storage-benchmark-results.md (Milestone 0)
--
-- ⚠️ READ THIS BEFORE LOOKING FOR THE CREATE INDEX STATEMENTS. THERE ARE NONE,
--    AND THAT IS THE FINDING THIS FILE EXISTS TO RECORD.
--
-- The plan's Migration Gates table describes G3 as "`computed` column,
-- expression indexes for hot properties". Checked against what is actually in
-- the database and what Milestone 8 actually needs, both halves turn out to be
-- already-settled or not-expressible:
--
-- 1. **The `computed` column already exists.** Migration 014 created
--    `db_row_props.computed JSONB NOT NULL DEFAULT '{}'` together with its
--    `jsonb_path_ops` GIN index `db_row_props_comp_gin`, and created
--    `db_properties.result_type` and `db_properties.is_volatile` — the two
--    columns spec §7.3/§7.4's type checker and volatility rule write to. The
--    plan's own file-structure section assigned them to 014 and 014 delivered
--    them. Nothing about the column is outstanding.
--
-- 2. **The expression indexes cannot be a static migration.** Milestone 0's
--    GO verdict rests on B-tree expression indexes of this shape
--    (scripts/bench/storage_bench.py, `bench_jsonb_indexed_hotnum`):
--
--      CREATE INDEX ... ON bench_jsonb_indexed
--        ((((properties->'numPri04'->>'number'))::double precision));
--
--    Note what is baked into the index: the **property key**. Keys are 8-char
--    base62 identifiers minted per data source at runtime by
--    backend/services/db/keys.py — they do not exist when a migration file is
--    written, they differ per user and per database, and there is an unbounded
--    number of them. A static file cannot name them. Postgres also cannot
--    index "whatever key this row happens to use": a B-tree expression index
--    matches only when the indexed expression appears **verbatim** in the
--    query, which is the same reason `SqlFragment`'s docstring in
--    backend/services/db/properties/base.py requires the key to be a SQL
--    literal rather than a bound parameter.
--
--    So hot-property expression indexes are an **operational** act performed
--    per property once a real database is known to be slow, not a schema
--    migration. §2 below is the recipe. Milestone 0's own review already
--    pointed at this gap from the other direction (storage-benchmark-results.md's
--    "Schema caveat": the benchmarked indexes do not lead with
--    `data_source_id`, which production's would have to) — the recipe fixes
--    that too.
--
-- Rather than invent index statements nobody can use, or ship speculative
-- indexes that every write would pay for and no query would use, this
-- migration does the one honest thing left: it **verifies that G3's
-- preconditions are actually true**, so "the computed substrate is in place"
-- stops being a claim and becomes a checked fact. It creates no objects and
-- changes no data; applying it is risk-free and re-applying it is a no-op.

BEGIN;

-- ---- §1. Fail closed if 014 did not deliver what §7.3 depends on ----
-- Milestone 8's engine writes formula and rollup results into
-- `db_row_props.computed` and reads its per-property metadata from
-- `db_properties.result_type` / `is_volatile`. If any of these is missing, the
-- engine is broken in a way that is far easier to diagnose here than at
-- runtime. This aborts the transaction rather than reporting a warning nobody
-- reads.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='db_row_props' AND column_name='computed'
  ) THEN missing := missing || 'db_row_props.computed'::text; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='db_properties' AND column_name='result_type'
  ) THEN missing := missing || 'db_properties.result_type'::text; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='db_properties' AND column_name='is_volatile'
  ) THEN missing := missing || 'db_properties.is_volatile'::text; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND tablename='db_row_props' AND indexname='db_row_props_comp_gin'
  ) THEN missing := missing || 'db_row_props_comp_gin'::text; END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'migration 016 aborted: migration 014 should already provide %, but it/they are absent. '
      'Milestone 8''s formula engine materialises into db_row_props.computed and cannot run '
      'without them. Nothing has been committed.', array_to_string(missing, ', ');
  END IF;
END $$;

-- `computed` is documented here rather than in 014 because 014 created it
-- before the engine that gives it meaning existed.
COMMENT ON COLUMN db_row_props.computed IS
  'Materialised formula and rollup results, keyed by property key, in the §3.3 '
  'wrapper shape. Written ONLY by backend/services/db/recompute.py — never by a '
  'row write, which touches `properties` alone (spec §7.3: keeping them in '
  'separate columns is what makes invalidation explicit). Volatile formulas '
  '(those referencing now()/today()) are never materialised here at all and are '
  'evaluated per request instead (spec §7.4). A value of {"type":"unsupported"} '
  'means a depth or fan-out limit was hit, matching Notion''s own API sentinel.';

COMMIT;


-- ---- §2. The hot-property expression index recipe (NOT executed) ----
--
-- Run these by hand, per property, only once a specific database is measurably
-- slow. Each one costs write throughput on every row insert and update, so
-- they are not free and should not be applied speculatively.
--
-- Substitute:
--   <DS>   the data source's UUID
--   <KEY>  the 8-char base62 property key (db_properties.key)
--
-- Leading with `data_source_id` is deliberate and is the correction Milestone
-- 0's review asked for: the benchmark's indexes omitted it, but every real
-- query carries the mandatory `_scope()` predicate on it (spec §8.3), so an
-- index without it has the wrong selectivity and often will not be chosen.
--
-- A stored (user-authored) number property:
--   CREATE INDEX CONCURRENTLY db_rp_<DS8>_<KEY>_num
--     ON db_row_props (data_source_id, (((properties->'<KEY>'->>'number'))::double precision));
--
-- A stored select/status property:
--   CREATE INDEX CONCURRENTLY db_rp_<DS8>_<KEY>_sel
--     ON db_row_props (data_source_id, (properties->'<KEY>'->>'select'));
--
-- A materialised formula or rollup (note `computed`, not `properties`; the
-- inner key is the formula's result_type):
--   CREATE INDEX CONCURRENTLY db_rp_<DS8>_<KEY>_calc
--     ON db_row_props (data_source_id, (((computed->'<KEY>'->>'number'))::double precision));
--
-- Three rules that make the difference between an index that works and one
-- that is merely present:
--   a. The expression must match the query's text **verbatim**, cast included.
--      `::double precision` is not interchangeable with `::numeric`; the
--      backend emits the former (properties/base.py `_VALUE_SHAPES`), and it
--      is the cast Milestone 0 benchmarked.
--   b. Use CONCURRENTLY on a populated table so the build does not hold a
--      write lock. CONCURRENTLY cannot run inside a transaction block, which
--      is a second reason these are not in the BEGIN/COMMIT above.
--   c. Verify with EXPLAIN afterwards. An expression index that is never
--      chosen is pure write-side cost — measure, do not assume.
--
-- Do NOT add a guarded/CASE-wrapped cast to these expressions without also
-- rebuilding the index to match. Milestone 3 shipped exactly that guard,
-- measured p95 ~450ms against the validated ~90ms because the CASE-wrapped
-- expression no longer matched the index, and reverted it (commits bfa9d06,
-- 1b49404). The decision comment lives in properties/base.py; this is the
-- other half of it.


-- ---- proof it applied ----
-- The Migration Gates table names `SELECT count(*) FROM db_row_props WHERE
-- computed <> '{}';` as G3's proof query — that is `rows_with_computed` below
-- (0 until Milestone 8's first recompute pass runs; the point is that the
-- column and the predicate resolve at all).
--
-- Expected on a successful apply: rows_with_computed = 0, preconditions_ok = 4.

SELECT 'migration 016 applied' AS status,
       (SELECT count(*) FROM db_row_props WHERE computed <> '{}') AS rows_with_computed,
       (
         (SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='db_row_props' AND column_name='computed')
       + (SELECT count(*) FROM information_schema.columns
          WHERE table_schema='public' AND table_name='db_properties'
            AND column_name IN ('result_type','is_volatile'))
       + (SELECT count(*) FROM pg_indexes
          WHERE schemaname='public' AND tablename='db_row_props'
            AND indexname='db_row_props_comp_gin')
       ) AS preconditions_ok;
