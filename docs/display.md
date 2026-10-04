# TUI display

The TUI is somora's chat client for the terminal. This page explains
what it shows, which lines you can switch on and off, and every slash
command it knows. The switches only change what your terminal draws.
The server sends and runs everything either way.

## What you get

- **A quiet or a detailed view.** Hide memory and tool lines with
  `/show`, or expand them to the full payload with `/verbose`.
- **The model's reasoning on demand.** `/verbose thinking on` puts the
  thinking text above each reply.
- **A status line that tells the truth**: agent, session, model, tokens
  spent, context fill, and what the session is working on.
- **Control over the queue.** `/queue` lists what runs and what waits,
  `/queue rm` takes an entry back.
- **Everything by slash command**: switch agent, session or model,
  export a session, reload the config, restart the service.

## Try it

Start the client against a running server:

```bash
somora tui
```

It opens the agent you used last, in its `main` session. An empty
session greets you with the somora lettering. Type a message and press
Enter. Then try the switches:

```
/show tools off
/verbose memory on
/help
```

Type `/` to see all commands. Tab completes the highlighted one.

## The screen

Finished messages scroll up into your terminal's own scrollback. The
bottom panel stays in place: a separator, the status line, the command
list while you type a `/`, the input, and a line of hints.

### The status line

| Part | Meaning |
|---|---|
| `🐨 somora · <agent>:<session> · <model>` | Where you are, and the model that answered the last turn. |
| `Σ↑ 12k+80k¢` | Input tokens the last turn spent, summed over all its requests. The green part with `¢` was read from the cache. |
| `▣ 45k/200k` | How full the context is. Yellow above 75 %, red above 90 %, magenta when it is over the window. |
| `↓ 1.2k (300 🧠)` | Output tokens, with reasoning tokens in brackets. A `~` marks an estimate. |
| `🧠 high` | The thinking depth of the turn. `thinking=high (dormant)` means the model cannot reason, so the setting does nothing. |
| `mem ✓ tools ✓` | The two `/show` switches. An off switch is red: `mem ✗`. |
| `📝 wiki-review:<agent>` | A wiki review loop is active. |
| `📁 <project>` | The project pinned to this session. `⚠` marks an archived one. |
| `📬 2` | Two other agents have something unread. |
| `⌛3 ▶1 🤖2 ↩1` | Work counters, see "The work queue". Absent when the session is idle. |
| `●` | Green: connected. Red: not connected. During a turn a spinner with `thinking` or `streaming` takes its place. |

### Lines in the chat

| Line | Meaning |
|---|---|
| `user` | A message typed by a person, here or in another client. |
| `<icon> <agent>` | The agent's reply, below its name. |
| `↬ ada` or `↬ ada/<session>` | A message from another agent. The session is named when it is not `main`. |
| `◇ memory · 3 hits · top=0.82 · <refs>` | Notes recalled for this turn. At most three references are listed, then `+N more`. |
| `▸ <tool> · <summary>` | A tool call. |
| `↳ <summary>` | The tool's result. Results with nothing worth showing are left out. |
| `↳ error · <message>` | The tool failed. |
| `◌ codex · plan · <summary>` | An internal item of the engine, such as the plan list of the codex engine. |
| `🧠 thinking` | The model's reasoning, only with `/verbose thinking on`. |
| `[image] <file>` or `[video] <file> (4.0s)` | The reply produced a picture or a video. The terminal shows the file name. |
| `i`, `!`, `✗` | A notice from the client: info in gray, warning in yellow, error in red. |

### Turns nobody typed

A turn that somora or another part of the system started is one gray
line, not a message:

| Line | What started the turn |
|---|---|
| `🔔 sentinel · <trigger name>` | A sentinel trigger fired. |
| `🤖 subagent · <task>` | A sub-agent delivered its result. |
| `↩ agent answer · <agent>` | The answer to a question this agent asked another agent. |
| `🌐 browser · <view> · handed back` | The browser window was handed back to the agent. `activity` appears in place of `handed back` for other browser wakes. |
| `🎙 voice · <text>` | A request from a voice call. |
| `🖥 tmux · <tmux session>` | A watched terminal session needs attention. |
| `🎬 video · <first line>` | A video render finished or failed. |
| `⚙ system · <cause>` | somora itself speaks. After a restart the cause is `restart`. |

### The lettering

An empty session is greeted with the somora lettering, a tagline and a
hint, once per run of the client. Below 60 columns a compact three-line
version is used. Nothing is drawn below 22 columns or when the terminal
locale is not UTF-8.

## Sending and keys

| Key | What it does |
|---|---|
| Enter | Sends the message or runs the slash command. |
| Tab, Shift+Tab | Steps through the matching slash commands and fills in the highlighted one. |
| Up, Down | Steps through what you sent before, up to 100 entries. Your unsent draft comes back at the end. |
| Esc | During a turn: stops the running turn and keeps your input. Otherwise: clears the input. |
| Ctrl+C | Clears the input. With an empty input it quits. |

You can keep typing while the agent works. A message sent during a
running turn waits its turn and shows `· queued`, or `· queued · N
ahead` when others wait before it. It moves into the chat when it
starts.

## The two switches

`/show` decides whether a line appears at all. `/verbose` decides how
much detail it carries when it does. Think of `/show` as the master
switch and `/verbose` as the zoom.

| Command | Effect |
|---|---|
| `/show` | Lists the current state. |
| `/show memory on\|off` | Shows or hides the `◇ memory` lines. |
| `/show tools on\|off` | Shows or hides tool calls, tool results and the `◌` engine lines. |
| `/verbose` | Lists the current state. |
| `/verbose tools on\|off` | Adds the full input and output below each tool call and result. Engine lines expand to their full content. |
| `/verbose memory on\|off` | Adds the full recalled text below each memory line, as the model received it. |
| `/verbose system on` | Prints the agent's system prompt once. |
| `/verbose system off` | Clears the flag. Blocks already printed stay. |
| `/verbose thinking on\|off` | Shows the model's thinking text above each reply. |

Good to know:

- A switch applies to new lines. Lines already printed do not change.
- `/show memory off` wins over `/verbose memory on`: a hidden line has
  no place for details. The same goes for tools.
- Hiding is display only. The notes are still recalled and the tools
  still run.
- When you switch to a session, its stored tool lines are replayed
  whatever `/show tools` says, in a short form that `/verbose tools`
  does not expand. Memory lines are not stored, so they do not come
  back.

One line is never hidden: the warning that a backup model answered. It
starts with `⇄ model fallback:`, names every model that failed with its
reason, and then the model that answered. It is replayed when you open
the session again.

## Thinking text

`/verbose thinking` is off by default. When it is on:

- **While the model thinks** and no reply text has arrived, the last
  six lines of its thinking show where the reply will appear. The first
  word of the reply replaces them.
- **After the turn** a gray `🧠 thinking` block sits above the reply. It
  shows at most 40 lines and ends with `… (+N lines)` for the rest.
- **`(truncated)`** behind the label means the server cut the text at
  its size limit.
- **Switching to a session** replays stored thinking blocks only when
  the switch is on at that moment.

The block exists only for engines and models that provide their
reasoning. The `thinking` spinner in the status line and the reasoning
token counter work whatever this switch says.

The web client has the same switch. There it is on by default and kept
per session.

## The work queue

The status line counts everything the session has to do, whoever
started it: your messages, another agent's question, a sub-agent's
result, a sentinel trigger, a request from a call.

| Counter | Meaning |
|---|---|
| `⌛3` | Three entries are waiting. |
| `▶1` | A turn is running. |
| `🤖2` | Two things this session started elsewhere: sub-agents, or questions to other agents. |
| `↩1` | One result is on its way back to this session. |

`/queue` prints the list in four parts: Running, Waiting, Arriving and
From here. Waiting entries are numbered. The entries under "From here"
continue that numbering.

`/queue rm <n>` acts on the entry with that number:

| Entry | What happens |
|---|---|
| Your own waiting message | Removed. Its text returns to the input so you can rewrite it. |
| Another agent's waiting question | Removed. That agent is told it failed, with the reason. |
| A waiting sub-agent brief | Removed and reported as cancelled. |
| A waiting sentinel trigger | Removed and reported as skipped. |
| Running, under "From here" | Stopped. A sub-agent stops with everything it started. For a question, the turn in the asked session is stopped. |
| Started in the meantime | Nothing is removed. The notice says so. Esc stops a running turn. |

The counters are fetched again on every queue event, when a turn starts
or ends, after `/queue rm` and on a session switch. Nothing is polled
while the session is idle.

## Exporting a session

`/export` fetches the session from the server and writes a file where
you started the client. The notice names the full path, the size and
the format.

| Command | Result |
|---|---|
| `/export` | A readable Markdown transcript in `./<agent>-<session>.md`. |
| `/export markdown [path]` | The same, to a path of your choice. |
| `/export json [path]` | The raw event log, one JSON event per line. Default path `./<agent>-<session>.jsonl`. |

A path only works after the format word.

## Slash commands

| Command | What it does |
|---|---|
| `/help` | Lists all commands. |
| `/agents` | Lists the agents. `*` marks the current one. |
| `/agent <name> [session]` | Switches to another agent, into its `main` session unless you name one. |
| `/sessions` | Lists the current agent's sessions with message count and last activity. `📬` marks unread, `📁` a pinned project. |
| `/session <slug-or-id>` | Switches to another session of the current agent. |
| `/new <slug>` | Creates a session and switches to it. |
| `/main` | Returns to the `main` session. |
| `/reset [YES]` | Without `YES`: explains what would happen. With `YES`: archives the current session and starts it fresh. The archive can be opened again with `/session <id>`. |
| `/models` | Lists the configured models with alias, engine, context size and capabilities. |
| `/model [<alias>\|default]` | No argument: shows the model in effect and where it comes from. An alias or `provider/id`: sets it for this session. `default` or `-`: back to the agent's own model. |
| `/show [memory\|tools] [on\|off]` | Line visibility, see "The two switches". |
| `/verbose [tools\|memory\|system\|thinking] [on\|off]` | Detail level, see "The two switches". |
| `/thinking [off\|low\|medium\|high\|default]` | No argument: shows the thinking depth in effect and its source. A level: sets it for this session. `default` or `-`: clears the session's own setting. |
| `/reload` | Reads `~/.somora/config.yaml` again without a restart. Reports what changed and what needs a restart. |
| `/restart [YES]` | With `YES`: restarts the somora service. Every open stream drops and the client reconnects. Without `YES`: asks you to confirm. |
| `/sampling [key=value …\|default]` | No argument: shows the sampling parameters in effect. `key=value` pairs set them for this session, the value `-` removes a key. `default` or `-` clears the session's own setting. |
| `/temp <0–2>\|default` | Short for `/sampling temperature=<n>`. `default` or `-` removes only the temperature. |
| `/export [json\|markdown] [path]` | Writes the session to a file, see "Exporting a session". |
| `/queue [rm <n>]` | Lists the session's work, or removes entry `n`, see "The work queue". |
| `/projekt [<slug>\|unlink]` | No argument: shows the project pinned to this session. A slug pins it, from the next turn on. `unlink`, `off`, `clear` or `-` removes the pin. |
| `/project [<slug>\|unlink]` | The same command under its English name. |
| `/projects` | Lists the available projects. |
| `/quit` | Leaves the client. |
| `/exit` | The same. |

Keys for `/sampling`: `temperature`, `top_p`, `top_k`, `min_p`,
`frequency_penalty`, `presence_penalty`, `repetition_penalty`, `seed`,
`stop`. Only the openai-compatible engine applies them. On other
engines the notice says the setting is dormant.

The three project commands appear only when `projects.enabled` is
`true` in `config.yaml`.

`/restart` works when somora runs as a background service: the systemd
user unit on Linux or the LaunchAgent on macOS. A server started by
hand refuses, because nothing would bring it back.

## Settings

The start values of the switches live in `~/.somora/config.yaml`:

```yaml
tui:
  show:
    memory: true
    tools: true
  verbose:
    tools: false
    memory: false
    system: false
    thinking: false
```

| Setting | Default | Meaning |
|---|---|---|
| `tui.show.memory` | `true` | Memory lines are visible. |
| `tui.show.tools` | `true` | Tool calls, tool results and engine lines are visible. |
| `tui.verbose.tools` | `false` | Full input and output below each tool line. |
| `tui.verbose.memory` | `false` | Full recalled text below each memory line. |
| `tui.verbose.system` | `false` | Start value of the system flag that `/verbose` lists. It does not print the system prompt at start. |
| `tui.verbose.thinking` | `false` | Thinking text above each reply. |

The client does not read the file for these. It asks the server once at
start with `GET /tui-config`. If the server does not answer, the
defaults above apply. A switch you flip with `/show` or `/verbose` lasts
until you quit.

### Where the client connects

By default the client talks to `http://127.0.0.1:18737`. When
`server.tls` is set in `config.yaml`, it uses HTTPS and the host from
`server.tls.publicHost`. Environment variables override this:

| Variable | Meaning |
|---|---|
| `SOMORA_BASE` | The full address, for example `https://nova.tail1234.ts.net:18737`. Wins over the others. |
| `SOMORA_HOST` | The host name. |
| `SOMORA_PORT` | The port. Default `18737`. |
| `SOMORA_TLS` | `1` forces HTTPS, `0` forces HTTP. |

The agent you used last is remembered in `~/.somora/tui-state.json`.
Without one, the client starts on the first agent in alphabetical
order.

## What the server sends

The detail for `/verbose` is always in the live events. The client only
decides whether to draw it. That is why a switch works at once, without
a reconnect, and why any other client can offer the same switch without
a new route.

| Event | Always drawn from | Drawn only when verbose |
|---|---|---|
| `tool` | `tool`, `summary` | `details`: the payload as formatted JSON |
| `memory` | `count`, `topScore`, `refs` | `fullText`: the recalled block as the model received it |
| `thinking` | nothing | `text` (the full text so far) and `truncated` |

The server formats the payloads. A client shows strings and needs no
knowledge of any tool.

Routes the client uses for the features on this page:

| Route | Used for |
|---|---|
| `GET /tui-config` | The start values of the switches. |
| `GET /agents/:agent/system-prompt` | `/verbose system on`. |
| `GET /agents/:agent/sessions/:session/work` | The counters and the `/queue` list. |
| `DELETE /chat/queue/:id` | `/queue rm` on a waiting entry. |
| `POST /spawn-cancel` | `/queue rm` on a running sub-agent. |
| `POST /chat/abort` | Esc, and `/queue rm` on a running question. |
| `GET /agents/:agent/sessions/:session/export?format=…` | `/export`, with `format` being `json` or `markdown`. |
| `POST /config/reload` | `/reload`. |
| `POST /server/restart` | `/restart YES`. |

## Troubleshooting

**No memory or tool lines appear.** Look at the status line. A red
`mem ✗` or `tools ✗` means the switch is off. Turn it on with
`/show memory on` or `/show tools on`.

**`/verbose tools on` did not expand the lines above.** Switches apply
to new lines only. The next tool call shows its payload.

**No thinking block although the switch is on.** The engine or model
does not provide its reasoning, or `thinkingContent.capture` is `false`
in `config.yaml`.

**`/projekt` says the feature is disabled.** Set `projects.enabled:
true` in `config.yaml`.

**`/restart YES` is refused.** somora was started by hand and not as a
service. Restart it the way you started it.

**`/queue` says the server did not answer.** The server is older than
the client and has no work route. Update the server.

**`stream closed by server` or `stream error` notices.** The live
connection dropped. The client reconnects by itself, first after half a
second, then with growing pauses up to ten seconds. A notice ending in
`giving up` means the agent or session no longer exists: switch with
`/agent` or `/session`.

**No lettering in an empty session.** The terminal is narrower than 22
columns, the locale is not UTF-8, or the lettering was already shown in
this run.

## See also

- [Thinking](thinking.md): thinking depth, and which engines show
  their reasoning
- [Sampling](sampling.md): the parameters behind `/sampling` and `/temp`
- [Projects](projects.md): what a pinned project does
- [Memory](memory.md): what the memory lines recall
- [Setup](setup.md): engine internals such as the codex plan list, and
  HTTPS
- [Web client](web.md) and [Mobile app](mobile.md): the other clients
- [API](api.md): `GET /tui-config`, the work, export and queue routes
