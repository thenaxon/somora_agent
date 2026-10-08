# HTTP API

Every somora client talks to the same server over HTTP, Server-Sent
Events and WebSockets: the terminal client, the web client, the mobile
app and anything you build yourself. This page lists every route and
every stream event, so you can write your own client from it.

## What you get

- **One surface for all clients.** What the shipped clients can do, your
  client can do: there are no private routes.
- **Send and follow.** Post a message, then read the reply as it is
  written, tool call by tool call.
- **Everything about a session**: history, queue, model, thinking
  level, project, unread state.
- **The machinery behind the agents**: memory search, wiki, dream
  phases, triggers, browser, media, voice.
- **No login to implement.** Whoever reaches the port may use it. Read
  "Access model" before you open that port to anyone.

## First request

List the agents, open the stream of one session, then send a message.
The reply arrives on the stream.

```bash
BASE=https://<your-host>:18737

# 1. Who is there?
curl $BASE/agents

# 2. Follow the session (keep this running)
curl -N "$BASE/chat/stream?agent=<your-agent>&session=main" &

# 3. Send a message
curl -X POST $BASE/chat/send \
     -H 'Content-Type: application/json' \
     -d '{"agent":"<your-agent>","session":"main","text":"What is on today?"}'
# → 202 { "ok": true, "turnId": "…" }
```

On the stream you now see `user_message`, `agent` with `phase: "start"`,
`chat` deltas, perhaps `tool` events, a `chat` event with
`state: "final"` and `agent` with `phase: "end"`.

A fuller client usually does this:

| When | Calls |
|---|---|
| On start | `GET /agents`, `GET /sessions`, `GET /version`, one `GET /activity/stream` |
| Per open chat window | `GET /chat/history?limit=200`, one `GET /chat/stream` |
| On input | `POST /attachments` per file, then `POST /chat/send` |
| On Stop | `POST /chat/abort` |
| To show the queue | `GET /agents/:agent/sessions/:session/work` |

If you do not want to handle a stream, `POST /chat/send-sync` waits for
the turn and returns the reply in the response.

## Conventions

| Topic | Rule |
|---|---|
| Base URL | `https://<your-host>.<your-tailnet>.ts.net:18737` with HTTPS set up, else `http://127.0.0.1:18737`. The web client is under `/web/`, the mobile app under `/mobile/`. |
| Bodies | JSON in, JSON out (`Content-Type: application/json`), unless a route says otherwise. Uploads are raw bytes or `multipart/form-data`, as noted per route. |
| Errors | A non-2xx response carries `{ "error": "<message>" }`. The message is written for a person. Some routes add fields, noted per route. |
| Unknown agent or session | `404` on every route that takes one. |
| Times | Epoch milliseconds as numbers, or ISO 8601 strings. The examples show which. |
| Streams | Server-Sent Events with named events. `data` is always JSON. |

### Session references

A session id has the form `<YYYYMMDD>-<HHMMSS>_<slug>`. Every agent
also has the session `main`, which always exists. Where a route takes
`:session` or a `session` field, it accepts a reference and resolves it
in this order:

1. `main`
2. an exact id
3. a session stored under exactly that name
4. the newest session with that slug

An unknown reference is refused. It is never resolved to a similar
name. Responses carry the resolved id.

### Polling

Routes that report live state only read memory and are cheap. The
shipped clients poll the dream loop every 2 seconds, the dream phases
every 30 seconds and the session list every 60 seconds. Prefer the two
streams where they cover what you need.

## Access model

There is no API key, no login and no per-route permission. The server
trusts every request that reaches it. Access is decided by the network:
bind to `127.0.0.1`, or to a private network such as a tailnet whose
rules say who may connect.

> **Warning:** Never expose the port to the public internet. Anyone who
> reaches it can read all memory and sessions and act as any agent.

The API can do what an agent can do: write memory, switch models, start
dream runs, run tools. The security page describes the trust boundary
and how to check your setup.

## Stability

- The version from `GET /version` is calendar based and valid semver:
  `2026.1001.2` is the second build of 1 October 2026.
- The routes on this page are used by the shipped clients and are kept
  stable.
- A route marked **experimental** may change shape in any build. Pin a
  somora version if your client depends on one.
- New fields may appear in any response and any event. Ignore what you
  do not know.

## Core

### `GET /version`

The running version and what the daily update check found.

```json
{ "version": "2026.1001.2",
  "update": { "latestVersion": "2026.1005.1", "available": true, "note": "update Node first" } }
```

| Field | Meaning |
|---|---|
| `version` | The running build. |
| `update` | `null` until the first check has answered, or when the check is switched off. |
| `update.latestVersion` | The newest published version. |
| `update.available` | `true` when `latestVersion` is newer than `version`. |
| `update.note` | Optional hint that comes with the release. |

### `GET /healthz`

Liveness probe. Answers the plain text `ok` with status 200. Use it to
wait for the server to come up.

### `GET /health`

A snapshot for diagnosing a session that seems stuck: which session is
busy, since when, what waits behind it, and when the last event went
out. Read-only and cheap.

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
  "claudeAuth": { "enabled": true, "userExists": true, "somoraExists": true,
                  "identical": true, "userExpiresAt": 1785503549000,
                  "somoraExpiresAt": 1785503549000,
                  "lastSyncResult": "noop", "lastSyncAt": 1785496349000 },
  "memoryEmbedder": { "state": "ok", "provider": "local", "model": "all-MiniLM-L6-v2",
                      "dim": 384, "error": null, "since": 1785496350120,
                      "attempts": 1, "loadMs": 2373 },
  "sharedIndex": { "state": "ready", "role": "owner",
                   "path": "/home/me/.somora/index/shared.db",
                   "files": 626, "chunks": 1466, "built_by": "sweep" },
  "sessions": [
    {
      "agent": "<your-agent>", "session": "main",
      "busy": true, "activePriority": "user",
      "activeSince": 1778757036447, "activeAgeMs": 1024,
      "activeCallId": null, "activeTurnId": "b5b7a734-…",
      "queueLength": 1, "userWaiting": 0, "agentWaiting": 1,
      "queued": [
        { "id": "3f0c2b1e-…", "kind": "agent",
          "preview": "Can you check whether the build log mentions …",
          "enqueuedAt": 1778757040112, "position": 1 }
      ],
      "lastEngineEventAt": 1778757036900, "lastEngineEventAgoMs": 571,
      "subscriberCount": 2,
      "lastPublishOkAt": 1778757036900, "lastPublishOkAgoMs": 571
    }
  ]
}
```

Per session:

| Field | Meaning |
|---|---|
| `busy`, `activeSince`, `activeAgeMs` | Whether a turn runs, and for how long. |
| `activePriority` | `user` for a person typing or dictating, `agent` for everything else. A label only: the queue is first in, first out. |
| `activeTurnId` | Set for every running turn, whatever started it. Stop it with `POST /chat/abort`. |
| `activeCallId` | The call id when the running turn is another agent's question, else `null`. |
| `queueLength`, `userWaiting`, `agentWaiting` | How many turns wait, in total and by label. |
| `queued` | The waiters in order: `id`, origin `kind`, the first 160 characters as `preview`, `enqueuedAt`, `position` (1 is next). Any `id` can go to `DELETE /chat/queue/:id`. |
| `lastEngineEventAt`, `lastEngineEventAgoMs` | When the engine last produced an event. A value that keeps growing during a chat turn means the turn hangs. The engine watchdog then aborts it (`engineWatchdog` in the config). |
| `subscriberCount` | Clients connected to this session's stream. |
| `lastPublishOkAt`, `lastPublishOkAgoMs` | When an event last reached the subscribers. If it grows while `subscriberCount` is above 0, one client is stuck. The next event removes it after `sse.publishTimeoutMs`. |

Top-level blocks:

| Block | Meaning |
|---|---|
| `claudeAuth` | State of the login shared between `~/.claude` and somora's own Claude folder. Expiry times only, never tokens. `identical: false` with both sides present means they have drifted apart. If that stays, run `somora auth status`. |
| `memoryEmbedder` | The embedding model behind memory search. `state` is `ok`, `loading` or `failed`. With `failed`, `error` says why and every search is keyword only until a retry succeeds. |
| `sharedIndex` | The search index over vault and wiki that all agents share. `state` is `ready`, `building`, `disabled` (no vault configured) or `failed` with `error`. `built_by` is `seed:<agent>` or `sweep`. `null` until the server has opened it. |

### `GET /host-stats`

CPU load and memory of the machine somora runs on.

```json
{
  "cpu": { "loadAvg1": 0.42, "cores": 6, "percent": 7.0 },
  "mem": { "totalBytes": 25186074624, "availableBytes": 23197777920,
           "usedBytes": 1988296704, "percent": 7.9 }
}
```

| Field | Meaning |
|---|---|
| `cpu.percent` | The 1-minute load average divided by the core count, as a percentage. Not capped: above 100 means overload. |
| `mem.availableBytes` | Memory the system can hand out without swapping. Linux reads `MemAvailable` from `/proc/meminfo`, macOS adds free, inactive and speculative pages from `vm_stat`. Elsewhere it is the free memory the runtime reports. |
| `mem.usedBytes` | `totalBytes` minus `availableBytes`. |

### `GET /env`

The environment overrides the running server resolved at start. One
entry per variable, each `{value, isDefault, note?}`.

| Field | Meaning |
|---|---|
| `value` | What is in force. |
| `isDefault` | The variable was unset or invalid. |
| `note` | Explains a fallback, for example that an unset `SOMORA_PORT` means `server.port` from `config.yaml`. |

The variables: `SOMORA_HOME`, `SOMORA_PORT`, `SOMORA_LOG_LEVEL`,
`SOMORA_CLAUDE_BIN`, `SOMORA_CODEX_BIN`, `SOMORA_CODEX_TOOL_TIMEOUT_SEC`,
`SOMORA_COMPACTION_TRIGGER_RATIO`, `SOMORA_COMPACTION_SAFETY_PAIRS`,
`SOMORA_COMPACTION_MODEL`, `SOMORA_COMPACTION_WORKERS`.

### `GET /tui-config` · `GET /mobile-config`

Display preferences for clients, read from `config.yaml` by the server
so that no client parses the file itself.

| Route | Returns | Config block |
|---|---|---|
| `GET /tui-config` | `{show: {memory, tools}, verbose: {tools, memory, system, thinking}}` | `tui:` |
| `GET /mobile-config` | `{show: {tools, memory}}` | `mobile:` |

A custom client may use either as its own defaults.

### `GET /logs`

The tail of the server log for one day.

| Query | Default | Meaning |
|---|---|---|
| `day` | newest file | `YYYY-MM-DD`. A day, never a path. |
| `minLevel` | none | Lowest level to include: 20 debug, 30 info, 40 warn, 50 error. |
| `q` | none | Substring to find in the raw line, case-insensitive. |
| `agent` | none | Only lines of this agent. |
| `limit` | 300 | At most 2000. |

Returns `{day, days, lines: [{ts, level, msg, agent?, session?, fields}], offset, truncated}`.
`days` lists every day that has a file, newest first. `offset` is the
byte position to continue from. `truncated` says older lines lay
outside the window: only the last 512 KiB of the file are read.

### `GET /logs/since`

What was appended to the log after a position: the follow path for a
log view.

| Query | Meaning |
|---|---|
| `offset` | Byte position from the last response. Default 0. |
| `day`, `agent`, `q`, `minLevel` | As for `GET /logs`. |

Returns `{lines, offset, day}`. When the file shrank, the offset snaps
back to its real size.

## Config and restart

### `GET /config/status`

Whether `config.yaml` changed on disk since the server loaded it,
whether the file is valid, and whether the server can restart itself.

```json
{ "invalid": null,
  "path": "/home/me/.somora/config.yaml",
  "loadedAt": "2026-05-14T11:09:08.429Z",
  "changedOnDisk": false,
  "restartRequiredSections": ["server", "memory", "obsidian", "wiki", "mcp",
    "claudeCli", "codexCli", "stt", "tts", "sentinel", "updateCheck",
    "tmux", "web", "mobile"],
  "restartAvailable": true }
```

`restartRequiredSections` are the config sections that are read at
start and only change after a restart. `restartAvailable` is `true`
when somora runs as a background service (systemd user unit on Linux,
LaunchAgent on macOS).

`invalid` is `null` while the file on disk validates. Otherwise it is
`{since, message}`: the file does not validate, somora keeps running on
the last valid version, `since` is when this version of the file was
first seen and `message` lists the problems. The route checks the file
on every call.

### `POST /config/reload`

Reads `config.yaml` again. The file is checked first: on any error the
running config stays in force.

| Status | Body |
|---|---|
| `200` | `{ok: true, changed: [...], restartRequired: [...], loadedAt}`. `changed` lists the sections that differ, `restartRequired` those of them that need a restart. |
| `400` | `{ok: false, error}` with the schema problems. Nothing was changed. |

A reload also forgets every "model unavailable" mark, like
`POST /models/availability/reset`.

### `POST /server/restart`

Restarts the server through its service manager: the systemd user unit
on Linux, the LaunchAgent on macOS. Without a body the restart happens
at once.

| Status | Body |
|---|---|
| `200` | `{ok: true, via: "systemd" \| "launchd", expectedDowntimeSeconds: 8}` |
| `409` | `{ok: false, error}`: somora was started by hand, so nothing would bring it back. Restart it the way you started it. |

### A restart requested from inside a turn

An agent that restarts somora from its own turn would cut that turn
off. The route therefore takes the requester in the body and waits.

```bash
curl -X POST $BASE/server/restart \
     -H 'Content-Type: application/json' \
     -d '{"agent":"<your-agent>","session":"main","reason":"config change"}'
# → { "ok": true, "deferred": true, "via": "systemd", "message": "…" }
```

| Field | Required | Meaning |
|---|---|---|
| `agent` | yes | The agent that asks. |
| `session` | yes | The session it asks from. |
| `reason` | no | Free text, at most 300 characters. Shown to the agent after the restart. |

What happens:

1. The request is written to `~/.somora/restart-intent.json`.
2. The server waits until that session's turn has ended, at most 10
   minutes.
3. Turns in other sessions get 30 more seconds. What still runs is cut
   and marked in its session.
4. The server restarts.
5. After start, the session is woken with a turn whose text begins
   `[system: restart]` and says the restart is done. Its origin is
   `{kind: "wake", about: "system", cause: "restart"}`.

| Status | Body |
|---|---|
| `200` | `{ok: true, deferred: true, via, message}` |
| `200` | `{ok: true, deferred: true, already: true, via, requestedBy, message}` when a restart is already scheduled |
| `404` | `{ok: false, error}` for an unknown agent |
| `409` | `{ok: false, error}` when somora does not run as a service |

`somora server restart` and `somora update` send this request when an
agent runs them through `exec`. The tool sets `SOMORA_AGENT` and
`SOMORA_SESSION` for the command, so the agent has nothing else to do.

A turn that was cut by a restart it caused itself, for example a raw
`systemctl restart somora` or `launchctl kickstart` among its tool
calls, is woken after start too and told not to run the command again.
Other agents whose question or helper was cut are told as well.

A session is woken at most twice in ten minutes, so an agent that
answers the wake with another restart cannot loop. The setting
`server.resumeAfterRestart` (`requested`, `all` or `off`) widens this or
switches it off.

## Chat

A turn is one message into a session and everything the agent does to
answer it. Each session runs one turn at a time. Whatever arrives while
a turn runs waits in that session's queue.

### `POST /chat/send`

Sends a message and returns at once. The turn runs in the background
and its events arrive on `GET /chat/stream`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `agent` | string | yes | Agent name. When left out, the alphabetically first agent is used, so pass it. |
| `text` | string | yes | The message. |
| `session` | string | no | Session reference. Default `main`. |
| `attachments` | array | no | `{hash, name, mime, size}` objects from `POST /attachments`. |
| `steer` | boolean | no | Hand the text to the turn that is running now. See "Steering". Ignored together with `agent_ask_call_id`. |
| `input_modality` | `"text"` or `"voice"` | no | `voice` when the client filled the text from its microphone. Stored as `user_message.input.modality`. A condition for a spoken reply. |
| `stt_provider` | string | no | Free tag naming the speech-to-text path used. |
| `auto_play_requested` | boolean | no | The client wants a spoken reply (`assistant_audio`). Only honoured together with `input_modality: "voice"`. |
| `from_agent` | string | no | The turn is written by another agent. Used by the `agent_ask` tool. |
| `from_session` | string | no | The session the asking agent wrote from. Ignored without `from_agent`. |
| `agent_ask_call_id` | string | no | Correlation id of an agent's question. With `from_agent` the call is registered, so `GET /a2a/ask-result` finds it while the turn waits or runs. |
| `subagent_depth` | number | no | Nesting depth when the turn is a sub-agent brief. The turn's `origin` becomes `{kind: "subagent"}`. |

| Status | Body |
|---|---|
| `202` | `{ok: true, turnId}`. Keep `turnId` to match the later `turn_queued` and `user_message` events to the bubble you drew. |
| `202` | `{ok: true, steered: true, steerId, turnId}` when `steer` went into the running turn. `turnId` is that turn's. |
| `202` | `{ok: true, turnId, steered: false}` when `steer` was set but nothing could take it. The message was queued. |
| `400` | No agent is configured. |
| `404` | Unknown agent or session. |

#### Steering

With `steer: true` a message goes into the running turn instead of
waiting behind it. The server keeps it until the agent's next step: after
the tools of the current round have returned and before the next model
call. The model reads it as a message that was sent while it was
working. A running tool call is never interrupted.

What a client sees, in order:

1. The `202` response with `steerId`.
2. A `steer_queued` event on the stream, so other windows can show the
   pending message.
3. A `user_message` event with `steer: true` and the same `steer_id`,
   once the model has been given the text. The message is now in the
   session history, at the place where the model read it.

| Case | Result |
|---|---|
| Engine `openai-compatible`, `claude-cli`, `codex-cli` or `grok-cli` | The message is steered. |
| Any other engine, or no turn running | It is queued as a turn of its own (`steered: false`). |
| The turn is already finishing | It becomes an ordinary queued turn. Nothing is lost. |
| The message carries `agent_ask_call_id` | Never steered: such a question needs a turn of its own. |

On `claude-cli` and `grok-cli` a message steered while the model
writes its final answer is answered in the same turn. The model finishes the answer,
then replies to the message in a new paragraph. The turn ends once
every steered message has had its answer.

Grok does not say when it hands a message to the model. somora reads
that from Grok's own session record, so on `grok-cli` the `user_message`
event can arrive a second or two after the model read the text.

Sub-agent and voice turns can be steered like any other. The web
client offers a steer or queue switch next to Send. Its starting
position is the agent's `steering:` setting in `agent.yaml`, reported
by `GET /agents`.

#### Queuing

A message for a session that is busy is queued, not refused. Each
session has one queue, first in, first out. Every kind of turn goes
through it: typed and dictated messages, questions from other agents,
sub-agent briefs, sentinel fires, tmux and browser wakes, voice
consults and wake-ups. None jumps ahead. A running turn always
finishes before the next one starts.

| You want to | Use |
|---|---|
| Show "queued" on a message | The `turn_queued` event |
| See what runs and what waits | `GET /agents/:agent/sessions/:session/work` |
| Take a waiting turn back | `DELETE /chat/queue/:id` |
| Stop the running turn | `POST /chat/abort` |

### `POST /chat/send-sync`

Sends a message, waits for the turn to finish and returns the result.
This is also the route the agent-to-agent tools use.

It takes `agent`, `session`, `text`, `attachments`, `from_agent`,
`from_session`, `agent_ask_call_id` and `subagent_depth` as on
`POST /chat/send`, plus:

| Field | Type | Meaning |
|---|---|---|
| `model` | string | An alias or `provider/id` that answers this one turn instead of the session's model. |
| `max_rounds` | number | Overrides `agentLoop.maxRounds` for this turn. |
| `create_session` | boolean | When `session` is a slug that does not exist on the target, create it and deliver the message there. Only slugs: an exact id or a `sub-*` name answers `400`. |
| `create_model` | string | With `create_session`: the model pinned on the session if this call creates it. Ignored when the session exists; the response then carries `session_note`. |
| `waiter_agent`, `waiter_session` | string | The turn that blocks on this request. Registers the wait in the deadlock guard. Set both or neither. |
| `detach` | boolean | With `from_agent` and `agent_ask_call_id`: hand the message over and return at once. The asker is woken when the reply lands. This is `agent_ask` with `wait: false`. |

Response `200`, the turn result:

```json
{ "finalText": "…", "outcome": "completed", "tool_calls": 3, "rounds": 2,
  "usage": { "tokens_in": 18200, "tokens_out": 640 },
  "contextWindow": 200000, "provider": "anthropic", "model": "claude-opus-4-7",
  "thinkingActive": false, "ms": 8421,
  "session_id": "20260511-093251_research-notes" }
```

| Field | Meaning |
|---|---|
| `finalText` | The reply. |
| `outcome` | `completed`, `partial`, `degraded` or `failed`. `outcome_reason` and `error` explain the last three. |
| `tool_calls`, `rounds`, `ms` | How much work the turn was. |
| `files_written`, `media` | Files and generated media of the turn, when there are any. |
| `follow_ups` | Texts that reached the caller after the report. See `GET /spawn-result`. |
| `usage`, `contextWindow`, `provider`, `model` | Tokens and the model that answered. `fallback` is added when a backup model answered. |
| `thinkingActive`, `thinkingLevel` | Whether a thinking level was applied. |
| `session_id` | The resolved session id. |
| `session_created`, `session_model` | Present when this call created the session. |
| `session_note` | Present when `create_model` was ignored. |

Other answers:

| Status | Body | When |
|---|---|---|
| `202` | `{call_id, state: "pending", session_id, session_created?, session_model?, session_note?}` | `detach` was set. |
| `200` | `{finalText: "", outcome: "failed", dequeued: true, error: "removed from the queue by the user before it started", session_id}` | A person removed the waiting call from the queue. |
| `400` | `{error, known_models}` | `create_model` names an unknown model. Nothing was created. |
| `404` | `{error, known_sessions: [...]}` | Unknown session. The list holds the target's live session slugs, so a caller can correct itself. |
| `409` | `{error, circular_wait: true, chain: [...]}` | With `waiter_*`: the target already waits on the caller, directly or through others. |
| `500` | `{error}` | The turn could not run. |

A session created through `create_session` is told so beside its first
message: who created it and on which model it runs. A message with
`from_agent` is shown to the target with a header naming the agent and
its session. Neither is part of the stored `text`.

### `POST /chat/abort`

Stops the turn that is running on a session, whatever started it.
Agent and session go in the query string.

```bash
curl -X POST "$BASE/chat/abort?agent=<your-agent>&session=main"
```

| Query | Default | Meaning |
|---|---|---|
| `agent` | first agent | Agent name. |
| `session` | `main` | Session reference. |

Returns `{agent, session, aborted: true, ms_running}`, or
`{agent, session, aborted: false}` when nothing was running. Safe to
call twice.

- Only the running turn is stopped. Queued turns keep their place.
- A command the turn runs through `exec` is killed with it. Its result
  says `killed: the turn was stopped`.
- Whoever asked for the turn learns why it ended: another agent's
  question and a sub-agent task report `state: "failed"` with
  `error: "stopped by the user"`. A sentinel fire is recorded as
  `error` with the same text.

### `DELETE /chat/queue/:id`

Takes a waiting turn out of the queue before it starts. Nothing is
written to the session.

`:id` is the id the queue views show:

| Waiting entry | Its id |
|---|---|
| A typed message | The `turnId` from `POST /chat/send` |
| Another agent's question | The `call_id` |
| A sub-agent brief or a sentinel fire | The `task_id` |

| Body field | Meaning |
|---|---|
| none | The request acts as the person and may remove anything. |
| `requesting_agent` | Acts as that agent, which may remove only what it asked for itself. This is what `agent_ask_cancel` sends. |
| `withdraw_running` | With `requesting_agent`: if the call already runs, withdraw it instead of answering `409`. |

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ok: true, id, turnId, kind, agent, session, text?, attachments?}` | Removed. For a typed message (`kind: "human"`), `text` and `attachments` come back so the client can put them into its input field. The attachment refs stay valid. |
| `200` | `{ok: true, state: "withdrawn", id, turnId, agent, session, steered, steerId?, ranMs}` | A running call was withdrawn. Its result no longer wakes the asker. With `steered: true` the target was told to stop through a steered message. The turn is not aborted. |
| `403` | `{ok: false, reason: "forbidden", id, error}` | The entry does not belong to `requesting_agent`. |
| `404` | `{ok: false, reason: "unknown", error}` | Nothing waits under that id. |
| `409` | `{ok: false, reason: "already_started", id, turnId}` | The turn is running. Use `POST /chat/abort`. |

Who is told about a removed entry:

| Removed | What its requester sees |
|---|---|
| Another agent's question | `state: "failed"` with `error: "removed from the queue by the user before it started"`, as the tool result, in `agent_ask_result` and in `GET /a2a/ask-result`. An asker that had stopped waiting is woken with an `[agent answer]` turn. |
| A sub-agent brief | `cancelled` with the same error in `subagent_status`, `subagent_result` and `GET /spawn-status`. The parent is woken with a `[subagent attention]` turn. |
| A sentinel fire | The trigger's history records it as `skipped` with `skipReason: "removed from the queue by the user"`. |
| A wake-up turn | Dropped quietly. The result it was bringing stays readable. |

On success every client on the session gets a `turn_dequeued` event,
followed by fresh `turn_queued` events for the typed messages that
moved up.

### `GET /chat/history`

The stored events of a session, oldest first. Clients load this when a
chat window opens.

| Query | Required | Meaning |
|---|---|---|
| `agent` | yes | Agent name. |
| `session` | yes | Session reference. |
| `limit` | no | Return only the last N events (1 to 2000, default 200 once paging is used). |
| `before` | no | Epoch ms. Return events older than this. Pass the `oldestTs` of the previous page. |

Without `limit` and `before` the whole session is returned.

```json
{ "agent": "<your-agent>",
  "session": "20260511-093251_research-notes",
  "events": [ { "kind": "user_message", "ts": 1715512000000, "text": "…" } ],
  "hasMore": true,
  "oldestTs": 1715512000000 }
```

Every event has `kind` and `ts`. The kinds:

| `kind` | What it is |
|---|---|
| `user_message` | The message that started a turn, with `text`, `origin` and the fields described under "The user_message event". The stored row also has `ephemeral`. |
| `assistant_message` | The reply text. |
| `thinking_message` | The model's reasoning: `{text, truncated?}`. Stands directly before its `assistant_message`. |
| `tool_call`, `tool_result` | A tool call and its result. Tool names are in short form (`memory_search`). |
| `engine_meta` | A side note of the engine or of somora: raw `itemType` and `payload`. See "Engine notes". |
| `model_fallback` | A backup model answered. Stands before the assistant message it produced. |
| `assistant_audio`, `assistant_media` | Spoken audio and generated media of a turn, paired by `turnId`. |
| `project_switched` | The session's project changed. |
| `error` | An error text. |
| `turn_start`, `turn_end` | Bookkeeping around a turn. |

`400` when `agent` or `session` is missing or `before` is not a number.

### `GET /agents/:agent/sessions/:session/work`

What the session is doing right now, what waits behind it, which
answers are about to arrive and what it started elsewhere. Only the
first 160 characters of each text are exposed.

```json
{
  "asOf": 1789300000000,
  "agent": "<your-agent>",
  "session": "20260913-101500_main",
  "busy": true,
  "active": {
    "id": "1f3a…", "kind": "agent", "state": "running",
    "preview": "Can you check whether the release notes mention …",
    "target": { "agent": "<your-agent>", "session": "20260913-101500_main" },
    "requester": { "agent": "<other-agent>", "session": "20260910-083000_main" },
    "enqueuedAt": 1789299990000, "startedAt": 1789299991000, "turnId": "1f3a…"
  },
  "queued": [
    { "id": "b5b7…", "kind": "human", "state": "queued",
      "preview": "and the changelog too",
      "target": { "agent": "<your-agent>", "session": "20260913-101500_main" },
      "requester": { "human": true },
      "enqueuedAt": 1789299995000, "position": 1 }
  ],
  "pendingWakes": [
    { "id": "9d2c…", "kind": "agent", "about": "a2a", "state": "done",
      "preview": "Which of the three drafts …",
      "target": { "agent": "<other-agent>", "session": "20260910-083000_main" },
      "requester": { "agent": "<your-agent>", "session": "20260913-101500_main" },
      "enqueuedAt": 1789299900000, "startedAt": 1789299901000,
      "finishedAt": 1789299999500 }
  ],
  "children": [
    { "id": "task-…", "kind": "subagent", "state": "running",
      "preview": "Summarise the three …",
      "target": { "agent": "<your-agent>", "session": "sub-<your-agent>-20260913-101700" },
      "requester": { "agent": "<your-agent>", "session": "20260913-101500_main" },
      "enqueuedAt": 1789299970000, "startedAt": 1789299971000 }
  ]
}
```

The four lists:

| List | Holds |
|---|---|
| `active` | The running turn, or `null`. When a turn runs without an entry, the response carries `activeTurnId` instead. |
| `queued` | The waiters in order, each with `position` (1 is next). Remove one with `DELETE /chat/queue/:id`. |
| `pendingWakes` | Work this session asked for that has finished and whose wake-up turn is scheduled. `about` is `a2a`, `subagent` or `job`. The delay is `agentLoop.wakeGraceMs`. |
| `children` | Sub-agents and questions to other agents that this session started and that still wait or run. |

Every entry has the same fields:

| Field | Meaning |
|---|---|
| `id` | The work id: a `turnId`, a `call_id`, a `task_id`, the consult id of a question from a call, or a video job id. |
| `kind` | Where it came from: `human`, `agent`, `subagent`, `sentinel`, `tmux`, `browser`, `voice` or `wake`. A `wake` also has `about` (`a2a`, `subagent`, `job` or `system`). |
| `state` | `queued`, `running`, `done`, `failed`, `cancelled` or `dequeued`. |
| `preview` | The first 160 characters of the text, line breaks folded to spaces. |
| `target` | The `{agent, session}` the turn runs on. |
| `requester` | Who asked: `{agent, session}`, `{human: true}` or `{voiceCall}`. Absent for sentinel, tmux and browser turns. |
| `enqueuedAt`, `startedAt?`, `finishedAt?` | Epoch ms. |
| `turnId?`, `error?` | The turn id once it runs. The error for `failed`, `cancelled` and `dequeued`. |

This view lives in memory and is empty after a restart.

## Streams

### `GET /chat/stream`

The live events of one session, as Server-Sent Events. Open one per
chat window.

```bash
curl -N "$BASE/chat/stream?agent=<your-agent>&session=main"
```

| Query | Default | Meaning |
|---|---|---|
| `agent` | first agent | Agent name. |
| `session` | `main` | Session reference. |

`400` when no agent is configured, `404` for an unknown agent or
session. The first event is `status` with
`{msg: "connected", session}`, where `session` is the resolved id.

All events:

| Event | When | Data |
|---|---|---|
| `status` | On connect, and for error notices (`error: …`, `turn failed: …`) | `{msg}` |
| `heartbeat` | Every `sse.heartbeatMs` (20 s) | The current time in ms |
| `user_message` | A turn's message was stored: the turn has started. Also for a steered message. | See "The user_message event" |
| `turn_queued` | A message has to wait behind another turn | `{turnId, ahead, workId?, kind?}` |
| `turn_dequeued` | A waiting entry was removed with `DELETE /chat/queue/:id` | `{turnId, workId}` |
| `steer_queued` | A steered message was accepted for the running turn | `{steerId, text, ts, turnId, origin}` |
| `turn_started` | The engine opened the turn | `{turnId}` |
| `agent` | The model call starts and ends | `{phase: "start"\|"end", usage?, contextWindow?, provider?, model?, thinking?, fallback?}` |
| `memory` | After `agent` start: what recall put into the turn | `{count, topScore?, refs, fullText}` |
| `thinking` | The model's reasoning text | `{state: "delta"\|"final", text, truncated?}` |
| `chat` | The reply text | `{state: "delta"\|"final", text}` |
| `tool` | A tool is called, returns or fails | `{phase: "call"\|"result"\|"error", tool, summary?, details?, error?}` |
| `engine_meta` | A side note of the engine or of somora | `{engine, itemType, label, summary?, payload}` |
| `model_fallback` | A backup model takes over the turn | `{requested, actual, reason, hops?}` |
| `turn_error` | The turn ended with an error | `{turnId?, message, engine}` |
| `assistant_audio` | Spoken audio for the reply is ready | `{turnId, url, mime, durationMs?, cacheKey}` |
| `assistant_media` | Images or videos made during the turn | `{turnId, media: [{type, id, prompt, mime, filename, url, thumbUrl?, durationSec?}]}` |
| `session_model` | The session's model was set or cleared | `{model, resolved?, source}` |
| `project` | The session's project changed | `{from, to, via}` |
| `builder_state` | A builder session's mode, phase or plan file changed | `{mode, phase, planPath}` |
| `todo_updated` | A builder replaced its task list | `{todos: [{content, status, priority?}], by?}` |
| `question_asked` | A builder waits for the person | `{questionId, question, header?, options, multiple, expiresAt}` |
| `question_answered` | The open question was answered | `{questionId, answered}` |

Details where the table is not enough:

**`chat` and `thinking`.** Deltas are cumulative: each `delta` carries
the whole text so far, so replace what you show instead of appending.
The `final` event carries the complete text. The `thinking`
final comes before the `chat` final of the same turn. Thinking is only
sent by engines that expose it, and not at all with
`thinkingContent.capture: false`.

**`agent`.** The start event carries `provider`, `model` and
`thinking` (`{level, active}`). The end event adds `usage`,
`contextWindow` and, when a backup model answered, `fallback` and the
model that really answered.

| `usage` field | Meaning |
|---|---|
| `tokens_in`, `tokens_out` | What the turn spent, summed over every request it made. A turn with tools can exceed the context window several times over. |
| `tokens_in_cached` | The part of `tokens_in` read from the provider's cache. |
| `tokens_out_reasoning`, `tokens_out_reasoning_estimated` | Reasoning tokens, and whether the number is an estimate. |
| `context_tokens` | The prompt size of the turn's last request. This is the only value to compare with `contextWindow`. Optional. |

**`tool`.** Tool names are in short form: `memory_search`, not
`mcp__somora__memory_search`. `summary` is one line made for display.
`details` is the input or the output as pretty-printed JSON. A result
with nothing worth showing sends no `result` event.

**`turn_queued`.** `ahead` counts the turns before this one, including
the running one, at the moment it was queued. It is not updated as the
queue drains, except after a `DELETE /chat/queue/:id`. Show "queued"
until the `user_message` with the same `turnId` arrives.

**`turn_started`.** This `turnId` is the engine's own id (`t-…`). It is
the one that `assistant_media`, `assistant_audio`, `turn_error` and the
stored `turn_end` carry. Mark the reply you are about to draw with it,
so that late audio, media and errors land on the right turn.

**`model_fallback`.** Model names are `provider/modelId`. `requested`
is the agent's first model, `actual` the one answering now, `reason`
the failure. With a chain of backups one event is sent per hop. `hops`
lists every model that failed so far as `[{model, reason}]`. The event
is stored in the history too.

**`memory`.** `refs` are `source/slug` in score order. `fullText` is
the block the model was given. `count` is `0` when recall found
nothing.

**`session_model`.** Sent to every client on the session, because a
switch is often made from elsewhere. `source` is `session-override`, or
`persona-default` with `model: null` after a clear.

**`project`.** `from` and `to` are project slugs or `null`. `via` is
`slash_command` for a change through the API and `tool` when the agent
changed it during a turn.

**`heartbeat`.** The server watches these writes. One that fails, or
stays unfinished for `sse.deadAfterMs` (60 s), ends the stream. Over
HTTPS the connection is also pinged (`sse.h2PingIntervalMs`,
`sse.h2PingTimeoutMs`). A client should reconnect when heartbeats stop.

#### The user_message event

```json
{ "text": "and the changelog too", "ts": 1789299995000, "turnId": "b5b7…",
  "origin": { "kind": "human", "via": "chat" } }
```

| Field | Meaning |
|---|---|
| `text` | The message as it is kept: what a person typed, what an agent asked, what a trigger's prompt says, or the one-line statement of a wake-up. |
| `ts` | Epoch ms. |
| `turnId` | The id from `POST /chat/send`. Match it to the bubble you drew. |
| `origin` | Where the turn came from. See below. |
| `input` | `{modality?: "text"\|"voice", source?: "stt"\|"realtime"}` when the turn was not typed. `stt` is dictation, `realtime` a sentence from a call. |
| `steer`, `steer_id` | `steer: true` marks a message that went into the running turn `turnId`. `steer_id` matches the `steer_queued` event. |
| `from_agent`, `from_session`, `agent_ask_call_id` | Older fields, derived from an `agent` origin. |
| `attachments` | `{hash, name, mime, size}` of the files sent with the message. |
| `attachment_descriptions` | Stored row only. The vision worker's description of each attachment the model could not see, one string per file. |
| `from_system` | Older field, derived from the origin: `sentinel`, `tmux`, `browser`, `voice`, or for a wake its `about` (`a2a`, `subagent`, `job`, `system`). The shipped clients draw these as a divider, not as a bubble. |

`origin` is one of:

```ts
origin?:
  | { kind: 'human';    via: 'chat' | 'voice-stt' }
  | { kind: 'agent';    from: { agent: string; session?: string }; callId?: string }
  | { kind: 'subagent'; parent?: { agent: string; session: string }; taskId?: string; depth: number }
  | { kind: 'sentinel'; triggerId: string; taskId: string; triggerName?: string }
  | { kind: 'tmux';     tmuxSession: string; tmuxKind?: string }
  | { kind: 'browser';  viewId: string; cause: 'handoff' | 'activity'; handoffId?: string }
  | { kind: 'voice';    callId?: string; consultId: string }
  | { kind: 'wake';     about: 'a2a' | 'subagent' | 'job' | 'system'; ref: string; depth?: number; cause?: string };
```

| `kind` | The turn was started by |
|---|---|
| `human` | A person typing (`chat`) or dictating (`voice-stt`). |
| `agent` | Another agent's question, or its follow-up on one (`callId` is the original call). |
| `subagent` | A brief running in its own `sub-…` session. |
| `sentinel`, `tmux`, `browser`, `voice` | A trigger, a tmux session that became ready, a browser window handed back, a question from a voice call. |
| `wake` | Something the agent started earlier has finished: a late answer (`about: "a2a"`, `ref` is the call id), a sub-agent (`subagent`, task id) or a video (`job`, job id). |
| `wake` with `about: "system"` | somora itself speaks. `cause` names the occasion. Today that is `restart`, and the text begins `[system: restart]`. |

Stored rows from old sessions may have no `origin`. Read the `from_*`
fields then.

What the model is told about a turn, such as who wrote it and what to
do with it, is not part of `text`. It is kept in the stored row's
`ephemeral` field together with the recalled memory, and is not on the
stream event.

#### Engine notes

`engine_meta` carries notes that are not part of the reply. `label` is
a display name chosen by the server, `payload` the original item, and
most notes have a readable `payload.text`.

| `itemType` | Meaning |
|---|---|
| `todo_list` | Codex's own plan or checklist (label `plan`). |
| `error`, `reconnecting`, `transport_fallback` | Codex reported an error, reconnects a dropped stream by itself, or switched to HTTPS after retries. The last two are not failures. |
| `model_switch` | The Codex thread continues under a new model. |
| `thread_recreated` | The Codex thread was gone. A new one was started with the history replayed. |
| `tools_changed` | The agent's tool set changed, so a new Codex thread was started with the history replayed. |
| `mcp_server_renamed` | The engine session was rebuilt (label `session restarted`). |
| `context_compacted` | The history was compacted after it outgrew the window. |
| `context_trimmed` | The oldest tool results of the running turn were shortened to fit the window. The turn goes on. |
| `attachments_unsupported` | The engine cannot pass attachments on. |
| `session_model` | An agent switched this session's model (label `model switched`). |
| `voice_handover`, `voice_spoken` | A call was handed to or from another agent. What a call said out loud, in older sessions. |
| `reasoning_effort_adjusted`, `sampling_dropped` | The backend refused a parameter and the turn was retried without it. |

An unknown `itemType` keeps its raw name as label.

### `GET /activity/stream`

One stream for the whole server: which sessions are working and which
have something unread. It also reports sessions that no client has
open. Open one per client.

```bash
curl -N $BASE/activity/stream
```

| Event | When | Data |
|---|---|---|
| `status` | On connect | `{msg: "connected"}` |
| `heartbeat` | Every `sse.heartbeatMs` | The current time in ms |
| `streaming` | A turn starts or ends on any session | `{agent, session, phase: "start"\|"end"}` |
| `turn` | Something a person should read arrived in a session | `{agent, session, unreadAt}` |
| `seen` | A client marked a session as seen | `{agent, session, seenAt}` |

A `turn` event is sent for a finished reply (`chat` with
`state: "final"`) and for a `user_message` that carries `from_agent` or
`from_system`. Messages a person typed, tool events and the start and
end of a model call do not count.

A session is unread when `unreadAt` is later than `seenAt`, or `seenAt`
is `null`. Both are ISO timestamps kept with the session, so the state
survives a restart. The session lists return them.

### `POST /sessions/:agent/:session/seen`

Tells the server that the person is looking at this session now. Other
clients get a `seen` event and clear their badge.

| Body field | Required | Meaning |
|---|---|---|
| `ts` | no | ISO timestamp of when the session was looked at. Default: now. |

The body may be empty. The server keeps the later of the stored value
and `ts`, so the marker never moves backwards.

```json
{ "ok": true, "agent": "<your-agent>", "session": "main", "seenAt": "2026-05-27T14:00:00.000Z" }
```

## Sessions

A session is one conversation of an agent. Every agent has `main` and
any number of named sessions.

### `GET /agents/:agent/sessions`

The sessions of one agent.

| Query | Meaning |
|---|---|
| `include_archived=true` | Also return archived sessions. They are left out by default. |

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

| Field | Meaning |
|---|---|
| `dreamCoverageTs`, `dreamLagEvents` | How far REM has read this session, and how many events it has not read yet. `null` when it never ran. |
| `unreadAt`, `seenAt` | Unread state, see `GET /activity/stream`. |
| `archivedAt`, `archiveReason` | Present on archived sessions. |
| `projectSlug` | Present when a project is pinned. |

### `GET /sessions`

The sessions of all agents in one list.

| Query | Meaning |
|---|---|
| `include_archived=true` | Also return archived sessions. |

Returns `{sessions: [...]}`. The `session_list` tool reads this route.
Each row has the fields above with the id as `sessionId`, plus:

| Field | Meaning |
|---|---|
| `agent`, `agentColor`, `agentIcon` | The agent the session belongs to. |
| `liveSubscribers` | Clients connected to its stream right now. |
| `dream` | `{status, coverageTs, lagEvents}` with `status` `dreamed`, `partial` or `never`. Replaces the two `dream*` fields. |
| `busy`, `queueLength`, `activeSince` | Whether a turn runs, how many wait, and since when (ms, `null` when idle). |

### `POST /agents/:agent/sessions`

Creates a named session.

| Body field | Required | Meaning |
|---|---|---|
| `slug` | yes | The name. Must match `[A-Za-z0-9_-]+`. |

| Status | Body |
|---|---|
| `201` | `{id, slug, agent}` |
| `400` | The slug is missing, invalid, or `main`. |
| `409` | `{error, id, slug, agent, exists: true}`: a live session already has this name. `id` is that session, so a client can switch to it. |

Archiving or resetting a session frees its name.

### `POST /agents/:agent/sessions/:session/archive`

Hides a session from the default lists without deleting anything.

| Body field | Required | Meaning |
|---|---|---|
| `reason` | no | Free text, kept with the session. |

Returns `{archived: true, agent, session}`. `400` when the session
cannot be archived. `main` cannot: reset it instead.

### `POST /agents/:agent/sessions/:session/unarchive`

Brings an archived session back as a normal session, also one that
`/reset` archived. Returns the state after the call:

| Status | Body |
|---|---|
| `200` | `{archived: false, agent, session, slug}`. `slug` is the name the session is listed under. |
| `409` | `{error, archived: true}`. The session is still archived. |

A reset archive keeps its id and is listed under the name in that id,
for example `main-archive` or `trip-archive`. The original name stays
with the fresh session. The history is untouched, and REM does not read
the archived part a second time.

The web client's Sessions window, the mobile app's session sheet and
the TUI's `/unarchive` all use this route.

### `POST /agents/:agent/sessions/:session/compact`

Compacts the session now, on the engine of its model. See
[Compact by hand](compaction.md#compact-by-hand).

| Body field | Required | Meaning |
|---|---|---|
| `instructions` | no | What the summary should keep. Used on `openai-compatible` and `claude-cli`, at most 2000 characters. |

| Status | Body |
|---|---|
| `200` | `{agent, session, status: "compacted", engine, tokensBefore?, tokensAfter?, note?}`. `note` says when the engine ignored the instructions (`codex-cli`, `grok-cli`). |
| `200` | `{agent, session, status: "nothing_to_compact", engine, note}`. The session is too short, or the engine has no conversation for it yet. |
| `400` | `{status: "unsupported", engine, note}`. The engine cannot compact by hand. |
| `409` | `{error, busy: true}`. A turn or another compaction is running. |
| `502` | `{error}`. The engine failed while compacting. |

A finished compaction is stored as an `engine_meta` row with engine
`somora` and `itemType: "context_compacted"`, and sent to every client
on the session. Its `payload` holds `text`, `manual: true`, the `engine`,
the token counts and the `focus`.

### `POST /agents/:agent/sessions/:session/reset`

Archives the session's content and starts the session empty. If REM is
enabled for the agent, it reads the archived content in the background.

```json
{ "agent": "<your-agent>", "session": "main",
  "archivedId": "20260512-140822_main-archive",
  "dreamSpawned": true }
```

The reset waits for a running turn to finish. An empty session answers
`{agent, session, archivedId: null, reason}`. Follow the REM run with
`GET /dream-states`.

### `GET /agents/:agent/sessions/:session/export`

Downloads the session as a file.

| `format` | Content type | Content |
|---|---|---|
| `markdown` (default) | `text/markdown` | A readable transcript: messages as sections, tool calls as collapsible blocks, plans as task lists. Bookkeeping events are left out. |
| `json` | `application/x-ndjson` | The stored events, one JSON object per line, complete. Use this for backups. |

Both set `Content-Disposition: attachment`. `400` for another format.

```bash
curl "$BASE/agents/<your-agent>/sessions/main/export?format=markdown" -o main.md
curl "$BASE/agents/<your-agent>/sessions/main/export?format=json" -o main.jsonl
```

## Models and thinking

Each session can override the agent's model, thinking level and
sampling. Without an override the agent's own setting applies.

### `GET /models`

Every model in `config.yaml`.

```json
[ { "provider": "anthropic", "id": "claude-opus-4-20250514",
    "alias": "claude-opus-4-7", "engine": "claude-cli",
    "contextWindow": 200000, "capabilities": ["vision", "reasoning"],
    "ref": "claude-opus-4-7" } ]
```

| Field | Meaning |
|---|---|
| `ref` | The handle to pass to the model routes: the alias, else `<provider>/<id>`. |
| `unavailable` | `{since, until, reason}` in epoch ms. Present while the model is marked unreachable after a host error. Fallback chains skip such models for `fallback.retryUnavailableMinutes`. |

### `POST /models/availability/reset`

Forgets every "unavailable" mark, so the first-choice models are tried
again. Returns `{ok: true, cleared, retryUnavailableMinutes}`.

### `GET /agents/:agent/sessions/:session/model`

The model the session's next turn will use.

```json
{ "agent": "<your-agent>", "session": "main",
  "provider": "anthropic", "modelId": "claude-opus-4-20250514",
  "alias": "claude-opus-4-7", "engine": "claude-cli", "contextWindow": 200000,
  "source": "session-override", "override": "claude-opus-4-7",
  "personaDefault": "claude-sonnet-4-5" }
```

`source` is `session-override` or `persona-default`. `500` when the
agent's model cannot be resolved.

### `PUT /agents/:agent/sessions/:session/model`

Sets the session's model. It applies from the next turn: a running turn
keeps the model it started with. This is safe on every engine.

| Body field | Required | Meaning |
|---|---|---|
| `model` | yes | An alias or `<provider>/<id>`, as `ref` in `GET /models`. |
| `by_agent`, `by_session` | no | Who switched, when an agent did it. Sent by the `session_model` tool. |

Returns `{agent, session, model, resolved: "<provider>/<modelId>"}`.
`400` for a missing or unknown model; the error lists the known ones.

Every client on the session gets a `session_model` event. A switch
with `by_agent` is also written into the conversation as an
`engine_meta` note naming who switched to what. A switch by a person
leaves no note.

### `DELETE /agents/:agent/sessions/:session/model`

Clears the override. Takes the same optional `by_agent` and
`by_session`. Returns `{agent, session, cleared: true}` and sends
`session_model` with `model: null`.

### `GET /agents/:agent/sessions/:session/thinking`

The thinking level in force.

| Field | Meaning |
|---|---|
| `effective` | The level that applies: `off`, `low`, `medium`, `high`, or `null` when nothing is set and the model decides. |
| `override`, `personaDefault`, `modelDefault` | The session's setting, the agent's, and the active model's `reasoning.default`, or `null`. |
| `source` | `session-override`, `persona-default`, `model-default`, or `engine-default` (nothing set: nothing is sent; show it as "model decides", not "off"). |
| `modelSupportsReasoning` | Whether the current model uses the setting at all. |
| `wire` | The value actually sent when it differs from the level, for example `xhigh` for `high`. Else `null`. |

### `PUT /agents/:agent/sessions/:session/thinking`

Sets the level. Body `{"level": "off" | "low" | "medium" | "high"}`.
Returns `{agent, session, level}`. Anything else is a `400`. Which
word is sent to the model for a level is set per model under
`reasoning.levels` in the config.

### `DELETE /agents/:agent/sessions/:session/thinking`

Clears the override. Returns `{agent, session, cleared: true}`.

### `GET /agents/:agent/sessions/:session/sampling`

The sampling values in force. Only the `openai-compatible` engine
applies them.

| Field | Meaning |
|---|---|
| `effective` | Model defaults, agent defaults and session override merged, or `null`. |
| `override`, `personaDefault`, `modelDefault` | The three layers, each an object or `null`. |
| `source` | `session-override`, `persona-default`, `model-default` or `engine-default`. |
| `engineSupportsSampling` | Whether the setting has any effect on the current model. |

### `PUT /agents/:agent/sessions/:session/sampling`

Merges keys into the session's override. A key set to `null` is
dropped.

```bash
curl -X PUT $BASE/agents/<your-agent>/sessions/main/sampling \
     -H 'Content-Type: application/json' -d '{"temperature":0.7}'
```

Keys: `temperature`, `top_p`, `top_k`, `min_p`, `frequency_penalty`,
`presence_penalty`, `repetition_penalty`, `seed`, `stop`. Returns
`{agent, session, override}`; `override` is `null` once the last key is
gone. `400` names an unknown key or a value out of range.

### `DELETE /agents/:agent/sessions/:session/sampling`

Clears the override. Returns `{agent, session, cleared: true}`.

## Agents

### `GET /agents`

The configured agents.

```json
[ { "name": "<your-agent>", "description": "scribe and personal assistant",
    "icon": "📝", "color": "#6366f1", "role": "Scribe",
    "steering": true, "kind": "chat" } ]
```

| Field | Meaning |
|---|---|
| `icon`, `color`, `role` | Optional display values from the agent's `AGENTS.md`. |
| `steering` | The agent's default for a message typed while a turn runs: `true` steers, `false` queues. |
| `kind` | `chat` or `builder`. |

### `GET /agents/:agent/system-prompt`

The agent's own part of the system prompt: `SOUL.md`, `AGENTS.md` and
`USER.md` under somora's headings. Returns `{agent, systemPrompt}`. For
the complete prompt use the next route.

### `GET /agents/:agent/prompt-preview`

The system prompt exactly as the next turn would send it. No turn runs
and nothing is changed.

| Query | Default | Meaning |
|---|---|---|
| `session` | `main` | The session to build the prompt for. |

```json
{ "agent": "<your-agent>", "session": "main", "text": "…", "chars": 16210,
  "parts": [ { "key": "self", "label": "Self-pointer", "chars": 900 },
             { "key": "persona", "label": "Persona (SOUL.md · AGENTS.md · USER.md)", "chars": 9340 },
             { "key": "team", "label": "Team block", "chars": 2652 } ],
  "tools": { "count": 41, "schemaChars": 26510, "names": ["exec"] },
  "budgets": { "teamBlockChars": 3000, "personaFileChars": 8000, "personaTotalChars": 14000 },
  "notIncluded": ["tool schemas (…)", "memory recall injected per turn"] }
```

| Field | Meaning |
|---|---|
| `parts` | The pieces of `text` in prompt order: self-pointer, persona, team, tool reminder, wiki overview, skills, session, project. |
| `tools` | The tools this agent would see on that session's model, and the size of their schemas. They travel beside the prompt, not in `text`. |
| `budgets` | `promptBudgets` from the config. |
| `notIncluded` | What a turn sends in addition. |

### `GET /agents/:agent/persona`

The agent's persona files with what is needed to edit them.

Returns `{agent, kind, files, budgets, totals: {personaChars}}`. Each
file is `{name, exists, content, hash, chars, bytes, mtime, readOnly}`.
The files are `AGENTS.md`, `SOUL.md`, `USER.md` and, read-only,
`agent.yaml`.

### `PUT /agents/:agent/persona/:file`

Saves one persona file. `:file` is `AGENTS.md`, `SOUL.md` or `USER.md`.

| Body field | Required | Meaning |
|---|---|---|
| `content` | yes | The new text. |
| `baseHash` | yes | The `hash` you read. The save only goes through when the file on disk still has it. |

| Status | Body |
|---|---|
| `200` | `{ok: true, hash, backup, chars}`. The next turn uses the new text. |
| `400` | Wrong body, an unknown file, or an `AGENTS.md` without a readable header, with a `name` that does not match the agent, or without a body. |
| `409` | `{error, currentHash, currentContent}`: the file changed meanwhile. Agents edit these files too, so reload and merge. |

The previous version is kept beside the file as
`<file>.bak-<timestamp>`. The last five are kept.

### `GET /tools`

Every tool registered on the server.

Returns `{count, tools: [{name, toolset, description, inputSchema, maxResultSizeChars, hasAvailabilityCheck}]}`.
`inputSchema` is the tool's JSON Schema. `maxResultSizeChars` is `null`
for the default cap. `hasAvailabilityCheck` says the tool is checked at
run time and may be hidden from some agents.

### `GET /agents/:agent/tools` · `PUT /agents/:agent/tools`

Which tools an agent may use.

`GET` returns:

| Field | Meaning |
|---|---|
| `agent`, `kind` | The agent and its kind. |
| `kindDefaults` | For a builder: the tool names its kind allows by default. Else `null`. |
| `gating` | The agent's `tools:` section as `{deny, allow}`, or `null`. |
| `hasPatternRules` | Always `false`. Kept for older clients; the Abilities window is always editable. |
| `handWrittenRules` | Patterns in the section that are not a family rule (`toolset:<tag>`), a server rule (`mcp__<server>__*`) or `*`. They apply; the window lists them as a note. |
| `tools` | `[{name, toolset, mcpServer?, description, visible, availableNow}]`: every tool, built in or from an external MCP server. `visible` says whether the agent may use it. |

`PUT` takes `{deny: string[], allow: string[]}` and rewrites only the
`tools:` block of the agent's `agent.yaml`. Returns `{ok: true}`. `400`
for a wrong body or a failed write, `404` for an unknown agent. It
applies from the agent's next turn and keeps the previous file as a
backup, like a click.

### `POST /agents/:agent/tools/toggle` · `POST /agents/:agent/skills/toggle`

One click in the Abilities window. The server works out the rules, so
every client edits the same way. Body:

| Field | Meaning |
|---|---|
| `names` | The tools or skills to switch, at least one. |
| `visible` | `true` to switch them on, `false` to switch them off. |
| `group` | `true` when the names are one whole family (a toolset, an MCP server, or all skills). Off then writes one rule for the family, so tools it gains later stay off. |

Returns `{ok: true, gating}` with the rules now in `agent.yaml`. Only
the named entries change state. `400` for a wrong body, an unknown
name, or a builder-only tool (`todo_write`, `ask_user`, `plan_write`)
for a chat agent. `404` for an unknown agent. Clicks on one agent run
one after another, and each write keeps the previous `agent.yaml` as a
backup (the newest five stay).

### `GET /agents/:agent/skills` · `PUT /agents/:agent/skills`

Which skills an agent sees.

`GET` returns `{agent, kind, gating, hasPatternRules, skills}`. Each
skill is `{name, description, available, unavailableReason?, visible}`.
`gating` is the agent's `skills:` section as `{deny, allow}` or `null`.
`hasPatternRules` is always `false`, kept for older clients.

`PUT` takes `{deny: string[], allow: string[]}` and rewrites only the
`skills:` block of `agent.yaml`. Empty lists remove the block. Names
are skill names (`[a-z0-9-]`), plus `*` under `deny` for every skill.
Returns `{ok: true}`, `400` on a wrong body, `404` for an unknown
agent. It applies from the next turn and keeps the previous file as a
backup.

### `POST /agents/:agent/tools/:name`

Runs one tool as the agent, without a chat turn. The body is the
tool's input, the response its result.

```bash
curl -X POST $BASE/agents/<your-agent>/tools/memory_search \
     -H 'Content-Type: application/json' \
     -d '{"query":"voice satellites","limit":3}'
```

`400` with the result when the tool reports a failure.

## Team

The team file `~/.somora/team.yaml` says who reports to whom. It can be
read and written here or edited by hand.

### `GET /team`

The team as written and as resolved.

| Field | Meaning |
|---|---|
| `enabled` | A valid team is in force. |
| `path`, `exists`, `valid` | The file, whether it is there, whether it parses. |
| `issues` | `[{path, message}]` when it is invalid. The last valid team stays in force. |
| `file` | The document as written. |
| `principal`, `rules` | The person at the top and the team rules. |
| `agents` | By name: `{name, title, reportsTo, involveFor, notFor, notes?, children, depth}`. |
| `order` | The agents from the top down. |
| `unlisted`, `missing` | Agents on disk that the file does not name, and file entries without an agent. |
| `warnings` | Things worth fixing that do not make the file invalid. |

### `GET /team/preview/:agent`

The team text that agent gets in its system prompt. Returns
`{agent, enabled, block, chars, softMaxChars}`, or
`{agent, enabled: false, block: ""}` without a team.

### `GET /team/check`

What `somora team check` prints, without the persona scan. Returns
`{exists, valid, issues, warnings, unlisted, missing, blocks: [{agent, chars, overSoftMax}], softMaxChars}`.

### `PUT /team`

Replaces the team file. The body is the whole document as JSON:
`{version: 1, principal, rules?, agents}`, the shape `GET /team`
returns under `file`.

| Status | Body |
|---|---|
| `200` | `{ok: true, backup, …}` plus everything `GET /team` returns. |
| `400` | `{error, issues: [{path, message}]}`. Nothing was written. |

The previous file is kept as `team.yaml.bak-<timestamp>` (last five).
Agents see the change on their next turn.

### `POST /team/init`

Writes a first team file in which every agent reports to the
principal. Body `{principal?: string}`. Returns `{ok: true, …}` with
the fields of `GET /team`. `409` when a file exists: this route never
overwrites. `400` when there are no agents.

### `POST /team/preview`

Renders a draft for one agent without saving it. Body `{file, agent}`.
Returns `{agent, valid, issues, warnings, block, chars, softMaxChars}`.
An invalid draft comes back with `valid: false` and its `issues`.

## Agent to agent

These routes carry the `agent_ask` and sub-agent tools. A custom client
can use them to follow such calls or to run background tasks.

### `GET /a2a/ask-result`

The outcome of one agent's question to another, by call id.

| Query | Required | Meaning |
|---|---|---|
| `call_id` | yes | The id of the call. |
| `wait_until_done` | no | `1` blocks until the call finishes or `timeout_ms` passes. |
| `timeout_ms` | no | Default `agentLoop.longTaskDefaultTimeoutMs`, capped at `agentLoop.longTaskMaxTimeoutMs`. |
| `waiter_agent`, `waiter_session` | no | Who waits. Registers the wait in the deadlock guard. |
| `agent`, `session` | no | The target. Needed after a restart, when the call is no longer in memory: the answer is then read from the target's history. |

```json
{ "call_id": "…", "state": "done", "target_agent": "<other-agent>",
  "target_session": "20260906-172957_research", "started_at": 1788000000000,
  "finished_at": 1788000042000, "response": "…", "outcome": "completed",
  "source": "registry" }
```

| Field | Meaning |
|---|---|
| `state` | `queued`, `running`, `done` or `failed`. Read from history it can also be `unknown`: the turn never ended. |
| `response`, `outcome` | The reply and the turn's outcome, once done. |
| `error` | Why it failed. `stopped by the user` and `removed from the queue by the user before it started` mean a person intervened. An agent should not retry those by itself. |
| `source` | `registry` (in memory) or `history` (read from the target session). |

`404` when the call is unknown and no `agent` and `session` were given,
or when the target session has no such call. `409` with
`circular_wait: true` and `chain` when waiting would close a cycle.

Reading a result cancels the wake-up the asker would otherwise get. A
`done` call may later be followed by one more message from the target,
when work it had started finishes after its reply. That follow-up
arrives as a normal turn with an `agent` origin and the same `callId`.

### `GET /a2a/turn-origin/:agent/:session`

Who started the turn that is running on a session. `agent_ask` uses it
to send a reply back to the session the question came from.

```json
{ "origin": { "agent": "<other-agent>", "session": "20260906-172957_research", "kind": "a2a" } }
```

| `kind` | Meaning |
|---|---|
| `a2a` | Another agent asked. |
| `subagent` | The session is a sub-agent's. The origin is the parent that started it. |
| `wake` | The turn is a wake-up. The origin is the agent and session whose answer caused it. |

`{"origin": null}` when the turn was started by a person or a trigger.

The `agent_ask` result names the rule that chose the target session as
`routing_reason`:

| `routing_reason` | Meaning |
|---|---|
| `explicit` | The caller named a session. |
| `reply_to_origin` | No session was named and the target is the origin agent, so the message went to the origin session. The result also has `session_inferred: true`. |
| `default_main` | Neither applied: the message went to `main`. A `routing_note` is added when the caller sits in another session. |

### Sub-agent tasks

Every sub-agent runs as a task: a brief that runs in a session of its
own and reports back. These routes are what `spawn_subagent` and the
`subagent_*` tools call. Tasks live in memory and are gone after a
restart.

### `POST /spawn-async`

Starts a task and returns at once.

| Body field | Required | Meaning |
|---|---|---|
| `agent` | yes | The agent that does the work. |
| `session` | yes | The session to run in. A slug that does not exist is created. An exact id that does not exist answers `404`. |
| `text` | yes | The brief. |
| `parent_agent`, `parent_session` | no | Who is told when the task ends. Default: `from_agent`, else the agent itself. |
| `from_agent` | no | Marks the turn as written by that agent. |
| `subagent_depth` | no | Nesting depth. |
| `model` | no | Model for this task. |
| `max_rounds` | no | Overrides `agentLoop.maxRounds`. |
| `attention` | no | `false` suppresses the parent's wake-up when the task ends. |
| `attachments` | no | Refs from `POST /attachments`. |

Returns `202 {task_id}`. `400` when `agent` or `session` is missing,
`429` when the agent already runs as many sub-agents as allowed.

### `GET /spawn-status?task_id=…`

The state of a task.

```json
{ "task_id": "task-…", "state": "running",
  "parent_agent": "<your-agent>", "parent_session": "20260913-101500_main",
  "target_agent": "<your-agent>", "target_session": "sub-<your-agent>-20260913-101700",
  "started_at": 1789299970000 }
```

`state` is `running`, `done`, `failed` or `cancelled`. `finished_at`
and `error` appear when they apply. `404` for an unknown id.

### `GET /spawn-result?task_id=…`

The result of a finished task.

| Query | Meaning |
|---|---|
| `task_id` | Required. |
| `wait_until_done` | `1` blocks until the task ends or `timeout_ms` passes. |
| `timeout_ms` | Capped at `agentLoop.longTaskMaxTimeoutMs`. |
| `waiter_agent`, `waiter_session` | Who waits. Joins the deadlock guard. |

Returns `{task_id, state, target_agent, target_session, result?, error?}`.
`result` is the turn result described under `POST /chat/send-sync`.

`result.follow_ups` holds texts that reached the parent after the
report: the outcome of work the sub-agent started and did not wait for.
Each one is announced to the parent with a `[subagent attention]`
wake-up.

| Status | Meaning |
|---|---|
| `409` | `{task_id, state: "running", error}`: not finished yet. With `circular_wait: true` and `chain`: the task waits on the caller. |
| `404` | Unknown id. |

Reading a finished result cancels the parent's pending wake-up.

### `GET /spawn-list?parent_agent=…`

Every task that agent started since the server came up. Returns
`{tasks: [...]}` with entries as in `GET /spawn-status`. `400` without
`parent_agent`.

### `POST /spawn-cancel`

Cancels a task and every task it started. A running turn is aborted, a
waiting one is taken out of its queue. Files it wrote stay.

| Body field | Required | Meaning |
|---|---|---|
| `task_id` | yes | The task. |
| `requesting_agent` | no | Acts as that agent, which must be the one that started the task (`403` otherwise). Without it the request acts as a person and the parent reads `stopped by the user`. |
| `reason` | no | Free text, added to the reason the parent reads. |

Returns `{cancelled: [task_ids], skipped: [{task_id, state}]}`. Tasks
that had already ended are skipped. `404` for an unknown id.

## Builder sessions

Agents of kind `builder` keep a mode, a phase, a plan file and a task
list per session, and at most one open question to the person. The web
client's task panel uses these routes, and so do the builder's own
tools `todo_write`, `ask_user` and `plan_write`.

### `GET /agents/:agent/sessions/:session/builder`

The builder state of a session.

```json
{ "agent": "<your-agent>", "session": "20260913-101500_main", "kind": "builder",
  "state": { "mode": "attended", "phase": "plan",
             "planPath": "/home/me/code/acme/PLAN.md",
             "todos": [ { "content": "Write the parser", "status": "pending" } ] },
  "question": null,
  "turn": { "turnId": "…", "startedAt": 1789299991000, "toolCalls": 7,
            "lastTool": "file_write", "lastToolAt": 1789299999000 } }
```

| Field | Meaning |
|---|---|
| `state` | `{mode, phase, planPath, todos, orderer?}`, or `null` before the session's first turn. `mode` is `attended` or `unattended`, `phase` is `plan` or `build`. |
| `question` | `{questionId, question, header?, options: [{label, description?}], multiple, askedAt, expiresAt}` or `null`. Also carries the question a builder raises before writing outside its project folder. |
| `turn` | Progress of the running turn, else `null`. |

### `PATCH /agents/:agent/sessions/:session/builder`

Changes mode, phase or plan file. Sends `builder_state`.

| Body field | Meaning |
|---|---|
| `mode` | `attended` or `unattended`. |
| `phase` | `plan` or `build`. |
| `planPath` | An absolute path, or `null` to clear it. |
| `orderer` | `{agent, session?}`: the agent that handed the order over. Set by `builder_dispatch`. |

Returns `{agent, session, state}`. `400` for a value outside these.

### `POST /agents/:agent/sessions/:session/builder/go`

Approves the plan: sets the phase to `build` and starts a turn that
tells the builder to carry it out.

| Body field | Meaning |
|---|---|
| `note` | Optional text added to that message. |

| Status | Body |
|---|---|
| `202` | `{agent, session, state, turnId}` |
| `202` | `{agent, session, state, turnId, callId, wakes}` when the state has an `orderer`. The turn then runs as that agent's question, and `wakes` names who gets the report. |
| `409` | `{error, busy}`: another builder's turn is working in the session's folder. |

### `PUT /agents/:agent/sessions/:session/todos`

Replaces the whole task list. Sends `todo_updated`.

| Body field | Meaning |
|---|---|
| `todos` | `[{content, status?, priority?}]`, at most 100. `status` defaults to `pending`. Each `content` is cut at 500 characters. |
| `by_agent` | Optional: who wrote it. |

Returns `{agent, session, todos}`.

### `PUT /agents/:agent/sessions/:session/plan`

Writes the session's plan file. Body `{content}`.

The path is the session's plan path. Without one it is `PLAN.md` in the
session's working folder, which is the pinned project's folder or the
workspace. Returns `{path, bytes, archived?, note?}`. Sends
`builder_state`.

If a plan was already there and this session did not write it, it is
moved aside first to `PLAN-<date>-<session>.md` and `archived` names
that file. `400` when the write policy forbids the path.

### `POST /agents/:agent/sessions/:session/ask`

Asks the person a question and **blocks** until they answer or the
wait runs out. Sends `question_asked`.

| Body field | Required | Meaning |
|---|---|---|
| `question` | yes | The question, at most 2000 characters. |
| `options` | yes | 2 to 6 of `{label, description?}`. |
| `header` | no | A short title, at most 40 characters. |
| `multiple` | no | `true` allows several answers. |
| `timeout_ms` | no | Default 30 minutes, at most 4 hours. |

Returns `{answered, answers: string[], text?}`. A second question on
the same session replaces the first, which returns unanswered.

### `POST /agents/:agent/sessions/:session/answer`

Answers the open question. Sends `question_answered`.

| Body field | Required | Meaning |
|---|---|---|
| `questionId` | yes | From `question_asked` or the builder state. |
| `answers` | no | The chosen labels. |
| `text` | no | A free-text answer. |

Returns `{ok: true}`. `404` when no such question is open.

### `GET /builders`

The builder agents and the folders each is working in right now.
Returns `{builders: [{name, role, description, busy: [{session, workdir, since}]}]}`.

### `GET /builders/busy`

Whether a running builder turn claims a folder.

| Query | Meaning |
|---|---|
| `workdir` | A path. The check also covers its parent and child folders. |

Returns `{workdir, busy}` where `busy` is
`{agent, session, turnId, workdir, since, reason}` or `null`. Without
`workdir` it returns `{claims: [...]}`.

### `POST /lsp/diagnostics`

Asks the language server about a file a builder just wrote. This is
what `file_write` and `file_patch` call.

| Body field | Required | Meaning |
|---|---|---|
| `agent`, `session` | yes | The builder session. |
| `path` | yes | Absolute path of the file. |
| `touch` | no | `true` only starts the server and returns `{diagnostics: null, touched: true}`. |

Returns `{diagnostics}` with `{server, errors, errors_in_other_files}`
or `null`. For an agent that is not a builder, or with language servers
switched off, it is `{diagnostics: null, reason}`.

### `GET /lsp/status`

The language servers somora knows. Returns
`{enabled, waitMs, servers: [{id, title, extensions, enabled, command, source}], running}`.

## Memory

Each agent has its own notes. A shared vault and the wiki can be
searched with them.

### `GET /agents/:agent/memory/notes`

The agent's indexed notes. Returns `{agent, count, notes}`.

### `GET /agents/:agent/memory/search`

Searches the agent's notes and the shared vault and wiki index by
keyword and by meaning. It is the search the `memory_search` tool uses.

| Query | Default | Meaning |
|---|---|---|
| `q` | required | The search text. |
| `limit` | 5 | 1 to 50. |
| `minScore` | 0 | 0 to 1. Hits below it are dropped. Recall during a turn uses `autoInject.minScore` instead. |

```bash
curl "$BASE/agents/<your-agent>/memory/search?q=voice+satellites&limit=5"
```

Returns `{agent, query, limit, minScore, count, hits}`. Each hit:

| Field | Meaning |
|---|---|
| `slug`, `source` | The note, and where it lives: `memory`, `wiki` or `vault`. |
| `score` | The combined score, scaled within this query's results. It is a rank, not a similarity. |
| `vecScore`, `bm25Score` | The meaning score and the keyword score. |
| `startLine`, `endLine`, `filePath`, `text` | The matching passage. |

For the whole note, call the `memory_get` tool through
`POST /agents/:agent/tools/:name`.

### `POST /agents/:agent/memory/recall-preview`

What a turn would recall for a message, without running a turn. Use it
to try a recall setting before changing the config.

| Body field | Required | Meaning |
|---|---|---|
| `text` | yes | The message. |
| `history` | no | Earlier messages, oldest first: `{kind, text}` with `kind` `user_message` or `assistant_message`. Other entries are ignored. |
| `autoInject` | no | Overrides any `memory.autoInject` setting for this call only. |

```json
{ "text": "and who else is in the family?",
  "history": [
    { "kind": "user_message", "text": "what can you tell me about Karl?" },
    { "kind": "assistant_message", "text": "Karl is …" } ],
  "autoInject": { "historyWeight": 0.4 } }
```

Returns `{agent, text, historyTurns, injectedCount, hits, ephemeralContextChars}`.
The hits have `slug`, `source`, `score`, `vecScore`, `bm25Score`,
`startLine` and `endLine`.

## Wiki explorer

Read access to the shared wiki. Every route except the status answers
`503` unless `wiki.enabled` and `obsidian.vault` are both set. Pages
are addressed by slug, never by path, so a request can only name pages
the wiki index already found.

### `GET /wiki/status`

Whether the wiki is on. Returns `{enabled, root?}`. Ask this once to
decide whether to show a wiki view.

### `GET /wiki/tree`

The folder tree with all pages.

```json
{ "root": "/path/to/vault/somora", "pages": 262, "builtAt": 1784750000000,
  "nodes": [
    { "type": "dir", "name": "people", "path": "people",
      "children": [
        { "type": "page", "slug": "people/muster-family",
          "name": "muster-family.md", "title": "Muster family",
          "description": "…", "mtimeMs": 1784700000000 } ] } ] }
```

A page's title is its first `# H1`, else `title` from its header, else
the file name.

### `GET /wiki/page?slug=<slug>`

One page with its links.

```json
{ "slug": "projects/somora", "title": "somora", "folder": "projects",
  "mtimeMs": 1784700000000,
  "markdown": "## Current state\n…",
  "frontmatter": { "type": "project" },
  "links":      [ { "slug": "people/nina-muster", "title": "Nina" } ],
  "backlinks":  [ { "slug": "agents/<your-agent>", "title": "Your agent" } ],
  "unresolved": ["people/muster-family"],
  "linkTargets": { "people/nina-muster": "people/nina-muster", "muster-family": null } }
```

`linkTargets` maps every `[[target]]` in the text to a slug, or to
`null` when nothing matches. A target matches by exact slug, by slug
without regard to case, or by a file name that exists only once. A file
name that exists several times resolves to `null`.

`400` without `slug`, `404` for an unknown page.

### `GET /wiki/graph?scope=local&slug=<slug>` · `?scope=global`

The link graph around one page, or of the whole wiki.

```json
{ "scope": "local",
  "nodes": [ { "id": "projects/somora", "label": "somora", "folder": "projects", "degree": 41 } ],
  "edges": [ { "from": "agents/<your-agent>", "to": "projects/somora", "type": "wikilink" } ],
  "truncated": false }
```

| Scope | Returns |
|---|---|
| `local` (default) | The page, what it links to, what links to it, and the links among those. Needs `slug`. |
| `global` | The whole wiki, capped at the 400 best-connected pages. `truncated` says whether the cap applied. |

`degree` always counts links in the whole wiki. Edge `type` is
`wikilink` for a `[[link]]` in the text and `related` for a `related:`
entry in the header. `index.md` is left out: it links to everything.

`400` when `local` has no `slug`, `404` for an unknown page.

### `POST /wiki/refresh`

Rebuilds the wiki index now. Returns `{pages, builtAt}`. Ordinary edits
show up without it: the index is kept for 10 seconds and then re-reads
only files that changed.

## Dream system

The three dream phases, REM, Deep and Lucid, turn conversations into
memory and wiki pages. These routes show their state and start them by
hand.

### `GET /dream-states` ⚠ experimental

The state of all three phases.

```json
{ "rem": { "<your-agent>": { "active": false, "pendingCount": 3 } },
  "deep":  { "active": false },
  "lucid": { "active": false, "pendingRuns": 0, "pendingFindings": 0 } }
```

| Field | Meaning |
|---|---|
| `rem.<agent>.active` | A REM dream is running for that agent. |
| `rem.<agent>.pendingCount` | Finished REM dreams that wait for review. |
| `deep.active`, `lucid.active` | A run is in progress. |
| `lucid.pendingRuns`, `lucid.pendingFindings` | Lucid runs and findings that wait for review. `oldestPendingAt` is added when there are any. |
| `lucid.loopHolder` | The agent that is reviewing Lucid findings right now, when one is. |

### `GET /dream/loop-state`

Whether an agent is reviewing Lucid findings right now.

```json
{ "active": true, "agent": "<your-agent>", "dreamId": "lucid-…",
  "startedAt": "…", "lastActivityAt": "…" }
```

`{ "active": false }` when nobody is.

### `POST /agents/:agent/dream/run-rem`

Starts REM for one agent now, without waiting for the agent to go
quiet. It always runs in the background, and chat activity pauses it as
usual.

```json
{ "agent": "<your-agent>", "outcome": "started", "started": true, "message": "…" }
```

`outcome` is `started`, `busy` (already running) or `nothing_to_do`.
`400` when REM is not enabled for the agent, `409` when it was enabled
after the server started.

### `POST /dream/run-deep`

Starts a Deep run.

| Body field | Default | Meaning |
|---|---|---|
| `wait` | `false` | `true` waits for the run and returns its result. |
| `force` | `false` | `true` re-reads every memory file, also those the skip cache would leave out. |

Without `wait`: `{started: true, wait: false, force, message}`. With
it: `{wait: true, force, candidatesSeen, cachedSkips, durationMs, counts, outcomes}`.
`400` when the wiki is off.

### `POST /dream/run-lucid`

Starts a Lucid run. Same body as `POST /dream/run-deep`. While an
earlier run still has findings waiting for review, no new run starts
unless `force` is `true`.

Without `wait`: `{started: true, wait: false, message}`. With it:
`{wait: true, runId, findingsCount, pagesScanned, durationMs, status}`.
`400` when the wiki is off.

## Wiki migration

These routes move a grown wiki onto the folder template, in steps:
plan, refine, approve, execute. Plan ids look like `20260929-104047`.
Each plan has a folder under `~/.somora/wiki-migration/<id>/`. All
write routes answer `400` when the wiki is off or the id is malformed.

### `POST /wiki/migration/plan`

Step one. Reads the whole wiki and writes down what a migration would
do. Nothing in the wiki is touched.

```json
{ "id": "20260929-104047",
  "plan": "/home/me/.somora/wiki-migration/20260929-104047/plan.md",
  "pagesTotal": 991, "foldersTotal": 71,
  "summary": { "move_folder": { "items": 19, "pages": 40 },
               "unite_twins": { "items": 19, "pages": 38 },
               "fold_report": { "items": 190, "pages": 190 },
               "review_pages": { "items": 37, "pages": 447 },
               "describe_folder": { "items": 0, "pages": 0 },
               "unclear": { "items": 0, "pages": 0 } },
  "durationMs": 1830 }
```

### `POST /wiki/migration/refine`

Step two. The Lucid model, or else the Deep model, judges every page
the plan is unsure about or would move: keep, move, fold into another
page, or unclear. Still nothing is written into the wiki.

| Body field | Default | Meaning |
|---|---|---|
| `id` | required | The plan id. |
| `wait` | `false` | `true` returns the result in the response. |
| `batchSize` | 25 | Pages per model call. |

Without `wait`: `{id, started: true, message}`. With it:
`{id, refined, pagesJudged, batchesTotal, batchesFailed, groups: [{action, target, pages}]}`.
The result is also written as `refined.md` and `refined.json` beside
the plan. `404` for an unknown plan, `409` while a refine for it runs.

### `GET /wiki/migration/plans/:id`

The plan, the progress of a running step and the approvals.

```json
{ "id": "20260929-104047", "dir": "…/wiki-migration/20260929-104047",
  "plan": { "pagesTotal": 991, "foldersTotal": 71, "summary": {}, "createdAt": "…" },
  "refine": { "started": "…", "done": 12, "total": 27 },
  "execute": null,
  "approvals": { "planId": "…", "groups": { "move:rules": { "status": "approved", "at": "…" } }, "twins": {} },
  "refined": { "model": "…", "pagesJudged": 943, "batchesTotal": 38, "batchesFailed": 0,
               "createdAt": "…",
               "groups": [ { "action": "move", "target": "rules", "pages": 50 } ] } }
```

`refine` and `execute` are `null` when that step has not run since the
server started. A finished step has `finished`, a failed one `error`.

### `POST /wiki/migration/plans/:id/approve`

Step three. Marks groups of the refined plan.

| Body field | Meaning |
|---|---|
| `groups` | Group keys such as `move:rules` or `fold:projects/somora`. |
| `action` | `move`, `fold` or `unclear`: every group of that action. |
| `twins` | Names of twin pages to unite, or `"all"`. |
| `status` | `approved` (default), `dismissed` or `pending`. |

```json
{ "id": "…", "status": "approved", "touched": 3,
  "approvedGroups": 12, "approvedPages": 310, "approvedTwins": 19 }
```

`404` until the plan has a refined result.

### `POST /wiki/migration/plans/:id/execute`

Step four. Runs the approved part.

| Body field | Default | Meaning |
|---|---|---|
| `dryRun` | `true` | A dry run writes `dry-run.md` beside the plan and touches nothing. |
| `confirm` | none | A real run needs `{"dryRun": false, "confirm": "move my wiki"}`. |
| `wait` | `false` | `true` returns the result in the response. |

A real run first copies the whole wiki into `backup-<time>/` under the
plan and does not start when the copy is incomplete.

Without `wait`: `{id, dryRun, started: true, message}`. With it:

```json
{ "id": "…", "dryRun": false, "report": "…/execution-20260929-131500.md", "steps": 768,
  "counts": { "move": 207, "fold": 540, "unite": 19, "failed": 2, "skipped": 0 },
  "linksRewritten": 812, "foldersRemoved": 51, "backupDir": "…/backup-20260929-131412",
  "reindex": { "indexed": 610, "skipped": 380 } }
```

`404` without a refined result, `409` while a run for that plan is
going.

### `POST /wiki/migration/plans/:id/relink`

Goes over every page again with the renames a finished run recorded.
`[[links]]` and `related:` entries that still name a moved, folded or
united page are pointed at its new place. Safe to repeat. Body
`{"dryRun": true}` only counts.

```json
{ "id": "…", "dryRun": false, "renames": 819, "refsRewritten": 393, "pagesTouched": 224 }
```

`404` when the plan has no finished run.

### `POST /wiki/migration/reindex`

Runs one full pass of the shared search index now. `somora wiki migrate
undo` calls it after putting a backup back. Returns
`{indexed, skipped}`. `503` when the index cannot run it yet.

## Projects

A project links a session to a folder, links and a description. The
feature is opt-in: every route except the first answers `503` when
`projects.enabled` is `false`.

### `GET /projects/feature`

Whether projects are on. Always answers `200`.

```json
{ "enabled": true, "entityCount": 2 }
```

### `GET /projects/entities`

The fixed list of entities a project can belong to, from
`projects.entities` in the config.

```json
{ "entities": [ { "slug": "private", "label": "Private" },
                { "slug": "acme", "label": "acme" } ] }
```

### `GET /projects`

The projects.

| Query | Meaning |
|---|---|
| `entity` | Only this entity. |
| `tag` | Only projects with this tag. |
| `includeArchived=true` | Also archived projects. |

```json
{ "total": 1,
  "projects": [
    { "slug": "home-cinema", "name": "Home cinema", "entity": "private",
      "description": "Receiver, projector, …", "color": "#4f46e5",
      "tags": ["hardware", "wip"],
      "created": "2026-04-15T10:23:00Z", "updated": "2026-05-13T09:42:00Z",
      "archived": false,
      "paths": [ { "ref": "~/code/home-cinema", "label": "Source code" },
                 { "ref": "https://example.com/plans" } ],
      "workdir": "~/code/home-cinema" } ] }
```

### `GET /projects/:slug`

One project as `{project}`. `400` for a malformed slug, `404` when it
does not exist.

### `POST /projects`

Creates a project.

| Body field | Required | Meaning |
|---|---|---|
| `slug` | yes | Must match `[a-z0-9_-]+` and be new. |
| `name` | yes | Display name. |
| `entity` | yes | One of the slugs from `GET /projects/entities`. |
| `description`, `color`, `tags`, `expires` | no | Free fields. `expires` is a date string or `null`. |
| `paths` | no | `[{ref, label?}]`. A `ref` is `https://…`, `~/path`, `/path`, or `<resource>:/path` with a resource from the config. |
| `workdir` | no | The project's working folder. A session that pins the project works there. |

| Status | Body |
|---|---|
| `201` | `{project}` |
| `400` | A required field is missing, the slug is malformed, the entity is unknown or a `ref` is not valid. The error lists what is available. |
| `409` | A project with that slug exists. |

### `PATCH /projects/:slug`

Changes a project through a list of operations. All are checked first:
if one fails, nothing is written.

```json
{ "ops": [
    { "op": "add_path", "ref": "~/research/atmos.md", "label": "Atmos notes" },
    { "op": "set_field", "field": "description", "value": "Updated" },
    { "op": "set_tags", "tags": ["hardware", "wip"] } ] }
```

| `op` | Fields | Effect |
|---|---|---|
| `set_field` | `field` (`name`, `description`, `color`, `expires`, `workdir`), `value` (string or `null`) | Sets the field. `null` clears it. `name` cannot be cleared. |
| `add_path` | `ref`, `label?` | Adds a path. Checked as in `POST /projects`. `400` when it is already there. |
| `remove_path` | `ref` | Removes the path with exactly that `ref`. `400` when it is not there. |
| `set_tags` | `tags` | Replaces all tags. |
| `archive` | `reason?` | Hides the project. |
| `unarchive` | none | Brings it back. |

Returns `{project}`. `400` for a bad operation, `404` for an unknown
project. Slug and entity cannot be changed.

### `GET /agents/:agent/sessions/:session/project`

The project pinned to a session.

| Case | Body |
|---|---|
| Pinned | `{agent, session, slug, project}` |
| Nothing pinned | `{agent, session, slug: null, project: null}` |
| Pinned, but the project file is gone | `{agent, session, slug, project: null, missing: true}` |

### `POST /agents/:agent/sessions/:session/project`

Pins a project to a session. Body `{"slug": "<slug>"}`; `null` clears
the pin. Returns `{agent, session, previousSlug, currentSlug}` and
sends a `project` event. `400` without `slug` or for an unknown
project.

### `DELETE /agents/:agent/sessions/:session/project`

Clears the pin. Returns `{agent, session, cleared: true, previousSlug}`
and sends a `project` event.

## Attachments

Files for a chat turn travel in two steps: upload first, then name the
upload in `attachments` on `POST /chat/send` or `POST /chat/send-sync`.

### `POST /attachments`

Uploads one file as the raw request body. The file name goes into the
`X-Somora-Filename` header, URL-encoded.

```bash
curl -X POST $BASE/attachments \
     --data-binary @./screenshot.png \
     -H "Content-Type: image/png" \
     -H "X-Somora-Filename: screenshot.png"
```

```json
{ "hash": "9f2c…", "name": "screenshot.png", "mime": "image/png",
  "kind": "image", "size": 184320 }
```

The type is read from the bytes, not from the name. The same content
is stored only once. Pass the whole object on in `attachments`.

| Status | When |
|---|---|
| `400` | No body, or the file breaks a limit from `attachments` in the config. |
| `415` | A `multipart/form-data` upload. Send the raw bytes. |

### `GET /attachments/:hash`

The bytes of an uploaded file, for showing what the agent saw. `:hash`
is the 64-character hash. `400` for a malformed hash, `404` when it is
unknown.

## Files

### `GET /files/view`

Describes a file on the server by absolute path, and returns its text
when it is a text file. The shipped clients use it to open paths that
agents mention in chat.

| Query | Required | Meaning |
|---|---|---|
| `path` | yes | Absolute path. A leading `~` is expanded. |

The route follows the same rules as the `file_read` tool: what an agent
may read, you may view. Links are resolved before the check.

| File | `kind` | The response carries |
|---|---|---|
| `.md`, `.markdown` | `markdown` | `content` |
| `.txt`, `.log`, other text | `text` | `content` |
| `.json`, `.jsonl`, `.yaml`, `.yml`, `.toml`, `.svg` | `code` | `content` |
| PNG, JPEG, GIF, WebP | `image` | `url`, `mime` |
| MP4, MOV, WebM | `video` | `url`, `mime` |
| WAV, MP3, OGG, FLAC, M4A | `audio` | `url`, `mime` |
| PDF | `pdf` | `url`, `mime` |
| anything else | `binary` | `url`, `mime` |

Media and unknown files are recognised from their bytes, not from the
extension. An `.svg` is shown as its source, because it can carry
script.

```json
{ "path": "/home/me/somoraworkspace/report.md", "kind": "markdown",
  "ext": ".md", "bytes": 4321, "content": "# Report\n…",
  "truncated": false, "downloadUrl": "/files/raw?download=1&path=…" }
```

```json
{ "path": "/home/me/somoraworkspace/shots/run-12.png", "kind": "image",
  "ext": ".png", "bytes": 184320, "mime": "image/png",
  "url": "/files/raw?path=…", "downloadUrl": "/files/raw?download=1&path=…" }
```

Text is cut at 200 000 characters; `truncated` is then `true` and
`truncated_reason` says why. Every response has `downloadUrl`.

| Status | When |
|---|---|
| `400` | `path` is missing, relative, a folder or not a regular file. |
| `403` | The read rules forbid the path. |
| `404` | The file does not exist. |

### `GET /files/raw`

The bytes of a file: media to show in place, and a download for
everything else. Same path rules as `GET /files/view`.

| Query | Required | Meaning |
|---|---|---|
| `path` | yes | Absolute path. |
| `download` | no | `1` forces a download. |

- Range requests work (`206`, `416`, and `bytes=-N` for the end), so a
  video player can seek. There is no size limit.
- `Content-Type` comes from the bytes, with
  `X-Content-Type-Options: nosniff`.
- Only images, video, audio and PDF are served `inline`. Everything
  else is an attachment.

Errors as for `GET /files/view`.

## Images

Image generation. The routes that list, generate or ask a provider
answer `503` unless `imageGen.enabled` is set and at least one model is
configured.

### `GET /images/status`

Whether image generation is on. Returns `{enabled: false}`, or
`{enabled: true, outputDir, maxImagesPerTurn, models: [{name, label, model, provider, defaults}]}`.

### `GET /images`

The generated images, newest first.

| Query | Default | Meaning |
|---|---|---|
| `query` | none | Part of the prompt, case-insensitive. |
| `model`, `agent` | none | Only this model or agent. |
| `since`, `until` | none | `YYYY-MM-DD`. |
| `limit` | 60 | At most 200. |
| `offset` | 0 | For paging. |

Returns `{total, offset, items, totalBytes}`. `total` counts all
matches, not only this page. The items are media records, see
`GET /media`.

### `GET /images/:id`

One record: prompt, model, specs, path, type, size, cost, agent and
session.

### `GET /images/:id/file`

The image bytes. `?download=1` forces a download. `410` when the
record exists but the file was moved or deleted. Files are addressed
by record id, never by path.

### `GET /images/models/:name/capabilities`

What a configured image model accepts.

| Field | Meaning |
|---|---|
| `model`, `defaults` | The configured name and its default specs. |
| `source` | Where the answer comes from: `catalog`, `config` or `unknown`. |
| `known` | Whether anything is known about the model. |
| `values` | Allowed values per spec field. A field that is missing here has no known limit: offer free input for it. |
| `recommended`, `supported` | The provider's recommended values and supported fields, or `null`. |
| `maxN`, `maxReferences` | Most images per request and most reference images, or `null`. |
| `sizeAlsoAccepts` | Named ratios the endpoint takes in `size`, or `null`. |

`404` for an unknown model name.

### `GET /images/catalog`

The image models a provider offers right now. `?provider=<name>`
picks the provider; the default is the one behind the first configured
model. Returns `{provider, models: [{id, name?}]}`. The config still
decides which models somora calls. `400` for an unknown provider.

### `POST /images/generate`

Generates images.

| Body field | Required | Meaning |
|---|---|---|
| `prompt` | yes | What to draw. |
| `model` | no | A configured model name. |
| `resolution`, `aspect_ratio`, `size`, `quality`, `output_format`, `background`, `output_compression`, `seed`, `n`, `steps`, `cfg`, `guidance` | no | Specs. Which ones a model takes is in its capabilities. |
| `reference_images` | no | Images as base64 strings. The `image_generate` tool takes file paths instead. |
| `session` | no | Recorded with the image. |

Returns `{images: [record], costUsd, warnings?, fellBackFrom?}`.
`warnings` lists what the endpoint did differently than asked, for
example a size it replaced. `fellBackFrom` names the models that were
unavailable when a backup model was used. A `save_to` field is ignored:
every image lands in the configured images folder.

| Status | Meaning |
|---|---|
| `400` | Something the caller can fix. The message names the field and the values that work. |
| `502` | The provider failed. |
| `503` | The model is configured but not loaded right now. |

Error bodies carry `kind` beside `error`.

### `DELETE /images/:id`

Forgets the record. The file on disk is kept. Returns
`{ok, path, fileKept: true}`.

## Media

One gallery over everything somora generated: images and videos.

### `GET /media`

| Query | Default | Meaning |
|---|---|---|
| `kind` | both | `image` or `video`. |
| `agent` | none | Only this agent. |
| `query` | none | Part of the prompt. |
| `limit` | 60 | At most 200. |
| `offset` | 0 | For paging. |

Returns `{total, offset, items, totalBytes}`. A media record:

| Field | Meaning |
|---|---|
| `id`, `kind`, `createdAt` | `kind` is `image` or `video`. A record without `kind` is an image. |
| `prompt`, `modelName`, `modelId`, `provider`, `specs` | How it was made. |
| `path`, `filename`, `mime`, `bytes` | The file. |
| `width?`, `height?`, `durationSec?` | Size, and length for a video. |
| `thumbPath?`, `thumbMime?` | A video's still image. |
| `costUsd?`, `agent?`, `session?`, `references?` | Cost, who made it, reference images. |
| `batchId`, `batchIndex`, `linkedTo` | Grouping of images made in one request. |

### `GET /media/:id`

One media record. `404` when unknown.

### `GET /media/:id/file`

The bytes, served `inline`. `?download=1` forces a download. Range
requests work (`206`, `416`), so a video player can seek. `410` when
the file left the disk.

### `GET /media/:id/thumb`

A video's still image, `image/webp` unless the record says otherwise.
Same behaviour as `/file`. `404` when there is none.

### `DELETE /media/:id`

Removes the record. Returns `{ok: true}` or `404`.

## Video

Video generation runs as jobs. A request starts one and returns at
once. It is on when `videoGen.enabled` is set and a model is
configured. When the file is ready it becomes a media record, and an agent
that started the job is woken with a turn whose origin is
`{kind: "wake", about: "job"}`.

### `GET /video/status`

Whether video generation is on, and the jobs.

| Query | Meaning |
|---|---|
| `agent` | Only this agent's jobs. |

Returns `{enabled: false, reason}` when it is off. Otherwise:

| Field | Meaning |
|---|---|
| `active`, `limit` | Jobs running now and the most allowed at once (`videoGen.maxConcurrent`). |
| `models` | `[{name, label, model, provider, wire}]` |
| `jobs` | Each `{id, providerJobId, modelName, provider, prompt, specs, status, progress?, queuePosition?, error?, createdAt, updatedAt, mediaId?, path?, agent?, session?, references?}`. |

A job's `status` is `queued`, `in_progress`, `completed` or `failed`.
`mediaId` appears once the file is stored. It is the id for
`GET /media/:id`.

### `POST /video/generate`

Starts a job.

| Body field | Required | Meaning |
|---|---|---|
| `prompt` | yes | What to show. |
| `model` | no | A configured model name. |
| `seconds`, `size`, `aspect_ratio`, `audio`, `quality`, `seed` | no | Specs. |
| `reference_images` | no | Images as base64 strings. |
| `agent`, `session` | no | Who is woken when the job ends. |

Returns `{job}`. Follow it with `GET /video/status`.

| Status | Meaning |
|---|---|
| `400` | A bad request. |
| `429` | All job slots are busy. |
| `502` | The provider failed. |
| `503` | Video is off, or the model is not available right now. |

## Voice

Dictation and spoken replies. Each route answers `503` when its part,
`stt` or `tts`, is not enabled in the config.

### `GET /stt/config`

Whether dictation is available. Returns `{enabled, language}` or
`{enabled: false}`. `language` is the default language hint or `null`.

### `POST /stt/transcribe`

Turns a recording into text. The body is `multipart/form-data`.

| Form field | Required | Meaning |
|---|---|---|
| `file` | yes | The recording. |
| `language` | no | Overrides the configured language. |

Returns `{text}`. `400` for a wrong body, `502` when the transcription
service failed or was unreachable.

### `GET /tts/config`

Whether spoken replies are available, and the defaults per client.

```json
{ "enabled": true,
  "formats": ["audio/wav", "audio/opus", "audio/mp4"],
  "language": "de", "voice": null,
  "clients": {
    "web":    { "autoPlayVoiceReplies": false, "allowUserOverride": true },
    "mobile": { "autoPlayVoiceReplies": false, "allowUserOverride": true } } }
```

`formats` is only `audio/wav` when re-encoding is off. Returns
`{enabled: false}` when spoken replies are off.

### `POST /tts/synthesize`

Speaks a text. The response body is the audio. The format is chosen
from the `Accept` header.

| Body field | Required | Meaning |
|---|---|---|
| `text` | yes | At most 4000 characters. |
| `voice`, `language` | no | Override the configured ones. |
| `agent` | no | Use this agent's voice settings. |

| Response header | Meaning |
|---|---|
| `Content-Type` | `audio/wav`, `audio/opus` or `audio/mp4`. |
| `X-Tts-Cache` | `hit` or `miss`. |
| `X-Tts-Cache-Key` | The key under which the audio is cached. |
| `X-Tts-Duration-Ms` | The length, when it is known. |

`400` for a missing or too long text, `502` when the speech service
failed.

### `GET /tts/cache/:filename`

A cached audio file. File names have the form
`<64 hex characters>.<wav|opus|m4a>`. This is the URL in
`assistant_audio.url`, so a client can hand it straight to an audio
player. A `Range: bytes=N-` request works, for seeking.

`400` for another file name, `404` when the file is not cached.

### `POST /voice/turn`

Audio in, audio out, in one request: transcribes the recording, runs a
normal turn with it, and speaks the reply. The turn shows up in the
session and on its stream like any other. The body is
`multipart/form-data`.

| Form field | Required | Meaning |
|---|---|---|
| `audio` | yes | The recording. |
| `agent` | yes | Agent name. When left out, the first agent is used. |
| `session` | no | Default `main`. A slug that does not exist is created. An exact id that does not exist answers `404`. |
| `voice`, `language` | no | For the spoken reply. Default: `tts.voice`, `tts.language`. |

The audio format is chosen from the `Accept` header.

```json
{ "ok": true, "agent": "<your-agent>", "session": "main",
  "transcript": "What time is it?",
  "text": "It is 10:29.",
  "audio": { "url": "/tts/cache/abc123….opus", "mime": "audio/opus",
             "durationMs": 1800, "cacheKey": "abc123…" } }
```

The reply is always spoken, whatever a client's auto-play setting says.
A reply that is mostly code or tables is replaced by a short spoken
note that points to the chat.

`502` when transcription returned nothing, the agent gave no reply or
speech failed.

### `assistant_audio` SSE event

After a turn whose reply was spoken, the session's stream sends:

```
event: assistant_audio
data: {"turnId":"…","url":"/tts/cache/….opus","mime":"audio/opus","durationMs":1800,"cacheKey":"…"}
```

Match it by `turnId` and offer a play button on that reply. The event
is also stored, so `GET /chat/history` returns it.

## Realtime voice

A standing call with an agent that you can interrupt. Off unless
`realtimeVoice.enabled` is set. This is separate from dictation and
spoken replies.

### `GET /voice/status`

Whether calls are possible, and with whom.

```json
{ "enabled": true, "provider": "openai", "model": "gpt-realtime-2.1-mini",
  "maxCallMinutes": 20, "agents": ["<your-agent>"], "calls": [] }
```

`agents` lists who can be called: agents whose `agent.yaml` has
`voice.enabled: true`. `calls` lists the calls in progress. With the
feature off the answer is `{"enabled": false, "agents": []}` with
status `200`.

### `GET /voice/instructions?agent=<name>&session=<slug>`

What the speaking model would be told, without starting a call.

```json
{ "agent": "<your-agent>", "session": "main",
  "text": "You are <your-agent>, speaking out loud …", "chars": 1528,
  "source": "derived", "voice": "ash", "language": "de", "consultPolicy": "always" }
```

`source` is `derived` when the text is built from the agent's persona
and its `voice:` settings, or `VOICE.md` when the agent has that file.
`503` when realtime voice is off, `404` when the agent has no voice.

### `WS /voice/attach?agent=<name>&session=<slug>`

The call itself, as a WebSocket with JSON text frames in both
directions. `session` defaults to `main`.

Client to server:

| Frame | Meaning |
|---|---|
| `{"type": "audio", "base64": "…"}` | Microphone audio: PCM16, 24 kHz, mono. |
| `{"type": "interrupt"}` | Stop the model's speech. |
| `{"type": "hangup"}` | End the call. |

Server to client:

| Frame | Meaning |
|---|---|
| `{"type": "ready", "call", "rateHz": 24000}` | The call is up. |
| `{"type": "audio", "base64", "rateHz"}` | Speech to play. |
| `{"type": "state", "call"}` | The call's state changed. |
| `{"type": "event", "event", "call"}` | Something happened. `event.kind` is `user_speech`, `user_transcript`, `model_speech`, `model_transcript`, `tool_call`, `interrupted`, `usage`, `closed` or `error`. |

`call` is `{id, target, state, startedAt, consults, spokenTurns, handoverTo?, lastError?}`.
`state` is `connecting`, `listening`, `consulting`, `speaking` or
`closed`. `consulting` means the agent is running a real turn in the
session. `target` changes when the call is handed to another agent.

> **Note:** Keep sending audio while nobody speaks. The model ends a
> turn on silence, not on missing packets.

Closing the socket ends the call. Work the agent already accepted
keeps running. The socket closes with code `1008` when realtime voice
is off or the call cannot start, and `1000` when the call ended.

## Tmux integration

Terminals in the browser: tmux sessions on the server, and a plain
shell.

### `GET /tmux/sessions`

The tmux sessions on the server.

```bash
curl $BASE/tmux/sessions
```

Returns `{sessions: [{name, windows, activeCommand, activeTitle, createdEpoch, lastActivityEpoch, origin?}]}`.
The two `…Epoch` fields are in seconds. `origin` says which agent and
session created the tmux session, when somora did.

### `WS /tmux/attach?session=<name>`

A WebSocket to `tmux attach-session -d -t <name>`.

| Direction | Frame | Meaning |
|---|---|---|
| server to client | binary | Terminal output. |
| client to server | binary | Keyboard input. |
| client to server | text `{"type":"resize","cols":N,"rows":N}` | The terminal's size changed. |
| server to client | text `{"type":"ping"}` | Sent every 25 seconds. |

Any message from the client counts as a sign of life. After 80 seconds
without one the server closes the socket with code `4000`, so answer
each ping, for example with `{"type":"pong"}`. Code `1008` means the
session name is invalid or unknown, `1011` that tmux could not start,
`1000` that tmux exited.

### `WS /terminal/attach`

A WebSocket to a fresh shell in the default workspace folder, without
tmux. Same frames, pings and close codes as `/tmux/attach`. The shell
ends when the socket closes.

## Browser

The shared browser that agents drive and people can watch and take
over. With `browser.enabled` off, the routes that change something
answer `503`, and the status and its stream report
`{enabled: false, browsers: [], warnings: []}`.

### `GET /browser/status`

The open browser windows.

```json
{ "enabled": true, "headed": "headless",
  "browsers": [
    { "view_id": "profile:team@<your-agent>", "agent": "<your-agent>",
      "browser_id": "profile:team", "profile": "team", "ephemeral": false,
      "state": "running", "control": "agent_control",
      "tabs": [ { "tab_id": "t1", "url": "https://example.com", "title": "Example",
                  "agent": "<your-agent>", "generation": 3 } ],
      "last_used": 1789299999000 } ],
  "warnings": [] }
```

| Field | Meaning |
|---|---|
| `browsers` | One entry per window, not per browser process. `view_id` is `<browser_id>@<agent>`. Agents that share a profile share a process and have one window each. |
| `control` | `agent_control`, `handoff_requested`, `human_control` or `paused`. `human_by` and `handoff` are added when they apply. |
| `tabs` | `{tab_id, url, title, agent, session?, generation, emulation?}`. `emulation` shows a tab's `device` and `locale`. |
| `headed` | How windows are shown on the server, following `browser.headed`: `headless`, `display`, `xvfb` or `unavailable`. |
| `warnings` | What needs fixing, for example that no Chromium was found. |

Stopped browsers are not listed, except one that still holds an open
hand-over.

### `GET /browser/stream`

The browser status as Server-Sent Events.

| Event | When | Data |
|---|---|---|
| `browsers` | On connect, and whenever a window, tab or control state changes | `{enabled, browsers, warnings}` as in `GET /browser/status` |
| `heartbeat` | Every `sse.heartbeatMs` | The current time in ms |

Each `browsers` event is a complete snapshot that replaces the one
before.

### `POST /browser/op`

Runs one operation of the `browser` tool for an agent, in that agent's
window.

| Body field | Required | Meaning |
|---|---|---|
| `agent` | yes | The agent. |
| `session` | no | Its session. |
| `input` | yes | The tool's arguments, for example `{"op": "open", "url": "…"}` or `{"op": "snapshot", "tab": "…"}`. |

Returns the tool's result object (`ok`, `error`, `hint`, `tab`,
`snapshot` and so on). A refusal by the tool is still a `200`. `400`
without an `input.op`, `404` for an unknown agent.

### `POST /browser/:id/restart`

Reopens a stopped browser with a blank page and the same profile.
`:id` is a window id or a browser id. Every window that existed comes
back with its control state. Nothing is replayed. Returns `{ok: true}`,
or `409 {error}` when the browser is unknown or its shared profile was
removed from the config.

### `POST /browser/:id/control`

Takes a window over, or hands it back to its agent. `:id` is a window
id such as `profile:team@<your-agent>`. A bare browser id works while
only one agent has a window on it.

| Body field | Required | Meaning |
|---|---|---|
| `mode` | yes | `human` takes control: the agent's operations in that window are refused until it is handed back. `agent` hands it back. |
| `by` | no | Who acts. With it, somebody else's control cannot be handed back. |
| `handoffId` | no | The id of the hand-over being answered, from the status. Prevents a late button press from waking the agent twice. |

Returns `{ok: true, control}`.

Handing back with an open hand-over wakes the agent that asked for it,
once, in its session. Without one, a hand-back after real activity
wakes the window's own agent in the session of the last tab it used.

| Status | Meaning |
|---|---|
| `400` | `mode` is neither `human` nor `agent`. |
| `404` | The browser is not running. |
| `409` | A state conflict, such as a `handoffId` that does not match. |

### `GET /browser/attach` (WebSocket)

The live picture of one browser window, with input.

| Query | Meaning |
|---|---|
| `view` | The window id `<browser_id>@<agent>`. `browser` is accepted as the parameter name too. |
| `tab` | The tab to show first. Optional. |
| `viewer` | An id for this viewer. Optional. |

Binary frames from the server carry one JPEG each:
`[u32 BE header length][JSON header][JPEG]`. The header is
`{tabId, generation, seq, url, cssWidth, cssHeight, scrollX, scrollY, ts}`.
The frame rate follows `browser.stream.maxFps` (default 15, at most 20).
Frames are skipped for a viewer with more than 2 MB waiting to be sent.

Text frames from the server:

| `type` | Data | Meaning |
|---|---|---|
| `ready` | `{browser, tabId, viewerId}` | Attached, or switched to another tab. |
| `tabs` | `{browser}` | Tabs or control changed. |
| `control` | `{control}` | Answer to a control request. |
| `notice`, `error` | `{text}` | A hint, or a failed request. |
| `ping` | none | Answer with `{"type":"pong"}`. 80 seconds of silence close the socket. |

Text frames from the viewer:

| `type` | Data | Meaning |
|---|---|---|
| `control` | `{mode: "human"\|"agent", handoffId?}` | Take over or hand back. |
| `tab` | `{tabId}` | Show another tab. |
| `navigate` | `{url}` | Open a URL. Same rules as for the tool. |
| `newtab`, `closetab` | none, `{tabId}` | Open or close a tab. |
| `resize` | `{width, height}` | Resize the page. |
| `mousemove`, `click`, `mousedown`, `mouseup` | `{x, y, button?, clickCount?}` | Pointer input, in CSS pixels of the shown page. |
| `wheel` | `{x, y, deltaX, deltaY}` | Scrolling. |
| `text` | `{text}` | Typed or pasted text. |
| `key` | `{key, ctrl?, alt?, shift?, meta?, action?}` | A key by its Playwright name, such as `Enter` or `Control+a`. |
| `back`, `forward`, `reload` | none | History and reload. |

Everything except `control` and `tab` is applied only while this viewer
holds control; otherwise it gets a `notice`. Input other than
`navigate`, `newtab`, `closetab`, `tab` and `control` must carry
`frameTab` and `generation` from the frame on screen, and input for an
older picture is refused.

| Close code | Meaning |
|---|---|
| `1008` | Bad request: unknown browser, browser switched off, or more than 64 inputs waiting. |
| `1009` | A message larger than 64 KiB. |
| `1012` | The server is shutting down. |
| `4000` | No sign of life for 80 seconds. |
| `4001` | The tab or the browser was closed. |

## Sentinel

Sentinel wakes agents on a schedule. These routes list and manage the
triggers. The same operations are available to agents as the `sentinel`
tool.

### `GET /sentinel/triggers`

All triggers, newest first.

| Query | Meaning |
|---|---|
| `owner` | Only triggers of this agent. |
| `status` | `active`, `paused`, `error` or `completed`. |

```json
{ "count": 1,
  "triggers": [
    { "id": "morning-mail-summary-a7c3", "name": "morning-mail-summary",
      "ownerAgent": "<your-agent>",
      "source": { "type": "time", "spec": { "type": "daily", "time": "08:00" } },
      "evaluator": { "type": "none" },
      "dispatch": { "agent": "<your-agent>", "session": "morning-routine",
                    "prompt": "Check the inbox …" },
      "createdAt": "2026-05-17T11:00:00.000Z", "status": "active",
      "fireCount": 5, "lastSuccessAt": "2026-05-17T08:00:01.234Z",
      "errorStreak": 0, "nextFireAt": "2026-05-18T08:00:00.000Z" } ] }
```

### `GET /sentinel/triggers/:id`

One trigger as `{trigger}`.

### `GET /sentinel/triggers/:id/history`

The fires of a trigger, newest first. `?limit=N`, default 50, at most
200.

```json
{ "count": 2,
  "entries": [
    { "firedAt": "2026-05-17T08:00:01.234Z", "scheduledFor": "2026-05-17T08:00:00.000Z",
      "outcome": "success", "taskId": "task-…" },
    { "firedAt": "2026-05-16T08:00:00.500Z", "scheduledFor": "2026-05-16T08:00:00.000Z",
      "outcome": "skipped", "skipReason": "cooldown (1320s remaining)" } ] }
```

| `outcome` | Comes with |
|---|---|
| `success` | `taskId` |
| `error` | `error`. `stopped by the user` when a person stopped the turn. |
| `skipped` | `skipReason`. `removed from the queue by the user` when a person removed the waiting fire. |

`catchUp: true` marks a fire made up for after a restart, `testMode:
true` one started through the test route. `404` once the trigger is
deleted.

### `POST /sentinel/triggers/:id/pause`

Pauses a trigger until it is resumed. Returns `{ok: true}`.

### `POST /sentinel/triggers/:id/resume`

Sets a trigger back to `active`, clears its error count and works out
its next fire. Returns `{ok: true}`. `400` when the schedule cannot be
computed.

### `POST /sentinel/triggers/:id/test`

Fires a trigger now, ignoring cooldown and daily cap. The agent gets
the same prompt as on a real fire. Returns `{ok: true, hint}`.

### `DELETE /sentinel/triggers/:id`

Removes a trigger and its history. Returns `{ok: true}`, or `404` when
it is already gone.

### `GET /sentinel/status`

Whether the scheduler runs and when the next trigger is due.

```json
{ "started": true, "nextFireAt": 1779013800000 }
```

### Creating triggers

There is no route to create a trigger. Create it through the tool, so
that the same limits apply as for an agent:

```bash
curl -X POST $BASE/agents/<your-agent>/tools/sentinel \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "create",
    "name": "morning-mail-summary",
    "intent": "Daily inbox digest at 8",
    "source": { "type": "time", "spec": { "type": "daily", "time": "08:00" } },
    "dispatch": {
      "agent": "<your-agent>",
      "session": "morning-routine",
      "prompt": "Check the inbox, group by topic, tell me what is important."
    }
  }'
```

The tool's actions are `create`, `list`, `get`, `pause`, `resume`,
`delete`, `test`, `history` and `purge_completed`.

## External MCP servers

State and control of the external MCP servers from `mcp.servers` in
the config. All three routes answer `503` when none is configured.

### `GET /mcp/status`

The state of each server.

```json
{ "enabled": true,
  "servers": { "<name>": { "state": "connected", "toolCount": 12, "transport": "stdio",
                           "lastConnectedAt": 1789299000000, "consecutiveFailures": 0 } } }
```

`state` is `pending`, `connected`, `failed`, `needs-auth` or
`disabled`. `lastError` is added after a failure.

### `POST /mcp/servers/:name/reconnect`

Drops the connection to one server and connects again at once. Returns
`{ok: true, status}` with the server's new state. `400` when the name
is unknown or the server is disabled in the config.

### `POST /mcp/call`

Calls one tool of an external server directly.

| Body field | Required | Meaning |
|---|---|---|
| `server` | yes | The server's name. |
| `tool` | yes | The tool's name on that server. |
| `args` | no | The tool's arguments as an object. |
| `timeoutMs` | no | How long to wait. |

Returns `{isError, text, images: [{data, mimeType}]}`. `400` without
`server` or `tool`, `502` when the call failed.

> **Note:** This route does not apply an agent's tool rules. It is
> meant for the server's own use and for an operator.

## Web bundle

### `GET /web/`

The web client, as static files from the same address as the API.
`GET /web` redirects here.

### `GET /mobile/`

The mobile app, served the same way. `GET /mobile` redirects here. A
custom client needs neither: everything they do goes through the routes
on this page.

## See also

- [Setup](setup.md): install, HTTPS, restart and reload, all settings
- [Security](security.md): who can reach the server and what that means
- [Web client](web.md) and [Mobile app](mobile.md): the shipped clients
  built on these routes
- [Display](display.md): what the terminal client shows and its commands
- [Agents](agents.md): agent files, `agent_ask`, sub-agents, steering
- [Team](team.md): the team file
- [Models](models.md), [Thinking](thinking.md), [Sampling](sampling.md):
  the per-session overrides
- [Builder agents](builder.md) and [Language servers](lsp.md): modes,
  phases, plans, diagnostics
- [Memory](memory.md), [Wiki](wiki.md), [Dream phases](dream-phases.md):
  search, the wiki and its migration, REM, Deep and Lucid
- [Projects](projects.md): what a project is and how sessions use it
- [Files](files.md) and [Tools](tools.md): read and write rules, the
  tool list
- [Image generation](imagegen.md) and [Video generation](videogen.md):
  models, specs, jobs
- [Voice](voice.md) and [Realtime voice](realtime-voice.md): dictation,
  spoken replies, calls
- [Tmux](tmux.md), [Browser](browser.md), [Sentinel](sentinel.md),
  [MCP servers](mcp.md), [Skills](skills.md): the features behind the
  remaining routes
