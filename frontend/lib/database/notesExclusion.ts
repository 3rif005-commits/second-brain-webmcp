/**
 * Notes-row exclusion (Notion-databases plan).
 *
 * Every notes surface must exclude rows that are actually a database row
 * (i.e. have a companion `db_row_props` entry) — the SQL equivalent of
 * `NOT EXISTS (SELECT 1 FROM db_row_props p WHERE p.note_id = notes.id)`.
 *
 * Milestone 1 shipped this as a placeholder: `excludedDatabaseRowIds`
 * fetched every `db_row_props.note_id` for the user and callers inlined
 * them into a PostgREST `.not("id","in",(...))` filter via
 * `applyNotesExclusion`. That worked but didn't scale — see the final
 * Milestone 1 review (finding 5) for the O(all database rows) extra
 * round-trip and the ~37-bytes-per-row URL growth that made it fall over
 * well short of the plan's 50,000-row envelope (spec §4.3).
 *
 * Migration `019_notes_exclusion_view.sql` replaced that mechanism with a
 * server-side anti-join, exposed as the view
 * `notes_excluding_database_rows` — `SELECT n.* FROM notes n WHERE NOT
 * EXISTS (SELECT 1 FROM db_row_props p WHERE p.note_id = n.id)`, with
 * `security_invoker = true` so it enforces the caller's own RLS exactly
 * like querying `notes` directly (see that migration's header for the
 * security details and the "silently clears on CREATE OR REPLACE without
 * the WITH clause" trap). Selecting from the view returns exactly the rows
 * the Milestone 1 placeholder was trying to filter down to, in one round
 * trip, with no id list in the query at all. As a result there is nothing
 * left to fetch or filter client-side — callers just need to know which
 * table/view to query.
 *
 * Gated behind `DATABASE_ROWS_ENABLED` (mirrors backend
 * `core/config.py: settings.database_rows_enabled`), default off.
 *
 * Read per-call (not cached at module load) so it can be exercised in
 * tests without a module-reload dance, and so a process-level env change
 * (unlikely outside tests, but cheap to support) takes effect immediately.
 */
function databaseRowsEnabled(): boolean {
  return process.env.DATABASE_ROWS_ENABLED === "true";
}

/**
 * Which table/view notes-listing surfaces (list, search, trash) should
 * query. When the flag is on, `notes_excluding_database_rows` (migration
 * 019) transparently excludes database rows; when it's off, `notes` is
 * queried directly and database rows are not filtered (matches the
 * pre-Milestone-2 behaviour, since `db_row_props` may not exist yet).
 */
export function notesTableName(): "notes" | "notes_excluding_database_rows" {
  return databaseRowsEnabled() ? "notes_excluding_database_rows" : "notes";
}
