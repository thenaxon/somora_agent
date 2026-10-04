# Memory

Every agent keeps its own notes as plain Markdown files. somora finds the
relevant ones for each message and shows them to the agent before it
answers, so the agent remembers without being asked to look.

## What you get

- **Recall without asking.** Notes that fit the current message are
  added to every turn automatically.
- **One search over everything.** The agent's own notes, the shared
  [wiki](wiki.md) and your Obsidian vault are searched together.
- **Plain files.** A note is a `.md` file. Edit it with any editor, sync
  it, put it under version control.
- **Works offline.** The search index and the embedding model run on
  your machine.
- **A tidy inbox.** Notes are short-term. The Deep phase moves lasting
  knowledge into the wiki and removes the note.

## Try it

Tell the agent something worth keeping:

```
Remember that the garden gate code is 4711.
```

The agent writes a note with `memory_write`. Start a new session and ask
for the gate code: the note is recalled and the agent answers from it.

You can also write a note yourself. Save a file as
`~/.somora/agents/<name>/memory/gate-code.md` and the agent sees it on
its next turn.

## The three sources

Recall draws on three places. Every hit carries a tag that says where it
came from.

| Source | Where it lives | Who writes it | Tag in hits |
|---|---|---|---|
| **memory** | `~/.somora/agents/<name>/memory/*.md` | the agent, you, REM | `memory/<slug>` |
| **wiki** | `<vault>/<wiki-subfolder>/**/*.md` | Deep and Lucid | `wiki/<path>` |
| **vault** | the rest of your Obsidian vault | you | `vault/<path>` |

Memory is private to one agent and short-term. The wiki is shared by all
agents and long-term. The vault is yours: somora reads it and never
writes to it.

Curated content ranks first. By default a wiki hit counts 1.4 times, a
memory hit 0.85 times and a vault hit 0.65 times its score.

This page covers the memory inbox. The wiki has [its own page](wiki.md).

## Where notes live

```
~/.somora/agents/<name>/
├── memory.db (+ -wal, -shm)      ← search index of this agent's notes
└── memory/
    ├── *.md                      ← the notes
    ├── .deep-skip-cache.json     ← notes Deep looked at and left alone
    └── .dreams/                  ← REM findings
        ├── <id>.dream.md         ← waiting for review
        └── processed/            ← resolved findings
```

The `.md` files are the truth. `memory.db` is built from them: delete it
and it is rebuilt the next time the agent starts.

The vault and the wiki have one shared index for the whole instance,
`~/.somora/index/shared.db`. All agents read the same copy, so a new
agent costs nothing beyond its own notes. This index is rebuilt too when
you delete it. While it builds, `GET /health` reports
`sharedIndex: building`, afterwards `ready`.

## How recall works

There are two ways a note reaches the agent.

### Automatic recall

For every message somora searches all three sources and hands the best
hits to the agent as a `<memory-context>` block, placed in front of the
message:

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

Up to 5 hits with a score of at least 0.35 are included, capped at 1500
tokens. All three limits are settings.

> **Note:** The wording of the block header matters. It calls the notes
> recollection, not observation, and says they never replace a tool.
> Wording such as "no tool call required" makes smaller models stop
> using tools. If you change the block, keep that distinction.

### Recall on demand

When the automatic block is not enough, the agent searches itself with
`memory_search` and reads a whole note or page with `memory_get`. Search
hits are sections of about 400 tokens. `memory_get` returns the full
file.

All six tools are listed under [Tools](#tools).

## Writing notes

A note gets into the inbox in three ways.

1. **You save a file** in `~/.somora/agents/<name>/memory/`. It is
   indexed about 1.5 seconds later and the agent sees it on the next
   turn.
2. **The agent writes it** with `memory_write`, changes it with
   `memory_edit` or removes it with `memory_delete`.
3. **REM proposes it.** After a session REM extracts facts and proposes
   notes as findings. A finding becomes a note when it is approved with
   `dream_apply`.

Note names (slugs) are lowercase letters, digits, `-` and `_`. The write
tools accept nothing else, so an agent cannot write outside its own
memory folder. Agents cannot write to the wiki or the vault at all.

### Notes on a network share

The file watcher only sees files saved on the somora host. A vault on a
network share that you edit from another machine sends no file events.
Those files are picked up by a full sweep every 10 minutes
(`memory.rescanMinutes`) and at every server start.

If the share is unreachable when the server starts, the watcher retries
by itself with a growing delay, from 30 seconds up to 10 minutes.

## File format

```markdown
---
slug: garden
description: Notes about the garden
tags: [home, places]
created: 2026-04-15
updated: 2026-05-01
---

# Garden

The garden is about 2000 m², spread over four adjoining plots …
```

The frontmatter is optional. `description` is what `memory_list` shows.
The write tools maintain `created` and `updated`.

To keep a note in the inbox for good, add `wiki_promote: false`. Deep
then ignores it. This is useful for scratchpads:

```yaml
---
slug: scratch
wiki_promote: false
---
```

## How the inbox empties

The inbox is not meant to grow. Deep runs every 12 hours, or on demand
with `dream_run({phase:'deep'})`, and decides for each note:

| Decision | What happens | The note |
|---|---|---|
| **Skip** | Too thin, short-lived, or already in the wiki | stays |
| **Promote** | A new wiki page is created | is deleted |
| **Merge** | The content goes into an existing wiki page | is deleted |

A skipped note is remembered by its content and not looked at again
until it changes. A mostly empty inbox is the sign that Deep is working.

## Your Obsidian vault

Point somora at a vault and name the subfolder that holds the wiki:

```yaml
obsidian:
  vault: ~/Documents/Vault/
wiki:
  enabled: true
  vaultSubfolder: somora    # ~/Documents/Vault/somora/ becomes the wiki
  language: de              # de | en
```

All agents share this vault. The wiki subfolder is recalled as `wiki`,
everything else as `vault`. Folders that start with a dot (`.obsidian/`,
`.trash/`, `.git/`) are skipped.

In a vault hit, `--` separates folders:
`Projects/Personal/Travel.md` is `vault/Projects--Personal--Travel`.

## How recall ranks

You only need this section when recall finds the wrong notes.

Each hit gets a score from two searches that are combined:

- **Meaning.** A local embedding model (`all-MiniLM-L6-v2`) compares the
  meaning of the question with each section.
- **Words.** A full-text search (BM25) matches the exact words. Filler
  words such as "the", "was" or "du" are ignored, in English and German.

The two scores are scaled to the same range and added, 70% meaning and
30% words by default. The result is multiplied by the weight of its
source.

The embedding model is downloaded once per machine to
`~/.somora/models/transformers/`. Until it is there, or if loading
fails, recall runs on words alone and switches to both by itself later.
`GET /health` shows the state as `memoryEmbedder`.

### The question and the conversation

The current message is the question. The turns before it only nudge the
search, so two long answers about something else cannot outvote a short
question. How strong the nudge is depends on the message:

| The message has | History weight | Setting |
|---|---|---|
| three or more content words | 0.3 | `historyWeight` |
| one or two ("and his wife?") | 0.55 | `historyWeightShort` |
| none ("you should know that") | 0.8 | `historyWeightEmpty` |

A message with at least one content word is also searched alone, and
each section keeps the better of its two scores. A page the question
names is therefore never pushed down by the history.

For a question of one or two words the exact word is the question, so
the word search gets half of the weight (`shortQueryBm25Weight`).

### Which page wins

Four rules reorder the hits after scoring. They change nothing in the
index, so a new value applies from the next search.

| Setting | Default | What it does | When to change it |
|---|---|---|---|
| `slugMatchBoost` | 1.5 | Lifts a page whose name contains a word of the question. The page about a person rarely repeats the name, pages that mention the person do. | `1` switches it off. |
| `slugFullNameBoost` | 1.5 | Lifts a page again when the question contains every word of its name (two words or more). | `1` switches it off. |
| `logDemotion` | 0.5 | Ranks the wiki's monthly change log behind the pages it lists. Switched off automatically when the question is about the chronicle: a month, a year, or words like "when", "changed", "created". | Lower (`0.3`) if logs still win on questions about the thing itself. `1` treats logs like any page. |
| `pageSupport` | 0.3 | A page that matches in several sections gains from its next two sections, if they reach half of its best one. | Raise (`0.5`) when long pages lose to short mentions. Lower (`0.1`) or `0` when short notes lose to long pages. |

Ranking is sensitive to wording. Before you change a value, write down a
handful of your own questions with the page you expect, and compare the
ranks before and after with `memory_search`.

## Settings

All settings live in `config.yaml`. The values shown are the defaults.

```yaml
memory:
  embedding:
    provider: local
    model: all-MiniLM-L6-v2
  chunking:
    targetTokens: 400
    overlapTokens: 80
  autoInject:
    queryTurns: 3
    maxResults: 5
    minScore: 0.35
    maxTokens: 1500
    historyWeight: 0.3
    historyWeightShort: 0.55
    historyWeightEmpty: 0.8
    historyTurnChars: 800
    shortQueryBm25Weight: 0.5
  rescanMinutes: 10
  hybrid:
    vectorWeight: 0.7
    bm25Weight: 0.3
    slugMatchBoost: 1.5
    slugFullNameBoost: 1.5
    logDemotion: 0.5
    pageSupport: 0.3
wiki:
  search:
    boostWiki: 1.4
    boostMemory: 0.85
    boostVault: 0.65
```

| Setting | Meaning |
|---|---|
| `memory.embedding.model` | The local embedding model. |
| `memory.chunking.targetTokens` | Size of one indexed section. |
| `memory.chunking.overlapTokens` | How much neighbouring sections overlap. |
| `memory.autoInject.queryTurns` | The current message plus this many minus one earlier turns steer the search. |
| `memory.autoInject.maxResults` | Most hits in the automatic block. |
| `memory.autoInject.minScore` | Hits below this score are left out of the block. Raise to 0.5 or more if the block is noisy. |
| `memory.autoInject.maxTokens` | Size limit of the block. |
| `memory.autoInject.historyWeight` | How much earlier turns steer the search for a normal message. |
| `memory.autoInject.historyWeightShort` | The same for a message with one or two content words. |
| `memory.autoInject.historyWeightEmpty` | The same for a message with none. |
| `memory.autoInject.historyTurnChars` | How much of each earlier turn is used. |
| `memory.autoInject.shortQueryBm25Weight` | Share of the word search for a one- or two-word question. `null` uses `bm25Weight`. |
| `memory.rescanMinutes` | Full sweep of vault and wiki every N minutes. `0` switches it off. Unchanged files are skipped. |
| `memory.hybrid.vectorWeight` | Share of the meaning search. |
| `memory.hybrid.bm25Weight` | Share of the word search. |
| `memory.hybrid.slugMatchBoost` | See [Which page wins](#which-page-wins). |
| `memory.hybrid.slugFullNameBoost` | See [Which page wins](#which-page-wins). |
| `memory.hybrid.logDemotion` | See [Which page wins](#which-page-wins). |
| `memory.hybrid.pageSupport` | See [Which page wins](#which-page-wins). |
| `wiki.search.boostWiki` | Weight of a wiki hit. |
| `wiki.search.boostMemory` | Weight of a memory hit. |
| `wiki.search.boostVault` | Weight of a vault hit. |

## Tools

| Tool | What it does |
|---|---|
| `memory_search(query, limit?, minScore?, source?)` | Searches all three sources. `source` is `memory`, `wiki`, `vault` or `all` (default). `minScore` defaults to 0, so the agent gets the best hits whatever their score. |
| `memory_get(reference)` | Returns the full file behind a hit. The reference is what search returned, for example `memory/gate-code` or `wiki/personen/familie-klein`. |
| `memory_list(tag?, source?, pathPrefix?)` | Lists notes with name, description and tags. Default is the agent's own inbox. `source: "wiki"` with `pathPrefix` browses a wiki folder. |
| `memory_write(slug, content, frontmatter?)` | Creates or replaces a note in the agent's inbox. |
| `memory_edit(slug, content, frontmatter?)` | Changes an existing note. Fails when the note does not exist. |
| `memory_delete(slug)` | Removes a note. Removing a note that is not there is not an error. |

Neighbouring sections of a file overlap on purpose and can both match.
A section that lies completely inside another hit of the same file is
folded into it, so the same text never appears twice in the results.

The tools reach the model differently per engine: through a local MCP
server for `claude-cli` and `grok-cli`, as dynamic tools for
`codex-cli`, and as function definitions for `openai-compatible`
engines.

## When recall feels off

Ask the index directly. Replace `<name>` with the agent.

```bash
# How many notes are indexed for this agent, across all sources
curl 'http://127.0.0.1:18737/agents/<name>/memory/notes' | jq '.count'

# State of the shared vault and wiki index: building | ready
curl 'http://127.0.0.1:18737/health' | jq '.sharedIndex'

# Is the embedding model loaded? "failed" means words-only search
curl 'http://127.0.0.1:18737/health' | jq '.memoryEmbedder'

# What a search returns, with the score of each of the two searches
curl 'http://127.0.0.1:18737/agents/<name>/memory/search?q=garden&minScore=0' \
  | jq '.hits[] | {source, slug, score, vecScore, bm25Score, text: .text[0:80]}'
```

If the note is missing from the search, it is not indexed. If it is
there with a low score, it fell below `minScore`.

Two log lines to look for: `memory.embedder_boot_failed` when the
embedding model could not be loaded at start, and `memory.watcher_retry`
/ `memory.watcher_recovered` when the vault was unreachable.

`POST /agents/<name>/memory/recall-preview` runs the automatic recall
for a message and a history you supply, without starting a turn. Use it
to compare settings.

## See also

- [Wiki](wiki.md): the shared long-term layer, and the overview block
  that tells agents which pages exist
- [Dream phases](dream-phases.md): REM, Deep and Lucid in detail
- [Agents](agents.md): per-agent setup
- [Cache strategy](cache-strategy.md): why the memory block sits in
  front of the message and not in the system prompt
- [API](api.md): `GET /health` and the memory routes
