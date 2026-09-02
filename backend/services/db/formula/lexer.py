"""Hand-written scanner for the formula language: source text -> token stream.

Spec: docs/superpowers/specs/2026-08-08-notion-databases-design.md §7.1-7.2.
Research: docs/research/notion-databases-research.md §H.1-H.2.12.

This module does no schema resolution and no keyword classification beyond the
symbolic operators/punctuation. Word-like text (`and`, `not`, `true`, `if`, a
property name, a variable name — all of it) comes out as a plain `IDENT` token;
`parser.py` is the only place that decides what an identifier *means*, because that
decision needs the caller-supplied property-name set (see parser.py's module
docstring) and word-keyword case rules the lexer has no business owning.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, auto


class FormulaSyntaxError(Exception):
    """Raised by both the lexer and the parser for any malformed formula. Carries a
    0-based character offset plus 1-based line/col so a formula editor (a later
    task's `/db/formulas/validate` endpoint) can underline the offending character.
    Never let anything else escape `lex()`/`parse()` — an uncaught `IndexError` etc.
    reaching the validate endpoint would be a 500 instead of a 400."""

    def __init__(self, message: str, pos: int, line: int, col: int):
        super().__init__(f"{message} (line {line}, col {col})")
        self.message = message
        self.pos = pos
        self.line = line
        self.col = col


class TokenKind(Enum):
    NUMBER = auto()
    STRING = auto()
    IDENT = auto()
    # Declared per this task's brief §1 token-kind list, but never emitted by this
    # lexer: per brief §1.2's ruling, bare property references are not resolved
    # lexically (a context-free lexer cannot tell `Start Date` the property from
    # two identifiers in a row). They lex as plain IDENT and are joined into a
    # `PropertyRef` AST node by the *parser*, which alone has the property-name
    # set needed to make that call. Kept in this enum only so the brief's token-kind
    # enumeration is complete and `TokenKind` is the one place both lexer and parser
    # import from.
    PROP = auto()
    OP = auto()
    LPAREN = auto()
    RPAREN = auto()
    LBRACKET = auto()
    RBRACKET = auto()
    COMMA = auto()
    QUESTION = auto()
    COLON = auto()
    DOT = auto()
    EOF = auto()


@dataclass(frozen=True)
class Token:
    kind: TokenKind
    value: object  # str for IDENT/OP/STRING, float for NUMBER, None otherwise
    pos: int  # 0-based character offset of the token's first character
    line: int  # 1-based
    col: int  # 1-based


# Longest-match-first: a prefix that is itself a valid shorter operator must come
# after any operator it is a prefix of, so the scanner's greedy scan (below) always
# tries the longest candidate first.
#
# `!==`: research §2.5 flags one official-docs example using `!==` where every other
# example uses `!=`, and explicitly says it is UNRESOLVED whether this is a real
# token or a typo, suggesting "a tolerant lexer should probably accept both."
# UNRESOLVED-in-research, decided here (not in the brief's ruling table): accept
# `!==` as a spelling of `!=` (not a distinct token) — tolerant per research's own
# suggestion, and there is no plausible alternative meaning for `!==` in this
# grammar (there is no `===`).
_OPERATORS_BY_LENGTH = [
    "!==",  # -> normalised to "!="
    "==", "!=", ">=", "<=", "&&", "||",
    "+", "-", "*", "/", "%", "^", ">", "<", "!",
]
_OPERATORS_BY_LENGTH.sort(key=len, reverse=True)

_SINGLE_CHAR_PUNCT = {
    "(": TokenKind.LPAREN,
    ")": TokenKind.RPAREN,
    "[": TokenKind.LBRACKET,
    "]": TokenKind.RBRACKET,
    ",": TokenKind.COMMA,
    "?": TokenKind.QUESTION,
    ":": TokenKind.COLON,
    ".": TokenKind.DOT,
}

_ESCAPES = {'"': '"', "\\": "\\", "n": "\n", "t": "\t"}


class _Scanner:
    def __init__(self, source: str):
        self.src = source
        self.n = len(source)
        self.i = 0
        self.line = 1
        self.col = 1

    def _advance(self) -> str:
        ch = self.src[self.i]
        self.i += 1
        if ch == "\n":
            self.line += 1
            self.col = 1
        else:
            self.col += 1
        return ch

    def _error(self, message: str, at: int | None = None, line: int | None = None,
               col: int | None = None) -> FormulaSyntaxError:
        return FormulaSyntaxError(
            message,
            pos=self.i if at is None else at,
            line=self.line if line is None else line,
            col=self.col if col is None else col,
        )

    def _skip_trivia(self) -> None:
        """Whitespace (including newlines — multi-line formulas are documented,
        research §2.7) and `/* block comments */`. Line comments (`//`) are not
        handled here.

        UNRESOLVED-in-research, decided here (not in the brief's table): research
        §2.7 flags both "does `//` exist" and "do block comments nest" as
        UNRESOLVED, with zero documented examples of either. Ruling: `/* */` only,
        non-nesting (the first `*/` closes the comment) — implementing exactly what
        is positively documented, per this task's own §0 discipline, rather than
        inventing `//` support or nesting behaviour with no source. A `//` in a
        formula is therefore just two `/` OP tokens, which fails to parse cleanly
        (a clear syntax error) rather than being silently swallowed.
        """
        while self.i < self.n:
            ch = self.src[self.i]
            if ch in " \t\r\n":
                self._advance()
                continue
            if ch == "/" and self.i + 1 < self.n and self.src[self.i + 1] == "*":
                start_pos, start_line, start_col = self.i, self.line, self.col
                self._advance()
                self._advance()
                closed = False
                while self.i < self.n:
                    if self.src[self.i] == "*" and self.i + 1 < self.n and self.src[self.i + 1] == "/":
                        self._advance()
                        self._advance()
                        closed = True
                        break
                    self._advance()
                if not closed:
                    raise self._error(
                        "unterminated comment", at=start_pos, line=start_line, col=start_col
                    )
                continue
            break

    def _read_string(self) -> Token:
        start_pos, start_line, start_col = self.i, self.line, self.col
        self._advance()  # opening quote
        chars: list[str] = []
        while True:
            if self.i >= self.n:
                raise self._error(
                    "unterminated string literal", at=start_pos, line=start_line, col=start_col
                )
            ch = self._advance()
            if ch == '"':
                break
            if ch == "\\":
                if self.i >= self.n:
                    raise self._error(
                        "unterminated string literal", at=start_pos, line=start_line, col=start_col
                    )
                esc_pos, esc_line, esc_col = self.i, self.line, self.col
                esc = self._advance()
                if esc not in _ESCAPES:
                    # research §2.8 documents exactly four escapes (\" \\ \n \t) and
                    # flags the string/regex backslash boundary as UNRESOLVED,
                    # inconsistent between its own sources (\\d vs \d).
                    # UNRESOLVED-in-research, decided here (not in the brief's
                    # table): reject any other backslash escape as a lex error
                    # rather than silently passing it through. Implementing only
                    # what is positively documented and raising a clear, located
                    # error is safer than guessing a permissive rule that could
                    # silently accept a formula whose regex-escaping behaviour we
                    # cannot verify against a live workspace.
                    raise self._error(
                        f"invalid escape sequence '\\{esc}' in string literal",
                        at=esc_pos, line=esc_line, col=esc_col,
                    )
                chars.append(_ESCAPES[esc])
                continue
            chars.append(ch)
        return Token(TokenKind.STRING, "".join(chars), start_pos, start_line, start_col)

    def _read_number(self) -> Token:
        start_pos, start_line, start_col = self.i, self.line, self.col
        while self.i < self.n and self.src[self.i].isdigit():
            self._advance()
        # research §2.9's lexing hazard: `1932.substring(0, 2)` must lex as NUMBER(1932)
        # DOT IDENT(substring), not NUMBER(1932.) DOT-less garbage. A `.` is only
        # part of the number when followed by a digit (maximal-munch on the decimal
        # part only, per the brief).
        if self.i < self.n and self.src[self.i] == "." and self.i + 1 < self.n and self.src[self.i + 1].isdigit():
            self._advance()  # the dot
            while self.i < self.n and self.src[self.i].isdigit():
                self._advance()
        text = self.src[start_pos:self.i]
        return Token(TokenKind.NUMBER, float(text), start_pos, start_line, start_col)

    def _read_ident(self) -> Token:
        start_pos, start_line, start_col = self.i, self.line, self.col
        while self.i < self.n and (self.src[self.i].isalnum() or self.src[self.i] == "_"):
            self._advance()
        text = self.src[start_pos:self.i]
        return Token(TokenKind.IDENT, text, start_pos, start_line, start_col)

    def _read_operator(self) -> Token:
        start_pos, start_line, start_col = self.i, self.line, self.col
        rest = self.src[self.i:]
        for op in _OPERATORS_BY_LENGTH:
            if rest.startswith(op):
                for _ in op:
                    self._advance()
                value = "!=" if op == "!==" else op
                return Token(TokenKind.OP, value, start_pos, start_line, start_col)
        raise self._error(f"unexpected character {rest[0]!r}", at=start_pos, line=start_line, col=start_col)

    def tokenize(self) -> list[Token]:
        tokens: list[Token] = []
        while True:
            self._skip_trivia()
            if self.i >= self.n:
                tokens.append(Token(TokenKind.EOF, None, self.i, self.line, self.col))
                return tokens
            ch = self.src[self.i]
            pos, line, col = self.i, self.line, self.col
            if ch == '"':
                tokens.append(self._read_string())
            elif ch.isdigit():
                tokens.append(self._read_number())
            elif ch.isalpha() or ch == "_":
                tokens.append(self._read_ident())
            elif ch in _SINGLE_CHAR_PUNCT:
                self._advance()
                tokens.append(Token(_SINGLE_CHAR_PUNCT[ch], ch, pos, line, col))
            else:
                tokens.append(self._read_operator())
        return tokens


def tokenize(source: str) -> list[Token]:
    """Scan `source` into a token list ending with a single `EOF` token. Raises
    `FormulaSyntaxError` (never anything else) for malformed input."""
    return _Scanner(source).tokenize()
