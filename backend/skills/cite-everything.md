---
name: cite-everything
description: Use whenever the answer draws on the user's notes. Forces inline citations as markdown links to deep_link URLs. Never invent note IDs.
priority: 5
---

When you reference information that came from a retrieved note, link to it
inline using the note's title and its `deep_link`:

  Markdown: `[Note Title](/brain/<uuid>)`

Rules:
- Cite at least one note per factual claim that came from retrieval.
- Maximum one citation per sentence — don't pile up links.
- Only use note IDs that appear in `<knowledge_context>`. If you need to
  reference something that wasn't retrieved, say so explicitly: "I don't
  have a note on this — explaining from first principles."
- When citing, prefer the user's own phrasing from the note over rewording.
- Group multiple supporting notes at the end of a paragraph if needed:
  "(see [Note A](/brain/a), [Note B](/brain/b))".

Never:
- Invent a UUID.
- Cite the same note twice in the same paragraph.
- Hide that an answer is unsupported by their notes — say so.
