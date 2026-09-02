"""Website resource extraction — trafilatura rich extraction into sections.

extract_website(url) → {
  "title": str,
  "meta": {author, thumbnail?},
  "sections": [{"index": int, "kind": "text"|"heading"|"image",
                "content": str,        # text, or image URL for kind=image
               }],
  "tagged_text": str,  # "[section N]" tagged text for summarization
}
"""
from __future__ import annotations

import trafilatura


def extract_website(url: str) -> dict:
    downloaded = trafilatura.fetch_url(url)
    if not downloaded:
        raise ValueError(f"Could not fetch URL: {url}")

    doc = trafilatura.bare_extraction(
        downloaded,
        include_images=True,
        include_formatting=True,
        include_links=False,
        include_tables=True,
        with_metadata=True,
    )
    if doc is None:
        raise ValueError("Could not extract readable content from the page.")

    # trafilatura ≥2.0 returns a Document object; older returns dict
    get = (lambda k: getattr(doc, k, None)) if not isinstance(doc, dict) else doc.get
    title = get("title") or url
    text = get("text") or ""
    if not text.strip():
        raise ValueError("Page had no readable text.")

    meta = {"author": get("author"), "thumbnail": get("image")}

    sections: list[dict] = []
    idx = 0
    for para in text.split("\n"):
        para = para.strip()
        if not para:
            continue
        if para.startswith("!["):  # markdown image from include_images
            src = para[para.find("(") + 1: para.rfind(")")] if "(" in para else ""
            if src:
                sections.append({"index": idx, "kind": "image", "content": src})
                idx += 1
            continue
        kind = "heading" if (para.startswith("#") and len(para) < 200) else "text"
        sections.append({"index": idx, "kind": kind, "content": para.lstrip("# ").strip()
                         if kind == "heading" else para})
        idx += 1

    tagged = "\n".join(
        f"[section {s['index']}] {s['content']}"
        for s in sections if s["kind"] != "image"
    )
    return {"title": title, "meta": meta, "sections": sections, "tagged_text": tagged}


def chunk_sections(sections: list[dict], max_chars: int = 1500) -> list[dict]:
    """Section-anchored chunks for grounded retrieval."""
    chunks: list[dict] = []
    idx = 0
    buf = ""
    start = 0
    last = 0
    for s in sections:
        if s["kind"] == "image":
            continue
        if not buf:
            start = s["index"]
        buf += s["content"] + "\n"
        last = s["index"]
        if len(buf) >= max_chars:
            chunks.append({"chunk_index": idx, "chunk_text": buf.strip(),
                           "anchor_type": "section",
                           "anchor_start": start, "anchor_end": last})
            idx += 1
            buf = ""
    if buf.strip():
        chunks.append({"chunk_index": idx, "chunk_text": buf.strip(),
                       "anchor_type": "section",
                       "anchor_start": start, "anchor_end": last})
    return chunks
