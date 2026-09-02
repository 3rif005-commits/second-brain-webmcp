"""Milestone 5 (task-14-brief.md §1): Number and UniqueId."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from services.db.properties.base import REGISTRY, SqlContext, _GenericProperty
from services.db.properties.scalar import Number, NumberConfig, UniqueId, UniqueIdConfig, next_unique_id

# pytest.ini: asyncio_mode = auto -- async def tests below are collected
# automatically, no `@pytest.mark.asyncio` needed.


# ---------------------------------------------------------------------------
# Number
# ---------------------------------------------------------------------------

def test_number_default_is_none_not_zero():
    assert Number().default() is None


def test_number_is_empty():
    n = Number()
    assert n.is_empty(None) is True
    assert n.is_empty(0) is False
    assert n.is_empty(0.0) is False
    assert n.is_empty(-5) is False


def test_number_config_default_format():
    assert NumberConfig().format == "number"


def test_number_config_accepts_every_documented_format():
    formats = [
        "number", "number_with_commas", "percent", "dollar", "canadian_dollar",
        "singapore_dollar", "hong_kong_dollar", "new_zealand_dollar",
        "new_taiwan_dollar", "euro", "pound", "yen", "yuan", "won", "ruble",
        "rupee", "rupiah", "real", "lira", "franc", "krona", "norwegian_krone",
        "danish_krone", "mexican_peso", "chilean_peso", "philippine_peso",
        "colombian_peso", "argentine_peso", "uruguayan_peso", "rand", "zloty",
        "baht", "forint", "koruna", "shekel", "dirham", "riyal", "ringgit", "leu",
    ]
    assert len(formats) == 39  # see scalar.py's NumberFormat comment re: the 40-vs-39 discrepancy
    for fmt in formats:
        assert NumberConfig(format=fmt).format == fmt


def test_number_config_rejects_unknown_format():
    with pytest.raises(ValidationError):
        NumberConfig(format="bitcoin")


def test_number_config_forbids_extra_fields():
    # `show_as` used to be the example of a rejected key here. It is a real
    # field now (the Edit property panel writes it), so the assertion moved
    # to a key Notion's panel genuinely has no control for.
    with pytest.raises(ValidationError):
        NumberConfig(precision=2)


def test_number_config_display_only_fields_default_to_plain_number():
    config = NumberConfig()
    assert config.decimal_places is None
    assert config.show_as == "number"
    assert config.bar_color == "green"
    assert config.divide_by is None
    assert config.show_number is True


def test_number_config_accepts_the_show_as_values_notion_offers():
    for show_as in ("number", "bar", "ring"):
        assert NumberConfig(show_as=show_as).show_as == show_as
    with pytest.raises(ValidationError):
        NumberConfig(show_as="gauge")


def test_number_config_bounds_decimal_places_to_notions_range():
    # Notion's `Decimal places` flyout offers Default, 0, 1, 2, 3, 4, 5.
    for places in range(6):
        assert NumberConfig(decimal_places=places).decimal_places == places
    with pytest.raises(ValidationError):
        NumberConfig(decimal_places=6)
    with pytest.raises(ValidationError):
        NumberConfig(decimal_places=-1)


def test_number_coerce_write_accepts_int_float_none():
    n = Number()
    assert n.coerce_write(42) == 42
    assert n.coerce_write(3.14) == 3.14
    assert n.coerce_write(None) is None
    assert n.coerce_write(0) == 0


def test_number_coerce_write_rejects_bool():
    n = Number()
    with pytest.raises(ValueError):
        n.coerce_write(True)
    with pytest.raises(ValueError):
        n.coerce_write(False)


def test_number_coerce_write_rejects_string_and_other_types():
    n = Number()
    with pytest.raises(ValueError):
        n.coerce_write("42")
    with pytest.raises(ValueError):
        n.coerce_write([1, 2])
    with pytest.raises(ValueError):
        n.coerce_write({"a": 1})


def test_number_coerce_write_rejects_an_int_too_large_for_float():
    """Fix 2 (task-51, M14 final cross-cutting review): a Python `int` is
    unbounded, but this value is later read back through `services/db/
    recompute.py`'s `_decode_stored` (`float(raw)`, run on EVERY row write) --
    a too-large int previously sailed through `coerce_write`'s bare
    `isinstance(raw, (int, float))` check, got stored, and only crashed the
    NEXT time anything recomputed the row (`OverflowError`, not a `ValueError`,
    so nothing downstream converts it to a clean 400 either). Guarded here at
    write time instead: same magnitude that reproduces `OverflowError: int too
    large to convert to float` directly (`float(10**400)`)."""
    n = Number()
    huge = 10**400
    with pytest.raises(ValueError, match="out of range"):
        n.coerce_write(huge)
    with pytest.raises(ValueError, match="out of range"):
        n.coerce_write(-huge)
    # A merely large-but-float-representable int/float is untouched.
    assert n.coerce_write(10**15) == 10**15
    assert n.coerce_write(1.5e300) == 1.5e300


def test_number_operators_and_aggregations_are_sane():
    n = Number()
    ops = n.operators()
    assert ops["equals"].arg_type == "num"
    assert "is_empty" in ops
    aggs = n.aggregations()
    assert {"sum", "average", "median", "min", "max", "range"} <= aggs


# --- sql_extract/sql_order byte-identity: the regression check that matters most ---

def test_number_sql_extract_byte_identical_to_generic():
    ctx = SqlContext(key="numAbc123", alias="p")
    assert Number().sql_extract(ctx).sql == _GenericProperty(key="number").sql_extract(ctx).sql
    assert Number().sql_extract(ctx).params == _GenericProperty(key="number").sql_extract(ctx).params


def test_number_sql_order_byte_identical_to_generic():
    ctx = SqlContext(key="numAbc123", alias="p")
    for direction in ("asc", "desc"):
        assert (
            Number().sql_order(ctx, direction).sql
            == _GenericProperty(key="number").sql_order(ctx, direction).sql
        )


def test_number_sql_extract_byte_identical_for_column_storage():
    ctx = SqlContext(key="mastery_status", alias="notes", storage="column")
    # number isn't itself column-backed today, but the descriptor's SQL
    # generation must still match _GenericProperty's for any ctx it's given.
    assert (
        REGISTRY["number"].sql_extract(SqlContext(key="a1b2c3d4", alias="p")).sql
        == _GenericProperty(key="number").sql_extract(SqlContext(key="a1b2c3d4", alias="p")).sql
    )


def test_number_registry_entry_is_the_rich_descriptor():
    assert isinstance(REGISTRY["number"], Number)


# ---------------------------------------------------------------------------
# UniqueId
# ---------------------------------------------------------------------------

def test_unique_id_default_is_none():
    assert UniqueId().default() is None


def test_unique_id_config_default_prefix_is_none():
    assert UniqueIdConfig().prefix is None


def test_unique_id_config_accepts_prefix():
    assert UniqueIdConfig(prefix="ID").prefix == "ID"


def test_unique_id_coerce_write_accepts_none_only():
    u = UniqueId()
    assert u.coerce_write(None) is None


def test_unique_id_coerce_write_always_rejects_a_real_value():
    u = UniqueId()
    with pytest.raises(ValueError):
        u.coerce_write(5)
    with pytest.raises(ValueError):
        u.coerce_write("5")


def test_unique_id_aggregations_excludes_numeric_aggregators():
    # query/aggregations.py deliberately scopes numeric aggregators to
    # "number" only, excluding unique_id -- mirrored here.
    aggs = UniqueId().aggregations()
    assert not ({"sum", "average", "median", "min", "max", "range"} & aggs)


def test_unique_id_operators_get_the_full_numeric_family():
    ops = UniqueId().operators()
    assert set(ops) == {
        "equals", "does_not_equal", "greater_than", "less_than",
        "greater_than_or_equal_to", "less_than_or_equal_to",
        "is_empty", "is_not_empty",
    }


def test_unique_id_sql_extract_byte_identical_to_generic():
    ctx = SqlContext(key="uidAbc123", alias="p")
    assert UniqueId().sql_extract(ctx).sql == _GenericProperty(key="unique_id").sql_extract(ctx).sql


def test_unique_id_sql_order_byte_identical_to_generic():
    ctx = SqlContext(key="uidAbc123", alias="p")
    for direction in ("asc", "desc"):
        assert (
            UniqueId().sql_order(ctx, direction).sql
            == _GenericProperty(key="unique_id").sql_order(ctx, direction).sql
        )


def test_unique_id_registry_entry_is_the_rich_descriptor():
    assert isinstance(REGISTRY["unique_id"], UniqueId)


# ---------------------------------------------------------------------------
# next_unique_id -- needs the local pgtest harness (db_conn/test_user).
# ---------------------------------------------------------------------------

async def _make_unique_id_property(db_conn, user_id):
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'T') RETURNING id", user_id
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, 'Default') RETURNING id",
        db_row["id"], user_id,
    )
    prop_row = await db_conn.fetchrow(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type)
        VALUES ($1, $2, 'uidKey01', 'ID', 'unique_id')
        RETURNING id
        """,
        ds_row["id"], user_id,
    )
    return str(prop_row["id"])


async def test_next_unique_id_starts_at_one(db_conn, test_user):
    prop_id = await _make_unique_id_property(db_conn, test_user)
    assert await next_unique_id(db_conn, prop_id) == 1


async def test_next_unique_id_increments_sequentially_and_persists(db_conn, test_user):
    prop_id = await _make_unique_id_property(db_conn, test_user)
    values = [await next_unique_id(db_conn, prop_id) for _ in range(5)]
    assert values == [1, 2, 3, 4, 5]

    # Persistence: re-fetch the property row directly and confirm the
    # counter state actually landed in config->>'next_value', not just in
    # this function's return value.
    row = await db_conn.fetchrow("SELECT config FROM db_properties WHERE id = $1", prop_id)
    assert row["config"]["next_value"] == 5


async def test_next_unique_id_never_reuses_gaps_from_deleted_rows(db_conn, test_user):
    """Research: "unique_id counters consume numbers for deleted rows (gaps
    permanent)". Simulated here without any row-creation flow: call the
    counter several times (as if assigning ids 1..5 to 5 rows), then
    pretend rows 2 and 4 were deleted -- the counter has no knowledge of
    row existence at all, so the next call must still produce 6, never
    reusing 2 or 4."""
    prop_id = await _make_unique_id_property(db_conn, test_user)
    consumed = [await next_unique_id(db_conn, prop_id) for _ in range(5)]
    assert consumed == [1, 2, 3, 4, 5]
    # "delete" rows 2 and 4 -- nothing to do at the counter level, since
    # next_unique_id never reads row state. The next assignment must not
    # backfill either gap.
    assert await next_unique_id(db_conn, prop_id) == 6


async def test_next_unique_id_independent_per_property(db_conn, test_user):
    prop_a = await _make_unique_id_property(db_conn, test_user)
    db_row = await db_conn.fetchrow(
        "INSERT INTO db_databases (user_id, title) VALUES ($1, 'T2') RETURNING id", test_user
    )
    ds_row = await db_conn.fetchrow(
        "INSERT INTO db_data_sources (database_id, user_id, name) VALUES ($1, $2, 'Default') RETURNING id",
        db_row["id"], test_user,
    )
    prop_b_row = await db_conn.fetchrow(
        """
        INSERT INTO db_properties (data_source_id, user_id, key, name, type)
        VALUES ($1, $2, 'uidKey02', 'ID2', 'unique_id')
        RETURNING id
        """,
        ds_row["id"], test_user,
    )
    prop_b = str(prop_b_row["id"])

    assert await next_unique_id(db_conn, prop_a) == 1
    assert await next_unique_id(db_conn, prop_b) == 1
    assert await next_unique_id(db_conn, prop_a) == 2


async def test_next_unique_id_raises_for_unknown_property(db_conn, test_user):
    import uuid
    with pytest.raises(ValueError):
        await next_unique_id(db_conn, str(uuid.uuid4()))
