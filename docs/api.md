# somora HTTP API reference

> All clients — TUI, web app, and any third-party tool — talk to the
> same HTTP+SSE+WebSocket surface. This document is the reference for
> that surface, so you can build your own client: a Telegram bridge,
> a status dashboard, a Voice frontend, a Stream-Deck integration,
> whatever you want to plug into your agents.

The server is a Hono app served by `@hono/node-server` over HTTP/2
(see [setup.md](setup.md) for TLS via Tailscale). The base URL in a
typical install is `https://<host>.<tailnet>.ts.net:18737`. The TUI
and web both live at this same origin (TUI is the binary that ships
with somora; web is mounted under `/web`).

## Authentication & deployment model

**There is no API key, no OAuth, no per-route auth.** somora's
security model is *LAN-trust*: the server binds to the loopback or
the Tailnet, and anyone who can reach the address is authorised.

This is a deliberate choice that follows from somora's positioning:

- **Local-first.** somora lives on your machine (or a server in your
  Tailnet). It holds your memory, talks to your accounts. There is
  no multi-tenancy concept.
- **Tailscale is the ACL.** Tailnet ACLs decide who can reach the
  port; somora itself trusts whoever's already at the door.
- **Anything an agent can do, you can do.** The API surfaces the
  same capabilities the agent has — memory writes, model switches,
  dream triggers. If the model is allowed to do it, so is your
  client.

**Do not expose the somora port to the public internet.** No auth
guard means anyone who finds the URL gets full agent control,
including the ability to read all memory + sessions + vault. Keep
it on Tailscale or on `127.0.0.1` and tunnel.

## Conventions

- **Encoding.** Request and response bodies are JSON (`Content-Type:
  application/json`) unless otherwise noted. Attachments are
  `multipart/form-data`.
- **Errors.** A non-2xx response carries `{ "error": "<message>" }`
  in the body. Messages are human-readable strings and may be in
  German (somora speaks both — error text follows the locale of the
  originating component).
- **IDs.** Session IDs are `<YYYYMMDD>-<HHMMSS>_<slug>`. The literal
  string `main` is the always-on default session per agent and is
  always addressable.
- **Polling cadence.** Endpoints that surface live state are cheap
  by design — poll every 2 s for the dream loop, 30 s for dream
  phases, 60 s for sessions. The server caches expensive lookups
  (e.g. session sizes) so polling doesn't burn cycles.
- **SSE.** Streaming endpoints use Server-Sent Events with named
  events (`chat`, `tool`, `memory_inject`, `status`, `heartbeat`).
  See [SSE event vocabulary](web.md#sse-event-vocabulary).

## Versioning & stability

- The version returned by `GET /version` is a calendar version like
  `2026.05.12.3`. somora doesn't follow semver; minor bumps within
  the same day are common during active work.
- Most endpoints listed here are stable — the TUI and web both use
  them, and breaking them would break the shipped clients.
- Endpoints marked **⚠ experimental** may change shape in any bump.
  They are surfaced because the TUI/web already need them; lock
  yourself to a specific somora version if your client depends on
  them.

---

## Core

### `GET /version`

Returns the running somora version.

```bash
curl https://<host>:18737/version
# { "version": "2026.05.12.3" }
```

### `GET /healthz`

Liveness probe. Returns the plain-text `ok` with status 200. Use it
to wait for server start, smoke-test load balancers, etc.

### `GET /health`

Diagnostic snapshot. Use this when something looks stuck — e.g. an
agent's session has stopped responding but the server is still
accepting HTTP. The response shows which `(agent, session)` is busy,
since when, what its current turn id is, queue depth behind it, and
how long ago the last engine event reached SSE subscribers. Read-only,
cheap (in-memory only).

```bash
curl https://<host>:18737/health
```

Returns:

```json
{
  "ok": true,
  "serverPid": 12345,
  "serverBootedAt": 1778756948428,
  "serverUptimeMs": 5142,
  "lockfilePid": 12345,
  "lockfileStartedAt": "2026-05-14T11:09:08.429Z",
  "activeSessions": 1,
  "totalKnownSessions": 3,
  "claudeAuth": {
    "enabled": true,
    "userExists": true,
    "somoraExists": true,
    "identical": true,
    "userExpiresAt": 1785503549000,
    "somoraExpiresAt": 1785503549000,
    "lastSyncResult": "noop",
    "lastSyncAt": 1785496349000
  },
  "sessions": [
    {
      "agent": "<your-agent>",
      "session": "main",
      "busy": true,
      "activePriority": "user",
      "activeSince": 1778757036447,
      "activeAgeMs": 1024,
      "activeCallId": null,
      "activeTurnId": "b5b7a734-...",
      "queueLength": 0,
      "userWaiting": 0,
      "agentWaiting": 0,
      "lastEngineEventAt": 1778757036900,
      "lastEngineEventAgoMs": 571,
      "subscriberCount": 2,
      "lastPublishOkAt": 1778757036900,
      "lastPublishOkAgoMs": 571
    }
  ]
}
```

`activeAgeMs` is how long the current turn has been holding the
per-session lock. `lastEngineEventAgoMs` ticks up while the engine is
silent — if it climbs past a few minutes on a chat turn (vs. a long
local-LLM job), the turn is wedged and the engine watchdog will abort
it. See [setup.md](setup.md#tunables) `engineWatchdog` to tune
thresholds per engine.

`claudeAuth` reports the shared-login credential sync between
`~/.claude` and somora's isolated claude-home (paths and mtimes
elided above; never token material). `identical: false` with both
sides present means the stores have diverged and the watcher hasn't
caught up yet — if it persists, claude-cli auth is about to break;
run `somora auth status` on the host. See
[setup.md](setup.md#isolated-claude-config-dir).

`subscriberCount` is the number of currently-connected SSE clients
(web / mobile / TUI tail) watching this session. `lastPublishOkAt` only
advances when a broadcast reached at least one subscriber within the
`sse.publishTimeoutMs` budget; if `subscriberCount > 0` but
`lastPublishOkAgoMs` grows without bound, at least one client is wedged
— the next publish auto-evicts it (see `sse.publishTimeoutMs` in
[setup.md](setup.md#tunables)).

### `GET /host-stats`

Host machine resource snapshot — CPU load and memory usage of the box
somora is running on. Surfaced to the web taskbar's `cpu` / `mem`
widgets and handy when somora lives on a VM you don't otherwise have a
metrics view for.

```bash
curl https://<host>:18737/host-stats
```

Returns:

```json
{
  "cpu": {
    "loadAvg1": 0.42,
    "cores": 6,
    "percent": 7.0
  },
  "mem": {
    "totalBytes": 25186074624,
    "availableBytes": 23197777920,
    "usedBytes": 1988296704,
    "percent": 7.9
  }
}
```

`cpu.percent` is the 1-minute load average divided by core count and
expressed as a percentage. Values over 100 mean the box has more
runnable processes than CPUs — not capped, an overload signal is more
useful than a clamped number.

`mem.availableBytes` is "memory the kernel can hand back without I/O".
The reading is platform-specific so it matches what the OS-native
tools report:

- **Linux:** `/proc/meminfo:MemAvailable` (includes reclaimable page
  cache). Falls back to `os.freemem()` on kernels that don't expose
  it.
- **macOS:** `vm_stat` pages free + inactive + speculative, times
  page size. Mirrors Activity Monitor's "Available" notion. Falls
  back to `os.freemem()` if the `vm_stat` binary is unavailable.
- **Other:** `os.freemem()` straight (degraded but non-erroring).

`usedBytes` = `totalBytes − availableBytes`. Read-only, cheap (no disk
I/O on Linux, a sub-millisecond `vm_stat` spawn on macOS).

### `GET /tools`

List every tool registered on the server (the same tools agents see).
Useful for clients that want to surface a tool catalog.

```bash
curl https://<host>:18737/tools
```

Returns an array of `{ name, toolset, description, jsonSchema }`.

### `POST /agents/:agent/tools/:name`

Invoke a tool directly as an agent (without going through a chat
turn). The body is the tool's input shape; the response is the tool's
output. Same authorisation as everything else (LAN-trust).

```bash
curl -X POST https://<host>:18737/agents/<your-agent>/tools/memory_search \
     -H 'Content-Type: application/json' \
     -d '{"query":"voice satellites","limit":3}'
```

---

## Files

### `GET /files/view`

Read a server-local file by absolute path. Used by the web client's
FileView window so users can click absolute-path links emitted in
agent messages (e.g. `[report.md](/home/user/somoraworkspace/...)`)
and see the content in-app without SSH-ing into the server.

Policy is reused 1:1 from the `file_read` tool — the same allowlist
(workspace + somora-home roots) and the same blocklist (`~/.ssh`,
credential stores, system dirs, …). Symlink-resolution prevents path
escapes via realpath check on the closest existing ancestor.

Read-only, no writes. Bytes are returned as UTF-8 in the JSON body
and capped at 200 000 characters; oversize files come back with
`truncated: true`.

**Query parameters**

| Name | Required | Description |
|---|---|---|
| `path` | yes | Absolute filesystem path. `~`-prefix is expanded server-side. Relative paths are rejected (no agent-context cwd here). |

**Supported file kinds** — only types the FileView renderer knows
what to do with are accepted; everything else returns `415`.

| Extension | `kind` | Renderer hint |
|---|---|---|
| `.md`, `.markdown` | `markdown` | full Markdown render (same plugins as chat) |
| `.txt`, `.log` | `text` | monospace preformatted, no highlighting |
| `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml` | `code` | monospace + syntax highlighting via rehype-highlight |

**Success response (200)**

```json
{
  "path": "/home/user/somoraworkspace/somora_feedback/example.md",
  "kind": "markdown",
  "ext": ".md",
  "bytes": 4321,
  "content": "# Report\n…",
  "truncated": false
}
```

**Error responses**

| Status | When |
|---|---|
| `400` | Missing `path` query, relative path, path is a directory or non-regular file |
| `403` | Policy blocked (path resolves under a blacklisted root or a denied somora-internal location) |
| `404` | File does not exist |
| `415` | File extension not in the supported set |

```bash
curl -G "https://<host>:18737/files/view" \
     --data-urlencode "path=/home/user/somoraworkspace/somora_feedback/example.md"
```

---

## Agents

### `GET /agents`

List configured agents.

```bash
curl https://<host>:18737/agents
```

Returns an array of `AgentInfo`:

```json
[
  {
    "name": "<your-agent>",
    "description": "scribe and personal-assistant",
    "icon": "📝",
    "color": "#6366f1",
    "role": "Scribe"
  }
]
```

Source: `~/.somora/agents/<name>/AGENTS.md` frontmatter.

### `GET /agents/:agent/system-prompt`

Returns the assembled system prompt for the agent (persona +
behavior + injected blocks). Mostly useful for debugging or for
clients that want to display "what the agent sees".

---

## Sessions

A session is a single conversation thread inside an agent. Each
agent has a magical `main` session plus any number of named sessions.

### `GET /agents/:agent/sessions`

List sessions for one agent. Archived sessions are filtered out by
default — pass `?include_archived=true` to surface them.

```bash
curl https://<host>:18737/agents/<your-agent>/sessions
curl https://<host>:18737/agents/<your-agent>/sessions?include_archived=true
```

Returns an array of `SessionSummary`:

```json
[
  {
    "id": "20260511-093251_research-notes",
    "slug": "research-notes",
    "isMain": false,
    "createdAt": "2026-05-11T09:32:51.000Z",
    "lastActivity": "2026-05-12T14:08:22.000Z",
    "messageCount": 47,
    "isArchived": false,
    "byteSize": 18923,
    "engine": "claude-cli",
    "dreamCoverageTs": 1715520120000,
    "dreamLagEvents": 4,
    "unreadAt": "2026-05-12T14:08:22.000Z",
    "seenAt": "2026-05-12T13:55:00.000Z"
  }
]
```

`unreadAt` and `seenAt` drive the unread badge UX: a session is unread
when `unreadAt > seenAt` (or `seenAt` is null). See
[`/activity/stream`](#get-activitystream) for the live feed that
keeps these in sync across clients.

### `GET /sessions`

Cross-agent session list. Same data as the per-agent endpoint, but
flattened across every agent, with each row carrying its agent name.
Used by the web Sessions tool.

```bash
curl https://<host>:18737/sessions
curl https://<host>:18737/sessions?include_archived=true
```

### `POST /agents/:agent/sessions`

Create a new named session.

```bash
curl -X POST https://<host>:18737/agents/<your-agent>/sessions \
     -H 'Content-Type: application/json' \
     -d '{"slug":"research-notes"}'
```

Returns `{ id, slug }`. The slug must match `[A-Za-z0-9_-]+`. Cannot
be the reserved string `main`.

### `POST /agents/:agent/sessions/:session/archive`

Hide a session from active views without deleting it. The `<id>.jsonl`
and `<id>.meta.json` stay on disk; only the `archived: true` flag
in meta is set. Reversible via unarchive.

```bash
curl -X POST https://<host>:18737/agents/<your-agent>/sessions/<id>/archive \
     -H 'Content-Type: application/json' \
     -d '{"reason":"old smoke test"}'
```

The `main` session cannot be archived directly — use `/reset` instead.

### `POST /agents/:agent/sessions/:session/unarchive`

Clears the `archived` flag.

### `GET /agents/:agent/sessions/:session/export`

Download the session as either raw JSONL (canonical, byte-identical to
the source-of-truth file on disk) or a rendered Markdown transcript
(human-readable, suitable for Obsidian / GitHub / blog posts).

Query param `format`:
- `json` — `Content-Type: application/x-ndjson`. The complete JSONL
  with every event preserved (turn_start, tool_call, engine_meta, …).
  Use this for backups and cross-host transfer.
- `markdown` (default) — `Content-Type: text/markdown`. Renders
  user/assistant turns as `##` sections, tool calls as collapsible
  `<details>` blocks with their JSON args/results, and engine_meta
  items (e.g. codex's plan/todo lists) as task-style bullet lists
  with status glyphs. Skips bookkeeping events (turn_start, turn_end,
  assistant_audio) — those don't add value in a transcript.

Both responses set `Content-Disposition: attachment` so browsers
trigger a file save.

```bash
# Markdown transcript
curl https://<host>:18737/agents/<your-agent>/sessions/main/export?format=markdown \
     -o <your-agent>-main.md

# Raw JSONL (full fidelity)
curl https://<host>:18737/agents/<your-agent>/sessions/main/export?format=json \
     -o <your-agent>-main.jsonl
```

The web client surfaces this via per-row download icons in the
Sessions tool (file-text icon = markdown, file-json icon = JSONL).
The TUI has `/export [json|markdown] [path]` — see [tui.md](tui.md)
for the slash-command reference.

### `POST /agents/:agent/sessions/:session/reset`

Archive the current session content and start fresh. Triggers an
asynchronous REM extraction over the archived content if REM is
enabled for the agent.

```bash
curl -X POST https://<host>:18737/agents/<your-agent>/sessions/main/reset
# { "agent": "<your-agent>", "session": "main",
#   "archivedId": "20260512-140822_main-archive",
#   "dreamSpawned": true }
```

The reset returns immediately. The REM run continues in the
background; check its progress via `GET /dream-states` or via
the per-agent REM badge in the web AgentDock.

---

## Models & thinking

Per-session overrides for the active model and the active thinking
level. Both fall back to the persona default when unset.

### Model

```bash
# Read current
curl https://<host>:18737/agents/<your-agent>/sessions/main/model

# Set per-session override
curl -X PUT https://<host>:18737/agents/<your-agent>/sessions/main/model \
     -H 'Content-Type: application/json' \
     -d '{"model":"claude-opus-4-7"}'

# Clear override (back to persona default)
curl -X DELETE https://<host>:18737/agents/<your-agent>/sessions/main/model
```

The `model` field accepts an alias (`claude-opus-4-7`), a
`<provider>/<id>` tuple (`anthropic/claude-opus-4-20250514`), or
anything else resolvable by `GET /models`.

Switching models mid-session is safe on every engine. Codex pins its
internal thread to the model it was recorded with — somora detects the
mismatch before resume, starts a fresh codex thread seeded with the full
session history, and drops a `model switch` marker into the
conversation. The somora session (id, history, meta) is untouched;
alias changes that resolve to the same underlying model don't trigger a
re-thread.

### Thinking

```bash
# Read
curl https://<host>:18737/agents/<your-agent>/sessions/main/thinking

# Set
curl -X PUT https://<host>:18737/agents/<your-agent>/sessions/main/thinking \
     -H 'Content-Type: application/json' \
     -d '{"level":"medium"}'

# Clear override
curl -X DELETE https://<host>:18737/agents/<your-agent>/sessions/main/thinking
```

Levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. See
[thinking.md](thinking.md) for what each maps to per engine.

### `GET /models`

List models the server knows about. Sources: config-level model
definitions plus engine-discovered models.

```bash
curl https://<host>:18737/models
```

Each entry: `{ provider, id, alias, engine, contextWindow,
capabilities, ref }`. `ref` is the canonical handle to pass to the
model-set endpoints.

---

## Chat

### `POST /chat/send`

Fire-and-forget. The server returns 202 immediately; the actual
turn runs in the background and emits SSE events to `/chat/stream`
subscribers on the same `(agent, session)`.

```bash
curl -X POST https://<host>:18737/chat/send \
     -H 'Content-Type: application/json' \
     -d '{"agent":"<your-agent>","session":"main","text":"Was steht heute an?"}'
```

Body fields:
- `agent` (required) — agent name
- `session` (optional) — defaults to `"main"`
- `text` (required) — user message
- `attachments` (optional) — array of `{hash, name, mime, size}` —
  refs from prior `POST /attachments` calls
- `from_agent` (optional, A2A) — when set, the turn is attributed to
  another agent (used by `agent_ask` tool)
- `agent_ask_call_id` (optional, A2A) — correlation UUID

Response: `{ ok: true, turnId }`. The `turnId` is the server-issued
identifier for the queued/running turn — clients echo it through to
match later SSE events (`turn_queued`, `user_message`) back to the
optimistic bubble they rendered locally.

Streaming responses arrive via `/chat/stream`; this endpoint just
acknowledges receipt.

#### Queuing

Sends on a `(agent, session)` that already has a turn running are
**enqueued**, not rejected. The server holds a per-session lock with
a two-class priority queue:
- `user` — direct human sends (no `from_agent`)
- `agent` — A2A sends from `agent_ask` / sub-spawns

User entries jump ahead of any waiting agent entries; FIFO within each
class. The currently-running turn always finishes — preempting would
corrupt JSONL — so a queued turn starts only after the lock holder
releases.

Clients can opt into rendering a queue indicator by listening for the
`turn_queued` SSE event (see below). UIs without it still work; the
turn runs eventually, just without a visible "waiting" hint.

### `POST /chat/send-sync`

Synchronous variant. Waits for the turn to finish and returns the
full result inline. Slower (you block on it) but simpler for clients
that don't want to manage SSE.

```bash
curl -X POST https://<host>:18737/chat/send-sync \
     -H 'Content-Type: application/json' \
     -d '{"agent":"<your-agent>","session":"main","text":"…"}'
```

Body fields: same as `/chat/send` (`agent`, `session`, `text`,
`from_agent`, `agent_ask_call_id`), plus:

- `waiter_agent` / `waiter_session` (optional, A2A) — identify the
  caller turn that blocks on this request. Used by `agent_ask` and
  `spawn_subagent` internally to register the wait in the server's
  deadlock guard; set both or neither.

When `waiter_*` are present and the request would close a wait cycle
(the target is already — directly or through a chain of waits —
blocked on the caller), the server responds `409` instead of
deadlocking:

```json
{ "error": "circular A2A wait: …", "circular_wait": true,
  "chain": ["donna/main", "gideon/main", "donna/main"] }
```

Response on success: the full turn result (`finalText`, `usage`,
`model`, `ms`, …).

### `GET /chat/stream`

Server-Sent Events stream for a single `(agent, session)`. Subscribe
once per chat window you want to display.

```bash
curl -N "https://<host>:18737/chat/stream?agent=<your-agent>&session=main"
```

Event types:
- `chat` — `{state: 'delta'|'final', text}` — streaming assistant
  output
- `agent` — `{phase: 'start'|'end', usage?, model?, ...}` — turn
  lifecycle around the model call
- `user_message` — `{text, ts, turnId?, from_agent?, from_system?,
  agent_ask_call_id?}` — broadcast when a turn's user_message is
  written to JSONL. Self-typed sends, A2A inbounds, and sentinel
  triggers all flow through here. `turnId` lets a sending client
  match this event to the optimistic bubble it rendered after
  `POST /chat/send` (which echoes the same id).
- `turn_queued` — `{turnId, ahead}` — fired when `POST /chat/send`
  hit a busy lock and the turn had to wait. `ahead` is the number
  of turns this one must wait for (≥1, includes the currently-
  running one). Static snapshot at enqueue time, not updated as
  the queue drains. Clients render `"queued · N ahead"` until the
  matching `user_message` event arrives (= the turn is now actually
  running, lock acquired).
- `tool` — `{phase: 'call'|'result'|'error', tool, summary?,
  details?, error?}` — tool-call events
- `engine_meta` — `{engine, itemType, label, summary?, payload}` —
  engine-internal side-channel state. The canonical case is codex's
  `todo_list` (an internal plan/checklist the model updates mid-turn)
  — somora persists these so memory / REM-dream can read them later
  and clients can optionally render them. `label` is server-resolved
  (e.g. `todo_list` → `"plan"`); unknown item-types fall back to the
  raw `itemType`. `payload` is the engine's original event, opaque.
- `model_fallback` — `{requested, actual, reason}` (refs are
  `provider/modelId`) — the persona's primary model failed before
  producing anything and the configured `fallback:` model is answering
  this turn. Sent before the fallback's first delta; the following
  `agent` phase:'end' also carries `fallback` and reports the ACTUAL
  `provider`/`model`. Persisted to history as the same kind, so a
  reload keeps the marker on that turn.
- `memory_inject` — `{hits, block}` — memory recall for this turn
- `status` — `{msg}` — connection events, error notices
- `heartbeat` — current ms timestamp, fires every 20 s

Tool names are normalised through the same path the wire serializer
uses — clients receive `memory_search`, not
`mcp__somora-memory__memory_search`. Tool input/output payloads ride
in the `details` field as pretty-printed JSON.

### `GET /activity/stream`

App-wide activity feed. One subscription per client gives streaming
markers for every busy `(agent, session)` plus unread state for
sessions the user hasn't viewed since new movement arrived. Distinct
from `/chat/stream`, which is per-session and per-window.

```bash
curl -N https://<host>:18737/activity/stream
```

Event types:

- `streaming` — `{agent, session, phase: 'start'|'end'}` — emitted
  when any turn begins or ends on any session. Drives multi-agent
  streaming-dots in clients that aren't subscribed to every per-
  session `/chat/stream`.
- `turn` — `{agent, session, unreadAt}` — a new unread-candidate
  event landed in the session's JSONL. Unread candidates are:
  - `chat:final` (assistant answer)
  - `user_message` with `from_agent` set (A2A peer wrote to us)
  - `user_message` with `from_system` set (sentinel woke us)
  Plain self-typed user messages, tool / memory / engine_meta events,
  and lifecycle (`agent:start`, `agent:end`) are excluded.
- `seen` — `{agent, session, seenAt}` — broadcast when any client
  POSTs `/sessions/:agent/:session/seen`. Sibling clients clear
  their unread badge for that session.
- `status` — `{msg}` — connection lifecycle.
- `heartbeat` — current ms timestamp, fires every 20 s.

Unread state is persisted in the session's meta as `unreadAt` and
`seenAt` (both ISO timestamps). A session is unread when
`unreadAt > seenAt` (or `seenAt` is null). The persistence path is
authoritative, so a server restart preserves the badge state.

### `POST /sessions/:agent/:session/seen`

Tell the server "I am looking at this session now". Updates `seenAt`
in the session's meta and broadcasts a `seen` event on
`/activity/stream` so other open clients clear their badge live.

```bash
curl -X POST https://<host>:18737/sessions/<your-agent>/main/seen
```

Optional body:

```json
{ "ts": "2026-05-27T14:00:00.000Z" }
```

`ts` lets a client claim an older "I last looked at this at …" time —
useful for scrolling-into-view triggers where the wall-clock isn't
exactly "now". The server clamps to `max(currentSeenAt, ts)`, so a
later arrival can never regress the seen marker.

Response:

```json
{ "ok": true, "agent": "<your-agent>", "session": "main", "seenAt": "2026-…" }
```

### `GET /chat/history`

Snapshot of past events for a session. The TUI and web both
hydrate this on open.

```bash
curl "https://<host>:18737/chat/history?agent=<your-agent>&session=main"
```

Pagination: pass `?limit=200` to get the last 200 events plus a
`hasMore` + `oldestTs` cursor; subsequent calls supply
`?before=<oldestTs>&limit=200` for older windows.

```json
{
  "agent": "<your-agent>",
  "session": "20260511-093251_research-notes",
  "events": [...],
  "hasMore": true,
  "oldestTs": 1715512000000
}
```

Event kinds: `user_message`, `assistant_message`, `tool_call`,
`tool_result`, `engine_meta`, `memory_inject`, `model_fallback`
(precedes the assistant message the fallback model produced). Each carries `kind`,
`ts`, and kind-specific fields. Tool names are normalised here too.
`engine_meta` rows preserve the raw `itemType` + opaque `payload`;
clients resolve the friendly label on render (see
[setup.md](setup.md#engine-meta--codex-todo_list)).

### `POST /chat/abort`

Cancel an in-flight turn on a `(agent, session)`. The TUI fires it
on ESC; web and mobile fire it from the Stop button overlaid on the
streaming assistant bubble. Idempotent — returns `aborted: false`
when no turn is running. Cancels the **currently-running** turn
only; queued waiters keep their slots and still execute.

```bash
curl -X POST "https://<host>:18737/chat/abort?agent=<your-agent>&session=main"
```

---

## Memory

Each agent has its own memory layer — markdown notes under
`~/.somora/agents/<agent>/memory/` plus, optionally, a shared Obsidian
vault and wiki layer. See [memory.md](memory.md) for the storage
architecture.

### `GET /agents/:agent/memory/notes`

List indexed notes for an agent. Optional `?source=memory|vault|wiki`
to filter by source layer.

### `GET /agents/:agent/memory/search`

Hybrid (BM25 + vector) search across the agent's memory.

```bash
curl "https://<host>:18737/agents/<your-agent>/memory/search?q=voice+satellites&limit=5&minScore=0.3"
```

Query params: `q` (required), `limit` (default 5), `minScore`
(default 0.5), `source` (optional filter).

Returns `{ query, count, hits: [...] }` with each hit carrying
`reference`, `source`, `slug`, `score`, `snippet`, `path`, line
numbers.

For full content of a hit, agents call `memory_get` via the tool
endpoint (`POST /agents/:a/tools/memory_get`). Same path is
available to your client.

---

## Wiki explorer

Read-only browse surface over the shared wiki, backing the web client's
wiki window. All routes return **503** unless `wiki.enabled` and
`obsidian.vault` are both configured.

Pages are addressed by **slug, never by path** — a request can only name
pages the index already found under the wiki root, so traversal attempts
come back as a plain 404 rather than needing a filter to catch them.

### `GET /wiki/status`

`{ enabled: boolean, root?: string }`. Cheap enough to call on UI mount;
clients use it to decide whether to show the wiki entry point at all.

### `GET /wiki/tree`

```json
{
  "root": "/path/to/vault/somora",
  "pages": 262,
  "builtAt": 1784750000000,
  "nodes": [
    { "type": "dir", "name": "personen", "path": "personen",
      "children": [
        { "type": "page", "slug": "personen/familie-klein",
          "name": "familie-klein.md", "title": "Familie Klein",
          "description": "…", "mtimeMs": 1784700000000 }
      ] }
  ]
}
```

Titles come from the page's first `# H1`, falling back to frontmatter
`title`, then the filename.

### `GET /wiki/page?slug=<slug>`

Returns `markdown` plus resolved relationships:

```json
{
  "slug": "projekte/somora", "title": "somora", "folder": "projekte",
  "mtimeMs": 1784700000000,
  "markdown": "## Aktueller Stand\n…",
  "frontmatter": { "type": "project", "created": "2026-05-08" },
  "links":       [{ "slug": "personen/rene-siegl", "title": "Rene" }],
  "backlinks":   [{ "slug": "agenten/<your-agent>", "title": "Your Agent" }],
  "unresolved":  ["personen/familie-rene"],
  "linkTargets": { "personen/rene-siegl": "personen/rene-siegl",
                   "familie-rene": null }
}
```

`linkTargets` maps every raw `[[target]]` in the body to a slug, or
`null` when nothing matches. Resolution — exact slug, case-insensitive
slug, unique basename — lives here so clients don't reimplement
Obsidian's matching. An ambiguous basename resolves to `null` on
purpose: guessing one of several same-named pages fabricates a
relationship.

404 when the slug names no page.

### `GET /wiki/graph?scope=local&slug=<slug>` · `?scope=global`

```json
{
  "scope": "local",
  "nodes": [{ "id": "projekte/somora", "label": "somora",
              "folder": "projekte", "degree": 41 }],
  "edges": [{ "from": "agenten/<your-agent>", "to": "projekte/somora",
              "type": "wikilink" }],
  "truncated": false
}
```

`local` returns the page, everything it points at, everything pointing
at it, and the edges among those neighbours. `global` returns the whole
wiki, capped at the 400 most-connected pages — `truncated` says whether
the cap bit. `degree` always counts the full wiki, so a node stays
recognisable as a hub inside a local view.

`index.md` is excluded from both scopes: it links to every page by
construction, which makes it a table of contents rather than a
relationship.

Edge `type` is `wikilink` for inline `[[links]]` and `related` for
frontmatter `related:` entries.

### `POST /wiki/refresh`

Drops the cache and re-scans. The index otherwise caches for 10 seconds
and then re-parses only files whose mtime or size changed, so ordinary
edits appear without this call.

---

## Dream system

The dream system runs in three phases (REM, Deep, Lucid) — see
[dream-phases.md](dream-phases.md) for the model. Some of these
endpoints surface state for monitoring; others trigger phases
manually.

### `GET /dream/loop-state`

Read-only snapshot of the active Lucid review loop, if any.

```json
{ "active": true, "agent": "<your-agent>", "dreamId": "lucid-...",
  "startedAt": "…", "lastActivityAt": "…" }
```

Returns `{ active: false }` when no loop is held.

### `GET /dream-states` ⚠ experimental

Per-agent REM state + server-global Deep / Lucid state. Drives the
web AgentDock pulse indicators and REM badges.

```json
{
  "rem": {
    "<your-agent>":  { "active": false, "pendingCount": 3 },
    "<agent-b>":  { "active": true,  "pendingCount": 0 }
  },
  "deep":  { "active": false },
  "lucid": { "active": false }
}
```

`rem[<agent>].active` is filesystem-driven (presence of
`<agent>/memory/.dreams/<id>.dream.running.md`).
`rem[<agent>].pendingCount` is the number of completed REM dreams
waiting for review (`<id>.dream.md` files in `.dreams/`, not in
`processed/`).

### `POST /dream/run-deep`

Trigger a Deep run manually. Default is fire-and-forget (returns
immediately); set `{"wait": true}` to wait for the run to finish and
get the result inline.

```bash
curl -X POST https://<host>:18737/dream/run-deep \
     -H 'Content-Type: application/json' \
     -d '{"wait":true, "force":false}'
```

`force: true` bypasses the per-agent skip-cache so every memory file
gets re-evaluated.

### `POST /dream/run-lucid`

Same shape as `run-deep`, for the Lucid (wiki review) phase.

---

## Projects

Curated pointer-file manifests linking a session to a real-world
project. **Opt-in feature** — every route below returns `503` when
`projects.enabled` is `false` in `config.yaml`. Clients should probe
[`GET /projects/feature`](#get-projectsfeature) once at boot to
decide whether to surface the feature at all. See
[projects.md](projects.md) for the user-level model.

### `GET /projects/feature`

Feature-flag probe. **Always returns 200**, regardless of the
configured state — clients use this to detect availability without
ambiguity (empty entities array vs. feature off).

```json
{ "enabled": true, "entityCount": 2 }
```

### `GET /projects/entities`

The controlled entity vocabulary from `config.projects.entities`.

```json
{
  "entities": [
    { "slug": "privat", "label": "Privat" },
    { "slug": "enovom", "label": "enovom GmbH" }
  ]
}
```

Agents call this before `project_create` when they're uncertain
about an entity name they heard via STT — the response is the
canonical match list. Direct clients fetch it once to populate
filter dropdowns.

### `GET /projects`

List configured projects.

Query params (all optional):
- `entity=<slug>` — filter to one entity
- `tag=<string>` — filter to projects whose `tags[]` contains this
- `includeArchived=true` — include soft-deleted projects (hidden by
  default)

```json
{
  "total": 3,
  "projects": [
    {
      "slug": "heimkino",
      "name": "Heimkino",
      "entity": "privat",
      "description": "Receiver, beamer, …",
      "color": "#4f46e5",
      "tags": ["hardware", "wip"],
      "created": "2026-04-15T10:23:00Z",
      "updated": "2026-05-13T09:42:00Z",
      "archived": false,
      "paths": [
        { "ref": "~/code/heimkino", "label": "Sourcecode" },
        { "ref": "https://drive.google.com/..." }
      ]
    }
  ]
}
```

### `GET /projects/:slug`

Full project file content. `404` if the slug doesn't exist.

```bash
curl https://<host>:18737/projects/heimkino
```

### `POST /projects`

Create a new project. Returns `201` with the full project on
success.

Body:
```json
{
  "slug": "heimkino",
  "name": "Heimkino",
  "entity": "privat",
  "description": "Receiver, beamer, acoustic treatment",
  "color": "#4f46e5",
  "tags": ["hardware", "wip"],
  "expires": null,
  "paths": [
    { "ref": "~/code/heimkino", "label": "Sourcecode" },
    { "ref": "https://drive.google.com/..." }
  ]
}
```

Validation:
- `slug` must match `[a-z0-9_-]+` and be unique (`409` on collision)
- `entity` must match one of `config.projects.entities[].slug`
  (`400` with the available list when unknown)
- each `paths[].ref` must be scheme-recognised — `https://...`,
  `~/abs`, `/abs`, or `<resource-slug>:/path` where the slug
  exists in `config.resources` (`400` with the available list
  when the resource is unknown)

### `PATCH /projects/:slug`

Transactional multi-op update. All ops validate first; if any one
fails, **nothing is written**. Returns `200` with the updated
project on success.

Body:
```json
{
  "ops": [
    { "op": "add_path", "ref": "~/research/atmos.md", "label": "Atmos notes" },
    { "op": "set_field", "field": "description", "value": "Updated" },
    { "op": "set_tags", "tags": ["hardware", "wip", "avr"] }
  ]
}
```

Supported op shapes:

| `op` | Required fields | Effect |
|---|---|---|
| `set_field` | `field` ∈ {name,description,color,expires}, `value` (string or null) | Update top-level field; `null` clears optional fields (cannot clear `name`). |
| `add_path` | `ref`, `label?` | Append a pointer. Same scheme validation as `POST /projects`. |
| `remove_path` | `ref` | Remove by exact ref match. `400` if `ref` isn't in the list. |
| `set_tags` | `tags: string[]` | Replace the full tag array. |
| `archive` | `reason?` | Soft-delete. |
| `unarchive` | — | Restore. |

Slug and entity are intentionally **not** mutable in v1 — would
break session pins. Workaround: delete the file and recreate.

### `GET /agents/:agent/sessions/:session/project`

Current pinned project for a session. Always returns `200` (or
`404` if the agent/session itself doesn't exist).

```json
{
  "agent": "<your-agent>",
  "session": "main",
  "slug": "heimkino",
  "project": { … full ProjectInfo … }
}
```

When no project is pinned: `{ "agent": …, "session": …, "slug": null, "project": null }`.
When the slug is set but the file is missing on disk:
`{ …, "slug": "ghost", "project": null, "missing": true }`.

### `POST /agents/:agent/sessions/:session/project`

Pin a project to a session.

```bash
curl -X POST https://<host>:18737/agents/<your-agent>/sessions/main/project \
     -H 'Content-Type: application/json' \
     -d '{"slug":"heimkino"}'
```

Returns `{ agent, session, previousSlug, currentSlug }`. Re-pinning
the same project is a noop — no `project_switched` event is written
to the JSONL.

Emits an SSE `project` event to every subscriber of (agent, session).

### `DELETE /agents/:agent/sessions/:session/project`

Clear the pin. Returns `{ agent, session, cleared: true, previousSlug }`.
Also emits an SSE `project` event.

---

## Attachments

Files attached to chat turns (images, PDFs, plain-text snippets)
travel via this two-step flow: upload first, then ref the hash on
`/chat/send`.

### `POST /attachments`

Multipart upload of one or more files. Content is stored once on
disk, deduped by hash.

```bash
curl -X POST https://<host>:18737/attachments \
     -F "file=@./screenshot.png"
```

Returns:
```json
[
  { "hash": "sha256-…",
    "name": "screenshot.png",
    "mime": "image/png",
    "kind": "image",
    "size": 184320 }
]
```

Pass the same shape under `attachments[]` on the next `/chat/send`.

### `GET /attachments/:hash`

Serve the bytes for a previously-uploaded attachment. Useful for
clients that want to preview the same image the agent saw.

---

## Tmux integration

somora knows about tmux sessions on the host and lets clients attach
to them through a WebSocket bridge. See [tmux.md](tmux.md) for the
full model.

### `GET /tmux/sessions`

List live tmux sessions, joined with somora's origin store so each
session carries the agent/session that created it (if known).

```bash
curl https://<host>:18737/tmux/sessions
```

### `WS /tmux/attach?session=<name>`

WebSocket bridge to `tmux attach-session -d -t <name>`. Binary
frames carry the terminal stream; text frames carry control messages
(`{type:'resize',cols,rows}`).

### `WS /terminal/attach`

Fresh shell (no tmux session). Same binary/text frame protocol as
`/tmux/attach`.

---

## Sentinel — proactive triggers

Sentinel installs time-based triggers that wake agents on a schedule.
The agent does its work into its own chat session — same surface as
when you interact with it directly. See [sentinel.md](sentinel.md) for
the conceptual overview.

The same operations are also exposed as the `sentinel` tool agents
can call (`POST /agents/:agent/tools/sentinel`); the HTTP routes below
are for the web-UI sentinel tab and for external clients.

### `GET /sentinel/triggers`

List all triggers. Optional query filters:

- `?owner=<agent>` — only triggers whose `ownerAgent` matches
- `?status=active|paused|error|completed`

```bash
curl https://<host>:18737/sentinel/triggers?status=active
```

```json
{
  "count": 2,
  "triggers": [
    {
      "id": "morning-mail-summary-a7c3",
      "name": "morning-mail-summary",
      "ownerAgent": "<other-agent>",
      "source": { "type": "time", "spec": { "type": "daily", "time": "08:00" } },
      "evaluator": { "type": "none" },
      "dispatch": { "agent": "<other-agent>", "session": "morning-routine",
                    "prompt": "Check inbox via gog skill…" },
      "createdAt": "2026-05-17T11:00:00.000Z",
      "status": "active",
      "fireCount": 5,
      "lastSuccessAt": "2026-05-17T08:00:01.234Z",
      "errorStreak": 0,
      "nextFireAt": "2026-05-18T08:00:00.000Z"
    }
  ]
}
```

### `GET /sentinel/triggers/:id`

Full trigger document for a single id. 404 if missing.

### `GET /sentinel/triggers/:id/history`

Newest-first fire log. `?limit=N` capped at 200, default 50.

```json
{
  "count": 5,
  "entries": [
    {
      "firedAt": "2026-05-17T08:00:01.234Z",
      "scheduledFor": "2026-05-17T08:00:00.000Z",
      "outcome": "success",
      "taskId": "task-..."
    },
    {
      "firedAt": "2026-05-16T08:00:00.500Z",
      "scheduledFor": "2026-05-16T08:00:00.000Z",
      "outcome": "skipped",
      "skipReason": "cooldown (1320s remaining)"
    }
  ]
}
```

Outcomes: `success` / `error` (with `error: string`) / `skipped`
(with `skipReason: string`). Plus optional `catchUp: true` (boot
recovery fire) and `testMode: true` (fired via `/test`).

### `POST /sentinel/triggers/:id/pause`

Set status to `paused`. Trigger stops firing until explicitly resumed.
Returns `{"ok": true}`. 404 if missing.

### `POST /sentinel/triggers/:id/resume`

Set status back to `active`, recompute `nextFireAt` from the spec.
Idempotent for already-active triggers. 404 if missing.

### `POST /sentinel/triggers/:id/test`

Fire NOW, bypassing cooldown and daily-cap. The fire is recorded with
`testMode: true` in history. The dispatched agent receives the same
evidence-prefixed prompt as a real fire.

```bash
curl -X POST https://<host>:18737/sentinel/triggers/morning-mail-summary-a7c3/test
```

### `DELETE /sentinel/triggers/:id`

Remove the trigger and its history file. Idempotent — already-deleted
ids return 404.

### `GET /sentinel/status`

Scheduler diagnostic snapshot. Useful when sanity-checking that the
scheduler is armed for the next due trigger.

```json
{ "started": true, "nextFireAt": 1779013800000 }
```

### Creating triggers

Triggers are created through the agent-facing tool, not a dedicated
HTTP route, so the safeguards (min-interval, per-agent cap, limit
enforcement) all run through the same validation path:

```bash
curl -X POST https://<host>:18737/agents/<your-agent>/tools/sentinel \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "create",
    "name": "morning-mail-summary",
    "intent": "Daily 8am inbox digest",
    "source": { "type": "time", "spec": { "type": "daily", "time": "08:00" } },
    "dispatch": {
      "agent": "<other-agent>",
      "session": "morning-routine",
      "prompt": "Check inbox via the gog skill, group by topic, tell me what is important."
    }
  }'
```

The full `sentinel` tool surface (`create` / `list` / `get` /
`pause` / `resume` / `delete` / `test` / `history`) is described in
[sentinel.md](sentinel.md).

---

## Voice

Two flows: STT for filling chat drafts, TTS for spoken replies. Plus
`/voice/turn` as the audio-in/audio-out endpoint for integrations.
All routes return 503 when the matching block is missing or disabled
in `config.yaml`. See [voice.md](voice.md) for the full picture.

### `GET /stt/config`

Reports STT availability + the default language hint.

```json
{ "enabled": true, "language": "de" }
```

Returns `{ "enabled": false }` when STT is off in config — clients
auto-hide their mic button.

### `POST /stt/transcribe`

Forwards a multipart audio recording to the configured upstream's
`/v1/audio/transcriptions` and returns the transcript.

```http
POST /stt/transcribe
Content-Type: multipart/form-data

file=@recording.webm
language=de              # optional, overrides config default
```

Response: `{ "text": "<transcript>" }`. 503 when disabled.

### `GET /tts/config`

Reports TTS availability + supported wire formats + per-client
auto-play defaults.

```json
{
  "enabled": true,
  "formats": ["audio/wav", "audio/opus", "audio/mp4"],
  "language": "de",
  "voice": null,
  "clients": {
    "web": { "autoPlayVoiceReplies": false, "allowUserOverride": true },
    "mobile": { "autoPlayVoiceReplies": false, "allowUserOverride": true }
  }
}
```

### `POST /tts/synthesize`

Generate (or fetch from cache) spoken audio for a piece of text.
Content-negotiates the wire format from `Accept`.

```http
POST /tts/synthesize
Content-Type: application/json
Accept: audio/opus, audio/wav;q=0.5

{ "text": "Es ist 10:29 Uhr.", "voice": null, "language": "de" }
```

Response body is audio bytes. Useful response headers:

- `Content-Type` — `audio/wav`, `audio/opus`, or `audio/mp4`.
- `X-Tts-Cache` — `hit` or `miss`.
- `X-Tts-Cache-Key` — sha256 hex used for caching.
- `X-Tts-Duration-Ms` — set on WAV cache misses; omitted otherwise
  (clients can compute on-play).

400 on missing `text` or text > 4000 chars. 502 on upstream failure.
503 when TTS disabled.

### `GET /tts/cache/:filename`

Stream a previously-generated audio file by its cache key. Filenames
are `<64-hex>.<wav|opus|m4a>`; anything else returns 400. Supports
single-range requests (`Range: bytes=N-`) so mobile `<audio>` can
seek.

This is the URL emitted as `assistant_audio.url` in SSE and JSONL —
clients render it directly into `<audio src=…>` without ever calling
`/tts/synthesize` for cached turns.

### `POST /voice/turn`

Independent audio-in → audio-out endpoint. STT-transcribes the
recording, runs a normal agent turn (with `input_modality=voice`),
sanitizes the assistant reply for speech, generates TTS, and returns
JSON with the artifact URL. The session JSONL + SSE stream see the
turn live, same as a `/chat/send` turn.

```http
POST /voice/turn
Content-Type: multipart/form-data
Accept: audio/opus, audio/wav;q=0.5

agent=<name>             # required
session=<name>           # required: "main" / exact id / new slug (creates)
audio=@recording.webm    # required
voice=<voice-id>         # optional, falls back to tts.voice
language=<lang>          # optional, falls back to tts.language
```

Response:

```json
{
  "ok": true,
  "agent": "<your-agent>",
  "session": "main",
  "transcript": "Wie spät ist es?",
  "text": "Es ist 10:29 Uhr.",
  "audio": {
    "url": "/tts/cache/abc123….opus",
    "mime": "audio/opus",
    "durationMs": 1800,
    "cacheKey": "abc123…"
  }
}
```

- Session lock priority: `user` (treated as human input).
- 60s default timeout — voice UX dies past that.
- Always generates audio, regardless of any per-chat auto-play
  toggle (those toggles only affect `/chat/send`).
- 404 when `session=<exact-id>` doesn't exist; auto-creates for free-
  form slug names. 503 if either `stt` or `tts` is disabled.

### `assistant_audio` SSE event

After a turn whose reply got TTS (auto or via `/voice/turn`), the
session's SSE stream emits:

```
event: assistant_audio
data: {"turnId":"…","url":"/tts/cache/…","mime":"audio/opus","durationMs":1800,"cacheKey":"…"}
```

Clients pair on `turnId` and render a Play-button on the matching
assistant bubble. The event is also appended to the session JSONL,
so `/chat/history` returns it on reload and Play-buttons survive.

---

## Web bundle

### `GET /web/`

Serves the bundled web UI from `web/dist/`. Same-origin as the API,
so the web app's `fetch('/agents')` works without CORS.

---

## Building a custom client — typical flow

A minimal client that wants to send a message and stream the
response back works like this:

```bash
# 1. Discover agents
curl https://<host>:18737/agents

# 2. Optionally set the model + thinking for this conversation
curl -X PUT https://<host>:18737/agents/<your-agent>/sessions/main/model \
     -H 'Content-Type: application/json' \
     -d '{"model":"claude-opus-4-7"}'

# 3. Subscribe to the stream (background)
curl -N "https://<host>:18737/chat/stream?agent=<your-agent>&session=main" &

# 4. Send a message — server fires the turn, events arrive on the stream
curl -X POST https://<host>:18737/chat/send \
     -H 'Content-Type: application/json' \
     -d '{"agent":"<your-agent>","session":"main","text":"Was steht heute an?"}'
```

For richer clients (a dashboard, a desktop app, a phone bridge), the
typical loop is:

1. **On boot:** `GET /agents` + `GET /sessions` + `GET /version` to
   build the navigation.
2. **For each open chat window:** open one SSE subscription
   (`/chat/stream`) and one history hydration (`/chat/history?limit=200`).
3. **On user input:** `POST /attachments` for any files, then
   `POST /chat/send` with `attachments[]` set.
4. **On user reset:** `POST /agents/:a/sessions/:s/reset`. The server
   triggers REM in the background; your UI can show the resulting
   pending count via `/dream-states`.
5. **For monitoring:** poll `/dream-states` every 30 s for dream-phase
   indicators, `/dream/loop-state` every 2 s if you want to surface
   the Lucid review loop.

The TUI's API client lives at `src/cli/tui/api.ts`; the web's at
`web/src/lib/api.ts`. Both are short, focused, typed wrappers over
the surface above and make good starting points for your own.

---

## Files of interest in the somora source

- `src/server/index.ts` — every route definition lives here
- `src/server/sse-serializer.ts` — wire format for SSE events
- `src/server/tool-format.ts` — tool name + arg + result
  pre-formatting (normalises `mcp__…` prefixes)
- `src/cli/tui/api.ts` — reference client (TypeScript)
- `web/src/lib/api.ts` — second reference client (TypeScript,
  browser-targeted)
