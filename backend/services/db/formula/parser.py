"""Hand-written Pratt/recursive-descent parser for the formula language:
token stream (lexer.py) -> AST (ast.py). Parsing only — no type checking, no
evaluation, no builtin-arity validation. Those are later tasks (M8b/M8c);
see this task's brief, "Out of scope".

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.1, §7.2.
Research: docs/research/notion-databases-research.md §H.1-H.2.12.
Ruling table for every point research marks `UNRESOLVED:`:
.superpowers/sdd/2026-08-08-notion-databases/task-23-brief.md §0.

--------------------------------------------------------------------------
Why this parser must be schema-aware (property_names)
--------------------------------------------------------------------------
Every other part of this parser is a pure function of the token stream. This one
part is not, and it deserves an explanation because a parser depending on
information *external to the source text* is unusual.

Research §2.6 documents three surface forms for "reference a property":
  1. `prop("Name")` — an ordinary call. No special handling needed at all; it
     lexes and parses like any other `f("literal")` call and stays a `Call` node.
  2. A **bare token**, which may contain spaces: official docs show
     `dateAdd(Start Date, 2, "week")` and `Parent Task.Sub-item.every(...)`.
  3. Dotted off a `Page` value: `current.Status`.

Forms 2 and 3 are the problem. `Start Date` is lexically two `IDENT` tokens
(`Start`, `Date`) with nothing between them — no quotes, no sigil, no
whitespace-is-significant rule. A context-free lexer or parser cannot tell
`Start Date` (one property) from, say, two adjacent single-word variable
references (which would otherwise be a syntax error, since the grammar has no
rule for "expression expression" with no operator between them — but the
*parser* doesn't know that in advance without knowing which identifiers are
properties).

Research itself concludes this (§2.6, "Practical takeaway for a parser"):
`prop("...")` is the one form the wire format (the API's `formula.expression`)
actually uses, and bare tokens are "an editor affordance whose grammar is
undocumented and ambiguous" — the research's own best guess is that they are not
textual at all in the live editor, but rich-text chips backed by property IDs
that only *render* as bare words.

This task's brief (§1.2) resolves the ambiguity the only way it can be resolved
without inventing new syntax: `parse()` takes the caller's real, current set of
property names (`property_names: Iterable[str]`) and the parser greedily joins a
run of adjacent `IDENT` tokens into a single `PropertyRef` **only when the
joined text matches a member of that set.** With no match — including the
common case of calling `parse()` with an empty set, e.g. for a syntax-only
check — a multi-word bare reference is a clean `FormulaSyntaxError` rather than
a silent misparse into two unrelated variables. A single bare identifier that
isn't a resolved property, isn't a keyword, and isn't a call target instead
becomes a `Variable` (a `let`/`lets` binding use) — see `_parse_bare_ident`.

The same ambiguity, and the same resolution, recurs after a `.` with no call
parens (`current.Status`): see `_parse_dot_access`'s docstring for how that
case is handled — it is *not* explicitly worked through in the brief, and is
flagged in this task's report as a decision made here.
"""
from __future__ import annotations

import sys
from contextlib import contextmanager
from typing import Iterable, Iterator

from . import ast as A
from .lexer import FormulaSyntaxError, Token, TokenKind, tokenize

__all__ = ["parse", "FormulaSyntaxError", "MAX_PARSE_DEPTH"]

# This is a *parser* recursion-depth cap, distinct from spec §7.3's
# formula-depth-15 limit. §7.3's 15 is a semantic limit on property-reference
# chains (how many hops of prop-of-a-relation a formula may traverse) and
# belongs to Task 24's dependency extractor / evaluator — it is checked against
# the *meaning* of a parsed formula, long after this module has returned a tree.
# MAX_PARSE_DEPTH exists purely to stop a hostile/malformed input from
# overflowing the Python call stack while *parsing* — a formula is one string a
# user can nest arbitrarily deeply (`((((((...))))))`, `f(f(f(f(...))))`,
# `2^2^2^2^...`), and an uncaught `RecursionError` reaching the validate
# endpoint (a later task) would surface as an HTTP 500, not a 400. Naming them
# differently is deliberate so the two are never confused in code review.
MAX_PARSE_DEPTH = 200

# Operators recognised as their word forms, case-insensitively — research §2.1:
# "Notion is no longer picky, so `&&`, `AND`, and `And` now also work" [P2],
# confirmed only for `and`. Brief §0 ruling: extend the same case-insensitivity
# to `or`/`not` (the research quote is about the *class* of logical-keyword
# operators, and singling out `and` while leaving `or`/`not` case-sensitive
# would be a stranger reading than treating the three uniformly), but do NOT
# extend it to the `true`/`false` literals — that is a bigger leap from the one
# documented data point, so `TRUE`/`True` etc. are plain (unresolved) bare
# identifiers, not booleans. Both halves of this ruling are `UNRESOLVED:` in
# research (§2.1) and are decided here per the brief.
_WORD_OR = "or"
_WORD_AND = "and"
_WORD_NOT = "not"


class _Parser:
    def __init__(self, tokens: list[Token], property_names: frozenset[str]):
        self.tokens = tokens
        self.i = 0
        self.property_names = property_names
        self.depth = 0
        # Every AST node's `.pos` is copied from some token's `.pos` (never
        # synthesised), so this is a total, O(1) way to recover a token's
        # line/col from a node's `.pos` alone for errors raised well after
        # that token was consumed (e.g. `_build_let` inspecting an already-
        # fully-parsed argument list).
        self._pos_index = {t.pos: t for t in tokens}

    # -- token stream helpers -------------------------------------------------

    def _peek(self) -> Token:
        return self.tokens[self.i]

    def _peek_next(self) -> Token:
        """The token after the current one. Always safe: `tokens` is guaranteed
        to end with a single `EOF`, and this is only called when the current
        token is not `EOF`."""
        return self.tokens[self.i + 1]

    def _advance(self) -> Token:
        tok = self.tokens[self.i]
        if tok.kind != TokenKind.EOF:
            self.i += 1
        return tok

    def _check_op(self, *values: str) -> bool:
        tok = self._peek()
        return tok.kind == TokenKind.OP and tok.value in values

    def _check_word(self, *words: str) -> bool:
        """Case-insensitive match against a bare-IDENT keyword spelling."""
        tok = self._peek()
        return tok.kind == TokenKind.IDENT and tok.value.lower() in words

    def _error(self, message: str, tok: Token | None = None) -> FormulaSyntaxError:
        tok = tok or self._peek()
        return FormulaSyntaxError(message, tok.pos, tok.line, tok.col)

    def _error_at_pos(self, message: str, pos: int) -> FormulaSyntaxError:
        """Like `_error`, but locates the token by AST-node `.pos` rather than
        the parser's current stream position — see `_pos_index`."""
        tok = self._pos_index.get(pos) or self._peek()
        return FormulaSyntaxError(message, tok.pos, tok.line, tok.col)

    def _expect(self, kind: TokenKind, message: str) -> Token:
        tok = self._peek()
        if tok.kind != kind:
            raise self._error(message, tok)
        return self._advance()

    # -- recursion-depth guard -------------------------------------------------
    # See MAX_PARSE_DEPTH's module-level comment. Guarded at every grammar rule
    # that can recurse into *itself* (directly, or through a short mutually
    # recursive cycle) on a single long/deeply-nested input: `_parse_expr` (any
    # parenthesised/bracketed/call-argument/ternary-branch nesting),
    # `_parse_unary_minus`/`_parse_power` (a `^`/unary-`-` chain — these two
    # recurse into each other; see their docstrings), and `_parse_not` (a
    # `not`/`!` chain). The purely left-associative, loop-based levels
    # (`_parse_or`/`_parse_and`/.../`_parse_multiplicative`) do not recurse into
    # themselves and need no guard — a long *chain* of `+` is one stack frame
    # regardless of length; only *nesting* costs a frame.

    @contextmanager
    def _guard_depth(self) -> Iterator[None]:
        self.depth += 1
        if self.depth > MAX_PARSE_DEPTH:
            raise self._error(
                f"formula nesting exceeds MAX_PARSE_DEPTH={MAX_PARSE_DEPTH}"
            )
        try:
            yield
        finally:
            self.depth -= 1

    # -- grammar: expression entry point (ternary is the loosest level) -------

    def _parse_expr(self) -> A.Node:
        with self._guard_depth():
            return self._parse_ternary()

    def _parse_ternary(self) -> A.Node:  # precedence 1, right-assoc
        cond = self._parse_or()
        if self._peek().kind == TokenKind.QUESTION:
            self._advance()
            then_ = self._parse_expr()
            self._expect(TokenKind.COLON, "expected ':' in ternary expression")
            else_ = self._parse_expr()
            # Ternary and `if(cond, then, else)` are the same construct
            # (official docs: the ternary "is equivalent to `if(X, Y, Z)`") —
            # normalised to one node here so no downstream visitor has to know
            # there were ever two spellings. See ast.Conditional's docstring.
            return A.Conditional(cond.pos, cond, then_, else_)
        return cond

    def _parse_or(self) -> A.Node:  # precedence 2, left-assoc
        left = self._parse_and()
        while self._check_op("||") or self._check_word(_WORD_OR):
            self._advance()
            right = self._parse_and()
            left = A.Binary(left.pos, "or", left, right)
        return left

    def _parse_and(self) -> A.Node:  # precedence 3, left-assoc
        left = self._parse_equality()
        while self._check_op("&&") or self._check_word(_WORD_AND):
            self._advance()
            right = self._parse_equality()
            left = A.Binary(left.pos, "and", left, right)
        return left

    def _parse_equality(self) -> A.Node:  # precedence 4, non-associative
        left = self._parse_comparison()
        if self._check_op("==", "!="):
            op = self._advance().value
            right = self._parse_comparison()
            left = A.Binary(left.pos, op, left, right)
            if self._check_op("==", "!="):
                # Non-associativity is an enforced grammar rule, not a
                # convention we merely document — research §2.2 is emphatic:
                # `1 == toNumber(true) == toNumber("1")` is documented invalid.
                # Note this check fires only immediately after building *this*
                # equality node, so `1 > x == true` (comparison then equality —
                # different tiers) is unaffected and parses normally.
                raise self._error(
                    "comparison operators do not chain: "
                    f"write '{op}' only once (e.g. use 'and' to combine "
                    "multiple comparisons)"
                )
        return left

    def _parse_comparison(self) -> A.Node:  # precedence 5, non-associative
        left = self._parse_additive()
        if self._check_op(">", ">=", "<", "<="):
            op = self._advance().value
            right = self._parse_additive()
            left = A.Binary(left.pos, op, left, right)
            if self._check_op(">", ">=", "<", "<="):
                raise self._error(
                    "comparison operators do not chain: "
                    f"write '{op}' only once (e.g. use 'and' to combine "
                    "multiple comparisons)"
                )
        return left

    def _parse_additive(self) -> A.Node:  # precedence 6, left-assoc
        left = self._parse_multiplicative()
        while self._check_op("+", "-"):
            op = self._advance().value
            right = self._parse_multiplicative()
            left = A.Binary(left.pos, op, left, right)
        return left

    def _parse_multiplicative(self) -> A.Node:  # precedence 7, left-assoc
        # `%` at this level, alongside `*`/`/`, is brief §0's ruling for
        # research's `UNRESOLVED:` (§2.2): "Level 7, with `*` and `/`. The
        # natural reading, and research says so."
        left = self._parse_unary_minus()
        while self._check_op("*", "/", "%"):
            op = self._advance().value
            right = self._parse_unary_minus()
            left = A.Binary(left.pos, op, left, right)
        return left

    def _parse_unary_minus(self) -> A.Node:  # precedence 8.5, prefix, right-assoc
        # Brief §0's ruling for research's `UNRESOLVED:` (§2.2, unary-minus
        # precedence): binds tighter than `^`'s LEFT operand but looser than
        # `^` as a whole, so `-2^2 == -4` (matching Python's `-2**2` and every
        # mainstream language). That requires an asymmetric grammar, not a flat
        # precedence-climb: this function's own operand recurses back into
        # itself first (`_parse_unary_minus`, allowing a repeated `--x`) and
        # only falls through to `_parse_power` once there is no more leading
        # `-` — so `-2^2` parses as `-(2^2)`, because the whole `2^2` power
        # expression becomes this Unary's operand. Symmetrically,
        # `_parse_power`'s *right*-hand (exponent) operand recurses back up
        # into this function (not straight into `_parse_power`), so `2^-2`
        # parses as `2^(-2)` without needing parentheses — this isn't tested by
        # the brief but falls out of mirroring the same asymmetric structure
        # every mainstream language uses for `-x**y`.
        #
        # Guarded (see MAX_PARSE_DEPTH's module comment): a chain like
        # `----------------x` recurses through this function alone, never
        # passing through `_parse_expr`, so it needs its own depth guard to
        # stay bounded.
        with self._guard_depth():
            if self._check_op("-"):
                tok = self._advance()
                operand = self._parse_unary_minus()
                return A.Unary(tok.pos, "-", operand)
            return self._parse_power()

    def _parse_power(self) -> A.Node:  # precedence 8, right-assoc
        # Guarded: a chain like `2^2^2^2^...` recurses through
        # `_parse_power` <-> `_parse_unary_minus` (its exponent branch) and
        # never passes through `_parse_expr` either.
        with self._guard_depth():
            left = self._parse_not()
            if self._check_op("^"):
                self._advance()
                right = self._parse_unary_minus()  # see _parse_unary_minus docstring
                left = A.Binary(left.pos, "^", left, right)
            return left

    def _parse_not(self) -> A.Node:  # precedence 9, prefix, right-assoc
        # Brief §0 ruling: `not`/`!` bind tighter than unary `-` (research's
        # published table places `not` at 9, above `^`'s 8, but never mentions
        # unary minus at all — 8.5 is the brief's own insertion). Required
        # test: `not a and b` parses as `(not a) and b`.
        #
        # Guarded: a chain like `not not not not ... x` recurses through this
        # function alone, same reasoning as `_parse_unary_minus` above.
        with self._guard_depth():
            if self._check_op("!") or self._check_word(_WORD_NOT):
                tok = self._advance()
                operand = self._parse_not()
                return A.Unary(tok.pos, "not", operand)
            return self._parse_postfix()

    # -- precedence 10: grouping, postfix `.method(...)`, call -----------------

    def _parse_postfix(self) -> A.Node:
        node = self._parse_primary()
        while self._peek().kind == TokenKind.DOT:
            self._advance()
            node = self._parse_dot_access(node)
        return node

    def _parse_dot_access(self, receiver: A.Node) -> A.Node:
        """`receiver.` has just been consumed; parse whatever follows a dot.

        Two documented shapes (research §2.5, §2.6 form 3):
          - `receiver.f(a, b)` — a method call, kept as its own `MethodCall`
            node (never rewritten to `Call`; see ast.MethodCall's docstring).
          - `receiver.Status` / `current.Status` — a *bare* property name, no
            call parens, read off `receiver` (a `Page`-typed value in every
            documented example).

        The bare form is not walked through anywhere in research or the brief
        as explicitly as the primary-position bare-token case is (module
        docstring above) — it is flagged here in this task's report as a
        decision made rather than found. The resolution mirrors the
        primary-position one for consistency, since it is the same underlying
        ambiguity (a run of `IDENT` tokens with no distinguishing syntax) at a
        different grammar position:
          - Greedily collect a run of adjacent `IDENT` tokens after the dot.
          - If the run is immediately followed by `(`: it must be a single
            word (no documented function/method name is multi-word) and
            becomes a normal `MethodCall(receiver, name, args)`.
          - Otherwise (no call parens): if the joined run matches a known
            property name, desugar to `MethodCall(receiver, "prop",
            [Literal(name)])` — reusing the *already-documented* equivalence
            research §2.6 states outright (`current.Status` and
            `page.prop("Created By")` are listed side by side as two spellings
            of the same operation), rather than inventing a new AST shape for
            it.
          - A single identifier that does not match a known property becomes a
            zero-argument `MethodCall(receiver, name, [])` — plausibly a
            builtin with no required arguments; left for the type checker to
            accept or reject, exactly as this parser leaves builtin-arity
            checking to later tasks everywhere else.
          - A multi-word run that does not match a known property is a syntax
            error, symmetric with the primary-position rule: with no schema
            match, there is no non-guessing way to know where one bare name
            ends and the next expression begins.
        """
        if self._peek().kind != TokenKind.IDENT:
            raise self._error("expected a property or method name after '.'")
        run = self._collect_ident_run()
        joined = " ".join(t.value for t in run)
        if self._peek().kind == TokenKind.LPAREN:
            if len(run) != 1:
                raise self._error(
                    f"{joined!r} is not a valid method name before '(' "
                    "(no documented function name contains spaces)",
                    run[0],
                )
            args = self._parse_call_args()
            return A.MethodCall(receiver.pos, receiver, run[0].value, args)
        if joined in self.property_names:
            return A.MethodCall(
                receiver.pos, receiver, "prop", [A.Literal(run[0].pos, joined)]
            )
        if len(run) == 1:
            return A.MethodCall(receiver.pos, receiver, run[0].value, [])
        raise self._error(
            f"{joined!r} after '.' does not match any known property "
            "(pass property_names to resolve bare multi-word property "
            "references)",
            run[0],
        )

    def _collect_ident_run(self) -> list[Token]:
        """Collect a run of adjacent `IDENT` tokens for bare-token property
        resolution (see this module's docstring). The first token is always
        taken unconditionally (callers only invoke this once positioned on a
        genuine `IDENT`); tokens after that stop the run if they are one of
        the case-insensitive logical-keyword spellings (`and`/`or`/`not`) or
        an exact-case `true`/`false` — those are always operators/literals in
        this grammar, never a continuation of a bare property name, and must
        not be silently absorbed into one.

        Bug found while smoke-testing this task: without this guard,
        `not a and b` mis-parsed, because after `not` is consumed the operand
        parse reaches `a` and then greedily swallows `and b` too (the lexer
        emits `and` as a plain `IDENT`, indistinguishable from a property-name
        word without this check), producing a syntax error instead of
        `(not a) and b`. This does mean a property genuinely named e.g.
        `Start and End` cannot be referenced as a bare token (only via
        `prop("Start and End")`, which does not go through this path) — an
        acceptable, inherent trade-off of case-insensitive word operators
        sharing the `IDENT` token kind with property names, not something a
        context-free lexer/parser pair can fully resolve.
        """
        run = [self._advance()]
        while self._peek().kind == TokenKind.IDENT and not self._is_reserved_word(
            self._peek()
        ):
            run.append(self._advance())
        return run

    @staticmethod
    def _is_reserved_word(tok: Token) -> bool:
        return tok.value.lower() in (_WORD_AND, _WORD_OR, _WORD_NOT) or tok.value in (
            "true",
            "false",
        )

    def _parse_call_args(self) -> list[A.Node]:
        self._expect(TokenKind.LPAREN, "expected '(' to start argument list")
        args: list[A.Node] = []
        if self._peek().kind != TokenKind.RPAREN:
            args.append(self._parse_expr())
            while self._peek().kind == TokenKind.COMMA:
                self._advance()
                args.append(self._parse_expr())
        self._expect(TokenKind.RPAREN, "expected ')' to close argument list")
        return args

    # -- primary ----------------------------------------------------------------

    def _parse_primary(self) -> A.Node:
        tok = self._peek()
        if tok.kind == TokenKind.NUMBER:
            self._advance()
            return A.Literal(tok.pos, tok.value)
        if tok.kind == TokenKind.STRING:
            self._advance()
            return A.Literal(tok.pos, tok.value)
        if tok.kind == TokenKind.LPAREN:
            self._advance()
            inner = self._parse_expr()
            self._expect(TokenKind.RPAREN, "expected ')' to close '('")
            return inner
        if tok.kind == TokenKind.LBRACKET:
            return self._parse_list_literal()
        if tok.kind == TokenKind.IDENT:
            return self._parse_bare_ident()
        raise self._error(f"unexpected token {tok.value!r}")

    def _parse_list_literal(self) -> A.Node:
        start = self._advance()  # '['
        items: list[A.Node] = []
        if self._peek().kind != TokenKind.RBRACKET:
            items.append(self._parse_expr())
            while self._peek().kind == TokenKind.COMMA:
                self._advance()
                items.append(self._parse_expr())
        self._expect(TokenKind.RBRACKET, "expected ']' to close list literal")
        return A.ListLiteral(start.pos, items)

    def _parse_bare_ident(self) -> A.Node:
        tok = self._peek()
        text = tok.value
        # `true`/`false` only in exactly this case — brief §0 ruling, see the
        # module-level `_WORD_*` comment.
        if text == "true":
            self._advance()
            return A.Literal(tok.pos, True)
        if text == "false":
            self._advance()
            return A.Literal(tok.pos, False)
        if self._peek_next().kind == TokenKind.LPAREN:
            self._advance()
            args = self._parse_call_args()
            return self._normalize_call(text, args, tok.pos)
        # Bare-token property/variable resolution — see this module's
        # docstring. Greedily join a run of adjacent IDENTs and resolve
        # against `property_names`; brief §1.2's exact ruling.
        run = self._collect_ident_run()
        joined = " ".join(t.value for t in run)
        if joined in self.property_names:
            return A.PropertyRef(run[0].pos, joined)
        if len(run) == 1:
            return A.Variable(run[0].pos, run[0].value)
        raise self._error(
            f"{joined!r} does not match any known property "
            "(pass property_names to resolve bare multi-word property "
            "references)",
            run[0],
        )

    # -- call-site normalisation: if/ternary -> Conditional, let/lets -> Let ---

    def _normalize_call(self, name: str, args: list[A.Node], pos: int) -> A.Node:
        if name == "if" and len(args) == 3:
            return A.Conditional(pos, args[0], args[1], args[2])
            # `if` with any arity other than 3 is left as a plain `Call` —
            # not in the brief verbatim, decided here: a 2-arg or 5-arg
            # `if(...)` has no well-formed `Conditional` shape to normalise
            # into, so it is left for the type checker to reject with the
            # same "wrong argument count" handling it already owns for every
            # other builtin (including `ifs`, per brief §3's explicit
            # division of labour: "the parser accepts any argument count and
            # the type checker enforces the shape").
        if name in ("let", "lets"):
            return self._build_let(args, pos)
            # `ifs` deliberately stays a plain `Call("ifs", args)` — brief §3:
            # "the parser accepts any argument count and the type checker
            # enforces the shape" (N condition/value pairs + one default is a
            # variable-arity shape `ast.Conditional`'s fixed 3 slots cannot
            # represent).
        return A.Call(pos, name, args)

    def _build_let(self, args: list[A.Node], pos: int) -> A.Node:
        # `let` gained multi-binding in April 2025 and `lets` is documented as
        # its alias (research §2.4) — both normalise to the same `Let` node
        # here so no downstream visitor needs to know which spelling was used.
        if len(args) % 2 == 0:
            # Points at the `let`/`lets` keyword itself — by this point the
            # whole call (through its closing `)`) has already been consumed,
            # so the current stream position is no longer useful.
            raise self._error_at_pos(
                "let() needs a final expression after its bindings", pos
            )
        bindings: list[tuple[str, A.Node]] = []
        for idx in range(0, len(args) - 1, 2):
            name_node = args[idx]
            if not isinstance(name_node, A.Variable):
                raise self._error_at_pos(
                    "let() binding name must be a plain identifier, "
                    f"not {type(name_node).__name__}",
                    name_node.pos,
                )
            bindings.append((name_node.name, args[idx + 1]))
        body = args[-1]
        return A.Let(pos, bindings, body)


def parse(source: str, *, property_names: Iterable[str] = ()) -> A.Node:
    """Parse `source` into an AST. `property_names` is the data source's real
    property-name set, used only to resolve bare (non-`prop(...)`) property
    references — see this module's docstring. Raises `FormulaSyntaxError` for
    any malformed input and nothing else; a bare `IndexError`/`RecursionError`
    escaping this function would surface as an HTTP 500 at a later task's
    `/db/formulas/validate` endpoint instead of a 400.
    """
    tokens = tokenize(source)
    parser = _Parser(tokens, frozenset(property_names))
    # See MAX_PARSE_DEPTH's comment: the depth guard exists specifically so a
    # deeply nested formula fails with our own FormulaSyntaxError rather than
    # Python's RecursionError, but that only holds if the *interpreter's* own
    # recursion limit is not reached first — this grammar's chain of
    # precedence levels costs several Python stack frames per unit of
    # `MAX_PARSE_DEPTH`, so the default limit (1000) is not enough headroom
    # for MAX_PARSE_DEPTH=200 to ever actually fire. Raised only for the
    # duration of this call and restored after, regardless of outcome.
    old_limit = sys.getrecursionlimit()
    sys.setrecursionlimit(max(old_limit, 10_000))
    try:
        node = parser._parse_expr()
        if parser._peek().kind != TokenKind.EOF:
            raise parser._error(
                f"unexpected trailing input starting at {parser._peek().value!r}"
            )
        return node
    finally:
        sys.setrecursionlimit(old_limit)
