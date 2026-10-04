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
    ├── infrastruktur/, orte/, …       ← the shipped template, see "Folders"
    ├── _struktur.md                   ← the folders and what lives in them
    └── logs/
        └── YYYY-MM.md                 ← monthly Deep audit log
```

The folder names, section headings and the wording of index and log
follow `wiki.language` (`de`, the default, or `en` — see
[Language](#language)). The tree above is the German set; with `en`
it reads `people/`, `projects/`, `knowledge/`, `places/`.

## Why a separate layer

Three reasons memory and wiki need to be separate:

**Multi-agent.** Each agent has its own conversation history and its
own atomic observations. But a fact like "Bea is the user's spouse"
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
`wiki_edit` / `wiki_create` / `wiki_delete` / `wiki_move` tools after you OK each
step. Outside the loop, no agent can write to the wiki.

See [dream-phases.md](dream-phases.md#phase-lucid--wiki-cleanup) for
the full flow + loop discipline rules.

### By you (manually in Obsidian)

The wiki is just markdown. Open Obsidian, edit a page, save. somora's
file-watcher re-indexes the change — once, into the shared vault/wiki
index every agent reads ([memory.md](memory.md#where-notes-live)).
Deep and Lucid will respect your edit on next run (mtime check before
writing — they back off on conflict).

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

- **Spouse:** Dr. Bea Klein (* 03.02.1984)
- **Sister:** Eva Klein (* 08.12.1973)
- …

## Zeitleiste

- 1941-04-30 — Ada Klein born
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

Deep prefers writing pages with four section headers, named by
`wiki.language`:

| `de` (default) | `en` | content |
|---|---|---|
| `## Aktueller Stand` | `## Current state` | prose summary, current state of the topic |
| `## Eigenschaften` | `## Properties` | bullet-list of stable facts |
| `## Zeitleiste` | `## Timeline` | dated entries (additions, changes, milestones) |
| `## Notizen` | `## Notes` | miscellaneous observations, cross-refs |

You can introduce other sections; Deep respects existing structure on
Merge. The conventions exist so multi-agent reads have a predictable
shape.

### Wikilinks

Use Obsidian's `[[wiki-path]]` syntax for cross-references between
pages. Example: `Bea ist die [[personen/familie-klein|Ehefrau]]`.

Wikilinks are indexed as plain text (the brackets are tokenized away),
so a search for `garten` finds pages mentioning `[[orte/garten]]`. They
are NOT followed transitively — `memory_search` doesn't walk graph
edges. The agent reads the wikilink in a hit and decides whether to
fetch the referenced page via `memory_get`.

## index.md

Auto-regenerated after every Deep run. Contains:

- Header with last-update timestamp
- Sections per subfolder (`## Personen`, `## Projekte`, … — the
  capitalised folder names)
  - One bullet per page with the slug + first-line description
- `## Letzte Updates` (`## Recent updates` with `wiki.language: en`) —
  last 10 Promote/Merge entries from the current run

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

## Folders: kind, not topic

A folder says what **kind** of page lives in it — a person, a project,
a device, a rule — never what a page is about. Topics live in the page
body, in its `[[links]]` and in `index.md`. Kept this way, a wiki with
a thousand pages still has a dozen folders; without the rule, five
months of Deep runs produced 40 folders, a 300-page `wissen/` catch-all
and the same page name living in several folders at once.

somora ships one folder template per wiki language. Deep proposes it,
your wiki's real folders win: a folder you or Deep created is listed as
it is, the template only fills the gaps.

| `de` | `en` | What lives there |
|---|---|---|
| `personen/` | `people/` | one page per human |
| `unternehmen/` | `companies/` | one page per company, firm, supplier |
| `projekte/` | `projects/` | one page per bounded undertaking; dated work reports are timeline entries on it, not pages |
| `infrastruktur/` | `infrastructure/` | devices, hosts, services, provider accounts — subfolders `geraete/hosts/dienste/konten` (`devices/hosts/services/accounts`) |
| `finanzen/` | `finances/` | accounts, portfolio, crypto, real estate as investment, loans — one subfolder per kind |
| `besitz/` | `possessions/` | things owned that are not investments |
| `orte/` | `places/` | houses, sites, cities, destinations |
| `ereignisse/` | `events/` | what happened when |
| `wissen/` | `knowledge/` | subject knowledge tied to no person or company — `konzepte/anleitungen/vergleiche` (`concepts/how-tos/comparisons`) |
| `regeln/` | `rules/` | directives, preferences, agreements |
| `agenten/` | `agents/` | agent profiles only, no work reports |
| `privat/` | `personal/` | interests, hobbies, pets, health, living |

At most one level of subfolders. The template with its rationale per
folder lives in `src/wiki/taxonomy.ts`; adding a language means adding
an entry there.

### The structure file

`_struktur.md` (`_structure.md` with `en`) in the wiki root is the
wiki's own memory of what its folders mean: one row per folder with
its purpose, who described it (`template`, `deep`, `user`) and since
when. Deep writes it after a run in which a folder was created or
found undescribed; you edit the sentences in Obsidian like any page —
a person's wording is never overwritten. Folders on disk nobody has
described yet appear as "(no description yet)" until you or the
migration fill them in. The file is not a wiki page: the index and the
memory search skip it.

### How Deep files a page

On every run Deep is shown the **wiki map**: every folder that exists
with its purpose and page count, then the template folders that do not
exist yet, then the rules. It files a new page into one of the
described ones — a grown folder nobody has described is not a home
until someone describes it. Only when no kind fits may it create a folder, and then it has to say in one
sentence what kind of page lives there — that sentence lands in the
structure file and in every later map. A new folder without a purpose,
or one deeper than a subfolder, is refused and the memory note waits
for the next run.

Before a page is created, its name is checked against the **whole**
wiki, not only the exact path: when a page with that name already
exists in another folder, Deep merges into it instead of creating a
twin. Names that already exist in several folders are noted in the
structure file for the migration.

A page whose name extends an entity page's name — a note filed as
`acme-kapitalruecklage` while `unternehmen/acme` exists — is
usually a detail of that entity: Deep is asked again with the entity
page in full and merges the note into it, unless it insists the page
is a thing of its own.

`wiki.defaultSubdirs` from earlier versions is still read, but only
shapes the example slugs in the prompts; the template above replaces
the list.

### Migrating a grown wiki

A wiki that grew before the template keeps working as it is: the map
only changes where **new** pages go. Moving the existing pages onto
the template is a separate, deliberate process that nothing starts by
itself — you trigger it, you read what it would do, you approve it in
groups, and it takes a full copy of the wiki before it moves a file.
Four steps, from the shell on the somora host — `somora wiki migrate`
walks you through them, and each is also a subcommand with flags so a
script, or an agent that read this page, can drive it — or over HTTP
([api.md](api.md#post-wikimigrationplan)), which is what the command
calls:

```
somora wiki migrate                 guided: plan → judge → approve → dry run → run
somora wiki migrate plan            step 1, prints the plan id
somora wiki migrate judge <id>      step 2, waits for the model, lists the groups
somora wiki migrate status <id>     the groups and what is approved
somora wiki migrate approve <id> --action move --action fold --twins
somora wiki migrate approve <id> --group fold:projekte/somora --dismiss
somora wiki migrate dry-run <id>    step 4a, writes dry-run.md, touches nothing
somora wiki migrate run <id> --confirm "move my wiki"
somora wiki migrate undo <id>       the backup back over the wiki (the current
                                    wiki is moved aside, nothing is deleted)
somora wiki migrate relink <id>     point links and related: at the moved pages
                                    again (runs before .07 missed related:)
```

The words "move my wiki" are the one thing an agent must not supply on
its own: it may plan, judge, read the groups out and record your
approvals, and it starts the real run only after you said the words.

1. **Plan** — `POST /wiki/migration/plan` reads the wiki and writes a
   plan under `~/.somora/wiki-migration/<id>/plan.md`: folders a rule
   would move (a folder named `aktien` belongs in `finanzen/depot`),
   page names that exist in several folders, dated work reports and
   the project they seem to belong to. Nothing is touched.
2. **Judge** — `POST /wiki/migration/refine` has the Lucid model look
   at **every** page — with the map and the names of the entity pages
   in front of it — and answer per page: keep, move (with a new file
   name when the old one is a date, not a thing), fold into an existing
   page, or unclear. A rule's proposal is only a proposal; no page
   moves on a folder name alone. The answers land in `refined.md`,
   grouped by what would happen: "move 12 pages to
   infrastruktur/geraete", "fold 30 pages into projekte/realtimevoice".
   Still nothing is touched.
3. **Approve** — `POST /wiki/migration/plans/<id>/approve` marks groups
   (or every group of one action, or the same-name unions) approved or
   dismissed. What you do not approve stays where it is.
4. **Execute** — `POST /wiki/migration/plans/<id>/execute`. The default
   is a dry run: it walks the approved steps and writes `dry-run.md`,
   nothing else. A real run needs `{"dryRun": false, "confirm": "move
   my wiki"}` and then, in this order: a full copy of the wiki into
   `~/.somora/wiki-migration/<id>/backup-<time>/` (verified by file
   count — no copy, no run); the approved moves (file, frontmatter
   `slug`); the approved folds — the model writes the entry that
   carries the page's substance into the target (a timeline line for a
   dated report, a few lines under the fitting heading for a detail),
   the original is kept in full under `logs/berichte/` (`logs/reports/`
   with `en`) with `merged_into` in its frontmatter — that archive is
   left out of the search index, its substance now lives in the target
   pages; the approved unions
   of same-name pages — the copy the model gave a home survives, the
   model writes its merged body, the other copy goes to the same
   archive; every `[[link]]` in the wiki pointed at the new places;
   empty folders removed; the structure file stamped with the template
   version; `index.md` and the monthly log regenerated; the search
   index swept. Every step is recorded with its outcome in
   `execution-<time>.md`; a failed step never stops the others.

To undo a run: `somora wiki migrate undo <id>` moves the current wiki
folder aside (`<wiki>.before-undo-<time>`), copies the backup to the
wiki's place and sweeps the search index. The plan and its files stay
under `~/.somora/wiki-migration/` for as long as you keep them.

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

The graph toggles between **This page** (the current page, what it links
to, and what links to it — plus the edges among those neighbours) and
**Whole wiki** (every page at once, capped at the 400 most-connected).
Scroll to zoom, drag the background to pan, and the expand button gives
the graph the full window — a dense whole-wiki view only becomes legible
once you can zoom into a corner and read the labels. Clicking a node
opens that page. `index.md` is excluded from both scopes: it links to
every page by construction, so including it turns the graph into a star
around one node and adds hundreds of edges that say nothing about how
the knowledge connects.

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
  language: de                           # de | en — see "Language" below

  deep:
    enabled: true
    intervalHours: 12
    model: opus

  lucid:
    enabled: true
    intervalDays: 7
    model: opus
    requireApproval: true
    maxCallsPerTurn: 3                   # wiki_* calls per turn in a review loop

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

## Language

`wiki.language` decides what the wiki's scaffolding is called and
which language Deep writes page prose in. It covers:

- the section headings of new pages (table above),
- the `type:` values Deep picks (`person / projekt / konzept / ort /
  werkzeug` vs `person / project / concept / place / tool`),
- the folder template ("Folders" above) and the examples in the Deep
  and Lucid prompts and the `wiki_*` tool descriptions,
- the wording of `index.md` (`Letztes Update … von Deep` / `Sonstiges`
  / `Letzte Updates` vs `Last update … by Deep` / `Other` / `Recent
  updates`) and of the monthly log (`# Wiki-Log Mai 2026` vs `# Wiki
  log May 2026`, promotion lines),
- the instruction to the Deep worker to write titles, headings and
  prose in that language.

`de` is the default; an installation that never sets the key keeps
producing pages that match its existing ones. Set `en` for an English
wiki. Switching later changes only new scaffolding: Merge keeps the
headings a page already has, existing pages are not translated, and
memory notes and search are language-neutral and unaffected. Names and
terms are quoted as they appear in the memory, whatever the wiki
language.

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
