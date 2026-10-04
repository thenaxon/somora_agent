# Dream Phases

While you are not chatting, somora tidies up what was said. Three
background jobs, called REM, Deep and Lucid, turn conversations into
notes, notes into wiki pages, and keep the wiki free of contradictions.
Each job has its own model, its own rhythm and its own rule for what
needs your approval.

## What you get

- **Nothing said in passing is lost.** REM reads finished conversations
  and proposes the facts worth keeping.
- **You decide what is remembered.** REM and Lucid only propose. A note
  or a wiki fix happens when you or the agent approve it.
- **A wiki that writes itself.** Deep moves approved notes into the
  shared wiki without asking, so the inbox stays small.
- **A wiki that stays consistent.** Lucid finds contradictions,
  duplicates, dead links and misfiled pages.
- **Cost under control.** Each phase runs on the model you name for it,
  never silently on the chat model.
- **Outages are survived.** Every phase can have backup models, and REM
  catches up by itself after a failure.

## Set it up

REM is switched on per agent, in `~/.somora/agents/<name>/agent.yaml`:

```yaml
rem:
  enabled: true
  model: <alias>          # required: a model alias or provider/modelId
```

Deep and Lucid are switched on for the whole instance, in `config.yaml`.
They need the wiki, and the wiki needs an Obsidian vault:

```yaml
obsidian:
  vault: ~/Documents/Vault/
wiki:
  enabled: true
  deep:
    model: <alias>        # required
  lucid:
    model: <alias>        # required
```

Restart somora. Then chat with the agent, leave it alone for half an
hour and ask: "Did you dream anything?" The agent calls `dream_list` and
walks you through the findings.

## The three phases

| | REM | Deep | Lucid |
|---|---|---|---|
| **Job** | Conversation to memory notes | Memory notes to wiki pages | Review of the wiki |
| **Scope** | One agent | All agents | The shared wiki |
| **Runs** | After 30 minutes without chat | Every 12 hours | Every 7 days |
| **Approval** | Every finding | None | Every finding |
| **Result** | Findings in `dream_list` | New and updated wiki pages | Findings in `dream_list` |
| **Configured in** | `agent.yaml`, `rem` | `config.yaml`, `wiki.deep` | `config.yaml`, `wiki.lucid` |
| **Good model** | Small or local | Strong | Strong |

Facts come in through REM, are consolidated by Deep and are checked by
Lucid. No phase starts another one: Deep works on the notes that are on
disk, whoever wrote them.

### Which models can do the work

A worker model can sit on an `openai-compatible` provider, on
`claude-cli` or on `codex-cli`. A Claude or ChatGPT subscription is
therefore enough for all three phases. A model on `grok-cli` cannot be a
worker for any phase.

## REM

REM reads what was said in a session since its last visit and proposes
memory notes for the agent it belongs to.

### What REM does

It looks for facts the person stated: decisions, changes, preferences.
It leaves out jokes, passing states and what the agent's notes or the
wiki already say. Each fact becomes a finding that waits for review.
Nothing is written to memory before a finding is approved.

### When REM runs

| Trigger | What happens |
|---|---|
| **Idle timer** | After `idleMinutes` without a chat message (default 30) REM reads the unread sessions of the agent, up to eight in one go. |
| **`/reset YES`** | The session is archived and REM reads the part of it that it has not read yet. |
| **`dream_run({phase: 'rem'})`** | Starts the idle cycle at once. Answers `started`, `busy` or `nothing_to_do`. |
| **`POST /agents/:agent/dream/run-rem`** | The same over HTTP. |

How the idle cycle goes:

1. A run that was paused earlier is finished first.
2. Otherwise the most recently active session with unread messages is
   read. Archived sessions count: archiving says you are done with a
   conversation, not that it should be forgotten.
3. After a successful run the next unread session follows. The cycle
   ends at the first run that fails. A session whose last attempt
   failed is picked last, so it cannot hold up the others.

A chat message to the agent pauses an automatic run. It resumes at the
next idle time. A run started by `/reset YES` is not paused.

REM comes back by itself when work is left over: a failed run, a paused
run, an unread session. It retries after one, two, four and eight idle
intervals and then stays quiet until the next chat message. A failed
stretch stays on record until a run has actually read it.

Messages inside a Lucid review (`dream_review` start to end) are
skipped. What you clarify there goes straight into the wiki.

### The REM worker

`rem.model` is required when REM is enabled. REM never falls back to
the agent's chat model or chat fallback, so a run cannot land on an
expensive model by accident. A small local model is good enough for
this job and REM runs often. A strong hosted model works too.

`rem.fallback` names one backup worker or an ordered list:

```yaml
rem:
  enabled: true
  model: local-small
  fallback: [glm, flash]
```

| Situation | What REM does |
|---|---|
| Worker unreachable: connection refused, timeout, 5xx, 429 | Continues on the next backup from the chunk that failed. Finished chunks are kept. The backup stays in charge for the rest of the run. |
| Worker is marked as unavailable when the run starts | Starts on the first backup that is not marked. |
| Chain used up | The chunk fails as it would without a backup. |
| Request rejected (4xx: bad parameter, auth) | No switch. The run fails visibly, because this is a setup problem. |
| Unknown name in `model` or `fallback` | The run fails at its start. |

The dream file records the backups as `worker_fallback_ref` and a switch
as `worker_switch` with `from`, `to`, `reason` and `at_chunk`.

### What the worker sees

- The transcript, split into chunks of about `chunkTokens` tokens.
- The agent's existing memory notes.
- The wiki: its index and the 8 pages closest to the conversation.
- Up to 15 matching notes from the vault.

The transcript says who wrote each line. Only `USER` lines are the
person speaking. A line from another agent is labelled
`OTHER-AGENT(<name>)`, an automatic trigger `SYSTEM(<kind>)`. A fact
passed on by another agent can become a finding, but it is recorded
with its source ("Laut <name>: …"). Trigger text is never a source.

### What REM produces

A dream file with findings. Each finding has:

| Field | Meaning |
|---|---|
| `action` | `memory_write`, `memory_edit`, `memory_delete` or `vault_hint` |
| `slug` | Name of the note |
| `proposed_content` | What the note will say when approved |
| `reason` | Why, with the statement it rests on |

`vault_hint` points out a vault note that looks outdated. Approving it
writes nothing, because somora never writes to your vault.

A note written from a finding carries `stated_at`: the end of the
conversation it came from. Deep uses that date, not the day of the
approval. A run without findings is filed away at once and never shows
up for review.

### Repeats are marked

Small models do not reliably stick to "only new facts". After the
extraction, code checks each finding against what is already stored.

| Check | Result |
|---|---|
| The slug is the name of a wiki page | The finding is dropped. |
| The slug is an existing note with the same content | The finding is dropped. |
| The slug is an existing note with different content | The finding is kept under `<slug>-update-<date>`, so a correction reaches the review and nothing is overwritten. |
| The content is very similar to a note or wiki page | The finding is kept and marked `likely_duplicate`. `duplicate_of` names the page, `matched_excerpt` shows the text that matched. |

The mark means the topic overlaps. It does not prove the fact is
already written. A finding with numbers, dates or versions that the
matched text lacks is also marked `novel_details`.

> **Warning:** Do not dismiss findings marked `novel_details` in bulk.
> They are usually a new fact on a known topic. For the others, read
> `matched_excerpt` first: dismiss when it states the fact, not only
> the topic.

The wiki's monthly change logs are left out of the comparison. They
record that something was processed, not the knowledge itself.

### The coverage judge

Similarity cannot tell "waiting for the go" from "the go was given".
The optional coverage judge asks a model instead. It reads the whole
pages of the closest candidates and answers one question: is everything
in this finding already stated there?

| Verdict | Effect |
|---|---|
| `covered`, confidence at or above `minConfidence` | The finding is marked `likely_duplicate`. `duplicate_of` reads `<source>:<slug>@judge` unless similarity had marked it already. |
| `adds_new` | No mark. If similarity had marked the finding, it also gets `novel_details`. |
| No candidates, call failed, answer unreadable, or `maxPerRun` reached | No verdict. The finding is reviewed as usual. |

Nothing is deleted by the judge. A judged finding shows `judge_verdict`,
`judge_confidence` (0 to 100), `judge_reason` and, when covered,
`judge_by` in `dream_get`.

The judge is off by default. Without `rem.dedup.judge.model` it uses the
worker the REM run is on, including a backup the run switched to. The
question is easier than the extraction, so a smaller model does fine. It
costs one call per finding with candidates, a few thousand tokens each.

## Deep

Deep moves the memory notes of all agents into the shared wiki. It runs
without approval.

### What Deep does

For each note Deep asks its worker once and gets one of three answers:

| Decision | What happens | The note |
|---|---|---|
| **Skip** | Short-lived, too thin, or already in the wiki | stays |
| **Promote** | A new wiki page is written | is deleted |
| **Merge** | The content goes into an existing page | is deleted |

Two ways to keep notes out of Deep:

- `wiki_promote: false` in the frontmatter of a note keeps that note in
  the inbox.
- `rem.participate_in_wiki: false` in `agent.yaml` keeps all notes of
  that agent out of the wiki.

### When Deep runs

Every `wiki.deep.intervalHours` (default 12). The rhythm survives
restarts. On a fresh install the first run is one interval after the
first start.

Run it now with `dream_run({phase: 'deep'})` or `POST /dream/run-deep`.
Only one Deep run is active at a time.

### The Deep worker

`wiki.deep.model` is required. Without it Deep does nothing and logs
`dream.deep.no_worker_model_configured`. Deep decides what goes into the
wiki, so a strong model is worth it. Backups are covered under
[Backup workers](#backup-workers).

### What the worker sees

- The note and when its content was stated (`stated_at` if present).
- The wiki map: every folder, what kind of page lives in it, and the
  filing rules.
- The 8 wiki pages closest to the note. A page over 8000 characters
  arrives cut to its first 6000.

When the note contradicts the page, Deep compares dates. A note that is
clearly newer updates the fact and records the change in the timeline.
A note that is older, or whose order is unclear, leaves the fact alone
and is added to the timeline as an earlier entry.

### Checks before Deep writes

| Check | What happens |
|---|---|
| Merge into a page the worker saw shortened or not at all | The worker is asked again with that page in full. The write is refused if the page changed in the meantime. |
| Target page is over `maxPageChars` (default 50 000) | The page takes no more content. The worker is asked to write the note as a sub-page under it. |
| Promote into a folder the wiki map does not know | Refused, unless the worker gave the folder a purpose. Then the folder is created and described. |
| Folder deeper than one level below a top folder | Refused. |
| A page of that name exists in another folder | The promote becomes a merge into that page. |
| Merge would shrink the page | Refused by the shrink guard, see below. |

A refused note stays in the inbox and is tried again on the next run.

### The shrink guard

For a merge the worker returns the full new page. On a large page a
model may return a summary instead, and the old content would be gone.
Deep therefore compares sizes. If the new body is shorter than
`minRatio` times the old one, the merge is refused: the page and the
note both stay, and the next run tries again.

Pages below `minExistingBytes` are not guarded. Shrinking a short stub
is normal editing.

> **Tip:** A page that trips the guard again and again has outgrown
> full-page merges. Split it into sub-pages.

### Skipped notes are remembered

A skipped note is remembered by a hash of its content. While the note is
unchanged, later runs skip it without a model call. A run in which
nothing changed costs no tokens.

A skip is forgotten when:

- the note changes or is deleted,
- the skip is older than `skipCacheDays` (default 30, `0` means never),
- you run `dream_run({phase: 'deep', force: true})`, which looks at
  every note again.

A skip expires because it was a verdict against the wiki of that day.
"Too thin for a page of its own" stops being true once the page exists.
Expiry is spread out per note, and at most 10 expired notes per agent
are looked at again in one run.

### What Deep leaves behind

New and updated pages in the wiki, and one line per promote or merge in
the monthly log `<vault>/<wiki-subfolder>/logs/YYYY-MM.md`.

There is no review. If Deep decided badly, edit the page in Obsidian or
wait for Lucid to flag it.

## Lucid

Lucid reads the wiki and reports what is provably wrong with it. It sets
missing links itself. Everything else waits for a review.

### What Lucid looks for

| Finding | Meaning | Fix |
|---|---|---|
| `contradiction` | Two pages state facts that exclude each other. | In the review loop |
| `duplicate_page` | Two pages describe the same thing under different names. | `dream_apply` unites them: the worker writes the merged page, the other page is archived, links follow. |
| `misfiled_page` | A page that is not of its folder's kind. | `dream_apply` moves it to the folder the finding names. |
| `oversized_page` | A page over `oversizedChars` (default 50 000). Found without a model. | Split it in the review loop. |
| `dead_ref` | A `[[wiki-path]]` link to a page that does not exist. | In the review loop |
| `wanted_page` | A missing page that three or more pages link to. | In the review loop |
| `link_suggestion` | A page names something that has its own page, without linking it. | Set by Lucid itself |
| `not_migrated` | The wiki does not use the folder template. Reported once per run. | Run `somora wiki migrate`, or dismiss to keep the wiki as it is. |

`misfiled_page` and `oversized_page` are only reported in a wiki on the
folder template. Style is not Lucid's business: "this could read
better" belongs in the conversation, not in a finding.

Three older kinds (`stale_claim`, `outdated`, `inconsistent_xref`) are
still readable in archived runs. No run produces them.

### When Lucid runs

Every `wiki.lucid.intervalDays` (default 7), with the same restart-safe
rhythm as Deep. Run it now with `dream_run({phase: 'lucid'})` or
`POST /dream/run-lucid`.

While a run still has findings waiting, no new run starts. The schedule
looks again six hours later. `force: true` runs anyway.

### The Lucid worker

`wiki.lucid.model` is required. Without it a run fails with
`no worker model configured for lucid`. Lucid judges contradictions and
you review its findings by hand, so pick a strong model.

### How Lucid reads the wiki

Lucid cuts the wiki into calls by size. One call carries as many pages
of one folder as fit into `batchChars` (default 100 000 characters). A
larger page travels alone, a big folder goes in parts. Each call also
sees the wiki map and one line for every other page of its top folder.

A last pass looks across folders. It sees only the opening line of each
page. That is enough for a dead link or a missing page. A contradiction
between the bodies of two pages in different folders is out of its
sight.

### What Lucid produces

A run file, `~/.somora/wiki-lucid/<run-id>.json`.

- **Findings are capped.** Each call may return up to 8. The run keeps
  the `maxFindings` weightiest (default 12): contradictions first, then
  dead links, duplicates, misfiled and oversized pages, wanted pages.
- **Links are set at once.** The first plain mention becomes a
  `[[link]]`, up to `autoLinksPerRun` per run. Each one is recorded as
  `applied`, or as `dismissed` with the reason. `autoLinks: false`
  switches this off.
- **Dismissed findings stay away.** A finding you dismissed is not
  reported again for `seenDays` (default 90).
- **Failures are visible.** The file records `batches_total` and
  `batches_failed`. A run in which every call failed has the status
  `failed`. It is not a clean wiki with zero findings.

## Backup workers

Deep and Lucid each name one worker. If it is unreachable the run would
fail and wait for its next slot: twelve hours, or a week. Give each a
backup:

```yaml
wiki:
  deep:
    model: opus
    fallback: [gpt, local-model]   # one name or a list, tried in order
  lucid:
    model: opus
    fallback: gpt
```

- A backup steps in when the worker is not there: connection refused,
  timeout, 5xx, 429. A rejected request (4xx) stays an error.
- An outage is remembered and shared with chat, REM and compaction. A
  model that failed is skipped by all of them for
  `fallback.retryUnavailableMinutes` (default 60). A successful call
  clears the mark.
- A backup name that is not a configured model stops the server at
  start, with the list of known models.

> **Tip:** Put at least one backup on a different provider. A second
> Claude model does not help when the Claude login has expired.

A weaker backup is better than no run for Deep, whose pages a later run
can correct. Think twice for Lucid, whose findings you review by hand.

## Reviewing findings

`dream_list` shows what waits. Each entry has a `kind`:

| `kind` | From | Who sees it |
|---|---|---|
| `memory` | REM | Only the agent it belongs to |
| `wiki_lucid` | Lucid | Every agent with the `dream` toolset |

### REM findings

Ask the agent to go through them with you. It calls `dream_get` for the
list, then `dream_apply` or `dream_dismiss` per finding. When the last
one is resolved the dream file moves to `processed/`.

If a finding was right but is already taken care of, close it with
`dream_dismiss({resolved_manually: true, reason})`. The history then
reads "done elsewhere", not "rejected".

If the note of a `memory_edit` finding no longer exists, because Deep
moved it into the wiki, `dream_apply` writes the content as a new note.

### Lucid findings

`duplicate_page` and `misfiled_page` can be fixed directly with
`dream_apply`. The other findings are worked through in a conversation,
the review loop:

```
you:    have a look at the Lucid result
agent:  dream_list, dream_get
        dream_review({dream_id, action: 'start'})
        "Lucid found 3 contradictions and 2 dead links. The first:
         page X says A, page Y says B. I would change Y. OK?"
you:    yes
agent:  wiki_edit({...})
        "Done. Next finding: ..."
you:    good, wrap it up
agent:  dream_review({dream_id, action: 'end', summary: '...'})
```

`dream_apply` on any other Lucid finding only marks it as applied and
changes nothing in the wiki.

### Rules of the review loop

| Rule | Detail |
|---|---|
| Wiki tools appear | The agent gets `wiki_edit`, `wiki_create`, `wiki_delete` and `wiki_move`. They exist only inside the loop. |
| Other tools are hidden | `exec_*`, `tmux_*`, `agents_*`, `skill_*`, `file_write` and `file_patch` are refused. `file_read`, `file_search`, `file_list`, `analyze_file`, memory and web tools stay. |
| One loop at a time | Only one agent on the instance can hold a loop. |
| Small steps | At most `maxCallsPerTurn` (default 3) `wiki_*` calls per turn. The count resets with every message of yours. |
| Open findings stay open | `end` needs a `summary`. Findings you did not get to keep waiting, and a later loop continues there. `dismiss_rest: true` closes them all. |
| Archive | The run file moves to `processed/` when no finding is left. |
| Forgotten loops | A loop without activity for 24 hours closes by itself. |

`wiki_edit` takes a new body (`newBody`), changes to the frontmatter
lists (`relatedAdd`, `relatedRemove`, `sourcesAdd`, `sourcesRemove`), or
both. `wiki_edit({wikiPath, relatedRemove: ['dead/page']})` removes a
dead reference without touching the text.

> **Note:** Agents on `claude-cli`, `codex-cli` and `grok-cli` get their
> tool list once per turn. After `dream_review` start, the `wiki_*`
> tools are available from the next turn. The agent should end its
> reply and continue after you answer.

The TUI shows `📝 wiki-review:<agent>` in the status line while a loop
is open.

## Where things live

```
~/.somora/agents/<name>/memory/                    ← the agent's notes
~/.somora/agents/<name>/memory/.dreams/            ← REM runs waiting for review (<id>.dream.md)
~/.somora/agents/<name>/memory/.dreams/processed/  ← resolved REM runs
~/.somora/agents/<name>/memory/.deep-skip-cache.json ← notes Deep skipped
~/.somora/wiki-lucid/<run-id>.json                 ← Lucid runs waiting for review
~/.somora/wiki-lucid/processed/                    ← resolved Lucid runs
<vault>/<wiki-subfolder>/                          ← the wiki
<vault>/<wiki-subfolder>/index.md                  ← page overview, rebuilt automatically
<vault>/<wiki-subfolder>/logs/YYYY-MM.md           ← monthly log of Deep
```

The dream phases write only to the agents' memory folders and to the
wiki subfolder. The rest of your vault is read, never written.

## Settings

### REM per agent

In `agent.yaml`. The values shown are the defaults.

```yaml
rem:
  enabled: true
  model: <alias>
  # fallback: <alias>          # or a list: [a, b]
  idleMinutes: 30
  chunkTokens: 50000
  chunkTimeoutMs: 600000
  participate_in_wiki: true
  # thinking: medium
```

| Setting | Default | Meaning |
|---|---|---|
| `rem.enabled` | none | Switches REM on for this agent. |
| `rem.model` | none | The worker. Required. Alias or `provider/modelId`. |
| `rem.fallback` | none | Backup worker, or an ordered list of them. |
| `rem.idleMinutes` | 30 | Minutes without chat before REM starts. |
| `rem.chunkTokens` | 50000 | Size of one piece of a long transcript. |
| `rem.chunkTimeoutMs` | 600000 | Time limit per piece. Ten minutes leave room for local models. |
| `rem.participate_in_wiki` | true | `false` keeps this agent's notes out of Deep. |
| `rem.thinking` | none | `off`, `low`, `medium` or `high`. Used when the worker model can reason. |

### REM for all agents

In `config.yaml`.

```yaml
rem:
  dedup:
    enabled: true
    similarityThreshold: 0.85
    judge:
      enabled: false
      # model: <alias>
      candidates: 4
      maxPageChars: 6000
      minConfidence: 80
      maxPerRun: 60
      timeoutMs: 120000
      # thinking: low
```

| Setting | Default | Meaning |
|---|---|---|
| `rem.dedup.enabled` | true | Check findings against stored notes and pages. |
| `rem.dedup.similarityThreshold` | 0.85 | Similarity (0 to 1) from which a finding is marked `likely_duplicate`. Lower marks more. A rewording of the same fact scores about 0.85 to 0.95, the same topic with another fact about 0.6 to 0.8. |
| `rem.dedup.judge.enabled` | false | Switches the coverage judge on. |
| `rem.dedup.judge.model` | the REM worker | Model that judges. |
| `rem.dedup.judge.candidates` | 4 | Pages the judge reads per finding. |
| `rem.dedup.judge.maxPageChars` | 6000 | Each page is cut to this length. |
| `rem.dedup.judge.minConfidence` | 80 | A `covered` verdict below this marks nothing. |
| `rem.dedup.judge.maxPerRun` | 60 | Findings judged per run. The rest go unjudged. |
| `rem.dedup.judge.timeoutMs` | 120000 | Time limit per judge call. |
| `rem.dedup.judge.thinking` | none | Used when the judge model can reason. |

### Deep and Lucid

In `config.yaml`.

```yaml
wiki:
  enabled: false
  vaultSubfolder: somora
  language: de
  deep:
    enabled: true
    intervalHours: 12
    # model: <alias>
    # fallback: <alias>        # or a list
    # thinking: medium
    mergeShrinkGuard:
      enabled: true
      minRatio: 0.5
      minExistingBytes: 2000
    skipCacheDays: 30
    maxPageChars: 50000
  lucid:
    enabled: true
    intervalDays: 7
    # model: <alias>
    # fallback: <alias>        # or a list
    # thinking: medium
    maxCallsPerTurn: 3
    batchChars: 100000
    oversizedChars: 50000
    maxFindings: 12
    autoLinks: true
    autoLinksPerRun: 30
    seenDays: 90
fallback:
  retryUnavailableMinutes: 60
```

| Setting | Default | Meaning |
|---|---|---|
| `wiki.enabled` | false | Switches the wiki on, and with it Deep and Lucid. |
| `wiki.deep.enabled` | true | Scheduled Deep runs. |
| `wiki.deep.intervalHours` | 12 | Hours between Deep runs. |
| `wiki.deep.model` | none | The Deep worker. Required. |
| `wiki.deep.fallback` | none | Backup worker or list. |
| `wiki.deep.thinking` | none | Used when the worker can reason. Tends to improve the decisions and costs more. |
| `wiki.deep.mergeShrinkGuard.enabled` | true | Refuse merges that shrink a page. |
| `wiki.deep.mergeShrinkGuard.minRatio` | 0.5 | Refuse when the new body is shorter than this share of the old one. |
| `wiki.deep.mergeShrinkGuard.minExistingBytes` | 2000 | Pages below this size are not guarded. |
| `wiki.deep.skipCacheDays` | 30 | A skipped, unchanged note is looked at again after this many days. `0` means never. |
| `wiki.deep.maxPageChars` | 50000 | A page above this takes no more content and gets sub-pages. |
| `wiki.lucid.enabled` | true | Scheduled Lucid runs. |
| `wiki.lucid.intervalDays` | 7 | Days between Lucid runs. |
| `wiki.lucid.model` | none | The Lucid worker. Required. |
| `wiki.lucid.fallback` | none | Backup worker or list. |
| `wiki.lucid.thinking` | none | As for Deep. |
| `wiki.lucid.maxCallsPerTurn` | 3 | `wiki_*` calls per turn in the review loop. |
| `wiki.lucid.batchChars` | 100000 | Page text per Lucid call. |
| `wiki.lucid.oversizedChars` | 50000 | Pages above this are reported as `oversized_page`. |
| `wiki.lucid.maxFindings` | 12 | Findings kept per run for review. |
| `wiki.lucid.autoLinks` | true | Lucid sets suggested links itself. |
| `wiki.lucid.autoLinksPerRun` | 30 | Most links set per run. |
| `wiki.lucid.seenDays` | 90 | A dismissed finding is not reported again for this long. |
| `fallback.retryUnavailableMinutes` | 60 | How long a model that failed is skipped by chat, REM, Deep, Lucid and compaction. |

## Tools

All six belong to the `dream` toolset.

| Tool | What it does |
|---|---|
| `dream_list(include_processed?)` | Lists REM dreams of the calling agent and Lucid runs that wait for review. `include_processed: true` adds resolved ones. Failed runs are listed with their `error`. |
| `dream_get(dream_id)` | Returns all findings of one dream or Lucid run with their status. |
| `dream_apply(dream_id, finding_id)` | Carries out one finding. For REM: writes, edits or deletes the note. For Lucid: unites or moves pages, otherwise only marks the finding. |
| `dream_dismiss(dream_id, finding_id?, reason?, resolved_manually?)` | Closes one finding, or the whole dream without `finding_id`. `resolved_manually: true` records "handled elsewhere". |
| `dream_run(phase?, wait?, force?)` | Starts `deep` (default), `lucid` or `rem` now. See below. |
| `dream_review(dream_id, action, summary?, dismiss_rest?)` | `start` opens and `end` closes the review loop for a Lucid run. `end` requires `summary`. |

Finding ids start at 1. An unknown `dream_id` returns
`error: dream_not_found` with the list of valid ids.

`dream_run` returns at once and the run continues in the background.
`wait: true` blocks until a Deep or Lucid run is done and returns its
result. `force: true` makes Deep ignore its remembered skips, and makes
Lucid run although findings wait. For `rem` neither applies.

## Routes

| Route | What it does |
|---|---|
| `POST /agents/:agent/dream/run-rem` | Starts the REM cycle for one agent. Returns `outcome`: `started`, `busy` or `nothing_to_do`. 400 when REM is not enabled for the agent. |
| `POST /dream/run-deep` | Starts Deep. Body `{wait?, force?}`. With `wait: true` returns `candidatesSeen`, `cachedSkips`, `counts` and `outcomes`. |
| `POST /dream/run-lucid` | Starts Lucid. Body `{wait?, force?}`. With `wait: true` returns `runId`, `findingsCount`, `pagesScanned` and `status`. |
| `GET /dream-states` | Per agent: REM `active` and `pendingCount`. Deep: `active`. Lucid: `active`, `pendingRuns`, `pendingFindings` and `loopHolder`. |
| `GET /dream/loop-state` | The open review loop: `active`, `agent`, `dreamId`, `startedAt`, `lastActivityAt`. |

`run-deep` and `run-lucid` answer 400 when `wiki.enabled` is false.

```bash
curl -X POST http://127.0.0.1:18737/dream/run-deep  -d '{"wait":true}'
curl -X POST http://127.0.0.1:18737/dream/run-lucid -d '{"wait":true}'
```

## Troubleshooting

| Symptom | Where to look |
|---|---|
| REM never runs for an agent | `rem.enabled` and `rem.model` in `agent.yaml`. The log line `dream.rem.registered` appears at start for every agent with REM. After enabling REM, restart. |
| A dream shows `failed` in `dream_list` | Read its `error`. The same stretch is retried automatically, so wait for the new dream. `dream.worker_fallback` in the log shows a switch to a backup. |
| REM gave up after an outage | `dream.rem.self_heal_exhausted` in the log. Send the agent a message or call `dream_run({phase: 'rem'})`. |
| The judge marks nothing | `dream.rem.dedup_summary` carries `judged`, `judge_marked`, `judge_cleared`, `judge_failed`, `judge_skipped` and `judge_model`. Single failures are logged as `dream.rem.judge_failed` and `dream.rem.judge_unreadable`. |
| A finding vanished before review | `dream.rem.dedup_dropped` (repeat of an existing page or note) or `dream.rem.dedup_reslugged` (kept under a new name). |
| Deep does nothing | `dream.deep.no_worker_model_configured`, or `wiki.enabled` is false. |
| A note never reaches the wiki | It is remembered as skipped. Run Deep with `force: true`. `dream.deep.merge_shrink_blocked` means the shrink guard refused the merge. |
| Which model answered | `dream.worker_unavailable` and `dream.worker_switched` in the log, `answeredBy` on `dream.deep.done`, `answered_by` in the Lucid run file. |
| Lucid does not start | `dream.lucid.skip_pending`: an earlier run still has open findings. Review it or use `force: true`. |
| Lucid found fewer findings than expected | `dream.lucid.run_capped` lists what `maxFindings` dropped. `batches_failed` in the run file shows calls that failed. |

## See also

- [Memory](memory.md): the inbox REM fills and Deep empties
- [Wiki](wiki.md): folders, page format and the migration onto the
  folder template
- [Agents](agents.md): `agent.yaml`, including the `rem` block
- [Models](models.md): aliases, providers and the chat fallback
- [Thinking](thinking.md): what the `thinking` levels mean per engine
- [Tools](tools.md): all toolsets, `dream` among them
