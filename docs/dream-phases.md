# Dream Phases

> Background memory consolidation in three phases — REM, Deep, Lucid.
> Together they turn raw conversation into curated long-term knowledge
> without any single LLM call doing too much.

## The mental model

```
   ┌─ REM ─────────────────┐    ┌─ Deep ─────────────────┐    ┌─ Lucid ──────────────┐
   │  Session → Memory     │    │  Memory → Wiki         │    │  Wiki cleanup        │
   │  per-agent            │    │  platform-wide         │    │  platform-wide       │
   │  ~30 min idle         │    │  ~12 h scheduled       │    │  ~7 d scheduled      │
   │  small/local model    │    │  strong model (opus)   │    │  strong model (opus) │
   │  approval required    │    │  auto-applies          │    │  approval required   │
   └───────────────────────┘    └────────────────────────┘    └──────────────────────┘
                │                            │                            │
                ▼                            ▼                            ▼
   memory inbox grows           wiki gets new pages /         wiki gets fixed:
   with new facts the           merges of new content;        contradictions resolved,
   agent should keep            consumed memory files         stale claims updated,
                                are deleted                   missing pages created
```

Each phase has one job. Each runs at its own cadence. Each uses an LLM
worker model you configure separately. The phases compose into a clean
flow: facts come in via REM, get consolidated by Deep, get audited by
Lucid.

## Phase REM — Session → Memory

REM ("Rapid Eye Movement") extracts new factual information from a
session's transcript and proposes additions to the agent's **private
memory inbox**.

### Job

Read the session JSONL since the last REM run, identify FACTS the user
asserted (not jokes, not transient state, not things already in memory or
the wiki), and surface them as `pending` findings for your approval.

### Triggers

Two triggers, both per-agent:

**Manual: `/reset YES`** — when you reset a session, somora archives the
current `main.jsonl` to a timestamped name and starts a fresh `main`.
If REM is enabled for the agent, it spawns a manual run over the
archived range. Result lands in
`~/.somora/agents/<name>/memory/.dreams/<id>.dream.md` and shows up in
`dream_list`.

**Automatic: idle-timer** — when REM is enabled, an in-process worker
watches each agent's chat activity. After `idleMinutes` of no chat
(default 30), the worker:

1. Resumes any previously-paused dream first (don't waste prior work).
2. Otherwise picks the most-recently-active session whose last activity
   is past its `dreamReadThroughTs` marker.
3. Runs an extraction over the delta range.
4. On success, bumps the marker so the next idle cycle sees a fresh delta.

Manual REM runs do **not** pause when you start chatting again — they're
user-initiated, bounded, just run to completion.
Automatic REM runs **abort** on user activity (the in-flight extraction
gets paused; resumed on next idle).

### Worker model

Configured per-agent in `agent.yaml`:

```yaml
rem:
  enabled: true
  model: gemma4big           # alias from config.yaml or 'provider/modelId'
  idleMinutes: 30
  chunkTokens: 50000         # range-split for very long sessions
  chunkTimeoutMs: 600000     # 10 min per chunk (gemma-friendly)
  participate_in_wiki: true  # default true; false = REM only, never Deep
```

Default worker is small/local (`gemma4big` via mlx-omx, ~31B params).
You can switch to opus/sonnet/gpt-5.5 — but REM runs often, so cost
matters. Gemma is good enough for atomic-fact extraction with the right
prompt.

### What REM sees

Each REM run feeds the worker:

- Transcript chunk (1+ chunks if session is long)
- Existing memory inbox contents for this agent
- Wiki context (index.md + top-N relevant wiki pages, embedding-matched
  against session content)
- Vault-recall snippets (if vault is configured)
- The REM system prompt (in `src/dream/rem-extract.ts`)

The wiki context is critical: REM dedupes against the **wiki**, not just
memory. New facts that contradict the wiki get surfaced as
`memory_write` so Deep can later merge them in.

### Output: findings

A REM run produces `pending` findings, each with:

- `action` — `memory_write | memory_edit | memory_delete | vault_hint`
- `slug` — kebab-case identifier
- `proposed_content` — what should land in memory if approved
- `reason` — why this finding (quotes user's statement)

Approve with `dream_apply`, reject with `dream_dismiss`. Memory file is
written/edited/deleted only on approval.

## Phase Deep — Memory → Wiki

Deep consolidates **all agents' memory inboxes** into the shared wiki.

### Job

For each memory file across all participating agents, decide one of three
outcomes:

- **Skip** — transient (daily log, scratchpad), already covered, too thin.
- **Promote** — new wiki topic, create dedicated page with frontmatter,
  sections, cross-references.
- **Merge** — topic exists in the wiki, integrate new content into the
  existing page (preserves structure, updates `## Aktueller Stand` and
  `## Zeitleiste` typically).

After successful Promote or Merge, the source memory file is **deleted**.
Wiki = canonical, inbox stays a clean queue.

### Triggers

**Schedule** — every 12h (configurable).

**Manual** — `dream_run({phase: 'deep'})` from any agent's chat, or
`POST /dream/run-deep` over HTTP. Optional `force: true` bypasses the
hash-cache (re-evaluates every memory file).

Deep operates on whatever memory files are currently on disk. It does
**not** trigger REM. New observations only enter memory when you
approve a REM finding via `dream_apply`; Deep picks them up on its
next run.

### Worker model

Configured platform-wide in `config.yaml`:

```yaml
wiki:
  deep:
    enabled: true
    intervalHours: 12
    model: opus              # opus by default; via Claude subscription
```

### Single-prompt logic (skip / promote / merge in one call)

Per memory file, Deep does ONE LLM call that decides skip/promote/merge.
The worker sees:

- The memory file (frontmatter + body)
- Wiki index.md (topology header)
- Top-8 relevant wiki pages (full bodies, embedding-matched against
  the memory body)

Returns a structured `MemoryFateDecision`:

```json
{ "kind": "skip", "reason": "..." }

{ "kind": "promote", "subfolder": "personen", "slug": "personen/luca",
  "type": "person", "title": "Luca",
  "body": "## Aktueller Stand\n…", "related": [...] }

{ "kind": "merge", "wikiPath": "personen/familie-klein",
  "body": "...full updated body...",
  "logSummary": "familie-klein aktualisiert: ..." }
```

Deep applies the decision verbatim. No second LLM call at apply-time.

### Hash-cache

Skipped memory files get cached by body-hash in
`~/.somora/agents/<name>/memory/.deep-skip-cache.json`. On the next Deep
run, files whose hash matches the cached entry are skipped without an
LLM call. Saves opus tokens dramatically when most memories are
unchanged between runs (verified: 1500× speedup on a 56-file all-cached
run).

The cache invalidates automatically when:
- Memory body changes (hash mismatch → re-evaluate)
- Promote/merge consumed the file (entry pruned)
- File is deleted (opportunistic cleanup on next loadCache)

`dream_run({phase: 'deep', force: true})` ignores the cache for one run.

### No approval

Deep runs auto-apply. No per-finding review — the trade-off is that
Memory→Wiki is mechanical consolidation, not subjective. If a Deep run
makes a bad decision you don't like, you fix it in Obsidian (the wiki
is just markdown) or wait for Lucid to flag it.

The audit trail lives in `<vault>/<wiki-subfolder>/logs/YYYY-MM.md` —
monthly append-only logs of all Promotes and Merges with one-line
summaries.

## Phase Lucid — Wiki cleanup

Lucid audits the existing wiki, surfaces objectively-verifiable
quality issues, and hands them off to **a conversational review loop**
where you walk the findings with one of your agents and that agent
writes the changes via loop-scoped `wiki_*` tools. Lucid itself never
auto-edits the wiki.

### Job

Walk the wiki (subfolder by subfolder), identify issues that are
objectively provable from the wiki content, surface a SHORT list (max
8 per run). Lucid is intentionally narrow:

| Finding kind | What it means |
|---|---|
| `contradiction` | Two pages assert mutually exclusive facts about the same subject. Cite specific text from each. |
| `dead_ref` | `[[wiki-path]]` references a page that doesn't exist. |
| `wanted_page` | Topic referenced by ≥3 wiki pages but missing its own page. |
| `link_suggestion` | A page mentions a named entity in prose AND a wiki page exists with that name AND there is no `[[wikilink]]` from one to the other. Strict: only for clearly identifiable named entities, not generic words. |

Subjective polish (stylistic rewrites, "this could read better",
"feels old") is **deliberately NOT in scope**. Those decisions belong
in the review conversation, not pre-baked as findings. Three legacy
kinds (`stale_claim`, `outdated`, `inconsistent_xref`) are retired
from current runs but still parse for archived runs in `processed/`.

### Triggers

**Schedule** — every 7 days (configurable).

**Manual** — `dream_run({phase: 'lucid'})` or `POST /dream/run-lucid`.

### Cluster strategy

Lucid walks the wiki by subfolder, one LLM call per subfolder. Then a
final cross-subfolder pass with page-headers only catches issues that
span subfolders (a contradiction between `personen/luca` and
`projekte/familie-luca-podcast`, for example).

This isn't just for scale — claude-cli's stdin-stream parser fails on
single user-messages > ~50 KB. Per-subfolder batches stay safely under
that limit. As a side-effect Opus reads each subfolder with full focus,
which produces higher-quality findings than scanning everything at once.

For very large wikis (>1500 pages), a future stage adds hierarchical
clustering inside subfolders. Until then, subfolder-pass is the
universal default.

### Worker model

Configured platform-wide:

```yaml
wiki:
  lucid:
    enabled: true
    intervalDays: 7
    model: opus
    requireApproval: true
```

### Output

A `LucidRun` JSON file in `~/.somora/wiki-lucid/<run-id>.json` with up
to 8 findings. Each finding is **informational only** — `fix.kind:
'no_op'` with the description of the issue. The actual editing happens
in a `dream_review` loop (next section), not via `dream_apply`.

When the review loop closes (or you dismiss the whole run), the file
moves to `~/.somora/wiki-lucid/processed/` with the loop summary
appended for the audit trail.

### Reviewing Lucid findings — the `dream_review` loop

Findings are walked by an agent in conversation with you, not via
button-click approval. You start the loop with one agent, talk through
each finding, the agent writes changes via loop-scoped `wiki_*` tools
when you OK each step, and you close the loop when done.

```
> du:    schau dir das lucid result mal an
hans:    dream_list   → finds the Lucid run
         dream_get(id) → reads all findings
         dream_review({dream_id, action: 'start'})  ← opens the loop
         "Hier ist was Lucid gefunden hat: 5 contradictions, 2 dead refs.
          Ich fang mit der ersten an: page X sagt Y, page Z sagt W.
          Mein Vorschlag: <konkrete Änderung>. OK?"

> du:    ja, mach so
hans:    wiki_edit({...})   ← writes the page
         "Erledigt. Nächste Finding: ..."

> [several rounds of walk-discuss-edit]

> du:    passt, mach Schluss
hans:    dream_review({dream_id, action: 'end', summary: '...'})  ← closes
         loop is archived to processed/, normal tools come back
```

While the loop is active for an agent:

- The agent gets `wiki_edit` / `wiki_create` / `wiki_delete` (loop-scoped)
- Read-only file tools (`file_read`, `file_search`, `file_list`,
  `analyze_file`) stay available so the agent can look up source
  material before proposing an edit. `file_write` / `file_patch` are
  hidden — only wiki_* may mutate.
- The agent's `exec_*` / `agents_*` / `skill_*` / `tmux_*` tools are
  temporarily hidden so the conversation stays focused
- Other agents continue normal operation but cannot start their own
  loop until this one ends — somora-instance-global lock
- The TUI status line shows `📝 wiki-review:<agent>`
- Per-turn cap: max 3 wiki_* calls in a single turn so the agent
  cannot batch-edit without checking in. Resets on every user
  message.
- Auto-expiry: 24h idle without activity → loop auto-closes as a
  safety net in case the agent forgot to call `action: 'end'`

`wiki_edit` accepts body changes (`newBody`) and/or frontmatter ops
(`relatedAdd`, `relatedRemove`, `sourcesAdd`, `sourcesRemove`) — all
optional. Pass only what you want to touch. Useful pattern: clear a
dead `related:` ref with `wiki_edit({wikiPath, relatedRemove: ['dead/page']})`
without touching the body.

## Reviewing findings — the `dream_*` tool surface

REM and Lucid have different review flows because the cost of a wrong
auto-apply differs:

- **REM findings** are atomic memory writes — small, easy to audit
  individually, isolated to one agent's inbox. They use the per-finding
  approval pattern (`dream_apply` / `dream_dismiss`).
- **Lucid findings** are wiki edits that ripple across multiple pages
  and need the user's judgement. They use the conversational
  `dream_review` loop described above.

Tools:

```
dream_list                              List pending dreams (REM + Lucid)
dream_get(dream_id)                     Show full content of a dream
dream_apply(dream_id, finding_id)       Accept REM finding → applied
dream_dismiss(dream_id, [finding_id])   Reject (one finding or whole run)
dream_run({phase, [wait], [force]})     Trigger Deep or Lucid manually
dream_review({dream_id, action, [summary]})
                                        Open/close the wiki review loop
                                        for a Lucid run (Lucid only)
```

`dream_list` returns a `kind` discriminator per entry:

- `kind: 'memory'` — REM finding, scoped to the agent in whose chat
  you're calling. Other agents don't see it.
- `kind: 'wiki_lucid'` — Lucid finding, platform-wide. Any agent with
  the `dream` toolset sees the same set.

Typical REM flow:

```
hans> dream_list
   → memory dream: 5 pending findings
hans> dream_get dream_id=<id>
   → full finding list with action, slug, reason, proposed_content
> walk through with me, finding by finding
hans> dream_apply  (or dream_dismiss)
   → repeats until all resolved → dream_done: true
```

Typical Lucid flow:

```
hans> dream_list
   → wiki_lucid run: 6 pending findings
hans> dream_get dream_id=<id>
   → full finding list (all fix.kind = 'no_op' informational)
hans> dream_review({dream_id, action: 'start'})
   → loop opens, wiki_* tools become available, file_*/exec_* etc. hide
[walk-discuss-edit conversation rounds]
hans> dream_review({dream_id, action: 'end', summary: 'F1 applied as edit X, F2 dismissed, ...'})
   → loop closes, run archived
```

`dream_apply` on a Lucid finding (which is always `no_op` now) marks
it applied without writing anything — useful only as
acknowledge-and-move-on if you don't want the loop. The actual fix
path is the loop.

## Triggering manually

REM runs are user-initiated only via `/reset YES` (TUI) or organic via
idle-timer. There's no `dream_run({phase:'rem'})` because REM is
per-agent and per-session.

Deep and Lucid are platform-wide and triggerable:

```
# In any agent's chat:
> ruf bitte dream_run({phase: 'deep'}) auf
> dream_run({phase: 'lucid'})
> dream_run({phase: 'deep', force: true})  # bypass hash-cache

# Or HTTP directly:
curl -X POST http://127.0.0.1:18737/dream/run-deep   -d '{"wait":true}'
curl -X POST http://127.0.0.1:18737/dream/run-lucid  -d '{"wait":true}'
```

`wait: true` blocks the request until the run finishes (returns full
outcome). Default `wait: false` is fire-and-forget — agent gets a
"started in background" reply, run completes on its own.

## Configuration cheat-sheet

```yaml
# config.yaml — platform-wide
wiki:
  enabled: true
  vaultSubfolder: somora                 # → <vault>/somora/
  deep:
    enabled: true
    intervalHours: 12
    model: opus
  lucid:
    enabled: true
    intervalDays: 7
    model: opus
    requireApproval: true
  search:
    boostWiki: 1.4                       # wiki hits rank above memory
    boostMemory: 0.85
    boostVault: 0.65
```

```yaml
# agent.yaml — per-agent
rem:
  enabled: true
  model: gemma4big
  idleMinutes: 30
  chunkTokens: 50000
  chunkTimeoutMs: 600000
  participate_in_wiki: true
```

## Where things live

```
~/.somora/agents/<agent>/memory/             ← memory inbox (REM writes here)
~/.somora/agents/<agent>/memory/.dreams/     ← REM run files awaiting approval
~/.somora/agents/<agent>/memory/.dreams/processed/   ← resolved REM runs
~/.somora/agents/<agent>/memory/.deep-skip-cache.json ← Deep hash-cache
~/.somora/wiki-lucid/<run-id>.json           ← Lucid run files
~/.somora/wiki-lucid/processed/              ← resolved Lucid runs
<vault>/<wiki-subfolder>/                    ← the wiki itself
<vault>/<wiki-subfolder>/index.md            ← auto-regenerated topology
<vault>/<wiki-subfolder>/logs/YYYY-MM.md     ← monthly Deep audit log
```

## What dreams won't do

- **Auto-write to memory or wiki without approval** — except Deep, which
  runs auto-apply (no approval) but is bounded to the structured
  `MemoryFateDecision` and writes only the markdown the LLM produced.
- **Edit content outside the agent's memory or the wiki subfolder** — the
  rest of your Obsidian vault stays read-only from somora's perspective.
- **Sync across machines automatically** — somora is single-host. Use git
  or syncthing on the wiki subfolder if you want cross-device sync (memory
  inboxes are ephemeral inboxes, not worth syncing).

## Design rationale

Each phase has its own worker model so you can tune cost vs quality
independently:

- REM runs often → cheap local model is fine for atomic-fact extraction.
- Deep runs occasionally → strong model is worth it for quality consolidation.
- Lucid runs rarely → strong model definitely worth it for finding
  contradictions / stale claims.

Each phase has its own approval policy so you control surface area:

- REM proposes; you decide what enters memory.
- Deep auto-applies; mistakes are recoverable in Obsidian.
- Lucid proposes; you decide what gets fixed in the wiki.

The wiki is the only place where stable knowledge lives. The memory
inbox is volatile by design — files come in, get consolidated, get
deleted. The vault is read-only context (your Obsidian notes outside
the wiki subfolder are yours, not somora's).

## See also

- [memory.md](memory.md) — how the memory inbox indexes and retrieves
- [wiki.md](wiki.md) — the shared long-term wiki layer
- [agents.md](agents.md) — per-agent configuration including REM
- [tools.md](tools.md) — full tool reference (`dream_*` is one of 12 toolsets)
