"""Golden-value table for the 53 formula builtins this task implements --
§H.3.1 logic (8), §H.3.2 numeric (25), §H.3.3 string (16, including
`formatNumber`'s format strings, §H.3.5), §H.3.4 regex (4).

Milestone 8c (Task 25) brief §4: "A golden-value table is the deliverable
here, not an afterthought... use the research's own worked examples
verbatim wherever it gives them, so the test suite is traceable to the
source rather than to your implementation's own behaviour. Where research
gives no example, write one and mark it in a comment as ours, not
Notion's."

Every row below is tagged SOURCED (a verbatim worked example from
docs/research/notion-databases-research.md §H.3) or OURS (this task's own
example, because research describes the function's shape/behaviour but
gives no concrete input/output pair). A handful of rows are marked
UNRESOLVED -- these are the runtime edge cases research §1.9 explicitly
declines to specify (`divide(1,0)`, `sqrt(-1)`, `ln(0)`, `toNumber("abc")`)
plus a few more this task extends the same ruling to (`mod` by zero,
`pow` with a complex result, out-of-range `substring`); all resolve to the
`EMPTY` sentinel per this task's brief.

Pure Python, no database, no fixtures.
"""
from __future__ import annotations

import math

import pytest

from services.db.formula import parse
from services.db.formula.evaluator import EvalContext, evaluate, make_now
from services.db.formula.values import EMPTY


def _eval(src: str):
    tree = parse(src)
    ctx = EvalContext(properties={}, now=make_now())
    return evaluate(tree, ctx)


# ---------------------------------------------------------------------------
# §3.1 Conditional / logic (8)
# ---------------------------------------------------------------------------

LOGIC_CASES = [
    # (id, source, expected) -- SOURCED unless noted OURS in the id.
    ("if_true", "if(true, 1, 2)", 1.0),  # SOURCED, official
    ("if_false", "if(false, 1, 2)", 2.0),  # SOURCED, official
    ("ifs_first_true", "ifs(true, 1, true, 2, 3)", 1.0),  # SOURCED, official
    ("ifs_falls_to_default", "ifs(false, 1, false, 2, 3)", 3.0),  # SOURCED, official
    ("and_true_true__ours", "and(true, true)", True),
    ("and_true_false__ours", "and(true, false)", False),
    ("or_false_true__ours", "or(false, true)", True),
    ("or_false_false__ours", "or(false, false)", False),
    ("not_true__ours", "not(true)", False),
    ("not_false__ours", "not(false)", True),
    ("equal_cross_type_string_number", '"1" == 1', False),  # SOURCED, official (§1.8)
    ("unequal_cross_type_string_bool", '"true" != true', True),  # SOURCED, official (§1.8)
    ("equal_call_form__ours", "equal(1, 1)", True),
    ("unequal_call_form__ours", "unequal(1, 2)", True),
    ("empty_zero_is_true", "empty(0)", True),  # SOURCED, official
    ("empty_empty_string_is_true", 'empty("")', True),  # SOURCED, official
    ("empty_empty_list_is_true", "empty([])", True),  # SOURCED, official
    ("empty_nonempty_string_is_false__ours", 'empty("x")', False),
    ("empty_zero_arg_is_the_null_literal", "empty()", EMPTY),  # SOURCED, official
]

# ---------------------------------------------------------------------------
# §3.2 Numeric / math (25)
# ---------------------------------------------------------------------------

NUMERIC_CASES = [
    ("add__ours", "add(2, 3)", 5.0),
    ("subtract__ours", "subtract(5, 3)", 2.0),
    ("multiply__ours", "multiply(4, 5)", 20.0),
    ("divide_official", "divide(5, 10)", 0.5),  # SOURCED, official
    ("mod__ours", "mod(7, 3)", 1.0),
    ("pow_official", "pow(5, 10)", 9765625.0),  # SOURCED, official (§2.1)
    ("abs__ours", "abs(-5)", 5.0),
    ("round_negative_places_official", "round(1234, -2)", 1200.0),  # SOURCED, official
    ("ceil_official", "ceil(-0.6)", 0.0),  # SOURCED, official
    ("floor_official", "floor(-0.6)", -1.0),  # SOURCED, official
    ("sqrt__ours", "sqrt(16)", 4.0),
    ("cbrt_positive__ours", "cbrt(27)", 3.0),
    ("cbrt_negative__ours", "cbrt(-8)", -2.0),
    ("exp_zero__ours", "exp(0)", 1.0),
    ("ln_one__ours", "ln(1)", 0.0),
    ("log10__ours", "log10(100)", 2.0),
    ("log2__ours", "log2(8)", 3.0),
    ("sign_negative__ours", "sign(-5)", -1.0),
    ("sign_zero__ours", "sign(0)", 0.0),
    ("sign_positive__ours", "sign(5)", 1.0),
    ("min_list_official", "min([1,2,3])", 1.0),  # SOURCED, official
    ("max_list_official", "max([1,2,3])", 3.0),  # SOURCED, official
    ("sum_mixed_list_and_scalars_official", "sum([1,2,3], 4, 5)", 15.0),  # SOURCED, official
    ("median_mixed_official", "median([1,2,3], 4)", 2.5),  # SOURCED, official
    ("mean_mixed_official", "mean([1,2,3], 4, 5)", 3.0),  # SOURCED, official
    ("pi_official", "pi()", math.pi),  # SOURCED, official (3.141592653589793)
    ("e_official", "e()", math.e),  # SOURCED, official (2.718281828459045)
    ("toNumber_true_official", "toNumber(true)", 1.0),  # SOURCED, official
    ("toNumber_string__ours", 'toNumber("42")', 42.0),
]

# ---------------------------------------------------------------------------
# §3.3 String (16)
# ---------------------------------------------------------------------------

STRING_CASES = [
    ("length_string__ours", 'length("hello")', 5.0),
    ("length_list__ours", "length([1,2,3])", 3.0),
    ("substring_start_end_official", 'substring("Notion",0,3)', "Not"),  # SOURCED, official
    ("substring_start_only_official", 'substring("Notion",3)', "ion"),  # SOURCED, official
    ("substring_number_receiver_coerces_official", "1932.substring(0,2)", "19"),  # SOURCED, official (§1.8)
    ("contains_true__ours", 'contains("Notion","ion")', True),
    ("contains_false__ours", 'contains("Notion","xyz")', False),
    ("lower__ours", 'lower("ABC")', "abc"),
    ("upper__ours", 'upper("abc")', "ABC"),
    ("repeat__ours", 'repeat("ab", 3)', "ababab"),
    ("trim__ours", 'trim("  hi  ")', "hi"),
    ("padStart_official", 'padStart("hello",8,".")', "...hello"),  # SOURCED, official
    ("padEnd__ours", 'padEnd("hello",8,".")', "hello..."),
    ("split__ours", 'split("a,b,c", ",")', ["a", "b", "c"]),
    ("join_stringifies_elements__ours", "join([1,2,3], \",\")", "1,2,3"),
    ("format_number_no_trailing_dot_zero__ours", "format(42)", "42"),
    ("format_bool_lowercase__ours", "format(true)", "true"),
    ("link_returns_label__ours", 'link("Notion","https://notion.so")', "Notion"),
    ("style_identity__ours", 'style("Notion","b","u")', "Notion"),
    ("unstyle_identity__ours", 'unstyle("Notion","b")', "Notion"),
    # formatNumber (§3.5) -- format strings are [P2] end to end.
    ("formatNumber_commas_official", "formatNumber(12345)", "12,345"),  # SOURCED, official default
    ("formatNumber_percent_official", 'formatNumber(0.856,"percent")', "85.6%"),  # SOURCED
    ("formatNumber_compact_official", 'formatNumber(1234567,"compact")', "1.2M"),  # SOURCED
    ("formatNumber_humanize_alias_official", 'formatNumber(1234567,"humanize")', "1.2M"),  # SOURCED
    ("formatNumber_bytes_decimal_official", 'formatNumber(12345678,"bytes_decimal")', "12.35 MB"),  # SOURCED
    (
        "formatNumber_bytes_decimal_no_padding_quirk_official",
        'formatNumber(1,"bytes_decimal",4)',
        "1 B",
    ),  # SOURCED, official quirk
    (
        "formatNumber_bytes_binary_corrected__ours",
        'formatNumber(12345678,"bytes_binary")',
        "11.77 MiB",
    ),  # OURS -- see this task's report: research's own worked example
    # ("12345678 -> 12.06 KiB") is numerically wrong (12345678 / 1024 =
    # ~12056 KiB, not 12.06; 12345678 / 1048576 = ~11.77 MiB). Corrected
    # here rather than reproduced.
    ("formatNumber_bytes_alias__ours", 'formatNumber(0,"bytes")', "0 B"),
    ("formatNumber_currency_usd__ours", 'formatNumber(1234.5,"usd")', "USD 1,234.50"),
    ("formatNumber_currency_alias_dollar__ours", 'formatNumber(1,"dollar")', "USD 1.00"),
]

# ---------------------------------------------------------------------------
# §3.4 Regex (4) -- Python `re`, JS-dialect assumption flagged (regex.py)
# ---------------------------------------------------------------------------

REGEX_CASES = [
    ("test_no_digit_official", 'test("Notion","\\\\d")', False),  # SOURCED, official
    ("test_has_digit__ours", 'test("Notion1","\\\\d")', True),
    (
        "match_all_matches_official",
        'match("Notion 123 Notion 456","\\\\d+")',
        ["123", "456"],
    ),  # SOURCED, official
    ("replace_first_only__ours", 'replace("aaa","a","b")', "baa"),
    ("replaceAll_every_match__ours", 'replaceAll("aaa","a","b")', "bbb"),
    (
        "replace_dollar_group_substitution__ours",
        'replace("2023-01-15","(\\\\d+)-(\\\\d+)-(\\\\d+)","$2/$3/$1")',
        "01/15/2023",
    ),
]

ALL_GOLDEN_CASES = LOGIC_CASES + NUMERIC_CASES + STRING_CASES + REGEX_CASES


@pytest.mark.parametrize("case_id,src,expected", ALL_GOLDEN_CASES, ids=[c[0] for c in ALL_GOLDEN_CASES])
def test_golden_value(case_id, src, expected):
    result = _eval(src)
    if expected is EMPTY:
        assert result is EMPTY
    else:
        assert result == expected


def test_golden_table_covers_every_implemented_function_at_least_once():
    """Every one of the 53 names THIS FILE's golden table covers (logic /
    numeric / string / regex, Task 25's four categories) appears in at
    least one golden case above (by simple substring-of-source-text
    search, sufficient since builtin names are called by name in every
    case).

    Scoped to exactly those 53 -- NOT `functions.REGISTRY` as a whole,
    which Task 26 completed to 93 -- because Task 26's own golden tables
    (test_formula_functions_date.py, test_formula_functions_list.py) carry
    the identical completeness check for the other 40 date/time/list/
    page-person names. Checking the full registry from this file would
    make it fail every time a category this file doesn't own gets
    implemented -- exactly what happened when Task 26 landed, fixed here.

    `typecheck.FUNCTION_SIGNATURES` is declared in research's own
    §3.1(logic)->§3.2(numeric)->§3.3(string)->§3.4(regex)->§3.6..3.8(date/
    list/page) order, so its first 53 keys ARE exactly Task 25's 53 names
    -- verified once, directly, against `functions.REGISTRY`'s own
    logic.py/numeric.py/string.py/regex.py module boundaries."""
    from services.db.formula.typecheck import FUNCTION_SIGNATURES

    task_25_names = list(FUNCTION_SIGNATURES)[:53]
    covered_source = " ".join(src for _id, src, _expected in ALL_GOLDEN_CASES)
    missing = [name for name in task_25_names if name not in covered_source]
    assert not missing, f"no golden-value case exercises: {sorted(missing)}"


# ---------------------------------------------------------------------------
# UNRESOLVED runtime edges (research §1.9's own named list, decided EMPTY
# per this task's brief; plus this task's own extensions to the same
# ruling for functions research doesn't name but which have the identical
# "undocumented domain error" shape).
# ---------------------------------------------------------------------------

UNRESOLVED_EDGE_CASES = [
    ("divide_by_zero", "divide(1, 0)"),  # research §1.9, named verbatim
    ("sqrt_negative", "sqrt(-1)"),  # research §1.9, named verbatim
    ("ln_zero", "ln(0)"),  # research §1.9, named verbatim
    ("toNumber_garbage", 'toNumber("abc")'),  # research §1.9, named verbatim
    # research §1.9 also names `parseDate("garbage")` and `at(list, 99)` --
    # both belong to Task 26's categories (date/time, list) and cannot be
    # exercised by this task's evaluator; Task 26 inherits the identical
    # EMPTY ruling for them (see this task's report).
    ("ln_negative__ours_extension", "ln(-1)"),
    ("log10_zero__ours_extension", "log10(0)"),
    ("log10_negative__ours_extension", "log10(-1)"),
    ("log2_zero__ours_extension", "log2(0)"),
    ("mod_by_zero__ours_extension", "mod(1, 0)"),
    ("pow_negative_base_fractional_exponent__ours_extension", "pow(-1, 0.5)"),
]


@pytest.mark.parametrize(
    "case_id,src", UNRESOLVED_EDGE_CASES, ids=[c[0] for c in UNRESOLVED_EDGE_CASES]
)
def test_unresolved_runtime_edge_returns_empty_never_raises(case_id, src):
    assert _eval(src) is EMPTY


def test_out_of_range_substring_clamps_rather_than_raising():
    # A DIFFERENT edge from the ones above: an out-of-range index that is
    # still a well-formed call clamps (this task's own decision,
    # string.py's `_clamp_index` docstring) rather than becoming EMPTY --
    # `substring("hi", 5)` clamps start to len("hi")==2, giving "".
    assert _eval('substring("hi", 5)') == ""


def test_pow_produces_no_nan_or_infinity_ever():
    # Brief, explicit: "never NaN/Infinity" -- spot-check a value that
    # would be `inf` under naive float exponentiation without a guard.
    result = _eval("pow(10, 400)")
    assert result is EMPTY or (isinstance(result, float) and math.isfinite(result))


# ---------------------------------------------------------------------------
# formatNumber currency-code coverage (this task's own invented rendering
# -- see string.py's `_format_number` docstring; NOT sourced from
# research, which gives zero worked currency examples)
# ---------------------------------------------------------------------------


def test_formatNumber_accepts_every_documented_currency_code():
    from services.db.formula.functions.string import _CURRENCY_CODES

    assert len(_CURRENCY_CODES) == 38  # research §3.5's own list, recounted -- see report
    for code in _CURRENCY_CODES:
        result = _eval(f'formatNumber(1, "{code}")')
        assert result != EMPTY, f"currency code {code!r} was rejected"
        assert result.startswith(code.upper())


def test_formatNumber_unrecognised_format_string_is_empty():
    assert _eval('formatNumber(1, "not-a-real-format")') is EMPTY
