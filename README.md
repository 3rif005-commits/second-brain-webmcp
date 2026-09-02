# Second Brain — a knowledge app that renders itself twice

**The WebMCP Challenge submission.**

- **Live app:** https://second-brain-webmcp.vercel.app
- **Demo video (< 3 min):** _TODO_
- **Judge login:** `demo@secondbrain.app` / `WebMCP-Demo-2026`
- **Straight to the database:** https://second-brain-webmcp.vercel.app/brain/db/e03b0c0b-0821-4e60-b1cd-6f4f4d1cdfba — a seeded Reading List, 12 rows.

> No Chrome 149? The app still demonstrates everything. Open the **"N agent tools"**
> pill in the bottom-right: it lists every tool registered for the page you are on
> and lets you invoke any of them by hand, watching the UI change behind the panel.

---

## The idea

A web app has exactly one representation: pixels. Everything it knows is encoded
into a visual layout, and to act on it you have to decode that layout back into
intent. Humans do this natively. Agents do it badly — screenshot, guess a
coordinate, click, screenshot again to find out what happened.

WebMCP lets an app render itself a second time: same state, same capabilities,
expressed as typed text instead of pixels. Not a second app — a second rendering.

So Second Brain has one state, one action layer, and two renderers:

| | Human renderer | Agent renderer |
|---|---|---|
| Output | React components → pixels | `project()` → typed text |
| Input | clicks and typing | `executeTool()` |
| Write path | **the same command layer** | **the same command layer** |

Both branches mutate through one path, so the agent's model of the app cannot
drift from what the user is looking at.

## What that buys, concretely

**The agent sees what the visual encodes.** The app stores a callout's semantic
type (`EXAM`, `CAUTION`, `FORMULA`, …) and renders it as a coloured box with an
icon. A screenshot-driven agent sees "a pink box with 🎯". The projection layer
emits `callout EXAM — "Exam", shown to the reader as a pink box with 🎯`. Same for
`data-importance` (a 0–6 scale rendered as a background tint), mastery status, and
board grouping, where a row's group is encoded purely as horizontal position.

**Tools are generated from the live schema, not hand-written.** Opening a database
registers tools built from *that* database's properties. A Reading List advertises
`Status` with its real enum and `Rating` with its real bounds, so the model cannot
invent a property or an option that doesn't exist. Opening a different database
swaps the entire tool set and fires `toolchange`.

**The tool surface follows the user's attention.** Tools are scoped to what is on
screen and unregistered on navigate, rather than registering the whole product at
once and flooding the model's context.

**Writes reuse the app's own mutation path.** `create-row` calls the same
`updateCell` a human edit calls — so optimistic updates, rollback on failure and
toasts all behave identically whether a person or an agent made the change.

## Where the code is

| Path | What it does |
|---|---|
| `frontend/lib/webmcp/registry.ts` | The only file that touches `document.modelContext`. Keeps a local registry, mirrors to the browser when present, routes every call through one execute path. Feature-detects both `document.modelContext` and the older `navigator.modelContext`. |
| `frontend/lib/webmcp/useWebMcpTools.ts` | React binding. Registration is keyed on tool *names*; implementations resolve late from a ref, so `toolchange` fires when capabilities change and not on every render. |
| `frontend/lib/webmcp/project.ts` | The agent renderer — turns visual encodings back into text. |
| `frontend/lib/webmcp/tools/database.ts` | Schema-generated database tools. |
| `frontend/lib/webmcp/tools/note.ts` | Note tools. `note.read` returns the projection, and reads the live editor document so it reflects unsaved edits. |
| `frontend/components/webmcp/AgentPanel.tsx` | Makes the surface visible and hand-runnable. |
| `frontend/components/database/DatabaseShell.tsx` | The single wiring point — one `useWebMcpTools` call. |

## Tools registered on a database page

| Tool | | What it does |
|---|---|---|
| `db.<name>.describe` | read | Schema, allowed values, active view with its filters and grouping. |
| `db.<name>.list-visible-rows` | read | The rows on screen *after* filters and grouping — not every row in the table. |
| `db.<name>.create-row` | write | Input schema generated from the real properties. |
| `db.<name>.update-row` | write | Same. |
| `db.<name>.switch-view` | write | Moves the user to another view. |
| `db.<name>.set-grouping` | write | Regroups the board in front of them. |
| `db.<name>.set-filter` | write | Filters the grid in front of them. |

## Tools registered on a note page

| Tool | | What it does |
|---|---|---|
| `note.read` | read | The note as an annotated outline — including callout semantics and the importance scale that a screenshot cannot convey. Reflects unsaved edits. |
| `note.get-open` | read | Which note the user is looking at. |
| `note.search` | read | Keyword search across notes. |
| `note.append` | write | Appends Markdown; lands in the editor and is undoable. |
| `note.set-mastery` | write | Sets the mastery badge. |
| `note.open` | write | Navigates the user to another note. |

## Verified

- Deployed and live: frontend on Vercel, API on Render, Postgres on Supabase.
- Production build: clean `npm ci` + `next build`, compiles successfully.
- Test suite: 921 tests across 61 files, all passing.
- Type-check: clean.

## Running it locally

```bash
# 1. Backend — needs Postgres only; no model server required for /db
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in Supabase + DATABASE_URL
uvicorn main:app --reload   # :8000

# 2. Frontend
cd frontend
npm install
cp .env.local.example .env.local   # set DATABASE_ROWS_ENABLED=true
npm run dev                        # :3000
```

To exercise the browser API rather than the in-page path, enable
`chrome://flags/#enable-webmcp-testing` in Chrome 149+ and reload. The panel's
status line reports which namespace it found.

## Deploying

`render.yaml` is a Render blueprint for the API. The frontend is a stock Next.js
app — deploy to Vercel and set `FASTAPI_URL` to the Render URL, plus the Supabase
keys. Set the API's `FRONTEND_URL` to the Vercel origin or CORS will reject it.

## Honest limits

WebMCP is an origin trial (Chrome 149, Edge 150), and `outputSchema`, tool progress
reporting and the user-elicitation interface are still open in the working group.
Four of the five layers here — commands, projection, journal, reciprocity — have no
dependency on the browser API at all, which is why the app is fully functional and
fully demonstrable on browsers that will never ship it.

## Licence

MIT — see `LICENSE`.
