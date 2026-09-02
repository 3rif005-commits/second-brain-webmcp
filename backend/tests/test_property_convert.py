"""Unit tests for services/db/properties/convert.py.

The module's job is to make a type change either PRESERVE data predictably or
REFUSE with a reason — never to destroy it silently on a menu click. These
tests are mostly about that boundary.
"""
import pytest

from services.db.properties.convert import (
    ConversionError,
    convert_value,
    is_legal,
    legal_targets,
)


def wrap(type_: str, value):
    return {"type": type_, type_: value}


class TestLegality:
    def test_identity_is_always_legal(self):
        assert is_legal("relation", "relation")
        assert is_legal("rich_text", "rich_text")

    @pytest.mark.parametrize("target", ["relation", "formula", "rollup", "title", "date"])
    def test_structurally_impossible_targets_are_refused(self, target):
        # Each for a distinct reason, documented in the module header:
        # relations need a minted pair, formula/rollup need validated config
        # and a recompute, a data source has exactly one title, and parsing
        # text into a date invents precision.
        assert not is_legal("rich_text", target)

    def test_checkbox_is_never_a_target(self):
        # "is 'Sam' true?" has no defensible answer.
        assert not is_legal("rich_text", "checkbox")
        assert not is_legal("select", "checkbox")

    def test_checkbox_can_still_be_converted_away_from(self):
        assert is_legal("checkbox", "rich_text")

    def test_legal_targets_excludes_self_and_is_stable(self):
        targets = legal_targets("select")
        assert "select" not in targets
        assert targets == sorted(targets)
        assert "rich_text" in targets and "multi_select" in targets


class TestTextCoercion:
    def test_number_to_text(self):
        assert convert_value(wrap("number", 42), "number", "rich_text") == wrap(
            "rich_text", "42"
        )

    def test_multi_select_to_text_joins(self):
        assert convert_value(
            wrap("multi_select", ["a", "b"]), "multi_select", "rich_text"
        ) == wrap("rich_text", "a, b")

    def test_checkbox_to_text_is_human_readable(self):
        assert convert_value(wrap("checkbox", True), "checkbox", "rich_text") == wrap(
            "rich_text", "Yes"
        )
        assert convert_value(wrap("checkbox", False), "checkbox", "rich_text") == wrap(
            "rich_text", "No"
        )

    def test_date_to_text_keeps_only_the_start(self):
        # An end date and a timezone have nowhere to go in a text field, so
        # the conversion is lossy — but predictably, not silently wrong.
        value = wrap("date", {"start": "2026-08-31", "end": "2026-09-02"})
        assert convert_value(value, "date", "rich_text") == wrap("rich_text", "2026-08-31")


class TestNumberCoercion:
    def test_parses_plain_and_comma_grouped_text(self):
        assert convert_value(wrap("rich_text", "42"), "rich_text", "number") == wrap(
            "number", 42
        )
        assert convert_value(wrap("rich_text", "1,234"), "rich_text", "number") == wrap(
            "number", 1234
        )

    def test_keeps_a_float_as_a_float_and_an_integer_as_an_integer(self):
        assert convert_value(wrap("rich_text", "2.5"), "rich_text", "number") == wrap(
            "number", 2.5
        )
        assert convert_value(wrap("rich_text", "3.0"), "rich_text", "number") == wrap(
            "number", 3
        )

    def test_unparseable_text_empties_the_cell_rather_than_failing(self):
        # Converting a column of mixed notes to Number must not fail because
        # one row says "about ten".
        assert convert_value(wrap("rich_text", "about ten"), "rich_text", "number") is None


class TestChoiceCoercion:
    def test_select_and_status_round_trip(self):
        assert convert_value(wrap("select", "Done"), "select", "status") == wrap(
            "status", "Done"
        )
        assert convert_value(wrap("status", "Done"), "status", "select") == wrap(
            "select", "Done"
        )

    def test_select_to_multi_select_wraps(self):
        assert convert_value(wrap("select", "A"), "select", "multi_select") == wrap(
            "multi_select", ["A"]
        )

    def test_multi_select_to_select_keeps_the_first(self):
        assert convert_value(
            wrap("multi_select", ["A", "B"]), "multi_select", "select"
        ) == wrap("select", "A")

    def test_text_to_multi_select_splits_on_commas(self):
        # The only reading that round-trips with multi_select -> text.
        assert convert_value(
            wrap("rich_text", "a, b ,c"), "rich_text", "multi_select"
        ) == wrap("multi_select", ["a", "b", "c"])


class TestEmptiness:
    @pytest.mark.parametrize(
        "value",
        [None, {}, {"type": "select"}, wrap("select", None), wrap("multi_select", [])],
    )
    def test_empty_or_malformed_values_convert_to_a_deletion(self, value):
        # None means "remove this key", not "store an empty wrapper" — an
        # absent key and an empty wrapper are different states elsewhere.
        assert convert_value(value, "select", "rich_text") is None

    def test_a_row_that_never_had_a_value_converts_cleanly(self):
        assert convert_value(None, "rich_text", "number") is None


class TestRefusal:
    def test_illegal_pair_raises_with_a_user_facing_message(self):
        with pytest.raises(ConversionError) as exc:
            convert_value(wrap("rich_text", "x"), "rich_text", "relation")
        assert "rich_text" in str(exc.value) and "relation" in str(exc.value)
