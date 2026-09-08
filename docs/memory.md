# Memory

> Each agent has a private memory inbox. Memory is plain Markdown files
> on disk, indexed by SQLite (`sqlite-vec` for vector + FTS5 for BM25)
> for fast hybrid retrieval. Inboxes are short-term — Deep promotes
> stable knowledge to the shared [wiki](wiki.md) and deletes the source.

## Three layers, one search

somora unifies three sources behind one retrieval pipeline. Every search
(auto-injection or explicit `memory_search`) ranks across all three:

| Source | Where | Lifecycle | Source-tag in hits |
|---|---|---|---|
| **memory** | `~/.somora/agents/<name>/memory/*.md` | per-agent, short-term, deleted by Deep on promotion | `memory/<slug>` |
| **wiki** | `<vault>/<wiki-subfolder>/**/*.md` | shared, long-term, single source of truth | `wiki/<path>` |
| **vault** | rest of `<vault>` outside the wiki subfolder | user-managed, read-only from somora | `vault/<path>` |

A single `memory_search("garten")` call returns hits from all three,
ranked by hybrid score with per-source boosts (default: wiki 1.4×,
memory 0.85×, vault 0.65×). Curated wiki content ranks above raw memory
inbox content; both rank above unstructured vault notes.

This document covers the **memory inbox** — the per-agent layer. See
[wiki.md](wiki.md) for the wiki layer and [agents.md](agents.md) for
how vault binding works.

## Mental model — memory inbox

```
~/.somora/agents/<name>/memory/
├── *.md                          ← un-consolidated notes the agent has now
│
├── memory.db (+ -wal, -shm)      ← derived index of THIS agent's notes, rebuilt from .md if deleted
├── .deep-skip-cache.json         ← Deep's hash-cache (skipped files)
└── .dreams/                      ← REM extraction findings
    ├── <id>.dream.md             ← pending review
    └── processed/                ← resolved findings (audit trail)
```

The `.md` files are the source of truth. The SQLite index is derived —
delete `memory.db*` and it rebuilds from the `.md` files on next agent
init. Files survive `git`, `vim`, `rsync`, anything. The agent reads
them through the same pipeline regardless of who wrote them (you, the
agent itself via tools, REM extraction, or a sync from another machine).

The vault and the wiki are indexed **once per instance**, not once per
agent, in `~/.somora/index/shared.db`. The index belongs to the source,
not to the reader: every agent would embed exactly the same chunks, so
one copy serves them all, and one file-watcher on the vault replaces
one per agent. A new agent's first turn therefore costs nothing beyond
its own notes (before this, a new agent embedded the whole vault on its
first turn — 85 s on a 600-page vault). `shared.db` is derived too:
delete it and the server rebuilds it, seeding from an existing agent DB
when one holds the same embedding model, otherwise from disk.

**Updating from a version before the shared index** needs nothing from
you. On the first boot the server copies the vault/wiki rows out of the
largest agent DB into `shared.db` (seconds, no model call), sweeps the
vault in the background, and only then switches the agents over; until
that moment they keep answering from their own DB, which still holds
the old rows. Those old vault/wiki rows are left in place — they are
never read again and cost only disk. `GET /health` → `sharedIndex`
shows `building` during the switch and `ready` after
([api.md](api.md#get-health)).

The inbox is **volatile by design**. Files come in via REM or
`memory_write`; Deep consolidates them into the wiki and deletes the
source on Promote/Merge. A clean inbox means everything substantive
that's been observed is now in the wiki.

## How retrieval works

Two paths flow into every chat turn:

### 1. Auto-injection (always on)

The runtime builds an embedding query from the user's current message
plus the last few turns, runs hybrid search over the agent's own
memory index and the shared vault/wiki index as one candidate pool,
takes the top-N hits above a configurable score threshold, and prepends
them as a `<memory-context>` block to the system prompt.

```
<memory-context>
Background notes recalled from your memory for this turn. Source tags:
[memory/...] = your own short-term notes; [wiki/...] = shared long-term
wiki; [vault/...] = read-only vault content. These notes are recollection,
not observation: they can be outdated and say nothing about the current
state of the system. Call `memory_search` or `memory_get` to recall more.
Having these notes never replaces using a tool: if the user asks you to
check, run, read or change something, do it with the appropriate tool
rather than answering from these notes.

## Relevant hits for this turn

### [wiki/orte/main-house · score=0.42]
<chunk content>

### [memory/note-x · score=0.31]
<chunk content>
</memory-context>
```

The wording of that header is deliberate and load-bearing. An earlier
version said the notes were retrieved "(no tool call required)" and
called the wiki "authoritative". Measured 2026-07-22 on an identical
request, that phrasing cut kimi-k3's tool-call rate from 85% to 55%:
it reads as a general "you do not need tools here", and it puts recall
above the actual state of the system. Framing the notes as recollection
rather than observation restored the rate to 95%. If you customise this
block, keep that distinction.


The agent sees relevant notes (from any source) without having to call
a search tool.

Only query-dependent content goes in this block. The wiki topology
header is not part of it — it is stable for a whole session, so it sits
in the system prompt instead, where the provider's prefix cache holds
it. See [wiki.md](wiki.md#overview-block).

### 2. Tools (agent-driven, on demand)

When auto-injection isn't enough, the agent calls tools:

```
memory_search(query, limit?, minScore?, source?)
memory_get(reference)                              # full content of one item
memory_list(filter?)                                # browse own memory
memory_write(slug, content, frontmatter?)           # write to own inbox
memory_edit(slug, content)                          # modify existing
memory_delete(slug)                                 # remove
```

`memory_search` ranks across all three sources by default; pass
`source: 'memory' | 'wiki' | 'vault'` to constrain. `memory_get`
accepts a reference like `wiki/personen/familie-klein` returned by
search, fetches the full file content (vs. the snippet shown in
search hits).

Search snippets are chunks (~400 tokens, with overlap). Full files
go through `memory_get` — the agent decides when a snippet is
enough vs needing the whole page. Adjacent chunks share one paragraph
of overlap on purpose and may both match; a chunk whose lines lie
entirely inside another hit from the same file is folded into the
wider one before results are ranked, so the same section never lands
twice in the injected block.

### Hybrid retrieval mechanics

- **Vector** — local embeddings via ONNX (`Xenova/all-MiniLM-L6-v2`
  by default, 384-dim). Configurable in `config.yaml`. The model
  downloads **once per machine** to `~/.somora/models/transformers/`
  (a stable location that survives `somora update`) and is shared by
  every agent. Until that first download finishes — or if it ever
  fails — retrieval degrades gracefully to BM25-only; it upgrades to
  hybrid automatically once the model is present, and the next reindex
  backfills embeddings for anything indexed while it was unavailable.
  Whether the model is actually loaded is visible on `GET /health` as
  `memoryEmbedder` (`state: ok | loading | failed`, plus the error);
  a failed load is also logged once at boot as
  `memory.embedder_boot_failed`.
- **BM25** — SQLite FTS5 over chunk text. Tokenizer drops punctuation,
  lowercases everything (so `[[wiki-link]]` tokenizes to `wiki` and
  `link`).
- **Fusion** — min-max normalize each modality independently, weighted
  sum (default 0.7 vector + 0.3 BM25), apply per-source boost.
- **Auto-inject minScore** — default 0.35. Hits below this score don't
  appear in the inject block. Configurable.

Tunables live in `config.yaml`:

```yaml
memory:
  embedding:
    provider: local
    model: all-MiniLM-L6-v2
  chunking:
    targetTokens: 400
    overlapTokens: 80
  autoInject:
    queryTurns: 3            # current message + the 2 turns before it
    maxResults: 5
    minScore: 0.35
    maxTokens: 1500
    historyWeight: 0.3       # how much those turns steer the vector query
    historyWeightShort: 0.55 # … when the message has only 1–2 content words
    historyWeightEmpty: 0.8  # … when it has none ("das solltest du wissen oder?")
    historyTurnChars: 800    # head of each turn that goes into the blend
    shortQueryBm25Weight: 0.5 # BM25 share for a 1–2-word question (null = hybrid default)
  hybrid:
    vectorWeight: 0.7
    bm25Weight: 0.3
    slugMatchBoost: 1.5      # page whose slug names a query word (1 = off)
```

**How the query is built (since 2026-09-08).** The current message is
the query. The previous `queryTurns - 1` turns are context: embedded
separately and blended into the message embedding at
`historyWeight` — so the question decides and the conversation nudges.
Before, everything was one concatenated text, and a 46-character
question after two long answers about something else recalled that
something else. Two refinements, both measured on replayed real
sessions:

- The weight adapts to how much the message says. Three or more
  content words (everything that is not a filler word like "ok",
  "kannst", "mir", "so" — a built-in German + English stopword list,
  also dropped from BM25 queries): `historyWeight`. One or two ("und seine
  frau?"): `historyWeightShort`. None ("das solltest du aber wissen
  oder?"): `historyWeightEmpty` — the conversation is the topic.
- A message with a content word also runs on its own, and a chunk
  keeps the better of the two vector scores — each query vector's
  candidates normalised on their own first, because a long blend
  scores every page higher than a five-word question does. A page the
  question names outright is never pushed down by the history; a
  follow-up without a topic word still finds its page through the
  history.
- For a one- or two-word question ("wer ist walter?") the exact word
  match is the question, so BM25 gets `shortQueryBm25Weight` of the
  fusion instead of the hybrid default.
- `hybrid.slugMatchBoost` (all searches, not only auto-inject): a chunk
  whose slug contains a content word of the query is multiplied. The
  page ABOUT a person or thing rarely repeats its own name — the Walter
  page says "Walter" once, the family page four times — so BM25 alone
  ranks the mentions above the page; the name in the slug marks the
  canonical page.

The BM25 side sees the message only, with filler words removed
(`FTS_STOPWORDS` in `src/memory/retrieval.ts`, German and English) —
otherwise every page that says "was", "du" and "so" a lot outranked
the one page that says "walter". `POST /agents/<name>/memory/recall-preview`
runs exactly this path for a message plus a supplied history, which is
how the change was measured ([api.md](api.md#post-agentsagentmemoryrecall-preview)).

## Writing memory

Three ways content lands in the memory inbox:

1. **You edit `~/.somora/agents/<name>/memory/<slug>.md` directly.** A
   chokidar file-watcher re-indexes within ~1.5 s of save. The agent
   sees your edit on the next turn. Works with `vim`, VSCode, Obsidian,
   any editor that does atomic-rename writes.

2. **The agent writes it via tool.** `memory_write` (create or replace),
   `memory_edit` (modify existing, fail if missing), `memory_delete`
   (remove). Slugs are limited to lowercase `[a-z0-9_-]` so the agent
   can never accidentally write outside the memory directory.

3. **Via REM (the per-agent dream phase).** REM extracts facts from
   session transcripts and proposes `memory_write` / `memory_edit` /
   `memory_delete` findings. You approve via `dream_apply`; the
   underlying tool call writes the file. Nothing lands in memory
   without your say-so.

## File format

```markdown
---
slug: garten
description: Notes about the garden
tags: [home, places]
created: 2026-04-15
updated: 2026-05-01
---

# Garten

Der Garten ist ca. 2000 m², aufgeteilt auf vier zusammenhängende
Grundstücke …
```

Frontmatter is optional. `description` (if present) is shown by
`memory_list`. The write tools manage `created`/`updated`
automatically. Add an `wiki_promote: false` field to opt a single
memory file out of Deep evaluation:

```yaml
---
slug: scratch
wiki_promote: false        # stays in memory inbox forever; Deep ignores
---
```

Useful for scratchpads or transient state you don't want consolidated.

## How memory inboxes get drained

The inbox is not where things accumulate forever. Deep runs every 12h
(or via `dream_run({phase:'deep'})`) and decides per file:

- **Skip** — too thin, transient, already in wiki. File stays.
- **Promote** — new wiki topic. New page is created in the wiki.
  **Source memory file is deleted.**
- **Merge** — wiki page exists, new content integrated.
  **Source memory file is deleted.**

After a few Deep runs, your inbox typically contains only:
- Files Deep has skipped (cached by hash so they're not re-evaluated
  next run unless content changes)
- Recent additions since the last Deep run

See [dream-phases.md](dream-phases.md#phase-deep--memory--wiki) for the
full Deep mechanic. The inbox is intended to look mostly empty most of
the time — that's a sign Deep is working.

## Obsidian vault as a read source

Configure server-globally:

```yaml
obsidian:
  vault: ~/Documents/Vault/
wiki:
  enabled: true
  vaultSubfolder: somora    # → ~/Documents/Vault/somora/ becomes the wiki
  language: de              # de | en — headings, folders, index/log wording (wiki.md)
```

All agents share this single vault, and so do they share its index
(`~/.somora/index/shared.db`, see the mental model above). Vault notes
are recalled alongside each agent's own memory. Hits return them as
`vault/<path>` (slugs use `--` as path separator:
`Projects/Personal/Travel.md` → `Projects--Personal--Travel`).

Agents CANNOT write to the vault from somora — `memory_write` is hard-
scoped to per-agent memory directories; the wiki is written only by
Deep/Lucid (server-side workers, not agent-direct).

A few notes on vault integration:

- Dotfile directories (`.obsidian/`, `.trash/`, `.git/`) are skipped.
- The same hybrid retrieval ranks across both memory + wiki + vault.
- The wiki subfolder of the vault gets `source: 'wiki'`; the rest of
  the vault gets `source: 'vault'` so retrieval can boost differently.

## Tool surface

```
memory_search(query, limit?, minScore?, source?)
                              hybrid recall across memory + wiki + vault.
                              minScore defaults to 0 (agent gets best top-N).
memory_get(reference)         full content of a hit; reference like
                              'memory/<slug>' or 'wiki/<path>'.
memory_list(filter?)          list own memory inbox notes.
memory_write(slug, content, frontmatter?)
                              create or replace own-inbox note.
memory_edit(slug, content)    modify existing inbox note; fails if missing.
memory_delete(slug)           remove inbox note (idempotent).
```

`memory_*` write tools refuse non-memory paths by construction (slug
regex rejects `/`, uppercase, special chars). Agents cannot write
to wiki or vault directly — those go through Deep/Lucid.

The tools are exposed three ways:
- For `claude-cli` (and `grok-cli`): via a local stdio MCP server
  (`src/mcp/server.ts`).
- For `codex-cli`: as Codex dynamic tools on the app-server; somora
  serves each call from the in-process registry.
- For `openai-compatible` engines: as in-process function definitions
  via the agent's tool-call loop.

## Debug endpoints

When recall feels off, query the raw index directly:

```bash
# How many notes are indexed for this agent (across all sources —
# memory from the agent's own DB, wiki/vault from the shared index)
curl 'http://127.0.0.1:18737/agents/<name>/memory/notes' | jq '.count'

# State of the shared vault/wiki index: building | ready, files, chunks
curl 'http://127.0.0.1:18737/health' | jq '.sharedIndex'

# Is the embedding model loaded? "failed" = BM25-only for every agent
curl 'http://127.0.0.1:18737/health' | jq '.memoryEmbedder'

# Raw search — see exactly what would be auto-injected for a given query
curl 'http://127.0.0.1:18737/agents/<name>/memory/search?q=garten&minScore=0' \
  | jq '.hits[] | {source, slug, score, vecScore, bm25Score, text: .text[0:80]}'
```

This returns per-modality scores (`vecScore`, `bm25Score`) and the
chunk text that matched. Helpful when a recall feels off ("the agent
didn't see X even though I wrote about it yesterday") to confirm
whether the issue is at the index level (chunks not present) or higher
(score below threshold).

## See also

- [wiki.md](wiki.md) — the shared long-term wiki layer
- [dream-phases.md](dream-phases.md) — REM/Deep/Lucid mechanics
- [agents.md](agents.md) — per-agent setup including memory directory
