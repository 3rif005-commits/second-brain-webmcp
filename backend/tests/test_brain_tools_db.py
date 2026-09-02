"""Tests for the 5 database agent tools (Milestone 14, task 49):
brain.list_databases, brain.get_database_schema, brain.query_database,
brain.create_row, brain.update_row.

Unlike the 10 pre-existing tools (`tests/test_brain_tools.py`, mocked via
`@patch("services.agent.brain_tools.get_supabase")`), these 5 live entirely
behind asyncpg/the Milestone 3+ filter/sort compiler -- there is nothing
mockable at that layer without duplicating (and risking drift from) the
real SQL-generation logic, so they run against the local pgtest harness
through the transaction-wrapped `db_conn`/`test_user` fixtures
(`tests/conftest.py`), rolled back on teardown, same convention as
`test_db_automations.py`/`test_db_templates.py`.

Each tool acquires its own connection via `services.agent.brain_tools.
get_pool()` (not a FastAPI `Depends(get_conn)` — there is no request here),
so the `patched_pool` fixture below patches that one name to hand back
`db_conn` itself, wrapped in a fake asyncpg Pool whose `.acquire()` yields
it — the same fake-pool shape `test_db_scheduler.py` already uses for
`services.db.scheduler.get_pool`, just yielding a *real* transaction-backed
connection instead of a string sentinel.
"""
from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

from services.agent.brain_tools import execute_brain_tool

pytestmark = pytest.mark.asyncio


# ===========================================================================
# Helpers (duplicated from test_db_automations.py's own precedent of small,
# per-test-file helper duplication rather than a shared cross-file import).
# ===========================================================================


async def _make_data_source(db_conn, user_id, *, name="DS", title="T") -> str:
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, $2) RETURNING id",
        user_id, title,
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, $3) RETURNING id",
        db_row["id"], user_id, name,
    )
    return str(ds_row["id"])


async def _insert_property(
    db_conn, user_id, data_source_id, key, name, type_, *, config=None,
) -> str:
    await db_conn.execute(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type, config)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        data_source_id, user_id, key, name, type_, config or {},
    )
    return key


async def _make_row(db_conn, user_id, data_source_id, *, title="Row", properties=None) -> str:
    note = await db_conn.fetchrow(
        "INSERT INTO notes (user_id, title) VALUES ($1, $2) RETURNING id", user_id, title
    )
    await db_conn.execute(
        "INSERT INTO db_row_props (note_id, data_source_id, user_id, properties) VALUES ($1, $2, $3, $4)",
        note["id"], data_source_id, user_id, properties or {},
    )
    return str(note["id"])


async def _insert_automation(db_conn, user_id, data_source_id, **overrides) -> str:
    fields = {
        "name": "A",
        "is_active": True,
        "last_error": None,
        "trigger_combinator": "any",
        "triggers": [],
        "view_id": None,
        "actions": [],
        "next_run_at": None,
        "position": 0,
    }
    fields.update(overrides)
    row = await db_conn.fetchrow(
        """
        INSERT INTO db_automations
            (data_source_id, user_id, name, is_active, last_error, trigger_combinator,
             triggers, view_id, actions, next_run_at, position)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id
        """,
        data_source_id, user_id, fields["name"], fields["is_active"], fields["last_error"],
        fields["trigger_combinator"], fields["triggers"], fields["view_id"], fields["actions"],
        fields["next_run_at"], fields["position"],
    )
    return str(row["id"])


async def _other_user(db_conn) -> str:
    other_user = str(uuid.uuid4())
    await db_conn.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2)", other_user, f"{other_user}@t.local"
    )
    return other_user


def _fake_pool(conn) -> MagicMock:
    """A fake asyncpg Pool whose one `.acquire()` context manager always
    yields `conn` -- same shape `test_db_scheduler.py`'s own `_fake_pool()`
    uses, just handing back a real transaction-backed connection instead of
    a sentinel string, so the tool bodies' own
    `pool = await get_pool(); async with pool.acquire() as conn:` runs
    completely unmodified against real data."""
    pool = MagicMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=conn)
    cm.__aexit__ = AsyncMock(return_value=False)
    pool.acquire = MagicMock(return_value=cm)
    return pool


@pytest_asyncio.fixture
async def patched_pool(db_conn):
    """Patches `services.agent.brain_tools.get_pool` (the name imported
    into that module, not `services.db.connection.get_pool` itself -- same
    "patch where it's looked up" convention `test_db_scheduler.py` follows
    for `services.db.scheduler.get_pool`) so every one of the 5 tools below
    acquires `db_conn` -- and therefore runs inside its already-open,
    always-rolled-back transaction."""
    fake_pool = _fake_pool(db_conn)
    with patch(
        "services.agent.brain_tools.get_pool", AsyncMock(return_value=fake_pool)
    ):
        yield db_conn


# ===========================================================================
# execute_brain_tool is now async-callable — regression guard (brief's own
# explicit ask): the signature change must not silently break a pre-
# existing SYNC tool when awaited from a caller.
# ===========================================================================


async def test_execute_brain_tool_is_awaitable_and_sync_tools_still_work():
    with (
        patch("services.agent.brain_tools.embed", return_value=[0.1, 0.2]),
        patch(
            "services.agent.brain_tools.retrieve",
            return_value=[{"id": "n1", "title": "T", "content_text": "x", "similarity": 0.9}],
        ),
    ):
        result = await execute_brain_tool(
            "brain.search_brain", args={"query": "anything"}, user_id="u1"
        )
    assert result["matches"][0]["id"] == "n1"


# ===========================================================================
# brain.list_databases / brain.get_database_schema
# ===========================================================================


async def test_list_databases_returns_only_the_calling_users_databases(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user, title="Mine")
    other_user = await _other_user(db_conn)
    await _make_data_source(db_conn, other_user, title="Not mine")

    result = await execute_brain_tool("brain.list_databases", args={}, user_id=test_user)

    titles = [entry["database"]["title"] for entry in result["databases"]]
    assert "Mine" in titles
    assert "Not mine" not in titles
    # Confirms the data source id round-trips too (needed by the other 4 tools).
    mine = next(e for e in result["databases"] if e["database"]["title"] == "Mine")
    assert mine["data_source"]["id"] == ds_id


async def test_list_databases_empty_for_a_user_with_none(patched_pool, db_conn, test_user):
    other_user = await _other_user(db_conn)
    await _make_data_source(db_conn, other_user)

    result = await execute_brain_tool("brain.list_databases", args={}, user_id=test_user)
    assert result["databases"] == []


async def test_get_database_schema_returns_properties_for_owner(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "num1", "Score", "number")

    # database_id, not data_source_id -- look up the db_databases row via ds_id.
    db_id = str(await db_conn.fetchval(
        "SELECT database_id FROM db_data_sources WHERE id = $1", ds_id
    ))

    result = await execute_brain_tool(
        "brain.get_database_schema", args={"database_id": db_id}, user_id=test_user
    )
    assert result["data_source"]["id"] == ds_id
    keys = [p["key"] for p in result["properties"]]
    assert "num1" in keys


async def test_get_database_schema_rejects_another_users_database(patched_pool, db_conn, test_user):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    db_id = str(await db_conn.fetchval(
        "SELECT database_id FROM db_data_sources WHERE id = $1", ds_id
    ))

    with pytest.raises(ValueError, match="not found"):
        await execute_brain_tool(
            "brain.get_database_schema", args={"database_id": db_id}, user_id=test_user
        )


# ===========================================================================
# brain.query_database -- the tenancy claim the spec explicitly names.
# ===========================================================================


async def test_query_database_filter_returns_exactly_the_matching_rows(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "num1", "Score", "number")
    low = await _make_row(db_conn, test_user, ds_id, properties={"num1": {"type": "number", "number": 5}})
    high = await _make_row(db_conn, test_user, ds_id, properties={"num1": {"type": "number", "number": 15}})

    result = await execute_brain_tool(
        "brain.query_database",
        args={
            "data_source_id": ds_id,
            "filter": {"type": "condition", "property": "num1", "operator": "greater_than", "value": 10},
        },
        user_id=test_user,
    )

    ids = [r["id"] for r in result["rows"]]
    assert ids == [high]
    assert low not in ids


async def test_query_database_rejects_a_data_source_the_caller_does_not_own(patched_pool, db_conn, test_user):
    other_user = await _other_user(db_conn)
    ds_id = await _make_data_source(db_conn, other_user)
    await _insert_property(db_conn, other_user, ds_id, "num1", "Score", "number")
    await _make_row(db_conn, other_user, ds_id, properties={"num1": {"type": "number", "number": 99}})

    # This is the plan's own "asserted" test case (line 471): a filter naming a
    # data_source_id the calling user_id does NOT own must be rejected the exact
    # same way the HTTP endpoint rejects it (404 -> ValueError here), never
    # silently-empty results and never another user's rows leaking through.
    with pytest.raises(ValueError, match="not found"):
        await execute_brain_tool(
            "brain.query_database",
            args={"data_source_id": ds_id, "filter": None},
            user_id=test_user,
        )

    # Mutation check (per task-49-brief.md): confirm this assertion is not
    # vacuous by calling query_rows directly with the WRONG (other) user_id
    # for the SQL ownership check but the RIGHT one for property lookup --
    # i.e. simulate what a broken/bypassed tenancy check would return, and
    # show it's a different, unsafe outcome from what the tool above
    # actually produced (a leak, not a 404) -- proving this test would catch
    # a regression that removed the ownership check from `_query_database`.
    from routers.databases import query_rows
    from models.database import QueryRequest

    leaked = await query_rows(ds_id, QueryRequest(), user_id=other_user, conn=db_conn)
    assert len(leaked.rows) == 1  # the row genuinely exists -- just not test_user's to see.


# ===========================================================================
# brain.create_row
# ===========================================================================


async def test_create_row_coerces_number_checkbox_and_date(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "num1", "Score", "number")
    await _insert_property(db_conn, test_user, ds_id, "chk1", "Done", "checkbox")
    await _insert_property(db_conn, test_user, ds_id, "dat1", "When", "date")

    result = await execute_brain_tool(
        "brain.create_row",
        args={
            "data_source_id": ds_id,
            "properties": {
                "num1": 42,
                "chk1": True,
                "dat1": {"start": "2026-01-01T00:00:00+00:00"},
            },
        },
        user_id=test_user,
    )

    assert result["properties"]["num1"] == {"type": "number", "number": 42}
    assert result["properties"]["chk1"] == {"type": "checkbox", "checkbox": True}
    assert result["properties"]["dat1"]["date"]["start"] == "2026-01-01T00:00:00+00:00"

    # Round-trips through the real DB, not just the in-memory response.
    row = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", uuid.UUID(result["id"])
    )
    assert row["properties"]["num1"]["number"] == 42


async def test_create_row_rejects_unknown_property_key(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)

    with pytest.raises(ValueError, match="unknown property key"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"nope": 1}},
            user_id=test_user,
        )


async def test_create_row_rejects_relation_typed_key(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(
        db_conn, test_user, ds_id, "rel1", "Linked", "relation",
        config={"relation_id": str(uuid.uuid4()), "side": "forward"},
    )

    with pytest.raises(ValueError, match="relation"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"rel1": "some-id"}},
            user_id=test_user,
        )


async def test_create_row_rejects_a_bool_where_a_number_is_expected(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "num1", "Score", "number")

    with pytest.raises(ValueError, match="num1"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"num1": True}},
            user_id=test_user,
        )


# ===========================================================================
# brain.update_row -- must behave exactly like a human edit: title sync +
# automation firing.
# ===========================================================================


async def test_update_row_syncs_title_to_notes_table(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "ttl1", "Name", "title")
    row_id = await _make_row(db_conn, test_user, ds_id)

    await execute_brain_tool(
        "brain.update_row",
        args={
            "data_source_id": ds_id,
            "note_id": row_id,
            "property_key": "ttl1",
            "value": "New Title",
        },
        user_id=test_user,
    )

    note_title = await db_conn.fetchval(
        "SELECT title FROM notes WHERE id = $1", uuid.UUID(row_id)
    )
    assert note_title == "New Title"


async def test_update_row_fires_property_edited_automation(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(
        db_conn, test_user, ds_id, "sts1", "Status", "status",
        config={"options": [{"id": "done", "name": "Done"}]},
    )
    row_id = await _make_row(db_conn, test_user, ds_id)
    await _insert_automation(
        db_conn, test_user, ds_id,
        triggers=[{"type": "property_edited", "property_key": "sts1", "condition": "any_change"}],
        actions=[{"type": "send_notification", "message": "fired:via-brain-tool"}],
    )

    await execute_brain_tool(
        "brain.update_row",
        args={
            "data_source_id": ds_id,
            "note_id": row_id,
            "property_key": "sts1",
            "value": "done",
        },
        user_id=test_user,
    )

    count = await db_conn.fetchval(
        "SELECT count(*) FROM db_notifications WHERE user_id = $1 AND message = $2",
        test_user, "fired:via-brain-tool",
    )
    assert count == 1


async def test_update_row_rejects_unknown_property_key(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    row_id = await _make_row(db_conn, test_user, ds_id)

    with pytest.raises(ValueError, match="unknown property key"):
        await execute_brain_tool(
            "brain.update_row",
            args={
                "data_source_id": ds_id, "note_id": row_id,
                "property_key": "nope", "value": 1,
            },
            user_id=test_user,
        )


# ===========================================================================
# Fix round (task-50, M14 combined review Critical finding) -- 10 of 24
# property types had NO write-side validation at all (`_GenericProperty.
# coerce_write` is a bare `return raw`). Each case below asserts the bad
# value is rejected with a clear `ValueError` BEFORE reaching asyncpg (i.e.
# the row is never created), and that no row was actually written.
# ===========================================================================


async def test_create_row_rejects_a_non_bool_checkbox_value(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "chk1", "Done", "checkbox")

    with pytest.raises(ValueError, match="checkbox"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"chk1": "maybe"}},
            user_id=test_user,
        )

    count = await db_conn.fetchval(
        "SELECT count(*) FROM db_row_props WHERE data_source_id = $1", uuid.UUID(ds_id)
    )
    assert count == 0


async def test_create_row_rejects_an_int_checkbox_value(patched_pool, db_conn, test_user):
    """`1`/`0` are exactly what an LLM would guess for a boolean -- and
    `isinstance(1, bool)` is `False` (the reverse of the bool-is-a-subclass-
    of-int trap), so this specifically exercises the "reject anything that
    isn't literally a bool" requirement, not just "reject strings"."""
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "chk1", "Done", "checkbox")

    with pytest.raises(ValueError, match="checkbox"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"chk1": 1}},
            user_id=test_user,
        )


async def test_create_row_rejects_a_non_str_title(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "ttl1", "Name", "title")

    with pytest.raises(ValueError, match="title"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"ttl1": 12345}},
            user_id=test_user,
        )

    count = await db_conn.fetchval(
        "SELECT count(*) FROM db_row_props WHERE data_source_id = $1", uuid.UUID(ds_id)
    )
    assert count == 0


async def test_create_row_rejects_a_dict_title(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "ttl1", "Name", "title")

    with pytest.raises(ValueError, match="title"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"ttl1": {"nested": "dict"}}},
            user_id=test_user,
        )


async def test_create_row_rejects_a_non_list_people_value(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "ppl1", "Assignees", "people")

    with pytest.raises(ValueError, match="people"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"ppl1": "not-a-list"}},
            user_id=test_user,
        )


async def test_create_row_rejects_a_non_list_files_value(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "fil1", "Attachments", "files")

    with pytest.raises(ValueError, match="files"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"fil1": "not-a-list"}},
            user_id=test_user,
        )


async def test_create_row_rejects_a_non_dict_place_value(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "plc1", "Location", "place")

    with pytest.raises(ValueError, match="place"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"plc1": "not-a-dict"}},
            user_id=test_user,
        )


async def test_create_row_rejects_a_non_dict_verification_value(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "ver1", "Verified", "verification")

    with pytest.raises(ValueError, match="verification"):
        await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"ver1": 42}},
            user_id=test_user,
        )


async def test_create_row_still_accepts_none_for_a_previously_unvalidated_type(
    patched_pool, db_conn, test_user
):
    """The new checks must not reject the pre-existing `None` pass-through
    convention (`_create_row` calls `coerce_property_write` even for a key
    whose value is explicitly `None` -- every rich descriptor's own
    `coerce_write(None)` already treats this as a no-op, not an error)."""
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "chk1", "Done", "checkbox")
    await _insert_property(db_conn, test_user, ds_id, "ttl1", "Name", "title")

    result = await execute_brain_tool(
        "brain.create_row",
        args={"data_source_id": ds_id, "properties": {"chk1": None, "ttl1": None}},
        user_id=test_user,
    )
    assert result["properties"]["chk1"] == {"type": "checkbox", "checkbox": None}
    assert result["properties"]["ttl1"] == {"type": "title", "title": None}


async def test_update_row_rejects_a_non_bool_checkbox_value(patched_pool, db_conn, test_user):
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "chk1", "Done", "checkbox")
    row_id = await _make_row(db_conn, test_user, ds_id)

    with pytest.raises(ValueError, match="checkbox"):
        await execute_brain_tool(
            "brain.update_row",
            args={
                "data_source_id": ds_id, "note_id": row_id,
                "property_key": "chk1", "value": "yes",
            },
            user_id=test_user,
        )

    row = await db_conn.fetchrow(
        "SELECT properties FROM db_row_props WHERE note_id = $1", uuid.UUID(row_id)
    )
    assert "chk1" not in (row["properties"] or {})


async def test_checkbox_mutation_check_reproduces_the_reviewed_asyncpg_crash(db_conn):
    """Mutation test (task-50, Critical fix): temporarily simulate the
    pre-fix `_GenericProperty.coerce_write` behaviour (`return raw`, no
    validation at all) for `checkbox` and confirm a bad value actually
    reaches asyncpg and crashes with the exact reviewed error class
    (`asyncpg.exceptions.InvalidTextRepresentationError`), not just "the
    test fails" -- proving `_check_generic_property_shape` is genuinely the
    thing standing between an LLM's `"maybe"` and a broken row's JSONB, not
    a coincidentally-passing assertion."""
    import asyncpg

    from services.agent import brain_tools
    from services.db.properties.base import REGISTRY

    # Bypass `_check_generic_property_shape` entirely -- exactly what the pre-fix
    # code path did -- and let the malformed value reach the generic `coerce_write`,
    # then write it straight into a real `jsonb` column and read it back cast to
    # `::boolean`, the same expression `properties/base.py`'s
    # `_VALUE_SHAPES["checkbox"]` compiles for a filter/sort.
    raw = "maybe"
    coerced = REGISTRY["checkbox"].coerce_write(raw)  # _GenericProperty: `return raw`
    assert coerced == "maybe"  # confirms there really is no validation here

    await db_conn.execute("CREATE TEMP TABLE mutation_check (properties jsonb)")
    # `db_conn` has the same jsonb codec the production pool registers
    # (`services/db/connection.py`'s `_init_connection`) active -- a native
    # Python dict, not a pre-serialized JSON string, is what a `$1::jsonb`
    # bind expects here (the codec's own `encoder=json.dumps` runs on it).
    await db_conn.execute(
        "INSERT INTO mutation_check (properties) VALUES ($1::jsonb)",
        {"type": "checkbox", "checkbox": "maybe"},
    )
    with pytest.raises(asyncpg.exceptions.InvalidTextRepresentationError):
        # The exact `->> 'checkbox' ::boolean` cast `_GenericProperty._value_sql`
        # compiles for a real filter/sort on this column.
        await db_conn.fetchval(
            "SELECT (properties ->> 'checkbox')::boolean FROM mutation_check"
        )

    # And confirm the real fix (still in place) rejects it long before any of the
    # above -- `coerce_property_write` (not the raw REGISTRY descriptor) is what
    # every real write call site actually calls.
    with pytest.raises(ValueError, match="checkbox"):
        brain_tools.coerce_property_write("checkbox", {}, "maybe")


# ===========================================================================
# Fix 4 (task-50, M14 combined review Important finding) -- brain.create_row
# must actually trigger the Task 46 property-preamble reindex, an agent-tool
# call site the brief names explicitly. Mocking convention follows
# `tests/test_indexer.py`'s own `_db()`/`_patched()` helpers (same per-test-
# file duplication that file's own docstring documents, rather than a
# shared cross-file import) -- `get_supabase()` is `index_note`'s only
# dependency besides the embedder, and MagicMock chains ignore whatever
# note_id/user_id they're actually filtered on, so the fake table data can
# be wired up BEFORE the real note_id is known (it's server-minted inside
# `create_row_core`, which runs before `try_index_note` is even called).
# ===========================================================================


def _preamble_fake_supabase(*, ds_id, row_properties, prop_defs, notes_title="Untitled"):
    tables: dict = {}
    db = MagicMock()
    db.table.side_effect = lambda name: tables.setdefault(name, MagicMock())

    notes = tables.setdefault("notes", MagicMock())
    notes.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = {
        "title": notes_title, "content": [],
    }

    row_props = tables.setdefault("db_row_props", MagicMock())
    row_props.select.return_value.eq.return_value.eq.return_value.maybe_single.return_value.execute.return_value.data = {
        "properties": row_properties, "data_source_id": ds_id,
    }

    properties = tables.setdefault("db_properties", MagicMock())
    properties.select.return_value.eq.return_value.eq.return_value.order.return_value.execute.return_value.data = (
        prop_defs
    )

    tables.setdefault("note_chunks", MagicMock())
    db.tables = tables
    return db


def _inserted_preamble_rows(db) -> list[dict]:
    insert_call = db.tables["note_chunks"].insert.call_args
    assert insert_call is not None, "note_chunks.insert was never called -- index_note was never invoked"
    return insert_call[0][0]


async def test_create_row_triggers_property_preamble_reindex(patched_pool, db_conn, test_user):
    """Fix 4.3: `_create_row` must call `try_index_note` after
    `create_row_core` succeeds. Task 46's own preamble-rendering logic is
    proven correct in `test_indexer.py` already -- this test's whole job is
    proving the call site exists at all (it didn't, pre-fix: nothing on any
    row-write path ever called `index_note`), by asserting the exact
    rendered preamble Task 46 built lands as `note_chunks` chunk 0 for the
    real note id `brain.create_row` just returned."""
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "notekey", "Notes", "rich_text")

    fake_db = _preamble_fake_supabase(
        ds_id=ds_id,
        row_properties={"notekey": {"type": "rich_text", "rich_text": "hello from agent"}},
        prop_defs=[{"key": "notekey", "name": "Notes", "type": "rich_text", "position": 0, "config": {}}],
    )

    with (
        patch("services.indexer.get_supabase", return_value=fake_db),
        patch("services.indexer.embed_batch", side_effect=lambda texts: [[0.0]] * len(texts)),
        patch("services.indexer.embed", return_value=[0.0]),
        patch("services.indexer.generate_descriptor", return_value="d"),
    ):
        result = await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"notekey": "hello from agent"}},
            user_id=test_user,
        )

    rows = _inserted_preamble_rows(fake_db)
    assert len(rows) == 1  # no body blocks -- only the preamble chunk
    assert rows[0]["chunk_index"] == 0
    assert rows[0]["chunk_text"] == "Notes: hello from agent"
    assert rows[0]["block_id"] == "__property_preamble__"
    assert rows[0]["note_id"] == result["id"]


async def test_create_row_succeeds_even_if_indexing_fails(patched_pool, db_conn, test_user):
    """Fix 4's own required regression guard: `try_index_note` is best-
    effort/non-fatal -- a flaky/down embedder must never turn a successful
    row write into a failed tool call."""
    ds_id = await _make_data_source(db_conn, test_user)
    await _insert_property(db_conn, test_user, ds_id, "notekey", "Notes", "rich_text")

    with patch("services.indexer.index_note", side_effect=RuntimeError("embedder down")):
        result = await execute_brain_tool(
            "brain.create_row",
            args={"data_source_id": ds_id, "properties": {"notekey": "still works"}},
            user_id=test_user,
        )

    assert result["properties"]["notekey"] == {"type": "rich_text", "rich_text": "still works"}
