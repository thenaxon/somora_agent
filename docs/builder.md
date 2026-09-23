# Builder agents

A **builder** is an agent of a second kind. It is a coding harness inside
somora: the same server, the same sessions, tools and team as every
other agent, but in front of the conversation stands what a coding
harness puts there — rules for working in a repository, an environment
block, the repository's own instructions — instead of a persona's
personality, a wiki map and a memory-recall block. It gets a short
coding tool set, turns that may run for hours, a task list and a way to
ask the person watching. You talk to it in the chat like to any other
agent; another agent can hand it a brief the same way.

The kind is fixed at creation. A chat agent never becomes a builder and
a builder never becomes a chat agent: the files differ (a builder has no
`SOUL.md` and no `USER.md`), the prompt differs, the defaults differ.

## Creating one

```
~/.somora/agents/<name>/
  AGENTS.md    frontmatter: name, description, role, icon, color — body: extra rules, optional
  agent.yaml   kind: builder, model, workspace, …
```

```yaml
# ~/.somora/agents/rudi/agent.yaml
kind: builder
model: deepseek            # any configured alias; local models work well here
workspace:
  path: ~/somoraworkspace  # the default working directory (a pinned project overrides it)
steering: true             # a message typed while it works goes INTO the turn
# agentLoop:               # optional — the builder defaults are 500 rounds,
#   maxRounds: 500         # 2000 tool calls and 8 hours per turn
#   maxToolCallsPerTurn: 2000
#   maxTurnMs: 28800000
# tools:                   # optional — add to or remove from the builder set
#   allow: [browser]
#   deny: [web_fetch]
```

```markdown
---
name: rudi
description: Builds and changes software in the repository it is pointed at.
role: builder
icon: 🔨
---
Repository-independent rules for this builder go here (short). The
harness rules come from somora; a repository's own AGENTS.md or
CLAUDE.md is read from the working directory.
```

The dock shows the kind under the name and frames the tile grey. The
Abilities window has two views by kind: a builder's own set as one group
(switch off = `tools.deny`) and everything else under "more" (switch on
= `tools.allow`); a chat agent's full programme minus the three
builder-only tools. Skills the same way: a builder's switches edit the
allow-list, a chat agent's the denies.

## What a builder sees

The system prompt, in order (`GET /agents/:agent/prompt-preview` shows
it byte for byte):

1. **Identity + environment** — one line who it is; working directory,
   whether that is a git repository, platform, model, date.
2. **Harness rules** — how to work: everything through tools ("code in
   your text is not saved"), read before patch, search before assuming,
   verify after every change with the repository's own build/test
   commands, smallest correct change, keep going until done, no
   repeated identical calls, shell for terminal work only, git only when
   asked, no secrets. The task list, decisions and questions, helpers
   and colleagues, and what the final report contains.
3. **Team (compact)** — the principal and the colleagues it can consult
   with `agent_ask`, one line each, plus the team rules. No org chart.
4. **Tool reminder**, **repository instructions** (`AGENTS.md`,
   `CLAUDE.md` or `CONTEXT.md` from the working directory, first found,
   capped at 20 000 chars), **skills**, **this session** with the
   session's **mode and phase** (below), **project**.

Not in it: SOUL/USER prose, the wiki overview, and the per-turn memory
recall block — a builder gets no `<memory-context>`; it has
`memory_search` and `memory_get` as tools instead. Dreaming (REM) is off
unless `rem.enabled` is set in its `agent.yaml`.

Tools by default (`src/tools/gating.ts` `BUILDER_TOOL_ALLOW`):
`file_read`, `file_write`, `file_patch`, `file_search`, `file_list`,
`exec`, `process`, `todo_write`, `ask_user`, `plan_write`,
`spawn_subagent`, `subagent_result`, `agent_ask`, `agent_ask_result`,
`skill`, `skill_list`, `web_fetch`, `web_search`, `project_get`, `project_list`,
`project_create`, `project_focus`, `memory_search`, `memory_get`,
`time_now`. Everything else is off until `tools.allow` names it.

## Mode and phase

Every builder session carries two switches, set on its first turn from
where that turn came from and changed any time in the task panel
(`PATCH …/builder`):

| | default when | what it does |
|---|---|---|
| **attended** | a person opened the session | `ask_user` is offered; the prompt says "for a real fork in the road, ask". |
| **unattended** | an agent handed over a brief | `ask_user` is hidden; the prompt says "decide yourself, note it in the report, never wait". |
| **plan** | a person opened the session | read, search, run read-only commands, ask; the only file written is the plan (`plan_write`). `file_write`, `file_patch`, `process`, `spawn_subagent` are hidden. Ends with **Go**. |
| **build** | an agent handed over a brief | edit, run, test, report. The plan file, if there is one, is approved. |

**Go** (the button in the panel, `POST …/builder/go`) switches the phase
to build and sends the builder a message: the plan is approved, execute
it, keep the task list, end with the report. So a project can start
directly with the builder — describe it, let it plan, press Go — with
no orchestrator in between. When the order came from another agent
(`builder_dispatch` with `phase: "plan"`), Go runs the build as that
agent's detached ask: it is woken with the report when the build ends,
the same way it was woken with the plan.

## The task panel

A builder's chat window has a panel docked on the right:

- **Running for** — while a turn runs: elapsed time, the number of
  tool calls so far and the last tool, ticking every second; when the
  last call is more than a minute old the age is shown too, so a stuck
  turn is visible at a glance.
- **Mode** and **phase** switches, **Go** while planning, the plan
  file's path.
- **Tasks** — the list the builder keeps with `todo_write`: one item
  `in_progress` at a time, `completed` the moment it is verified.
- **Question** — when the builder called `ask_user`: the question, its
  options as buttons (multiple choice when it said so), a free-text
  field, and how long it will wait. The turn blocks until you answer or
  the wait runs out (default 30 min); an unanswered question comes back
  to the builder as "unanswered — decide yourself".

The panel reads `GET …/builder` and refreshes on every turn event and
every two seconds; the SSE events `builder_state`, `todo_updated`,
`question_asked` and `question_answered` exist for other clients.

## Steering

A builder's turns are long. A message typed while it works goes into
the running turn before its next step when steering is on (the bolt
next to Send; `steering: true` in agent.yaml makes that the default)
— see the *Steering* section of [api.md](api.md).

## Handing over a brief

The bundled skill `builder-handover` (seeded into `~/.somora/skills/`
on start, see [skills.md](skills.md)) is the procedure for the agent
that plans with the person and hands the implementation over: switch it
on for that agent in its abilities. In short:

From another agent (an orchestrator) the hand-over is one call:
`builder_dispatch` creates a fresh session on the builder, pins the
project (its `workdir` becomes the working directory), sets the session
to unattended + build (or `phase: "plan"`: plan first, stop with "Plan
ready", the person presses Go) and sends the order; the caller returns at once
and is woken with the builder's report (an `[agent answer]` wake, read
with `agent_ask_result`). The builder's final answer is that report: an
order must not ask it to message the caller back. Without a project, name
the repository in the order. `builder` may be left out when exactly one
builder exists; with several, the caller names one, chosen by the team
description each builder carries (its role and what it is for).

**One builder per folder.** A builder's running turn claims its working
directory. A hand-over into a project whose folder is claimed — by any
builder, the same one in another session included — is refused with the
name of who works there; so is Go. Nested folders count as the same
folder. Orders into different folders run side by side; the claim ends
with the turn. `GET /builders` lists the builders and where each is
working, `GET /builders/busy?workdir=…` answers for one folder. The order itself, in `task` (plus `plan_path`, `done_criteria`,
`report_path`):

> Read the plan at `<path>`. Implement it. Done means: `<criterion,
> e.g. tests green and feature X usable>`. Write the report to `<path>`
> at the end. Decide open questions yourself and list them in the
> report.

Then wait for the report — no interim check-ins, no corrections into
running work; a correction is a new message into that session, which
steers into the running turn or starts the next one. The session opened
this way starts **unattended** and in **build**. Every colleague's team
block says the same about a builder, so an orchestrator on any model
sees the rule.

## Working directory

A builder works where its session points: the folder of the pinned
project (`workdir`, see [projects.md](projects.md)), else the agent's
workspace. Without a pinned project folder the prompt tells an attended
builder to ask for the repository or create and pin the project itself
(`project_create` with `workdir`, `project_focus`), and an unattended
one to report that no project folder was given. Helpers it spawns
inherit the pin and the folder.

## Limits and loop

A builder's turn on the openai-compatible engine runs with `maxRounds`
500, `maxToolCallsPerTurn` 2000 and `maxTurnMs` 8 h (agent.yaml
`agentLoop:` overrides). Two brakes end a turn early with a request for
the report: the wall-clock cap, and a **doom loop** — the same tool
calls with the same arguments five rounds in a row (a notice goes to
the model after three). The forced final answer names the reason
(`turn_end.forced_final`: `round_cap`, `tool_budget`, `time_cap`,
`doom_loop`, `scaffold_leak`).

## Routes

- `GET /agents/:agent/sessions/:session/builder` → `{agent, session,
  kind, state: {mode, phase, planPath, todos, orderer?} | null, question | null,
  turn: {turnId, startedAt, toolCalls, lastTool?, lastToolAt?} | null}`
- `PATCH …/builder` `{mode?, phase?, planPath?, orderer?}` → `{state}`;
  publishes `builder_state`
- `POST …/builder/go` `{note?}` → `{state, turnId, callId?, wakes?}`
  (202): phase build + the Go message as a new turn; with an `orderer`
  the turn is its detached ask (`callId`) and it is woken with the report
- `PUT …/todos` `{todos: [{content, status, priority?}]}` → `{todos}`;
  publishes `todo_updated` (what `todo_write` calls)
- `PUT …/plan` `{content}` → `{path, bytes}` (what `plan_write` calls)
- `POST …/ask` `{question, header?, options[], multiple?, timeout_ms?}`
  → blocks until `{answered, answers[], text?}` (what `ask_user` calls);
  publishes `question_asked`
- `POST …/answer` `{questionId, answers?, text?}` → `{ok}`; publishes
  `question_answered`

## What keeps the builder's prompt small

Everything below hangs on `kind: builder`; chat agents are untouched:

- **Tool descriptions.** A builder's model sees a short description per
  tool (`src/tools/builder/short-descriptions.ts`), a few lines of what
  the tool takes and returns; the policy ("use file_read instead of
  cat", when to ask) lives in the harness rules instead. A hidden tool
  sends no description at all, and the harness section that names it
  (task list, questions, helpers) is left out too. When a tool's
  parameters change, the short text must follow — one file, one place.
- **Skills.** A builder sees no skill unless its `agent.yaml` allows it
  (the Abilities window adds them one by one); a chat agent sees all but
  the denied ones.
- **Team.** The compact team block names the principal and the
  colleagues with their titles; the org chart and the involve-for lists
  are for orchestrators.
- **No tool reminder, no wiki map, no memory recall block.**
- **Own rules.** The body of the builder's `AGENTS.md` (below the
  frontmatter) is its "Rules for this builder" section, after the
  harness rules. SOUL.md and USER.md are not read — the Agent window
  does not offer them for a builder.

## Long turns

Two things happen inside a builder turn on the openai-compatible engine
that a chat turn never needs:

- **Mid-turn compaction.** When the next request would not fit the
  context window, the older rounds of the running turn (from its user
  message up to the last six rounds) are summarised by a compaction
  worker into a work-state block — objective, details, completed /
  active / blocked, next move, relevant files — and replaced by one
  message carrying it; the last six rounds stay verbatim and the turn
  continues; the task list as last written with `todo_write` travels
  with that block verbatim, so the builder keeps ticking it off after
  the compaction. The session file keeps every record. The chat shows
  an `engine_meta` row `context_compacted`. When no worker answers, the
  old tool-result shortening applies as for chat agents.
- **Checkpoints.** Every 100 tool rounds the builder is told to refresh
  its task list and append a short status to its report file, so a
  crash late in a long night loses minutes.
