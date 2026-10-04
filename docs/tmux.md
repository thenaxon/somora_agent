# tmux

The `tmux` tool gives an agent a terminal that stays open between its
tool calls. The agent starts a program once, then types into it and
reads its screen over many turns. This is how an agent drives another
command-line program such as Claude Code, codex, OpenCode, vim or a
REPL.

## What you get

- **A terminal that survives the turn.** The program keeps running
  while the agent answers you, and is still there on the next turn.
- **Waiting without guessing.** The agent can wait for a text to
  appear, or simply until the screen stops changing.
- **Knows the common coding CLIs.** For Claude Code, codex and OpenCode
  the tool reports whether the program is ready, still working or
  holding unsent input.
- **A wake-up when the program is done.** If a coding CLI finishes
  after the agent stopped watching, somora starts a turn so the agent
  reads the result.
- **Local or remote.** The same calls work on the somora machine and on
  any configured SSH resource.
- **You can look in.** The web client lists the sessions and attaches
  to them in a terminal window.

For a single command that runs and ends, use `exec` instead. A tmux
session that nobody kills stays around.

## Try it

tmux must be installed on the machine that runs the session
(`sudo apt install tmux`, `brew install tmux`). Then ask the agent:

```
Open a tmux session called build-1 in /path/to/project, run ./build.sh
and tell me when it says "Build succeeded".
```

The agent makes these calls:

```jsonc
tmux({ action: "create",  name: "build-1", cwd: "/path/to/project" })
tmux({ action: "send",    name: "build-1", keys: "./build.sh\n" })
tmux({ action: "capture", name: "build-1",
       wait_pattern: "Build succeeded", wait_timeout_ms: 60000 })
tmux({ action: "kill",    name: "build-1" })
```

`tmux` is part of the `exec` toolset. An agent that may not use that
toolset does not have the tool.

## The life of a session

| Action | What it does |
|---|---|
| `create` | Starts a detached session with a shell in it. Fails when the name is taken, so the agent can reuse the session or pick another name. |
| `send` | Types text (`keys`) or presses named keys (`key`). |
| `capture` | Returns the end of the screen, at once or after waiting for a pattern. |
| `wait_idle` | Waits until the screen stops changing. No pattern needed. |
| `list` | Lists the sessions on the target. |
| `kill` | Ends the session. Killing a session that is gone is not an error. |

## Local and remote sessions

`target` is `"local"` by default, which means the machine somora runs
on. Any other value is the name of an SSH resource the agent may use
(`resource_list` shows them). The session lives on that host and keeps
running when the connection drops between calls.

Three things work for local sessions only: the session `kind` with its
`tui_state`, the attention watcher, and `inherit_agent_env`. A remote
session behaves like kind `shell`.

## Sending input

**Text.** `keys` is typed as written. Each `\n` is an Enter, so end a
shell command with `\n` to run it.

**Named keys.** `key` presses one or more tmux keys, separated by
spaces: `Escape`, `C-c`, `C-u`, `Tab`, `BSpace`, `Up`, `F1`, `C-x C-c`.
The prefixes are `C-` for Ctrl, `M-` for Alt and `S-` for Shift. Use
it to interrupt a program (`Escape`, `C-c`) or to clear its input line
(`C-u`). Control characters written into `keys` are unreliable.

A `send` call takes `keys` or `key`, never both.

### Messages with several lines

The input boxes of coding CLIs submit on Enter. A message with line
breaks would be sent as several messages. With `multiline_safe: true`
every `\n` inside the text becomes Alt+Enter (`M-Enter`), which those
programs treat as a line break. A `\n` at the very end is still a
plain Enter and submits the message.

```jsonc
tmux({ action: "send", name: "claude-1", multiline_safe: true,
       keys: "Please build a Tetris game.\n\n" +
             "1. Next.js + TS\n" +
             "2. 10x20 grid\n" })
```

Do not use `multiline_safe` for a plain shell. It does not follow this
convention and joins your lines instead.

## Reading the screen

`capture` returns the last `lines` lines of the pane (200 by default)
in `content`. Without `wait_pattern` it returns at once.

With `wait_pattern` it checks the screen every 200 ms until the pattern
matches or `wait_timeout_ms` is over (30 seconds by default, 10 minutes
at most). On a timeout you get `matched_pattern: false` and the screen
as it is. `wait_mode` decides what counts as a match:

| `wait_mode` | Matches when | Use for |
|---|---|---|
| `auto` (default) | The pattern appears more often than before the wait, or it is on screen and the last line ends with a prompt (`$`, `#` or `>`). | Shell sessions. The command you typed often contains the pattern itself, and this mode does not fall for that. |
| `present` | The pattern is anywhere on screen. | Programs that draw a fixed screen: Claude Code, codex, vim, htop, fzf. There is no shell prompt and the count never grows. |
| `idle` | The pattern is on screen and nothing has changed for `idle_stable_ms` (500 by default). | Waiting until a program has stopped redrawing. |

```jsonc
// A coding CLI has started and shows its welcome panel.
tmux({ action: "capture", name: "claude-1",
       wait_pattern: "bypass permissions on",
       wait_mode: "present", wait_timeout_ms: 15000 })
```

> **Tip:** A wait that ends in a timeout although the text is on screen
> usually has the wrong mode. Use `present` for full-screen programs and
> `auto` for shells. `auto` does not know prompts that end in `❯`.

### Waiting until it is quiet

`wait_idle` needs no pattern. It returns when the screen has not
changed for `idle_stable_ms`, with `became_idle: true`. On a timeout
it returns `became_idle: false` and the latest screen. Use it when you
cannot know what the final output will look like.

## Session kinds

A session has a `kind`, set on `create`. It tells somora which program
runs in the pane.

| `kind` | Start it for | Counts as queued | Counts as running |
|---|---|---|---|
| `shell` (default) | bash, zsh, fish, build scripts, REPLs, vim, htop, anything not listed below | never | never |
| `claude-code` | `claude`, `claude --dangerously-skip-permissions` | `Press up to edit queued messages` | `esc to interrupt`, or a spinner word: `Tempering…`, `Whisking…`, `Contemplating…`, `Pondering…`, `Brewing…`, `Simmering…`, `Sautéing…` |
| `codex` | `codex` | never | `esc to interrupt` |
| `opencode` | `opencode` | `QUEUED` under a message sent during a turn | `esc interrupt`, or `esc again to interrupt` after a first Escape |

For every kind except `shell`, two things change:

1. `capture` and `wait_idle` add a `tui_state` block to the result.
2. `wait_idle` reports `became_idle: true` only when the screen is
   quiet and the state is `ready`. A pane that sits on unsent input or
   on a paused spinner no longer passes as finished.

Pick `shell`, or leave `kind` out, when you are unsure. A wrong kind
does not break the session. Its markers just never match.

### The state of the program

```jsonc
"tui_state": {
  "state": "ready",
  "markers": [],
  "suggestion_visible": false
}
```

| Field | Meaning |
|---|---|
| `state` | `ready`: waiting for input. `queued`: input is in the box and not processed yet. `running`: still working. `idle_unknown` is reserved and not reported today. |
| `markers` | The marker texts from the table above that were found on screen. |
| `suggestion_visible` | `true` when the input line shows a grey suggestion. Kinds `claude-code` and `codex` only. |
| `suggestion_text` | The suggested text, when one is visible. |

When both a queued and a running marker are on screen, the state is
`queued`.

```jsonc
tmux({ action: "create", name: "claude-1", kind: "claude-code",
       cwd: "/path/to/project" })
tmux({ action: "send", name: "claude-1",
       keys: "claude --dangerously-skip-permissions\n" })
// later, after sending a prompt
const r = await tmux({ action: "wait_idle", name: "claude-1",
                       wait_timeout_ms: 600000 })
// r.tui_state.state === "queued":  not submitted, do not go on
// r.tui_state.state === "running": wait longer, or send key "Escape"
// r.became_idle && state "ready":  done, read r.content
```

### OpenCode

Two things differ from the other kinds:

- A `△ Permission required` dialog reads as `ready`, because it waits
  for an answer. `capture` shows the dialog. `key: "Enter"` picks the
  preselected "Allow once". Arrow keys and Enter pick "Allow always" or
  "Reject".
- A message sent while a turn runs is queued and submitted by OpenCode
  when the turn ends. `queued` therefore means that more work follows.

OpenCode reads its model from `~/.config/opencode/opencode.json` and
accepts any OpenAI-compatible endpoint. That makes it the kind to use
for driving a coding model you host yourself.

## Suggestions are not input

Claude Code and codex show a grey suggestion in their input field, a
guess at what a human might type next. In a normal capture it looks
exactly like typed text:

```text
❯ works now, thanks                ← typed
❯ delete the project               ← suggestion drawn by the program
```

> **Warning:** Never press Enter on input you did not type yourself. It
> may be a suggestion, and submitting it can trigger destructive actions
> such as "delete the project". Type your own input, or ask the user.

How to tell the two apart:

- **With a kind set:** `tui_state.suggestion_visible` and
  `suggestion_text` say what is a suggestion. Ignore it. Do not clear
  it, mention it or submit it. It disappears when you type.
- **Without a kind:** capture with `include_ansi: true`. `content`
  then keeps the colour codes, and a suggestion arrives wrapped in dim
  styling such as `\x1b[2m…\x1b[0m`. Typed text does not.

## The attention watcher

Local sessions of kind `claude-code`, `codex` or `opencode` are watched
by the server. Every few seconds it looks at the pane and notices when
the program goes from working to `ready`. That means it finished, or it
waits for input such as a permission prompt.

What happens next depends on whether the agent that created the session
saw it:

- **The agent saw it.** Its own `capture` or `wait_idle` returned
  `ready` after the program stopped. Nothing happens.
- **The agent missed it.** Its wait timed out and its turn ended while
  the program kept working. somora starts a turn for that agent in the
  session the tmux session was created from.

The wake turn carries this text:

```
[tmux attention] Session '<name>' (<kind>) became ready.
```

It comes with instructions for the agent: capture the session first,
then decide whether to reply into it, answer a prompt, report to the
user or wrap up, and never send a new prompt unread. Web client, mobile
app and TUI show the turn as a `tmux` divider, like a sentinel trigger.

### Rules that keep it calm

- **One wake per completion.** A wake the agent ignores is not
  repeated. The session is armed again once the agent uses it again.
- **Never in the middle of a turn.** While the agent is busy in that
  chat session, the wake waits.
- **Cooldown and daily cap.** `cooldownS` sets the pause between two
  wakes for one session, `dailyCapPerSession` the limit per UTC day.
  Past the cap only the flag is set.
- **Only what somora started.** Sessions made by hand with `tmux new`,
  kind `shell` and remote sessions are never watched.
- **No wake for a dead session.** If the session was killed before the
  turn could start, the wake is dropped.
- **Opt out per session** with `attention: false` on `create`.

### The attention block

For watched sessions `capture`, `wait_idle` and `list` add:

```jsonc
"attention": {
  "needs_attention": true,
  "last_event_at": 1785150000000,
  "last_wake_at": null,
  "wakes_today": 0,
  "state": "ready"
}
```

| Field | Meaning |
|---|---|
| `needs_attention` | A completion the creating agent has not looked at yet. |
| `last_event_at` | When the program last became ready, in epoch milliseconds. |
| `last_wake_at` | When the last wake turn was started, or `null`. |
| `wakes_today` | Wake turns for this session today. |
| `state` | What the watcher saw last: `running` or `ready`. Unsent input counts as `running`. |

## The environment inside a session

A local session should behave like a terminal you opened yourself. So
somora removes its own internal variables before your shell starts:

| Group | Variables |
|---|---|
| Claude isolation | `CLAUDE_CONFIG_DIR`, `SOMORA_CLAUDE_BIN` |
| Engine overrides | `SOMORA_CODEX_BIN`, `SOMORA_GROK_BIN`, `SOMORA_BIN_PATH`, `SOMORA_CODEX_SHELL_ENV_POLICY` |
| Runtime | `TSX_TSCONFIG_PATH`, `NODE_ENV` |
| Claude Code markers | `CLAUDECODE`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*` |

The effect: a `claude` or `codex` started in the pane uses your normal
login in `~/.claude`, and a project's own `tsx` resolves path aliases
against the project's tsconfig, not somora's.

The agent's identity (`SOMORA_AGENT`, `SOMORA_SESSION`) and the server
address variables stay, so skill scripts can still call somora.

`inherit_agent_env: true` on `create` passes the internal variables
through. It is rarely needed:

- A nested `claude` should share the isolated state of somora's own
  Claude engine.
- You debug a difference between what somora sees and what a normal
  shell sees.
- You pointed `CLAUDE_CONFIG_DIR` at your own config tree in
  `~/.somora/somora.env` and want tmux sessions to use it too.

`exec` has the same flag with the same default, `false`.

## Watching from the web client

The `tmux` app in the web client lists the sessions on the somora
machine and refreshes every 5 seconds. Each row shows the agent and
chat session that created it. A session started outside somora is
labelled "orphan". Open a row to attach in a terminal window and type
into the same pane the agent uses.

## Settings

```yaml
tmux:
  attention:
    enabled: true
    wake: true
    pollMs: 3000
    cooldownS: 60
    dailyCapPerSession: 40
```

| Setting | Default | Meaning |
|---|---|---|
| `tmux.attention.enabled` | `true` | Turns the watcher on. Off means no polling and no `attention` block in tool results. |
| `tmux.attention.wake` | `true` | Start wake turns. `false` only sets `needs_attention`. |
| `tmux.attention.pollMs` | `3000` | How often the watcher looks at each pane. Minimum 500. |
| `tmux.attention.cooldownS` | `60` | Minimum seconds between two wakes for one tmux session. |
| `tmux.attention.dailyCapPerSession` | `40` | Most wakes per tmux session and UTC day. |

These live in `config.yaml`. A change in the `tmux` section applies
after a restart of somora.

## Tool parameters

One tool, `tmux`. Only `action` is always required.

| Parameter | Used by | Default | Meaning |
|---|---|---|---|
| `action` | all | required | `create`, `send`, `capture`, `wait_idle`, `list` or `kill`. |
| `target` | all | `"local"` | `"local"` or the name of an SSH resource. |
| `name` | all except `list` | required | Session name, up to 100 characters. Use letters, digits, dash and underscore, for example `codex-bugfix-auth`. |
| `cwd` | `create` | none | Working directory of the session's shell. |
| `kind` | `create` | `"shell"` | `shell`, `claude-code`, `codex` or `opencode`. |
| `attention` | `create` | `true` | `false` keeps the watcher away from this session. |
| `inherit_agent_env` | `create` | `false` | `true` keeps somora's internal variables. Local only. |
| `keys` | `send` | none | Text to type. `\n` is Enter. |
| `key` | `send` | none | Named keys, separated by spaces. Letters, digits, dash and underscore only. |
| `multiline_safe` | `send` | `false` | `true` sends every `\n` inside `keys` as `M-Enter`. |
| `lines` | `capture`, `wait_idle` | `200` | Lines from the end of the pane to return. 1 to 10000. |
| `wait_pattern` | `capture` | none | Text to wait for. |
| `wait_mode` | `capture` | `"auto"` | `auto`, `present` or `idle`. |
| `wait_timeout_ms` | `capture`, `wait_idle` | `30000` | Longest wait. 100 to 600000. |
| `idle_stable_ms` | `capture` in mode `idle`, `wait_idle` | `500` | How long the screen must stay unchanged. 100 to 10000. |
| `include_ansi` | `capture`, `wait_idle` | `false` | `true` keeps colour and style codes in `content`. |

## Results

Every result has `action`, `ok`, `target` and, except for `list`,
`name`. A failed call adds `error`.

| Action | More fields |
|---|---|
| `create` | `hint`: a reminder of the next calls. |
| `send` | `ms` |
| `capture` | `content`, `matched_pattern` (`false` on a timeout or without a pattern), `wait_pattern` (echoed when set), `ms`, `tui_state`, `attention` |
| `wait_idle` | `content`, `became_idle`, `ms`, `tui_state`, `attention` |
| `list` | `count`, `sessions`: each with `name`, `created_at` (epoch milliseconds), `windows` and `attention` |
| `kill` | `was_running`: `false` when the session was already gone. |

`tui_state` is present for local sessions with a kind other than
`shell`. `attention` is present for watched sessions.

## Routes and files

| Route | What it does |
|---|---|
| `GET /tmux/sessions` | Lists local tmux sessions as `{ sessions: [...] }`. Each has `name`, `windows`, `activeCommand`, `activeTitle`, `createdEpoch`, `lastActivityEpoch` and, for sessions somora created, `origin` with `agent`, `session`, `kind` and `createdAt`. |
| `WS /tmux/attach?session=<name>` | Attaches to a local session. Binary frames carry the terminal stream, text frames carry `{type:'resize',cols,rows}`. |

| File in `~/.somora/` | Content |
|---|---|
| `tmux-origins.json` | Who created which session, and its kind. |
| `tmux-observations.json` | When the creating agent last looked at a session. |
| `tmux-attention.json` | The watcher's current `attention` block per session. |

## Troubleshooting

**A capture times out although the text is on screen.** The wait mode
does not fit the program. Use `wait_mode: "present"` for full-screen
programs. The server log has a `tmux.capture.pattern_timeout` line with
the mode and the pattern.

**`wait_idle` never reports idle for a coding CLI.** Look at
`tui_state.state` in the result. `queued` means the input is still in
the box: submit it with `key: "Enter"` if you typed it. `running`
means the program is still working.

**A multi-line prompt arrives as several messages.** Send it with
`multiline_safe: true`.

**No wake turn after the CLI finished.** Check that the session is
local, was created with a coding kind and without `attention: false`,
and that `tmux.attention.enabled` and `wake` are on. The watcher must
have seen the program working first. A program that starts and
finishes between two polls goes unnoticed. The log lines are
`tmux.attention_wake`, `tmux.attention_wake_skipped`,
`tmux.attention_wake_stale` and `tmux.attention_cap_reached`.

**`claude` in the pane asks for a login.** That is the default: the
pane uses your own `~/.claude`, not somora's isolated copy. Log in
there once, or create the session with `inherit_agent_env: true`.

**The call fails with "not a configured resource".** `target` names an
SSH resource that does not exist or that this agent may not use.

## See also

- [Tools](tools.md): all tool families and toolsets
- [Resources](resources.md): SSH targets for remote sessions
- [Web client](web.md): the tmux app and terminal windows
- [Sentinel](sentinel.md): other ways an agent is woken
- [API](api.md): `GET /tmux/sessions`, `WS /tmux/attach`
- [Setup](setup.md): installing tmux, the isolated Claude config
