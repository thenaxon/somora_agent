# Tools

Tools are what an agent can do besides writing text: search its memory,
read a file, run a command, ask another agent. somora keeps all of them
in one catalog, and every agent gets the same tools whichever model or
engine it runs on.

## What you get

- **One catalog for every engine.** A tool works the same on
  `claude-cli`, `grok-cli`, `codex-cli` and `openai-compatible` models.
- **Only tools that can run.** A tool whose configuration is missing is
  not shown to the model at all, so it cannot pick it by mistake.
- **A switch per agent.** Hide single tools, whole families or an
  external server from one agent, in the web client or in `agent.yaml`.
- **Results that fit.** An oversized result is shortened and the full
  text is kept in a file the agent can page through.
- **Broken calls repaired.** A call with unusable arguments is answered
  with advice the model can act on. It never breaks the turn.

## Try it

List every tool the server has registered:

```bash
curl http://127.0.0.1:18737/tools | jq '.count, .tools[].name'
```

Run one without a model in the loop. Replace `<name>` with an agent:

```bash
curl -X POST http://127.0.0.1:18737/agents/<name>/tools/time_now \
  -H 'content-type: application/json' -d '{}'
```

To see and change what one agent is offered, open the **Abilities**
window in the web client. Each tool has a switch there.

## The tool families

Every tool carries a toolset tag. The tag groups tools for the
per-agent switch (`toolset:<tag>`). There are 64 built-in tools, plus
whatever your external MCP servers bring.

| Toolset | Tools | Offered when |
|---|---|---|
| `memory` | 10 | always |
| `dream` | 6 | always |
| `wiki` | 4 | only to the agent that holds an open `dream_review` loop |
| `time` | 1 | always |
| `web` | 2 | `web_fetch` always, `web_search` with `web.brave.apiKey` |
| `file` | 6 | always, except `analyze_file` (see below) |
| `exec` | 3 | always |
| `agents` | 12 | always |
| `skills` | 2 | always |
| `sentinel` | 1 | always |
| `projects` | 6 | `projects.enabled: true` |
| `image` | 2 | `imageGen.enabled: true` and at least one entry in `imageGen.models` |
| `video` | 3 | `videoGen.enabled: true` and at least one entry in `videoGen.models` |
| `media` | 1 | image or video generation is set up |
| `browser` | 1 | `browser.enabled: true` |
| `decision` | 1 | `decisions.model` names an entry in `decisions.models` |
| `builder` | 3 | builder agents, or a chat agent whose `tools.allow` names the tool |
| `mcp` | varies | servers listed under `mcp.servers` |

### Memory, docs and resources

Toolset `memory`. The docs and resource tools carry the same tag, so
`toolset:memory` covers all ten.

| Tool | What it does |
|---|---|
| `memory_search` | Searches the agent's notes, the shared wiki and the vault in one go. |
| `memory_get` | Returns the full note or page behind a search hit. |
| `memory_list` | Lists notes, or browses a wiki folder. |
| `memory_write` | Creates or replaces a note in the agent's inbox. |
| `memory_edit` | Changes an existing note. |
| `memory_delete` | Removes a note. |
| `somora_docs_list` | Lists the pages of this documentation. |
| `somora_docs_read` | Reads one page of this documentation. |
| `resource_list` | Lists the remote SSH targets the agent may use. |
| `resource_test` | Checks that one SSH target is reachable. |

### Dreaming and the wiki

Toolsets `dream` and `wiki`.

| Tool | What it does |
|---|---|
| `dream_list` | Lists findings from REM and Lucid that wait for review. |
| `dream_get` | Shows one finding in full. |
| `dream_apply` | Approves a finding, for example turns it into a note. |
| `dream_dismiss` | Rejects a finding. |
| `dream_run` | Starts a phase by hand: `phase` is `deep` (default), `lucid` or `rem`. |
| `dream_review` | Opens or closes a wiki review loop for a Lucid run: `action` is `start` or `end`. |
| `wiki_edit` | Changes the body, `related:` or `sources:` of a wiki page. |
| `wiki_create` | Creates a wiki page in a folder of the wiki. |
| `wiki_delete` | Deletes a wiki page. |
| `wiki_move` | Moves or renames a page and rewrites every `[[link]]` to it. |

The four `wiki_*` tools exist only inside a review loop. While an agent
holds the loop it gets them, and loses the `exec`, `agents` and `skills`
toolsets plus `file_write` and `file_patch` until the loop ends. It may
make 3 `wiki_*` calls per turn (`wiki.lucid.maxCallsPerTurn`), so you
are asked between edits.

### Time and web

Toolsets `time` and `web`.

| Tool | What it does |
|---|---|
| `time_now` | Returns the current date, time, weekday and timezone. |
| `web_search` | Searches the web through Brave. Needs `web.brave.apiKey`. |
| `web_fetch` | Fetches a web page as Markdown. Addresses inside your own network are refused. |

### Files

Toolset `file`. Every tool works on the somora host or, with
`target`, on a configured SSH resource.

| Tool | What it does |
|---|---|
| `file_read` | Reads a file as numbered lines (`N: text`), 2000 per call, with the offset to continue. |
| `file_write` | Creates or replaces a file. |
| `file_patch` | Replaces `old_string` in a file. Tolerates whitespace and indentation drift and shows a diff. |
| `file_search` | Searches file contents. Takes `include` globs, `context` lines and `files_only`. |
| `file_list` | Lists a folder, recursively with a glob. Honours `.gitignore`. |
| `analyze_file` | Has an image or PDF described by the vision worker, for models that cannot see. |

`analyze_file` is offered only when `vision.worker` is set and the
agent's current model lacks the `image` capability. A model that can see
reads the picture itself with `file_read`.

For a builder agent, a write or patch result also carries the language
server's `errors` for the file.

### Shell and terminals

Toolset `exec`.

| Tool | What it does |
|---|---|
| `exec` | Runs one shell command, waiting for it or in the background, locally or on an SSH resource. |
| `process` | Handles background jobs: `action` is `list`, `poll`, `log`, `write` or `kill`. |
| `tmux` | Keeps terminal sessions open across turns: `action` is `create`, `send`, `capture`, `wait_idle`, `list` or `kill`, against `target: local` or an SSH resource. |

Destructive command patterns are blocked. A resource can lift single
blocks with `allowBlocked`, for a machine that belongs to the agent.

Background jobs are detached: they survive a somora restart and are
tracked on disk. `poll` checks the real process, never a remembered
state.

The tmux guide explains `wait_mode`, `multiline_safe` and
`include_ansi`.

### Other agents

Toolset `agents`.

| Tool | What it does |
|---|---|
| `spawn_subagent` | Hands a task to a sub-agent in its own sealed session. |
| `spawn_subagents` | Starts several sub-agents in one call. |
| `subagent_status` | Reports where one sub-agent stands. |
| `subagent_result` | Fetches a sub-agent's result, or waits for it. |
| `subagent_list` | Lists the agent's sub-agent tasks. |
| `subagent_cancel` | Stops a sub-agent and everything it started. |
| `agent_ask` | Sends a message into another agent's session and returns its reply. |
| `agent_ask_result` | Fetches or waits for the outcome of an earlier `agent_ask`: `done`, `failed` or `pending`. The message is never sent twice. |
| `agent_ask_cancel` | Takes an own `agent_ask` back. |
| `session_list` | Lists chat sessions: the agent's own, another agent's with `agent`, everyone's with `"*"`. |
| `session_model` | Switches the model of an existing session, or clears the override with `clear:true`. |
| `builder_dispatch` | Hands a build order to a builder agent and returns a `call_id`. |

What an agent should know about waiting:

- **A spawn is a background task.** The default is `wait:false`: the
  tool returns a `task_id` and the parent is woken with a
  `[subagent attention]` turn when the sub finishes. `attention:false`
  switches the wake off. `wait:true` waits and returns the result
  inline.
- **A wait that runs out is not a failure.** After
  `agentLoop.longTaskMaxTimeoutMs` the tool returns `state: "pending"`
  with the `task_id`. The sub keeps running and the wake still comes.
- **`agent_ask` behaves the same.** No answer within `timeout_ms`
  returns `state: "pending"` with a `call_id`, and the asker is woken
  when the answer lands. `wait: false` returns `pending` at once.
- **Cancelling a question never aborts the target's turn.** A queued
  call is `removed`. A running one is `withdrawn`, and `steered` says
  whether the stop message reached the turn.
- **Waits cannot deadlock.** A call that would close a circle of agents
  waiting on each other is refused with an explanation.

A finished sub-agent's result carries facts the model cannot make up:

| Field | Meaning |
|---|---|
| `outcome` | `completed`, `partial` (the engine forced a finish at a limit), `degraded` (the sub looped or never answered) or `failed`. |
| `outcome_reason` | Why, in words. |
| `tool_calls`, `rounds` | How much work the sub did. |
| `files_written` | Files created or edited with `file_write` or `file_patch`. |
| `media` | Absolute paths of every image or video the sub generated. |
| `follow_ups` | Results of work the sub started and that finished later. |

More parameters:

- **Sessions.** The target sees
  `[Message from agent <name>, session <slug>]`. An `agent_ask` without
  `session` answers into the session that message came from, otherwise
  into `main`. An explicit
  `session` always wins. `create_session: true`, optionally with
  `model: "<alias>"`, creates a missing session on the target and pins
  the model on it.
- **Pictures.** `agent_ask` and the `spawn_*` tools take
  `images: ["/absolute/path.png"]`. The receiving agent sees them. A
  target without vision gets the vision worker's description.
- **Limits.** One agent runs at most 4 sub-agents at a time, 16 across
  the instance. Subs started by a sub count against the parent, and the
  last slot is kept for top-level spawns.
- **Builders.** `builder_dispatch` may omit `builder` when exactly one
  builder exists. A project folder another builder is working in is
  refused.

### Skills, sentinel and projects

Toolsets `skills`, `sentinel` and `projects`.

| Tool | What it does |
|---|---|
| `skill` | Loads the full text of one skill from `~/.somora/skills/<slug>/SKILL.md`. |
| `skill_list` | Lists the skills the agent may use, fresh from disk. |
| `sentinel` | Manages triggers that wake an agent on a schedule: `action` is `create`, `list`, `get`, `pause`, `resume`, `delete`, `test`, `history` or `purge_completed`. |
| `entity_list` | Lists the entities a project can belong to. |
| `project_list` | Lists projects, filtered by entity or tag. |
| `project_get` | Shows one project with its paths. |
| `project_create` | Creates a project. |
| `project_update` | Changes a project: paths, tags and other fields. |
| `project_focus` | Pins a project to the current session. |

`sentinel` with `list` hides one-shot triggers that already fired
unless you pass `include_completed`. `purge_completed` drops them all.

### Images, video and browser

Toolsets `image`, `video`, `media` and `browser`.

| Tool | What it does |
|---|---|
| `image_generate` | Creates images from a prompt. Returns paths and metadata. `return_image: true` also shows the image to the agent. |
| `image_models` | Lists the configured image models and what each accepts. |
| `video_generate` | Starts a video render and returns at once. The agent is woken when it lands. |
| `video_status` | Reports on video jobs. |
| `video_models` | Lists the configured video models and what each accepts. |
| `media_list` | Finds images and videos generated earlier, newest first, with an optional `type` filter. |
| `browser` | Drives a managed Chromium: `op` is `open`, `snapshot`, `act`, `screenshot`, `tabs`, `status`, `request_handoff`, `close_tab` or `stop`. |

`image_generate` passes the prompt on unchanged. Its specs, such as
`aspect_ratio`, `resolution` and `quality`, are checked against what the
chosen model accepts. `browser` with `open` can emulate a `device` and a
`locale` per tab.

Both generate tools take `reference_images` as file paths. For video
the order matters: one picture is the opening frame, two are opening and
closing frame.

`media_list` has its own toolset because the gallery is shared: an
install with video only still needs to list what it made.

### Decisions

Toolset `decision`.

| Tool | What it does |
|---|---|
| `decision_evaluate` | Asks the configured decision model `boolean`, `choice` and `score` questions about a supplied `state`, optionally with up to four `images` (file paths). Returns probabilities, or `unavailable` with a reason. |

The `images` field is offered only when the decision model has the
`image` capability. The decision models page has the details.

### Builder tools

Toolset `builder`.

| Tool | What it does |
|---|---|
| `todo_write` | Keeps the session's task list shown in the task panel. |
| `ask_user` | Asks the person watching a question and waits for the answer. |
| `plan_write` | Writes the plan file. It is the one write allowed in the plan phase. |

`ask_user` is offered only while the session is attended. In the plan
phase a builder does not get `file_write`, `file_patch`, `process`,
`spawn_subagent` and `subagent_result`.

### Tools from MCP servers

Toolset `mcp`. Each server under `mcp.servers` adds its tools as
`mcp__<server>__<tool>`. They are found at runtime and can be hidden
per agent like any built-in tool, a whole server with
`mcp__<server>__*`.

## Choosing tools per agent

An agent sees every tool that can run, unless its `agent.yaml` says
otherwise:

```yaml
# ~/.somora/agents/<your-agent>/agent.yaml
tools:
  deny:
    - toolset:exec          # a whole family
    - mcp__acme__*          # everything from one MCP server
    - web_search            # one tool
  allow: []                 # empty: everything that is not denied
```

| Pattern | Matches |
|---|---|
| `web_search` | the tool with exactly this name |
| `toolset:exec` | every tool with this toolset tag |
| `mcp__acme__*` | every tool whose name starts with the text before `*` |

The rules:

- `deny` beats `allow`.
- An empty or missing `allow` means everything that is not denied.
- A non-empty `allow` means only the tools it matches.
- No `tools:` block means no restriction.

A change applies from the agent's next turn. The switches in the
Abilities window write exact names into `deny`. When the block contains
an `allow` list, a `toolset:` rule or a `*` pattern, the window shows it
read-only: you wrote a policy by hand and the window does not guess how
to edit it.

> **Tip:** Every offered tool costs context on every turn. Smaller
> local models use tools better when they are offered fewer of them.

### What a builder gets

A builder agent (`kind: builder`) starts from a short list instead of
everything:

```
file_read  file_write  file_patch  file_search  file_list  analyze_file
exec  process  todo_write  ask_user  plan_write
spawn_subagent  subagent_result  subagent_cancel
agent_ask  agent_ask_result  skill  skill_list
web_fetch  web_search
project_get  project_list  project_create  project_focus
memory_search  memory_get  time_now
```

Its own `tools.allow` adds to this list and its `tools.deny` removes
from it. A chat agent never gets the three `builder` tools unless its
`allow` names one of them.

## How a tool reaches the model

| Engine | How it gets the tools |
|---|---|
| `claude-cli`, `grok-cli` | through a local MCP server that somora starts for each turn |
| `codex-cli` | as Codex dynamic tools. Codex asks somora, and the tool runs in the server |
| `openai-compatible` | as function definitions, run inside the server |

All paths are filled from the same catalog and pass the same per-agent
filter, so the set is identical on every engine. The `claude-cli` and
`grok-cli` engines see the names with a prefix, `mcp__somora__<tool>`.

## Results, limits and timeouts

**Size.** A result may be up to 100 000 characters of JSON unless the
tool sets its own limit. A larger one is replaced by a marker with
`truncated`, `original_size_chars`, `cap_chars`, a `preview` and a
`hint`. The complete result is saved under
`~/.somora/agents/<agent>/tool-output/` and the marker names the file
in `full_output_file`, so the agent can read parts of it with
`file_read`.

**Time.** A tool call may take 30 seconds
(`agentLoop.toolCallTimeoutMs`). Tools that are known to run long set
their own limit, or take it from the call: `exec`, `agent_ask` and
`subagent_result` wait as long as the caller asked, up to
`agentLoop.longTaskMaxTimeoutMs`.

**Wrong input.** Input is checked against the tool's schema, and the
error names the field. A nested object sent as a JSON string is read
and accepted. An unknown tool name is answered with up to three similar
names.

## When a call arrives broken

A model writes the arguments of a tool call as text. On
`openai-compatible` engines that text can arrive unusable in two ways.

| Fault | What it is | What somora does |
|---|---|---|
| **Cut off** | The text stops mid-value, usually because the answer ran out of output allowance. | Does not retry, because the same request ends the same way. The model is told the call "arrived cut off after N characters" and to send less in one go. |
| **Malformed** | Complete, but not valid JSON. | Sends the same request again without comment, up to twice. After that the model is told what the parser found, and that a tool without required parameters takes `{}`. |

somora tells the two apart by the text itself: a complete JSON value
ends on its closing bracket. The provider's stop reason is not used,
because routers rewrite it.

The broken text is never sent back to the model. Backends parse the
arguments of earlier calls, so one bad call would make every further
round of the turn fail. The call keeps its place in the conversation
with empty arguments, and the original text stays in the session record.

## Settings

Settings in `config.yaml` that decide whether a tool is offered:

| Setting | Tools it enables |
|---|---|
| `web.brave.apiKey` | `web_search` |
| `vision.worker` | `analyze_file`, for models without the `image` capability |
| `projects.enabled` | `entity_list` and the five `project_*` tools |
| `imageGen.enabled` with `imageGen.models` | `image_generate`, `image_models`, `media_list` |
| `videoGen.enabled` with `videoGen.models` | `video_generate`, `video_status`, `video_models`, `media_list` |
| `browser.enabled` | `browser` |
| `mcp.servers` | `mcp__<server>__*` |

Settings that shape how tools run:

| Setting | Default | Meaning |
|---|---|---|
| `agentLoop.toolCallTimeoutMs` | `30000` | Time limit of one tool call, unless the tool sets its own. |
| `agentLoop.longTaskMaxTimeoutMs` | `1800000` | Longest wait of the tools that wait for other work. |
| `wiki.lucid.maxCallsPerTurn` | `3` | `wiki_*` calls per turn inside a review loop. |

Per agent, in `agent.yaml`:

| Setting | Default | Meaning |
|---|---|---|
| `tools.deny` | none | Patterns of tools to hide from this agent. |
| `tools.allow` | none | When set, only matching tools are offered. For a builder it adds to the builder list. |
| `kind` | `chat` | `builder` starts from the short builder list. |

## Routes

| Route | What it does |
|---|---|
| `GET /tools` | Lists every registered tool with `name`, `toolset`, `description`, `inputSchema`, `maxResultSizeChars` and `hasAvailabilityCheck`. Includes tools that are not offered right now. |
| `POST /agents/:agent/tools/:name` | Runs one tool as that agent. The body is the tool's input. A failed call answers 400. |
| `GET /agents/:agent/tools` | Lists the tools this agent could use, each with `visible`, plus the agent's `gating` and `hasPatternRules`. |
| `PUT /agents/:agent/tools` | Writes `{ deny: [...], allow: [...] }` into the agent's `agent.yaml`. |

## Troubleshooting

**The agent says it has no such tool.** Check the "Offered when" column
above, then the agent's `tools:` block. `GET /agents/<name>/tools`
lists only tools whose configuration exists, with `visible` for each.

**A tool is in `GET /tools` but the agent does not get it.** That route
lists everything registered. What an agent is offered also depends on
configuration, its `tools:` block, and whether it holds a review loop.

**"is hidden while you hold the active dream_review loop".** The agent
is inside a wiki review. It ends the loop with
`dream_review({action: 'end'})` and gets its tools back.

**"is not available in this context".** The tool's configuration is
missing, or the call came from outside the situation the tool needs.

Log lines to look for: `tool.invoked` (with `result_truncated` when a
result was shortened), `tool.input_invalid`, `tool.invoke_failed`,
`tool.available_threw` and `agents.tool_gating_updated`.

## Adding a tool from source

A tool is one `ToolDefinition` object in the somora repository, under
`src/tools/`:

| Field | Meaning |
|---|---|
| `name` | Unique. Also the MCP method and function name. |
| `toolset` | The family tag. |
| `description` | What the model reads. Write it as policy, not only as API text: "use this INSTEAD of running `cat` via exec". |
| `inputSchema` | Zod schema, checked at runtime. |
| `jsonSchema` | JSON Schema sent to the model. Keep it in step with `inputSchema` by hand. |
| `handler(input, ctx)` | Does the work. `ctx` carries `agent`, `session`, `config`, `activeModel` and `getMemoryManager`. |
| `available?(ctx)` | Optional check. When it returns false or throws, the tool is hidden and a call is refused. |
| `maxResultSizeChars?` | Own size limit for the result. |
| `defaultTimeoutMs?`, `timeoutFromInput?`, `maxTimeoutMs?` | Own time limits. |

Register a new bundle with one `registerMany()` line in
`registerAllTools(registry)` in `src/tools/index.ts`. The server and
the MCP child process both fill their registry from that function, so
every engine picks the tool up.

## See also

- [Agents](agents.md): sub-agents, `agent_ask` and sessions in detail
- [Builder agents](builder.md): mode, phase and the task panel
- [Memory](memory.md): the memory tools and how recall ranks
- [Wiki](wiki.md): the shared long-term layer
- [Dream phases](dream-phases.md): REM, Deep, Lucid and the review loop
- [File tools](files.md): limits of the file tools and `analyze_file`
- [Resources](resources.md): SSH targets and `allowBlocked`
- [tmux](tmux.md): shell and TUI session patterns
- [External MCP servers](mcp.md): connecting tool servers
- [Skills](skills.md): the skill system and per-agent visibility
- [Sentinel](sentinel.md): scheduled triggers
- [Projects](projects.md): project manifests
- [Image generation](imagegen.md) and [video generation](videogen.md)
- [Shared browser](browser.md): the managed browser and handoffs
- [Language servers](lsp.md): the `errors` a builder gets after a write
- [TUI display](display.md): `/show` and `/verbose` for tool calls
- [Thinking](thinking.md): thinking depth across engines
- [API](api.md): all routes
