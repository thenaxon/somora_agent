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

The dock shows the kind under the name; the Abilities window shows the
builder's tool set (the kind's defaults plus whatever `tools:` adds or
removes).

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
`skill`, `skill_list`, `web_fetch`, `project_get`, `project_list`,
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
no orchestrator in between.

## The task panel

A builder's chat window has a panel docked on the right:

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

From another agent (an orchestrator) the hand-over is one message into
a builder session — with `agent_ask` and `create_session: true` when the
session does not exist yet:

> Read the plan at `<path>`. Implement it. Done means: `<criterion,
> e.g. tests green and feature X usable>`. Write the report to `<path>`
> at the end. Decide open questions yourself and list them in the
> report.

Then wait for the answer (the report) — no interim check-ins, no
corrections into running work; a correction is a new message, which
steers into the running turn or starts the next one. The session opened
this way starts **unattended** and in **build**.

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
  kind, state: {mode, phase, planPath, todos} | null, question | null}`
- `PATCH …/builder` `{mode?, phase?, planPath?}` → `{state}`; publishes
  `builder_state`
- `POST …/builder/go` `{note?}` → `{state, turnId}` (202): phase build +
  the Go message as a new turn
- `PUT …/todos` `{todos: [{content, status, priority?}]}` → `{todos}`;
  publishes `todo_updated` (what `todo_write` calls)
- `PUT …/plan` `{content}` → `{path, bytes}` (what `plan_write` calls)
- `POST …/ask` `{question, header?, options[], multiple?, timeout_ms?}`
  → blocks until `{answered, answers[], text?}` (what `ask_user` calls);
  publishes `question_asked`
- `POST …/answer` `{questionId, answers?, text?}` → `{ok}`; publishes
  `question_answered`
