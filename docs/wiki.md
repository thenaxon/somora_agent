# Wiki Layer

> Long-term, structured, shared knowledge that all agents read but only
> Deep and Lucid (and you, in Obsidian) write. Lives in a designated
> subfolder of an Obsidian vault.

## What it is

The wiki is somora's long-term memory. While each agent has its own
private **memory inbox** (`~/.somora/agents/<name>/memory/*.md`), the
wiki is **one shared knowledge base** that every agent can read from
and contribute to via the Deep dream phase.

```
<obsidian-vault>/
├── … your normal Obsidian notes (somora reads these as 'vault' source) …
└── <wiki-subfolder>/                  ← THIS is the wiki
    ├── index.md                       ← auto-regenerated topology
    ├── personen/
    │   ├── familie-klein.md
    │   ├── max-meier.md
    │   └── …
    ├── projekte/
    │   ├── somora.md
    │   ├── internal-cms.md
    │   └── …
    ├── wissen/
    │   ├── runpod.md
    │   └── …
    ├── orte/, infrastruktur/, …       ← subfolders Deep invents on demand
    └── logs/
        └── YYYY-MM.md                 ← monthly Deep audit log
```

## Why a separate layer

Three reasons memory and wiki need to be separate:

**Multi-agent.** Each agent has its own conversation history and its
own atomic observations. But a fact like "Lisa is the user's spouse"
is not agent-private — it's something every agent should know. The
wiki is where shared facts live.

**Curation.** Memory inboxes accumulate raw observations ("user
mentioned a new family car arrived"). The wiki is the place where
those observations
get integrated into a coherent picture (`personen/familie-klein` is
updated; the source memory entry is deleted). One source of truth per
topic.

**You-edit-able.** The wiki is plain markdown in your Obsidian vault.
You can read it in Obsidian, edit it like any note, link it from other
vault content. somora respects your edits (mtime-aware writes — Deep/Lucid
back off if you've changed a page since they last saw it).

## How wiki pages are written

### By Deep (Memory → Wiki consolidation)

Every 12h or via `dream_run({phase: 'deep'})`, Deep iterates each agent's
memory inbox, decides per file whether to skip / promote / merge, and
applies the structured fix verbatim. After Promote/Merge the source
memory file is deleted.

See [dream-phases.md](dream-phases.md#phase-deep--memory--wiki) for
mechanics.

### By Lucid + an agent in a `dream_review` loop

Every 7 days or via `dream_run({phase: 'lucid'})`, Lucid scans the
existing wiki for objectively-verifiable issues (contradictions, dead
refs, missing pages, link suggestions) — max 8 findings per run. Each
finding is **informational only** — the actual editing happens in a
conversational `dream_review` loop where you walk the findings with
one of your agents and the agent writes changes via loop-scoped
`wiki_edit` / `wiki_create` / `wiki_delete` tools after you OK each
step. Outside the loop, no agent can write to the wiki.

See [dream-phases.md](dream-phases.md#phase-lucid--wiki-cleanup) for
the full flow + loop discipline rules.

### By you (manually in Obsidian)

The wiki is just markdown. Open Obsidian, edit a page, save. somora's
file-watcher re-indexes the change. Deep and Lucid will respect your edit
on next run (mtime check before writing — they back off on conflict).

## Page format

Every wiki page is markdown with YAML frontmatter:

```markdown
---
slug: personen/familie-klein
type: family
created: 2026-05-08
updated: 2026-05-09
sources:
  - alpha/familie-klein              # which agent's memory contributed
  - beta/people
related:
  - wissen/family-cars
  - orte/main-house
---

# Familie Klein

## Aktueller Stand

Familie around Sarah Klein: spouse, sister, father, niece and
two dogs. This page bundles the key people …

## Eigenschaften

- **Spouse:** Dr. Lisa Klein (* 03.02.1984)
- **Sister:** Eva Klein (* 08.12.1973)
- …

## Zeitleiste

- 1941-04-30 — Hans Klein born
- 1973-12-08 — Eva Klein born
- …

## Notizen

- Querverweise: [[wissen/family-cars]], [[orte/main-house]]
```

### Frontmatter fields

| Field | Required | Purpose |
|---|---|---|
| `slug` | yes | Wiki path without `.md`, matches the file's location. Stable identifier. |
| `type` | yes | Loose category (`person`, `projekt`, `konzept`, `ort`, `werkzeug`, …). Deep may invent new types. |
| `created` | yes | ISO date when the page was first created. |
| `updated` | yes | ISO date of last modification. Deep refreshes on every Promote/Merge. |
| `sources` | optional | List of `<agent>/<memory-slug>` strings — which agent inboxes contributed content. |
| `related` | optional | List of wiki-paths (without `.md`) for cross-references. |

### Section conventions (soft)

Deep prefers writing pages with these section headers (German, since
the user is German-speaking by default):

- `## Aktueller Stand` — prose summary, current state of the topic
- `## Eigenschaften` — bullet-list of stable facts
- `## Zeitleiste` — dated entries (additions, changes, milestones)
- `## Notizen` — miscellaneous observations, cross-refs

You can introduce other sections; Deep respects existing structure on
Merge. The conventions exist so multi-agent reads have a predictable
shape.

### Wikilinks

Use Obsidian's `[[wiki-path]]` syntax for cross-references between
pages. Example: `Lisa ist die [[personen/familie-klein|Ehefrau]]`.

Wikilinks are indexed as plain text (the brackets are tokenized away),
so a search for `garten` finds pages mentioning `[[orte/garten]]`. They
are NOT followed transitively — `memory_search` doesn't walk graph
edges. The agent reads the wikilink in a hit and decides whether to
fetch the referenced page via `memory_get`.

## index.md

Auto-regenerated after every Deep run. Contains:

- Header with last-update timestamp
- Sections per subfolder (`## Personen`, `## Projekte`, …)
  - One bullet per page with the slug + first-line description
- `## Letzte Updates` — last 10 Promote/Merge entries from the current run

```markdown
# somora-Wiki Index

Letztes Update: 2026-05-09 07:45 UTC von Deep

## Personen
- [[personen/familie-klein]] — Family around Sarah Klein …
- [[personen/anna]] — Niece, daughter of Eva …

## Projekte
- [[projekte/internal-cms]] — Internal CMS used by …
- [[projekte/release-pipeline]] — CI/CD across multiple repos …

## Wissen
- [[wissen/family-cars]] — Notes on the household vehicle fleet …

## Letzte Updates
- 2026-05-09: [[personen/familie-klein]] — familie-klein aktualisiert: spouse + birthday
```

The index is the **topology header** Lucid and REM see — they know what
subfolders exist and what slugs are taken without loading every page
body.

## Subfolders Deep uses by default

```yaml
defaultSubdirs: ['personen', 'projekte', 'wissen']
```

Plus on-demand subfolders Deep invents when a topic doesn't fit:

- `orte/` — physical places (gardens, houses, addresses)
- `infrastruktur/` — hardware, network nodes
- `agenten/` — agents themselves (when they get their own page)
- `skills/` — documented capabilities
- whatever else makes sense for a given topic

You can pre-create subfolders too — Deep walks the existing layout when
it builds the wiki summary, so existing structure influences future
Promote decisions.

## How agents read the wiki

Three paths feed a chat turn:

1. **Auto-injection** runs hybrid search (vector + BM25) across all three
   memory layers. With wiki enabled, hits from `source: 'wiki'` get a
   1.4× boost (configurable) so curated wiki pages outrank noisier
   memory chunks. Auto-injected wiki content shows up as
   `[wiki/<path> · score=N.NN]` in the `<memory-context>` block.

2. **Wiki overview block** puts a shortened `index.md` into the system
   prompt — so the agent sees the wiki topology even when no specific
   page matches, and can decide "is there a wiki page I should fetch?"
   It is built once, on a session's first turn, and then frozen for the
   life of that session (see [Overview block](#overview-block)).

3. **Explicit tool calls** — `memory_search` or `memory_get` with a
   `wiki/<path>` reference. Agents fetch full pages on demand.

Wiki paths in references look like `wiki/personen/familie-klein` — the
`wiki/` prefix is the source-tag, the rest is the slug.

### Overview block

The overview answers one question: *what topics does the wiki hold?*
Content comes from search and `memory_get`, never from here.

It lives in the **system prompt**, not in the per-turn memory block. The
content is identical on every turn, so putting it in the cached prefix
costs it once per session instead of once per turn — and on the
`openai-compatible` engine, which rebuilds the whole conversation from
the transcript, once instead of once *per turn of history*.

It is also **frozen for the session**. Deep rewrites `index.md` every
~12 h; re-reading it mid-session would shift a block that sits in front
of the entire conversation and invalidate the provider's prefix cache.
A session therefore keeps the wiki map it started with. Recall stays
current regardless — auto-injection and `memory_search` always hit the
live index. To pick up a rewritten map, start a new session or `/reset`
the current one; both re-read `index.md` on the next turn.

`index.md` rarely fits the budget, so it degrades through four stages.
Each one describes the **whole** wiki; they differ in resolution:

| Stage | Content | Used when |
|---|---|---|
| 1 | `index.md` verbatim | fits `overviewMaxChars` |
| 2 | sections + pages + clipped descriptions | small wiki |
| 3 | sections + bare page links | medium wiki |
| 4 | section names + page counts | large wiki |

Stage 4 deliberately reports `- Projekte (60)` rather than listing 30 of
the 258 pages. A partial page list reads as complete and stops the agent
from searching; a section with a count tells it what to search *for*.

Raise `overviewMaxChars` to keep page names visible on a larger wiki —
the cost is a bigger constant prefix, paid once per session.

## Web explorer

The web client has a read-only wiki browser behind the **wiki** tile in
the app dock. Three columns:

```
┌──────────┬────────────────────────┬───────────────┐
│ tree     │ # somora Voice/TTS     │   graph       │
│ wissen/  │                        │      o        │
│ konzepte/│ …                      │     / \       │
│ projekte/│ [[somora]] [[voice]]   │    o   o      │
│ personen/│                        │ backlinks:    │
│ bugs/    │                        │ · projekte/x  │
└──────────┴────────────────────────┴───────────────┘
```

`[[wikilinks]]` are clickable and navigate inside the window. Targets
that resolve to no page render as **broken** instead of vanishing — a
wiki with gaps should look like one. Resolution follows Obsidian's
rules, in order: exact slug, case-insensitive slug, then a unique
basename. A basename matching several pages stays unresolved rather
than picking one; a wrong edge reads as a real relationship and is
worse than a missing one.

The graph toggles between **local** (the current page, what it links
to, and what links to it — plus the edges among those neighbours) and
**global** (the whole wiki, capped at the 400 most-connected pages).
Clicking a node opens that page. `index.md` is excluded from both: it
links to every page by construction, so including it turns the graph
into a star around one node and adds hundreds of edges that say nothing
about how the knowledge connects.

Read-only is deliberate. Deep and Lucid own the wiki files; an editor
in the browser would race them mid-run.

### Endpoints

```http
GET  /wiki/status                            # { enabled, root? }
GET  /wiki/tree                              # folder tree + page titles
GET  /wiki/page?slug=konzepte/voice-tts      # body + frontmatter + links
GET  /wiki/graph?scope=local&slug=<slug>     # neighbourhood
GET  /wiki/graph?scope=global                # whole wiki
POST /wiki/refresh                           # drop the cache, re-scan
```

Pages are addressed by **slug, never by path**. A request can only name
pages the index already found under the wiki root, so `../`, absolute
paths and symlink escapes are rejected by construction rather than by a
filter someone has to keep correct.

The index caches for 10 seconds, then re-stats the tree and re-parses
only files whose mtime or size moved. Edits made in Obsidian appear
within that window; the refresh button skips it.

## Configuration

```yaml
# ~/.somora/config.yaml
wiki:
  enabled: true                          # master toggle
  vaultSubfolder: somora                 # <vault>/somora/ becomes the wiki

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
    boostWiki: 1.4                       # search-rank multiplier per source
    boostMemory: 0.85
    boostVault: 0.65
    overviewMaxChars: 4000               # overview-block budget (see above)
    overviewTopNSlugs: 30                # max sections in the stage-4 view

obsidian:
  vault: /path/to/your/vault
```

`obsidian.vault` is required for the wiki to work — the wiki is a
subfolder of your Obsidian vault. If you don't use Obsidian, you can
still point `vault` at any directory; somora doesn't require Obsidian
itself, just the markdown-vault layout.

## Multi-agent participation

By default, every agent's memory inbox feeds the wiki via Deep. Opt
individual agents OUT in their `agent.yaml`:

```yaml
rem:
  enabled: true
  participate_in_wiki: false   # REM still runs; Deep won't see this agent's inbox
```

Useful for scratch agents, sandbox personas, or anything you don't want
contributing to shared knowledge.

## Sync across machines

The wiki is plain markdown in your Obsidian vault. Use whatever sync
mechanism you already use for Obsidian — iCloud, Syncthing, git, etc.
somora is single-host; the wiki sync is your responsibility.

Memory inboxes (`~/.somora/agents/<name>/memory/`) are intentionally
NOT designed for sync. They're ephemeral inboxes that get drained by
Deep — sync them and you risk Deep on machine A consuming a memory
file that machine B has just modified.

## What the wiki is not

**Not your raw notes.** Your Obsidian vault outside the wiki subfolder
is yours alone. somora reads it (auto-injection sees `source: 'vault'`
hits) but never writes to it. Deep won't promote vault content into the
wiki.

**Not a chat log.** Daily-log-shaped memory files are routinely skipped
by Deep ("transient task list, scratchpad, or daily log"). The wiki
captures stable knowledge, not session transcripts.

**Not auto-fixed beyond Deep + Lucid.** Lucid surfaces objective
issues; you walk them with an agent in a `dream_review` loop and the
agent writes the fixes after you OK each step. If you want bigger
restructuring (split a page in two, move between subfolders), do it
manually in Obsidian — Lucid intentionally stays out of structural
changes.

## See also

- [dream-phases.md](dream-phases.md) — REM/Deep/Lucid mechanics
- [memory.md](memory.md) — the per-agent memory inbox
- [agents.md](agents.md) — per-agent config including `participate_in_wiki`
