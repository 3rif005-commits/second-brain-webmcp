"""PDF element extraction — PyMuPDF only (no ML; runs in ms on CPU).

extract_pdf(path) → {
  "page_count": int,
  "page_sizes": [[w, h], ...],            # PDF points, per page
  "pages_text": ["[page 1]\\n...", ...],  # page-tagged text for summarization
  "elements": [                           # selectable viewer elements
     {"page": 1-based, "element_type": "text|heading|image|table|formula",
      "order_index": int, "bbox": [x0,y0,x1,y1], "content": str|None,
      "image_bytes": bytes|None}
  ],
}

Heuristics:
- headings: span size ≥ 1.35 × page median font size
- tables:   page.find_tables() (lines strategy) → markdown content + bbox
- images:   page image xrefs → PNG bytes + bbox
- formulas: blocks dominated by math fonts (CMMI/CMSY/CMEX/*Math*/Symbol) or
            high math-symbol density → rendered PNG crop for vision OCR
"""
from __future__ import annotations

import re
import statistics

_MATH_FONT = re.compile(r"cmmi|cmsy|cmex|math|symbol|msam|msbm", re.I)
_MATH_CHARS = set("∫∑∏√∞≈≠≤≥±×÷∂∇∈∉⊂⊃∪∩→⇒⇔αβγδεζηθλμπρστφχψωΩΔΣΠ")


def _math_density(text: str) -> float:
    if not text:
        return 0.0
    hits = sum(1 for ch in text if ch in _MATH_CHARS)
    return hits / len(text)


def extract_pdf(path: str, max_pages: int = 300) -> dict:
    import fitz  # pymupdf

    doc = fitz.open(path)
    page_count = min(doc.page_count, max_pages)

    pages_text: list[str] = []
    page_sizes: list[list[float]] = []
    elements: list[dict] = []

    # Document-wide body font size — per-page medians are skewed on sparse
    # pages (a title page's median IS the title size), so headings there
    # would never clear the threshold.
    all_sizes = [
        span["size"]
        for pno in range(page_count)
        for block in doc[pno].get_text("dict").get("blocks", [])
        if block.get("type") == 0
        for line in block.get("lines", [])
        for span in line.get("spans", [])
    ]
    doc_median = statistics.median(all_sizes) if all_sizes else 10.0

    for pno in range(page_count):
        page = doc[pno]
        page_sizes.append([page.rect.width, page.rect.height])
        order = 0

        # ---- tables first (so their regions can be excluded from text blocks)
        table_rects = []
        try:
            tabs = page.find_tables()
            for t in tabs.tables:
                bbox = list(t.bbox)
                table_rects.append(fitz.Rect(bbox))
                try:
                    md = t.to_markdown()
                except Exception:
                    md = ""
                elements.append({
                    "page": pno + 1, "element_type": "table", "order_index": order,
                    "bbox": bbox, "content": md, "image_bytes": None,
                })
                order += 1
        except Exception:
            pass

        # ---- images
        try:
            for img in page.get_images(full=True):
                xref = img[0]
                try:
                    rects = page.get_image_rects(xref)
                    if not rects:
                        continue
                    r = rects[0]
                    if r.width < 24 or r.height < 24:
                        continue  # skip decorative specks
                    pix = fitz.Pixmap(doc, xref)
                    if pix.n - pix.alpha > 3:
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    elements.append({
                        "page": pno + 1, "element_type": "image", "order_index": order,
                        "bbox": [r.x0, r.y0, r.x1, r.y1], "content": None,
                        "image_bytes": pix.tobytes("png"),
                    })
                    order += 1
                except Exception:
                    continue
        except Exception:
            pass

        # ---- text blocks (dict mode: bbox + font info per span)
        d = page.get_text("dict")
        median_size = doc_median

        page_lines: list[str] = []
        for block in d.get("blocks", []):
            if block.get("type") != 0:
                continue
            bbox = list(block["bbox"])
            brect = fitz.Rect(bbox)
            if any(brect.intersects(tr) for tr in table_rects):
                continue  # covered by a table element

            spans = [s for line in block.get("lines", []) for s in line.get("spans", [])]
            text = " ".join(s["text"] for s in spans).strip()
            if not text:
                continue
            page_lines.append(text)

            math_fonts = sum(1 for s in spans if _MATH_FONT.search(s.get("font", "")))
            is_formula = (
                (math_fonts / max(len(spans), 1) > 0.4)
                or _math_density(text) > 0.15
            )
            max_size = max((s["size"] for s in spans), default=median_size)
            is_heading = (not is_formula) and max_size >= median_size * 1.35 and len(text) < 200

            if is_formula:
                try:
                    pix = page.get_pixmap(clip=brect, dpi=200)
                    img_bytes = pix.tobytes("png")
                except Exception:
                    img_bytes = None
                elements.append({
                    "page": pno + 1, "element_type": "formula", "order_index": order,
                    "bbox": bbox, "content": text, "image_bytes": img_bytes,
                })
            else:
                elements.append({
                    "page": pno + 1,
                    "element_type": "heading" if is_heading else "text",
                    "order_index": order,
                    "bbox": bbox, "content": text, "image_bytes": None,
                })
            order += 1

        pages_text.append(f"[page {pno + 1}]\n" + "\n".join(page_lines))

    doc.close()
    return {
        "page_count": page_count,
        "page_sizes": page_sizes,
        "pages_text": pages_text,
        "elements": elements,
    }


def chunk_pages(pages_text: list[str], max_chars: int = 1500) -> list[dict]:
    """Page-anchored chunks for grounded retrieval."""
    chunks: list[dict] = []
    idx = 0
    for pno, ptext in enumerate(pages_text, start=1):
        body = re.sub(r"^\[page \d+\]\n?", "", ptext)
        if not body.strip():
            continue
        # split long pages at paragraph boundaries
        buf = ""
        for para in body.split("\n"):
            if len(buf) + len(para) > max_chars and buf:
                chunks.append({"chunk_index": idx, "chunk_text": buf.strip(),
                               "anchor_type": "page", "anchor_start": pno, "anchor_end": pno})
                idx += 1
                buf = ""
            buf += para + "\n"
        if buf.strip():
            chunks.append({"chunk_index": idx, "chunk_text": buf.strip(),
                           "anchor_type": "page", "anchor_start": pno, "anchor_end": pno})
            idx += 1
    return chunks
