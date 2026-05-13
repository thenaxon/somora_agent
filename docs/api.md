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
curl -X POST https://<host>:18737/agents/hans/tools/memory_search \
     -H 'Content-Type: application/json' \
     -d '{"query":"voice satellites","limit":3}'
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
    "name": "hans",
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
curl https://<host>:18737/agents/hans/sessions
curl https://<host>:18737/agents/hans/sessions?include_archived=true
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
    "dreamLagEvents": 4
  }
]
```

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
curl -X POST https://<host>:18737/agents/hans/sessions \
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
curl -X POST https://<host>:18737/agents/hans/sessions/<id>/archive \
     -H 'Content-Type: application/json' \
     -d '{"reason":"old smoke test"}'
```

The `main` session cannot be archived directly — use `/reset` instead.

### `POST /agents/:agent/sessions/:session/unarchive`

Clears the `archived` flag.

### `POST /agents/:agent/sessions/:session/reset`

Archive the current session content and start fresh. Triggers an
asynchronous REM extraction over the archived content if REM is
enabled for the agent.

```bash
curl -X POST https://<host>:18737/agents/hans/sessions/main/reset
# { "agent": "hans", "session": "main",
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
curl https://<host>:18737/agents/hans/sessions/main/model

# Set per-session override
curl -X PUT https://<host>:18737/agents/hans/sessions/main/model \
     -H 'Content-Type: application/json' \
     -d '{"model":"claude-opus-4-7"}'

# Clear override (back to persona default)
curl -X DELETE https://<host>:18737/agents/hans/sessions/main/model
```

The `model` field accepts an alias (`claude-opus-4-7`), a
`<provider>/<id>` tuple (`anthropic/claude-opus-4-20250514`), or
anything else resolvable by `GET /models`.

### Thinking

```bash
# Read
curl https://<host>:18737/agents/hans/sessions/main/thinking

# Set
curl -X PUT https://<host>:18737/agents/hans/sessions/main/thinking \
     -H 'Content-Type: application/json' \
     -d '{"level":"medium"}'

# Clear override
curl -X DELETE https://<host>:18737/agents/hans/sessions/main/thinking
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
     -d '{"agent":"hans","session":"main","text":"Was steht heute an?"}'
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

Streaming responses arrive via `/chat/stream`; this endpoint just
acknowledges receipt.

### `POST /chat/send-sync`

Synchronous variant. Waits for the turn to finish and returns the
full result inline. Slower (you block on it) but simpler for clients
that don't want to manage SSE.

```bash
curl -X POST https://<host>:18737/chat/send-sync \
     -H 'Content-Type: application/json' \
     -d '{"agent":"hans","session":"main","text":"…"}'
```

### `GET /chat/stream`

Server-Sent Events stream for a single `(agent, session)`. Subscribe
once per chat window you want to display.

```bash
curl -N "https://<host>:18737/chat/stream?agent=hans&session=main"
```

Event types:
- `chat` — `{state: 'delta'|'final', text}` — streaming assistant
  output
- `tool` — `{phase: 'call'|'result'|'error', tool, summary?,
  details?, error?}` — tool-call events
- `memory_inject` — `{hits, block}` — memory recall for this turn
- `status` — `{msg}` — connection events, error notices
- `heartbeat` — current ms timestamp, fires every 20 s

Tool names are normalised through the same path the wire serializer
uses — clients receive `memory_search`, not
`mcp__somora-memory__memory_search`. Tool input/output payloads ride
in the `details` field as pretty-printed JSON.

### `GET /chat/history`

Snapshot of past events for a session. The TUI and web both
hydrate this on open.

```bash
curl "https://<host>:18737/chat/history?agent=hans&session=main"
```

Pagination: pass `?limit=200` to get the last 200 events plus a
`hasMore` + `oldestTs` cursor; subsequent calls supply
`?before=<oldestTs>&limit=200` for older windows.

```json
{
  "agent": "hans",
  "session": "20260511-093251_research-notes",
  "events": [...],
  "hasMore": true,
  "oldestTs": 1715512000000
}
```

Event kinds: `user_message`, `assistant_message`, `tool_call`,
`tool_result`, `memory_inject`. Each carries `kind`, `ts`, and kind-
specific fields. Tool names are normalised here too.

### `POST /chat/abort`

Cancel an in-flight turn on a `(agent, session)`. Triggered by TUI
ESC and by the web equivalent.

```bash
curl -X POST https://<host>:18737/chat/abort \
     -H 'Content-Type: application/json' \
     -d '{"agent":"hans","session":"main"}'
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
curl "https://<host>:18737/agents/hans/memory/search?q=voice+satellites&limit=5&minScore=0.3"
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

## Dream system

The dream system runs in three phases (REM, Deep, Lucid) — see
[dream-phases.md](dream-phases.md) for the model. Some of these
endpoints surface state for monitoring; others trigger phases
manually.

### `GET /dream/loop-state`

Read-only snapshot of the active Lucid review loop, if any.

```json
{ "active": true, "agent": "hans", "dreamId": "lucid-...",
  "startedAt": "…", "lastActivityAt": "…" }
```

Returns `{ active: false }` when no loop is held.

### `GET /dream-states` ⚠ experimental

Per-agent REM state + server-global Deep / Lucid state. Drives the
web AgentDock pulse indicators and REM badges.

```json
{
  "rem": {
    "hans":  { "active": false, "pendingCount": 3 },
    "lisa":  { "active": true,  "pendingCount": 0 }
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
  "agent": "naxon",
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
curl -X POST https://<host>:18737/agents/naxon/sessions/main/project \
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
curl -X PUT https://<host>:18737/agents/hans/sessions/main/model \
     -H 'Content-Type: application/json' \
     -d '{"model":"claude-opus-4-7"}'

# 3. Subscribe to the stream (background)
curl -N "https://<host>:18737/chat/stream?agent=hans&session=main" &

# 4. Send a message — server fires the turn, events arrive on the stream
curl -X POST https://<host>:18737/chat/send \
     -H 'Content-Type: application/json' \
     -d '{"agent":"hans","session":"main","text":"Was steht heute an?"}'
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
