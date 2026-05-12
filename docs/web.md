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
same agent share state — open Hans's `main` session twice and both
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

- **Agent dock (left edge)**: one tile per agent from `/agents`. Click
  opens a chat window; clicking again focuses the existing window.
  Each tile carries up to three live signals:
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
- **App dock (below the agent dock)**: non-agent surfaces — `tmux`
  (attach to an existing tmux session), `terminal` (fresh shell in
  the somora workspace), and `sessions` (cross-agent session browser
  — see next section).
- **Window**: drag the title bar to move, drag the bottom-right
  corner to resize. Close button removes the window without
  unsubscribing other clients.
- **Taskbar (bottom)**: lists open windows. Auto-arrange tiles them
  across the desktop; save/restore persists positions in
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
 │ search: ____   agent: hans lisa  engine: codex-cli  REM: partial    │
 │ ─────────────────────────────────────────────────────────────────── │
 │ ☐  Agent  Slug             Engine     Status  Last act.  Msgs  Size │
 │ ☐  hans   main ★           codex-cli  ●★      5 min ago  46    280k │
 │ ☐  lisa   debug-auth-x     claude-cli         3h ago     12    22k  │
 │ ☑  hans   sub-self-477…    openai-c.          yesterday  2     35k  │
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
  toggle, ↑/↓ token counts, connection dot.
- **Body**: pinned-to-bottom auto-scroll. Manually scroll up to read
  history; new messages won't yank you down. Scroll back to the
  bottom to re-pin.
- **Tool-rendering toggle** (wrench in the meta line): show or hide
  tool-call / tool-result blocks. Persists per `agent::session` in
  `localStorage` — a reload restores your choice. Tools render
  **above** the agent's answer for a given turn (TUI-style ordering)
  — the assistant bubble is a single message that re-anchors to the
  bottom of the transcript whenever a tool event lands, so cumulative
  text never duplicates around tool boundaries.
- **Input**: auto-grow textarea up to 120px, then internal scroll.
  Enter sends, Shift+Enter newline. The disabled-during-streaming
  flag refocuses the field automatically when the response ends, so
  you can keep typing without an extra click.
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
  Configuration in [setup.md §7](setup.md#7-speech-to-text-optional).

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
 │ 📌 hans note                  × ─ ⤢ │ ← yellow titlebar tint
 ├──────────────────────────────────────┤
 │ 🤖 hans · main             14:08    │ ← agent + source + when said
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
| `user_message` | `{text, ts, from_agent?}` | A user-typed message landed in the session (any client) |
| `agent` | `{phase: 'start'\|'end', usage?, model?, ...}` | Turn boundary |
| `chat` | `{state: 'delta'\|'final', text}` | Cumulative assistant text (each delta carries the full running text, not just the new chunk) |
| `tool` | `{phase: 'call'\|'result'\|'error', tool, summary?, details?, error?}` | Tool invocation lifecycle |
| `memory` | `{count, topScore, refs, fullText?}` | Memory auto-inject for this turn |

The server pubsub key is `${agent}::${session}` — multiple agents can
share a session id like `main` without leaking events across windows.

## Features

- **Chat windows** — one per `(agent, session)`, live SSE streaming,
  full history hydration on open, per-window tool/memory toggles,
  cross-client echo (multiple windows on the same session stay in
  sync), window manager with persistence (positions/sizes survive
  reload).
- **Drag & drop / paste / paperclip attachments.**
  Per-turn user-attachments end-to-end through all three engines:
  claude-cli inlines as native ImageBlock / DocumentBlock;
  codex-cli pipes images through `--image` and rasterises PDFs to
  per-page PNGs; openai-compatible builds an array-content user
  message (`image_url` for images, `file` or rasterised pages for
  PDFs depending on `pdfMode`). Bytes live content-addressed at
  `~/.somora/attachments/<sha256>.<ext>`; JSONL refs only, never
  inline. See `docs/files.md` (and config block below) for the
  Server side; the client surface is paperclip + Cmd/Ctrl+V paste
  + drag&drop overlay + a per-bubble thumbnail row. Capability
  gate refuses uploads for models without `image`/`pdf` capability
  with a clear nudge to `/model`.
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
  inspectable and can be restored.

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
│   │   ├── AgentDock.tsx        ← left-edge agent tiles
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
