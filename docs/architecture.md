# WebMCP — dual-representation architecture

> Date: 2026-08-31 · Full doc (artifact): https://claude.ai/code/artifact/843ceab4-4579-4baf-ae7c-b1f4e0ac8bf2
> Supersedes the framing in webmcp-opportunity.md (that one treats WebMCP as a feature; it isn't).

## Governing rule

One state, one action layer, rendered twice: React → pixels for the human,
`project()` → typed text for the agent. Both input paths mutate through the same
commands. The moment tools are a parallel API, we maintain two apps that disagree.

**Completeness criterion (testable, not aspirational):**
1. Every UI capability has a named command — enforce with a lint rule: no component
   calls `fetch('/api/*')` directly, it goes through `lib/actions/`.
2. Every rendered object has a projection — enforce with a type-level exhaustiveness
   check over the domain union.

## Five layers

| Layer | Path | Status |
|---|---|---|
| Action layer | `frontend/lib/actions/` | ~20 named mutations already exist in `useDatabaseView.ts`, trapped in the hook. Extraction, not design. |
| Projection layer | `frontend/lib/project/` | New. Nearest prior art: `backend/services/descriptor.py` (note-level, corpus granularity). |
| Registry + scope | `frontend/lib/webmcp/` | New, small. **Only layer that touches `document.modelContext`.** |
| Session + journal | `agent_actions` table + pending-state UI | Extends `mcp_audit_log` (010). UI half is the underestimated part. |
| Reciprocity surface | capture · working-context · skills-as-tools | Indexing pipeline behind it already built. |

Four of five layers have zero dependency on the browser API. If WebMCP were
withdrawn tomorrow we keep everything but one adapter.

## Thesis 1 — full control without 200 hand-written tools

1. Lift commands out of React (`defineAction({ name, input, run, inverse })`).
2. **Generate tools from schemas we already own** — not `create_row(values: object)`
   but `db.reading-list.create-row` with real enums from `PropertyResponse`.
3. Scope tools to the route, unregister on navigate, fire `toolchange`. Agent
   capabilities follow the user's attention.
4. Expose `SkillRegistry` skills as tools (WebMCP open Issue #161 — we have a
   working answer already).
5. Deliberate escape hatch: agents fall back to DOM actuation. Don't chase 100%.

**The hard part is reversibility, not capability.** Confirm-every-write is
confirmation fatigue = rubber stamp. Instead: staged agent sessions — mutations
apply optimistically but marked pending, journal records each command's inverse,
human accepts or discards the batch. This is the explainer's own flagship pattern
("a batch of uncommitted changes ... allowing Jen to review or adjust them").
**The staging layer is also the prompt-injection containment boundary** — same
mechanism serves safety and usability.

Schema gaps:
- `mcp_audit_log` → generalise to `agent_actions`: `session_id`, `origin`,
  `result_json`, `inverse_json`, `status (pending|committed|reverted)`.
- `mcp_servers.trust_level` governs outbound only. Mirror inbound: which agent
  origins may drive the app, at what tier, reusing `permissions.py` vocabulary.

## Thesis 2 — what the brain gives back

- **Write-back is the missing half and the higher-value one.** `brain.capture()`
  makes the brain the durable layer under every ephemeral chat, in any vendor's
  client. Gap: `notes.source_type` allows manual/pdf/video/audio/url/text — **no
  `agent`**. Add it + an `origin` JSONB (agent id, model, conversation ref, ts).
  Then descriptor → chunk → embed → index takes over unchanged.
  Compounding: every conversation improves retrieval for every later conversation,
  across vendors. No chat-native memory feature can do this — each is a walled garden.
- `brain.get-working-context()` — open note, active view + filters, workspace
  sources, recent edits. Not derivable server-side. Highest-value tool we can offer.
- Serve retrieval live; don't export copies into N assistants' memory stores.
- Export skills = export methods, not just facts.

## Thesis 3 — one environment, two modalities

**Projection contract.** Our UI encodes a lot of meaning visually (Notion parity
made this dense). A screenshot-driven agent recovers almost none of it:

| Meaning | Visual (human) | Projection (agent) |
|---|---|---|
| Section importance | `data-importance` 0–6 → block bg colour | "importance: 5 of 6 — near-critical" |
| Callout semantics | red/orange/purple/blue | exam-critical / watch-out / insight / overview |
| Mastery | badge colour | "mastery: reviewing" |
| Board grouping | column position | "group: Blocked (4 rows)" |
| Formula result | rendered cell text | value + the formula that produced it |

- **Focus must be bidirectional** — read it (`get-working-context`) and move it
  (open note, open row peek, jump to PDF anchor). Backend agents can only emit a URL.
- **Agent action must be legible** — pending-change highlighting, change trail,
  review strip, presence. Frontend work, most likely to be underestimated.
- **Concurrency, honestly:** Yjs is in the tree only because BlockNote bundles it and
  `next.config.ts` transpiles it for dedup. **Collaborative editing is NOT wired.**
  Agent-as-CRDT-peer is the right destination but a real project, not a short step.
  Staging layer covers it meanwhile.
- **Tablet:** LiteRT on-device model + WebMCP page tools = a complete agent loop with
  no cloud — local inference, local actuation, local data. Falls out of this
  architecture free.

## Sequencing luck

`engine.py`'s inner loop comment: *"one round in Phase 1; multi-round will follow
once we wire continue-on-tool-result."* Page tools need exactly that mechanism.
The client-executed round trip and the queued multi-round continuation are **the
same refactor** — do them together or touch that loop twice.

## Limits

Origin trial only (Chrome 149 / Edge 150; ChatGPT Desktop ships it; Firefox +
Safari uncommitted). Still open in the WG: `outputSchema`, tool progress,
streaming I/O, the elicitation interface our confirmation flow needs. No service
worker → nothing works with the tab closed → **keep `backend/mcp_server.py`.**
