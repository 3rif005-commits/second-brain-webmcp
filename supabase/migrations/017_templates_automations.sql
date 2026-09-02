-- Migration 017: Notion Databases — row templates, automations, notifications
-- Tables: db_row_templates, db_automations, db_notifications
--
-- Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §3.2 (table
--   list), §1 (Slack/Teams/email non-goal — "In-app toast + generic outbound
--   webhook" instead)
-- Plan: docs/plans/2026-08-08-notion-databases.md (Migration Gates, G4)
-- Research: docs/research/notion-databases-research.md §J.5 (row templates,
--   ~line 5632), §J.6 (buttons and automations, ~line 5746)
--
-- This migration does not reference `vector`, so the
-- `SET LOCAL search_path = public, extensions;` rule does not apply here.
--
--
-- ---------------------------------------------------------------------------
-- THREE TABLES, NOT TWO — db_notifications is a genuine addition beyond the
-- plan's original two-table description for 017, in the same category as
-- migration 019 (notes_excluding_database_rows) being added mid-plan when a
-- real, load-bearing need was found that the original architecture didn't
-- name. Both button actions (§J.6.1/6.2) and database automations (§J.6.6)
-- have a "Send notification to" action, and this app has genuinely nowhere
-- for that to land: it has no realtime channel (spec §11.4 — deferred, with
-- the reason) and no existing notification storage anywhere (grepped, zero
-- hits outside the frontend's own ephemeral useToast()). A toast only reaches
-- a tab that is open and looking; an automation firing on a background
-- schedule tick has no live page to toast into. `db_notifications` is the
-- minimal persisted inbox that makes the action mean something real instead
-- of a silent no-op — a row per notification, polled/fetched on load, not a
-- push channel. Bundled into this migration rather than given its own gate
-- because it is a direct, same-milestone dependency of what 017 exists to
-- support, not an unrelated fix.
--
--
-- ---------------------------------------------------------------------------
-- SCHEDULING — the one genuinely new architectural piece this migration's
-- schema commits to, recorded here because two columns below depend on it.
-- ---------------------------------------------------------------------------
--
-- Repeating row templates (research §J.5.3) and the `Every {frequency}`
-- automation trigger (research §J.6.5) both need SOME periodic execution
-- mechanism. This codebase has none today — grepped for apscheduler/celery/
-- cron/systemd/a `while True` polling loop anywhere in backend/, and read
-- `services/db/recompute.py` (Milestone 8's own "materialise on demand," the
-- closest existing thing) to confirm it runs synchronously on write, never on
-- a schedule. `main.py`'s lifespan does nothing but open/close the connection
-- pool.
--
-- Decision, made now so the schema and the later application code agree: an
-- in-process scheduler (APScheduler, started in `main.py`'s lifespan) polling
-- both tables periodically for due work. This matches the app's own existing
-- deployment shape — one long-lived `uvicorn` process per `app.sh start`, no
-- queue/worker infrastructure, single user, no horizontal scaling — the same
-- "personal single-user KB, not a distributed system" reasoning this plan
-- already applies to M2's 500-row cap and M4's pure-Python grouping. No
-- distributed locking is needed for the same reason: one process, one
-- instance, and a job that runs a tick late after a `--reload` restart is
-- harmless (it runs on the next tick instead).
--
-- `db_row_templates.next_run_at` and `db_automations.next_run_at` are what the
-- scheduler's tick queries filter on (`WHERE next_run_at <= now()`); both get
-- a partial index below. Neither is a FK-backed relationship — they are the
-- literal "next due" instant, recomputed by application code after each run
-- from the record's own `repeat_config`/trigger config.
--
--
-- ---------------------------------------------------------------------------
-- ACTION-CHAIN JSONB SHAPE, shared across db_automations.actions and (once
-- the button property/button block frontend work lands) a button's own
-- config.actions — one executor, three callers, per the file-structure note
-- in services/db/automations.py's own header comment. Not enforced by a CHECK
-- here (same "polymorphic JSONB validated by application code, not DDL"
-- convention `db_views.filter`/`db_views.sorts` already established), but the
-- action-kind vocabulary is pinned here in prose so the application code and
-- this file's own comments cannot drift silently:
--
--   edit_property     — all three surfaces (button property, button block,
--                        database automation)
--   add_page_to       — all three
--   edit_pages_in     — all three
--   send_notification — all three (writes a db_notifications row)
--   send_webhook      — all three (generic outbound POST — spec §1's stated
--                        replacement for Slack/Teams/email, which are
--                        deliberately NOT built; the UI must say so rather
--                        than offering a dead control, per the plan's own M12
--                        test case)
--   define_variables   — all three (reuses the Milestone 8 formula engine to
--                        evaluate a named expression against the trigger/
--                        clicked row's context, consumable by later actions
--                        in the same chain)
--   show_confirmation  — button property + button block ONLY (needs a
--                        clicking user; a database automation has none)
--   open_page_or_url   — button property + button block ONLY, same reason
--   insert_blocks      — button BLOCK ONLY (needs the note's own BlockNote
--                        editor instance; a button property's row has no
--                        "the page it lives on" distinct from itself in the
--                        same way)
--
-- Two research-documented actions are deliberately NOT in this vocabulary at
-- all: `send_mail_to` (Gmail) and `send_slack_notification_to` — spec §1's
-- non-goals table excludes both by name ("Slack/Teams/email automation
-- actions ... In-app toast + generic outbound webhook instead").
--
-- research §J.6.2 documents an unresolved conflict about which actions a
-- button PROPERTY (as opposed to a button BLOCK) actually supports: the
-- dedicated button-property guide names only 4 (add page, edit pages, show
-- confirmation, open page), while the "complete action list" section (§6.2's
-- own title) names 9 (everything above except insert_blocks). Ruling, made
-- now rather than left for the frontend/backend task to guess: trust the
-- section that explicitly claims to be the complete list over what reads as
-- an introductory walkthrough that likely isn't exhaustive. Button property
-- and button block therefore share the identical 8-action set below;
-- button block alone adds insert_blocks (9 total).
--
--
-- ---------------------------------------------------------------------------
-- WHAT THIS SCHEMA DOES NOT ENFORCE (all of it on purpose, same discipline as
-- migration 015's equivalent section)
-- ---------------------------------------------------------------------------
--
-- 1. No CHECK tying db_automations.triggers' shape to trigger_combinator, and
--    no CHECK forbidding an `every_frequency` trigger from coexisting with
--    another trigger type in the same `triggers` array — research §J.6.5 says
--    Notion itself forbids this ("a recurring trigger... can't be paired with
--    another type of trigger"), but it is a product rule with a specific error
--    message, not a data-integrity invariant; enforcing it in DDL would turn a
--    should-be-400 into an opaque constraint violation. Application code
--    validates it at save time, same reasoning as migration 015's self-link
--    CHECK omission.
-- 2. No FK from db_notifications.source to whatever produced it (an
--    automation, a button click) — deliberately a free-text tag, not a
--    reference, so a notification survives the automation/button that
--    created it being edited or deleted (same reasoning as db_relation_links
--    not FK'ing relation_id: the notification belongs to the event, not to
--    the still-existing definition of what caused it).
-- 3. No uniqueness constraint on db_automations.name or db_row_templates.name
--    — Notion does not document one ("Nope! You can make as many as you
--    want" — research §J.5.1, about templates; automations have no
--    documented limit either, §J.6.7's own UNRESOLVED note).

BEGIN;

-- ---- db_row_templates ----
-- `properties` captures pre-filled property VALUES, same JSONB shape as
-- `db_row_props.properties` (keyed by the 8-char property key) — research
-- §J.5.1: "you can create a template for bug reports that automatically puts
-- P1 in the Priority property." `content` captures the page BODY, literally
-- the same shape as `notes.content` (`supabase/migrations/001_initial_schema.
-- sql`'s `content JSONB NOT NULL DEFAULT '[]'`, BlockNote's own block array) —
-- so instantiating a template is "copy `content` verbatim into the new row's
-- `notes.content`, merge `properties` into the new `db_row_props.properties`,"
-- no translation layer needed in either direction.
--
-- `is_default` — research §J.5.2: "the data source's default" template,
-- applied when a new row is created with no template explicitly chosen. The
-- partial unique index below makes "at most one default per data source" a
-- schema invariant, not an application convention that can drift.
--
-- `repeat_config`/`next_run_at` — NULL `repeat_config` means "not repeating"
-- (the common case); a non-NULL value holds the frequency/interval/weekdays/
-- start-date/time-of-day/timezone shape research §J.5.3 documents, validated
-- by application code (see the action-chain note above for why this file
-- does not attempt to shape-check JSONB). `next_run_at` is NULL exactly when
-- `repeat_config` is NULL, kept in sync by application code, not a CHECK
-- (same "the interesting invariant is a product rule, not a constraint"
-- reasoning as above).

CREATE TABLE IF NOT EXISTS db_row_templates (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id UUID        NOT NULL REFERENCES db_data_sources(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL DEFAULT 'Untitled template',
  icon           TEXT,
  properties     JSONB       NOT NULL DEFAULT '{}',
  content        JSONB       NOT NULL DEFAULT '[]',
  is_default     BOOLEAN     NOT NULL DEFAULT FALSE,
  repeat_config  JSONB,
  next_run_at    TIMESTAMPTZ,
  position       INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS db_row_templates_data_source_idx ON db_row_templates(data_source_id);
CREATE INDEX IF NOT EXISTS db_row_templates_user_idx ON db_row_templates(user_id);

-- At most one default template per data source (research §J.5.2's "the data
-- source's default", singular). Predicate excludes every row that exists
-- today (this table is brand new), so it cannot fail on apply.
CREATE UNIQUE INDEX IF NOT EXISTS db_row_templates_one_default_uniq
  ON db_row_templates (data_source_id) WHERE is_default;

-- Scheduler tick query: "every repeating template due to run now." Partial on
-- the common case (most templates never repeat) keeps this index tiny.
CREATE INDEX IF NOT EXISTS db_row_templates_due_idx
  ON db_row_templates (next_run_at) WHERE next_run_at IS NOT NULL;

ALTER TABLE db_row_templates ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'db_row_templates'
      AND policyname = 'db_row_templates_owner_all'
  ) THEN
    CREATE POLICY db_row_templates_owner_all ON db_row_templates
      FOR ALL TO authenticated
      USING (user_id = (SELECT auth.uid()))
      WITH CHECK (user_id = (SELECT auth.uid()));
  END IF;
END $$;

COMMENT ON TABLE db_row_templates IS
  'Row templates (research §J.5): captured property values + page body, '
  'applied when creating a new row. is_default is unique per data_source_id. '
  'repeat_config/next_run_at drive the in-process scheduler for repeating '
  'templates (research §J.5.3) — NULL repeat_config means not repeating.';


-- ---- db_automations ----
-- `triggers` is a JSONB array of trigger objects, each carrying its own
-- `type` discriminator (`page_added` | `property_edited` | `every_frequency`)
-- plus type-specific fields — same polymorphic-array convention as
-- `db_views.sorts`. `trigger_combinator` is Notion's own "When any of these
-- occur" / "When all of these occur" (research §J.6.5).
--
-- `view_id` — research §J.6.5: "you can specify if the automation should run
-- on pages in the entire database, or in a specific view." NULL means the
-- whole data source; ON DELETE SET NULL rather than CASCADE because deleting
-- the view the automation was scoped to should widen its scope back to the
-- whole database, not silently delete the automation.
--
-- `actions` — the ordered action-chain array described in this file's header
-- comment above; database automations use 6 of the 9 documented kinds
-- (no show_confirmation/open_page_or_url/insert_blocks — research §J.6.6's
-- own explicit note: those need a clicking user, which an automation has
-- none of).
--
-- `is_active`/`last_error` — research §J.6.7: a working automation that
-- starts failing is auto-paused, and un-pausing is the one user-facing
-- toggle (`Active`). One boolean plus a text field is enough to represent
-- both "the user turned this off" and "the system turned this off after a
-- failure" — the two are the same state from every consumer's point of view
-- (execution stops either way), and `last_error` distinguishes why for the
-- UI to display, without needing a second boolean to keep in sync with the
-- first.

CREATE TABLE IF NOT EXISTS db_automations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id     UUID        NOT NULL REFERENCES db_data_sources(id) ON DELETE CASCADE,
  user_id            UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name               TEXT        NOT NULL DEFAULT 'Untitled automation',
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  last_error         TEXT,
  trigger_combinator TEXT        NOT NULL DEFAULT 'any'
                                  CONSTRAINT db_automations_trigger_combinator_check
                                  CHECK (trigger_combinator IN ('any', 'all')),
  triggers           JSONB       NOT NULL DEFAULT '[]',
  view_id            UUID        REFERENCES db_views(id) ON DELETE SET NULL,
  actions            JSONB       NOT NULL DEFAULT '[]',
  next_run_at        TIMESTAMPTZ,
  position           INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS db_automations_data_source_idx ON db_automations(data_source_id);
CREATE INDEX IF NOT EXISTS db_automations_user_idx ON db_automations(user_id);
CREATE INDEX IF NOT EXISTS db_automations_view_idx ON db_automations(view_id) WHERE view_id IS NOT NULL;

-- Scheduler tick query: "every active `every_frequency` automation due now."
-- `is_active` in the predicate so a paused automation drops out of the
-- scheduler's scan entirely rather than being fetched and skipped every tick.
CREATE INDEX IF NOT EXISTS db_automations_due_idx
  ON db_automations (next_run_at) WHERE next_run_at IS NOT NULL AND is_active;

ALTER TABLE db_automations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'db_automations'
      AND policyname = 'db_automations_owner_all'
  ) THEN
    CREATE POLICY db_automations_owner_all ON db_automations
      FOR ALL TO authenticated
      USING (user_id = (SELECT auth.uid()))
      WITH CHECK (user_id = (SELECT auth.uid()));
  END IF;
END $$;

COMMENT ON TABLE db_automations IS
  'Database automations (research §J.6.5-6.7): triggers (page_added | '
  'property_edited | every_frequency, combined via trigger_combinator any/'
  'all) firing an ordered action chain. next_run_at drives the in-process '
  'scheduler for every_frequency triggers. is_active covers both a manual '
  'pause and the system auto-pause-on-repeated-failure Notion documents; '
  'last_error records why.';


-- ---- db_notifications ----
-- See the header note above for why this table exists at all. `source` is a
-- free-text tag ('automation:<id>' | 'button:<property_key>' | ...), not an
-- FK, so a notification outlives whatever produced it. `link` is an optional
-- in-app path (e.g. to the row that triggered it) for the frontend to
-- navigate to on click.

CREATE TABLE IF NOT EXISTS db_notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  message    TEXT        NOT NULL,
  link       TEXT,
  source     TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS db_notifications_user_idx ON db_notifications(user_id, created_at DESC);

-- Unread-count / unread-list query. Partial on the common steady state (most
-- notifications get read eventually, so the index stays small relative to
-- the table).
CREATE INDEX IF NOT EXISTS db_notifications_unread_idx
  ON db_notifications (user_id) WHERE read_at IS NULL;

ALTER TABLE db_notifications ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'db_notifications'
      AND policyname = 'db_notifications_owner_all'
  ) THEN
    CREATE POLICY db_notifications_owner_all ON db_notifications
      FOR ALL TO authenticated
      USING (user_id = (SELECT auth.uid()))
      WITH CHECK (user_id = (SELECT auth.uid()));
  END IF;
END $$;

COMMENT ON TABLE db_notifications IS
  'Minimal in-app notification inbox — the "send_notification" action''s '
  'target. Not a realtime push channel (spec §11.4): the frontend polls/'
  'fetches on load. Degenerate to a single recipient today (this app is '
  'single-user), same as People/Created by/Last edited by (spec §1).';

COMMIT;


-- ---- proof it applied ----
-- The plan's Migration Gates table names `SELECT count(*) FROM
-- db_automations;` as G4's proof query; that is `automation_count` below (0
-- on a fresh apply). The other columns check the parts a bare count would
-- not notice — all three tables landed, RLS is on, the two partial-unique/
-- due indexes exist.

SELECT 'migration 017 applied' AS status,
       (SELECT count(*) FROM db_automations) AS automation_count,
       (SELECT count(*) FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('db_row_templates', 'db_automations', 'db_notifications')) AS tables_created,
       (SELECT count(*) FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('db_row_templates', 'db_automations', 'db_notifications')) AS policy_count,
       (SELECT count(*) FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN ('db_row_templates_one_default_uniq',
                            'db_row_templates_due_idx',
                            'db_automations_due_idx')) AS load_bearing_index_count;
