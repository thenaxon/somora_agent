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
  "memoryEmbedder": {
    "state": "ok",
    "provider": "local",
    "model": "all-MiniLM-L6-v2",
    "dim": 384,
    "error": null,
    "since": 1785496350120,
    "attempts": 1,
    "loadMs": 2373
  },
  "sharedIndex": {
    "state": "ready",
    "role": "owner",
    "path": "/home/me/.somora/index/shared.db",
    "files": 626,
    "chunks": 1466,
    "built_by": "seed:buffet"
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

`sharedIndex` is the vault/wiki retrieval index shared by all agents
([memory.md](memory.md#mental-model--memory-inbox)). `state` is
`ready` when agents read vault/wiki from it, `building` while the
first build after an update is still running (agents then still answer
from their own DB), `disabled` when no vault is configured, `failed`
with `error` when the DB could not be opened or built. `built_by`
says where the content came from: `seed:<agent>` (copied out of that
agent's DB on the first boot after the update) or `sweep` (embedded
from disk). `null` until the server has opened it.

`memoryEmbedder` is the health of the embedding model behind memory
retrieval (see [memory.md](memory.md#hybrid-retrieval-mechanics)). The
server loads it once at boot; `state` is `ok` when the model is loaded,
`loading` while the (first-run) download is in flight, and `failed` when
the last attempt threw — `error` then carries the reason. `failed` means
every agent's memory search is BM25-only until the next retry succeeds
(one retry per agent per minute, on search): the server keeps working,
but semantic recall and dream dedup are silently degraded, so treat a
persistent `failed` as an incident. The model cache lives under
`~/.somora/models/transformers/` and survives updates.

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

### `GET /tui-config` · `GET /mobile-config`

Display preferences for thin clients, read from config.yaml by the
server so no client parses the file itself. `/tui-config` returns
`{show: {memory, tools}, verbose: {tools, memory, system, thinking}}`
(the `tui:` block, see [display.md](display.md)); `/mobile-config`
returns `{show: {tools, memory}}` (the `mobile:` block). A custom
client is free to use either as its own defaults.

### `GET /env`

The environment overrides the running server resolved at boot, one
entry per variable: `{SOMORA_HOME, SOMORA_PORT, SOMORA_LOG_LEVEL,
SOMORA_CLAUDE_BIN, SOMORA_CODEX_BIN, SOMORA_CODEX_TOOL_TIMEOUT_SEC,
SOMORA_COMPACTION_TRIGGER_RATIO, SOMORA_COMPACTION_SAFETY_PAIRS,
SOMORA_COMPACTION_MODEL}`, each `{value, isDefault, note?}` — `value`
is what is in force, `isDefault` says the variable was unset or
invalid, `note` explains a fallback (e.g. "unset → uses config.yaml
server.port"). Diagnostic; see [setup.md](setup.md).

### `GET /tools`

List every tool registered on the server (the same tools agents see).
Useful for clients that want to surface a tool catalog.

```bash
curl https://<host>:18737/tools
```

Returns an array of `{ name, toolset, description, jsonSchema }`.

### `GET /agents/:agent/skills` · `PUT /agents/:agent/skills`

Per-agent skill visibility — the skills half of the web client's
Abilities matrix (the tools half is `GET/PUT /agents/:agent/tools`,
documented in [mcp.md](mcp.md)).

`GET` returns `{ agent, gating, hasPatternRules, skills: [{ name,
description, available, unavailableReason?, visible }] }` — every skill
installed on the instance, with `visible` telling whether this agent
sees it. `gating` is the agent's `skills:` section (`{deny, allow}`)
or `null`; `hasPatternRules` is true when it carries a hand-written
allow-list, which the UI shows read-only.

`PUT` takes `{ deny: string[], allow: string[] }` and rewrites only the
`skills:` block of the agent's `agent.yaml` (comments and the rest of
the file untouched; empty deny+allow removes the block). Names must
be skill names (`[a-z0-9-]`). Takes effect on the agent's next turn.
See [skills.md](skills.md#per-agent-visibility).

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

## Images

Present only when `imageGen.enabled` is set and at least one model is
configured; every route below answers `503` otherwise. See
[imagegen.md](imagegen.md) for configuration.

### `GET /images/status`

`{enabled, outputDir, maxImagesPerTurn, models: [{name, label, model, provider, defaults}]}`,
or `{enabled: false}`. Clients use this to decide whether to show an
image-generation surface at all.

### `GET /images`

Gallery listing, newest first. Query: `query` (prompt substring, case-
insensitive), `model`, `agent`, `since`/`until` (`YYYY-MM-DD`), `limit`
(default 60, max 200), `offset`.

Returns `{total, offset, images: [ImageRecord], totalBytes}`. `total`
is the unpaged count.

### `GET /images/:id`

One `ImageRecord`: prompt, model, specs, path, mime, bytes, cost,
agent, session, and any additional hardlinked locations.

### `GET /images/:id/file`

The image bytes, with the record's MIME. `410` when the record exists
but the file was moved or deleted outside somora.

Files are addressed **by record id, never by path** — the client cannot
name a file, so a user-chosen images directory does not turn this into
a way to read arbitrary files.

### `GET /images/models/:name/capabilities`

`{model, source: 'catalog'|'config'|'unknown', known, values, maxN, maxReferences, sizeAlsoAccepts, defaults}`. `sizeAlsoAccepts` lists named ratios the endpoint takes in `size` (`null` when it publishes none) — see the aspect-ratio note in [imagegen.md](imagegen.md).

`values` maps a spec field to its allowed values. **A field absent from
`values` has no known constraint** — clients should offer free input
there rather than an empty dropdown.

### `GET /images/catalog`

`{provider, models: [{id, name?}]}` — what the provider currently
offers. `?provider=<name>` selects the provider; defaults to the one
behind the first configured model. Read-only discovery aid; config
still decides what somora will call.

### `POST /images/generate`

Body: `prompt` (required), optional `model` (a configured handle) and
any specs — `resolution`, `aspect_ratio`, `size`, `quality`,
`output_format`, `background`, `output_compression`, `seed`, `n` — plus
optional `save_to` and `reference_images`.

`reference_images` is **base64 on this route** — a browser has the bytes
of a file the user picked and no server-side path for it. The
`image_generate` tool takes file paths instead, for the mirror-image
reason: an agent works on the same machine, and base64 in a tool
argument would mean loading a file into its context just to send it
straight back out.

Returns `{images: [ImageRecord], costUsd, warnings?, fellBackFrom?}`.
`warnings` carries anything the endpoint did differently than asked — a
size or aspect ratio it substituted (detected by measuring the returned
image, not by trusting the endpoint to report it), an `aspect_ratio`
that had to be sent as the closest `size` on the OpenAI wire (see
[imagegen.md](imagegen.md)), plus any `ignored_params` or `warnings`
the provider itself sent.
`fellBackFrom` is present only when a `fallback:` chain had to be
walked, and names the models that were unavailable.

`503` when the model is configured but not loaded right now (an image
backend commonly shares a GPU box that runs one profile at a time and
says so) — distinct from `502`, which means the endpoint misbehaved.

`400` for anything the caller can fix, with a message naming the field
and the values that would have worked. `502` when the upstream itself
failed.

### `DELETE /images/:id`

Forgets the record. **The file on disk is kept** — returns
`{ok, path, fileKept: true}`.

## Media

One gallery over everything somora generated — images and videos.
The `/images/*` routes above are the image-only view; these are the
medium-agnostic ones the web Media window and the mobile PWA use.

### `GET /media`

Query: `kind` (`image` | `video`; omit for both), `agent`, `query`
(prompt substring), `limit` (default 60, max 200), `offset`.

Returns `{total, offset, items: [MediaRecord], totalBytes}`. A
`MediaRecord` is `{id, kind, createdAt, prompt, modelName, modelId,
provider, specs, path, filename, mime, bytes, width?, height?,
durationSec?, thumbPath?, thumbMime?, linkedTo, costUsd?, agent?,
session?, references?, batchId, batchIndex}` — `kind` is absent on
records written before video existed and then means `image`;
`durationSec` and the thumbnail fields are video-only.

### `GET /media/:id`

One `MediaRecord`, `404` when unknown.

### `GET /media/:id/file`

The bytes with the record's MIME, `Content-Disposition: inline`
(`?download=1` forces `attachment`), immutable cache headers, and
**HTTP Range support** (`206` / `416`) so a video player can seek
without re-downloading. `410` when the record exists but the file
left the disk.

### `GET /media/:id/thumb`

A video's still image (`image/webp` unless the record says otherwise),
same headers as `/file`. `404` when the provider served no thumbnail.

### `DELETE /media/:id`

Removes the record. Returns `{ok: true}` or `404`.

## Video

Video generation runs as **jobs**: `POST` starts one and returns at
once, the render continues in the main server, the finished file
becomes a `MediaRecord`, and an agent that started the job is woken
with a `from_system: 'job'` turn. Enabled by `videoGen.enabled` in
config.yaml; see [videogen.md](videogen.md).

### `GET /video/status`

`{enabled: false, reason}` when video is off or no model is
configured. Otherwise `{enabled: true, active, limit, models:
[{name, label, model, provider, wire}], jobs: [VideoJob]}` — `active`
and `limit` are the concurrent-job slot (`videoGen.maxConcurrent`,
default 4). `?agent=<name>` limits `jobs` to that agent's. A `VideoJob`
is `{id, providerJobId, modelName, provider, prompt, specs, status,
progress?, queuePosition?, error?, createdAt, updatedAt, mediaId?,
path?, agent?, session?, references?}` with `status` one of `queued`,
`in_progress`, `completed`, `failed`; `mediaId` appears once the file
is stored and is what `/media/:id` takes.

### `POST /video/generate`

Body: `prompt` (required), optional `model` (a configured handle),
the specs `seconds`, `size`, `aspect_ratio`, `audio`, `quality`,
`seed`, optional `reference_images` (**base64**, as on
`/images/generate`), and optional `agent` + `session` naming who
should be woken when the job finishes.

Returns `{job: VideoJob}` immediately. `400` for a bad request, `429`
when all job slots are busy, `503` when the model is configured but
not available right now, `502` when the provider failed. Poll
`GET /video/status` or watch the session for the completion turn.

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

Read-only, no writes. This route answers *what a file is*; the bytes of
anything it cannot inline come from `GET /files/raw`.

**Query parameters**

| Name | Required | Description |
|---|---|---|
| `path` | yes | Absolute filesystem path. `~`-prefix is expanded server-side. Relative paths are rejected (no agent-context cwd here). |

**File kinds.** A known text extension decides how the text is
highlighted; everything else is classified from the file's magic bytes,
because an extension is a claim and not evidence — a `.dat` holding PNG
bytes is reported as an image. Nothing is refused for being the wrong
type: an unrecognised file still comes back described, with a download
link, which beats an error for a file the user can see referenced in
chat.

| | `kind` | Response carries |
|---|---|---|
| `.md`, `.markdown` | `markdown` | `content`, full Markdown render |
| `.txt`, `.log`, other text | `text` | `content`, monospace |
| `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.svg` | `code` | `content`, syntax highlighting |
| PNG / JPEG / GIF / WebP bytes | `image` | `url`, `mime` |
| MP4 / MOV / WebM bytes | `video` | `url`, `mime` |
| WAV / MP3 / OGG / FLAC / M4A bytes | `audio` | `url`, `mime` |
| PDF bytes | `pdf` | `url`, `mime` |
| anything else | `binary` | `mime` and a download link only |

`.svg` is listed as `code`, not as an image: it is markup that can carry
script, so it is shown as its own source rather than rendered.

Text responses are capped at 200 000 characters and set
`truncated: true` past that. Every response carries `downloadUrl`.

**Success response (200), text**

```json
{
  "path": "/home/user/somoraworkspace/somora_feedback/example.md",
  "kind": "markdown",
  "ext": ".md",
  "bytes": 4321,
  "content": "# Report\n…",
  "truncated": false,
  "downloadUrl": "/files/raw?download=1&path=…"
}
```

**Success response (200), media**

```json
{
  "path": "/home/user/somoraworkspace/shots/run-12.png",
  "kind": "image",
  "ext": ".png",
  "bytes": 184320,
  "mime": "image/png",
  "url": "/files/raw?path=…",
  "downloadUrl": "/files/raw?download=1&path=…"
}
```

**Error responses**

| Status | When |
|---|---|
| `400` | Missing `path` query, relative path, path is a directory or non-regular file |
| `403` | Policy blocked (path resolves under a blacklisted root or a denied somora-internal location) |
| `404` | File does not exist |

```bash
curl -G "https://<host>:18737/files/view" \
     --data-urlencode "path=/home/user/somoraworkspace/somora_feedback/example.md"
```

---

### `GET /files/raw`

The bytes behind a `/files/view` result: media the viewer displays
inline, and a download for every other type. Same path policy, applied
in the same two passes — the byte route is not a way around what the
metadata route refuses.

**Query parameters**

| Name | Required | Description |
|---|---|---|
| `path` | yes | Absolute filesystem path, as for `/files/view`. |
| `download` | no | `1` forces `Content-Disposition: attachment`, whatever the type. |

**Range requests are supported** (`Accept-Ranges: bytes`, `206` with
`Content-Range`, `416` past the end, and `bytes=-N` for a suffix). A
browser seeking inside a video depends on it; without Range, scrubbing
re-fetches the whole file. There is therefore no size cap.

`Content-Type` is taken from the magic bytes, never the extension, and
`X-Content-Type-Options: nosniff` is set so a browser cannot re-guess
it. `Content-Disposition: inline` is limited to image, video, audio and
PDF — anything else is served as an attachment, because a file
displayed inline runs on somora's own origin.

The path policy is the only boundary: files outside the workspace
(`/tmp/...` screenshots, for instance) are viewable as long as they are
not under a blocked root, which matches what `file_read` allows an
agent to see.

```bash
curl -G "https://<host>:18737/files/raw" \
     --data-urlencode "path=/home/user/somoraworkspace/shots/run-12.png" \
     -o run-12.png
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

Returns the persona part of the system prompt (`SOUL.md`, `AGENTS.md`,
`USER.md` with somora's headings) — `{agent, systemPrompt}`. For the
complete prompt as a turn sends it, use `/prompt-preview` below.

### `GET /agents/:agent/prompt-preview`

The system prompt exactly as the next turn on `?session=<slug|id>`
(default `main`) would send it, without running a turn or touching the
session:

```json
{ "agent": "hans", "session": "main", "text": "…", "chars": 16210,
  "parts": [{"key": "self", "label": "Self-pointer", "chars": 900},
            {"key": "persona", "label": "Persona (SOUL.md · AGENTS.md · USER.md)", "chars": 9340},
            {"key": "team", "label": "Team block", "chars": 2652}, …],
  "tools": {"count": 41, "schemaChars": 26510, "names": ["exec", …]},
  "budgets": {"teamBlockChars": 3000, "personaFileChars": 8000, "personaTotalChars": 14000},
  "notIncluded": ["tool schemas (…)", "memory recall injected per turn", …] }
```

`parts` concatenate to `text` (separators included), in prompt order:
self-pointer, persona, team, tool reminder, wiki overview, skills,
project. `tools` counts the tools this agent can see after gating and
the size of their JSON schemas — they travel on the API tool channel,
not in `text`, and engines load them direct or deferred. Read-only: a
session whose wiki overview was never snapshotted is rendered without
persisting the snapshot.

### `GET /agents/:agent/persona`

`{agent, files: [{name, exists, content, hash, chars, bytes, mtime,
readOnly}], budgets, totals: {personaChars}}` — `AGENTS.md`, `SOUL.md`,
`USER.md` (editable) and `agent.yaml` (`readOnly: true`). `hash` is the
optimistic lock for the write below; `budgets` is
`config.promptBudgets`.

### `PUT /agents/:agent/persona/:file`

Body: `{content, baseHash}`; `file` is one of `AGENTS.md`, `SOUL.md`,
`USER.md`. Writes only when `baseHash` equals the hash of the file
currently on disk — agents self-edit these files, so a stale save must
not overwrite theirs: `409 {error, currentHash, currentContent}` tells
the client to reload. `AGENTS.md` must keep a parseable frontmatter
whose `name` (when set) matches the agent directory and a non-empty
body (`400` otherwise). The previous version is kept as
`<file>.bak-<timestamp>` (last five); the write is atomic. Returns
`{ok: true, hash, backup, chars}`. The next turn uses the new text.

---

## Team

The org chart from `~/.somora/team.yaml` (see [team.md](team.md)).
Read-only over HTTP in this phase; the file is edited by hand.

### `GET /team`

`{enabled, path, exists, valid, issues, file?, principal?, rules?,
agents?, order?, unlisted?, missing?, warnings?}` — `file` is the parsed
document as written; `agents` (keyed by name: `{name, title, reportsTo,
involveFor, notFor, notes?, children, depth}`), `order` (pre-order
walk), `unlisted` (agents on disk missing from the file) and `missing`
(file entries without a directory) are the resolved view. `enabled:
false` with `exists: false` means no file; with `valid: false` the
`issues` say what is wrong (`{path, message}`), and the server keeps
the last valid team in force.

### `GET /team/preview/:agent`

`{agent, enabled, block, chars, softMaxChars}` — the exact `# Your
team` text that agent gets in its system prompt. `404` for an unknown
agent.

### `GET /team/check`

`{exists, valid, issues, warnings, unlisted, missing, blocks: [{agent,
chars, overSoftMax}], softMaxChars}` — what `somora team check` prints,
minus the persona scan.

### `PUT /team`

Body: the whole document as JSON (`{version: 1, principal, rules?,
agents}` — the same shape `GET /team` returns under `file`). The server
validates exactly like the loader; `400 {error, issues: [{path,
message}]}` writes nothing. On success the previous file is kept as
`team.yaml.bak-<timestamp>` (last five), the new one is written
atomically, the read cache is dropped, and the response is `{ok: true,
backup, …}` plus everything `GET /team` returns. Agents see the change
on their next turn.

### `POST /team/init`

Body: `{principal?: string}`. Writes a first document with every agent
on disk reporting to the principal (titles from the frontmatter, the
default rules spelled out). `409` when a file already exists — this
never overwrites. Returns the same shape as `GET /team`.

### `POST /team/preview`

Body: `{file, agent}` — a draft document and the agent to render for.
Returns `{agent, valid, issues, warnings, block, chars, softMaxChars}`;
an invalid draft comes back with `valid: false` and its `issues`, and
nothing is written. This is what the web Team window's live preview
uses.

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

Switching models mid-session is safe on every engine. On codex-cli the
thread simply continues under the new model (`thread/resume` takes the
model; Codex may compact the thread context once) and somora drops a
`model switch` marker into the conversation. The somora session (id, history, meta) is untouched;
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

Levels: `off`, `low`, `medium`, `high` — anything else is a `400`.
Per-model `reasoning.levels` in config.yaml decides which wire word
(`minimal`, `xhigh`, `max`, …) each level becomes; see
[thinking.md](thinking.md).

`GET` returns `{agent, session, effective, override, personaDefault,
source, modelSupportsReasoning, wire}`: `effective` is the level in
force (session override > persona default > `null` = engine default),
`source` says which of those won (`session-override` /
`persona-default` / `engine-default`), `modelSupportsReasoning` tells a
client whether the setting is live or dormant on the current model,
and `wire` is the value actually sent when it differs from the level
(e.g. `high` → `xhigh`). `PUT` answers `{agent, session, level}`,
`DELETE` answers `{agent, session, cleared: true}`.

The `GET …/model` payload is `{agent, session, provider, modelId,
alias, engine, contextWindow, source, override, personaDefault}` with
`source` `session-override` or `persona-default`; `PUT` answers
`{agent, session, model, resolved: "<provider>/<modelId>"}` and `400`
names an unknown model; `DELETE` answers `{agent, session, cleared:
true}`.

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


## External MCP servers

Status and control of the MCP hub (`mcp.servers` in config.yaml, see
[mcp.md](mcp.md)). All three answer `503` when no external server is
configured.

### `GET /mcp/status`

`{enabled: true, servers: {<name>: {state, toolCount, transport?,
lastError?, lastConnectedAt?, consecutiveFailures}}}` — `state` is
`pending`, `connected`, `failed`, `needs-auth` or `disabled`.

### `POST /mcp/servers/:name/reconnect`

Tears the connection down and reconnects immediately, resetting the
backoff. `{ok: true, status}` with the server's new status entry;
`400` when the name is unknown or the server is disabled in config.

### `POST /mcp/call`

Body: `server`, `tool` (the upstream tool name), `args` (object),
optional `timeoutMs`. Calls the tool through the hub and returns
`{isError, text, images: [{data, mimeType}]}`. `502` when the upstream
call failed. This is the loopback path somora's own MCP children use;
it bypasses per-agent tool gating, so treat it as an operator surface.

## Config reload + restart

```bash
curl -sk https://<host>:18737/config/status          # loadedAt, changedOnDisk, restartRequiredSections, restartAvailable
curl -sk -X POST https://<host>:18737/config/reload  # → { ok, changed: [...], restartRequired: [...] } or 400 with the schema issues
curl -sk -X POST https://<host>:18737/server/restart # → { ok, via: "systemd", expectedDowntimeSeconds } or 409 without a systemd unit
```

Reload validates the file first and keeps the running config on any
error. Sections listed in `restartRequiredSections` (server, memory,
obsidian, wiki, mcp, claudeCli, codexCli, stt, tts, sentinel, tmux,
web, mobile) are consumed at boot and only change after a restart; the
rest applies to the next request. See [web.md](web.md) for the taskbar
surface and the TUI's `/reload` / `/restart`.

## Sampling

Per-session sampling override (`temperature`, `top_p`, …), merged over
the agent's and the model's defaults. Only the `openai-compatible`
engine applies it — `engineSupportsSampling` tells clients whether the
setting is live or dormant. Full description in [sampling.md](sampling.md).

```bash
curl https://<host>:18737/agents/<your-agent>/sessions/main/sampling

curl -X PUT https://<host>:18737/agents/<your-agent>/sessions/main/sampling \
  -H 'Content-Type: application/json' -d '{"temperature":0.7}'      # merges; null drops a key

curl -X DELETE https://<host>:18737/agents/<your-agent>/sessions/main/sampling
```

Keys: `temperature`, `top_p`, `top_k`, `min_p`, `frequency_penalty`,
`presence_penalty`, `repetition_penalty`, `seed`, `stop`; an unknown key
or an out-of-range value is a `400` naming the field. `GET` returns
`{agent, session, effective, override, personaDefault, modelDefault,
source, engineSupportsSampling}` (`source` is `session-override`,
`persona-default`, `model-default` or `engine-default`). `PUT` merges
the body into the override and returns `{agent, session, override}`
(`null` once the last key is dropped); `DELETE` returns `{agent,
session, cleared: true}`.

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

### `DELETE /chat/queue/:turnId`

Take a queued **user** turn back before it starts. `:turnId` is the id
`POST /chat/send` returned. Nothing is written to the session — the
message never became a turn.

- `200 {ok: true, turnId, agent, session, text, attachments: [{hash,
  name, mime, size}]}` — the waiter is gone; the payload is handed
  back so the client can put it into its composer (attachment refs
  are still valid, no re-upload needed).
- `409 {ok: false, reason: "already_started"}` — the lock went to this
  turn meanwhile; it is running. `POST /chat/abort` is the tool now.
- `404 {ok: false, reason: "unknown"}` — nothing queued under that id
  (finished, never queued here, or an A2A/sentinel turn — those are
  not the human's to take back).

Side effects on success: a `turn_dequeued` SSE event for every open
client on the session, followed by fresh `turn_queued` events for the
waiters that moved up (their `ahead` shrank).

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

- `from_session` (optional, A2A) — the session the asking agent wrote
  from (id or `main`). Persisted as `user_message.from_session` and
  shown to the target in the attribution header
  (`[Message from agent hans, session cerebrocraft]`) so it can address
  a follow-up. Ignored without `from_agent`.
- `waiter_agent` / `waiter_session` (optional, A2A) — identify the
  caller turn that blocks on this request. Used by `agent_ask` and
  `spawn_subagent` internally to register the wait in the server's
  deadlock guard; set both or neither.
- `create_session` (optional, default false) — when `session` is a
  named slug that does not exist on the target yet, create it (with
  the standard timestamped id) and deliver the message into it. Only
  slugs: `main` always exists, exact ids and `sub-*` names answer
  `400`. The target's first message is prefixed with a bracketed note
  that the session was just created (and on which model).
- `create_model` (optional, with `create_session`) — alias or
  `provider/id` pinned on the session **if this call creates it**
  (same effect as `PUT …/sessions/:session/model`). An unknown model
  is `400 {error, known_models}` and nothing is created. When the
  session already exists the model is ignored and the response
  carries `session_note` saying so.

The success response is the turn result plus `session_id` (the
resolved id), `session_created: true` and `session_model` when this
call created the session, or `session_note` when `create_model` was
ignored.

An unknown `session` answers `404` with the target's existing,
non-archived session slugs, so a caller that guessed wrong can correct
itself instead of retreating to `main`:

```json
{ "error": "session 'cerebro' not found for agent 'hans'",
  "known_sessions": ["main", "cerebrocraft", "somora-dev"] }
```

When `waiter_*` are present and the request would close a wait cycle
(the target is already — directly or through a chain of waits —
blocked on the caller), the server responds `409` instead of
deadlocking:

```json
{ "error": "circular A2A wait: …", "circular_wait": true,
  "chain": ["scribe/main", "coach/main", "scribe/main"] }
```

Response on success: the full turn result (`finalText`, `usage`,
`model`, `ms`, …).

### Sub-agent tasks — `/spawn-*`

The HTTP twins of the `spawn_subagent` / `subagent_*` tools. Agents
running in an MCP child (claude-cli, codex-cli) reach the task store
this way; a custom client can use them to run a sealed background
task in a fresh session and collect the result.

#### `POST /spawn-async`

Body: `agent` and `session` (required — a slug that does not exist is
created with the standard timestamped id; an exact id that is gone is
a `404`), `text` (the task), optional `from_agent`, `parent_agent` +
`parent_session` (who to report back to; default the caller),
`subagent_depth`, `model` (override), `max_rounds`, `attention`
(`false` suppresses the `[subagent attention]` wake of the parent).

Returns `202 {task_id}` at once; the turn runs in the background under
the target session's lock. `429` when the per-agent concurrent spawn
cap is full.

#### `GET /spawn-status?task_id=…`

`{task_id, state, parent_agent, parent_session, target_agent,
target_session, started_at, finished_at?, error?}` — `state` is
`running`, `done`, `failed` or `cancelled`. `404` for an unknown id.

#### `GET /spawn-result?task_id=…`

Same fields plus `result` (the full turn result: `finalText`,
`outcome`, `tool_calls`, `files_written`, `media`, `usage`, …) once
terminal. `wait_until_done=1` + `timeout_ms` block server-side; with
`waiter_agent` / `waiter_session` the wait joins the deadlock guard
and a cycle answers `409 {circular_wait: true, chain}`.

#### `GET /spawn-list?parent_agent=…`

`{tasks: [entry]}` — every task this agent spawned since server start
(the store is in-memory).

#### `POST /spawn-cancel`

Body: `task_id`, `requesting_agent` (must be the spawning agent —
otherwise `403`), optional `reason`. Aborts the running turn and
cascades to child spawns; returns `{cancelled: [task_ids],
skipped: [{task_id, state}]}` (tasks that were already terminal are
skipped). Disk artifacts stay.

### `GET /a2a/ask-result`

Outcome of an `agent_ask` call by `call_id` — backs the
`agent_ask_result` tool.

```
GET /a2a/ask-result?call_id=<uuid>
GET /a2a/ask-result?call_id=<uuid>&wait_until_done=1&timeout_ms=300000
GET /a2a/ask-result?call_id=<uuid>&agent=<target>&session=<slug>    # after a restart
```

```json
{ "call_id": "…", "state": "done", "target_agent": "hans",
  "target_session": "20260906-172957_cerebrocraft", "started_at": 1788…,
  "finished_at": 1788…, "response": "…", "outcome": "completed", "source": "registry" }
```

`state` is `queued` (behind another turn on the target session),
`running`, `done` or `failed`. The live registry is fed by
`/chat/send-sync`; when it has no record (server restarted since the
call) pass `agent` + `session` and the route reads the target's JSONL
(`user_message.agent_ask_call_id`) — `source: "history"`, and `state`
becomes `unknown` when the turn never reached `turn_end`. With
`wait_until_done` the request blocks until the call finishes or
`timeout_ms` passes; `waiter_agent` / `waiter_session` register the
wait in the deadlock guard, and a cycle answers `409` with
`circular_wait: true` like `/spawn-result`.

### `GET /a2a/turn-origin/:agent/:session`

Who started the turn currently running on `agent/session`: the A2A
asker (`from_agent`/`from_session` of the live turn) or, for a
sub-agent session, the spawning parent from its spawn meta.

```json
{ "origin": { "agent": "hans", "session": "20260906-172957_cerebrocraft", "kind": "a2a" } }
{ "origin": null }
```

`agent_ask` calls this when its `session` argument is omitted: if the
target is the origin agent, the message goes back to the origin
session instead of `main` (logged as `agent_ask.session_inferred`,
reported as `session_inferred: true` in the tool result). An explicit
`session` always wins.

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
- `user_message` — `{text, ts, turnId?, from_agent?, from_session?,
  from_system?, agent_ask_call_id?}` — broadcast when a turn's user_message is
  written to JSONL. Self-typed sends, A2A inbounds, and system wakes
  all flow through here; `from_system` is one of `sentinel`, `tmux`,
  `subagent`, `job`, `browser`. `turnId` lets a sending client
  match this event to the optimistic bubble it rendered after
  `POST /chat/send` (which echoes the same id).
- `turn_queued` — `{turnId, ahead}` — fired when `POST /chat/send`
  hit a busy lock and the turn had to wait. `ahead` is the number
  of turns this one must wait for (≥1, includes the currently-
  running one). Static snapshot at enqueue time, not updated as
  the queue drains — except after a `DELETE /chat/queue/:turnId`,
  which re-emits it for the waiters that moved up. Clients render
  `"queued · N ahead"` until the matching `user_message` event
  arrives (= the turn is now actually running, lock acquired).
- `turn_dequeued` — `{turnId}` — a queued user turn was taken back
  via `DELETE /chat/queue/:turnId`. Clients drop the optimistic
  bubble for that id.
- `turn_started` — `{turnId}` — the engine opened the turn; this is
  the engine's own id (`t-…`), the one `assistant_media`,
  `assistant_audio`, `turn_error` and the session file's `turn_end`
  carry. Clients stamp the assistant bubble they are about to build
  with it, so artifacts that arrive after the turn closed pair to
  THIS turn instead of "the most recent bubble".
- `turn_error` — `{turnId?, message, engine}` — the turn ended with an
  error instead of (or after) an assistant message. The `status`
  event still carries the same text (`error: …` / `turn failed: …`)
  for older clients; this one adds the turn id so the failure can be
  rendered as a block inside the right turn.
- `tool` — `{phase: 'call'|'result'|'error', tool, summary?,
  details?, error?}` — tool-call events
- `thinking` — `{state: 'delta'|'final', text, truncated?}` — the
  model's reasoning text, cumulative deltas like `chat`; the `final`
  precedes the `chat` final of the same turn. Only engines that surface
  thinking send it; `thinkingContent.capture: false` in config.yaml
  suppresses it entirely. See [thinking.md](thinking.md).
- `engine_meta` — `{engine, itemType, label, summary?, payload}` —
  engine-internal side-channel state. The canonical case is codex's
  `todo_list` (an internal plan/checklist the model updates mid-turn)
  — somora persists these so memory / REM-dream can read them later
  and clients can optionally render them. `label` is server-resolved
  (e.g. `todo_list` → `"plan"`); unknown item-types fall back to the
  raw `itemType`. `payload` is the engine's original event, opaque.
  Besides engine-native items, somora emits its own: `model_switch`
  (codex thread continued under a new model), `thread_recreated` (the
  Codex thread no longer existed; a fresh one was started with the
  session history replayed), `tools_changed` (the agent's tool set
  changed — Abilities toggle, hub server, review loop, update — and
  Codex threads keep their tools, so a fresh thread was started with the
  history replayed), `mcp_server_renamed`
  (engine session rebuilt after somora's MCP server rename, label
  "session restarted"), `context_compacted` (history compacted after a
  context overflow), `reasoning_effort_adjusted` and `sampling_dropped`
  (backend rejected the parameter, turn retried without it). Each
  carries a human-readable `payload.text`.
- `model_fallback` — `{requested, actual, reason, hops?}` (refs are
  `provider/modelId`) — the persona's primary model failed before
  producing anything and a configured `fallback:` model is answering
  this turn. `requested` is always the primary, `actual` the model
  now answering, `reason` the failure that triggered this hop. `hops`
  lists every model that failed so far, in order
  (`[{model, reason}, …]`, primary first) — with a fallback chain
  (`fallback: [a, b]`) one event is sent per hop and the last one
  carries the whole chain. Sent before the fallback's first delta;
  the following `agent` phase:'end' also carries `fallback` (same
  shape) and reports the ACTUAL `provider`/`model`. Persisted to
  history as the same kind, so a reload keeps the marker on that turn.
- `memory` — `{count, topScore?, refs, fullText}` — the memory recall
  injected into this turn: number of hits, best fused score, the
  `source/slug` refs, and the full `<memory-context>` block text.
  Sent after `agent` phase:'start'; `count` is `0` with empty `refs`
  when recall found nothing.
- `status` — `{msg}` — connection events, error notices
- `heartbeat` — current ms timestamp, every `sse.heartbeatMs` (20 s). The
  server watches these writes: one that fails or stays pending for
  `sse.deadAfterMs` (60 s) marks the stream dead — it is closed and its
  socket destroyed, logged as `sse.disconnect {reason: 'dead'}`. On the
  TLS listener every HTTP/2 session is also PINGed (`sse.h2PingIntervalMs`)
  and destroyed when it stops answering (`sse.h2PingTimeoutMs`), and every
  socket carries TCP keepalive — a tab that vanished without closing is
  gone server-side in about a minute instead of never.

Tool names are normalised through the same path the wire serializer
uses — clients receive `memory_search`, not
`mcp__somora__memory_search`. Tool input/output payloads ride
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
  - `user_message` with `from_system` set (`sentinel`, `tmux`,
    `subagent`, `job` or `browser` woke us)
  Plain self-typed user messages, tool / memory / engine_meta events,
  and lifecycle (`agent:start`, `agent:end`) are excluded.
- `seen` — `{agent, session, seenAt}` — broadcast when any client
  POSTs `/sessions/:agent/:session/seen`. Sibling clients clear
  their unread badge for that session.
- `status` — `{msg}` — connection lifecycle.
- `heartbeat` — current ms timestamp, every `sse.heartbeatMs`; same
  liveness rules as `/chat/stream`.

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

Rows are the session's JSONL events in order. A turn with thinking
carries one `thinking_message` row (`{kind, ts, engine, text,
truncated?}`) directly before its `assistant_message`; clients fold it
onto that bubble.

```bash
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

### `POST /agents/:agent/memory/recall-preview`

What auto-inject would recall for a message in a given conversation
state — the turn's own recall path (query construction, history blend,
search, block budget) without running a turn. Body:

```json
{
  "text": "und wer gehört sonst noch zur familie?",
  "history": [
    { "kind": "user_message", "text": "was kannst du mir über walter erzählen?" },
    { "kind": "assistant_message", "text": "Walter ist …" }
  ],
  "autoInject": { "historyWeight": 0.4 }
}
```

`history` is optional (oldest first; only `user_message` and
`assistant_message` entries count). `autoInject` optionally overrides
any `memory.autoInject` knob for this call only — for measuring a
setting before changing config.yaml. Response: `hits` with `slug`,
`source`, `score`, `vecScore`, `bm25Score`, line range, plus
`injectedCount` and `ephemeralContextChars`. Used by the recall replay
harness; loopback-only like every debug route.

### `GET /agents/:agent/memory/search`

Hybrid (BM25 + vector) search over the agent's own memory notes plus
the shared vault/wiki index — the same `MemoryManager.search` the
`memory_search` tool and auto-inject use: filler words are dropped
from the keyword side, a page whose slug names a query word is boosted
(`memory.hybrid.slugMatchBoost`), see [memory.md](memory.md). No
history blend here — that is auto-inject's, use `recall-preview` above
to see a turn's actual recall.

```bash
curl "https://<host>:18737/agents/<your-agent>/memory/search?q=voice+satellites&limit=5&minScore=0.3"
```

Query params: `q` (required), `limit` (1–50, default 5), `minScore`
(0..1, default 0 — the route shows everything; auto-inject applies
`autoInject.minScore`).

Returns `{ agent, query, limit, minScore, count, hits: [...] }`; each
hit carries `slug`, `source` (`memory` | `wiki` | `vault`), `score`
(fused, min-max normalised within this query's candidates — a rank,
not a similarity), `vecScore`, `bm25Score`, `startLine`, `endLine`,
`filePath` and the chunk `text`.

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
  "links":       [{ "slug": "personen/jane-doe", "title": "Jane" }],
  "backlinks":   [{ "slug": "agenten/<your-agent>", "title": "Your Agent" }],
  "unresolved":  ["personen/familie-doe"],
  "linkTargets": { "personen/jane-doe": "personen/jane-doe",
                   "familie-doe": null }
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

## Browser — shared managed Chromium

Served by the somora web server. See [browser.md](browser.md). Mutating
HTTP routes answer `503` while `browser.enabled` is false; status and
the change stream return `{enabled:false,browsers:[],warnings:[]}`.
The viewer WebSocket refuses attachment when disabled.

### `POST /browser/op`

Run one `browser` tool operation for an agent — the path the MCP tool
child takes for claude-cli/codex-cli turns, because the Chromium lives
in the server process. Body `{ agent, session?, input }` where `input`
is the tool's argument object (`{ op: "open", url }`, `{ op:
"snapshot", tab }`, …). Returns the tool's result object (`ok`,
`error`, `hint`, `tab`, `snapshot`, …), never a non-2xx for a tool-level
refusal.

### `GET /browser/status`

`{ enabled, headed, browsers: [{ browser_id, profile, ephemeral, state,
control, human_by?, handoff?, tabs: [{ tab_id, url, title, agent, session?,
generation, emulation? }], last_used, headed? }], warnings }` — every
running browser plus previously stopped profiles. `control` is
`agent_control`, `handoff_requested`, `human_control` or `paused`.
`headed` is the host plan for `browser.headed` (`headless`, `display`,
`xvfb`, `unavailable`); `warnings` lists what the operator must fix
(no Chromium found, headed configured but no display and no Xvfb).
`emulation` shows a tab's `device` / `locale` from `open`.

### `GET /browser/stream`

SSE events `browsers` contain `{enabled,browsers,warnings}` with the same
browser entries as `/browser/status`. Every connection starts with a
complete snapshot; later events replace it. `heartbeat` follows the
normal SSE liveness settings. Slow readers receive coalesced snapshots;
stalled writes terminate the connection.

### `POST /browser/:id/restart`

Explicitly reopen a known stopped browser with a blank page and the
same profile. No old navigation or input is replayed. Pending handoffs
remain pending. Returns `{ok:true}` or `409` with `{error}` when recovery
is refused (unknown browser or removed shared-profile configuration).

### `POST /browser/:id/control`

Body `{ mode: "human" | "agent", by?, handoffId? }`. `human` takes
control: every agent op on that browser is refused until handed back.
`agent` hands it back; with a pending handoff the requesting agent is
woken once in its session (pass the `handoffId` from the status so a
stale button press after a newer handoff does not wake twice). `404`
when the browser is not running, `409` on a state conflict. A mismatched
handoff ID is refused; a duplicate completed ID does not release a newer
manual takeover. With `by`, a different current controller cannot be
handed back. The web client sends control over its viewer WebSocket so
the identity matches subsequent input. Wake dispatch is not a durable
queue; see the recovery limitations in [browser.md](browser.md).

### `GET /browser/attach` (WebSocket)

`?browser=<id>&tab=<tabId>&viewer=<id>` — the live view behind the web
client's browser window. Binary frames carry one JPEG each:
`[u32 BE header length][JSON header][JPEG]`, header `{ tabId,
generation, seq, url, cssWidth, cssHeight, scrollX, scrollY, ts }`.
Frames are ack-paced (`browser.stream.maxFps`, default 15, at most 20 fps) and skipped for a viewer whose
socket has more than 2 MB pending. Text frames (JSON):

- server → viewer: `ping` (answer `{"type":"pong"}`; 80 s of silence
  drops the socket), `ready` `{browser, tabId, viewerId}` after attach
  or a tab switch, `tabs` `{browser}` whenever tabs or control changed,
  `control` `{control}` after a control request, `notice`/`error`
  `{text}`.
- viewer → server: `control` `{mode:"human"|"agent", handoffId?}`,
  `tab` `{tabId}` (switch the streamed tab), and — only while this
  viewer holds human control — `navigate` `{url}` (same policy as the
  tool), `newtab`, `closetab` `{tabId}`, `resize` `{width,height}`,
  `mousemove`/`click`/`mousedown`/`mouseup` `{x,y,button?,clickCount?}`
  in CSS pixels of the streamed viewport, `wheel` `{x,y,deltaX,deltaY}`,
  `text` `{text}` (composed text incl. paste; CDP `Input.insertText`),
  `key` `{key, ctrl?, alt?, shift?, meta?, action?}` (Playwright key
  names, e.g. `Enter`, `Control+a`), `back`, `forward`, `reload`. Input
  from a viewer without control gets a `notice`, nothing is applied.
  Input other than `navigate`, `newtab`, `closetab`, `tab` and `control`
  must also carry `frameTab` and `generation` from the displayed frame;
  obsolete metadata is refused. Messages above 64 KiB and queues above
  64 commands close the connection.

Close codes: `1008` bad request (unknown browser, disabled), `4000`
heartbeat timeout, `4001` tab closed, `1009` oversized input, `1012` server
shutdown. `1008` also covers excessive pending input.

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
so the web app's `fetch('/agents')` works without CORS. `GET /web`
(no slash) redirects here.

### `GET /mobile/`

Serves the mobile PWA from `web-mobile/dist/` the same way; `GET
/mobile` redirects to it. Both bundles are static files — a custom
client does not need them, every function they use is in the routes
above.

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
