# tmux

The `tmux` tool gives an agent terminals that stay open between its
tool calls. The agent starts a program once, then works with it over
many turns. This is how an agent drives other coding agents (Claude
Code, Codex, OpenCode, Pi and more), a shell, vim or a REPL.

## What you get

- **Coding agents as colleagues.** `start` launches an agent in a
  session, `prompt` hands it a task and waits for the answer. The agent
  in a session is recognised by its process.
- **Its state, read reliably.** For each coding agent somora reports
  `idle`, `working` or `blocked`, the last when a permission, question
  or startup dialog waits for an answer. The rules come from herdr.
- **A wake-up when it matters.** If an agent finishes or stops at a
  dialog while nobody watches, somora starts a turn for the agent that
  started it.
- **Local or remote.** The same calls work on the somora machine and on
  any configured SSH resource.
- **You can look in.** The web client lists the local sessions and
  attaches to them in a terminal window.

For a single command that runs and ends, use `exec` instead. A tmux
session that nobody kills stays around.

## Try it

tmux must be installed on the machine that runs the session
(`sudo apt install tmux`, `brew install tmux`), and the coding agent you
want to drive. Then ask the agent:

```
Start Codex in a tmux session called review-1 in /path/to/project and
ask it to review the current diff. Tell me what it finds.
```

The agent makes these calls:

```jsonc
tmux({ action: "start",  name: "review-1", cwd: "/path/to/project", command: "codex" })
tmux({ action: "prompt", name: "review-1",
       text: "Review the current diff and report only actionable findings." })
tmux({ action: "read",   name: "review-1", lines: 120 })
tmux({ action: "kill",   name: "review-1" })
```

`tmux` is part of the `exec` toolset. An agent that may not use that
toolset does not have the tool.

## The life of a session

| Action | What it does |
|---|---|
| `create` | Starts a detached session with a shell in it. Fails when the name is taken, so the agent can reuse the session or pick another name. |
| `start` | Starts a coding agent: creates the session if needed, types `command` into its shell and returns when the agent is ready. |
| `prompt` | Hands the coding agent a message and, by default, waits until it is done or stops at a dialog. |
| `new_conversation` | Gives the coding agent a fresh conversation for the next task and returns when it is ready. |
| `send` | Types text (`keys`) or presses named keys (`key`). |
| `capture` | Returns the end of the screen, at once or after waiting for a pattern. |
| `read` | Like `capture`, with wrapped lines joined: for reading an answer. |
| `wait_idle` | Waits until a coding agent is idle or blocked, or a shell's screen stops changing. |
| `list` | Lists the sessions on the target, with the agent in each and its state. |
| `explain` | Shows which detection rule decided an agent's state. |
| `kill` | Ends the session. Killing a session that is gone is not an error. |

## Local and remote sessions

`target` is `"local"` by default, which means the machine somora runs
on. Any other value is the name of an SSH resource the agent may use
(`resource_list` shows them). The session lives on that host and keeps
running when the connection drops between calls.

Remote sessions get everything local ones do: the agent's state,
`start` and `prompt`, and the attention watcher. Only
`inherit_agent_env` and the web client's tmux app are local.

## Coding agents

### The size of a session

A session that `create` or `start` makes is 160 columns by 45 rows and
keeps that size (`window-size manual`): an agent's state is read from
its screen, and a small terminal that attaches must not shrink it. The
web client attaches to these sessions without changing their size, and
you can still type into them. A smaller viewer sees part of the screen,
a larger one a margin. Sessions made by hand follow the viewer as
before.

### Recognising the agent

somora looks at the foreground processes of a session's terminal
(`ps -t <tty>`) and recognises the agent by name, also when a shell or
`sh -c` started it, or when it runs on node or bun. Recognised are
Claude Code, Codex, OpenCode, Pi, Gemini CLI, Cursor Agent, GitHub
Copilot CLI, Grok CLI, Qwen Code, Kimi Code, Kilo Code, Devin, Droid,
Amp, Hermes Agent, Letta Code and more.

A host whose `ps` cannot list a terminal's processes shows no agent. For
such a host name the agent at `create` with `kind` (`"codex"`,
`"claude"`, `"pi"`, …). The kind only counts while `ps` shows nothing.

### Its state

```jsonc
"agent": {
  "name": "codex",
  "state": "working",
  "rule": "osc_title_working",
  "identified_by": "process"
}
```

| `state` | Meaning |
|---|---|
| `idle` | Ready for input: finished, or freshly started. |
| `working` | Busy. A message waiting behind the current turn counts as working. |
| `blocked` | An approval, question or startup dialog waits for an answer (trust this folder, allow this command, pick an option). |
| `unknown` | The screen says nothing about the state, for example while a transcript viewer is open. |

`capture`, `read`, `wait_idle`, `prompt` and `start` report `agent` for
every session with a recognised agent, `list` reports `name` and `state`
per session. A shell has no `agent` field.

### How the state is read

somora reads the visible screen and the terminal title with herdr's
detection rules. [herdr](https://github.com/herdrdev/herdr) is a
terminal workspace for coding agents (Apache-2.0); its rule files come
with somora converted to JSON but with the rules unchanged, together
with the herdr version they are from and herdr's license. Each rule
looks at one part of the screen, the bottom lines, the input box or the
title. Of the matching rules the one with the highest priority decides.
No match means `idle`.

somora adds rules herdr does not have yet beside them, for example
Codex's dialog about its shared background server and its worktree
question after `/new`. New herdr rules
arrive with somora releases. Nothing is fetched while somora runs.

### Your own rules

A file `~/.somora/tmux-detection/<agent>.json` replaces the rules for
that agent, for example `codex.json`. It uses herdr's rule format as
JSON (`id`, `version`, `rules` with `id`, `state`, `priority`,
`region`, `contains`, `regex`, `line_regex`, `all`, `any`, `not`). A
file may also add an agent somora does not know. A file that does not
parse or compile, or whose `id` is not its file name, is skipped with a
warning in the log, and the shipped rules stay in force.

Changes apply after a restart of somora.

Your file replaces somora's own additions for that agent too. For
Codex these are the rules for its background-server dialog and the
worktree question after `/new`; copy them from the shipped
`somora-rules/codex.json`, or `new_conversation` no longer answers that
question.

`explain` shows the rule that decided, every rule that matched, where
the rules came from and their version:

```jsonc
tmux({ action: "explain", name: "review-1" })
// explain: { state, rule, fallback, rules_from: "bundled" | "override",
//            version, path, title, matched_rules, rules_checked }
```

`path` is your rule file when one is in use. When no agent is
recognised, `explain` is `{ agent: null, processes, note }`: the
processes in the pane and why none counts.

## Starting and prompting

`start` types `command` into the session's shell, so the session stays
open when the agent exits. It returns when the agent is ready (idle on a
screen that shows something). Errors:

- `agent_not_ready` with `agent.state: "blocked"`: the agent stopped at
  a dialog on its way up (trust this folder, a login). Read `content`
  and answer with `send`, or ask the person.
- `agent_not_ready` without a state: it did not come up within
  `wait_timeout_ms` (60 seconds by default).
- `agent_busy`: an agent already runs in this pane.
- `not_a_shell`: another program holds the pane, so nothing is typed.
- `tmux_error`: the session could not be created or read.

`prompt` pastes `text` as one message, line breaks kept, and presses
Enter. With `wait: true` (the default) it returns when the agent is
idle again or blocked, at most `wait_timeout_ms` (5 minutes by default,
10 at most). `content` holds the end of the screen.

`prompt` sends nothing in these cases, and says so:

| `error` | The agent is | Do |
|---|---|---|
| `agent_blocked` | at a dialog | Read it, decide or ask the person, answer with `send`, then prompt again. |
| `agent_busy` | working | `wait_idle`, or interrupt with `send` `key: "Escape"`. Codex keeps text typed while it works in its input box. A moment of working (Codex right after `/new`) gets about three seconds to settle first. |
| `agent_state_unknown` | showing something else | `capture` to look, `key: "Escape"` usually closes it. |
| `no_agent` | not there | Use `start`, or `send` for a shell. |

After Enter, `prompt` waits up to 10 seconds for a sign that the agent
took the message: it works, it stops at a dialog, or its screen moved
on. Without one the result is `agent_prompt_stalled`. Capture before
sending again: the text may still sit in the input box.

`timeout` means the agent took the message and is still working. Wait
longer with `wait_idle`, or end the turn: the attention watcher wakes
the agent when it is done.

### A fresh conversation

`new_conversation` clears the agent's conversation before the next
task, so old context from a finished task does not lead it astray. It
sends the agent's own command (`/new` for Codex, OpenCode and Pi,
`/clear` for Claude Code) and returns when the agent is idle again.

Codex then asks where the new conversation runs; somora answers with
the current worktree when that choice is preselected and says so in
`dialog_answered`; otherwise it hands the dialog back as
`agent_blocked`. An agent whose command somora
does not know gets `not_supported`: send its command with `prompt`.

### How long a task takes

The attention watcher times every task: from the `prompt` that handed
it over, or else the moment an agent leaves idle, until it is idle
again, a dialog in between included. The agent's own `/new` from
`new_conversation` is no task.

`list` shows `working_for_s` for an agent at work and `last_task_s` for the
last finished task. The wake line names it too: `… stopped working and
is idle after 6 min`. A task that starts and ends between two looks of
the watcher is not timed.

### Coordinating several agents

One session per agent, each with a readable name and a clear role,
works best. Give every task a fresh conversation (`new_conversation`). Ask each agent to end with a
short status: done or blocked, the files it changed, open questions.
A file such as `AGENTS.md` in the project can carry these rules for all
of them.

The bundled skill `coding-team` holds the whole procedure: agreeing the
team, an `AGENTS.md` template with roles, the files each may change and
the status format, handing out tasks, checking and committing.

## Sending input

**Text.** `keys` is typed as written. Each `\n` is an Enter, so end a
shell command with `\n` to run it. For a coding agent use `prompt`.

**Named keys.** `key` presses one or more tmux keys, separated by
spaces: `Escape`, `C-c`, `C-u`, `Tab`, `BSpace`, `Up`, `Down`, `Enter`,
`F1`, `C-x C-c`. The prefixes are `C-` for Ctrl, `M-` for Alt and `S-`
for Shift. Use it to interrupt a program (`Escape`, `C-c`) or to answer
a dialog (`Down`, `Enter`).

A `send` call takes `keys` or `key`, never both.

With `multiline_safe: true` every `\n` inside `keys` becomes Alt+Enter,
a line break that does not submit. `prompt` needs no such flag: it
pastes. Alt+Enter does not reach every program when tmux's
`extended-keys` is off. In a shell or a Python REPL every Enter runs
its line, so send the lines as they are. The Python REPL from 3.13 on
indents by itself: send lines without leading spaces.

## Reading the screen

`capture` returns the last `lines` lines of the pane (200 by default)
in `content`. Without `wait_pattern` it returns at once. `read` returns
the same with wrapped lines joined, the better choice for reading an
agent's answer.

With `wait_pattern`, `capture` checks the screen every 200 ms until the
pattern matches or `wait_timeout_ms` is over (30 seconds by default, 10
minutes at most). On a timeout you get `matched_pattern: false` and the
screen as it is. `wait_mode` decides what counts as a match:

| `wait_mode` | Matches when | Use for |
|---|---|---|
| `auto` (default) | The pattern appears more often than before the wait, or it is on screen and the last line ends with a prompt (`$`, `#` or `>`). | Shell sessions. The command you typed often contains the pattern itself, and this mode does not fall for that. |
| `present` | The pattern is anywhere on screen. | Programs that draw a fixed screen: vim, htop, fzf. |
| `idle` | The pattern is on screen and nothing has changed for `idle_stable_ms` (500 by default). | Waiting until a program has stopped redrawing. |

> **Tip:** A wait that ends in a timeout although the text is on screen
> usually has the wrong mode. Use `present` for full-screen programs and
> `auto` for shells. `auto` does not know prompts that end in `❯`.

### Waiting

`wait_idle` needs no pattern. For a coding agent it returns when the
agent is idle (`became_idle: true`) or blocked (`became_idle: false`,
`agent.state: "blocked"`, with a hint). For a shell it returns when the
screen has not changed for `idle_stable_ms`. On a timeout it returns
`became_idle: false` and the latest screen.

## Suggestions are not input

Claude Code and Codex show a grey suggestion in their input field, a
guess at what a human might type next. In a normal capture it looks
exactly like typed text:

```text
❯ works now, thanks                ← typed
❯ delete the project               ← suggestion drawn by the program
```

> **Warning:** Never press Enter on input you did not type yourself. It
> may be a suggestion, and submitting it can trigger destructive actions
> such as "delete the project". Type your own input, or ask the user.

`agent.suggestion_visible` and `agent.suggestion_text` say what is a
suggestion. Ignore it: do not clear it, mention it or submit it. It
disappears when you type. Without an agent field, capture with
`include_ansi: true`: a suggestion arrives in dim styling such as
`\x1b[2m…\x1b[0m`, typed text does not.

## The attention watcher

The server watches the sessions somora created, locally and on SSH
resources, as long as a coding agent runs in them. Every few seconds it
reads the agent's state and notices two things:

- **Stopped working:** the agent went from working to idle. Usually it
  finished; a turn can also stop half-way, so the wake asks to read
  first and check the agent's status report.
- **Needs an answer:** the agent stopped at a dialog (blocked).

What happens next depends on whether the agent that created the session
saw it:

- **The agent saw it.** Its own `prompt`, `wait_idle` or `capture`
  returned that state. Nothing happens.
- **The agent missed it.** somora starts a turn for that agent in the
  chat session the tmux session was created from.

The wake turn carries one of these texts:

```
[tmux attention] Session '<name>' (<agent>) stopped working and is idle after <time>.
[tmux attention] Session '<name>' (<agent>) needs an answer: it stopped at a dialog.
```

` after <time>` appears when the length of the task is known: seconds
below 90 seconds (`45 s`), minutes above (`6 min`). A session on an SSH
resource adds ` on <resource>` after its name. The
turn comes with instructions: read the session first, never send a new
prompt unread, never approve a dialog it does not understand. Web
client, mobile app and TUI show the turn as a `tmux` divider.

While the agent is busy in another turn, the wake waits. Meanwhile
every `tmux` result it gets carries `waiting_for_you`: its other
sessions that finished or wait at a dialog and were not looked at yet,
each with `name`, `target` (remote only), `state`, `reason`
(`finished`, or `dialog` with the detection `rule`, such as
`permission_required`) and `since`. Looking
at such a session counts as having seen it, and its wake is dropped.

### Rules that keep it calm

- **One wake per event.** A wake the agent ignores is not repeated. The
  session is armed again once the agent uses it again.
- **Never in the middle of a turn.** While the agent is busy in that
  chat session, the wake waits.
- **Cooldown and daily cap.** `cooldownS` sets the pause between two
  wakes for one session, `dailyCapPerSession` the limit per UTC day.
  Past the cap only the flag is set.
- **Only what somora started.** Sessions made by hand with `tmux new`
  and sessions without a coding agent are never watched.
- **No wake for a dead session.** If the session was killed before the
  turn could start, the wake is dropped.
- **Opt out per session** with `attention: false` on `create` or
  `start`.

### The attention block

For watched sessions `capture`, `read`, `wait_idle` and `list` add:

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
| `needs_attention` | An event the creating agent has not looked at yet. |
| `last_event_at` | When the agent last finished or stopped at a dialog, in epoch milliseconds. |
| `last_wake_at` | When the last wake turn was started, or `null`. |
| `wakes_today` | Wake turns for this session today. |
| `state` | What the watcher saw last: `running`, `ready` or `blocked`. |
| `task_started_at` | When the current task started, in epoch milliseconds; `null` while idle. |
| `last_task_ms` | How long the last finished task took. |
| `rule` | While `blocked`: the detection rule that matched. |
| `task_ended_at` | When the last task ended, in epoch milliseconds. |

## The environment inside a session

A local session should behave like a terminal you opened yourself. So
somora removes its own internal variables before your shell starts:

| Group | Variables |
|---|---|
| Claude isolation | `CLAUDE_CONFIG_DIR`, `SOMORA_CLAUDE_BIN` |
| Engine overrides | `SOMORA_CODEX_BIN`, `SOMORA_GROK_BIN`, `SOMORA_BIN_PATH`, `SOMORA_CODEX_SHELL_ENV_POLICY` |
| Runtime | `TSX_TSCONFIG_PATH`, `NODE_ENV` |
| Login key | `SOMORA_KEY` |
| Claude Code markers | `CLAUDECODE`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*` |

The effect: a `claude` or `codex` started in the pane uses your normal
login in `~/.claude`, and a project's own `tsx` resolves path aliases
against the project's tsconfig, not somora's.

The agent's identity (`SOMORA_AGENT`, `SOMORA_SESSION`) and the server
address variables stay, so skill scripts can still call somora. The key
does not: a script sends `-H "Authorization: Bearer $(somora key)"`.

`inherit_agent_env: true` on `create` passes the internal variables
through, the key included. It is rarely needed:

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
into the same pane the agent uses. The window takes the size of the
agent's session and does not change it.

When the session ends, the window says so and checks every 3 seconds.
A session started anew under the same name is attached again by itself.
When the same session is still there, another client took it over, and
the window stays closed.

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
| `action` | all | required | `create`, `start`, `prompt`, `new_conversation`, `send`, `capture`, `read`, `wait_idle`, `list`, `explain` or `kill`. |
| `target` | all | `"local"` | `"local"` or the name of an SSH resource. |
| `name` | all except `list` | required | Session name, up to 100 characters. Use letters, digits, dash and underscore, for example `codex-bugfix-auth`. |
| `cwd` | `create`, `start` | none | Working directory of a new session's shell. |
| `command` | `start` | required | The command that starts the agent, for example `codex`, `claude`, `opencode --model <provider>/<model>`. |
| `text` | `prompt` | required | The message, any length, line breaks kept. |
| `wait` | `prompt` | `true` | `false` returns as soon as the agent took the message. |
| `kind` | `create`, `start` | none | The agent, for a host whose `ps` cannot show it, or `shell`. |
| `attention` | `create`, `start` | `true` | `false` keeps the watcher away from this session. |
| `inherit_agent_env` | `create`, `start` | `false` | `true` keeps somora's internal variables. Local only. |
| `keys` | `send` | none | Text to type. `\n` is Enter. |
| `key` | `send` | none | Named keys, separated by spaces. Letters, digits, dash and underscore only. |
| `multiline_safe` | `send` | `false` | `true` sends every `\n` inside `keys` as `M-Enter`. |
| `lines` | `capture`, `read`, `prompt`, `start`, `new_conversation`, `wait_idle` | `200` (`prompt`, `start`: 60; `new_conversation`: 40) | Lines from the end of the pane to return. 1 to 10000. |
| `wait_pattern` | `capture` | none | Text to wait for. |
| `wait_mode` | `capture` | `"auto"` | `auto`, `present` or `idle`. |
| `wait_timeout_ms` | `prompt`, `start`, `new_conversation`, `capture`, `wait_idle` | `prompt` 300000, `start` 60000, others 30000 | Longest wait. 100 to 600000. |
| `idle_stable_ms` | `capture` in mode `idle`, `wait_idle` on a shell | `500` | How long the screen must stay unchanged. 100 to 10000. |
| `include_ansi` | `capture` | `false` | `true` keeps colour and style codes in `content`. |

## Results

Every result has `action`, `ok`, `target` and, except for `list`,
`name`. A failed call adds `error`. Every result except `list` adds
`waiting_for_you` when other sessions of the calling agent finished or
wait at a dialog.

| Action | More fields |
|---|---|
| `create` | `hint`: a reminder of the next calls. |
| `start`, `prompt`, `new_conversation` | `agent`, `content`, `ms`; `submitted` and `settled` (`prompt`, `new_conversation`), `settled` (`start`), `command` and `dialog_answered` (`new_conversation`: the command it sent, the dialog it answered); on failure `error` (a code from the table above, or `not_supported`) and `hint`. |
| `send` | `ms`, `agent` (the state a moment after the keys) |
| `capture`, `read` | `content`, `matched_pattern` (`false` on a timeout or without a pattern), `wait_pattern` (echoed when set), `ms`, `agent`, `attention` |
| `wait_idle` | `content`, `became_idle`, `ms`, `agent`, `hint`, `attention` |
| `list` | `count`, `sessions`: each with `name`, `created_at` (epoch milliseconds), `windows`, `agent` (`name`, `state`, `working_for_s`, `last_task_s`) and `attention` |
| `explain` | `agent`, `explain` |
| `kill` | `was_running`: `false` when the session was already gone. |

## Routes and files

| Route | What it does |
|---|---|
| `GET /tmux/sessions` | Lists local tmux sessions as `{ sessions: [...] }`. Each has `name`, `windows`, `activeCommand`, `activeTitle`, `createdEpoch`, `lastActivityEpoch`, `sessionId` (tmux's id, new for a session started anew under the same name) and, for sessions somora created, `origin` with `agent`, `session`, `kind` and `createdAt`. |
| `WS /tmux/attach?session=<name>` | Attaches to a local session. Binary frames carry the terminal stream. Text frames: the client sends `{type:'resize',cols,rows}` and answers `{type:'ping'}` with `{type:'pong'}`; the server sends `{type:'attached',sessionId,createdEpoch}` once attached. Sessions somora created are attached with `ignore-size`, so the viewer never changes their size. |

| File in `~/.somora/` | Content |
|---|---|
| `tmux-origins.json` | Who created which session, on which target, and a declared kind. |
| `tmux-observations.json` | When the creating agent last looked at a session, and what it saw. |
| `tmux-attention.json` | The watcher's current `attention` block per session. |
| `tmux-detection/<agent>.json` | Your own detection rules for an agent. |

## Troubleshooting

**An agent's state looks wrong.** Run `explain` on the session: it
names the rule that decided and what matched. A program version newer
than the rules may draw a screen they do not know yet; a file of your
own in `~/.somora/tmux-detection/` fixes it until the next release.

**`list` shows no agent although one runs.** The agent is recognised by
its process name. A wrapper with another name hides it: start the agent
directly, or name it with `kind` on `create`.

**`prompt` says `agent_prompt_stalled`.** The agent showed no sign of
taking the message. Capture the session: the text may sit in the input
box, or the agent shows something unusual. Do not send the text again
blindly.

**A capture times out although the text is on screen.** The wait mode
does not fit the program. Use `wait_mode: "present"` for full-screen
programs. The server log has a `tmux.capture.pattern_timeout` line with
the mode and the pattern.

**No wake turn after the agent finished.** Check that somora created the
session, without `attention: false`, and that `tmux.attention.enabled`
and `wake` are on. The watcher must have seen the agent working first:
an agent that starts and finishes between two polls goes unnoticed. The
log lines are `tmux.attention_wake`, `tmux.attention_wake_skipped`,
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
