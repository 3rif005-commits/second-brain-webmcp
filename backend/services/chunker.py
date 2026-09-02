"""Split note content_text into overlapping chunks for fine-grained retrieval."""


def split(text: str, max_words: int = 150) -> list[dict]:
    """Split plain text into chunks of ~max_words words.

    Strategy: split on blank lines (paragraphs), accumulate until the word
    budget is hit, then start a new chunk — keeping the last paragraph as
    overlap so context isn't lost at boundaries.

    Returns a list of {"chunk_index": int, "chunk_text": str}.
    """
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        return []

    chunks: list[str] = []
    current: list[str] = []
    current_words = 0

    for para in paragraphs:
        words = len(para.split())
        if current_words + words > max_words and current:
            chunks.append("\n\n".join(current))
            # Carry last paragraph forward as overlap
            current = [current[-1]]
            current_words = len(current[0].split())
        current.append(para)
        current_words += words

    if current:
        chunks.append("\n\n".join(current))

    return [{"chunk_index": i, "chunk_text": c} for i, c in enumerate(chunks)]
