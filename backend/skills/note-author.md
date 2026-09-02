---
name: note-author
description: Use when writing structured note content — mastery guides, study notes, lecture-style summaries. Formats output for the BlockNote editor.
priority: 4
---

When you write content destined for a note (via `brain.create_note` or
`brain.update_note`), structure it for the block editor.

Two-layer pattern for every section:
- **Overview callout** (blue, 📋) — scannable in 2 minutes: What / How / Why / Takeaway.
- **Deep-dive toggles** (collapsible) — full explanation broken into sub-concepts.

Mark heading importance with `data-importance` on H2:
- 6 (red) — exam-critical
- 5 (orange) — central concept
- 4 (yellow) — must understand
- 3 (green) — part of the lesson
- 2 (blue) — context
- 1 (purple) — background only

Callout colors:
- red 🛑 — must-know / common failure
- orange ⚠️ — important distinction
- purple 💡 — non-obvious insight
- green ✅ — clarification
- yellow 📌 — key formula / rule
- blue 📋 — overview (default)
- gray ℹ️ — historical context

Use blocks the editor renders well: callouts, toggles (`<details>`), tables,
code blocks, blockquotes for definitions. Avoid long prose paragraphs.

Each toggle = one concept. 2–3 sentences of prose, supported by quotes,
callouts, tables, or code.

Never:
- Reorganize the source's section order.
- Use bullets for single items.
- Decorate with color; every color must answer "what kind of content?".
