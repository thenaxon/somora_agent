# Web client

A browser-based desktop for somora — multi-window chat with every
agent on your LAN. Same backend as the TUI, just a different head.
Phase 1 ships chat windows; tmux + xterm.js attaches come later.

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
session attaches (Phase 1.5) and any future xterm.js/WebSocket panels
will eat connections from the same pool.

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

- Native PDF for `openai-compatible` providers verified against
  OpenRouter / OpenAI direct (today defaults to `rasterize` which
  works everywhere; `pdfMode: native` is opt-in per provider until
  smoke-tested across the fleet).

Recently landed:

- **Drag & drop / paste / paperclip attachments** (Phase Y.B).
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
