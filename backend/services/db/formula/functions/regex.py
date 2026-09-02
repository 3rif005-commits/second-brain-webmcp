"""§H.3.4 Regex (4): `test`, `match`, `replace`, `replaceAll`.

**Dialect assumption, flagged per this task's brief:** research documents
Notion's regex flavour as "ECMAScript / JavaScript `RegExp`, with no
flags" but never names the actual underlying engine. This module uses
Python's `re` module unmodified -- NOT a JS-regex-to-Python-regex
transpiler. For the documented common subset (character classes,
quantifiers, anchors, non-named groups, alternation, most lookarounds)
the two dialects agree closely enough that this is a reasonable-effort
implementation, but two concrete, real incompatibilities are called out
below rather than silently mishandled:

1. **Named capture groups**: JS spells them `(?<name>...)`; Python
   requires `(?P<name>...)`. A JS-spelled named group will fail to
   compile under Python's `re` (`re.error`), which this module turns into
   `EMPTY` (this task's general malformed-input ruling) rather than
   propagating the exception -- but the pattern simply will not work,
   which is a real, user-visible gap, not a silent one.
2. **Replacement-string substitutions**: research documents JS-style
   `$1`, `$&`, `` $` ``, `$'`, `$<name>` in the replacement argument.
   Python's `re.sub` uses a different syntax (`\\1`, `\\g<0>`, no
   direct equivalent for "everything before/after the match"). This
   module implements a best-effort translator for the two most common
   forms (`$1`-`$99` and `$&`) and leaves everything else (`` $` ``,
   `$'`, `$<name>`) as LITERAL text -- a real, documented limitation, not
   silently "handled." See `_translate_replacement`'s docstring.
"""
from __future__ import annotations

import re

from ..values import EMPTY, FValue, stringify
from . import builtin

# Denial-of-service guard (this task's brief, explicit): a user-authored
# regex evaluated over every row on a shared event loop is a real hazard
# (catastrophic backtracking). Python's stdlib `re` has no built-in
# per-call timeout, so the mitigation available without a third-party
# dependency is a hard cap on both the pattern and the subject text
# length -- oversized input is refused outright (EMPTY) rather than
# evaluated. A module constant with a comment, not a magic number, per
# the brief's explicit instruction.
_MAX_REGEX_INPUT_LENGTH = 10_000

# JS `$1`..`$99` (research §3.4's substitution list) -> Python's `\g<N>`
# backreference syntax; `$$` -> a literal `$` (JS's own escape for a
# literal dollar sign, the one point research explicitly asks "how to
# emit a literal $" and this is the one documented mechanism common to
# both dialects' `$`-substitution schemes).
_DOLLAR_GROUP_RE = re.compile(r"\$(\$|&|[1-9][0-9]?)")


def _translate_replacement(repl: str) -> str:
    """Best-effort JS -> Python replacement-string translation. Handles
    exactly `$$` (literal `$`), `$&` (whole match, -> `\\g<0>`), and
    `$1`-`$99` (numbered group, -> `\\g<N>`). Everything else --
    `` $` ``/`$'` (JS "everything before/after the match", which `re.sub`
    has no equivalent for without a custom replacement function) and
    `$<name>` (named-group substitution, which WOULD need the pattern's
    own named groups to resolve) -- is left untranslated, i.e. passed
    through as literal text. Research's own `UNRESOLVED:` on this exact
    point ("whether replace/replaceAll treat the replacement string's $
    specially in ALL positions") means there is no documented spec to
    implement more of; going further than the two unambiguous cases would
    be guessing at syntax this module cannot verify against a live
    workspace."""

    def _sub(m: re.Match[str]) -> str:
        token = m.group(1)
        if token == "$":
            return "$"
        if token == "&":
            return "\\g<0>"
        return f"\\g<{token}>"

    return _DOLLAR_GROUP_RE.sub(_sub, repl)


def _as_text(v: FValue) -> str | None:
    """research §1.8: "replace, replaceAll, and test auto-convert Numbers
    and Booleans (but NOT Dates) to strings." Extended here to `match` too
    (not separately named by research, but there is no principled reason
    one of the four regex functions would coerce and its siblings
    wouldn't -- a judgment call, flagged in this task's report). A `Date`
    value deliberately does NOT coerce (returns `None` -> `EMPTY`),
    matching the explicit "but not Dates" carve-out -- though nothing in
    this task's four categories can construct a Date value to exercise
    that branch (Task 26's territory; forward-compatible placeholder)."""
    if isinstance(v, str):
        return v
    if isinstance(v, (float, bool)):
        return stringify(v)
    return None


def _compile(pattern: str) -> re.Pattern[str] | None:
    if len(pattern) > _MAX_REGEX_INPUT_LENGTH:
        return None
    try:
        return re.compile(pattern)
    except re.error:
        return None


@builtin("test")
def _test(args: list[FValue]) -> FValue:
    text = _as_text(args[0])
    pattern = _as_text(args[1])
    if text is None or pattern is None or len(text) > _MAX_REGEX_INPUT_LENGTH:
        return EMPTY
    compiled = _compile(pattern)
    if compiled is None:
        return EMPTY
    return compiled.search(text) is not None


@builtin("match")
def _match(args: list[FValue]) -> FValue:
    """`match(Text, Text)` -> **all** matches as a list (research,
    official example: `match("Notion 123 Notion 456", "\\\\d+") ==
    ["123", "456"]`). Research flags `UNRESOLVED:` whether a pattern WITH
    capture groups returns full matches or the groups themselves --
    decided here: always the full match text (`m.group(0)`), never a
    group, since that is what the one documented example needs and
    Python's `re.findall` would instead silently switch to returning
    GROUPS the moment a pattern has any `(...)`, which is exactly the
    ambiguity research flags and declines to resolve; using
    `finditer`+`group(0)` sidesteps that ambiguity entirely rather than
    picking a guessed answer to it."""
    text = _as_text(args[0])
    pattern = _as_text(args[1])
    if text is None or pattern is None or len(text) > _MAX_REGEX_INPUT_LENGTH:
        return EMPTY
    compiled = _compile(pattern)
    if compiled is None:
        return EMPTY
    return [m.group(0) for m in compiled.finditer(text)]


@builtin("replace")
def _replace(args: list[FValue]) -> FValue:
    text = _as_text(args[0])
    pattern = _as_text(args[1])
    repl = _as_text(args[2])
    if text is None or pattern is None or repl is None or len(text) > _MAX_REGEX_INPUT_LENGTH:
        return EMPTY
    compiled = _compile(pattern)
    if compiled is None:
        return EMPTY
    try:
        return compiled.sub(_translate_replacement(repl), text, count=1)
    except re.error:
        return EMPTY  # malformed backreference etc. -- never raise


@builtin("replaceAll")
def _replace_all(args: list[FValue]) -> FValue:
    text = _as_text(args[0])
    pattern = _as_text(args[1])
    repl = _as_text(args[2])
    if text is None or pattern is None or repl is None or len(text) > _MAX_REGEX_INPUT_LENGTH:
        return EMPTY
    compiled = _compile(pattern)
    if compiled is None:
        return EMPTY
    try:
        return compiled.sub(_translate_replacement(repl), text)
    except re.error:
        return EMPTY
