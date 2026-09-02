# Devpost submission text

_Paste into the project description. The four headings map to the four things
the rules ask a submission to explain._

---

## Second Brain — a knowledge app that renders itself twice

A web app has exactly one representation: pixels. Everything it knows is encoded
into a visual layout, and to act on it an agent has to decode that layout back
into intent — screenshot, guess a coordinate, click, screenshot again to find out
what happened.

Second Brain is a personal knowledge OS: notes with a block editor, and a
Notion-parity database module with ten view types, filters, grouping, formulas,
rollups and automations. This submission gives it a second rendering. Same state,
same capabilities, expressed as typed text through WebMCP instead of as pixels.
Not a second app — a second renderer.

### Why this is a WebMCP problem, not a backend-API problem

Most of what makes a database view useful lives in the browser and nowhere else:
which view is active, what filters are applied, what grouping is in force, and
therefore which rows are actually on screen. A server-side integration cannot
read any of it, and — more importantly — cannot *change* it. It can compute an
answer and hand it back as text, leaving the user's screen exactly as it was.

That is the gap WebMCP closes. When the agent groups the board by status, the
board regroups in front of the user. When it filters, the grid changes. The tool
runs in the page's own execution context, calling the same functions a click
calls.

### What the user experience gains

- **Tools are generated from the live schema.** Opening a database registers
  tools built from *that* database's properties, so `create-row` advertises
  `Status` with its four real options and `Rating` with its real bounds. The
  model cannot name a property or pick an option that doesn't exist. Opening a
  different database swaps the entire set and fires `toolchange`.
- **The agent's capabilities follow the user's attention.** Tools are scoped to
  the surface on screen and unregistered on navigate, rather than registering
  every capability in the product and flooding the model's context.
- **Agent edits behave like human edits.** Writes go through the same
  `updateCell` / `updateView` functions the UI calls, so optimistic updates,
  rollback on failure and toast notifications are identical whether a person or
  an agent made the change. There is no second write path to keep in sync.

### How humans and agents share the environment

This is the part I found most interesting to build. The app encodes a lot of
meaning in visual channels: a callout's semantic type (`EXAM`, `CAUTION`,
`FORMULA`, …) reaches the reader as a coloured box with an icon; a section's
importance as a 0-to-6 background tint; a row's group as a horizontal column
position. All of that is real information, and all of it is what an agent working
from a screenshot loses.

So there is a projection layer — the counterpart to the React components. Where a
component picks a colour, the projection names what the colour stands for:
`callout EXAM — "Exam", shown to the reader as a pink box with 🎯`, or
`importance 5 of 6 (near-critical)`. Humans get the visual channel, which is
faster for them. Models get the text, which is lossless for them. Neither is
translating from the other's medium, and neither holds a stale copy.

### How it's built

Five modules and a single wiring point:

| | |
|---|---|
| `lib/webmcp/registry.ts` | The only file that touches the browser API. Keeps its own registry so the surface works where WebMCP doesn't exist, mirrors to `document.modelContext` where it does, and routes every call — from the browser's agent or from the page's own — through one execute path. Feature-detects both `document.modelContext` and the earlier `navigator.modelContext`. |
| `lib/webmcp/useWebMcpTools.ts` | React binding. Registration is keyed on tool *names* while implementations resolve late from a ref, so tools always act on current state but `toolchange` fires only when capabilities genuinely change — not on every render. |
| `lib/webmcp/project.ts` | The agent renderer. |
| `lib/webmcp/tools/database.ts` | Schema-generated database tools. |
| `components/webmcp/AgentPanel.tsx` | Lists what's registered and runs any of it by hand, so the integration is verifiable on a browser without the API. |

The architectural bet is that WebMCP should be a *delivery channel*, not a
dependency. Four of the five layers — commands, projection, journal, reciprocity
— are ordinary application architecture with no reference to the browser API.
Only the registry touches it, and it is the smallest of the five. If WebMCP were
withdrawn tomorrow, one adapter would be deleted and the app would still be
better than it was.

### Honest limits

WebMCP is an origin trial (Chrome 149, Edge 150). `outputSchema`, tool progress
reporting and the user-elicitation interface are still open questions in the
working group, which is why destructive operations are deliberately not
registered as tools: until consent has a settled shape, the safe surface is
reads plus reversible writes.
