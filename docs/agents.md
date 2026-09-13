# Agents

An **agent** is a distinct personality somora can chat as. You can have
many; each has its own memory, its own model preferences, and its own
optional Obsidian vault binding.

## Anatomy

```
~/.somora/agents/<name>/
├── AGENTS.md                       ← required. behavioural rules + identity (frontmatter)
├── SOUL.md                         ← optional. voice / personality
├── USER.md                         ← optional. what the agent knows about you
├── VOICE.md                        ← optional. hand-written character for spoken calls
├── agent.yaml                      ← optional. operator-config (model, REM, vault)
├── memory/                         ← per-agent memory inbox
│   ├── *.md                        ← un-consolidated notes
│   ├── memory.db (+ -wal, -shm)    ← derived index
│   ├── .deep-skip-cache.json       ← Deep's hash-cache for skipped files
│   └── .dreams/                    ← REM extraction findings awaiting review
│       └── processed/              ← resolved findings (audit trail)
└── sessions/                       ← chat history (jsonl + meta json per session)
    ├── main.jsonl
    └── 20260501-143022_some-slug.jsonl
```

The memory directory is the agent's **inbox** — short-term, volatile.
Deep periodically promotes content to the shared wiki and deletes the
source. See [memory.md](memory.md) and [wiki.md](wiki.md).

What the agent knows about its **colleagues** — who reports to whom,
who to involve for what — does not live in the persona. It is rendered
into the prompt from `~/.somora/team.yaml`, one file for the whole
install; see [team.md](team.md). Keep `AGENTS.md` to the agent's own
behaviour and lane.

## Creating a new agent

The minimum is an agent directory with an `AGENTS.md`. Everything else is
optional.

```bash
mkdir -p ~/.somora/agents/<your-agent>
cat > ~/.somora/agents/<your-agent>/AGENTS.md <<'EOF'
---
name: <your-agent>
description: Engineering-minded research assistant
icon: 🌼
---

- Be precise. Quote sources when you have them.
- Don't speculate beyond what's in your memory or the conversation.
- You are who the operator configured you as — stick to the
  description above and the SOUL.md voice.
EOF
```

The next `/agents` call from the CLI lists the new agent — no server
restart needed.

### Identity goes in AGENTS.md frontmatter

```yaml
---
name: <your-agent>    # must match the directory name
description: ...      # one-line — shown by `/agents`
icon: 🌼              # optional emoji shown in CLI prompts and listings
---
```

### Operator config goes in agent.yaml

```yaml
# ~/.somora/agents/<your-agent>/agent.yaml
model: opus           # alias OR provider/modelId
fallback: gpt55       # used when primary fails before producing any output
                      # (visible: ⇄ chip on that turn + notice in the web UI)
# fallback: [deep4flash, orhaiku]   # or an ordered chain — each is tried in
                      # turn when the previous one died before its first
                      # output or tool call. Put at least one entry on a
                      # different host/provider than the primary: two
                      # models on the same GPU box go down together.
#
# One exception to "before producing any output": some providers stream
# their refusal AS assistant text and only then report the error — a
# monthly quota notice is the common case. The engine adapter marks
# those, and the chain still runs, because such text is not an answer.
# A turn that already called a tool is never repeated on another model:
# the side effects have happened.

# Optional: cross-engine thinking depth (off|low|medium|high)
# Per-session override via /thinking <level>. Only applies to models with
# the `reasoning` capability — see thinking.md.
thinking: medium

# Optional: sampling defaults for openai-compatible models (temperature,
# top_p, top_k, …). Override the model's own defaults per key; per-session
# via /sampling and /temp. Dormant on claude-cli / codex-cli — see sampling.md.
sampling:
  temperature: 1.0
  top_p: 0.95

# Optional: per-agent workspace override. Default cwd for the file_* tools.
# Falls back to config.workspace.default (~/somoraworkspace) when unset.
workspace:
  path: ~/<your-agent>-workspace

# Optional: hide remote resources from this agent. By default every
# resource defined in config.yaml is visible. See resources.md.
resources:
  deny: ['production-db']

# Optional: per-agent tool visibility — uniform for built-in and
# external MCP tools. Patterns: exact name, toolset:<tag>, trailing-*
# glob. deny beats allow; no section = agent sees everything. See mcp.md.
# Denying a tool removes it from the model's tool list, which is real
# context saved: the full built-in surface costs roughly 13k tokens per
# turn. Only tools whose configuration exists are offered in the first
# place — the web Abilities window lists exactly those, so a switch there
# always changes something.
tools:
  deny: ['toolset:exec', 'mcp__parallel__*']
  allow: []

# Optional: per-agent skill visibility, same shape and semantics as
# tools: (deny beats allow, empty allow = all). The Abilities window
# writes exact-name denies here; a plain list (`skills: [a, b]`) is the
# older allow-list form and still works. See skills.md.
skills:
  deny: ['instagram-downloader']

# Optional: this agent's voice, for realtime calls (realtime-voice.md).
# Only what SPEAKING needs — who the agent is comes from its persona
# files, so there is no second character to maintain. Without this block
# the agent cannot be called and does not appear in the voice picker.
# A hand-written character can live in VOICE.md next to AGENTS.md; it
# replaces the derived one, while the rules that keep a call honest stay.
voice:
  enabled: true
  voice: ash                 # alloy ash ballad coral echo sage shimmer verse marin cedar
  language: de
  style: "dry, direct, no small talk"
  consultPolicy: always      # auto | substantive | always
  maxSpokenSentences: 4

# Optional: REM phase (per-agent session→memory extraction)
rem:
  enabled: true
  model: gemma4big          # required when enabled — never inherits the chat model
  # fallback: deep4pro      # optional backup worker, used only when `model`
                            # is unreachable (connection refused, 5xx, timeout)
  idleMinutes: 30           # auto-trigger after N min idle
  chunkTokens: 50000        # range-split for very long sessions
  chunkTimeoutMs: 600000    # 10 min/chunk; gemma-friendly
  participate_in_wiki: true # default true; false = REM only, never Deep
```

REM is the per-agent dream phase that watches sessions and proposes
memory updates with your approval. The platform-wide phases (Deep,
Lucid) are configured in `~/.somora/config.yaml.wiki.deep / .lucid` —
not per-agent. See [dream-phases.md](dream-phases.md).

`participate_in_wiki: false` opts a single agent's memory inbox out
of the Deep promote-to-wiki pipeline. REM still runs (the agent still
gets memory findings), Deep just won't see this agent's inbox. Useful
for sandbox/scratch agents you don't want contributing to the shared
wiki.

The split between `AGENTS.md` (identity + behavioural rules, agent-editable)
and `agent.yaml` (operator config) is intentional but not enforced as a
hard limit — the agent **can** edit `agent.yaml` via the `file_*` tools,
the path-blacklist allows it. The convention is: persona-content evolves
in the .md files, operator-config evolves in .yaml. Agents can self-edit
both today; future Skills-layer guidance will steer them toward the right
file for each kind of change.

### Seeing and editing the persona without a terminal

`/web` → right-click the agent tile → **Configure…** opens the Agent
window: the three persona files as editors, `agent.yaml` read-only, a
budget strip (persona total, team block, full prompt, tool schemas —
characters and estimated tokens against `promptBudgets` in config.yaml)
and a *Full prompt* tab with the system prompt exactly as the next turn
would send it. Saves are refused when the agent changed the file in the
meantime, and every save keeps a backup. See [web.md](web.md).

### Self-edit and cross-agent edit

Each agent gets a small self-pointer block prepended to its system prompt
at every turn. It tells the agent its name, where its persona files
live, the workspace path, the global config location, which remote
resources are configured, and the convention for referencing local
files in chat replies (markdown links carrying the bare absolute path
like `[label](/home/.../file.md)` — those route to a FileView window
in the web client; wrapped URLs do not). This means the agent can run
e.g.:

```
file_write({ path: "~/.somora/agents/<your-agent>/USER.md", content: "...", mode: "overwrite" })
file_read({ path: "~/.somora/agents/<your-agent>/agent.yaml" })
file_patch({ path: "~/.somora/config.yaml", old_string: "...", new_string: "..." })
```

…to update its own state without you having to dictate paths.

**Cross-agent editing is intentionally allowed.** One agent can rewrite
another's `AGENTS.md`, adjust their `agent.yaml`, or add notes to
their memory. Agents shape each other in this design, not just
themselves. The only files in `~/.somora/agents/<*>/` that stay
off-limits are the `sessions/` dirs (append-only conversation logs
managed by somora's storage layer). See `files.md` for the full
write blacklist.

To learn more about somora's own architecture, agents can call
`somora_docs_list` and `somora_docs_read` — those tools serve the
contents of this `docs/` directory.

### Persona in three files

| File       | Role                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `AGENTS.md` | Behavioural rules. "Reply concisely." "Use tools when asked, don't preface." |
| `SOUL.md`   | Voice / character. "I speak in short sentences. I have dry humour." |
| `VOICE.md`  | Optional, and only for realtime calls: the spoken character, replacing the one derived from the files above. The rules that keep a call honest (ask before answering anything factual, never invent, never refuse work on your own authority) always stay. See [realtime-voice.md](realtime-voice.md). |
| `USER.md`   | Static context about you. "User is Maria. Lives in Berlin. Two cats." |

All three are concatenated into the system prompt. Edit them in place; the
loader re-reads on every turn — no restart needed.

### Naming rules

Agent directory names must match `^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`. No
spaces, no slashes. Lowercase is the convention.

## Switching agents and sessions

```
/agents                          — list all configured agents
/agent <name>                    — switch to <name>, drop into its main session
/agent <name> some-topic         — switch to <name>, session named "some-topic"

/sessions                        — list sessions of the current agent
/session some-topic              — switch to that session (newest match)
/new daily-2026-05-02            — create + switch to a new session
/main                            — back to the agent's main session
```

`main` is a magic name — every agent always has one, you can't delete it.
Use `/reset YES` to archive the current main and start fresh while keeping
the old content as an archived session you can resume any time.

## Exporting a session

```
/export                          — write current session as Markdown to ./<agent>-<session>.md
/export markdown [path]          — same, optionally pick a target path
/export json [path]              — write raw JSONL (full fidelity) to <path or default>
```

Markdown is the default — a readable transcript with user/assistant
turns, fenced tool-call blocks, and engine plan/todo items rendered as
GitHub task lists. JSON is the canonical source (byte-identical to the
on-disk JSONL); use it for backups or moving a conversation to another
somora host.

In the web client the same export lives in the Sessions tool: each row
has a file-text icon (Markdown) and a file-json icon (JSONL) that
trigger a browser download.

## Per-session model overrides

Each agent has a default model from `agent.yaml`. You can override per
session:

```
/model                        — show what's effectively used now
/model gemma                  — use gemma for this session only
/model default                — drop the override, fall back to agent default
/models                       — list every configured model with its alias
```

Overrides are stored in the session's meta-file and survive across server
restarts.

## Talking to another agent

Agents talk to each other with `agent_ask`. The message lands in the
target's **real** session as a user message, so the target answers with
its full memory, persona and history, and the exchange stays visible
there afterwards. The target sees a header
`[Message from agent <name>, session <slug>]` ahead of the message and
answers as it would answer you; that answer comes back to the asker as
the tool result. The header is the turn's frame — the server composes
it beside the message, in the same per-turn field that carries the
memory-recall block — so the stored text of the turn is the message
itself, and that is what the target's memory and recall are built
from.
It is request-response, not a message bus: an agent that received a
question answers by finishing its turn, never by calling `agent_ask`
back at its caller.

```
agent_ask({ agent: "<other-agent>", message: "…" })
agent_ask({ agent: "<other-agent>", session: "projekt-a", create_session: true, model: "<alias>", message: "…" })
agent_ask({ agent: "<other-agent>", message: "…", images: ["/abs/path.png"], timeout_ms: 120000 })
```

- **Where it lands.** Without `session`, a reply to the agent that
  wrote to you (or to your spawning parent) goes back to the session
  that message came from; anything else goes to the target's `main`.
  An explicit `session` always wins. An unknown slug is an error that
  lists the target's existing sessions.
- **Creating a project session.** `create_session: true` creates a
  named slug on the target when it does not exist yet (not `main`, not
  ids, not `sub-…` sessions). `model` pins an alias or `provider/id`
  on the session this call creates; on an existing session it is
  ignored and the result says so in `session_note`. The target is
  told, beside its first message in that session, `[Your session
  '<slug>' was just created by <agent> for this conversation; it runs
  on model <model>.]` — the stored text is the question.
- **Pictures.** `images` takes absolute paths. somora uploads them and
  puts them on the target's turn, so a model with vision sees them; a
  target without vision gets the vision worker's description.
- **Queueing.** The call waits in the target session's queue in arrival
  order, like a typed message. It cannot ask yourself; a self-clone
  task is what `spawn_subagent` is for.
- **Waiting.** `wait: true` (the default) blocks until the reply.
  `timeout_ms` defaults to `agentLoop.longTaskDefaultTimeoutMs`
  (5 minutes) and is capped at `longTaskMaxTimeoutMs` (30 minutes).
  When the target has not answered by then the call returns
  `state: "pending"` with a `call_id` — the target keeps working, and
  the message is never sent again.
- **Handing over.** `wait: false` hands the message over and returns
  `state: "pending"` with the `call_id` at once (plus `session_created`,
  `session_model` or `session_note` when they apply). The rule: an
  answer needed to go on with this turn → `wait: true`; a job that may
  take its time → `wait: false`. Either way the reply reaches the asker
  — see the wake below.
- **Taking it back.** `agent_ask_cancel({ call_id })` removes a call of
  your own that is still waiting in the target's queue: `removed`, or
  `already_started` when the target is already answering (then it
  finishes, or a person stops it), or `unknown`. Another agent's call
  cannot be taken back.

The result has one of three states:

| `state` | What it carries | Meaning |
|---|---|---|
| `done` | `response`, `ms`, `usage`, `call_id`, `target_agent`, `target_session`, plus `session_inferred`, `session_created`, `session_model` or `session_note` when they apply | The target answered. |
| `pending` | `call_id`, `hint` | The target is still queued or running, or the call was sent with `wait: false`. Fetch the outcome with `agent_ask_result`, or wait to be woken. |
| `failed` | `error`, `hint` | The target's turn ran and failed — a model or engine error, or `stopped by the user` when a person pressed Stop on it — or it never ran because a person took it out of the target's queue (`removed from the queue by the user before it started`). An asker that had stopped waiting is woken with an `[agent answer]` turn saying so. Not something to retry on your own. |

`agent_ask_result({ call_id })` picks up a pending call: `done` with
the reply, `failed` with the error, or `pending` with `phase` `queued`
or `running`. `wait_until_done: true` blocks server-side until the call
finishes or `timeout_ms` passes, which is cheaper than polling. After a
server restart, pass `agent` and `session` of the original call and the
answer is read from the target's session.

An asker that stopped waiting, or never waited, does not have to
remember to poll. When the answer lands, the asker is woken in the
session it asked from with an `[agent answer]` turn. Its text is the
record of what happened:

```text
[agent answer] <other-agent> has answered the question you sent to session 'main' — you had stopped waiting for it. It begins: "…"
```

The instruction that goes with it — read the whole answer with
`agent_ask_result({ call_id })`, then do what depended on it —
accompanies the turn as its frame, beside the text, so the record
stays one line. A question a person took out of the target's queue
wakes the asker the same way (`… was removed from the queue by the
user before <other-agent> saw it — it will not be answered (call_id
"…")`). The wake waits `agentLoop.wakeGraceMs`
(default 3 seconds); reading the result through `agent_ask_result`
inside that window cancels it, and an asker still on the line never
gets one. The same wake, with the same grace, brings back a finished
background sub-agent and a rendered video — one mechanism for
everything an agent started and walked away from.

**Follow-ups.** A target may answer with "I am working on it with
sub-agents and will report back". Its turn ends, and with it the call,
while the work goes on. The asker does not have to come back for the
rest. Every piece of work remembers during which turn it was started,
so the sub-agents the target spawned while answering, the calls it
made, and whatever those start in turn form a tree under the original
call. When the last member of that tree has finished and the wake turn
about it has run in the target's session, the asker hears about it
exactly once — a follow-up carrying what the target wrote in its wake
turns about this work, oldest first (the answers of all of them, not
only the last: a summary given in the first wake turn is not lost to a
"nothing new" in the second). A wake that is still waiting in the
queue when the target reads that result itself is withdrawn, so a
result fetched during another turn does not come back as a stale
"finished" notice. So that this text is written for the asker and not as a note to
self, every wake turn under such a call carries, beside the usual
"fetch the result" frame, where its answer goes:

```text
What you answer in this turn is forwarded to agent <asker> as the follow-up to the question they sent (call_id "<id>") once all the work you started for it has finished — write it as the answer to that question, with the results, not as a note to yourself.
```

Four subs are four wakes in the target's session and one
follow-up to the asker, after the fourth. Work started inside a wake
turn extends the tree, and grandchildren count. The follow-up is an
ordinary message from the target agent — `origin.kind: "agent"` with
the original `call_id`, the text stored as the message — so clients
render it like any other. Its frame, beside the usual `[Message from
agent …]` header, says what it is:

```text
[Follow-up on the question you sent earlier (call_id "<id>"): the work it started has finished. Below is its result — treat it as the answer to that question. Continue whatever depended on it; if nothing does, tell your human in one line.]
```

Nobody waits for this message, so taking it out of the queue wakes no
one. There is no follow-up when the tree hangs under a person's turn
(that session shows the wake itself) or under a turn nobody asked for
(a sentinel fire, a tmux wake), when the call did not finish `done`,
when the wake turn was stopped by a person, when the target already
sent the asker a message of its own in that wake turn, or when the
asker read the result with `agent_ask_result` during the grace. A wake
turn that fails for another reason still produces one, saying the work
finished but the turn reporting it failed, with the error. Like the
rest of the ledger the tree lives in memory: after a server restart
there is none, and no follow-up. So a target that says it will report
back does — through such a follow-up turn — and the asker never asks
again.

Blocking waits are guarded against cycles. The server tracks who waits
on whom and refuses a call that would close the loop — even through a
chain of three or more agents — with an error that says so, instead of
letting both sessions hang. Sub-agents waiting on their parents are
part of the same graph.

## Sub-agents

`spawn_subagent` delegates a sealed task. The sub runs in a **fresh**
session of the target persona — `sub-<parent>-<timestamp>`, or
`sub-self-…` for a clone of the caller — with normal memory, tools and
thinking, and produces a final answer. Sub sessions stay visible in the
target's session list with a "sub from" marker.

```
spawn_subagent({ task: "…" })                                   # clone of yourself, background
spawn_subagent({ persona: "<other-agent>", task: "…", wait: true })
spawn_subagent({ task: "…", model: "<alias>", maxRounds: 32, attention: false })
spawn_subagents({ tasks: [{ task: "…" }, { persona: "<other-agent>", task: "…" }] })
```

- **Every spawn is a background task.** `spawn_subagent` registers a
  task and starts the sub in the background whichever way it is
  called. **`wait: false`** (default) returns the `task_id` at once
  and the caller's turn ends. **`wait: true`** waits for that same
  task and returns the sub's final answer inline — the result, the
  runtime verdict and the `task_id`. Because a synchronous sub is an
  ordinary task, it appears in `subagent_list`, a person can stop it
  with the Stop button, and `subagent_cancel` reaches it and every
  sub it spawned while the parent is still waiting.
- **When the wait runs out.** The wait is sized off
  `agentLoop.longTaskMaxTimeoutMs` (default 30 minutes, minus a few
  seconds). A sub still working by then does not fail: the tool
  returns `ok: false, wait: "sync", state: "pending"` with the
  `task_id` and a hint, the sub keeps running, and the parent is woken
  with a `[subagent attention]` turn when it finishes — or fetches the
  result itself with `subagent_result({ task_id })`. A sub that
  finishes inside the wait does not wake the parent; the parent has
  the result.
- **`spawn_subagents`** runs up to eight tasks in parallel and returns
  one result per task in the same order; `wait` applies to the batch.
- **`model`** overrides the persona's default for this sub (an alias or
  `provider/id` exactly as configured). **`maxRounds`** raises the
  sub's tool-call round cap above `agentLoop.maxRounds` — orchestrator
  subs that spawn and poll their own subs need it. **`images`** works
  as for `agent_ask`.
- **Checking on a sub.** `subagent_status({ task_id })` reports
  `running`, `done`, `failed` or `cancelled` with target and
  timestamps. `subagent_result({ task_id, wait_until_done?, timeout_ms? })`
  returns `done` with the text, `usage`, the runtime verdict `outcome`
  (`completed`, `partial`, `degraded`, `failed`) with `outcome_reason`,
  `tool_calls`, `rounds`, `files_written`, `media` and
  `follow_ups` (texts that arrived after the sub's report, oldest
  first — see the follow-up wake below); `failed` with
  the error; or `pending`. `subagent_list({ state?, limit? })` lists
  the caller's own tasks, newest first, from the server's in-memory
  registry (a restart empties it). `subagent_cancel({ task_id,
  reason? })` cancels a sub of your own — running, or still waiting in
  its session's queue — and every sub it spawned; files on disk and the
  session stay.
- **Attention wake.** When a background sub finishes and its result has
  not been fetched, the parent is woken in the session it spawned from
  with a `[subagent attention]` turn. Its text is the record:

  ```text
  [subagent attention] Task '<task_id>' (sub-agent '<name>', session 'sub-…') finished with state 'done'. Outcome: completed, 7 tool calls, 3 rounds. First line: "…" Files written (1): … Generated media (1): …
  ```

  The instruction — fetch the full answer with `subagent_result({
  task_id })`, then continue whatever depended on it — accompanies
  the turn as its frame, beside the text. A brief a person removed
  from the queue wakes the parent the same way (`… was removed from
  the queue by the user before it started — there is no result.`).
  The wake waits `agentLoop.wakeGraceMs` (default 3 seconds); a
  `subagent_result` inside that window cancels it, and
  `attention: false` opts a spawn out of it altogether — except when
  the spawn happened while answering another agent or a voice call:
  they wait for the outcome and hear it through the follow-up, which
  needs that wake, so the flag does not count there. A sub a person
  stops from the queue (■ under From here, `/queue rm` in the TUI)
  wakes its parent the same way, with `was stopped by the user before
  it finished — there is no result`; a sub the parent cancels itself,
  and children taken down with their parent, wake no one.
- **Follow-up wake.** A sub that starts sub-agents of its own is told
  in its system prompt not to hand in its report while they are still
  working: wait for them (`wait: true`, or `subagent_result` with
  `wait_until_done`) and fold their results in, because what it returns
  is what its parent gets. A sub that reports early anyway does not
  leave its parent without the rest. Whatever a sub starts is
  remembered as started during its task — its own subs, the agents it
  asks, and what those start in turn — and when the last of it has
  finished and the wake about it has run in the sub's session, the
  parent gets one more `[subagent attention]` turn:

  ```text
  [subagent attention] Task '<task_id>' (sub-agent '<name>', session 'sub-…') has a follow-up: the work it started has finished. It begins: "…"
  ```

  Its frame: fetch it with `subagent_result({ task_id })` — the
  follow-up is in `result.follow_ups` — then continue whatever
  depended on it; if nothing does, a short acknowledgement to the user
  is enough. The sub's own wake turns (about its subs) carry the
  matching note — "What you answer in this turn is forwarded to your
  parent (<agent>, session <session>) as the follow-up to task
  '<task_id>' …" — so the sub writes them as its report. The text is
  the final text of that last wake turn;
  `result.follow_ups` (also under `GET /spawn-result`) keeps every
  follow-up of a task, oldest first. A parent hears once, after the
  whole tree, not once per level, and work started inside a wake turn
  extends the tree. The follow-up waits the same grace, and a
  `subagent_result` inside it cancels it. There is none for a task a
  person asked for, for one that did not finish `done`, for a wake turn
  a person stopped, or after a server restart; a wake turn that failed
  for another reason still sends one, saying the work finished but the
  turn reporting it failed, with the error.
- **Limits.** Nesting is capped at depth 3. Each agent may run 4 subs
  at once and the whole server 16; subs spawned by subs count against
  the parent's 4 and may fill only 3 of them, so an orchestrator sub
  can never lock its own agent out. A spawn that finds a cap full is
  refused with the numbers.

A sub's turn is a turn like any other: it waits in its session's
queue, shows up in `/health` and in the session's queue view, and a
person can stop it — the parent then sees the task as `failed` with
`stopped by the user` — or remove it from the queue before it starts,
which the parent sees as `cancelled` with `removed from the queue by
the user before it started`.

## Programmatic agent creation

If you want to script agent creation, the directory layout is the contract.
Drop the files into `~/.somora/agents/<name>/` and they're picked up on the
next `GET /agents` request.

The HTTP API:

```
GET    /agents                                   list agents
GET    /agents/:agent/sessions                   list sessions
POST   /agents/:agent/sessions    {slug}         create session
POST   /agents/:agent/sessions/:session/reset    archive + reset (spawns REM if configured)
GET    /agents/:agent/memory/notes               list memory inbox notes
GET    /agents/:agent/memory/search?q=…          hybrid recall across memory+wiki+vault (debug)
POST   /agents/:agent/tools/:name                invoke a tool directly (debug)
POST   /dream/run-deep    {wait?, force?}        trigger Deep manually (platform-wide)
POST   /dream/run-lucid   {wait?}                trigger Lucid manually (platform-wide)
```

See:
- [memory.md](memory.md) — the per-agent memory inbox + retrieval
- [wiki.md](wiki.md) — the shared long-term wiki layer
- [dream-phases.md](dream-phases.md) — REM/Deep/Lucid mechanics
- [tools.md](tools.md) — full tool reference
