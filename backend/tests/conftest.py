"""Shared test fixtures."""
import uuid

import pytest
import pytest_asyncio


@pytest.fixture
def tmp_skills_dir(tmp_path):
    """A temp directory with no skills, ready to be populated."""
    d = tmp_path / "skills"
    d.mkdir()
    return d


# ---------------------------------------------------------------------------
# Local pgtest harness fixtures (Milestone 2, database CRUD tests).
#
# SAFETY: this DSN is hardcoded and completely independent of
# `core.config.settings.database_url` (which now points at the real
# Supabase project). Nothing here ever imports or reads `settings`. Bring
# the harness up first: `./scripts/pgtest/up.sh && ./scripts/pgtest/apply.sh
# 001 014` (from the repo root) — these fixtures assume it's already running
# on localhost:55432 with all 14 migrations applied.
# ---------------------------------------------------------------------------

LOCAL_PGTEST_DSN = "postgresql://postgres:pw@localhost:55432/postgres"


@pytest_asyncio.fixture
async def db_conn():
    """A connection to the local pgtest harness, wrapped in a transaction
    that is ALWAYS rolled back on teardown (pass or fail) — no test needs
    manual cleanup, and no test can leak state into another.

    Uses the same jsonb codec (`services.db.connection._init_connection`)
    the production pool registers, so `db_conn.fetch(...)` results already
    decode jsonb columns to Python dict/list.
    """
    import asyncpg

    from services.db.connection import _init_connection

    conn = await asyncpg.connect(LOCAL_PGTEST_DSN)
    await _init_connection(conn)
    tr = conn.transaction()
    await tr.start()
    try:
        yield conn
    finally:
        await tr.rollback()
        await conn.close()


@pytest_asyncio.fixture
async def test_user(db_conn):
    """Inserts a fresh `auth.users` row (the pgtest shim) inside `db_conn`'s
    transaction, and returns the new user's id as a string. A fresh UUID
    per call, so tests never collide regardless of run order.

    Does NOT separately insert into `profiles`: migration 001's
    `on_auth_user_created` trigger (`handle_new_user()`) already inserts a
    matching `profiles` row for every `auth.users` insert — a second,
    explicit insert collides with it (`profiles_pkey` unique violation).
    """
    user_id = str(uuid.uuid4())
    email = f"{user_id}@test.local"
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", user_id, email
    )
    return user_id
