# Web client

A browser-based desktop for somora — multi-window chat with every
agent on your LAN. Same backend as the TUI, just a different head.

## Mental model

```
  ┌─────────────────────────────── browser ─────────────────────────┐
  │  ┌─ agent dock ─┐  ┌── chat: scribe ───┐  ┌── chat: coach ────┐ │
  │  │  scribe ●    │  │ history + stream  │  │ history + stream  │ │
  │  │  coach  ●    │  │ tool blocks       │  │ tool blocks       │ │
  │  │  archi. ◯    │  │ [paperclip] ▢▷▶   │  │ [paperclip] ▢▷▶   │ │
  │  └──────────────┘  └───────────────────┘  └───────────────────┘ │
  │                                                                 │
  │  taskbar: [scribe] [coach]  ▢ auto-arrange  💾 save layout      │
  └─────────────────────────────────────────────────────────────────┘
                              │ HTTP + SSE
                              ▼
                    somora server :18737
```

Each chat window is a `ChatProvider`-managed React subtree subscribing
to one SSE stream keyed by `agent::session`. Multiple windows for the
same agent share state — open an agent's `main` session twice and both
windows render the same live transcript.

## Access

The somora server mounts the production bundle at `/web/*`. **HTTPS is
a hard requirement once you open more than one chat window** — see
"Why HTTPS is required" below. The blessed path is Tailscale, which
hands out free Let's Encrypt certs for your tailnet's hostnames.

```
https://<your-host>.<your-tailnet>.ts.net:18737/web/
```

For full Tailscale + cert setup steps see [setup.md](setup.md#https-tailscale--required-for-the-web-client-at-scale).
Short version:

```bash
# in the Tailscale admin: enable MagicDNS + HTTPS Certificates (one-time)
mkdir -p ~/.somora/certs && cd ~/.somora/certs
tailscale cert <your-host>.<your-tailnet>.ts.net   # use your own FQDN
```

Add to `~/.somora/config.yaml`:

```yaml
server:
  port: 18737
  tls:
    cert: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.crt
    key:  ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.key
    publicHost: <your-host>.<your-tailnet>.ts.net
```

Then `systemctl --user restart somora` (or however you launch it).

By default the server binds `127.0.0.1`. To reach it across the
tailnet/LAN, set `SOMORA_HOST=0.0.0.0`:

```bash
# ~/.config/systemd/user/somora.env
SOMORA_HOST=0.0.0.0
```

**There is no auth** — same trust model as the API server. Tailnet-only
by design (everyone with a Tailscale node on your tailnet can reach it,
no public exposure).

For development:

```bash
cd web
npm install
npm run dev
# vite reads ~/.somora/certs automatically and serves
# https://<host>.<tailnet>.ts.net:5173/web/  (HTTP/2)
# proxies /agents /chat /dream /tools /tui-config /health to the
# https somora server
```

If `~/.somora/certs/<host>.{crt,key}` aren't present (`SOMORA_TLS_HOST`
overrides the host name), Vite falls back to plain HTTP/1.1 — works for
one-window debugging, hits the 6-connection wall fast otherwise.

## Why HTTPS is required

Browsers cap **HTTP/1.1** at 6 concurrent connections per origin. Each
chat window holds one persistent SSE stream — so 6 windows max before
new tabs silently fail to send and agents look unresponsive. Tmux
session attaches and any xterm.js/WebSocket panels eat connections
from the same pool.

HTTP/2-over-TLS multiplexes every stream over **one** TCP connection.
The 6-limit becomes effectively unlimited, end of problem.

Plus the secure-context bonus that the roadmap leans on — `getUserMedia`
(mic), `getDisplayMedia` (screenshare), Clipboard async, Service Workers
(offline + push notifications), Web Push: all require HTTPS. You can
build a chat app over plain HTTP, but you can't add voice or push
without it.

## Window manager

- **Desktop icons**: one tile per agent from `/agents` plus the app
  tiles, laid out on a grid that spans the whole desktop. Fresh
  install = the classic left column; from there **drag any icon to
  any cell** (dropping on an occupied cell swaps the two), or move the
  focused icon with `Alt+Arrow`. The arrangement is stored per browser
  in `localStorage` (`somora-desktop-icons`); a narrower window
  relocates icons that no longer fit, widening restores them. Icons sit
  *below* windows like on a real desktop. Click an agent tile to open
  its chat window; clicking again focuses the existing window.
  **Right-click** an agent tile for its menu: *Open main*, the three
  most recently active other sessions (click one to open it in its
  own window), *New session…* (type a name — letters, digits, `-`,
  `_`; the field tells you what's wrong while you type — Enter creates
  it and opens a new window, Esc cancels), and *All sessions…* (the
  Sessions tool). This is the place agent-wide actions will collect;
  per-chat settings stay in the chat's `•••` menu.
  Each agent tile carries up to three live signals:
  - **Status dot** (bottom-right of the icon): green = idle,
    amber = streaming, violet = holds the dream review loop, grey =
    offline.
  - **Pulse glow** around the icon when a dream phase is running for
    this agent: green = REM (per-agent session→memory extraction),
    indigo = Deep (server-wide consolidation, every participating
    agent pulses), violet = Lucid (review-loop holder). Polled every
    30 s from `GET /dream-states`. See
    [dream-phases.md](dream-phases.md) for what each phase does.
  - **REM badge** (top-right of the icon) when the agent has REM
    extractions waiting for review: a small green counter (`1`, `2`,
    `9+`). The badge clears as you work through findings via
    `dream_apply` / `dream_dismiss`.
- **App tiles**: non-agent surfaces — `tmux`
  (attach to an existing tmux session), `terminal` (fresh shell in
  the somora workspace), `sessions` (cross-agent session browser
  — see next section), and `abilities` (per-agent visibility matrix

> A toggle takes effect on the agent's next turn on every engine. On codex-cli the Codex thread is restarted with the session history carried over (a `tools changed` marker appears in the chat), because Codex keeps a thread's tool set for its lifetime.
  for tools and skills plus external MCP server health — see
  [mcp.md](mcp.md) and [skills.md](skills.md)). The `wiki`
  tile carries a violet **Lucid badge** when completed lucid runs are
  waiting for review — lucid is platform-wide wiki cleanup, so its
  review backlog lives here rather than on any single agent. The
  badge counts pending findings; the tooltip names the oldest waiting
  run. Review with any agent via `dream_review`.
- **Window**: drag the title bar to move, drag the bottom-right
  corner to resize. Close button removes the window without
  unsubscribing other clients.
- **Windows never leave the desktop.** Dragging and resizing stop at
  the edges (a window may hang off the right edge while you drag it,
  but its title bar and body never go under the taskbar). When the
  *browser* gets smaller — you move it from an external display to
  the laptop screen, or a saved layout comes back on a smaller
  screen — every window that no longer fits is pushed back inside
  and, only if it is bigger than the desktop itself, shrunk to fit.
  Nothing is rearranged and nothing grows back when the browser gets
  bigger again: use **Save/Restore layout** in the taskbar for that.

## Taskbar gear: reload config, restart

The gear left of **Arrange** opens a small server menu:

- **Reload config** re-reads `~/.somora/config.yaml`, validates it and
  swaps it in without a restart. A typo leaves the running config
  untouched; the toast shows the schema error with field and message.
  On success the toast lists the changed sections and, when one of
  them only applies at boot (server, memory, mcp, voice, wiki
  schedulers, …), says so. The menu marks *changed on disk* when the
  file is newer than what the server loaded.
- **Restart somora** asks systemd to restart the user unit. Every open
  stream drops for a few seconds; the page polls `/health` and reloads
  itself once the new process answers. Greyed out when somora is not
  running as `somora.service`.

`agent.yaml` needs neither: it is read on every turn. The TUI has the
same two actions as `/reload` and `/restart YES`.
- **Taskbar (bottom)**: lists open windows and always stays on top —
  no window can cover it, so **Arrange** (tile all windows across the
  desktop) is always reachable. Save/restore persists positions in
  `localStorage`.

Layout state is per-browser-profile. There's no server-side window
manager — each device remembers its own arrangement.

## Sessions tool

A cross-agent session browser launched from the `sessions` tile in
the app dock. The single window where you keep order across the
hundreds of sessions somora accumulates over weeks.

```
 ┌───────────────────────────── Sessions ──────────────────────────────┐
 │ 172 total · 1 live · 28 archived · 94 dreamed · 50 partial   [⟳]   │
 │ [Active] [Archived] [All]                                            │
 │ search: ____   agent: nova luna  engine: codex-cli  REM: partial    │
 │ ─────────────────────────────────────────────────────────────────── │
 │ ☐  Agent  Slug             Engine     Status  Last act.  Msgs  Size │
 │ ☐  nova   main ★           codex-cli  ●★      5 min ago  46    280k │
 │ ☐  luna   debug-auth-x     claude-cli         3h ago     12    22k  │
 │ ☑  nova   sub-self-477…    openai-c.          yesterday  2     35k  │
 │ ...                                                                  │
 │ [2 selected] [Archive selected] [Clear]                              │
 └─────────────────────────────────────────────────────────────────────┘
```

**What it shows per row:**

| Column | Meaning |
|---|---|
| Agent | Persona name, coloured with the agent's `color` from `AGENTS.md` frontmatter |
| Slug | Session slug — `★` marks the magic `main` session |
| Engine | `claude-cli` / `codex-cli` / `openai-compatible` (last engine that touched it) |
| Status | `●` (green) = at least one SSE subscriber is live on this session right now · `📦` = archived · `★` = main |
| Last activity | Human-readable relative time (`5 min ago`, `yesterday`, `3w ago`) |
| Msgs | `user_message` + `assistant_message` count |
| Size | Bytes on disk for the JSONL |
| REM | `🧠 ✓` (green) = REM dreamed up to the latest event · `🧠 ⚠N` (orange) = REM ran once but `N` new events have arrived since · `🧠 ○` (grey) = never dreamed |

**About the REM column.** REM is the per-agent background phase that turns
finished session content into memory candidates (see
[dream-phases.md](dream-phases.md)). The column tells you, per session, how
much of its history REM has already processed:

- **`🧠 ✓` (dreamed).** REM has worked through every event in this session.
  Nothing waiting.
- **`🧠 ⚠N` (partial).** REM ran at some point — but you've chatted further
  since. The number is how many user/assistant events have piled up beyond
  REM's last read-through marker. They'll be picked up on the next idle-
  triggered REM run for this agent.
- **`🧠 ○` (never).** No REM run has touched this session yet. Common for
  brand-new sessions, sub-agent spawns that finished quickly, or sessions
  on agents where REM is disabled in `agent.yaml`.

The lag count is informational — you don't have to do anything about it. If
you want to nudge a session, end it (`/reset`) and REM will fire on the
archived copy at the next idle window.

**Tabs:**

- **Active** — non-archived sessions (default). Same set the `/session` slash-popup sees.
- **Archived** — sessions explicitly archived OR legacy `/reset` outputs (ids ending in `-archive`).
- **All** — both.

**Filters + sort:** agent (multi-select chip group), engine, REM-state (`dreamed` / `partial` / `never`), plus a free-text search across slug / agent / id. Column headers sort by last-activity / messages / size / agent (click to toggle direction).

**Click a row** (outside the checkbox / action buttons) → opens a chat window for that (agent, session). Same `wm.openChat()` path the agent dock uses.

**Archive / Unarchive:** the right-edge action button on each row archives (or unarchives in the Archived tab). Bulk-select with the checkboxes and the bulk-action bar archives multiple at once. The magic `main` session can't be archived directly — use `/reset` to spawn an archived copy.

**Export:** two download icons sit next to the archive button on every row — a file-text icon downloads a **Markdown transcript** (readable, with `##` user/assistant headers, fenced code blocks for tool calls, and engine plan items as task lists), a file-json icon downloads the raw **JSONL** (byte-identical to the on-disk source, full fidelity). Markdown is great for sharing or saving into Obsidian; JSONL is the canonical backup you'd drop on another somora host. Both work for archived sessions too. Backend route: `GET /agents/:agent/sessions/:session/export?format=…` (see [api.md](api.md)).

**Reload:** manual reload icon top-right, plus a 60-second auto-refresh toggle (default on). Stats are cached in each session's `<id>.meta.json` and invalidated by JSONL mtime, so reloads stay cheap.

**Archive semantics (DECISION):** archive is **meta-flag based**, no file movement. `meta.archived = true` (with `archivedAt` + optional `archiveReason`) is the source of truth. The `<id>.jsonl` and `<id>.meta.json` files stay where they are. Default-filtering at `listSessions()` keeps archives out of the slash-popup, chat-window session picker, and the Active tab — they only surface in the Sessions tool. No hard-delete option, on purpose: archive is fully reversible, and you can always clean up `~/.somora/agents/<agent>/sessions/` by hand if you really want bytes gone.

**Why this exists:** sessions accumulate fast (REM idle-trigger, sub-agent spawns, `/reset` archives, debugging sessions). Without a place to see everything at once, slash-popups grow until they're useless and you can't tell which old sessions are still worth keeping. The Sessions tool is the housekeeping surface — search, filter, archive, see at a glance which sessions have unconsolidated memory waiting for REM.

## Chat window anatomy

```
 ┌──────────────────────────────────────────────────────┐
 │ 🧠  scribe  · assistant             ● streaming     │ ← header
 │ main · opus · think:medium · 🔧 on · ↑12k ↓4k · ●    │ ← live meta
 ├──────────────────────────────────────────────────────┤
 │  [user]   summarize today's notes                    │
 │                                                       │
 │  [tool]   memory_search "today notes"                │ ← above
 │  [tool]   → notes/2026-05-10 · 0.71                  │
 │  [scribe] You spent the morning on the cache fix...  │ ← below
 │  ▮                                                   │
 ├──────────────────────────────────────────────────────┤
 │  📎  Type a message…                            ▷    │ ← input
 └──────────────────────────────────────────────────────┘
```

- **Header**: agent name, role badge from `AGENTS.md`, streaming pill.
- **Meta line (10px mono)**: session id, model, thinking level, tools
  toggle, ↑/↓ token counts, connection dot. When the last turn was
  answered by the persona's `fallback:` model, a warn-coloured
  `⇄ <backup-model>` marker sits next to the model (tooltip: why the
  primary failed).
- **Chat text zoom** (⊖ / ⊕ in the header, left of the project chip):
  75–200 % in discrete steps, **per agent** — one conversation can be
  enlarged without touching other agents, the window chrome or the
  desktop. The percentage readout appears only off-default and doubles
  as the reset. Persisted per browser (`somora-chat-zoom`).
- **Fallback marker on bubbles**: an assistant turn produced by the
  fallback model carries a `⇄ fallback · <model>` chip (hover for the
  primary's failure reason). It survives reloads — the server persists
  a `model_fallback` event in the session history. A short notice
  appears once at the start of a fallback streak and once more when
  the primary model answers again; turns in between get the chip only.
- **Body**: pinned-to-bottom auto-scroll. Manually scroll up to read
  history; new messages won't yank you down. Scroll back to the
  bottom to re-pin.
- **Tool-rendering toggle** (wrench in the meta line): show or hide
  tool-call / tool-result blocks AND `engine_meta` rows (codex's
  internal plan/todo state — see [setup.md](setup.md#engine-meta--codex-todo_list)).
  Persists per `agent::session` in `localStorage` — a reload restores
  your choice. Tools render **above** the agent's answer for a given
  turn (TUI-style ordering) — the assistant bubble is a single message
  that re-anchors to the bottom of the transcript whenever a tool event
  lands, so cumulative text never duplicates around tool boundaries.
  Engine-meta blocks render dimmer than tool calls and prefix with
  `◌ codex · plan` so it's visually clear they came from the engine,
  not from somora's tool layer.
- **Input**: auto-grow textarea up to 120px, then internal scroll.
  Enter sends, Shift+Enter newline. The textarea stays editable
  while a turn is streaming — pressing Send during a running turn
  enqueues the message rather than blocking it (see "Queueing &
  Stop" below).
- **Stop buttons** (two, same abort): while a turn is in flight a
  red Stop appears **in the composer next to Send** and on the
  **streaming assistant bubble** (in the slot where copy/pin sit on
  finished bubbles). Send stays live the whole time, so queued sends
  keep working from the button — Stop is additive, it never replaces
  Send. One click aborts the current turn server-side via
  `POST /chat/abort`; if there was nothing to stop (turn just
  finished) or the abort fails, a notice says so instead of silently
  doing nothing.
- **Mic button** (next to send, when STT is configured): click-to-toggle
  voice input. Click once to start recording — the icon switches to a
  red stop-square and `MediaRecorder` captures from the default mic.
  Click again to stop; the audio blob is POSTed to `/stt/transcribe`,
  somora forwards it to the configured upstream (e.g. oMLX Whisper),
  and the returned transcript is appended to the textarea — your
  existing draft is preserved, voice gets added with a separating
  space. Hidden when the browser lacks `MediaRecorder` /
  `getUserMedia` (capability gate identical to the screenshot
  button), or when somora's `/stt/config` reports STT disabled.
  Configuration in [setup.md §7](setup.md#7-voice--stt--tts-optional).
- **Voice replies** (when TTS is configured): the chat header shows a
  `🔊`/`🔇` toggle. When on, mic-submitted turns trigger automatic
  TTS playback of the assistant reply (text replies are unaffected).
  Toggle is sticky per `<agent>:<session>`. A Play-button appears on
  bubbles that have generated audio so you can replay any time. Full
  details in [voice.md](voice.md).

Markdown is rendered via `react-markdown` + `remark-gfm` +
`rehype-highlight`. Code blocks scroll horizontally inside the
75%-width bubble; tables overflow-scroll independently.

### Session actions menu (`•••`)

The three-dots button in the chat header opens a popover anchored to
that button — same screen position every time, escapes the chat
window via a portal so it can't be clipped. Three sections:

- **MODEL** — current model + engine + context window. "Switch
  model…" expands an inline picker with a free-text filter; clicking
  a model commits a per-session override (`PUT /agents/<a>/sessions/
  <s>/model`). Same flow as the `/model` slash command.
- **THINKING** — current effective level and its source (session
  override / persona default / engine default). A segmented control
  (off / low / medium / high) sets a session override; "Reset to
  default" removes the override and falls back to persona / engine
  default.
- **DANGER ZONE — Reset session** — archives the current chat (the
  jsonl is kept as `<id>-archive`) and starts a fresh session. If the
  agent has REM enabled in `agent.yaml`, REM fires asynchronously
  over the archived range to extract memory candidates. Two-click
  confirm so it can't trigger by accident.

Close the menu by clicking the `•••` button again, clicking anywhere
outside the popover, or pressing `Escape`.

### Bubble actions: copy and pin

Hover any finished assistant bubble and two small icons appear in the
top-right corner. They show up only once the message has finished
streaming — partial content can't be copied or pinned. The buttons
sit inside the bubble so they travel with their message as you scroll
and don't clutter the chat header.

- **Copy** writes the bubble's raw markdown to the clipboard. The
  icon swaps to a check glyph for ~1.5 s as a confirmation cue, then
  reverts. Pasting elsewhere preserves headings, lists, code blocks,
  tables — anything markdown carries.
- **Pin** opens a free-floating pin-note window with a snapshot of
  that message (see below). The pin icon turns yellow + filled and
  stays visible even without hover, so pinned messages stand out
  while you scroll the history.

Clicking an active pin again closes its pin-note window. Closing the
pin-note window via its `×` does the same thing — the two affordances
stay in sync.

### Pin-note windows

A pin-note is a small free-floating window that captures one
assistant message for working memory. Use it when an answer is
important to refer back to while the conversation continues — a
recipe, a config snippet, a decision summary.

Layout:

```
 ┌──────────────────────────────────────┐
 │ 📌 nova note                  × ─ ⤢ │ ← yellow titlebar tint
 ├──────────────────────────────────────┤
 │ 🤖 nova · main             14:08    │ ← agent + source + when said
 ├──────────────────────────────────────┤
 │                                      │
 │ rendered markdown body, scrollable,  │ ← same renderer as the chat
 │ selectable…                          │
 │                                      │
 ├──────────────────────────────────────┤
 │ 📌 pinned 3 min ago                   │ ← when the pin itself was made
 └──────────────────────────────────────┘
```

Behaviour:

- **Free-floating.** Drag the titlebar to move, drag the bottom-right
  corner to resize, same as any other window. Pin-notes have their
  own z-stack so you can leave one over a chat while continuing the
  conversation.
- **Yellow titlebar tint** distinguishes them at a glance from chat,
  tmux, and sessions windows.
- **Snapshot semantics.** The content is frozen at pin time. If the
  agent continues streaming additions to the same turn, the pin
  doesn't update — re-pin to capture the new state.
- **Multiple in parallel.** Pin as many messages as you like; each
  gets its own window. Re-pinning the same message focuses the
  existing note instead of duplicating.
- **Survives reloads.** Pin-notes live in the window-manager's
  `localStorage` layout, so a browser refresh restores them.
- **Survives the source.** Even if the original session is archived
  or the chat window is closed, the pin-note keeps its content. The
  header still shows the source agent and session label so you can
  retrace where the message came from.

Closing a pin-note (`×` button on the window, or click the active
pin button on the source bubble) just removes the note window — the
original message stays in chat history.

## Queueing & Stop

You don't have to wait for a turn to finish before typing the next
one. Submits during a running turn flow into the per-session queue
on the server (see [api.md](api.md#queuing)) and execute in order
once the lock frees.

The optimistic user-bubble shows up immediately with a small
hourglass marker next to its timestamp:

```
 ┌──────────────────────────────────────┐
 │  next thing I want to ask            │
 │                       ⌛ queued · 14:08 │
 └──────────────────────────────────────┘
```

When other waiters sit in front, the marker reads
`⌛ queued · N ahead`. The marker disappears as soon as the server
starts the turn — at that point the bubble looks like any other
finished user message, and the assistant's reply streams in below it.

While the marker is showing, the message is still yours: the small
**↩ edit** next to it takes the message back out of the queue and
into the composer (`DELETE /chat/queue/:turnId`), attachments
included, so you can add the thing you forgot and send again. The
re-sent message joins the end of the queue. If the turn started in
the meantime the bubble just loses its marker and a notice says so —
Stop is the handle from then on.

Aborting (Stop button on the streaming bubble) cancels the
**currently-running** turn only. Queued waiters keep their slots and
run in order.

## Failed turns

A turn that ends in an error (engine 5xx, watchdog, abort) renders as
a red **Turn failed** block inside the turn, right where it happened.
Media the turn produced before failing (a generated picture, say)
hangs under that block — not under the previous answer. The block
comes from the `turn_error` SSE event live and from the session
file's `error` rows on reload.

## Activity feed (multi-agent dots + unread)

The agent dock and the Sessions tool both show two passive indicators
that come from a single app-wide SSE on `/activity/stream`:

- **Streaming dot** — fills on every agent whose any session is mid-
  turn, not just agents whose chat window you currently have open.
  When a sentinel job wakes a different agent in the background or a
  peer-agent message kicks off an A2A reply, that agent's dock tile
  goes busy even if its window is closed.
- **Unread dot** — appears (different colour from streaming) when a
  session has activity since you last viewed it. Counts: A2A
  inbounds, sentinel-triggered messages, and assistant final replies.
  Self-typed messages and tool/memory side-effects do not count.

A session is "viewed" when its chat window is open and focused. The
client POSTs `/sessions/:agent/:session/seen` on focus and the server
broadcasts the cleared state — open the chat on the TUI or mobile and
the badge here disappears too. Per-session badges also show in the
Sessions tool's session list.

State persists across server restarts: `unreadAt` and `seenAt` live in
each session's meta. Endpoint docs: see [api.md](api.md#get-activitystream).

## Cross-client echo

When you type a message in a Web window, the somora server echoes a
`user_message` SSE event to **every** subscriber of that
`agent::session`. The TUI tail will show what you typed in the web,
and a second web tab on the same chat will show it too. Self-echoes
are deduped against the optimistic local-user message via a pending
list, so you never see the same text twice.

This is a behavioural change in `2026.05.10.1`: prior versions only
echoed `user_message` for A2A (agent-to-agent) turns. Now it fires
for self-typed turns too.

## SSE event vocabulary

The web client listens for these named events on `/chat/stream`:

| Event | Payload | Meaning |
|---|---|---|
| `status` | `{msg}` | Connection state — initial `connected`, periodic keepalive |
| `user_message` | `{text, ts, turnId?, from_agent?, from_system?, agent_ask_call_id?}` | A user-typed message landed in the session (any client). `turnId` pairs the event with an optimistic bubble made by `POST /chat/send`. `from_system: 'sentinel'` marks a system-trigger inbound. |
| `turn_queued` | `{turnId, ahead}` | Fired when a send hit a busy lock. `ahead` ≥ 1 includes the currently-running turn. Drives the `⌛ queued` marker. Re-emitted for the waiters that move up after a dequeue. |
| `turn_dequeued` | `{turnId}` | A queued message was taken back (↩ edit, from any client). The bubble is dropped. |
| `turn_started` | `{turnId}` | The engine's own turn id — stamped on the assistant bubble so `assistant_media` / `turn_error` pair to this turn. |
| `turn_error` | `{turnId?, message, engine}` | The turn failed. Rendered as the **Turn failed** block inside the turn. |
| `agent` | `{phase: 'start'\|'end', usage?, provider?, model?, fallback?, ...}` | Turn boundary. On `end`, `provider`/`model` are the model that ACTUALLY answered; `fallback` `{requested, actual, reason}` is set when that was the persona's fallback. |
| `model_fallback` | `{requested, actual, reason}` | The primary model failed before producing anything; the fallback model is answering this turn. Precedes its first `chat` delta. |
| `chat` | `{state: 'delta'\|'final', text}` | Cumulative assistant text (each delta carries the full running text, not just the new chunk) |
| `tool` | `{phase: 'call'\|'result'\|'error', tool, summary?, details?, error?}` | Tool invocation lifecycle |
| `engine_meta` | `{engine, itemType, label, summary?, payload}` | Engine-internal side-channel (e.g. codex `todo_list`). Renders under the tools toggle. |
| `memory` | `{count, topScore, refs, fullText?}` | Memory auto-inject for this turn |
| `project` | `{from, to, via}` | Project focus change — fired by `/projekt` slash + HTTP routes. MCP-routed agent tool calls don't emit this; clients re-GET `/…/project` on `agent:end` instead. Only fires when the projects feature is enabled. |
| `assistant_audio` | `{turnId, url, mime, durationMs?, cacheKey}` | Server-generated TTS artifact for the matching turn. Pairs by `turnId`; drives the Play-button on the bubble. |
| `assistant_media` | `{turnId, media: [{type, id, prompt, mime, filename, url}]}` | Media produced while the turn ran. Pairs by `turnId` and renders under the bubble. Published by the server after the turn finalizes — the agent doesn't have to attach anything. Each entry's `type` decides the renderer; an unknown type is skipped rather than guessed at. See [imagegen.md](imagegen.md). |

The server pubsub key is `${agent}::${session}` — multiple agents can
share a session id like `main` without leaking events across windows.

## FileView

Agents reference files by absolute path in chat (`[report.md](/home/…)`),
and the web client's Markdown renderer turns those into links that open
a FileView window. Nothing is refused for being the wrong type any more:
what the viewer cannot render, it describes.

| The file is | You get |
|---|---|
| Markdown | full render, same plugins as chat |
| Text / code | monospace, syntax highlighting for the known extensions |
| Image | inline, click for full size |
| Video | `<video controls>`, seeking served by Range requests |
| Audio | `<audio controls>` |
| PDF | the browser's own viewer |
| anything else | name, type, size — and a download |

**A download button is present for every file type**, including the ones
that render inline.

The classification comes from the file's magic bytes, not its
extension: a `.dat` holding PNG bytes is shown as the image it is, and a
`.png` that is really a JPEG is served with the type it really has.
`.svg` is the deliberate exception — it is markup that can carry script,
so it is shown as its own source rather than rendered.

Bytes come from `GET /files/raw`, which streams and honours `Range`;
without that, scrubbing a video would re-fetch the whole file. Inline
display is limited to image/video/audio/PDF, because anything else shown
inline would run on somora's own origin.

The boundary is the read policy, not the workspace: a file under
`/tmp/` is viewable, a file under a blocked root is not — the same
answer `file_read` gives an agent. See [api.md](api.md#get-filesview).

## Features

- **Chat windows** — one per `(agent, session)`, live SSE streaming,
  full history hydration on open, per-window tool/memory toggles,
  cross-client echo (multiple windows on the same session stay in
  sync), window manager with persistence (positions/sizes survive
  reload).
- **Windows never leave the desktop** — shrinking the browser pushes
  every window back inside and shrinks only what no longer fits; the
  taskbar (with Arrange, Save/Restore layout) always stays on top. See
  the window-manager section above.
- **Agent context menu** — right-click an agent tile: open main, jump
  to one of its recent sessions, start a named new session in its own
  window, or open the Sessions tool.
- **Queued messages are editable** — a message waiting behind a running
  turn shows ⌛ and an *edit* link that takes it back into the composer;
  a turn that fails renders as a *Turn failed* block inside the turn,
  with any media it produced under it.
- **Abilities window** — per-agent matrix for tools *and* skills, plus
  external MCP server health. See [mcp.md](mcp.md#the-abilities-window)
  and [skills.md](skills.md#per-agent-visibility).
- **Drag & drop / paste / paperclip attachments.**
  Per-turn user-attachments end-to-end through all three engines:
  claude-cli inlines as native ImageBlock / DocumentBlock;
  codex-cli sends images as native turn inputs and rasterises PDFs to
  per-page PNGs; openai-compatible builds an array-content user
  message (`image_url` for images, `file` or rasterised pages for
  PDFs depending on `pdfMode`). Bytes live content-addressed at
  `~/.somora/attachments/<sha256>.<ext>`; JSONL refs only, never
  inline. See `docs/files.md` (and config block below) for the
  Server side; the client surface is paperclip + Cmd/Ctrl+V paste
  + drag&drop overlay + a per-bubble thumbnail row. Capability
  gate refuses uploads for models without `image`/`pdf` capability
  with a clear nudge to `/model`. Switching an existing session to a
  text-only model afterwards keeps working: the history is packed for
  the model that will read it, so past attachments it cannot process
  are replayed as a text marker naming the file instead of being
  re-sent and rejected. See `files.md`.
- **Older-messages lazy-load**. Initial history load is paginated
  to the last 100 events; scrolling near the top auto-fetches the
  next 100, anchoring the visible position so you stay where you
  were reading. There's also an explicit "↑ load older" button
  for clarity.

- **Memory-inject banner** — per-turn `🧠 memory · N hits · refs…` line
  in the chat flow, mirrors the TUI's `◇ memory · …` row. Brain icon in
  the meta-line toggles visibility; chevron expands the full injected
  text. Persists per `agent::session` like the tools toggle.
- **Slash-command popup** — type `/` in the input to bring up a
  command picker:
  - `/model <ref>` — switch model for this session (autocompletes from
    `/models`).
  - `/session <slug>` — switch the window to another session of this
    agent (in-place, the SSE re-subscribes).
  - `/new <slug>` — create a new session and switch this window to it.
  - `/thinking <off|low|medium|high|default>` — set / clear the
    thinking-effort override.
  - `/sampling [key=value …|default]` and `/temp <n>|default` — sampling
    parameters for this session (openai-compatible engine), see
    [sampling.md](sampling.md).
  - `/verbose thinking on|off` — show or hide the 🧠 thinking block
    above replies in this session (display only; same switch as the
    checkbox in the ••• session menu).
  - `/projekt <slug>` (alias `/project`) — pin a project to this
    session. Autocompletes from `/projects` with entity + path-count
    detail per row. `/projekt unlink` is always the first row so
    clearing the pin doesn't require waiting for the list to load.
    Only present when the projects feature is enabled in `config.yaml`.

  Arrow-keys navigate, Enter or Tab accepts, Escape dismisses. Note:
  `/agent` is intentionally *not* a slash-command — the agent dock on
  the left is the agent switcher, switching agent inside an existing
  window would mean discarding the window's identity. `/skill` is also
  out, because skills are activated by the agent itself via the `skill`
  tool, not by user-facing CLI shortcuts.
- **Tmux session windows** — attach to a running tmux session in its
  own window via xterm.js + a WebSocket bridge. Sessions you started
  in the terminal show up in the AppDock; output streams live and
  keystrokes go straight through.
- **Sessions tool** — cross-agent session browser in the AppDock with
  filter (agent, engine, REM state), sort, search, click-to-chat,
  bulk archive/unarchive, and 60s auto-refresh. Archive is a meta-flag
  (no file movement, no hard delete) so archived sessions stay
  inspectable and can be restored. When the projects feature is on,
  the table also has a Project column with color-coded chips per row.
- **Wiki explorer** (opt-in, read-only) — a dock tile that opens the
  shared wiki in three columns: folder tree, rendered page, link graph
  plus backlinks. Obsidian `[[wikilinks]]` are clickable and navigate
  in place; targets that match no page render as broken rather than
  silently disappearing, so gaps in the wiki stay visible. The graph
  toggles between the current page's neighbourhood and the whole wiki,
  and clicking a node opens that page. The tile only appears when
  `wiki.enabled` and `obsidian.vault` are both set — the same gate the
  server applies to the routes. Nothing here writes: the wiki is owned
  by Deep/Lucid, and a viewer that could also edit would race them.
  See [wiki.md](wiki.md#web-explorer).
- **Project chip + switcher** (opt-in) — when `projects.enabled` is
  on, the chat-window header gains a chip next to the ••• action
  button. Color-pill with project name when pinned; ghost folder
  button when unpinned. Click opens a switcher popover with all
  configured projects grouped by entity + a search field. Cross-
  client live update via SSE: pin via `/projekt` in the TUI, the
  open web window updates within 100 ms. See
  [projects.md](projects.md) for the feature model.

## Files of interest

```
web/
├── src/
│   ├── components/
│   │   ├── ChatProvider.tsx     ← global per-session state + SSE multiplexer
│   │   ├── Desktop.tsx          ← window manager host
│   │   ├── Window.tsx           ← drag/resize chrome
│   │   ├── ChatWindow.tsx       ← header + body + input
│   │   ├── MessageItem.tsx      ← per-message renderer (user/agent/tool)
│   │   ├── DesktopIcons.tsx     ← icon grid: drag/swap/keyboard placement
│   │   ├── AgentTile.tsx        ← one agent tile (status dot, pulse, badge)
│   │   ├── AppTile.tsx          ← one app tile
│   │   ├── WikiWindow.tsx       ← wiki explorer: tree + reader + links
│   │   ├── WikiGraph.tsx        ← d3-force layout, plain-SVG rendering
│   │   └── Taskbar.tsx          ← bottom bar + layout actions
│   ├── hooks/
│   │   ├── useAgents.ts         ← /agents poll
│   │   ├── useSessionInfo.ts    ← /tui-config + per-session model/thinking
│   │   ├── useLoopState.ts      ← /dream/review-state poll
│   │   └── useWindowManager.ts  ← layout state + localStorage persistence
│   ├── lib/
│   │   ├── api.ts               ← typed wrappers around /agents, /chat/*, etc.
│   │   └── colors.ts            ← per-agent gradient + role-tint resolver
│   └── styles/
│       ├── desktop.css          ← click-dummy CSS, ported verbatim
│       ├── globals.css          ← Tailwind + targeted overrides
│       └── tokens.css           ← CSS variables (theme)
└── vite.config.ts               ← base: '/web/', proxy in dev mode
```
