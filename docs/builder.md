# Builder agents

A builder is an agent made for writing software. It works in a
repository on the machine somora runs on: it reads the code, makes a
plan, waits for your Go, then edits, runs and tests until the job is
done. You talk to it in the chat like to any other agent, and another
agent can hand it an order.

## What you get

- **Plan first, then build.** The builder writes a plan file and stops.
  Nothing in the repository changes until you press Go.
- **A task panel beside the chat.** You see the task list, how long the
  turn has been running and what it is doing right now.
- **Questions with buttons.** At a real fork the builder asks you and
  waits. Everything routine it decides itself.
- **Hand-over from another agent.** An agent that planned with you
  sends the order with one tool call and is woken with the report.
- **It stays in its project.** A builder pinned to a project folder
  writes only there.
- **Turns that run for hours.** Generous limits, compaction inside the
  turn, and compiler errors after every write keep long builds on
  track.

## Set it up

A builder is a folder with two files:

```
~/.somora/agents/<name>/
  AGENTS.md    frontmatter: name, description, role, icon, color. Body: extra rules, optional
  agent.yaml   kind: builder, model, workspace, …
```

```yaml
# ~/.somora/agents/<name>/agent.yaml
kind: builder
model: deepseek            # any configured alias; local models work well here
workspace:
  path: ~/somoraworkspace  # working directory when no project is pinned
steering: true             # a message typed while it works goes INTO the turn
```

```markdown
---
name: ada
description: Builds and changes software in the repository it is pointed at.
role: builder
icon: 🔨
---
Rules for this builder that hold in every repository go here. Keep
them short.
```

Then open the builder in the web client, describe what you want and let
it plan. Read the plan, press **Go**, and watch the task list.

> **Note:** The kind is fixed at creation. A chat agent never becomes a
> builder and a builder never becomes a chat agent. A builder has no
> `SOUL.md` and no `USER.md`: they are not read, and the Agent window
> does not offer them.

In the dock a builder's tile is framed grey and shows `builder` under
the name. The Abilities window shows the builder's own tools as one
group and everything else under "more".

## Mode and phase

Every builder session carries two switches. They are set on the
session's first turn from where that turn came from. You can change
them any time in the task panel.

| Switch | Value | Default when | What it does |
|---|---|---|---|
| Mode | **attended** | a person opened the session | `ask_user` is offered. The builder asks at a real fork in the road. |
| Mode | **unattended** | an agent handed over an order | `ask_user` is hidden. The builder decides itself, notes each decision in its report and never waits. |
| Phase | **plan** | a person opened the session | The builder reads, searches, runs read-only commands and asks. The only file it writes is the plan. |
| Phase | **build** | an agent handed over an order | The builder edits, runs, tests and reports. A plan file, if there is one, counts as approved. |

In the plan phase these tools are hidden: `file_write`, `file_patch`,
`process`, `spawn_subagent` and `subagent_result`. The builder ends the
phase by saying "Plan ready" and stopping.

**Go** switches the phase to build and sends the builder a message: the
plan is approved, execute it, keep the task list, end with the report.
So a project can start directly with the builder, with no other agent
in between.

## The plan file

The builder writes its plan with `plan_write`. The file is `PLAN.md` in
the folder of the pinned project, or in the agent's workspace when no
project is pinned.

- **The plan follows the pin.** When you pin a project later, the plan
  path moves into its folder, and an already written plan moves with it.
  A path you set yourself is never moved.
- **An older plan is kept.** A `PLAN.md` that this session did not write
  is not overwritten. It moves aside as `PLAN-<date>-<session>.md`, and
  the builder is told to say what of the old plan still stands.

## The task panel

A builder's chat window in the web client has a panel docked on the
right. It collapses by itself in a narrow window, and you can fold it
away by hand.

| Part | What it shows |
|---|---|
| **Running for** | While a turn runs: elapsed time, the number of tool calls and the last tool. When the last call is more than a minute old its age is shown too, so a stuck turn is visible at a glance. |
| **Switches** | Mode and phase, the **Go** button while planning, and the plan file's path. |
| **Tasks** | The list the builder keeps with `todo_write`: one item in progress at a time, each ticked off the moment it is verified. |
| **Question** | What the builder asked with `ask_user`: the options as buttons, a free-text field and the minutes left. |

A question blocks the turn until you answer or the wait runs out. The
wait is 30 minutes unless the builder asks for another (10 seconds to 4
hours). An unanswered question comes back to the builder as
"unanswered", and it decides itself. A session has one open question at
a time: a newer one replaces it.

The mobile app has no task panel. You can chat with a builder there,
but Go and answers happen in the web client.

## Steering

A builder's turns are long. With steering on, a message you type while
it works goes into the running turn before its next step. With steering
off, the message waits until the turn is done.

The toggle next to Send switches between the two for the next message.
`steering: true` in `agent.yaml` makes steering the default for this
agent.

## Handing over an order

An agent that plans with you can hand the implementation to a builder
with one call, `builder_dispatch`. It does four things:

1. creates a fresh session on the builder,
2. pins the project, whose `workdir` becomes the working directory,
3. sets the session to unattended and build,
4. sends the order.

The caller returns at once. It is woken with the builder's report as an
`[agent answer]` and reads it with `agent_ask_result`.

| Parameter | Meaning |
|---|---|
| `task` | The complete order. Required. The builder sees nothing of the caller's conversation. |
| `builder` | Name of the builder. May be left out when exactly one exists. With several, the caller picks by the role and description each one carries. |
| `project` | Project to pin. Without one, name the repository in `task`. |
| `plan_path` | Absolute path of a plan the builder must read first. |
| `done_criteria` | What "done" means, for example "tests green and the new column is printed". |
| `report_path` | Absolute path the builder writes its report to, besides answering. |
| `mode` | `unattended` (default) or `attended`. |
| `phase` | `build` (default) or `plan`. |
| `session` | Name for the new session. Default: `build-<project or date>-<random>`. |
| `timeout_ms` | Passed on to the underlying `agent_ask`. |

With `phase: "plan"` the builder plans first and stops with "Plan
ready". The caller is woken with the plan. When you then press Go, the
build runs on that agent's behalf: it is woken again with the report
when the build ends.

Rules for the ordering agent:

- **Wait for the report.** No check-ins, no corrections into running
  work. A correction is a new message into that session.
- **The final answer is the report.** An order must not ask the builder
  to message the caller back.

Every colleague's team block says the same about a builder, so an
ordering agent on any model sees the rule. The bundled skill
`builder-handover` holds the full procedure. It is seeded into
`~/.somora/skills/` on start. Switch it on in the abilities of the
agent that hands over.

## One builder per folder

A builder's running turn claims its working directory. Two builders in
one working copy would overwrite each other's files.

- A hand-over into a claimed folder is refused with the name of who
  works there. So is Go.
- A message typed straight into a builder session whose folder another
  session holds fails with `folder busy: …`.
- The same builder in another session counts as someone else.
- Nested folders count as the same folder.
- Orders into different folders run side by side.
- The claim ends with the turn.

`GET /builders` lists the builders and where each is working.

## Working directory

A builder works where its session points: the `workdir` of the pinned
project, else the agent's workspace.

Without a pinned project folder, an attended builder is told to ask for
the repository, or to create and pin the project itself with
`project_create` (with `workdir`) and `project_focus`. An unattended
one is told to report that no project folder was given and to stop.

The pin holds while the builder works. Unpinning or switching the
project during a running builder turn is refused. A first pin is
allowed.

Helpers started with `spawn_subagent` inherit the pin, the folder and
the plan path. They run unattended, in the build phase and on the
builder's own model. The builder is told to wait for a helper with
`subagent_result` and `wait:true`, never to message a running one, and
never to let two helpers edit the same file.

## Where a builder may write

A builder session pinned to a project folder writes only in two places:
the project folder and its own temp folder,
`~/.somora/agents/<agent>/tmp/`. `file_write` and `file_patch` check
this on every engine, after the general path blacklist.

| Mode | A write outside the two folders |
|---|---|
| **unattended** | Refused. The message names the two allowed folders and tells the builder to use a path inside the project, or to explain in its report why the file is needed elsewhere. |
| **attended** | A question appears in the task panel: *Allow once*, *Allow this folder for the session*, or *Deny*. No answer within five minutes counts as deny. |

"Allow this folder for the session" is remembered on the session, so
the next write there passes. A path inside the project that leads
outside through a symlink is refused.

Chat agents, and a builder without a pinned folder, are bound by the
blacklist alone.

> **Warning:** The shell is not gated. `exec` can still write and delete
> anywhere. Deleting inside the project folder stays allowed on purpose:
> the folder is the builder's to rebuild.

## Errors after every write

With a language server installed (`somora lsp install`), every
`file_write` and `file_patch` result of a builder carries the errors
the server found in that file, and in other files this write broke. The
builder's environment block says which servers are there.

## What a builder sees

A builder's system prompt holds what a coding harness needs instead of
a personality. `GET /agents/:agent/prompt-preview` shows it byte for
byte. In order:

1. **Identity and environment.** One line who it is, then working
   directory, whether that is a git repository, platform, model, date
   and language servers.
2. **Harness rules.** How to work: everything through tools, read
   before patching, search before assuming, verify after every change
   with the repository's own build and test commands, the smallest
   correct change, git only when asked, no secrets, and what the final
   report contains.
3. **Team, compact.** The principal and the colleagues it can consult
   with `agent_ask`, one line each, plus the team rules.
4. **Rules for this builder.** The body of its `AGENTS.md`.
5. **Repository instructions.** `AGENTS.md`, `CLAUDE.md` or
   `CONTEXT.md` from the working directory. The first one found is
   used, cut at 20 000 characters.
6. **Skills**, **this session** with mode and phase, and **project**.

What keeps the prompt small:

- **No recall block.** A builder gets no `<memory-context>`, no wiki
  overview and no persona prose. It has `memory_search` and
  `memory_get` as tools instead.
- **Short tool descriptions.** A few lines per tool on what it takes
  and returns. The policy lives in the harness rules.
- **Hidden means gone.** A hidden tool sends no description, and the
  harness section that names it (task list, questions, helpers) is left
  out too.
- **Skills only when allowed.** A builder sees no skill unless its
  `agent.yaml` allows it. A chat agent sees all but the denied ones.

Dreaming (REM) is off unless `rem.enabled` is set in the builder's
`agent.yaml`.

## Long turns

The points below apply to the openai-compatible engine, which runs the
tool loop itself.

**Mid-turn compaction.** When the next request would not fit the
context window, the older rounds of the running turn are summarised
into a work-state block: objective, details, completed, active,
blocked, next move, relevant files. The last six rounds stay verbatim.
The task list travels with the block, so the builder keeps ticking it
off.

The session file keeps every record, and the chat shows an
`engine_meta` row `context_compacted`. When no compaction worker
answers, old tool results are shortened as for chat agents.

**A stale task list.** After twelve tool rounds without `todo_write`
while items are open, the builder gets one line asking for an update.
The list is what you watch.

**Checkpoints.** Every 100 tool rounds the builder is told to refresh
its task list and append a short status to its report file, so a crash
late in a long build loses minutes.

**Brakes.** A turn that hits a limit is asked for its report instead of
being cut off. `turn_end.forced_final` names the reason:

| Reason | What happened |
|---|---|
| `round_cap` | `maxRounds` reached. |
| `tool_budget` | `maxToolCallsPerTurn` reached. |
| `time_cap` | `maxTurnMs` reached. |
| `doom_loop` | The same tool calls with the same arguments five rounds in a row. The model gets a notice after three. |
| `scaffold_leak` | The answer contained tool scaffolding or repeated itself. |

A doom loop leaves two rows in the session, "loop noticed" and "loop
stopped", naming the repeated calls. A reviewer sees why a turn was cut
short.

**Cut off while thinking.** A round that produced reasoning but neither
text nor a tool call hit the model's output cap (`maxTokens`, which
includes reasoning). The engine tells the model to continue with shorter
thinking, at most twice per turn. This and the doom-loop brake apply to
every agent on this engine, not only builders.

## Settings

All of them are per agent, in `agent.yaml`:

```yaml
kind: builder
steering: true
agentLoop:
  maxRounds: 500
  maxToolCallsPerTurn: 2000
  maxTurnMs: 28800000
tools:
  allow: [browser]
  deny: [web_fetch]
skills:
  allow: [<skill-name>]
```

| Setting | Default for a builder | Meaning |
|---|---|---|
| `kind` | `chat` | `builder` makes the agent a builder. Fixed for life. |
| `model` | the server default | Any configured model alias. |
| `workspace.path` | the server's `workspace.default` | Working directory when no project is pinned. |
| `steering` | `false` | `true` sends a message typed during a turn into that turn by default. |
| `agentLoop.maxRounds` | `500` | Model rounds per turn. |
| `agentLoop.maxToolCallsPerTurn` | `2000` | Tool calls per turn. |
| `agentLoop.maxTurnMs` | `28800000` (8 h) | Wall-clock limit per turn. |
| `tools.allow` | none | Adds tools to the builder list. |
| `tools.deny` | none | Removes tools from it. |
| `skills.allow` | none | The skills the builder sees. Empty means no skill. |
| `rem.enabled` | off | Turns dreaming on for this builder. |

The `agentLoop` values count on the openai-compatible engine. The
Abilities window edits `tools` and `skills` for you: switching off one
of the builder's own tools writes `tools.deny`, switching on one under
"more" writes `tools.allow`.

## Tools

What a builder is offered by default. Everything else is off until
`tools.allow` names it.

| Group | Tools |
|---|---|
| Files | `file_read`, `file_write`, `file_patch`, `file_search`, `file_list`, `analyze_file` |
| Shell | `exec`, `process` |
| Builder | `todo_write`, `ask_user`, `plan_write` |
| Helpers | `spawn_subagent`, `subagent_result`, `subagent_cancel` |
| Colleagues | `agent_ask`, `agent_ask_result` |
| Skills | `skill`, `skill_list` |
| Web | `web_fetch`, `web_search` |
| Projects | `project_get`, `project_list`, `project_create`, `project_focus` |
| Memory, read only | `memory_search`, `memory_get` |
| Time | `time_now` |

`analyze_file` is offered only when a vision worker is configured and
the builder's own model cannot see images.

The three builder tools:

| Tool | Parameters | What it does |
|---|---|---|
| `todo_write` | `todos: [{content, status, priority?}]` | Replaces the whole task list. Status is `pending`, `in_progress`, `completed` or `cancelled`. |
| `ask_user` | `question`, `options` (2 to 6, each `{label, description?}`), `header?`, `multiple?`, `timeout_ms?` | Asks in the task panel and waits. Returns `{answered, answers[], text?}`. |
| `plan_write` | `content` | Writes the whole plan file. |

A chat agent never gets these three, whatever its `agent.yaml` says.

## Routes

`…` stands for `/agents/:agent/sessions/:session`, so the first route
is `GET /agents/:agent/sessions/:session/builder`.

| Route | Body | Returns |
|---|---|---|
| `GET …/builder` | | `{agent, session, kind, state, question, turn}` |
| `PATCH …/builder` | `{mode?, phase?, planPath?, orderer?}` | `{state}`. Publishes `builder_state`. |
| `POST …/builder/go` | `{note?}` | 202 with `{state, turnId, callId?, wakes?}`. 409 `folder busy` when another builder turn holds the folder. |
| `PUT …/todos` | `{todos: [{content, status, priority?}]}` | `{todos}`. Publishes `todo_updated`. Used by `todo_write`. |
| `PUT …/plan` | `{content}` | `{path, bytes, archived?}`. Used by `plan_write`. |
| `POST …/ask` | `{question, header?, options[], multiple?, timeout_ms?}` | Blocks, then `{answered, answers[], text?}`. Publishes `question_asked`. Used by `ask_user`. |
| `POST …/answer` | `{questionId, answers?, text?}` | `{ok}`. Publishes `question_answered`. |
| `GET /builders` | | `{builders: [{name, role, description, busy[]}]}` |
| `GET /builders/busy?workdir=…` | | `{workdir, busy}`, where `busy` is the claim or `null`. Without `workdir`: all claims. |

Fields of `GET …/builder`:

| Field | Content |
|---|---|
| `state` | `{mode, phase, planPath, todos, orderer?}`, or `null` before the first turn. |
| `question` | `{questionId, question, header, options, multiple, askedAt, expiresAt}`, or `null`. |
| `turn` | `{turnId, startedAt, toolCalls, lastTool?, lastToolAt?}` while a turn runs, else `null`. |

Details:

- `planPath` must be an absolute path or `null`.
- `orderer` is `{agent, session?}`: the agent that handed the order
  over. With an orderer, Go runs the build as that agent's detached ask
  (`callId`) and wakes it with the report.
- `note` is appended to the Go message.
- The task list holds at most 100 items of 500 characters each.

The web panel reads `GET …/builder` on every turn event and every two
seconds. The SSE events `builder_state`, `todo_updated`,
`question_asked` and `question_answered` exist for other clients.

## Troubleshooting

| What you see | Reason and fix |
|---|---|
| `folder busy: …` | Another builder turn works in this folder or a nested one. Wait for its report or use another project folder. |
| `write refused: … is outside the project folder` | The write scope. Use a path inside the project, or switch the session to attended and allow the folder. |
| The builder never asks | The session is unattended, so `ask_user` is hidden. Switch the mode in the task panel. |
| The builder cannot edit files | The session is in the plan phase. Press Go. |
| The project cannot be unpinned or switched | A builder turn is running. Stop the turn first. |
| "No builder state yet" in the panel | Mode and phase appear with the first message. |
| `builder_dispatch: several builders exist` | Name one in `builder`. The error lists them. |
| A turn ended early | Look at `turn_end.forced_final` and the "loop noticed" and "loop stopped" rows. In the log: `engine.doom_loop_stop`, `engine.reasoning_only_round`. |

## See also

- [Tools](tools.md): every tool and how to allow or deny them per agent
- [Files](files.md): the file tools and the path blacklist
- [Language servers](lsp.md): the errors a builder gets after a write
- [Projects](projects.md): project folders and pinning
- [Skills](skills.md): bundled skills such as `builder-handover`
- [Compaction](compaction.md): how context is kept inside the window
- [Security](security.md): what the write scope does and does not cover
- [Team](team.md): how colleagues learn about a builder
- [API](api.md): the *Steering* section and the builder routes
