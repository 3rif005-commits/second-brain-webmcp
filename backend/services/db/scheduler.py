"""In-process job scheduler bootstrap (Milestone 12, task-37).

Migration 017's own header comment already made this decision: an in-process
APScheduler, started in `main.py`'s lifespan, polling for due periodic work —
matching this app's existing deployment shape (one long-lived `uvicorn`
process per `app.sh start`, no queue/worker infrastructure, single user, no
horizontal scaling). No distributed locking: one process, one instance, and a
job that runs a tick late (e.g. after a `--reload` restart) is harmless — it
just runs on the next tick instead.

This task wires up only the repeating-row-template half of the tick
(`_tick_templates`). Task 38 (automations' `every_frequency` trigger) adds a
`_tick_automations(conn)` call alongside it inside `_tick()` — `_tick()` is
structured as a thin dispatcher over per-concern functions specifically so
that addition doesn't require restructuring this module.

(Task 38 update: `_tick_automations` itself lives in `services/db/automations.py`,
not here — unlike `_tick_templates` above, its due-work handling needed enough
automations-specific business logic (action-chain execution, `end_date` handling)
that it belongs with the rest of that module's own automation logic. `_tick()`
below just calls `automations_service._tick_automations(conn)`, the same shape
`_tick_templates` already established for "one call per concern.")

Runs outside any HTTP request, so it cannot reuse `services/db/connection.
get_conn` (a FastAPI request-scoped dependency) — it acquires its own
connection from the shared `get_pool()` each tick instead.
"""
from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from services.db import automations as automations_service
from services.db import templates as templates_service
from services.db.connection import get_pool
from services.indexer import try_index_note

logger = logging.getLogger(__name__)

_TICK_INTERVAL_SECONDS = 60
_JOB_ID = "db_scheduler_tick"

_scheduler: AsyncIOScheduler | None = None


async def _tick_templates(conn) -> int:
    """One pass over every repeating template due to run: `SELECT ... WHERE
    next_run_at <= now()`, restricted to `repeat_config IS NOT NULL` (a
    non-repeating template always has `next_run_at IS NULL` too, per
    migration 017's own invariant, but this predicate makes the tick
    correct even if that invariant were ever violated, rather than relying
    on it). For each due row: instantiate it, then advance `next_run_at` to
    `next_occurrence(repeat_config, <the next_run_at that just fired>)` —
    both inside one transaction per template, so a crash between the two
    can't either lose the occurrence or fire it twice next tick.

    Not scoped to one `user_id` — this is a system-wide background job, not
    a request handler, so it legitimately scans every user's due templates
    in one query and re-derives each row's own `user_id` from the row
    itself for the `instantiate_template` call. This is not a violation of
    this plan's per-request `_scope()` discipline, which governs
    request-scoped queries deriving `user_id` from an authenticated
    caller — there is no such caller here.

    Returns the number of rows created (tests assert on this; also useful
    for logging).
    """
    due = await conn.fetch(
        """
        SELECT id, user_id, repeat_config, next_run_at
        FROM db_row_templates
        WHERE repeat_config IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= now()
        """
    )
    created = 0
    for row in due:
        template_id = str(row["id"])
        user_id = str(row["user_id"])
        async with conn.transaction():
            result = await templates_service.instantiate_template(conn, user_id, template_id)
            if result is None:
                # Deleted concurrently between the SELECT above and here --
                # nothing to instantiate or advance.
                continue
            new_next_run_at = templates_service.next_occurrence(
                row["repeat_config"], row["next_run_at"]
            )
            await conn.execute(
                """
                UPDATE db_row_templates SET next_run_at = $1, updated_at = now()
                WHERE id = $2 AND user_id = $3
                """,
                new_next_run_at,
                template_id,
                user_id,
            )
        # Fix 6 (task-51, M14 final cross-cutting review): best-effort, non-fatal
        # property-preamble refresh -- see `services/indexer.py`'s `try_index_note`
        # docstring. Called AFTER the `async with conn.transaction():` block above
        # has exited (this row's own INSERT + `next_run_at` advance are committed),
        # never inside it -- same "don't hold the transaction open for a slow/
        # network-fallible embedder call" reasoning `db_import.py`'s per-row loop
        # documents. Without this, a row created by a repeating template firing on
        # schedule was permanently unsearchable by property value.
        #
        # Controller catch (post-task-51 verification): this loop runs on the SAME
        # event loop as the rest of the app -- `AsyncIOScheduler` (imported above)
        # integrates directly with the running asyncio loop, it does not run in a
        # separate thread/process. Calling the synchronous, blocking `try_index_note`
        # directly here for every due template in one tick is structurally the exact
        # same event-loop-starvation bug Fix 1 (this same commit) closed for
        # `db_import.py`'s per-row loop, just reintroduced one function away in the
        # same fix round: any tick with multiple due templates would block every
        # concurrent HTTP request for the tick's duration. `asyncio.to_thread`,
        # identically to Fix 1's own fix.
        await asyncio.to_thread(try_index_note, result.id, user_id)
        created += 1
    return created


async def _tick() -> None:
    """The scheduler job's body: acquire a pool connection for this tick
    only (never a long-held one), run each due-work pass, release it.
    Never lets a tick failure (e.g. `DATABASE_URL` unset in an environment
    that never touched the database query engine, same "safe no-op"
    posture as `close_pool()`) crash the process or stop future ticks —
    logged and swallowed, matching the plan's "one process, no distributed
    system" reasoning: a missed tick is retried automatically 60 seconds
    later.

    The two passes (templates, automations) are isolated from each other
    (combined M12 review's Finding 3, controller-added): they were
    previously both inside one try/except, so a template-pass exception
    would skip that tick's automations pass too, and vice versa. Each is
    unrelated due-work with its own retry-next-tick posture, so one
    failing must not withhold the other from running this same tick.
    """
    try:
        pool = await get_pool()
    except Exception:
        logger.exception("scheduler tick: could not acquire the database pool")
        return
    try:
        async with pool.acquire() as conn:
            try:
                await _tick_templates(conn)
            except Exception:
                logger.exception("scheduler tick: templates pass failed")
            try:
                await automations_service._tick_automations(conn)
            except Exception:
                logger.exception("scheduler tick: automations pass failed")
    except Exception:
        logger.exception("scheduler tick failed")


def start_scheduler() -> None:
    """Idempotent: a second call while already running is a no-op (matches
    `get_pool()`'s own "creating it on first call" posture)."""
    global _scheduler
    if _scheduler is not None:
        return
    scheduler = AsyncIOScheduler()
    scheduler.add_job(_tick, IntervalTrigger(seconds=_TICK_INTERVAL_SECONDS), id=_JOB_ID)
    scheduler.start()
    _scheduler = scheduler


def stop_scheduler() -> None:
    """Safe no-op if the scheduler was never started (mirrors `close_pool`)."""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
