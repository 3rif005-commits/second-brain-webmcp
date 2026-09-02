# Demo video — 3:00 hard cap

Judged on WebMCP Leverage, Execution, Potential Impact, Creativity & Ambition.
The cut below spends its middle 90 seconds on Leverage, because that is the
criterion listed first and the one most submissions will show thinnest.

**Setup before recording**
- Chrome 149+, `chrome://flags/#enable-webmcp-testing` enabled.
- Logged into the demo account, Reading List database open, Board view.
- Agent panel **closed** (it opens on camera — that beat matters).
- Screen at 1440×900 or tighter so text is legible after compression.

---

### 0:00 – 0:18 · The problem

> **On screen:** the Reading List board.
>
> "This is a Notion-style database in my knowledge app. If you asked an AI agent
> to reorganise it today, it would take a screenshot, guess where to click, and
> screenshot again to find out what it did. It's driving my app by looking at
> pixels — because pixels are the only thing my app has ever produced."

### 0:18 – 0:40 · The thesis

> **On screen:** open the agent panel. Tool list fills in.
>
> "WebMCP lets the page render itself a second time. Same state, same
> capabilities — as typed text instead of pixels. Seven tools here, and they
> aren't hand-written. They're generated from this database's live schema."

### 0:40 – 1:30 · Leverage — the generated schema *(the core beat)*

> **On screen:** expand `db.reading-list.create-row`, show the JSON schema.
>
> "Look at what `create-row` advertises. Not 'values: object' — `Status` with
> its four real options, `Rating` as a number, `Topics` with the actual tags.
> The model cannot invent a property that doesn't exist, because the schema
> won't let it. Open a different database and this whole set is replaced and
> `toolchange` fires."
>
> **On screen:** switch to the browser agent. Type: *"Group this board by
> status, then show me only what I'm currently reading."*
>
> **Let the board visibly regroup and filter. Do not talk over it — 3 seconds of
> silence while it happens.**
>
> "Two tool calls. And notice where that happened: in my UI, in front of me. A
> backend integration would have computed an answer on a server and left my
> screen untouched."

### 1:30 – 2:10 · Creativity — the projection layer

> **On screen:** open a note with callouts of different colours.
>
> "Here's the part I think is the real opportunity. My app encodes meaning in
> colour. This pink box with a target icon means *exam-critical*. This 0-to-6
> background tint is an importance scale. A screenshot-driven agent sees a
> pinkish rectangle and guesses."
>
> **On screen:** run the note's projection tool; show the text output.
>
> "The projection layer emits what the colour *stands for*: `callout EXAM`,
> `importance 5 of 6, near-critical`. Humans want the visual. Models want the
> text. Same state, rendered for whoever is reading."

### 2:10 – 2:35 · Execution — it works without the API too

> **On screen:** the panel's status line; run a tool by hand from the panel.
>
> "Everything is verifiable without a browser agent. This panel lists what's
> registered and runs any of it by hand — so the integration is testable on a
> browser that hasn't shipped WebMCP at all. Four of the five layers here don't
> touch the browser API."

### 2:35 – 3:00 · Impact

> **On screen:** back to the board, agent adding a row.
>
> "One state, one write path, two renderers. The agent's model of my app can't
> drift from what I'm looking at, because they're the same object rendered
> twice. That's what I think WebMCP is actually for."

---

**Cutting room, if long:** drop 2:10–2:35 first (the README covers it), then
tighten 0:00–0:18. Never cut the silence at 1:15 — the board regrouping on its
own is the single most persuasive second in the video.
