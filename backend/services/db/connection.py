"""asyncpg pool lifecycle for the database query engine.

A real `DATABASE_URL` (Supabase pooler connection string, port 6543) is
required at runtime once the query engine is exercised — approved
decision, see `docs/plans/2026-08-08-notion-databases.md` Global
Constraints. Until then (and while `settings.database_rows_enabled` is
False), nothing in this process calls `get_pool()`, so the missing
`DATABASE_URL` in this environment is harmless.
"""
import asyncio
import json
from typing import AsyncIterator

import asyncpg
from core.config import settings

_pool: asyncpg.Pool | None = None
_pool_lock: asyncio.Lock | None = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Per-physical-connection setup: decode/encode `jsonb` as Python
    dict/list rather than asyncpg's default (raw text). Every table this
    milestone touches (`db_databases.description`, `db_properties.config`,
    `db_row_props.properties`/`computed`, `db_views.config`/`filter`/
    `sorts`) is jsonb, so every caller of `get_pool()`/`get_conn()` needs
    this codec active — set once here rather than per query.

    Registered as the pool's `init` callback (see `get_pool` below), so it
    fires for every new physical connection the pool opens. Tests that
    connect directly to the local pgtest harness (bypassing the pool) must
    call this explicitly to get the same behaviour — see
    `tests/conftest.py`'s `db_conn` fixture.
    """
    await conn.set_type_codec(
        "jsonb", encoder=json.dumps, decoder=json.loads,
        schema="pg_catalog", format="text",
    )


# Port 6543 is Supabase's Supavisor pooler in **transaction mode**: a
# different backend connection can serve each statement. asyncpg's named
# server-side prepared statements do not survive that (`prepared statement
# "__asyncpg_stmt_N__" already exists`), so the cache is disabled. Do not
# "optimise" this back on while DATABASE_URL points at the pooler.
_STATEMENT_CACHE_SIZE = 0

# A runaway query must not hold a pool slot forever (max_size=10 slots
# total against a pooler with a hard connection cap).
_COMMAND_TIMEOUT_SECONDS = 30.0


def _get_lock() -> asyncio.Lock:
    """Lazily create the module-level creation lock.

    Created on first use rather than at import time so the Lock is never
    bound to an event loop that isn't the one actually serving requests.
    Creating it is synchronous — there is no `await` between the check and
    the assignment — so this is itself race-free on a single event loop.
    """
    global _pool_lock
    if _pool_lock is None:
        _pool_lock = asyncio.Lock()
    return _pool_lock


async def get_pool() -> asyncpg.Pool:
    """Return the process-wide asyncpg pool, creating it on first call.

    Creation is guarded by a lock with a double-check inside it: two
    concurrent first callers would otherwise both observe `_pool is None`,
    both build a pool, and the loser's pool would be silently overwritten
    — never closed, holding connections against the pooler's cap until the
    process exits.
    """
    global _pool
    if _pool is not None:
        return _pool

    async with _get_lock():
        # Double-check: another caller may have created it while we waited.
        if _pool is None:
            if not settings.database_url:
                raise RuntimeError(
                    "DATABASE_URL is required for the database query engine. "
                    "Use the Supabase pooler connection string (port 6543)."
                )
            _pool = await asyncpg.create_pool(
                settings.database_url,
                min_size=1,
                max_size=10,
                statement_cache_size=_STATEMENT_CACHE_SIZE,
                command_timeout=_COMMAND_TIMEOUT_SECONDS,
                init=_init_connection,
            )
    return _pool


async def get_conn() -> AsyncIterator[asyncpg.Connection]:
    """FastAPI dependency: acquire a pool connection for the lifetime of one
    request. `routers/databases.py` depends on this rather than calling
    `get_pool()` directly so tests can override it (`app.dependency_
    overrides[get_conn]`) with a single, transaction-wrapped connection to
    the local pgtest harness — see `tests/conftest.py`.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        yield conn


async def close_pool() -> None:
    """Close the asyncpg pool, if one was ever created.

    Safe to call even when `get_pool()` was never invoked in this process
    (e.g. because `database_rows_enabled` is False and nothing has touched
    the database query engine yet) — used as a FastAPI shutdown hook.

    Takes the same lock as `get_pool()` so a shutdown racing an in-flight
    first call can't close a pool out from under its creator.
    """
    global _pool
    async with _get_lock():
        if _pool is not None:
            await _pool.close()
            _pool = None
