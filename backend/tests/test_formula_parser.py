"""Tests for services/db/formula/{lexer,ast,parser}.py — Milestone 8a (Task 23):
the formula lexer, AST, and Pratt parser. Parsing only; no type checking, no
evaluation. See task-23-brief.md and docs/research/notion-databases-research.md
§H for the language spec this is testing against.

Pure Python, no database, no fixtures.
"""
from __future__ import annotations

import pytest

from services.db.formula import (
    Binary,
    Call,
    Conditional,
    FormulaSyntaxError,
    Let,
    Literal,
    ListLiteral,
    MAX_PARSE_DEPTH,
    MethodCall,
    PropertyRef,
    Unary,
    Variable,
    parse,
)


# ---------------------------------------------------------------------------
# Precedence and associativity
# ---------------------------------------------------------------------------


def test_pow_is_right_associative():
    # 2^3^2 == 2^(3^2) == 512-shaped tree, not (2^3)^2.
    tree = parse("2^3^2")
    assert isinstance(tree, Binary) and tree.op == "^"
    assert tree.left == Literal(tree.left.pos, 2.0)
    assert isinstance(tree.right, Binary) and tree.right.op == "^"
    assert tree.right.left == Literal(tree.right.left.pos, 3.0)
    assert tree.right.right == Literal(tree.right.right.pos, 2.0)


def test_comparison_chain_raises():
    with pytest.raises(FormulaSyntaxError):
        parse("1 > x > 5")


def test_equality_chain_raises():
    with pytest.raises(FormulaSyntaxError):
        parse("1 == x == 2")


def test_mixed_comparison_and_equality_levels_is_not_chaining():
    # Different precedence tiers (> is level 5, == is level 4) — not a chain.
    tree = parse("1 > x == true")
    assert isinstance(tree, Binary) and tree.op == "=="
    assert isinstance(tree.left, Binary) and tree.left.op == ">"


def test_not_binds_tighter_than_and():
    # not a and b == (not a) and b
    tree = parse("not a and b")
    assert isinstance(tree, Binary) and tree.op == "and"
    assert isinstance(tree.left, Unary) and tree.left.op == "not"
    assert isinstance(tree.left.operand, Variable) and tree.left.operand.name == "a"
    assert isinstance(tree.right, Variable) and tree.right.name == "b"


def test_unary_minus_binds_looser_than_pow():
    # -2^2 == -(2^2) == -4, per brief §0's ruling (matches Python's -2**2).
    tree = parse("-2^2")
    assert isinstance(tree, Unary) and tree.op == "-"
    inner = tree.operand
    assert isinstance(inner, Binary) and inner.op == "^"
    assert inner.left == Literal(inner.left.pos, 2.0)
    assert inner.right == Literal(inner.right.pos, 2.0)


def test_percent_is_same_level_as_mul_div():
    # 1 + 2 % 3 == 1 + (2 % 3)
    tree = parse("1 + 2 % 3")
    assert isinstance(tree, Binary) and tree.op == "+"
    assert isinstance(tree.right, Binary) and tree.right.op == "%"


def test_mul_div_percent_left_associative():
    tree = parse("8 / 4 / 2")
    assert isinstance(tree, Binary) and tree.op == "/"
    assert isinstance(tree.left, Binary) and tree.left.op == "/"
    assert tree.left.left == Literal(tree.left.left.pos, 8.0)


def test_and_or_case_insensitive():
    tree = parse("a AND b")
    assert isinstance(tree, Binary) and tree.op == "and"
    tree2 = parse("a Or b")
    assert isinstance(tree2, Binary) and tree2.op == "or"
    tree3 = parse("Not a", property_names=())
    assert isinstance(tree3, Unary) and tree3.op == "not"


def test_true_false_only_lowercase():
    # Brief §0 ruling: TRUE/True are NOT boolean literals (only exact-case
    # "true"/"false"); they fall through to being a bare Variable instead.
    tree = parse("true")
    assert tree == Literal(tree.pos, True)
    tree2 = parse("True")
    assert isinstance(tree2, Variable) and tree2.name == "True"


def test_bang_equals_alias_and_double_bang_equals_tolerant():
    tree = parse("a != b")
    assert isinstance(tree, Binary) and tree.op == "!="
    # Research §2.5: one official example uses `!==`; UNRESOLVED whether real
    # or a typo. Decided here (not in brief's table): tolerant, treat as `!=`.
    tree2 = parse("a !== b")
    assert isinstance(tree2, Binary) and tree2.op == "!="


# ---------------------------------------------------------------------------
# Ternary / if / ifs
# ---------------------------------------------------------------------------


def _shape(node):
    """Structural equality ignoring `pos` (which legitimately differs between
    two different source strings) — everything else must match exactly."""
    import dataclasses

    if not dataclasses.is_dataclass(node):
        return node
    fields = {f.name: getattr(node, f.name) for f in dataclasses.fields(node) if f.name != "pos"}
    for k, v in fields.items():
        if dataclasses.is_dataclass(v):
            fields[k] = _shape(v)
        elif isinstance(v, list):
            fields[k] = [_shape(x) for x in v]
        elif isinstance(v, tuple):
            fields[k] = tuple(_shape(x) for x in v)
    return (type(node).__name__, fields)


def test_ternary_and_if_produce_identical_tree_shape():
    ternary = parse("true ? 1 : 2")
    call_form = parse("if(true, 1, 2)")
    assert isinstance(ternary, Conditional)
    assert isinstance(call_form, Conditional)
    assert _shape(ternary) == _shape(call_form)


def test_ternary_right_associative_nesting():
    tree = parse("a ? 1 : b ? 2 : 3")
    assert isinstance(tree, Conditional)
    assert isinstance(tree.otherwise, Conditional)


def test_if_wrong_arity_left_as_call_not_conditional():
    # Decided here (not verbatim in brief): only exactly-3-arg if() normalises;
    # the type checker (later task) owns wrong-arity rejection uniformly.
    tree = parse("if(true, 1)")
    assert isinstance(tree, Call) and tree.name == "if"
    assert len(tree.args) == 2


def test_ifs_stays_a_call_any_arity():
    tree = parse("ifs(true, 1, false, 2, 3)")
    assert isinstance(tree, Call) and tree.name == "ifs"
    assert len(tree.args) == 5
    tree2 = parse("ifs(true, 1)")  # parser accepts any count; type checker enforces shape
    assert isinstance(tree2, Call) and tree2.name == "ifs"


# ---------------------------------------------------------------------------
# let / lets
# ---------------------------------------------------------------------------


def test_let_single_binding():
    tree = parse('let(person, "Alan", "Hello, " + person)')
    assert isinstance(tree, Let)
    assert tree.bindings == [("person", Literal(tree.bindings[0][1].pos, "Alan"))]
    assert isinstance(tree.body, Binary)


def test_let_multi_binding_since_april_2025():
    tree = parse("let(a, 1, b, 2, a + b)")
    assert isinstance(tree, Let)
    assert [name for name, _ in tree.bindings] == ["a", "b"]


def test_lets_is_an_alias_producing_same_node_type():
    a = parse("let(a, 1, a)")
    b = parse("lets(a, 1, a)")
    assert isinstance(a, Let) and isinstance(b, Let)


def test_lets_research_worked_example_var1_through_var5():
    # research §2.4's own nested worked example.
    src = """
    lets(
        var1, 2 + 2,
        var2, 3 + 3,
        var3, lets(var4, var1 * var2, var5, var4 / var1, var5),
        var3 - var1
    )
    """
    tree = parse(src)
    assert isinstance(tree, Let)
    names = [name for name, _ in tree.bindings]
    assert names == ["var1", "var2", "var3"]
    var3_value = tree.bindings[2][1]
    assert isinstance(var3_value, Let)
    assert [n for n, _ in var3_value.bindings] == ["var4", "var5"]


def test_let_needs_a_body_even_arg_count_is_syntax_error():
    with pytest.raises(FormulaSyntaxError, match="final expression"):
        parse("let(a, 1)")
    with pytest.raises(FormulaSyntaxError, match="final expression"):
        parse("let()")


def test_let_binding_name_must_be_plain_identifier():
    with pytest.raises(FormulaSyntaxError, match="plain identifier"):
        parse("let(1, 2, 3)")


def test_let_shadowing_inner_shadows_outer():
    # Brief §0 ruling: shadowing legal, inner sees outer, ordinary lexical
    # scoping. Parser doesn't enforce scoping semantics (evaluator's job) but
    # must at least parse this shape without complaint.
    tree = parse("let(x, 1, let(x, 2, x))")
    assert isinstance(tree, Let)
    inner = tree.body
    assert isinstance(inner, Let) and inner.bindings[0][0] == "x"


# ---------------------------------------------------------------------------
# Dot notation / method calls / number-then-dot lexing
# ---------------------------------------------------------------------------


def test_number_then_dot_lexes_as_number_dot_ident():
    # 1932.substring(0,2) must lex as NUMBER(1932) DOT IDENT(substring), not
    # NUMBER(1932.) followed by garbage.
    tree = parse("1932.substring(0,2)")
    assert isinstance(tree, MethodCall)
    assert tree.name == "substring"
    assert isinstance(tree.receiver, Literal) and tree.receiver.value == 1932.0


def test_decimal_number_then_dot_method():
    tree = parse('12345.67.formatNumber("usd")')
    assert isinstance(tree, MethodCall) and tree.name == "formatNumber"
    assert tree.receiver.value == 12345.67


def test_method_chain_is_left_associative():
    tree = parse("a.f(b).g(c)")
    assert isinstance(tree, MethodCall) and tree.name == "g"
    assert isinstance(tree.receiver, MethodCall) and tree.receiver.name == "f"
    assert isinstance(tree.receiver.receiver, Variable) and tree.receiver.receiver.name == "a"


def test_dot_call_and_function_call_forms_both_parse_generically():
    dot_form = parse('prop("Title").length()')
    fn_form = parse('length(prop("Title"))')
    assert isinstance(dot_form, MethodCall) and dot_form.name == "length"
    assert isinstance(fn_form, Call) and fn_form.name == "length"


def test_bare_dotted_property_access_desugars_to_prop_method_call():
    # current.Status -- documented equivalent of current.prop("Status").
    # Decided here (brief doesn't spell this case out): only resolves when
    # "Status" is a known property name.
    tree = parse("current.Status", property_names=["Status"])
    assert isinstance(tree, MethodCall)
    assert tree.name == "prop"
    assert tree.args == [Literal(tree.args[0].pos, "Status")]
    assert isinstance(tree.receiver, Variable) and tree.receiver.name == "current"


def test_bare_dotted_access_not_matching_property_is_zero_arg_method_call():
    tree = parse("current.Status")  # no property_names supplied
    assert isinstance(tree, MethodCall)
    assert tree.name == "Status"
    assert tree.args == []


def test_variable_lets_dot_form_no_special_case():
    # Brief §0 ruling: treat as the generic dot-notation rewrite, no special
    # handling — stays a MethodCall named "lets", NOT normalised into Let.
    tree = parse("x.lets(a, 1, a)")
    assert isinstance(tree, MethodCall) and tree.name == "lets"
    assert not isinstance(tree, Let)


# ---------------------------------------------------------------------------
# Property references
# ---------------------------------------------------------------------------


def test_prop_call_form_stays_a_plain_call():
    tree = parse('prop("Price")')
    assert isinstance(tree, Call) and tree.name == "prop"
    assert tree.args == [Literal(tree.args[0].pos, "Price")]


def test_bare_single_word_property_resolves_with_property_names():
    tree = parse("Status", property_names=["Status"])
    assert isinstance(tree, PropertyRef) and tree.name == "Status"


def test_bare_single_word_not_matching_property_is_a_variable():
    tree = parse("Status")  # empty property_names
    assert isinstance(tree, Variable) and tree.name == "Status"


def test_bare_multiword_property_resolves_only_with_property_names():
    tree = parse(
        'dateAdd(Start Date, 2, "week")', property_names=["Start Date"]
    )
    assert isinstance(tree, Call) and tree.name == "dateAdd"
    ref = tree.args[0]
    assert isinstance(ref, PropertyRef) and ref.name == "Start Date"


def test_bare_multiword_property_without_property_names_is_clean_syntax_error():
    # Negative case: must NOT silently misparse into two variables.
    with pytest.raises(FormulaSyntaxError, match="Start Date"):
        parse('dateAdd(Start Date, 2, "week")')


def test_bare_multiword_property_partial_property_names_still_errors():
    # Only a match of the *whole* run resolves; a partial/wrong set does not
    # silently pick a shorter prefix.
    with pytest.raises(FormulaSyntaxError):
        parse('dateAdd(Start Date, 2, "week")', property_names=["Start"])


# ---------------------------------------------------------------------------
# MAX_PARSE_DEPTH
# ---------------------------------------------------------------------------


def test_max_parse_depth_paren_nesting_raises_formula_syntax_error():
    src = "(" * (MAX_PARSE_DEPTH * 3) + "1" + ")" * (MAX_PARSE_DEPTH * 3)
    with pytest.raises(FormulaSyntaxError) as exc_info:
        parse(src)
    assert not isinstance(exc_info.value, RecursionError)


def test_max_parse_depth_caret_chain_raises_formula_syntax_error():
    src = "^".join(["2"] * (MAX_PARSE_DEPTH * 3))
    with pytest.raises(FormulaSyntaxError):
        parse(src)


def test_max_parse_depth_not_chain_raises_formula_syntax_error():
    src = "not " * (MAX_PARSE_DEPTH * 3) + "true"
    with pytest.raises(FormulaSyntaxError):
        parse(src)


def test_max_parse_depth_unary_minus_chain_raises_formula_syntax_error():
    src = "-" * (MAX_PARSE_DEPTH * 3) + "1"
    with pytest.raises(FormulaSyntaxError):
        parse(src)


def test_reasonable_nesting_under_the_cap_still_parses():
    src = "(" * 10 + "1" + ")" * 10
    tree = parse(src)
    assert tree == Literal(tree.pos, 1.0)


# ---------------------------------------------------------------------------
# Strings, comments, whitespace
# ---------------------------------------------------------------------------


def test_string_escapes():
    tree = parse(r'"a\nb\tc\\d\"e"')
    assert tree == Literal(tree.pos, 'a\nb\tc\\d"e')


def test_unterminated_string_error_position():
    src = '1 + "abc'
    with pytest.raises(FormulaSyntaxError) as exc_info:
        parse(src)
    assert exc_info.value.pos == 4  # points at the opening quote


def test_invalid_escape_sequence_is_a_lex_error():
    with pytest.raises(FormulaSyntaxError, match="invalid escape"):
        parse(r'"bad \q escape"')


def test_block_comment_and_whitespace_skipped():
    tree = parse("/* a comment */ 1 + /* another */ 2")
    assert isinstance(tree, Binary) and tree.op == "+"


def test_multiline_formula_with_newlines_and_tabs():
    src = "let(\n\ta, 1,\n\tb, 2,\n\ta + b\n)"
    tree = parse(src)
    assert isinstance(tree, Let)


def test_unterminated_comment_is_a_lex_error():
    with pytest.raises(FormulaSyntaxError, match="unterminated comment"):
        parse("1 + /* never closed")


# ---------------------------------------------------------------------------
# List literals
# ---------------------------------------------------------------------------


def test_list_literal_heterogeneous_and_nested():
    tree = parse('[1, "a", true, [2, 3]]')
    assert isinstance(tree, ListLiteral)
    assert len(tree.items) == 4
    assert tree.items[0] == Literal(tree.items[0].pos, 1.0)
    assert tree.items[1] == Literal(tree.items[1].pos, "a")
    assert tree.items[2] == Literal(tree.items[2].pos, True)
    assert isinstance(tree.items[3], ListLiteral)
    assert len(tree.items[3].items) == 2


def test_empty_list_literal():
    tree = parse("[]")
    assert isinstance(tree, ListLiteral) and tree.items == []


# ---------------------------------------------------------------------------
# Malformed inputs: table of ~15 cases, all must raise FormulaSyntaxError
# with a sensible pos.
# ---------------------------------------------------------------------------


_MALFORMED_INPUTS = [
    "1 +",
    "(1 + 2",
    "1 + 2)",
    "1 2",
    "* 1",
    "1 > x > 5",
    "1 == x == 2",
    "let()",
    "let(a, 1)",
    "let(1, 2, 3)",
    '"unterminated',
    r'"bad \q escape"',
    "1 + /* unterminated comment",
    "[1, 2",
    "if(true, 1, 2",
    "prop(",
    ",",
    "?",
    "a ? b",  # missing ':' branch
    "dateAdd(Start Date, 2, \"week\")",  # unresolved bare multi-word ref
]


@pytest.mark.parametrize("src", _MALFORMED_INPUTS)
def test_malformed_inputs_raise_formula_syntax_error_with_position(src):
    with pytest.raises(FormulaSyntaxError) as exc_info:
        parse(src)
    err = exc_info.value
    assert isinstance(err.pos, int) and err.pos >= 0
    assert err.line >= 1 and err.col >= 1
    assert isinstance(err.message, str) and err.message


def test_parser_never_raises_anything_other_than_formula_syntax_error():
    for src in _MALFORMED_INPUTS + ["", "   ", "/* only a comment */"]:
        try:
            parse(src)
        except FormulaSyntaxError:
            pass
        except Exception as exc:  # pragma: no cover - failure path
            pytest.fail(f"parse({src!r}) raised {type(exc).__name__}, not FormulaSyntaxError: {exc}")


# ---------------------------------------------------------------------------
# current / index implicit list-function variables
# ---------------------------------------------------------------------------


def test_current_and_index_parse_as_ordinary_variables():
    tree = parse("map([1,2,3], current + index)")
    assert isinstance(tree, Call) and tree.name == "map"
    body = tree.args[1]
    assert isinstance(body, Binary)
    assert isinstance(body.left, Variable) and body.left.name == "current"
    assert isinstance(body.right, Variable) and body.right.name == "index"
