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

2. **Wiki overview block** prepends the index.md (capped at 1500 chars)
   to every turn — so the agent sees the wiki topology even when no
   specific page matches. Lets the agent decide "is there a wiki page
   I should explicitly fetch?"

3. **Explicit tool calls** — `memory_search` or `memory_get` with a
   `wiki/<path>` reference. Agents fetch full pages on demand.

Wiki paths in references look like `wiki/personen/familie-klein` — the
`wiki/` prefix is the source-tag, the rest is the slug.

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
    overviewMaxChars: 1500               # auto-inject wiki-overview cap
    overviewTopNSlugs: 30                # for very large wikis

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
