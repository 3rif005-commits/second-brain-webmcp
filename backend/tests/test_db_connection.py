"""Tests for the asyncpg pool lifecycle (services/db/connection.py).

No real DATABASE_URL is configured in this environment (Supabase pooler
connection string, port 6543, is not yet in backend/.env), so these tests
only cover what's testable without a live database: `get_pool()` raising
its documented RuntimeError when `settings.database_url` is empty (the
default), and `close_pool()` being a safe no-op when no pool was ever
created. Opening a real connection is explicitly out of scope here.
"""
import asyncio

import pytest

from services.db import connection


@pytest.fixture(autouse=True)
def _reset_pool():
    """Each test starts and ends with a clean module-level `_pool` and
    `_pool_lock`. The lock also needs resetting, not just the pool: an
    `asyncio.Lock` binds to whichever event loop first contends it, and
    pytest-asyncio gives each test its own loop, so a stale lock from a
    prior test would raise `RuntimeError: <Lock> is bound to a different
    event loop` the next time a test drives real contention on it."""
    connection._pool = None
    connection._pool_lock = None
    yield
    connection._pool = None
    connection._pool_lock = None


async def test_get_pool_raises_when_database_url_is_empty(monkeypatch):
    monkeypatch.setattr(connection.settings, "database_url", "")

    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        await connection.get_pool()


async def test_get_pool_error_mentions_the_pooler_port(monkeypatch):
    # The error message is the only guidance a developer gets when this
    # fires in a fresh checkout — assert it actually names the fix.
    monkeypatch.setattr(connection.settings, "database_url", "")

    with pytest.raises(RuntimeError, match="6543"):
        await connection.get_pool()


async def test_close_pool_is_a_safe_noop_when_never_created():
    assert connection._pool is None
    await connection.close_pool()
    assert connection._pool is None


# --------------------------------------------------------------------------
# Final-review findings 4 and 7. `asyncpg.create_pool` is stubbed out (no live
# database in this environment); what's under test is the *lifecycle* logic in
# this module, not asyncpg itself.
# --------------------------------------------------------------------------

class _FakePool:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.closed = False

    async def close(self):
        self.closed = True


@pytest.fixture
def fake_create_pool(monkeypatch):
    """Replaces `asyncpg.create_pool` with a slow-ish coroutine that records
    every call. The `await` inside is what makes a first-caller race
    observable: without a lock, a second caller entering while the first is
    suspended also sees `_pool is None`."""
    calls = []

    async def _create_pool(dsn, **kwargs):
        calls.append((dsn, kwargs))
        await asyncio.sleep(0)  # yield: lets any concurrent caller run
        await asyncio.sleep(0)
        return _FakePool(**kwargs)

    monkeypatch.setattr(connection.settings, "database_url", "postgresql://u:p@h:6543/db")
    monkeypatch.setattr(connection.asyncpg, "create_pool", _create_pool)
    return calls


async def test_concurrent_first_callers_create_exactly_one_pool(fake_create_pool):
    pools = await asyncio.gather(*(connection.get_pool() for _ in range(10)))

    assert len(fake_create_pool) == 1, (
        "a second pool was built and silently orphaned — it is never closed "
        "and holds connections against the pooler's cap until process exit"
    )
    assert all(pool is pools[0] for pool in pools)
    assert connection._pool is pools[0]


async def test_pool_is_created_once_across_sequential_calls(fake_create_pool):
    first = await connection.get_pool()
    second = await connection.get_pool()
    assert first is second
    assert len(fake_create_pool) == 1


async def test_pool_disables_prepared_statement_cache_for_the_pooler(fake_create_pool):
    """Port 6543 is Supabase's transaction-mode pooler: asyncpg's named
    prepared statements break against it ("prepared statement
    __asyncpg_stmt_N__ already exists")."""
    await connection.get_pool()
    _dsn, kwargs = fake_create_pool[0]
    assert kwargs["statement_cache_size"] == 0


async def test_pool_sets_a_command_timeout(fake_create_pool):
    await connection.get_pool()
    _dsn, kwargs = fake_create_pool[0]
    assert kwargs["command_timeout"] and kwargs["command_timeout"] <= 60


async def test_close_pool_closes_and_clears(fake_create_pool):
    pool = await connection.get_pool()
    await connection.close_pool()
    assert pool.closed is True
    assert connection._pool is None

    # ...and a later caller gets a fresh pool, not the closed one.
    again = await connection.get_pool()
    assert again is not pool
    assert len(fake_create_pool) == 2
