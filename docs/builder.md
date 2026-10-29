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
| **Acceptance** | The [acceptance list](#the-acceptance-list): per requirement its status, evidence and review, with a button to accept and one to reject (with a note). Shown when the list has items or the order requires one. |

A question blocks the turn until you answer or the wait runs out. The
wait is 30 minutes unless the builder asks for another (10 seconds to 4
hours). An unanswered question comes back to the builder as
"unanswered", and it decides itself. A session has one open question at
a time: a newer one replaces it.

The mobile app has no task panel. You can chat with a builder there,
but Go and answers happen in the web client.

## The acceptance list

The task list says what the builder does. The acceptance list says what
the order asked for and what shows it is met: one item per requirement,
in the words of the order. A finished turn, a reply that arrived and a
green test suite are not an accepted build.

| Field | Content |
|---|---|
| `id` | `A01`, `A02`, …, stable for the life of the item. |
| `requirement` | The requirement as the order states it. |
| `status` | `open`, `passed`, `failed` or `not_run`. Set by the builder. |
| `evidence` | What shows the status: the command and its result, the file, the test, the revision. Expected for `passed` and `failed`. |
| `review` | `accepted` or `rejected`, by whom, with a note. Set by you or by the agent that gave the order. |

**Rules.**

- **Required for agent orders.** An order sent with `builder_dispatch`
  requires the list. The builder writes it before building, or in the
  plan phase, and keeps it current. A builder may also keep one in a
  session you opened yourself.
- **The builder cannot narrow the list.** An item it leaves out stays,
  and a requirement keeps its first wording. A changed milestone is a
  new item, not a rewritten one.
- **The builder cannot accept.** `accepted` and `rejected` are reviews,
  set by you in the panel or by the orderer through the API. A new
  status or new evidence clears an earlier review, because that review
  was of the old evidence.
- **The end is checked.** A builder that wants to end its turn with an
  item still `open`, or with no list although the order requires one,
  is told so. This is the same notice as for open tasks: at most twice
  per turn, and the `open tasks` row counts both.
- **The report ends with the list.** The final answer gets the list as
  the session holds it, as a table under "Acceptance list (from the
  session)". The orderer reads it there.
- **It survives compaction.** The work-state block of a mid-turn
  compaction carries the list word for word. After a compaction before
  a turn, the builder reads it with `acceptance_write` and no items.

At most 60 items. A requirement is cut at 500 characters, evidence and
review notes at 1000.

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
| `project` | Project to pin; its `workdir` becomes the working directory. Without it the builder does not build: unattended, it reports that the order needs a pinned project and stops; attended, it asks which project the work belongs to. |
| `plan_path` | Absolute path of a plan the builder must read first. |
| `done_criteria` | What "done" means, for example "tests green and the new column is printed". |
| `report_path` | Absolute path the builder writes its report to, besides answering. |
| `mode` | `unattended` (default) or `attended`. |
| `phase` | `build` (default) or `plan`. |
| `session` | Name for the new session. Default: `build-<project or date>-<random>`. |
| `write_allow` | Absolute folders the builder may write in besides the project, such as a git worktree beside it. Needs `project`. Checked before the session is created: see [Where a builder may write](#where-a-builder-may-write). |
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

A builder builds only in a pinned project. A folder named in the order
is not enough. Without a pin, an attended builder is told to ask which
project the work belongs to, or to create and pin it itself with
`project_create` (with `workdir`) and `project_focus`. An unattended
one writes nothing, reports that the order needs a pinned project and
stops.

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
| **unattended** | Refused. The message names the allowed folders and says this is a limit of the order: the builder must not write the file through `exec` instead, but name the folder it needs in its report. |
| **attended** | A question appears in the task panel: *Allow once*, *Allow this folder for the session*, or *Deny*. No answer within five minutes counts as deny. |

"Allow this folder for the session" is remembered on the session, so
the next write there passes. A path inside the project that leads
outside through a symlink is refused.

### A second folder for the order

Work in a worktree or a second checkout beside the project needs that
folder allowed. The orderer passes it in `builder_dispatch`:

```json
{ "project": "<project>", "write_allow": ["/home/<you>/Projects/<project>-next"],
  "task": "…" }
```

The folders are checked before the session is created. Each must
exist (create the worktree first) and be narrow. The root, the home
folder, a folder that holds the project (it would open every
neighbour) and anything inside somora's home are refused. At most
four. The order and the session block name the folders to the
builder. A person can add one with `PATCH …/builder` `writeAllow`.

A worktree inside the project folder, kept out of git (for example
`.worktrees/<name>`, listed in `.git/info/exclude`), needs no
`write_allow` at all.

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
   correct change, git only when asked, no secrets. A fix covers the
   cause and the sibling code paths. Every response either makes
   progress with a tool call or is the final report.
3. **Done and messages.** Done means every requirement checked, test
   output read, the diff looked at, nothing still running, nothing
   invented. A `[somora]` message is a notice from the harness, or a
   message someone sent during the turn. Then what the final report
   contains.
4. **Team, compact.** The principal and the colleagues it can consult
   with `agent_ask`, one line each, plus the team rules.
5. **Rules for this builder.** The body of its `AGENTS.md`.
6. **Repository instructions.** `AGENTS.md`, `CLAUDE.md` or
   `CONTEXT.md` from the working directory. The first one found is
   used, cut at 20 000 characters.
7. **Skills**, **this session** with mode and phase, and **project**.

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

A builder does not dream unless `dreams: true` is set in its
`agent.yaml` or in the Agent window. With it, it gets REM, Deep and the
dream and wiki tools like a chat agent.

## Long turns

The points below apply to the openai-compatible engine, which runs the
tool loop itself.

**Room at the start of a turn.** A builder turn starts with at most 60 %
of the input budget used (`compaction.builderTargetRatio`). Above it,
the history is compacted before the turn, keeping only the newest
exchanges that fit, often none. Then the result is checked. The
`context compacted` row says whether the target was reached and how
many tokens are free. See [Compaction](compaction.md#builder-turns).

**Mid-turn compaction.** When the next request would not fit the
context window, the older rounds of the running turn are summarised
into a work-state block: objective, the person's directions quoted
word for word, details, completed (each verified or not), active,
blocked, checks still owed with the last failure, repository state,
what is still running, next move, relevant files. The last six rounds stay verbatim.
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

**No round cap.** A builder has no `maxRounds` unless its `agent.yaml`
sets one. A round count says nothing about progress, and the earlier
cap of 500 ended night builds mid-work. The brakes are the tool-call
budget (2000), the time cap (8 hours) and the loop guard below. A number
in `agentLoop.maxRounds`, or `maxRounds` in one `spawn_subagent` call,
brings a cap back. Chat agents keep the server's `agentLoop` values.

**Budget notices.** At 75 % of `maxToolCallsPerTurn`, or of
`maxRounds` when one is set, the builder gets a checkpoint: save
progress, most important open items first, keep working. It is not told
to stop there; a chat agent is.

At the limit the tools are switched off and the builder writes its
report: that the limit was reached, what is done and how it was
verified, what is not done or not verified, what comes next. The log
line for the checkpoint is `engine.budget_soft_warn` with `phase`
`builder_checkpoint`. The chat shows it as a `budget checkpoint` row.

**Open tasks at the end.** A builder that wants to end its turn while
its task list still has open items is told to go on: mark what is
really done, continue with the rest, or name the blocker and write the
report. This happens at most twice per turn, and only when:

- the turn wrote the task list itself (a turn that answers a question
  about the state is left alone),
- the session is in the build phase (the plan phase ends with open
  steps by design),
- the builder did not end right after such a notice (that answer
  stands).

The chat shows an `open tasks` row.

**A cut-off answer.** When the builder's answer runs into the output
limit (`maxTokens`), it is told to continue exactly where it stopped,
at most twice per turn. The parts are joined into one answer. The
chat shows an `answer cut off` row. The test is the token count of
that response, because routers rewrite the stop reason.

**Brakes.** A turn that hits a limit is asked for its report instead of
being cut off. `turn_end.forced_final` names the reason:

| Reason | What happened |
|---|---|
| `round_cap` | `maxRounds` reached. Only when one is set. |
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
every agent on this engine. Everything else in this section applies to
builders only.

## Settings

All of them are per agent, in `agent.yaml`:

```yaml
kind: builder
steering: true
agentLoop:
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
| `agentLoop.maxRounds` | none | Model rounds per turn. Unset means no round cap. |
| `agentLoop.maxToolCallsPerTurn` | `2000` | Tool calls per turn. |
| `agentLoop.maxTurnMs` | `28800000` (8 h) | Wall-clock limit per turn. |
| `tools.allow` | none | Adds tools to the builder list. |
| `tools.deny` | none | Removes tools from it. |
| `skills.allow` | none | The skills the builder sees. Empty means no skill. |
| `dreams` | `false` | `true` lets this builder dream (REM, Deep, the dream and wiki tools). |

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
| Builder | `todo_write`, `plan_write`, `acceptance_write` |
| Helpers | `spawn_subagent`, `subagent_result`, `subagent_cancel` |
| Colleagues and you | `agent_ask`, `agent_ask_result`, `ask_user` (offered while the session is attended; [every agent](tools.md#questions-to-you) has it) |
| Skills | `skill`, `skill_list` |
| Web | `web_fetch`, `web_search` |
| Projects | `project_get`, `project_list`, `project_create`, `project_focus` |
| Memory, read only | `memory_search`, `memory_get` |
| Time | `time_now` |

`analyze_file` is offered only when a vision worker is configured and
the builder's own model cannot see images.

The builder's tools:

| Tool | Parameters | What it does |
|---|---|---|
| `todo_write` | `todos: [{content, status, priority?}]` | Replaces the whole task list. Status is `pending`, `in_progress`, `completed` or `cancelled`. |
| `ask_user` | `question`, `options` (2 to 6, each `{label, description?}`), `header?`, `multiple?`, `timeout_ms?` | Asks in the task panel and waits. Returns `{answered, answers[], text?}`. |
| `plan_write` | `content` | Writes the whole plan file. |
| `acceptance_write` | `items?: [{id, requirement?, status, evidence?}]` | Replaces the acceptance list under its [rules](#the-acceptance-list). Returns the counts, the list and `warnings` for what was not taken. Without `items` it returns the list. |

A chat agent never gets `todo_write`, `plan_write` and `acceptance_write`, whatever its
`agent.yaml` says. `ask_user` belongs to every agent ([Questions to
you](tools.md#questions-to-you)); for a builder it waits in the task
panel.

## Routes

`…` stands for `/agents/:agent/sessions/:session`, so the first route
is `GET /agents/:agent/sessions/:session/builder`.

| Route | Body | Returns |
|---|---|---|
| `GET …/builder` | | `{agent, session, kind, state, acceptance, question, turn}` |
| `PATCH …/builder` | `{mode?, phase?, planPath?, orderer?, acceptanceRequired?, writeAllow?}` | `{state}`. Publishes `builder_state`. |
| `POST …/builder/go` | `{note?}` | 202 with `{state, turnId, callId?, wakes?}`. 409 `folder busy` when another builder turn holds the folder. |
| `PUT …/todos` | `{todos: [{content, status, priority?}]}` | `{todos}`. Publishes `todo_updated`. Used by `todo_write`. |
| `PUT …/plan` | `{content}` | `{path, bytes, archived?}`. Used by `plan_write`. |
| `GET …/acceptance` | | `{items, required}` |
| `PUT …/acceptance` | `{items: [{id, requirement?, status, evidence?}], by_agent?}` | `{items, required, warnings}`. Publishes `acceptance_updated`. Used by `acceptance_write`. 403 when `by_agent` is another agent. |
| `POST …/acceptance/review` | `{id, verdict: "accepted" \| "rejected", note?, by_agent?}` | `{items, required}`. Publishes `acceptance_updated`. Without `by_agent` the review is yours. With it, it must be the orderer. The builder itself gets 403. 404 for an unknown `id`. |
| `POST …/ask` | `{question, header?, options[], multiple?, timeout_ms?}` | A builder's question, or one in a task sent over A2A, blocks, then returns `{answered, answers[], text?}`. A chat agent's question in a turn a person started returns at once with `{asked: true, questionId, note}`. Publishes `question_asked`. Used by `ask_user`. |
| `POST …/answer` | `{questionId, answers?, text?}` | `{ok}`. Publishes `question_answered`. |
| `GET /builders` | | `{builders: [{name, role, description, busy[]}]}` |
| `GET /builders/busy?workdir=…` | | `{workdir, busy}`, where `busy` is the claim or `null`. Without `workdir`: all claims. |

Fields of `GET …/builder`:

| Field | Content |
|---|---|
| `state` | `{mode, phase, planPath, todos, orderer?}`, or `null` before the first turn. |
| `acceptance` | `{items, required}`: the acceptance list and whether the order requires it. |
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
`acceptance_updated`, `question_asked` and `question_answered` exist
for other clients.

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
