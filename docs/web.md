# Web client

A desktop in your browser. Every agent is an icon, every conversation a
window, and you can keep as many open side by side as you like. It talks
to the same server as the terminal client and the phone app, so all
three show the same conversations.

## What you get

- **Many chats at once.** One window per agent and session, each with
  live answers, tool calls and token counts.
- **Never blocked.** Type while the agent works. Your message waits in
  a queue you can see and edit, or steers the running turn.
- **Everything in one place.** Sessions, files, terminals, the shared
  browser, media, the wiki, the team chart and the server log are
  windows on the same desktop.
- **A glance tells you what is going on.** Dots and badges show which
  agents work, where something unread waits and what is dreaming.
- **Server controls.** Reload the config or restart somora from the
  taskbar, and see when an update is available.
- **A desktop that looks the way you like.** Dark, Light, the bundled
  Ocean theme, or a theme of your own with your colours and wallpaper.

## Open it

The server serves the web client at `/web/`:

```
https://<your-host>.<your-tailnet>.ts.net:18737/web/
```

On the machine somora runs on, `http://127.0.0.1:18737/web/` works too.

The web client needs Chrome or Edge 111, Firefox 114, Safari 16.4 or
newer.
To reach it from other devices, set `server.host: 0.0.0.0` in
`~/.somora/config.yaml` and restart.

### Sign in

The first time a browser opens somora, it asks for the server's key.
Paste what `somora key` prints on the server, or run `somora key link`
there and open the link it prints. The link signs the browser in at
once and drops the key from the address bar.

The browser then keeps a cookie for a year. It asks again after
**Sign out** in the gear menu, after `somora key rotate`, or when you
clear the site's data. With `server.auth: off` there is no key page.

> **Warning:** Whoever has the key can use every agent. Keep the server
> on your tailnet or LAN, never on the public internet. The security
> page explains the key.

> **Note:** Use HTTPS as soon as you open more than a few windows. Over
> plain HTTP a browser allows six connections per server, and every chat
> window and terminal holds one. The seventh window looks dead.
> Microphone, screenshots and voice calls also need HTTPS. The setup
> guide shows the Tailscale way under "HTTPS (Tailscale)".

## The desktop

### Icons

The desktop shows one icon per agent, followed by the app icons.

| Action | Result |
|---|---|
| Click an agent | Opens its `main` chat, or brings that window forward. |
| Right-click an agent | Opens the agent menu, see below. |
| Click an app icon | Opens that window. Each app has one window. |
| Drag an icon | Moves it to any free cell. Dropping on an occupied cell swaps the two. |
| `Alt+Arrow` | Moves the focused icon one cell. |

Icons sit below windows, like on a real desktop. The arrangement is
remembered per browser. In a smaller browser window, icons that no
longer fit move to the nearest free cell and return when there is room
again.

### What an agent icon shows

| Signal | Meaning |
|---|---|
| Status dot | Green: idle. Amber: a turn is running in one of its sessions, open or not. Violet: holds the dream review loop. Grey: server unreachable. |
| Unread dot | Something arrived in a session since you last looked: a reply, a message from another agent or a sentinel message. Your own messages do not count, nor do the sessions of sub-agents: their answers reach you through the agent that asked. |
| Pulse glow | A dream phase is running. Green: REM for this agent. Indigo: Deep, on every agent. Violet: Lucid, on the agent holding the review loop. |
| Number badge | REM findings waiting for review, `9+` at most. It shrinks as an agent works through them with `dream_apply` and `dream_dismiss`. |
| Grey outline and `builder` label | The agent is a builder. |
| Sign in the bottom-left corner and `external · <system>` label | An [external agent](external-agents.md): 🦞 OpenClaw, ☤ Hermes, initials for other systems. Its chat header shows the system and its version instead of a model, and a question it asks appears as a card with buttons above the input. |

A session counts as seen when its chat window is open and focused. That
clears the unread dot on all your clients. The state lives in the
session's meta file as `unreadAt` and `seenAt`, so it survives a server
restart. Dream states refresh every 30 seconds.

### The agent menu

| Entry | What it does |
|---|---|
| **Open main** | Opens the `main` session. |
| **Recent sessions** | The three most recently active other sessions. Click one to open it in its own window. |
| **New session…** | Type a name: letters, digits, `-` and `_`. The field says what is wrong while you type. Enter creates and opens it, Esc cancels. |
| **All sessions…** | Opens the Sessions window. |
| **Configure…** | Opens the Agent window. |

### App icons

| Icon | Window | Shown |
|---|---|---|
| `tmux` | List of tmux sessions on the host. Click one to attach. | always |
| `terminal` | A fresh shell in the somora workspace. | always |
| `sessions` | All sessions of all agents. | always |
| `sentinel` | Triggers: list, history, test or dry run, pause, resume, delete. | always |
| `abilities` | Tools and skills per agent, MCP server health. | always |
| `team` | The org chart editor. | always |
| `log` | The server log. | always |
| `voice` | A call with an agent. | when realtime voice is set up |
| `browser` | The shared browser's sessions. | when `browser.enabled` |
| `media` | Image and video generation, gallery. | when image or video generation is set up |
| `wiki` | The wiki explorer. | when `wiki.enabled` and `obsidian.vault` are set |

The `wiki` icon carries a violet badge when Lucid findings wait for
review. Its tooltip names the oldest waiting run. Review them with any
agent through `dream_review`.

### Windows

Drag the title bar to move a window and the bottom-right corner to
resize it. The title bar has Close and Minimize. A minimized window
stays in the taskbar. Closing a window never ends the conversation or
disturbs other clients.

Windows never leave the desktop. Dragging and resizing stop at the
edges, and no window can cover the taskbar. When the browser gets
smaller, windows that no longer fit are pushed back inside, and shrunk
only when they are bigger than the desktop. Nothing grows back by
itself: use **Restore layout** in the screen menu for that.

There is one chat window per conversation. Opening a session that is
already on the desktop brings its window forward, whether you come from
an icon, the Sessions window, a link in a chat or `/session`.

The layout is saved in the browser as you go and comes back after a
reload. Each device keeps its own.

## The taskbar

The bar at the bottom always stays on top. From left to right:

| Part | What it does |
|---|---|
| Koala, name and version | The somora mascot and the server version. |
| Inbox | Updates, messages from somora.ai and things that need you, with a count of what is new. See "Inbox". |
| Gear | Server menu: reload config, restart, sign out. |
| Screen | **Arrange windows**, **Save layout** and **Restore layout** (a snapshot of the layout, brought back later), **Full screen** where the browser can do it, and the theme: **somora** or one of your own, and **Dark**, **Light** or **Auto**. |
| `Browser · N waiting for you` | Appears when an agent handed the shared browser to you. Opens the browser list. |
| Window buttons | One per open window, in the agent's colour. Click to focus or bring back a minimized window. |
| `cpu` and `mem` | Load and memory of the host, refreshed every 5 seconds. |
| Clock | Time and date. |

**Arrange windows** fills the whole desktop. Counts that fill a grid (1, 2, 4,
6) become an even grid. With 3, 5 or 7 windows the leftmost one takes
the full height and the others stack beside it. Windows keep their
order, so arranging twice changes nothing.

### Reload and restart

| Gear entry | What it does |
|---|---|
| **Reload config** | Reads `config.yaml` again and applies it without a restart. A message lists the changed sections and says which of them need a restart. A file with an error is rejected and the running config stays. |
| **Restart somora** | Restarts the service after a confirmation. All streams drop for a few seconds. The page waits for the server and reloads itself. |
| **Sign out** | Forgets the key in this browser. The key page appears again. The key itself stays valid. |

The entry reads `changed on disk` when the file is newer than what the
server loaded. Restart is greyed out when somora does not run as a
background service (the systemd user unit on Linux, the LaunchAgent on
macOS). `agent.yaml` needs neither: it is read on every
turn.

When `config.yaml` has a mistake, the gear turns red with a `!` and
its menu lists the problems. somora keeps running on the last valid
version until the file is fixed. See
[A broken config file](setup.md#a-broken-config-file). The terminal client has the same actions as `/reload` and
`/restart YES`.

### When an agent restarts somora

An agent can restart the server from its own turn, with
`somora server restart` or `somora update`. Such a restart waits until
that turn has ended. After the server is back, the session is woken to
check the result and carry on. In the chat this shows as a divider
reading `⚙ system · restart`.

Which sessions are woken is set by `server.resumeAfterRestart`. A
session is not woken a third time within ten minutes, so a failing
restart cannot loop.

### Theme

The theme sits at the bottom of the screen menu. It shows the theme
in use: **somora**, **Ocean**, or one of your own, see
[Themes](#themes). A click on the name folds out the list of themes.

Below it you switch between **Dark**, **Light** and **Auto**. **Dark**
is the default. **Light** gives the whole desktop light surfaces with a
darker accent so text stays readable. **Auto** follows the system
setting and switches along when it changes. Both choices are kept per
browser.

Terminal and tmux windows stay dark in every theme. Agent colours stay as chosen;
on Light, text in an agent's colour (its role, the tools and memory
switches) is darkened just enough to stay readable, whatever colour
the agent has.

### Themes

somora comes with two looks:
- **somora:** the built-in one, in Dark and Light.
- **Ocean:** deep blue at night, sky blue by day. It is the theme to
  copy: it sets every colour a theme can set, in both versions, so a
  copy shows you every knob. We keep it up to date with somora.

Both are in the screen menu from the start. Ocean lies in
`docs/themes/ocean/` of the somora install.

Beyond those two, the desktop is yours to design: your colours, a
wallpaper you like, a calm dark or a bright light version, or both. A
theme takes a few minutes, needs no code and cannot break anything: a
mistake shows up in the menu with its reason, and somora stays as it
was. Start from Ocean, as described below.

A theme of your own sets the colours of the desktop and, if you like,
a wallpaper. It can have a dark version, a light version or both. Each
theme is a folder in `~/.somora/themes/` with a `theme.json`:

```
~/.somora/themes/
  harbour/
    theme.json
    night.jpg
```

### Make your own from Ocean

1. Copy Ocean under a new folder name. The name may use letters,
   digits, `-` and `_`:

   ```bash
   mkdir -p ~/.somora/themes
   cp -r "$(npm root -g)/somora/docs/themes/ocean" ~/.somora/themes/harbour
   ```

2. Open `~/.somora/themes/harbour/theme.json`, give it its own `name`
   and change the colours you want different. A colour you delete comes
   from somora's Dark or Light instead.
3. Open the screen menu: Harbour is listed next to somora and Ocean.

A copy under the folder name `ocean` replaces the bundled Ocean in the
list. It then stays as you made it: an update of somora changes the
bundled Ocean, not your copy.

> **Tip:** Keep the menu open while you edit. Save the file, close the
> menu and open it again: the theme is read fresh each time, so you see
> a change without reloading the page.


### The theme file

An example, shortened:

```json
{
  "name": "Harbour",
  "dark": {
    "colors": { "--bg-0": "#040c17", "--bg-1": "#0a1a2e", "--accent": "#4fb3e6" },
    "wallpaper": "night.jpg",
    "grid": false
  },
  "light": {
    "colors": { "--bg-0": "#d6e9f8", "--bg-1": "#f3f9fe", "--accent": "#1c74b8" }
  }
}
```

The list in the screen menu shows the themes by their `name`, after
somora. A folder added or changed while the page is open shows up the
next time the menu opens. A theme that is gone or no longer valid falls
back to somora, in the mode chosen there. A theme with a mistake is
listed greyed out, with the reason when you point at it.

With both versions, Dark, Light and Auto switch between them as they do
for somora. With one version, the switch stays on it and a line below
says so. Dark, Light or Auto stays saved for when you switch back.

| Key | Meaning |
|---|---|
| `name` | Shown in the menu. Optional, the folder name otherwise. |
| `dark`, `light` | The two versions. At least one of them. |

Each version takes these keys:

| Key | Meaning |
|---|---|
| `colors` | Colour tokens from the table below. Optional. Every colour a version does not set comes from somora's Dark or Light. |
| `wallpaper` | A `.png`, `.jpg` or `.webp` file in the theme folder, up to 20 MB. Optional. It takes the place of the background gradient. |
| `grid` | `false` hides the grid lines on the desktop. Optional, default `true`. |

Colour values are `#rgb`, `#rrggbb`, `rgb()` or `hsl()`, with or
without transparency. Nothing else is accepted: no names such as
`red`, no `url()`, no other keys. The folder name may use letters,
digits, `-` and `_`.

| Token | Colours |
|---|---|
| `--bg-0` … `--bg-3` | Surfaces, from the desktop edge (`0`) to fields and hover areas (`3`). |
| `--line`, `--line-2` | Borders and dividers. `--line-2` is the stronger one, e.g. the focused window. |
| `--text-0` … `--text-3` | Text, from the main text (`0`) to faint hints (`3`). |
| `--accent` | Buttons, focus, links. |
| `--accent-dim`, `--accent-glow` | A muted accent, and the glow around the focused window. |
| `--warn`, `--danger`, `--ok` | Warnings, errors, success. |
| `--grid`, `--grid-strong` | The fine and the coarse grid on the desktop. |
| `--glow-1`, `--glow-2` | The soft glows on the desktop, top left and bottom right. These two also take `transparent`, which switches the glow off. |

From bottom to top the desktop is: the gradient from `--bg-0` at the
top to `--bg-1` at the bottom, or the wallpaper; the two glows; the
grid. On a wallpaper the labels under the icons are white with a
shadow, so they stay readable on any picture. `--accent-glow`,
`--grid`, `--grid-strong` and `--glow-1` follow `--accent` unless the
theme sets them.

somora works out the rest from the colours given. The text on accent
buttons is dark or white, whichever reads better on `--accent`.

Window shapes, blur, shadows, fonts and icons are not part of a theme.
Terminal and tmux windows stay dark. Themes are for the web client
only.


### Inbox

The tray icon left of the gear is the inbox. A number on it counts
what is new, up to `9+`: red when something needs you, such as a
login, the config or the certificate, green otherwise. The inbox
refreshes every minute and when the window gets focus. Opening it
marks everything in it as read.

| What arrives | When it goes |
|---|---|
| A newer somora version, with `somora update` and the release notes | The update is installed. |
| A message from somora.ai (the note of the daily update check) | somora.ai sends another one, or none. |
| `config.yaml` has a mistake, with the problem | The file validates again. |
| Claude, Codex or Grok wants a new login; a provider refuses its key; a tool server wants a new login | The next turn on it works. |
| The HTTPS certificate could not be renewed or runs out soon | A fresh certificate is loaded. |
| REM failed three runs in a row for an agent; Deep could not place the same note three times; a Lucid run failed or was cut off | The next run succeeds. |
| A tool server or a model has been unreachable for a day | It answers again. |
| A Sentinel check stopped (errors, or its script copy changed) or used up its wakes for the day | The trigger is resumed and checks again, or is deleted. |
| `subagents.tools.deny` names a tool somora does not have | The entry is fixed. |

One thing is one entry. More failures of the same thing only change
its `since … · n×` line. An entry that resolved itself stays a day,
greyed out, then goes.

**Don't report again** keeps an entry quiet until its cause resolved
once; if it comes back after that, it shows again. Use it for things
you switched off on purpose, such as a tool server. **Hide** on an
update or message hides that one. **Muted** at the bottom lists what
is quiet, with **Report again**.

The inbox is shared: read or muted on one browser is the same on all.
Its text comes from somora and somora.ai only and never reaches an
agent.

## Chat windows

### The header

The first line shows the agent's name, its role, `streaming…` while a
turn runs and the work badge. The second line reads from left to right:

| Element | Meaning |
|---|---|
| Session | The session name, with the full id beside it in grey when the two differ. |
| Model | The model the next turn uses. |
| `(next turn · now <model>)` | The model was switched while a turn runs. The running turn finishes on the model it started with, the menu says the same. |
| `⇄ <model>` | The last turn was answered by a backup model, the agent's `fallback:` in `agent.yaml`. The tooltip says why. |
| `🧠 <level>` | The thinking level. `(dormant)` means the model cannot reason, so the level has no effect. Hidden at `off`. |
| `🧠 auto` | No level is set for the session, the agent or the model. Nothing is sent and the model decides: reasoning models usually think. See the [thinking guide](thinking.md). |
| **tools** | Shows or hides tool calls, tool results and the engine's own plan rows. somora's own notes, such as `model switched` or `context compacted`, stay visible. |
| **memory** | Shows or hides the line that lists the notes recalled for a turn. |
| **voice** | Spoken replies on or off. Only when text-to-speech is configured. |
| `▣ 21%` | How full the context window was on the turn's last request. Amber above 75 %, red above 90 %. |
| `Σ↑` and `↓` | Tokens the turn spent in and out, summed over all its requests. |
| `● connected` | The live connection of this window. `offline` while it is down. |

`▣` and `Σ↑` measure different things. A turn with 21 tool rounds sends
its context 21 times, so the sum runs far past the window and says
nothing about how full it is.

When the last request was larger than the window somora knows, the
badge reads `▣ >100%` with the token count. The configured
`contextWindow` of that model is then too small.

On the right of the header:

| Control | What it does |
|---|---|
| ⊖ and ⊕ | Chat text size from 75 to 200 %. Only the conversation is scaled. A percentage appears when it is not 100 %: click it to reset. |
| Project chip | The project of this session. Only with `projects.enabled`. |
| `•••` | The session menu. |

The text size is remembered per agent and session. Two sessions of the
same agent can have different sizes, and two windows on the same
session stay in step.

The three toggles and the thinking switch are remembered per agent and
session too.

### The conversation

| What you see | Meaning |
|---|---|
| Tool rows | Calls and results, above the answer of their turn. Rows marked `◌ codex · plan` come from the engine. Hidden unless **tools** is on. |
| `🧠 memory · N hits` | The notes recalled for the turn. The arrow expands the injected text. Hidden unless **memory** is on. |
| `🧠 thinking` block | The model's reasoning, when the engine provides it. Collapsed to one line. |
| `⇄ fallback · <model>` chip | A backup model answered. The tooltip lists every model that failed before it, with the reason. |
| Another agent's icon and colour | A message from another agent. `<agent> · <session>` appears when it came from a session other than its `main`. |
| Centered divider | A message from somora itself, not from a person. See the table below. |
| Red **Turn failed** block | The turn ended in an error. Media it produced before failing hangs under it. |
| Pictures and videos under a reply | Media the turn generated. |
| `Image from <host>` with **Show** and **Always show** | A picture from another website, held back until you allow it. See [Security](security.md#pictures-from-other-websites). |
| Thumbnails on your message | Your attachments. |

A notice appears once when a backup model takes over and once when the
primary model answers again. When every model fails, the error names
all of them with their reasons.

Dividers name where the message came from:

| Divider | Source |
|---|---|
| `Sentinel · <trigger>` | A sentinel trigger fired. |
| `tmux · <session>` | The tmux attention watcher. |
| `browser · <name> · handed back` | You gave the shared browser back. |
| `voice` | A question from a running call. |
| `agent answer · <agent>` | A late answer to an `agent_ask`. |
| `subagent · <task>` | A background sub-agent finished. |
| `video` | A video job finished. |
| `⚙ system · <cause>` | somora itself, for example `restart` after a restart. |

The window follows new messages while you are at the bottom. Scroll up
and it stays where you read. Scroll back down to follow again.

History loads the last 100 entries. Scrolling to the top loads 100
more, as does **↑ load older**. A window left open on a busy session
keeps the newest 300 rows once it passes 400. The older ones come back
the same way.

Finished replies are Markdown with highlighted code. Hover one for two
buttons:

| Button | What it does |
|---|---|
| **Copy** | Copies the reply as Markdown. |
| **Pin** | Opens a pin note with this reply. The pin stays yellow while the note exists. Click it again to close the note. |

A reply with generated audio also has a Play button.

### Pin notes

A pin note is a small window that keeps one reply in view while the
conversation goes on. It has a yellow title bar and shows the agent,
the session, when the reply was written and when you pinned it.

- The content is a snapshot. It does not change when the agent writes
  more.
- You can pin as many replies as you like. Pinning the same reply again
  brings its note forward.
- Notes come back after a reload, and stay when the chat window is
  closed or the session is archived.

### The input bar

| Control | What it does |
|---|---|
| Paperclip | Attaches files. Drag and drop onto the window and paste work too. |
| Screenshot | Captures a window, a tab or the screen and attaches it. Hidden where the browser cannot do it. |
| Text field | Enter sends, Shift+Enter starts a new line. Type `/` for commands. |
| Microphone | Records, then adds the transcript to your draft for you to check. Shown when speech-to-text is configured. |
| **queue** or **steer** | Only while a turn runs. Chooses what happens to your next message. |
| Red Stop | Only while a turn runs. Cancels the running turn. |
| Send | Sends the draft. |

Attached files upload at once and appear as chips above the input.
Images and PDFs reach every engine. A model that cannot read a file's
type refuses the upload with a hint to switch models. Uploaded files
are stored once as `~/.somora/attachments/<sha256>.<ext>`. The files
guide has the details.

### While the agent is working

You can keep typing. With the pill on **queue**, a message waits behind
the running turn and shows `⌛ queued`, or `⌛ queued · N ahead`. Queued
messages run in order.

- **↩ edit** next to a queued message takes it back into the input,
  attachments included. Send it again and it joins the end of the
  queue. If the turn started in the meantime, a notice says so.
- With the pill on **steer**, the message goes into the running turn.
  The model reads it at its next step. The bubble shows `steering…`,
  then `steered`. A steer the turn no longer reads becomes a normal
  queued message.
- **Stop** cancels the running turn only. A second Stop sits on the
  streaming reply. Queued messages keep their place.

The agent's `steering:` setting in `agent.yaml` decides which way the
pill starts. Stop works on any turn, whoever started it: the sender is
told that you stopped it.

### The work badge

The badge in the header counts everything on the session, whoever
started it, for example `waiting 3 · running · 1 arriving`. It adds
`2 sub-agents` or `1 ask` for work this session has out elsewhere.
Click it for the list:

| Section | Shows | Buttons |
|---|---|---|
| **Running** | The turn that runs now: its source, first line and start time. | Stop |
| **Waiting** | The queue in order, with source, preview and waiting time. | **×** removes an entry. |
| **Arriving** | Answers on their way back: a late `agent_ask` reply, a finished sub-agent, a rendered video. | none |
| **From here** | Sub-agents and questions this session started that still wait or run. Click a row to open that session. | **×** removes one that has not started. **■** stops a running one. |

Removing a waiting entry tells its sender. Your own message returns to
the input. Another agent's question is reported back as failed, a
sub-agent brief as cancelled, a sentinel fire as skipped. Stopping a
sub-agent also stops everything it started.

### Slash commands

Type `/` in an empty input. Arrow keys move, Enter or Tab accepts, Esc
closes. Commands are not available while a turn is running.

| Command | What it does |
|---|---|
| `/model <ref>` | Switches the model for this session. Completes from the model list. |
| `/session <slug>` | Switches this window to another session of the agent. |
| `/new <slug>` | Creates a session and switches to it. |
| `/thinking <off\|low\|medium\|high\|default>` | Sets the thinking level for this session. `default` removes the override. |
| `/sampling [key=value …\|default]` | Shows, sets or clears sampling parameters for this session. Only the openai-compatible engine uses them. |
| `/temp <0–2>\|default` | Short for `/sampling temperature=<n>`. |
| `/verbose thinking on\|off` | Shows or hides the thinking block in this session. Display only. |
| `/projekt <slug>` | Pins a project to this session. `/projekt unlink` clears it. `/project` is an alias. Only with `projects.enabled`. |
| `/compact [what to keep]` | Compacts this session now and the conversation goes on. The sentence is the focus of the summary. See [Compact by hand](compaction.md#compact-by-hand). |
| `/reset YES` | Archives this session and starts fresh. `YES` is the confirmation. |

There is no `/agent` command. To talk to another agent, open its
window.

### The session menu

The `•••` button opens a menu with four parts. Click outside or press
Esc to close it.

| Part | What it does |
|---|---|
| **Model** | Shows the current model, its engine and context window. **Switch model…** opens a filterable list. A click sets the model for this session, like `/model`. |
| **Thinking** | Shows the level and where it comes from. Buttons set off, low, medium or high for this session. **Reset to default** removes the override. **Show thinking in replies** is the same switch as `/verbose thinking`. |
| **Conversation** | **Compact now** compacts this session, like `/compact` without a focus. The header shows `compacting…` while it runs. Greyed out while a turn runs. |
| **Danger zone** | **Reset session** archives the conversation as `<timestamp>_<session>-archive` and starts fresh, after a second click to confirm. With REM enabled for the agent, REM reads the archived part. |

## The Sessions window

One table of all sessions of all agents. The line on top counts total,
live, archived, dreamed and partial sessions.

| Column | Meaning |
|---|---|
| Agent | The agent's name in its colour. |
| Slug | The session name. A dot marks unread activity. |
| Project | The session's project. Only with `projects.enabled`. |
| Engine | `claude-cli`, `codex-cli`, `grok-cli` or `openai-compatible`: the engine that last ran it. |
| Status | `●` a client is connected to it right now. `📦` archived. `★` the `main` session. |
| Last activity | Relative time. |
| Msgs | Number of user and assistant messages. |
| Size | Size of the session file. |
| REM | `✓` REM has read everything. `⚠N` REM ran, and N events arrived since. `○` REM never ran on it. |

A `⚠N` session needs no action. REM picks the new events up on its next
run.

| Control | What it does |
|---|---|
| Tabs | **Active** (default), **Archived**, **All**. |
| Filters | Agent, engine, REM state (`dreamed`, `partial`, `never`) and a text search over slug, agent and id. |
| Column headers | Agent, Last activity, Msgs and Size sort. Click again to reverse. |
| Click a row | Opens the chat window of that session. |
| Archive button | Archives or unarchives the session. Not offered for `main`: use `/reset` there. A session `/reset` archived comes back as `<name>-archive`, with its whole history, ready to continue. |
| Checkboxes | Select several sessions and archive them together. |
| Two download buttons | Export as a readable Markdown transcript or as the raw JSONL file. Works for archived sessions too. |
| Reload and auto-refresh | Reload by hand. The list also refreshes every 60 seconds unless you switch that off. |

Archiving is a flag, not a move: `archived`, `archivedAt` and
`archiveReason` in the session's meta file. The files stay where they
are, the session only disappears from the pickers, and unarchiving
brings it back. Nothing is ever deleted here. To free space, remove files from
`~/.somora/agents/<agent>/sessions/` by hand.

## Files

A file path in a reply is a link. Clicking it opens the file in a
window. Nothing is refused for its type: what cannot be shown is
described.

| The file is | You get |
|---|---|
| Markdown | Rendered like a chat reply |
| Text or code | Monospace with syntax highlighting |
| Image | Shown inline |
| Video | A player with seeking |
| Audio | A player |
| PDF | The browser's own viewer |
| Anything else | Name, type, size |

Every file has a download button. The type is read from the file's
content, not its extension. `.svg` is shown as source text, because an
SVG can carry script.

Which files can be opened follows the read policy, the same rule
`file_read` applies for an agent. The window reads `GET /files/view`,
and media bytes come from `GET /files/raw`.

## Terminals

**terminal** opens a fresh shell in the somora workspace. Each window
is its own shell, and closing the window ends it.

**tmux** lists the tmux sessions on the host and refreshes every 5
seconds. A row shows which agent and session created it, or `orphan`
for one started outside somora. Click a row to attach: output streams
live and your keys go straight through. The tmux guide covers the rest.

## The Agent window

**Configure…** in the agent menu shows what an agent is made of and
what its prompt costs.

| Part | What it shows |
|---|---|
| Budget strip | Persona files, team block, full prompt and tool schemas, in characters and estimated tokens against `promptBudgets`. |
| **Dreams** | The agent's dreams switch and the model REM runs on. It applies at once, see [Who dreams](dream-phases.md#who-dreams). |
| **A2A** | Whether other agent systems may send the agent tasks, which peers may, and its address. Not shown for a builder. See [A2A](a2a.md#taking-work-in). |
| **Rename…** | Renames the agent everywhere its name lives, after showing what would change. See [Renaming an agent](agents.md#renaming-an-agent). |
| `AGENTS.md`, `SOUL.md`, `USER.md` | Editors with a counter per file, Save and Discard. |
| `agent.yaml` | Read-only. |
| **Full prompt** | The system prompt as the next turn on a chosen session would send it, split into its parts with sizes. |
| **Voice prompt** | What the talking model is told on a call, and whether it comes from `VOICE.md` or the persona. Only for agents that can be called. |

The budgets are soft. Going over turns the counter yellow, and nothing
is cut.

Saving is guarded, because agents edit these files too. A save is
refused when the file changed on disk since you loaded it. The previous
version is kept as a backup. `AGENTS.md` must keep a frontmatter whose
`name` matches the agent's directory.

For a builder the window shows only `AGENTS.md`, and **Full prompt**
shows the builder's own prompt.

## Other windows

These features have their own pages. In short:

| Window | What it is |
|---|---|
| **abilities** | A matrix of tools and skills per agent, plus the health of external MCP servers. A switch takes effect on the agent's next turn. On `codex-cli` the chat shows a `tools changed` marker. The dream tools and the wiki writing tools follow the agent's dreams switch instead; a note in their group says so. |
| **team** | Drag agents onto their superior, edit titles and rules, and preview the `# Your team` block every agent gets. Saved to `~/.somora/team.yaml`. |
| **sentinel** | The triggers that wake agents on their own, with history and a test button. A check trigger also shows its checks and wakes, the last check, the decision model's answer, its script (read only), and a dry run in place. |
| **browser** | One row per agent window of the shared browser. A row opens the live view with tabs, address bar and take-over buttons. A waiting handoff also shows as an **Open browser** notice in its chat. |
| **media** | The form for generating images and videos, and the gallery. |
| **wiki** | The shared wiki in three columns: folder tree, page, links and graph. Read-only. `[[wikilinks]]` are clickable. |
| **voice** | A live call with an agent. |
| **log** | The end of the server log. Pick the day, a minimum level and a text filter. New lines follow every 2 seconds, and following pauses when you scroll up. |

A builder's chat window opens wider and carries the task panel on the
right: mode and phase switches, the **Go** button, the task list the
builder keeps with `todo_write` and the questions it asks with
`ask_user`. Below about 640 px width the panel folds to a
strip.

With projects enabled, the project chip in the chat header shows the
pinned project. Click it for a searchable list of all projects, grouped
by entity. A change made from another client shows up at once.

## Settings

The web client has no section of its own in `config.yaml`. These
settings shape it:

```yaml
server:
  host: 127.0.0.1
  port: 18737
  resumeAfterRestart: requested
  tls:                      # optional, no default
    cert: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.crt
    key: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.key
    publicHost: <your-host>.<your-tailnet>.ts.net
promptBudgets:
  teamBlockChars: 3000
  personaFileChars: 8000
  personaTotalChars: 14000
```

| Setting | Default | Meaning |
|---|---|---|
| `server.host` | `127.0.0.1` | Address the server listens on. `0.0.0.0` makes it reachable from other devices. |
| `server.port` | `18737` | Port. |
| `server.resumeAfterRestart` | `requested` | Who is woken after a restart. `requested`: the session that asked for it or caused it. `all`: also every turn the restart cut. `off`: nobody. |
| `server.tls.cert`, `server.tls.key` | none | Certificate and key files. With both set, the server speaks HTTPS. |
| `server.tls.publicHost` | none | The host name the certificate is for. |
| `promptBudgets.teamBlockChars` | `3000` | Soft limit for the team block in the Agent window. |
| `promptBudgets.personaFileChars` | `8000` | Soft limit for one persona file. |
| `promptBudgets.personaTotalChars` | `14000` | Soft limit for the persona files together. |

The environment variable `SOMORA_HOST` overrides `server.host`. Prefer
the config file: a variable added to the service definition is lost on
`somora update`.

### What the browser remembers

All of this is stored in the browser, per device. Nothing is stored on
the server.

| Key in `localStorage` | Holds |
|---|---|
| `somora-desktop-icons` | Where you placed the icons. |
| `somora-web-layout` | The open windows, saved as you go. |
| `somora-web-layout-saved` | The snapshot made with **Save layout**. |
| `somora-chat-zoom` | Text size per agent and session. |
| `somora.web.showTools.<agent>::<session>` | The **tools** toggle. The same pattern with `showMemory` and `showThinking`. |
| `somora.voice.autoPlay.<agent>::<session>` | The **voice** toggle. |
| `somora.web.builderPanel.collapsed.<agent>` | Whether the builder panel is folded. |
| `somora.web.theme` | Dark, Light or Auto. |
| `somora.web.theme.custom` | The theme of your own in use, with its colours, so it is there before the page has loaded. Not set for somora. |
| `somora.chat.externalImages` | **Always show** for pictures from other websites. Shared with the mobile app. |

## Routes the client uses

The API guide describes each route. These are the ones behind the
controls on this page:

| Route | Used for |
|---|---|
| `GET /agents` | Agent icons |
| `GET /chat/stream` | Live events of one window |
| `POST /chat/send`, `POST /chat/abort` | Send and Stop |
| `DELETE /chat/queue/:id` | ↩ edit and × in the queue |
| `GET /agents/:agent/sessions/:session/work` | Work badge and list, refetched on every queue event and every 3 s while the list is open |
| `PUT /agents/<a>/sessions/<s>/model` | Model switch |
| `GET /agents/:agent/persona`, `PUT /agents/:agent/dreams`, `PUT /agents/:agent/a2a` | Agent window, its dreams and A2A switches |
| `GET /agents/:agent/sessions/:session/export?format=…` | Session export |
| `GET /sessions` | Sessions window |
| `GET /activity/stream` | Status and unread dots |
| `POST /sessions/:agent/:session/seen` | Marks a session as seen |
| `GET /dream-states` | Pulse glow and badges |
| `GET /files/view`, `GET /files/raw` | File windows |
| `POST /attachments` | Uploads |
| `GET /stt/config`, `POST /stt/transcribe` | Microphone |
| `GET /tts/config` | Voice toggle |
| `GET /config/status`, `POST /config/reload`, `POST /server/restart` | Gear menu |
| `GET /version` | Version under the logo |
| `GET /inbox`, `POST /inbox/read`, `POST /inbox/mute`, `POST /inbox/unmute` | Inbox |
| `GET /themes`, `GET /themes/:id/:version/wallpaper` | Your own themes in the screen menu |
| `GET /host-stats` | `cpu` and `mem` |
| `GET /logs`, `GET /logs/since` | Log window |
| `GET /health` | Waiting for the server after a restart |

## SSE event vocabulary

A chat window listens for these events on `/chat/stream`. The stream is
keyed by agent and session, so two agents can both have a `main`
session without seeing each other's events. Field shapes are in the API
guide.

| Event | Payload | Meaning |
|---|---|---|
| `status` | `{msg}` | Connection state. |
| `heartbeat` | none | Keeps the connection alive. |
| `user_message` | `{text, ts, turnId?, origin?, from_agent?, from_session?, from_system?, agent_ask_call_id?}` | A message landed in the session, from any client. `from_system` is one of `sentinel`, `tmux`, `subagent`, `job`, `browser`, `voice`, `a2a`, `system` and is drawn as a divider. `origin` carries the same as one structured value. |
| `turn_queued` | `{turnId, ahead, workId?, kind?}` | A send met a running turn. Drives the `⌛ queued` marker. Sent again when waiters move up. |
| `turn_dequeued` | `{turnId, workId}` | A waiting entry was taken back, from any client. |
| `steer_queued` | `{steerId, text, ts, turnId, origin?}` | A message was steered into the running turn. |
| `turn_started` | `{turnId}` | The turn's id, so later media and errors pair with it. |
| `turn_error` | `{turnId?, message, engine}` | The turn failed. Drawn as the **Turn failed** block. |
| `agent` | `{phase: 'start'\|'end', usage?, provider?, model?, fallback?, ...}` | Turn boundary. On `end`, `provider` and `model` are the model that answered. |
| `model_fallback` | `{requested, actual, reason, hops?}` | A backup model answers this turn. One event per failed model. |
| `session_model` | none | The session's model was switched. The window reads the session info again. |
| `chat` | `{state: 'delta'\|'final', text}` | Assistant text. Each delta carries the full text so far. |
| `thinking` | `{state: 'delta'\|'final', text, truncated?}` | Reasoning text, cumulative like `chat`. |
| `tool` | `{phase: 'call'\|'result'\|'error', tool, summary?, details?, error?}` | A tool call and its outcome. |
| `engine_meta` | `{engine, itemType, label, summary?, payload}` | The engine's own rows, for example the codex `todo_list`. |
| `memory` | `{count, topScore, refs, fullText?}` | Notes recalled for this turn. |
| `project` | `{from, to, via}` | The session's project changed. |
| `assistant_audio` | `{turnId, url, mime, durationMs?, cacheKey}` | A spoken reply for the turn. Drives the Play button. |
| `assistant_media` | `{turnId, media: [{type, id, prompt, mime, filename, url}]}` | Media the turn produced. An unknown `type` is skipped. |

A message you type is echoed as `user_message` to every client on the
session, so the terminal client and a second browser tab show it too.
Your own window does not show it twice.

## Troubleshooting

**New windows stay empty or sending does nothing.** You are on plain
HTTP with more than six connections open. Switch to HTTPS or close
windows.

**No microphone or screenshot button.** The browser offers recording
(`getUserMedia`, `MediaRecorder`) and screen capture
(`getDisplayMedia`) only on HTTPS or on `127.0.0.1`. The microphone also needs speech-to-text
configured.

**Restart is greyed out.** somora does not run as a background
service. Restart it the way you started it, or with
`somora server restart`.

**The page says somora did not come back.** The server did not answer
within 90 seconds after a restart. Check the service and its log.

**The header shows `offline`.** The live connection of that window is
down. It reconnects by itself once the server answers.

**An app icon is missing.** Its feature is not enabled. See the table
under "App icons".

**The context badge reads `▣ >100%`.** The model's `contextWindow` in
`config.yaml` is smaller than what the engine really sent. Raise it.

## Building from source

The client lives in `web/` in the somora repository.

```bash
cd web
npm install
npm run dev
```

The dev server runs on port 5173 under `/web/` and passes API calls on
to the somora server. It serves HTTPS when a certificate for your host
is in `~/.somora/certs/`. Set `SOMORA_TLS_HOST` to name the host.
Without a certificate it falls back to plain HTTP.

```text
web/
├── src/
│   ├── components/     # windows, taskbar, chat
│   ├── hooks/          # window manager, icons, zoom, activity
│   ├── lib/            # api.ts and helpers
│   └── styles/
└── vite.config.ts      # base: '/web/', proxy in dev mode
```

`npm run build` in the repository root builds the client into the
package.

## See also

- [Setup](setup.md): HTTPS via Tailscale, speech-to-text, updates
- [Mobile app](mobile.md): the chat on your phone
- [API](api.md): every route and event the client uses
- [Agents](agents.md): `agent.yaml`, fallback models, steering
- [Models](models.md): context windows and thinking levels
- [Thinking](thinking.md): which engines show their reasoning
- [Sampling](sampling.md): the parameters behind `/sampling`
- [Files](files.md): attachments and the read policy
- [Dream phases](dream-phases.md): REM, Deep and Lucid
- [Voice](voice.md) and [Realtime voice](realtime-voice.md): dictation,
  spoken replies and calls
- [Browser](browser.md): the shared browser and handoffs
- [Image generation](imagegen.md) and [Video generation](videogen.md):
  the media window
- [Wiki](wiki.md): the explorer and what the wiki holds
- [Team](team.md): the org chart
- [Builder](builder.md): the task panel
- [Projects](projects.md): the project chip
- [Sentinel](sentinel.md): triggers
- [tmux](tmux.md): terminal sessions for agents
- [MCP servers](mcp.md) and [Skills](skills.md): the abilities window
