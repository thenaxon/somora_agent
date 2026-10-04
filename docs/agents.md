# Agents

An agent is one assistant with its own name, character, memory and
model. You can have many. Each one is a folder of plain files under
`~/.somora/agents/`, and changes to those files apply on the next turn.

## What you get

- **A folder is an agent.** One `AGENTS.md` is enough. No registration,
  no restart.
- **Its own model and backups.** Each agent names its model and an
  ordered chain of fallbacks for when that model is down.
- **Its own tools.** Hide tools, skills and remote resources per agent.
- **Agents that maintain themselves.** An agent can edit its own
  persona and settings, and those of its colleagues. Every change keeps
  a backup.
- **Teamwork.** Agents ask each other questions and hand tasks to
  sub-agents. Whoever started work is told when it is done.
- **A window to look inside.** The web client shows the persona files,
  their size against a budget, and the full prompt of the next turn.

## Set it up

The guided way asks for a name, a description and a model, and writes
the files:

```bash
somora setup agent
```

By hand, create a folder with an `AGENTS.md`:

```bash
mkdir -p ~/.somora/agents/<your-agent>
cat > ~/.somora/agents/<your-agent>/AGENTS.md <<'EOF'
---
name: <your-agent>
description: Engineering-minded research assistant
icon: 🌼
---

- Be precise. Quote sources when you have them.
- Do not speculate beyond your memory and the conversation.
EOF
echo "model: <alias>" > ~/.somora/agents/<your-agent>/agent.yaml
```

The agent appears in the next agent list (`/agents` in the TUI, the dock
in the web client). An agent needs a `model`: without one its turns fail
with an error that lists the configured models.

Folder names may contain letters, digits, `_`, `-` and `.`, and must not
start with a dot (`^[A-Za-z0-9_-][A-Za-z0-9_.-]*$`). Lowercase is the
convention. `somora setup agent` is stricter: lowercase letters, digits
and dashes, starting with a letter.

On a fresh install with no agents, somora creates one named `default`.
Rename or replace it.

## Chat agents and builders

Every agent has a kind, set as `kind` in `agent.yaml` when it is created
and not changed afterwards. This page describes chat agents, the
default. A builder (`kind: builder`) is a coding harness and has
[its own page](builder.md).

| | Chat agent | Builder |
|---|---|---|
| **What it is for** | Talking, thinking, remembering, coordinating | Building software in a repository: plan, edit, run, test, report |
| **Its prompt** | Its persona files, your team, the wiki map, memory recall | Harness rules, an environment block, the repository's own `AGENTS.md` or `CLAUDE.md`. No persona prose, no memory recall |
| **Tools** | Everything configured, minus what you hide | A short coding set, plus what you allow |
| **Skills** | All, minus what you hide | None, plus what you allow |
| **Turn limits** | The server's `agentLoop` values: 8 rounds, 30 tool calls | 500 rounds, 2000 tool calls, 8 hours |
| **Memory** | Notices facts, dreams them into notes and the wiki | Reads memory, never writes it, does not dream |
| **Works in** | Its workspace | The pinned project's folder |
| **Window** | Chat | Chat plus a task panel |

## The agent folder

```
~/.somora/agents/<name>/
├── AGENTS.md                 ← required: identity (frontmatter) and behaviour rules
├── SOUL.md                   ← optional: voice and character
├── USER.md                   ← optional: what the agent knows about you
├── VOICE.md                  ← optional: character for spoken calls
├── agent.yaml                ← optional: model, tools, voice, REM
├── *.bak-<timestamp>         ← backups of the five files above
├── memory.db (+ -wal, -shm)  ← search index of this agent's notes
├── memory/                   ← the agent's notes (its inbox)
│   └── .dreams/              ← REM findings
└── sessions/                 ← chat history, two files per session
    ├── main.jsonl
    ├── main.meta.json
    └── 20260501-143022_some-topic.jsonl
```

The memory folder is short-term. The Deep phase moves lasting knowledge
into the shared wiki and removes the note.

## Persona files

| File | In the prompt | What goes in it |
|---|---|---|
| `SOUL.md` | first | Voice and character. "I speak in short sentences. I have dry humour." |
| `AGENTS.md` | second, under `# Behaviour` | Behaviour rules. "Reply concisely." "Use tools when asked." |
| `USER.md` | third, under `# About the user` | Static context about you. "The user is Nina Muster. Two cats." |
| `VOICE.md` | no, only in realtime calls | A hand-written spoken character. It replaces the one derived from the other files. The rules that keep a call honest always stay. |
| `agent.yaml` | no | Settings, see [Settings](#settings). |

The files are read again on every turn. An edit applies to the next
message, without a restart.

What an agent knows about its colleagues does not belong in the
persona. It comes from `~/.somora/team.yaml`, one file for the whole
install. Keep `AGENTS.md` to the agent's own behaviour.

### Identity in the AGENTS.md frontmatter

```yaml
---
name: <your-agent>
description: Engineering-minded research assistant
icon: 🌼
color: "#5cf2d6"
role: Researcher
---
```

| Key | Meaning |
|---|---|
| `name` | Must equal the folder name. The folder name is what counts. The web editor refuses a save where the two differ. |
| `description` | One line, shown in agent lists. |
| `icon` | Emoji shown in the TUI and in listings. |
| `color` | Hex colour for the agent's tint in the web client. Without it the client picks one. |
| `role` | Short role tag under the name in the web dock. |

All keys are optional. A frontmatter that is not valid YAML does not
break the agent: the whole file is then used as the behaviour text.

### What the prompt is made of

The system prompt of a chat agent has these parts, in this order:

| Part | Content |
|---|---|
| Self-pointer | The agent's name, the paths of its persona files and `agent.yaml`, its workspace, the path of `config.yaml`, the visible remote resources, and how to link local files and show images in a reply. |
| Persona | `SOUL.md`, `AGENTS.md`, `USER.md`. |
| Team block | Rendered from `team.yaml`. |
| Tool reminder | A short constant text, when the agent has tools. |
| Wiki overview | A map of the shared wiki, fixed when the session starts. |
| Skills | The skills this agent may use. |
| This session | The session's name. |
| Project | The project pinned to the session. |

Memory recall is not part of the system prompt. It travels with each
message.

A local file is linked in a reply with its bare absolute path,
`[label](/home/.../file.md)`. The web client opens such a link in a file
window.

Because of the self-pointer, an agent knows where its files are. It can
change them without you dictating paths:

```
file_write({ path: "~/.somora/agents/<your-agent>/USER.md", content: "...", mode: "overwrite" })
file_read({ path: "~/.somora/agents/<your-agent>/agent.yaml" })
file_patch({ path: "~/.somora/config.yaml", old_string: "...", new_string: "..." })
```

To learn how somora works, agents read these docs with
`somora_docs_list` and `somora_docs_read`.

## Agents edit themselves and each other

An agent may edit its own persona files and `agent.yaml`, and those of
any other agent. This is intended: agents shape each other. The
convention is that character and rules evolve in the `.md` files and
settings in `agent.yaml`.

Two protections apply:

- **A backup first.** Every `file_write` or `file_patch` on `AGENTS.md`,
  `SOUL.md`, `USER.md`, `VOICE.md` or `agent.yaml` first writes
  `<file>.bak-<timestamp>`. The last five are kept. The web editor does
  the same.
- **Sessions are closed.** No agent can write into any `sessions/`
  folder. The conversation logs belong to somora.

> **Warning:** A mistake in `agent.yaml` does not stop the agent, it
> silently resets it. When the file fails validation, the whole file is
> ignored for that turn, including `model`. See
> [Troubleshooting](#troubleshooting).

## The Agent window

In the web client (`/web`), right-click the agent tile and choose
**Configure…**.

- **Budget strip.** Four meters in characters and estimated tokens:
  the persona files together, the team block, the full prompt, and the
  tool schemas. The first two are measured against `promptBudgets`.
- **Persona editors.** `AGENTS.md`, `SOUL.md` and `USER.md`, each with
  its own counter. A save is refused when the agent changed the file in
  the meantime, and every save keeps a backup.
- **agent.yaml.** Read-only here.
- **Full prompt.** The system prompt exactly as the next turn of a
  session would send it, split into its parts.
- **Voice prompt.** What the voice is told in a call. Only for agents
  with a `voice` block.

Tools and skills are switched per agent in the Abilities window. It
writes exact-name entries into `tools.deny` and `skills.deny`.

## Sessions

Each agent has any number of sessions. `main` always exists and cannot
be deleted. In the TUI:

| Command | What it does |
|---|---|
| `/agents` | Lists all agents. |
| `/agent <name> [session]` | Switches to an agent, into `main` or the named session. |
| `/sessions` | Lists the current agent's sessions. |
| `/session <slug-or-id>` | Switches to a session. |
| `/new <slug>` | Creates a session and switches to it. |
| `/main` | Back to the main session. |
| `/reset YES` | Archives the current session and starts it fresh. The archive can be resumed with `/session <id>`. |
| `/model` | Shows the model in use. |
| `/model <alias>` | Uses that model for this session only. |
| `/model default` | Drops the override. |
| `/models` | Lists every configured model with its alias. |
| `/export [json\|markdown] [path]` | Writes the session to a file. Default: Markdown to `./<agent>-<session>.md`. |

A model override is stored with the session and survives a restart.

The Markdown export is a readable transcript with tool calls as fenced
blocks and task lists as checkboxes. The JSON export is the session
file itself, for backups or for moving a conversation to another host.
In the web client both are icons on each row of the Sessions tool.

## Talking to another agent

Agents talk to each other with `agent_ask`. The message lands in the
target's real session as a user message. The target answers with its
full memory, persona and history, and the exchange stays visible there.

```
agent_ask({ agent: "<other-agent>", message: "…" })
agent_ask({ agent: "<other-agent>", session: "project-a", create_session: true, model: "<alias>", message: "…" })
agent_ask({ agent: "<other-agent>", message: "…", images: ["/abs/path.png"], timeout_ms: 120000 })
```

The target sees the header `[Message from agent <name>, session <slug>]`
in front of the message. The header is a frame around the turn. The
stored text is the message itself, so the target's memory is built from
the message alone.

This is request and response, not a message bus. An agent that received
a question answers by finishing its turn, never by calling `agent_ask`
back. An agent cannot ask itself: that is what `spawn_subagent` is for.

### Parameters

| Parameter | Meaning |
|---|---|
| `agent`, `message` | The target and the text. |
| `session` | The target session. Without it, a reply to the agent that wrote to you (or to your spawning parent) goes back to the session that message came from. Anything else goes to the target's `main`. An unknown name is an error that lists the target's sessions. |
| `create_session` | `true` creates the named session on the target when it is missing. Not for `main`, ids or `sub-…` sessions. |
| `model` | Pins an alias or `provider/id` on the session this call creates. On an existing session it is ignored and `session_note` says so. Use `session_model` to change an existing session. |
| `images` | Absolute paths. A target with vision sees the pictures. One without gets the vision worker's description. |
| `wait` | `true` (default) blocks until the reply. `false` hands the message over and returns `pending` at once. |
| `timeout_ms` | How long to wait. Default `agentLoop.longTaskDefaultTimeoutMs` (5 minutes), capped at `agentLoop.longTaskMaxTimeoutMs` (30 minutes). |

Use `wait: true` when you need the answer to go on with this turn, and
`wait: false` for a job that may take its time. The call waits in the
target session's queue in arrival order, like a typed message.

A session created this way tells the target so, beside its first
message:

```text
[Your session '<slug>' was just created by <agent> for this conversation; it runs on model <model>.]
```

### Result states

| `state` | What it carries | Meaning |
|---|---|---|
| `done` | `response`, `ms`, `usage`, `call_id`, `target_agent`, `target_session`, `routing_reason` | The target answered. |
| `pending` | `call_id`, `hint` | The target is still queued or running, or the call used `wait: false`. The target keeps working and the message is never sent again. |
| `failed` | `error`, `hint` | The target's turn failed (a model or engine error, or `stopped by the user`), or a person took the call out of the queue (`removed from the queue by the user before it started`). Do not retry on your own. |

`routing_reason` is `explicit`, `reply_to_origin` or `default_main`.
These fields appear when they apply: `session_inferred`,
`session_created`, `session_model`, `session_note`, and `routing_note`.
The last one warns that the message went to the target's `main` although
the caller works in another session, so the target may lack the context.

### Fetching a pending answer

`agent_ask_result({ call_id })` returns `done` with the reply, `failed`
with the error, or `pending` with `phase` `queued` or `running`.
`wait_until_done: true` blocks on the server until the call finishes or
`timeout_ms` passes, which is cheaper than polling. After a server
restart, pass `agent` and `session` of the original call: the answer is
then read from the target's session.

### The wake

An asker that stopped waiting, or never waited, does not have to poll.
When the answer lands, the asker is woken in the session it asked from:

```text
[agent answer] <other-agent> has answered the question you sent to session 'main' — you had stopped waiting for it. It begins: "…"
```

The turn tells the agent to read the whole answer with
`agent_ask_result({ call_id })` and then do what depended on it. A
failed call, and one a person removed from the queue, wake the asker the
same way.

The wake waits `agentLoop.wakeGraceMs` (3 seconds). Reading the result
inside that time cancels it. An asker still waiting gets none. The same
mechanism brings back a finished background sub-agent and a rendered
video.

### Taking a question back

`agent_ask_cancel({ call_id })` takes back a call of your own. Another
agent's call cannot be taken back.

| Result | When |
|---|---|
| `removed` | The call was still waiting in the queue. The target never sees it. |
| `withdrawn` | The call was already running, which is the usual case. The target is told to stop, and whatever it still delivers no longer wakes you. `steered: true` means the stop message reached the running turn. `false` means the engine reads no messages mid-turn or the turn had just ended. |
| `unknown` | Nothing runs or waits under this id. |

The tool never aborts another agent's turn. Only a person's Stop does
that.

### Follow-ups

A target may answer "I am working on it with sub-agents and will report
back". Its turn ends while the work goes on. The asker does not need to
ask again.

Every piece of work remembers the turn it was started in. The
sub-agents the target spawned while answering, the calls it made, and
whatever those start, form a tree under the original call. Work started
inside a wake turn extends the tree.

When the last member has finished and the target's wake turn about it
has run, the asker gets one follow-up message. It carries what the
target wrote in all its wake turns about this work, oldest first. Four
subs are four wakes for the target and one follow-up for the asker.

So that the target writes for the asker, each of its wake turns carries
this note:

```text
What you answer in this turn is forwarded to agent <asker> as the follow-up to the question they sent (call_id "<id>") once all the work you started for it has finished — write it as the answer to that question, with the results, not as a note to yourself.
```

The follow-up arrives as an ordinary message from the target
(`origin.kind: "agent"` with the original `call_id`), framed like this:

```text
[Follow-up on the question you sent earlier (call_id "<id>"): the work it started has finished. Below is its result — treat it as the answer to that question. Continue whatever depended on it; if nothing does, tell your human in one line.]
```

There is no follow-up when:

- the work hangs under a person's turn, or under a turn nobody asked
  for, such as a sentinel fire or a tmux wake
- the call did not finish `done`
- a person stopped the wake turn
- the target has already sent the asker a message of its own since
- the asker read the result with `agent_ask_result` during the grace
- the server was restarted: the tree lives in memory

A wake turn that fails for another reason still sends one. It says the
work finished but the turn reporting it failed, with the error.

### No deadlocks

The server tracks who waits on whom. A blocking call that would close a
circle, even through three or more agents, is refused with an error
that says so. Sub-agents waiting on their parents are part of the same
check.

## Sub-agents

`spawn_subagent` delegates a sealed task. The sub runs in a fresh
session of the target agent, with normal memory, tools and thinking,
and returns a final answer. The session is named
`sub-<parent>-<timestamp>`, or `sub-self-…` for a clone of the caller,
and stays visible in the session list with a "sub from" marker.

```
spawn_subagent({ task: "…" })                                   # clone of yourself, background
spawn_subagent({ persona: "<other-agent>", task: "…", wait: true })
spawn_subagent({ task: "…", model: "<alias>", maxRounds: 32, attention: false })
spawn_subagents({ tasks: [{ task: "…" }, { persona: "<other-agent>", task: "…" }] })
```

| Parameter | Meaning |
|---|---|
| `task` | The brief. The sub sees nothing else of the parent's conversation. |
| `persona` | The agent to run as. Default: a clone of the caller. |
| `wait` | `false` (default) returns the `task_id` at once. `true` waits and returns the answer, the runtime verdict and the `task_id`. |
| `model` | An alias or `provider/id` for this sub. |
| `maxRounds` | Raises the round cap above `agentLoop.maxRounds` for this sub, up to 100. Subs that orchestrate their own subs need it. |
| `attention` | `false` switches off the wake when the sub finishes. Ignored when the spawn happened while answering another agent or a voice call: those wait for the outcome. |
| `images` | As for `agent_ask`. |

`spawn_subagents` runs up to eight tasks in parallel and returns one
result per task in the same order. `wait` applies to the whole batch.

Every spawn is a background task, also with `wait: true`. It appears in
`subagent_list`, a person can stop it, and `subagent_cancel` reaches it
and every sub it started.

A `wait: true` that runs out is not a failure. The wait is just under
`agentLoop.longTaskMaxTimeoutMs` (30 minutes). After that the tool
returns `ok: false, wait: "sync", state: "pending"` with the `task_id`.
The sub keeps running and the parent is woken when it finishes.

### Checking on a sub

| Tool | What it returns |
|---|---|
| `subagent_status({ task_id })` | `running`, `done`, `failed` or `cancelled`, with target and timestamps. |
| `subagent_result({ task_id, wait_until_done?, timeout_ms? })` | `done` with the text, `usage`, `outcome` (`completed`, `partial`, `degraded`, `failed`), `outcome_reason`, `tool_calls`, `rounds`, `files_written`, `media` and `follow_ups`. Or `failed` with the error, or `pending`. |
| `subagent_list({ state?, limit? })` | The caller's own tasks, newest first. The list lives in memory: a restart empties it. |
| `subagent_cancel({ task_id, reason? })` | Cancels a sub of your own, running or queued, and every sub it spawned. Files and the session stay. |

### The attention wake

When a background sub finishes and nobody fetched its result, the
parent is woken in the session it spawned from:

```text
[subagent attention] Task '<task_id>' (sub-agent '<name>', session 'sub-…') finished with state 'done'. Outcome: completed, 7 tool calls, 3 rounds. First line: "…" Files written (1): … Generated media (1): …
```

The turn tells the parent to fetch the full answer with
`subagent_result({ task_id })` and continue. The wake waits
`agentLoop.wakeGraceMs`, and a `subagent_result` inside that time
cancels it. A sub that finishes inside a `wait: true` wakes no one.

| What happened to the sub | The parent sees | Woken |
|---|---|---|
| A person pressed Stop in the sub's session | `failed`, `stopped by the user` | yes |
| A person stopped it from the queue view (■ under "From here", or `/queue rm` in the TUI) | `cancelled`, `stopped by the user` | yes |
| A person removed it from the queue before it started | `cancelled`, `removed from the queue by the user before it started` | yes |
| The parent cancelled it, or it went down with its parent | `cancelled` | no |

### Follow-ups from a sub

A sub that starts sub-agents of its own is told not to hand in its
report while they still work. It should wait for them (`wait: true`, or
`subagent_result` with `wait_until_done`) and fold their results in.

A sub that reports early anyway does not leave its parent without the
rest. The work it started is tracked as a tree, as for `agent_ask`.
When the last of it has finished, the parent gets one more wake:

```text
[subagent attention] Task '<task_id>' (sub-agent '<name>', session 'sub-…') has a follow-up: the work it started has finished. It begins: "…"
```

The text is in the `follow_ups` field of `subagent_result`
(`result.follow_ups` under `GET /spawn-result`), which keeps every
follow-up of a task, oldest first. The parent hears once, after the
whole tree, not once per level.

The sub's own wake turns carry the matching note, so it writes them as
its report:

```text
What you answer in this turn is forwarded to your parent (<agent>, session <session>) as the follow-up to task '<task_id>' …
```

There is no follow-up for a task a person asked for, for one that did
not finish `done`, for a wake turn a person stopped, or after a server
restart. A wake turn that failed for another reason still sends one,
with the error.

### Limits

| Limit | Value |
|---|---|
| Nesting depth | 3 |
| Subs running at once, per agent | 4 |
| Subs running at once, whole server | 16 |
| Subs started by subs | Count against the parent's 4 and may fill only 3 of them, so an orchestrating sub cannot lock its agent out. |

A spawn that finds a limit reached is refused with the numbers. A sub's
turn is a turn like any other: it waits in its session's queue and
shows up in `GET /health` and in the queue view.

## What a restart does to running turns

A server restart cuts every running turn. At the next start somora
closes each open turn with an `error` entry and a `turn_end`, so the
window stops showing it as running and the history is whole again:

```text
[somora] This turn was interrupted by a server restart; the work it was doing stopped here.
```

Whoever waited for such a turn is woken and told. Nothing is run again
by itself.

| Who waited | Wake text begins |
|---|---|
| An agent that asked with `agent_ask` or `builder_dispatch` | `[system: restart] The question you sent to <agent> (session '<session>') was cut off by a server restart before an answer came`, with the `call_id` |
| The parent of a sub-agent | `[system: restart] The helper in <agent>'s session '<session>' was cut off by a server restart before it finished; there is no result.` |

> **Tip:** An agent that needs to restart somora should run
> `somora server restart` or `somora update` from its shell. The restart
> then waits until the agent's turn has ended, and the agent is woken
> afterwards.

## Settings

All of this lives in `~/.somora/agents/<name>/agent.yaml`. Every key is
optional. Unknown keys are ignored.

```yaml
kind: chat                  # chat | builder
model: opus                 # alias or provider/modelId
fallback: [gpt55, orhaiku]  # one ref or an ordered list
thinking: medium            # off | low | medium | high
steering: false
imageReview: never          # never | always

sampling:
  temperature: 1.0
  top_p: 0.95

agentLoop:
  maxRounds: 50
  maxToolCallsPerTurn: 200
  maxTurnMs: 3600000

workspace:
  path: ~/<your-agent>-workspace

tools:
  deny: ['toolset:exec', 'mcp__parallel__*']
  allow: []

skills:
  deny: ['instagram-downloader']

resources:
  deny: ['production-db']

voice:
  enabled: true
  voice: ash
  language: de
  style: "dry, direct, no small talk"
  consultPolicy: always     # auto | substantive | always
  maxSpokenSentences: 4

rem:
  enabled: true
  model: gemma4big
  fallback: [glm, deep41flash]
  idleMinutes: 30
  chunkTokens: 50000
  chunkTimeoutMs: 600000
  participate_in_wiki: true
  thinking: low
```

### Model and fallback

| Key | Type | Default | Meaning |
|---|---|---|---|
| `model` | string | none | The agent's model: an alias or `provider/modelId` from `config.yaml`. A session override (`/model`) wins over it. |
| `fallback` | string or list | none | Backup models, tried in order. Repeated entries and the primary itself are dropped. |
| `thinking` | `off`, `low`, `medium`, `high` | the model's own | Reasoning depth. Applies only to models with the `reasoning` capability. Per session: `/thinking <level>`. |
| `sampling` | map | the model's own | Sampling values for `openai-compatible` models, per key over the model's defaults. Per session: `/sampling`, `/temp`. No effect on the CLI engines. |

`sampling` accepts `temperature` (0 to 2), `top_p` (0 to 1), `top_k`,
`min_p` (0 to 1), `frequency_penalty` and `presence_penalty` (-2 to 2),
`repetition_penalty`, `seed` and `stop` (a string or up to four). Any
other key in this block is an error.

How the fallback chain works:

- **When it switches.** A backup takes over only when the model before
  it failed before its first output and before any tool call. A turn
  that already called a tool is never repeated on another model: the
  side effects have happened.
- **Refusals as text.** Some providers send their refusal, such as a
  quota notice, as answer text and then report an error. That text is
  not an answer, so the chain still runs.
- **You see it.** The turn carries a fallback chip and the web client
  shows a notice.
- **Dead models are remembered.** A model that was unreachable is
  skipped for `fallback.retryUnavailableMinutes` (default 60, in
  `config.yaml`). Turns start on the working backup at once. The chip's
  reason then reads `not tried — marked unavailable since …`. After
  that time the primary is tried again, and a success clears the mark.

> **Tip:** Put at least one fallback on a different host or provider
> than the primary. Two models on the same GPU box go down together.

### Behaviour

| Key | Type | Default | Meaning |
|---|---|---|---|
| `kind` | `chat`, `builder` | `chat` | The kind of agent. Set once at creation. |
| `steering` | boolean | `false` | Default for a message typed in the web client while a turn runs. `true` hands it into the running turn before its next step. `false` queues it as its own turn. The toggle next to Send flips it per message. Steering works on `openai-compatible`, `claude-cli` and `codex-cli`. Other engines always queue. |
| `imageReview` | `never`, `always` | `never` | `always` feeds each generated image back to the agent so it can judge it, about 2k tokens per image. Not a lock: the agent can set `return_image` per call either way. |
| `agentLoop.maxRounds` | integer | server value (8) | Rounds per turn on the `openai-compatible` engine. Builders default to 500. |
| `agentLoop.maxToolCallsPerTurn` | integer | server value (30) | Tool calls per turn, across all rounds. Builders default to 2000. |
| `agentLoop.maxTurnMs` | integer | none | Time limit per turn in milliseconds. Builders default to 8 hours. |

### Workspace and visibility

| Key | Type | Default | Meaning |
|---|---|---|---|
| `workspace.path` | string | `workspace.default` in `config.yaml` (`~/somoraworkspace`) | Default folder for the `file_*` tools. `~` expands. Created at server start. |
| `tools.deny` | list | empty | Tools to hide. |
| `tools.allow` | list | empty | When not empty, only these tools are offered. |
| `skills.deny` | list | empty | Skills to hide. |
| `skills.allow` | list | empty | When not empty, only these skills are offered. A plain list (`skills: [a, b]`) means the same. |
| `resources.deny` | list | empty | Remote resources to hide. There is no allow list. |

Rules for `tools` and `skills`:

- `deny` beats `allow`. No block means no restriction.
- A tool pattern is an exact name (`web_search`), a toolset
  (`toolset:exec`) or a name with a trailing `*` (`mcp__parallel__*`).
  The same patterns cover built-in tools and tools from MCP servers.
- A hidden tool is removed from the model's tool list, which saves
  context on every turn.
- Only tools whose configuration exists are offered at all. The
  Abilities window lists exactly those.
- The Abilities window edits exact names only. When the file holds an
  `allow` list or patterns, the window shows them read-only.
- For a builder, `tools.allow` adds to the builder set and
  `skills.allow` is the complete list.

### Voice

Without a `voice` block the agent cannot be called and does not appear
in the voice picker. The block holds only what speaking needs. Who the
agent is comes from its persona files.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `voice.enabled` | boolean | `true` | Switches the voice off without removing the block. |
| `voice.voice` | string | the provider's | Voice id, for example `ash`. |
| `voice.language` | string | the speech-to-text language | Spoken language, 2 to 8 characters. |
| `voice.style` | string | none | One line on how the agent sounds. Up to 400 characters. |
| `voice.consultPolicy` | `auto`, `substantive`, `always` | `realtimeVoice.consultPolicy` | When the voice must ask the agent before answering. |
| `voice.maxSpokenSentences` | integer, 1 to 10 | `4` | Longest spoken answer. |

### REM

REM is the per-agent dream phase. After a session goes quiet it reads
the conversation and proposes notes for the agent's memory. Deep and
Lucid work for the whole install and are set under `wiki.deep` and
`wiki.lucid` in `config.yaml`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `rem.enabled` | boolean | required | Master switch. |
| `rem.model` | string | required | The worker model. It never inherits the chat model, so REM cannot run on an expensive model by accident. |
| `rem.fallback` | string or list | none | Backup workers, tried in order when the one before is unreachable: connection refused, a 5xx error, a timeout, a rate limit. A 4xx error is a configuration problem and does not switch. It never inherits the chat fallback. |
| `rem.idleMinutes` | number | `30` | Quiet minutes before REM starts. Every message to the agent resets the count. |
| `rem.chunkTokens` | integer | `50000` | Size of one piece of a long session. |
| `rem.chunkTimeoutMs` | integer | `600000` | Time limit per piece. Ten minutes leaves room for local models. A piece that runs out is marked failed and REM continues with the next. |
| `rem.participate_in_wiki` | boolean | `true` | `false` keeps Deep away from this agent's notes. REM still runs. Useful for scratch agents. |
| `rem.thinking` | `off`, `low`, `medium`, `high` | none | Reasoning depth for the worker, when its model has the `reasoning` capability. |

The worker can be a model on `claude-cli`, `codex-cli` or an
`openai-compatible` provider. A model on `grok-cli` cannot run REM.

> **Note:** A `rem` block needs both `enabled` and `model`, also with
> `enabled: false`. REM agents are registered when the server starts:
> restart after you switch REM on or change `idleMinutes`.

### Related settings in config.yaml

| Setting | Default | Meaning |
|---|---|---|
| `fallback.retryUnavailableMinutes` | `60` | How long an unreachable model is skipped. 1 to 1440. |
| `agentLoop.maxRounds` | `8` | Rounds per turn, `openai-compatible` engine. |
| `agentLoop.maxToolCallsPerTurn` | `30` | Tool calls per turn. |
| `agentLoop.longTaskDefaultTimeoutMs` | `300000` | Default wait of `agent_ask` and the result tools. |
| `agentLoop.longTaskMaxTimeoutMs` | `1800000` | Longest wait. |
| `agentLoop.wakeGraceMs` | `3000` | Delay before a wake turn. 0 to 60000. |
| `agentLoop.toolUsageReminder` | `true` | The tool reminder in the prompt. |
| `promptBudgets.personaFileChars` | `8000` | Budget for each of `AGENTS.md`, `SOUL.md`, `USER.md`. |
| `promptBudgets.personaTotalChars` | `14000` | Budget for the three together. |
| `promptBudgets.teamBlockChars` | `3000` | Budget for the team block. |
| `workspace.default` | `~/somoraworkspace` | Workspace of agents without their own. |

The prompt budgets are what the Agent window measures against. They
warn. They do not cut anything.

## Commands

| Command | What it does |
|---|---|
| `somora setup agent` | Creates an agent with guidance, and checks that every agent's model exists. |
| `somora setup memory` | Switches REM on per agent, among other things. |
| `somora team init`, `check`, `show <agent>` | Creates and validates `team.yaml`, and prints the team block an agent sees. |
| `somora tui` | Opens the TUI, where the commands under [Sessions](#sessions) work. |

There is no command that creates an agent without questions. For
scripts, the folder layout is the contract: write the files and the
agent is there on the next `GET /agents`.

## Routes

| Route | What it does |
|---|---|
| `GET /agents` | Lists agents: `name`, `description`, `icon`, `color`, `role`, `steering`, `kind`. |
| `GET /agents/:agent/persona` | The persona files and `agent.yaml` with content, hash and size, plus `promptBudgets`. |
| `PUT /agents/:agent/persona/:file` | Saves `AGENTS.md`, `SOUL.md` or `USER.md`. Body `{content, baseHash}`. Answers 409 with the current content when the file changed since `baseHash`. |
| `GET /agents/:agent/prompt-preview?session=` | The system prompt of the next turn, its parts, and the visible tools with their schema size. |
| `GET /agents/:agent/system-prompt` | The persona part of the prompt only. |
| `GET /agents/:agent/tools` | The configured tools with a `visible` flag each. |
| `PUT /agents/:agent/tools` | Writes `tools` into `agent.yaml`. Body `{deny, allow}`. |
| `GET /agents/:agent/skills` | The skills with a `visible` flag each. |
| `PUT /agents/:agent/skills` | Writes `skills` into `agent.yaml`. Body `{deny, allow}`. |
| `POST /agents/:agent/tools/:name` | Runs a tool directly, for debugging. |
| `GET /agents/:agent/sessions` | Lists sessions. |
| `POST /agents/:agent/sessions` | Creates a session. Body `{slug}`. 409 when the name is taken. |
| `POST /agents/:agent/sessions/:session/reset` | Archives the session and starts it fresh. |
| `POST /agents/:agent/sessions/:session/archive`, `/unarchive` | Archives a session, or brings it back. |
| `GET /agents/:agent/sessions/:session/export?format=` | The session as `markdown` (default) or `json`. |
| `GET`, `PUT`, `DELETE /agents/:agent/sessions/:session/model` | The session's model override. `/thinking` and `/sampling` work the same way. |
| `GET /agents/:agent/memory/notes` | Lists the agent's indexed notes. |
| `GET /agents/:agent/memory/search?q=` | Searches memory, wiki and vault, for debugging. |
| `POST /agents/:agent/dream/run-rem` | Starts REM for this agent now. |
| `POST /dream/run-deep`, `POST /dream/run-lucid` | Start Deep or Lucid, for the whole install. Body `{wait?, force?}` and `{wait?}`. |
| `GET /spawn-result` | The result of a sub-agent task, as `subagent_result` reads it. |

Bodies and answers in full are on the [API](api.md) page.

## Troubleshooting

**The agent does not appear.** The folder needs an `AGENTS.md`, and the
folder name must match the naming rule under [Set it up](#set-it-up).

**The agent ignores its `agent.yaml`.** One invalid value makes somora
ignore the whole file: the agent then has no model, no tool rules and
no REM. The log line `persona.agent_yaml_parse_failed` names the key.
Common causes: a `rem` block without `model`, an unknown key under
`sampling`, a `thinking` value outside the four levels, or broken YAML.
`persona.agent_yaml_not_object` means the file is not a key and value
map.

**Turns fail with "model … cannot be resolved".** `model` is missing or
is not an alias or `provider/modelId` from `config.yaml`. The error
lists the valid names. If the model is set, check the point above.

**The frontmatter is ignored.** `persona.frontmatter_parse_failed` in
the log: the frontmatter of that file is not valid YAML. Quote values
that contain a colon.

**A fallback never runs.** The primary produced output or called a tool
before it failed. That turn is not repeated. Entries equal to the
primary are dropped (`persona.fallback_is_primary`), as are repeated
ones (`persona.fallback_duplicate`).

**The web editor refuses a save.** The agent changed the file after you
opened it. Reload and apply your change again. An empty `AGENTS.md`,
and a `name` that differs from the folder, are refused too.

**REM does not start.** `POST /agents/:agent/dream/run-rem` answers
"REM is not enabled" when `rem.enabled` is not `true`, and "REM worker
has no entry" when REM was switched on after the server started.
Restart the server.

**A file was overwritten.** Look for `<file>.bak-<timestamp>` next to
it. To see who changed the tool or skill rules through the web client,
search the log for `agents.tool_gating_updated`.

## See also

- [Builder agents](builder.md): the other kind of agent
- [Team](team.md): `team.yaml` and what agents know about each other
- [Models](models.md): providers, aliases and capabilities
- [Tools](tools.md): every tool, and choosing tools per agent
- [Skills](skills.md): skills and their visibility
- [Resources](resources.md): remote machines an agent can reach
- [File tools](files.md): where agents may write, and the backups
- [Memory](memory.md): the agent's notes and recall
- [Wiki](wiki.md): the shared long-term layer
- [Dream phases](dream-phases.md): REM, Deep and Lucid
- [Thinking](thinking.md) and [Sampling](sampling.md): the levels and
  values in detail
- [Realtime voice](realtime-voice.md): calls, `VOICE.md` and the voice
  settings
- [Web client](web.md): the Agent window, Abilities and Sessions
- [API](api.md): all routes, including `steer` on `POST /chat/send`
