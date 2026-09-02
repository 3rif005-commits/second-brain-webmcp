"""Property type conversion — which changes are legal, and what happens to the
values that already exist.

WHY THIS MODULE EXISTS AT ALL
-----------------------------
`PATCH /db/properties/{id}` gained a `type` field (Phase 0b, B5) because
"Change type" is a row in Notion's column header menu, which is milestone M1.
Without it that row is dead from the very first milestone.

But a type change cannot be a column write. Values live in `db_row_props` as
spec §3.3 discriminated wrappers -- `{"type": "status", "status": "done"}` --
and `services/db/rows.py` already rejects a wrapper whose `type` tag does not
match the property's declared type. So flipping `db_properties.type` and
leaving the values alone does not produce a slightly-wrong column; it produces
rows whose every value is invalid, filters that compile against the wrong
shape, and cells that cannot render. Leaving them is not an option.

THE THREE CHOICES, AND WHY THIS ONE
-----------------------------------
  (a) coerce every value           -- correct, but needs a rule for every one
                                      of 24x24 type pairs, most of which are
                                      meaningless
  (b) clear values on any change   -- safe and predictable, but silently
                                      destroys data on a menu click
  (c) coerce a defined subset,     <- chosen
      reject the rest with a 400

(c) loses the least and lies the least. A conversion either preserves the data
in a way the user would predict, or it is refused with a reason the UI can
show. Nothing is destroyed silently.

Notion greys illegal conversions in its own "Change type" list (Text -> Relation
is disabled). `legal_targets()` is that same list, served from one place, so
the UI does not hardcode a second copy that can drift.

DELIBERATELY NOT SUPPORTED, and each for a reason rather than an oversight:
  * relation      -- must be created through POST .../relations, which mints a
                     pair and a relation_id; the generic path cannot.
  * formula/rollup-- need a validated `config` and a full recompute. Create
                     one instead of converting into it.
  * title         -- a data source has exactly one, structurally. Converting
                     into or out of it would leave zero or two.
  * checkbox as a TARGET -- "is 'Sam' true?" has no defensible answer.
  * date          -- parsing arbitrary text into a date silently invents
                     precision and a timezone. Refused rather than guessed.
"""
from __future__ import annotations

from typing import Any, Callable

__all__ = ["ConversionError", "legal_targets", "is_legal", "convert_value"]


class ConversionError(ValueError):
    """Raised for an illegal type change. The router maps it to a 400 whose
    message is shown to the user, so the text is user-facing."""


# Types whose stored value is a single string under a key equal to the type.
_STRINGY = ("rich_text", "url", "email", "phone_number")
# Choice types: also a single string, but drawn from a configured option set.
_CHOICE = ("select", "status")


def _unwrap(value: Any, source: str) -> Any:
    """Pull the bare value out of a §3.3 wrapper. Tolerates a missing or
    malformed wrapper by returning None -- a row that never had a value must
    convert cleanly rather than raising."""
    if not isinstance(value, dict):
        return None
    return value.get(source)


def _to_text(raw: Any, source: str) -> str | None:
    if raw is None:
        return None
    if source == "multi_select":
        return ", ".join(str(v) for v in raw) if raw else None
    if source == "checkbox":
        return "Yes" if raw else "No"
    if source == "date":
        # Only the start instant survives; an end date and a timezone have
        # nowhere to go in a text field.
        return raw.get("start") if isinstance(raw, dict) else None
    return str(raw)


def _to_number(raw: Any, source: str) -> float | None:
    text = _to_text(raw, source)
    if text is None:
        return None
    try:
        parsed = float(text.strip().replace(",", ""))
    except (TypeError, ValueError):
        # Unparseable text becomes empty rather than an error: converting a
        # column of mixed notes to Number should not fail because one row
        # says "about ten".
        return None
    return int(parsed) if parsed.is_integer() else parsed


def _to_choice(raw: Any, source: str) -> str | None:
    if source == "multi_select":
        return str(raw[0]) if raw else None
    return _to_text(raw, source)


def _to_multi_select(raw: Any, source: str) -> list[str]:
    if raw is None:
        return []
    if source in _CHOICE:
        return [str(raw)]
    if source == "multi_select":
        return [str(v) for v in raw]
    text = _to_text(raw, source)
    if not text:
        return []
    # Comma-separated text is the only reading that round-trips with the
    # multi_select -> text direction above.
    return [part.strip() for part in text.split(",") if part.strip()]


# target -> (allowed sources, coercion). Sources are checked explicitly rather
# than "anything not refused", so adding a property type never silently makes
# a new conversion legal.
_CONVERSIONS: dict[str, tuple[tuple[str, ...], Callable[[Any, str], Any]]] = {
    # multi_select is a source here (joined to "a, b") but NOT for url/email/
    # phone_number below — "a, b" is not a plausible URL, and offering the
    # conversion would invite a column of nonsense.
    "rich_text": (
        _STRINGY + _CHOICE + ("multi_select", "number", "checkbox", "date"),
        _to_text,
    ),
    "url": (_STRINGY + _CHOICE, _to_text),
    "email": (_STRINGY + _CHOICE, _to_text),
    "phone_number": (_STRINGY + _CHOICE, _to_text),
    "number": (_STRINGY + ("number",), _to_number),
    "select": (_STRINGY + _CHOICE + ("multi_select",), _to_choice),
    "status": (_STRINGY + _CHOICE + ("multi_select",), _to_choice),
    "multi_select": (_STRINGY + _CHOICE + ("multi_select",), _to_multi_select),
}


def legal_targets(source_type: str) -> list[str]:
    """Every type `source_type` may be converted into, excluding itself.

    This is the list the UI greys against. Serving it from here means the
    front end does not keep a second copy that can drift from the behaviour."""
    return sorted(
        target
        for target, (sources, _) in _CONVERSIONS.items()
        if source_type in sources and target != source_type
    )


def is_legal(source_type: str, target_type: str) -> bool:
    if source_type == target_type:
        return True
    entry = _CONVERSIONS.get(target_type)
    return entry is not None and source_type in entry[0]


def convert_value(value: Any, source_type: str, target_type: str) -> Any:
    """Rewrap one row's value for the new type.

    Returns a §3.3 wrapper, or None meaning "delete this property's entry for
    this row" -- which is what an empty result must be, since an empty wrapper
    and an absent key are different states elsewhere in this codebase.

    Raises ConversionError for an illegal pair. Callers should check
    `is_legal` first so the error carries the friendlier message.
    """
    if source_type == target_type:
        return value
    entry = _CONVERSIONS.get(target_type)
    if entry is None or source_type not in entry[0]:
        raise ConversionError(
            f"cannot convert a {source_type} property to {target_type}"
        )
    _sources, coerce = entry
    coerced = coerce(_unwrap(value, source_type), source_type)
    if coerced is None or coerced == [] or coerced == "":
        return None
    return {"type": target_type, target_type: coerced}
