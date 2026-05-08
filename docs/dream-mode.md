# Dream-Mode

> Background memory consolidation. The agent reads its own session
> transcripts when you're not looking, identifies facts worth remembering,
> and surfaces them for your explicit approval. Nothing is written to
> memory without you saying yes.

## The problem it solves

Conversation history is rich; agent memory is sparse on purpose. Over a
typical session you might mention dozens of things the agent should know
long-term — a new project, a renamed device, an updated address. Without
a consolidation step those facts live only in the JSONL transcript. The
underlying provider's session compaction can quietly drop them in a
month, and they're hard to recover.

Dream-mode reads the transcripts, runs a small LLM over them, and produces
**findings** — concrete, structured suggestions like "add note `mercedes`
with content X" or "edit note `address` to replace Y with Z". You and the
agent walk through them; you approve or reject each individually. Memory
only changes by your say-so.

## When dreams run

Two triggers:

### Manual: `/reset YES`

When you reset a session — typically your `main` to keep it from
ballooning indefinitely — somora archives the current jsonl + meta to a
timestamped name and starts a new manual dream over that archived range.
The reset returns immediately; the dream runs async. Result lands in
`~/.somora/agents/<name>/memory/.dreams/<id>.dream.md` and shows up in
`dream_list` once extraction is done.

Manual dreams **do not pause** when you start chatting again. They were
user-initiated and have a bounded scope (one archived session); they
just run to completion.

### Automatic: idle-triggered

If `dream.enabled: true` is set in `agent.yaml`, an in-process worker
watches each agent's chat activity. After `idleMinutes` of no chat
(default 30), the worker:

1. Resumes any previously-paused dream first (don't waste prior work).
2. Otherwise picks the most-recently-active session whose `lastActivity`
   is past its `dreamReadThroughTs` marker.
3. Runs an extraction over the delta range.
4. On success, bumps `dreamReadThroughTs` so the next idle cycle sees a
   smaller delta.

If you start chatting while an auto-dream is running, the worker aborts
it (becomes `paused`) and resets the idle countdown. Next idle window,
the worker resumes from where it stopped.

## Configuration (per agent)

```yaml
# ~/.somora/agents/<name>/agent.yaml
dream:
  enabled: true              # master toggle
  model: gemma               # REQUIRED when enabled. No fallback.
  idleMinutes: 30
  chunkTokens: 50000         # rough size per LLM extraction call
  chunkTimeoutMs: 600000     # per-chunk timeout — 10 min default, lenient enough for local
```

`model` is mandatory when `enabled: true`. There is intentionally no
fallback to the agent's primary model: dreaming long sessions burns
tokens, and that's exactly the wrong thing to do silently on a premium
model. The dream worker model is your explicit choice — typically a
small local model (e.g., a Gemma variant via Ollama or oMLX).

`chunkTimeoutMs` defaults to 10 minutes. The earlier 2 min default was
too tight for realistic local-model loads: 33k-token chunks against
gemma-4-31b-it-8bit via mlx-omx need 3-5 min just for prefill +
JSON-output. With the lower cap, every chunk hit the timeout before it
could complete — and before the backend's KV cache could warm for the
next chunk, so even cache-friendly prompt structure (memory + vault
prefix stable across chunks per `docs/cache-strategy.md`) couldn't
help. 10 min fits any reasonable local-model setup; fast cloud workers
finish in seconds and ignore the headroom. Lower this only if you're
using a fast cloud worker AND want fail-fast on stalls.

### Per-agent rules: `DREAMRULES.MD`

Optional file at `~/.somora/agents/<name>/DREAMRULES.MD` alongside
`AGENTS.md` / `SOUL.md` / `USER.md`. Free-form Markdown — its content
is injected verbatim into the dream-worker's system prompt as a
`## Per-agent rules` block. No schema; the dream-worker is an LLM, it
reads prose.

Use this to encode persona-specific guardrails on what the worker
should and shouldn't propose. Common rule: when the agent has an
Obsidian vault, declare the vault as the single source of truth so the
worker doesn't suggest copying vault content into memory.

```markdown
# Dream Rules — <your-agent>

## Don't propose memory writes for these
- Content already present in the Obsidian vault. Vault is the canonical
  store; memory_write that consolidates vault notes is duplication and
  causes double-maintenance later.
- Consolidated overviews ("Alles über X"). Those belong in the vault as
  notes, not in memory as fact-summaries.

## What memory IS for
- Atomic statements the user made about themselves, their preferences,
  their projects, their state.
- Corrections to existing memory entries.
- Observations that don't fit anywhere in the vault (too specific,
  too transient, too personal).
```

The file is **optional**. Missing → no rules block, current behavior.
Loaded with mtime cache, re-read whenever it changes. The agent itself
can edit it with `file_write` when it spots dismissal patterns the
worker should learn — same edit-permission posture as the other
persona files.

Per-agent because dream behavior is already per-agent: an agent without
vault access has no "vault is the boss" rule to add; an agent with
strict privacy settings might want stricter memory-write rules. Each
persona shapes its own dreamer.

## File lifecycle

```
~/.somora/agents/<name>/memory/.dreams/
├── <id>.dream.running.md     ← extraction in flight
├── <id>.dream.paused.md      ← interrupted (chat activity or server crash)
├── <id>.dream.failed.md      ← unrecoverable; .error in frontmatter
├── <id>.dream.md             ← extraction done; awaiting your review
└── processed/
    └── <id>.dream.md         ← all findings resolved (applied or dismissed)
```

Filename suffix tracks status. Atomic rename on transitions. After
server crash, any orphan `.running.md` files are auto-renamed to
`.paused.md` (auto-trigger) or `.failed.md` (manual-trigger) at next
startup — manual dreams aren't auto-resumed because their scope was
tied to a specific user action.

## Reviewing findings

Ask the agent. It uses `dream_list` to see what's pending, `dream_get`
to read a specific dream, and walks you through findings one at a time:

```
[<your-agent>:main]> hast du was geträumt?

[tool call · dream_list · {}]
[tool result · {"count":1,"dreams":[...]}]
[tool call · dream_get · {"dream_id":"…"}]

agent: Yep — three findings from the archived main session.

  1. Memory edit: auto.md says you drive a Fiat. You mentioned a
     Mercedes purchase last week. Should I update?

[user]> ja

[tool call · dream_apply · {"dream_id":"…", "finding_id":1}]
[tool result · {"applied":true,"remaining":2,"dream_done":false}]

agent: Done. Next:

  2. New note "yoga": You mentioned starting yoga with Markus on
     Tuesdays at 6 PM. Save?

[user]> nee, das war Smalltalk

[tool call · dream_dismiss · {"dream_id":"…", "finding_id":2}]

agent: Skipped. Last one:

  3. ...
```

When all findings are resolved (applied or dismissed), the dream
auto-archives to `processed/`. If a dream extraction returns zero
findings (the conversation was trivial), it auto-archives directly —
no review needed.

## Tools

```
dream_list({ include_processed? })           overview of pending dreams
dream_get(dream_id)                          full content with structured findings
dream_apply(dream_id, finding_id)            execute the finding's memory action
dream_dismiss(dream_id, finding_id?)         reject one finding; or whole dream if no id
```

`dream_apply` doesn't think — it executes the proposed action via the
matching `memory_*` tool. The extractor decides what to suggest; you
decide whether to apply; the apply step has no creative leeway. That
separation makes apply deterministic and auditable.

## Why findings, not auto-promotion

The OpenClaw approach (auto-promote high-signal recalls into long-term
memory based on a scoring function) was rejected during design. Two
reasons:

1. **Auditability.** A bad extraction silently corrupts memory. With
   findings + explicit approval, every memory mutation has a paper
   trail in `.dreams/processed/`.

2. **Trust.** You should always know why a memory note got the way it
   is. Findings record the reason ("user said X on Y") and you say yes
   or no. Bad extractions just get dismissed, no harm done.

The cost is a per-dream review step. The dream archiving keeps the
review friction proportional to the actual change rate of your life,
not to the chat volume.

## Diagnostics

Server-log events to watch:

```
dream.start                  starting extraction (manual or auto)
dream.llm_request            chunk request going out (with baseUrl + model)
dream.chunk_done             chunk completed (with response preview + duration)
dream.completed              extraction done (with finding count)
dream.completed_empty        zero findings — auto-archived to processed/
dream.paused                 cancelled mid-flight (auto-trigger only)
dream.failed                 extraction errored unrecoverably
dream.auto.aborted_by_activity  user chatted while auto-dream was running
dream.auto.fired_idle        idle timer fired, kicking off work
```

Each `dream_*` tool invocation also logs at info level (`tool.invoked`).

## Limitations & non-goals (today)

- **Vault writes are not in scope.** Findings can be `vault_hint` ("user
  may want to update vault note X") but are surfaced as no-op
  acknowledgements — there is currently no `obsidian_write` tool.
- **Resume re-runs from scratch.** When a paused dream resumes on the
  next idle, the previously-extracted findings are discarded and the
  whole range is re-extracted. The cost of re-running is small for the
  typical delta; the alternative (dedup across partial-extraction
  runs) added enough complexity to defer.
- **Worker model must be openai-compatible.** Routing the extraction
  through `claude-cli` or `codex-cli` engines as worker is possible but
  unbuilt; the current implementation calls `chat.completions` directly.
