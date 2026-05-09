# Web client

A browser-based desktop for somora — multi-window chat with every
agent on your LAN. Same backend as the TUI, just a different head.
Phase 1 ships chat windows; tmux + xterm.js attaches come later.

## Mental model

```
  ┌─────────────────────────────── browser ─────────────────────────┐
  │  ┌─ agent dock ─┐  ┌─── chat: hans ────┐  ┌─── chat: naxon ───┐ │
  │  │  hans   ●    │  │ history + stream  │  │ history + stream  │ │
  │  │  naxon  ●    │  │ tool blocks       │  │ tool blocks       │ │
  │  │  rene   ◯    │  │ [paperclip] ▢▷▶   │  │ [paperclip] ▢▷▶   │ │
  │  └──────────────┘  └───────────────────┘  └───────────────────┘ │
  │                                                                 │
  │  taskbar: [hans] [naxon]   ▢ auto-arrange  💾 save layout       │
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

The somora server mounts the production bundle at `/web/*`:

```
http://<somora-host>:18737/web/
```

By default the server binds `127.0.0.1`. To make the web client
reachable from the LAN, set `SOMORA_HOST=0.0.0.0` in the systemd env
file (or wherever you launch from):

```bash
# ~/.config/systemd/user/somora.env
SOMORA_HOST=0.0.0.0
```

Then `systemctl --user restart somora`. The server listens on all
interfaces; child processes (MCP, openai-compat HTTP fallback) keep
talking to `127.0.0.1` regardless. **There is no auth** — same trust
model as the API server. LAN-only by design.

For development:

```bash
cd web
npm install
npm run dev   # vite on :5173, proxies /agents /chat /dream /tools /tui-config /health to :18737
```

The dev server also binds `0.0.0.0`, so you can browse from another
machine while iterating on the UI.

## Window manager

- **Agent dock (left edge)**: one tile per agent from `/agents`. Click
  opens a chat window; clicking again focuses the existing window.
  Status dot: green = idle, amber blink = streaming, violet = holds
  the dream review loop, grey = offline.
- **Window**: drag the title bar to move, drag the bottom-right
  corner to resize. Close button removes the window without
  unsubscribing other clients.
- **Taskbar (bottom)**: lists open windows. Auto-arrange tiles them
  across the desktop; save/restore persists positions in
  `localStorage`.

Layout state is per-browser-profile. There's no server-side window
manager — each device remembers its own arrangement.

## Chat window anatomy

```
 ┌──────────────────────────────────────────────────────┐
 │ 🧠  hans  · butler                  ● streaming     │ ← header
 │ main · gpt-4o · think:medium · 🔧 on · ↑12k ↓4k · ●  │ ← live meta
 ├──────────────────────────────────────────────────────┤
 │  [user]   wo wohnt rene?                             │
 │                                                       │
 │  [tool]   memory_search "rene wohnort"               │ ← above
 │  [tool]   → personen/rene · 0.71                     │
 │  [hans]   In Wien, in der Hofgasse.                  │ ← below
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

Markdown is rendered via `react-markdown` + `remark-gfm` +
`rehype-highlight`. Code blocks scroll horizontally inside the
75%-width bubble; tables overflow-scroll independently.

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

## Phase-1 backlog

Currently shipped: chat windows, history hydration, live streaming,
tool blocks, markdown, per-window tools toggle, cross-client echo,
window manager + persistence.

Not yet shipped (planned within Phase 1):

- Slash-command popup (`/agent`, `/session`, `/skill`, ...)
- Drag&drop attachments + multimodal preview
- Memory-inject banner (visible per-turn injection summary)
- Older-messages lazy-load (history is full-snapshot on subscribe today)

Phase 1.5 adds tmux session windows attached via xterm.js + a
WebSocket bridge. Phase 2 adds skill catalog, dream-runner controls,
and the wiki review loop UI.

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
