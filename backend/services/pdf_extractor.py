"""PDF text extraction using PyMuPDF (fitz)."""

import fitz  # pymupdf


def extract_pdf(path: str) -> str:
    """
    Extract plain text from a PDF, preserving paragraph structure.
    Returns a single string with pages separated by double newlines.
    """
    doc = fitz.open(path)
    pages: list[str] = []

    for page in doc:
        blocks = page.get_text("blocks")  # list of (x0, y0, x1, y1, text, block_no, block_type)
        text_blocks = [b[4].strip() for b in blocks if b[6] == 0 and b[4].strip()]
        if text_blocks:
            pages.append("\n\n".join(text_blocks))

    doc.close()
    return "\n\n---\n\n".join(pages)
