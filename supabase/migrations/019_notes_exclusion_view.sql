-- Migration 019: notes-listing view that excludes database rows
-- View: notes_excluding_database_rows
--
-- Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §3.2, §4.3
-- Plan: docs/plans/2026-08-08-notion-databases.md
--
-- A database row *is* a `notes` row: `db_row_props` (migration 014) is a 1:1
-- companion keyed by note_id. Every notes-listing surface (sidebar, notes
-- list, search, trash) must therefore hide notes that are really database
-- rows — the anti-join
--   NOT EXISTS (SELECT 1 FROM db_row_props p WHERE p.note_id = notes.id)
--
-- This replaces the Milestone 1 placeholder in
-- `frontend/lib/database/notesExclusion.ts`, which fetched *every*
-- `db_row_props.note_id` for the user and inlined them into a PostgREST
-- `.not("id","in",(...))` filter: an extra round trip per request plus a URL
-- that grows ~37 bytes per row, well short of the plan's 50,000-row envelope.
-- That module's own header names a server-side anti-join as the correct fix
-- and records that it could not be built until 014 was applied. It is.
--
-- Wiring the Next.js routes to this view (and flipping DATABASE_ROWS_ENABLED)
-- is deliberately NOT part of this migration — it is a follow-up task gated on
-- this file being applied to production, mirroring how 014 was handled.
--
-- Numbering: 015–018 are reserved in the plan's Migration Gates table for
-- relations / computed / templates+automations / forms. This view depends on
-- nothing those will add, so 019 is safe to write and apply ahead of them.
--
-- `SET LOCAL search_path` is set below even though this file never names
-- `vector`: `SELECT n.*` transitively exposes `notes.descriptor_embedding`
-- (a `vector`), and pinning the path also pins which schema the view lands in.
--
--
-- ⚠️ SECURITY — the single thing to get right here: `security_invoker`.
--
-- A Postgres view is, by default, evaluated with the *view owner's*
-- permissions, and the owner (`postgres` in the Supabase SQL editor) both owns
-- `notes` and is a superuser — so a default view over `notes` **bypasses the
-- notes RLS policy entirely** and would return every user's notes to any
-- authenticated caller. `WITH (security_invoker = true)` (PostgreSQL 15+;
-- Supabase and the local pgvector/pgvector:pg16 harness both support it) makes
-- permission checks and RLS evaluate as the *calling* role instead, so
-- `002_rls_policies.sql`'s `notes: owner select` policy (`auth.uid() =
-- user_id`) is enforced for the view exactly as it is for the table. Verified
-- on the harness with two users under `SET ROLE authenticated` +
-- `request.jwt.claim.sub`: each user sees only their own rows; the same view
-- created without the option leaked both users' notes.
--
-- ⚠️ SCOPE OF THAT GUARANTEE: `security_invoker` secures the **PostgREST /
-- end-user-JWT path only** — the Next.js routes, which connect as the caller's
-- own `authenticated` role. It gives *zero* tenancy to a `BYPASSRLS` role, and
-- `service_role` is one: RLS never applies to such a role, `security_invoker`
-- or not (confirmed on the harness — a BYPASSRLS caller selecting from this
-- view gets every user's rows). That is exactly the plan's Global Constraint:
-- "Tenancy is enforced in the query builder, not by RLS (asyncpg uses the
-- service role). `_scope()` is mandatory on every generated query." So the
-- backend's primary data path is *not* protected by this view. Any asyncpg or
-- service-role code that queries this view — or `notes` / `db_row_props`
-- directly — still needs its own explicit `user_id` scoping. Do not read this
-- migration as a substitute for `_scope()`.
--
-- Note that under `security_invoker` the `db_row_props` subquery is *also*
-- evaluated as the caller, so it too is filtered by that table's RLS
-- (`user_id = (SELECT auth.uid())`, migration 014). The view is safe either
-- way, for a structural reason worth stating outright: `db_row_props` appears
-- only inside a negated `NOT EXISTS`, so the result is always a *subset* of
-- the rows the caller can already read from `notes` itself. Whatever the
-- subquery does or doesn't see, it can only ever remove rows, never add one.
--
-- Concretely: nothing in the schema forces `db_row_props.user_id` to equal its
-- note's owner (no FK or CHECK ties them), and a direct PostgREST insert as
-- one user targeting another's note can create that divergence. The subset
-- property above is why that is not a security bug — it fails only in the
-- harmless direction. A companion row owned by someone else leaves the note's
-- owner still seeing their own note (cosmetic duplicate in their list, both
-- verified on the harness); no user can ever hide, or see, another user's notes
-- through it.
--
-- Views have no RLS of their own: `ALTER VIEW … ENABLE ROW LEVEL SECURITY` is
-- not a Postgres command. Inheriting the base tables' policies via
-- `security_invoker` is the whole mechanism *for the JWT path*; there is
-- deliberately nothing else here.
--
-- `CREATE OR REPLACE VIEW` is the idempotent form for views — Postgres has no
-- `CREATE VIEW IF NOT EXISTS` — so this file is re-appliable, per the plan's
-- "new migrations must be independently applicable" rule.

BEGIN;

SET LOCAL search_path = public, extensions;

-- ---- notes_excluding_database_rows ----
-- `SELECT n.*` exposes every `notes` column unchanged so the existing routes'
-- column-list `.select(...)` calls keep working verbatim when they are pointed
-- at this view. It intentionally applies no other predicate (no deleted_at, no
-- user_id): callers keep their own filters, and user scoping is RLS's job.
--
-- Caveat for whoever adds a `notes` column later: Postgres expands the `*` at
-- creation time into a fixed column list, so a new `notes` column does NOT
-- appear here until this view is recreated. Any migration that adds a column
-- to `notes` should re-run this `CREATE OR REPLACE VIEW` (appending columns is
-- allowed; dropping or reordering them is not — that needs DROP + CREATE).
--
-- ⚠️ When you do re-run it, the `WITH (security_invoker = true)` clause MUST
-- be repeated. Verified on the harness: `CREATE OR REPLACE VIEW` without the
-- clause silently *clears* the option (reloptions goes from
-- {security_invoker=true} to NULL) and the view starts returning every user's
-- notes. It fails open, with no error. The DO block below turns that silent
-- failure into an aborted transaction for *this* file; the `security_invoker_on`
-- column in the closing proof SELECT reports it as well and must read `t`.

CREATE OR REPLACE VIEW notes_excluding_database_rows
WITH (security_invoker = true) AS
SELECT n.*
FROM notes n
WHERE NOT EXISTS (
  SELECT 1 FROM db_row_props p WHERE p.note_id = n.id
);

-- ---- fail-closed guard on the reloption ----
-- The warning above is only a comment, and a comment cannot stop a silent,
-- fail-open leak. This aborts the transaction if the view somehow ends up
-- without `security_invoker`, so a botched apply rolls back instead of going
-- live. It runs inside the same transaction as the CREATE: on a first apply a
-- failure leaves no view at all, and on a re-apply the rollback restores the
-- previously committed (correct) view rather than the broken replacement —
-- both verified on the harness.
--
-- What this does NOT cover, stated plainly: it protects *this migration's own
-- apply*. It cannot stop a future migration from replacing the view without
-- the WITH clause — catching that would need an event trigger on
-- `ddl_command_end`, which is out of scope here and deliberately not added.
-- For that case the in-file warning above is still the only protection.
--
-- `pg_options_to_table` is used rather than matching the literal string
-- 'security_invoker=true': Postgres accepts on/1/yes spellings for the
-- boolean, all of which a string match would misread (safe direction, but it
-- would abort a perfectly good apply). `relkind = 'v'` scopes the lookup to
-- the view proper.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_options_to_table((
      SELECT c.reloptions
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public'
        AND c.relname  = 'notes_excluding_database_rows'
        AND c.relkind  = 'v'
    ))
    WHERE option_name = 'security_invoker'
      AND option_value::boolean
  ) THEN
    RAISE EXCEPTION
      'migration 019 aborted: notes_excluding_database_rows exists without '
      'security_invoker=true. That view would return every user''s notes to '
      'any authenticated caller. Re-apply with the WITH clause intact; '
      'nothing has been committed.';
  END IF;
END $$;

COMMENT ON VIEW notes_excluding_database_rows IS
  'notes minus rows that are database rows (have a db_row_props companion). '
  'security_invoker=true — enforces the caller''s RLS on notes and '
  'db_row_props. Never drop that option: without it this view returns every '
  'user''s notes.';

-- PostgREST reaches this view with the caller's own JWT, i.e. as the
-- `authenticated` role, which must hold SELECT on the view itself *and* — a
-- security_invoker consequence — on `notes` and `db_row_props` underneath.
-- Supabase's default privileges already grant the latter two; this grant is
-- the explicit, replayable version of the one that matters.
GRANT SELECT ON notes_excluding_database_rows TO authenticated;

-- Supabase's default privileges very likely grant `anon` on new objects too,
-- so "anon isn't granted" would be wishful thinking rather than a fact — this
-- makes it a fact. It is defence in depth, not a fix: `anon` has no RLS policy
-- granting it notes (005's `anon_read_public_notes` never applied — see the
-- plan's pre-existing-bugs list), so it sees nothing through the view either
-- way. Signed-out visitors still have no business listing notes.
REVOKE ALL ON notes_excluding_database_rows FROM anon;

COMMIT;


-- ---- proof it applied ----
-- `security_invoker_on` must read `t`. The DO block above already refuses to
-- commit otherwise, so this is a second pair of eyes on the property that
-- matters, not the only one.
--
-- For whoever does the follow-up wiring task: PostgREST caches the schema, and
-- a brand-new view is invisible to it until that cache reloads (Supabase
-- normally handles this with an event trigger). If the first request against
-- `notes_excluding_database_rows` 404s right after this migration is applied,
-- that is the likely cause — the migration is fine; the cache is stale.

SELECT 'migration 019 applied' AS status,
       (SELECT count(*) FROM information_schema.views
        WHERE table_schema = 'public'
          AND table_name = 'notes_excluding_database_rows') AS view_created,
       EXISTS (
         SELECT 1
         FROM pg_options_to_table((
           SELECT c.reloptions
           FROM pg_class c
           JOIN pg_namespace ns ON ns.oid = c.relnamespace
           WHERE ns.nspname = 'public'
             AND c.relname  = 'notes_excluding_database_rows'
             AND c.relkind  = 'v'
         ))
         WHERE option_name = 'security_invoker'
           AND option_value::boolean
       ) AS security_invoker_on;
