import secrets

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

# Fixed by a Global Constraint of the plan ("Property keys are 8-char base62,
# immutable") and by spec §4.2: 8 characters ≈ 2.2 × 10^14 keyspace, chosen
# over Notion's 4 because 4 has a plausible birthday collision within one
# large collection. Deliberately NOT a parameter — a caller-supplied length
# would let a shorter, collision-prone key into a column whose values are
# immutable for the life of the property and are baked into every row's
# JSONB and into expression-index DDL.
KEY_LENGTH = 8


def mint_key() -> str:
    """Short opaque JSONB key for a property. Immutable once assigned."""
    return "".join(secrets.choice(_ALPHABET) for _ in range(KEY_LENGTH))
