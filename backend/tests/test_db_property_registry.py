import re
from pathlib import Path

import pytest
from pydantic import BaseModel

from services.db.properties.base import PropertyType, REGISTRY, SqlContext
from services.db.properties.columns import (
    COLUMN_BACKED,
    ENGINE_STATE_COLUMNS,
    NEVER_COLUMN_BACKED,
)

NOTES_COLUMNS = {
    "id","user_id","collection_id","title","content","content_text","source_type",
    "source_url","source_filename","topics","mastery_status","is_indexed","created_at",
    "updated_at","deleted_at","icon","is_favorited","last_viewed_at","position",
    "cover_image_url","is_public","fts","local_only","descriptor","descriptor_embedding",
}


def test_column_backed_names_are_real_columns():
    for prop in COLUMN_BACKED.values():
        assert prop.column in NOTES_COLUMNS, f"{prop.column} is not a notes column"


def test_column_backed_identifiers_are_safe():
    for prop in COLUMN_BACKED.values():
        assert re.fullmatch(r"[a-z_]+", prop.column)


# --- Additional coverage for base.py / columns.py, not given verbatim by the brief ---
# Research §F.1 ("Complete property type inventory") enumerates exactly 24
# real, addressable property types (items 1-24) and explicitly resolves its
# own item 25 -- AI autofill -- as NOT a property type ("a modifier on an
# existing property", never a schema entry: research §F.1 line 360, and
# again at line 81). REGISTRY holds those 24 real type keys; the design
# spec and plan originally said "25" and were corrected to 24 to match
# (confirmed by the user during Milestone 1 review — see task-2-report.md).
REAL_TYPE_KEYS = {
    "title", "rich_text", "number", "select", "multi_select", "status",
    "date", "people", "files", "checkbox", "url", "email", "phone_number",
    "formula", "relation", "rollup", "created_time", "created_by",
    "last_edited_time", "last_edited_by", "unique_id", "place",
    "verification", "button",
}


def test_registry_contains_all_real_type_keys():
    assert set(REGISTRY.keys()) == REAL_TYPE_KEYS


@pytest.mark.parametrize("key", sorted(REAL_TYPE_KEYS))
def test_registry_entries_satisfy_property_type_protocol(key):
    prop = REGISTRY[key]
    assert isinstance(prop, PropertyType)
    assert prop.key == key
    assert isinstance(prop.config_model, type) and issubclass(prop.config_model, BaseModel)

    # Every method is callable and returns the shape the protocol promises.
    prop.default()
    assert isinstance(prop.is_empty(None), bool)

    ops = prop.operators()
    assert isinstance(ops, dict)
    if key not in ("formula", "rollup", "button"):
        assert ops  # at least one operator per type
    # else: Milestone 8 (Task 27) -- formula/rollup's filter-operator set
    # depends on the PROPERTY's own `result_type`, not just its `type`, so
    # a flat per-type `.operators()` dict can't represent it (a single
    # entry can't hold "equals" with three different arg_types at once).
    # The real dispatch lives in query/operators.py's RESULT_TYPE_OPERATORS
    # (see that module's own comment); `.operators()` here is legitimately
    # empty, only satisfying the PropertyType protocol's shape.
    # "button" (task-39-brief.md decision 1): research §25 says "Filters:
    # none" -- not even is_empty/is_not_empty, a deliberate narrowing from
    # every other type's at-least-empty-check pair, since a button property
    # carries no per-row value at all for a filter to ever test.
    assert all(isinstance(name, str) for name in ops)

    aggs = prop.aggregations()
    assert isinstance(aggs, set)

    # coerce_write must at least accept None without raising -- except
    # "relation" (task-20-brief.md §2): migration 015 made db_row_props
    # the wrong place to store a relation's value entirely, so
    # Relation.coerce_write is a hard failure for *every* input, None
    # included, not a silent accept. See test_relation_coerce_write_
    # always_raises below for the dedicated positive assertion.
    # "formula"/"rollup" (task-27-brief.md, Milestone 8): the identical
    # posture -- services/db/recompute.py is the only legal writer of a
    # materialised value, so coerce_write is a hard failure here too.
    # "button" (task-39-brief.md decision 1): same posture again -- a
    # button property's action chain lives in db_properties.config.actions,
    # never in db_row_props, so coerce_write has zero legitimate inputs,
    # None included (and zero production call sites today regardless).
    if key in ("relation", "formula", "rollup", "button"):
        with pytest.raises(ValueError):
            prop.coerce_write(None)
    else:
        prop.coerce_write(None)


def test_column_backed_never_touches_engine_state_columns():
    used_columns = {prop.column for prop in COLUMN_BACKED.values()}
    assert not (used_columns & ENGINE_STATE_COLUMNS)


# --------------------------------------------------------------------------
# Final-review finding 1: the emitted SQL must be able to use the expression
# indexes Milestone 0's benchmark validated.
#
# The benchmark's GO verdict (p95 89.71ms @ 50k rows) was measured against
# B-tree expression indexes built on the **two-hop** extraction of the actual
# scalar value out of the §3.3 discriminated wrapper object. An emitted
# fragment that extracts the wrapper object itself (`properties -> 'key'`)
# can never match those indexes and silently falls onto the unindexed path
# (measured p95 ~450ms — the NO-GO number).
# --------------------------------------------------------------------------

BENCH_PATH = Path(__file__).resolve().parents[2] / "scripts" / "bench" / "storage_bench.py"


def _bench_index_expression(index_name: str) -> str:
    """The exact indexed expression text from storage_bench.py's DDL."""
    src = BENCH_PATH.read_text()
    match = re.search(
        rf"CREATE INDEX {index_name}\s*\n\s*ON bench_jsonb_indexed\s*\((.*?)\);",
        src,
        re.S,
    )
    assert match, f"could not find {index_name}'s DDL in {BENCH_PATH}"
    return match.group(1)


def _canonical(expr: str) -> str:
    """Normalise a SQL expression for comparison: property key → KEY, table
    alias dropped, whitespace and (semantically redundant here) parentheses
    stripped. Both sides of every assertion go through this, so the
    comparison is about the *shape* of the extraction, not formatting."""
    out = re.sub(r"'\{HOT_[A-Z]+\}'", "KEY", expr)  # bench's f-string placeholder
    out = re.sub(r"'[0-9A-Za-z]{8}'", "KEY", out)  # a real 8-char minted key
    out = re.sub(r"\b[a-z_]+\.properties\b", "properties", out)  # table alias
    out = re.sub(r"\s+", "", out)
    return out.replace("(", "").replace(")", "")


def test_select_extract_matches_the_benchmarked_index_expression():
    frag = REGISTRY["select"].sql_extract(SqlContext(key="selStat1", alias="p"))
    assert _canonical(frag.sql) == _canonical(
        _bench_index_expression("bench_jsonb_indexed_hotsel")
    )


def test_number_extract_matches_the_benchmarked_index_expression():
    frag = REGISTRY["number"].sql_extract(SqlContext(key="numPri04", alias="p"))
    assert _canonical(frag.sql) == _canonical(
        _bench_index_expression("bench_jsonb_indexed_hotnum")
    )


def test_number_order_uses_the_same_indexable_expression():
    order = REGISTRY["number"].sql_order(SqlContext(key="numPri04", alias="p"), "asc")
    extract = REGISTRY["number"].sql_extract(SqlContext(key="numPri04", alias="p"))
    assert order.sql.startswith(extract.sql)
    assert order.sql.endswith("ASC NULLS LAST")


# "relation" is excluded (task-20-brief.md §2): Milestone 7 repointed it
# entirely away from JSONB, so REGISTRY["relation"].sql_extract has nothing
# to extract and raises rather than returning a bare-wrapper-shaped
# fragment -- see test_relation_sql_extract_raises below. "formula"/
# "rollup" are excluded for the analogous Milestone 8 (Task 27) reason:
# their sql_extract needs `ctx.result_type` (a bare SqlContext with none
# set raises, by design -- see test_computed_sql_extract_requires_a_
# result_type below), so a shared "extract with no type context" sweep
# doesn't apply to them the way it does to every other type. "button" is
# excluded for the task-39-brief.md decision 1 reason: it has no JSONB
# value at all (operators()/aggregations() are both empty), so
# sql_extract raises too -- see test_button_sql_extract_and_order_raise
# below.
@pytest.mark.parametrize("key", sorted(REAL_TYPE_KEYS - {"relation", "formula", "rollup", "button"}))
def test_no_type_extracts_the_bare_wrapper_object(key):
    """`properties -> 'key'` alone is the §3.3 wrapper (`{"type": ...,
    "<type>": ...}`), not a value: unindexable, and orders by jsonb key
    collation rather than by the value."""
    frag = REGISTRY[key].sql_extract(SqlContext(key="a1b2c3d4", alias="p"))
    assert not re.fullmatch(r"[a-z_]+\.properties\s*->\s*'a1b2c3d4'", frag.sql.strip())
    assert "'a1b2c3d4'" in frag.sql  # the key is still reached


def test_button_sql_extract_and_order_raise():
    # task-39-brief.md decision 1: mirrors test_relation_sql_extract_raises below --
    # a button property has no JSONB value at all (operators()/aggregations() are
    # both empty, so M3/M4's compilers should never reach either method), so both
    # raise rather than emitting a dummy fragment.
    with pytest.raises(ValueError):
        REGISTRY["button"].sql_extract(SqlContext(key="a1b2c3d4", alias="p"))
    with pytest.raises(ValueError):
        REGISTRY["button"].sql_order(SqlContext(key="a1b2c3d4", alias="p"), "asc")


def test_relation_sql_extract_raises():
    # Migration 015: db_relation_links is the only source of truth for a
    # relation's value. sql_extract raising (rather than emitting some
    # JSONB path) matches coerce_write's hard failure -- there is no JSONB
    # copy to point at in either direction.
    with pytest.raises(ValueError):
        REGISTRY["relation"].sql_extract(SqlContext(key="a1b2c3d4", alias="p"))


@pytest.mark.parametrize("key", ["formula", "rollup"])
def test_computed_sql_extract_requires_a_result_type(key):
    with pytest.raises(ValueError):
        REGISTRY[key].sql_extract(SqlContext(key="a1b2c3d4", alias="p"))


@pytest.mark.parametrize("key", ["formula", "rollup"])
@pytest.mark.parametrize("result_type", ["list", "person", "page", "unknown", "empty"])
def test_computed_sql_extract_raises_for_unfilterable_result_types(key, result_type):
    # research §4.6/§4.7: Notion's own formula API has no list/person/page
    # result type and no filter object for them either.
    with pytest.raises(ValueError):
        REGISTRY[key].sql_extract(SqlContext(key="a1b2c3d4", alias="p", result_type=result_type))


def test_computed_sql_extract_reads_computed_not_properties():
    frag = REGISTRY["formula"].sql_extract(
        SqlContext(key="a1b2c3d4", alias="p", result_type="number")
    )
    assert "p.computed" in frag.sql
    assert "properties" not in frag.sql
    assert "'a1b2c3d4'" in frag.sql
    assert "'number'" in frag.sql


def test_computed_sql_extract_date_projects_start():
    frag = REGISTRY["rollup"].sql_extract(
        SqlContext(key="a1b2c3d4", alias="p", result_type="date")
    )
    assert "'date'" in frag.sql and "'start'" in frag.sql


def test_computed_sql_order_matches_extract_shape():
    order = REGISTRY["formula"].sql_order(
        SqlContext(key="a1b2c3d4", alias="p", result_type="number"), "asc"
    )
    extract = REGISTRY["formula"].sql_extract(
        SqlContext(key="a1b2c3d4", alias="p", result_type="number")
    )
    assert order.sql.startswith(extract.sql)
    assert order.sql.endswith("ASC NULLS LAST")


def test_date_sorts_on_start_not_the_whole_date_object():
    """A `date` value is `{start, end, time_zone}`; jsonb key order puts
    `end` before `start`, so ordering by the object sorts by end date."""
    frag = REGISTRY["date"].sql_order(SqlContext(key="dtDue002", alias="p"), "asc")
    assert "'start'" in frag.sql


def test_multi_select_orders_by_first_option_not_array_length():
    """jsonb array comparison is by length first, contradicting spec §5.1
    ("first option in option order, then count")."""
    frag = REGISTRY["multi_select"].sql_order(SqlContext(key="msTags01", alias="p"), "asc")
    assert "->> 0" in frag.sql


def test_filter_and_sort_values_never_interpolate_user_input():
    """The property key is server-minted base62 (`mint_key`), validated at
    emit time; nothing else may reach the SQL text."""
    with pytest.raises(ValueError):
        REGISTRY["number"].sql_extract(SqlContext(key="a'; DROP TABLE notes;--"))


# --------------------------------------------------------------------------
# Final-review finding 2: SqlContext must carry a storage discriminator, and
# column-backed properties must emit a column reference, not a JSONB path
# (`notes` has no `properties` column).
# --------------------------------------------------------------------------

def test_column_storage_emits_a_direct_column_reference():
    ctx = SqlContext(key="mastery_status", alias="notes", storage="column")
    assert REGISTRY["status"].sql_extract(ctx).sql == "notes.mastery_status"
    assert REGISTRY["status"].sql_order(ctx, "asc").sql == "notes.mastery_status ASC NULLS LAST"


def test_jsonb_storage_is_the_default_and_still_uses_a_jsonb_path():
    frag = REGISTRY["status"].sql_extract(SqlContext(key="a1b2c3d4", alias="p"))
    assert frag.sql.startswith("p.properties ->")


def test_column_storage_rejects_anything_not_in_the_allow_list():
    for column in ("content", "user_id", "notes; DROP TABLE notes"):
        with pytest.raises(ValueError):
            REGISTRY["rich_text"].sql_extract(
                SqlContext(key=column, alias="notes", storage="column")
            )


@pytest.mark.parametrize("name", sorted(COLUMN_BACKED))
def test_every_column_backed_property_emits_valid_sql(name):
    prop = COLUMN_BACKED[name]
    ctx = SqlContext(key=prop.column, alias="notes", storage="column")
    assert REGISTRY[prop.type].sql_extract(ctx).sql == f"notes.{prop.column}"


# --------------------------------------------------------------------------
# Final-review finding 3: COLUMN_BACKED type tags must be real REGISTRY keys
# — M2's CRUD/view layer resolves them with `REGISTRY[COLUMN_BACKED[n].type]`.
# --------------------------------------------------------------------------

def test_column_backed_types_are_registry_keys():
    for name, prop in COLUMN_BACKED.items():
        assert prop.type in REGISTRY, f"{name}: {prop.type!r} is not a REGISTRY key"


def test_topics_is_a_multi_select_stored_in_a_native_array_column():
    topics = COLUMN_BACKED["topics"]
    assert topics.type == "multi_select"
    assert topics.native_array is True
    assert all(
        prop.native_array is False for name, prop in COLUMN_BACKED.items() if name != "topics"
    )


def test_engine_state_columns_match_spec():
    # Spec §6: "What stays hardcoded: content, content_text, fts,
    # descriptor_embedding, local_only, is_public, position, collection_id."
    assert ENGINE_STATE_COLUMNS == {
        "content", "content_text", "fts", "descriptor_embedding",
        "local_only", "is_public", "position", "collection_id",
    }


def test_never_column_backed_covers_identity_and_tenancy_columns():
    # Final review, minor finding: the load-bearing guard was a deny-list of
    # spec §6's "engine state" names only, so a hypothetical
    # ColumnProp("user_id", ...) — the tenancy column — would have passed it.
    assert ENGINE_STATE_COLUMNS <= NEVER_COLUMN_BACKED
    assert {"id", "user_id", "deleted_at"} <= NEVER_COLUMN_BACKED
    assert not ({prop.column for prop in COLUMN_BACKED.values()} & NEVER_COLUMN_BACKED)
