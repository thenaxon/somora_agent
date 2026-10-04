# External MCP servers

somora can connect to external [MCP](https://modelcontextprotocol.io)
servers and offer their tools to your agents, next to the built-in
tools. You add a server once in `config.yaml`. Every agent on every
engine can then use its tools, and you decide per agent which ones it
sees.

## What you get

- **One entry, every engine.** Agents on `claude-cli`, `codex-cli`,
  `grok-cli` and `openai-compatible` all get the server's tools.
- **One connection, in one place.** somora holds the connection and the
  credentials. The engines never talk to the external server
  themselves.
- **Names that cannot clash.** Every tool is called
  `mcp__<server>__<tool>`, so it never shadows a built-in tool or a
  tool of another server.
- **Per-agent visibility.** Hide one tool or a whole server for an
  agent, by hand or with a click in the web client.
- **Servers that fail do not hurt.** A broken tool schema is skipped, a
  dead server is retried in the background, and somora starts without
  waiting for any of them.
- **OAuth logins kept alive.** For servers that log in with OAuth,
  somora refreshes the token itself.

## Set it up

This works the same for a person and for an agent editing the files
with its own tools.

1. **Add the server** under `mcp.servers` in `~/.somora/config.yaml`
   (an agent uses `file_patch`):

   ```yaml
   mcp:
     servers:
       acme:
         url: https://mcp.acme.example/v1/
         headers:
           x-api-key: "${ACME_API_KEY}"
   ```

   The name may use lowercase letters, digits and hyphens, at most 30
   characters, no underscores.
2. **Put the secret in the environment**, not in the config. Append
   `ACME_API_KEY=...` to `~/.somora/somora.env`. The file is read when
   the server starts.
3. **Restart somora** with `somora restart`. The list of servers is
   read at start only.
4. **Check it**:

   ```bash
   curl -sk https://localhost:18737/mcp/status
   ```

   The server should be `connected` with a tool count. Its tools appear
   as `mcp__acme__*` in the **abilities** window of the web client.

> **Warning:** An agent that restarts somora cuts its own running turn.
> Finish the reply first, or ask the user to restart.

Port 18737 speaks HTTPS when `server.tls` is configured. With a
self-signed certificate `curl` needs `-k`. Without TLS use `http://`
and drop `-k`.

## What can be added

Check three things before you add a server.

| Question | Works | Does not work |
|---|---|---|
| How does it run? | A hosted HTTP endpoint (`https://...`). | A local package you start as a command (`npx ...`, `uvx ...`). |
| How does it log in? | No login, a fixed API key or token in a header, or an OAuth login whose credential a login tool writes to a JSON file. | A browser OAuth flow against the server itself, with no credential file. |
| What does it offer? | Tools. | MCP resources, prompts and elicitation are ignored. |

If a service offers both a hosted URL and a package, use the URL. Many
services with an OAuth flow also offer an API key: check their docs.

> **Warning:** Do not put `command:` or `args:` into `mcp.servers`.
> They are ignored. An entry without a `url` is skipped with
> `mcp.hub.config_invalid` in the log. A `transport` other than `http`
> or an invalid server name makes `config.yaml` invalid, and somora
> does not start.

## How the tools reach the model

somora runs one MCP client, the hub, inside the server process. It
holds one connection per configured server, reads the tool list and
runs every call, whichever engine asked.

| Engine | How it gets the tools | Name the model sees |
|---|---|---|
| `openai-compatible` | Added to somora's own tool list. | `mcp__<server>__<tool>` |
| `claude-cli` | One small proxy per server and turn. It serves the tool list and forwards calls to the hub. | `mcp__somora-<server>__<tool>` |
| `grok-cli` | The same proxy as `claude-cli`. | `somora-<server>__<tool>` |
| `codex-cli` | Codex dynamic tools, one namespace per server. | `somora_mcp_<server>` namespace, tool under its own name |

In `agent.yaml`, in the abilities window and in the session history the
tool is always `mcp__<server>__<tool>`.

What happens on import:

- Characters outside letters, digits, `_` and `-` in a tool name become
  `_`. A tool whose full name is longer than 64 characters, or collides
  with another after this step, is skipped.
- Schemas are repaired for known provider problems. A tool whose schema
  cannot be used is skipped alone, with `mcp.hub.tool_skipped` in the
  log.
- Descriptions are cut at 2048 characters. Invisible and control
  characters are removed from names, descriptions and schemas.
- Tools of a server that is not `connected` are not offered.

What comes back from a call:

- Text, JSON and images reach the model. Embedded text resources and
  resource links arrive as text. Audio and other binary content is
  dropped.
- A result longer than `maxResultChars` is cut with a marker, like a
  built-in tool result.
- External tools take whatever arguments the model sends. Checking them
  is the external server's job. somora's own tools are stricter: they
  refuse a call with a parameter the tool does not know.

## Per-agent tool control

Which tools an agent sees is decided in its `agent.yaml`, the same way
for built-in and external tools:

```yaml
# ~/.somora/agents/<your-agent>/agent.yaml
tools:
  deny:
    - mcp__acme__web_search   # hide one external tool
    - mcp__acme__*            # hide a whole server
    - toolset:exec            # hide a whole tool family
  allow: []                   # empty: everything that is not denied
```

A pattern is an exact tool name, `toolset:<tag>` for a family, or a
name ending in `*`. `deny` beats `allow`. An agent without a `tools:`
block sees everything. A change applies from the agent's next turn.

A hidden tool is absent from the model's tool list on all four engines,
so it also costs no context. This is the way to handle overlapping
tools: give a research agent the search tool of an MCP server and hide
the built-in `web_search` for it, while every other agent keeps the
built-in one.

A builder agent starts from a short list of coding tools. It gets an
external tool only when its `tools.allow` names it.

### The Abilities window

The **abilities** tile in the dock of the web client opens the same
control as a matrix.

| Part | What it shows |
|---|---|
| Left | The agents. Pick one. |
| Middle | Every tool this agent could use, with an eye to show or hide it. Built-in tools are grouped by toolset, external tools by MCP server. Below them: the same for skills. |
| Right | Each MCP server with state, tool count, transport, last error and a reconnect button. |

Good to know:

- Groups are collapsed at first. The header shows how many abilities a
  group holds and how many are hidden. Which groups you opened is
  remembered per browser (`localStorage`, `somora-abilities-expanded`).
- The eye in a group header switches the whole group in one write. If
  some are hidden, one click hides the rest and the next click brings
  all back. The eye is dimmed while a group is half hidden.
- A tool whose configuration is missing is not listed. No engine offers
  it either.
- For a builder the window shows **builder tools** first and everything
  else under **more**, off until switched on. Switching one on writes
  it into `tools.allow`. Switching a builder tool off writes it into
  `tools.deny`.
- A chat agent does not see the `builder` toolset.

A switch writes an exact tool name into `deny` in the agent's
`agent.yaml`. Comments and the rest of the file stay as they are. If
the file holds an `allow` list, a `toolset:` rule or a `*` pattern, the
window shows the rules and is read-only: you wrote that policy by hand.

## Servers with an OAuth login

Some servers take no API key. They use an OAuth login that hands out a
short-lived token. somora supports them when an interactive login tool
writes the credential to a JSON file. The hub reads the token from that
file and every engine gets the tools without a login of its own.

```yaml
mcp:
  servers:
    my-oauth-server:
      url: https://example.com/mcp
      auth:
        type: oauth-refresh
        credentialKey: myServiceOauth      # top-level key in the credential file
        tokenEndpoint: https://example.com/oauth/token
      headers:                             # optional extra headers
        X-Client: my-client
```

How the token is kept alive:

- **Who refreshes.** With `refresh: true` the hub refreshes the token
  itself. With `refresh: false` another program owns the token and the
  hub only reads the file again on every connect. A list of key names
  means: the hub refreshes exactly these keys.
- **When.** A token within 5 minutes of its expiry is refreshed at the
  token endpoint. A connected server is reconnected at that point, so
  the live connection carries the new token.
- **Writing back.** The new access token and the new refresh token are
  written back to the file. All other keys in the file stay untouched.
- **No collisions.** The refresh runs under a lock file and reads the
  credential again first. If another program refreshed in the meantime,
  the hub uses that token.

When the token endpoint rejects the refresh with HTTP 400 or 401, the
refresh token is dead. The hub renames the entry to
`<key>_stale_<timestamp>` in the credential file and the server shows
`needs-auth`, with the new key name in `lastError`. Run the login
again, then reconnect the server.

> **Note:** The credential itself is never in `config.yaml`. Only the
> interactive login creates it.

### Claude Design

[Claude Design](https://claude.ai/design) has an MCP server that logs
in with a claude.ai account. There is no API key. It needs its own
credential, written by `/design-login` in Claude Code, because the
ordinary Claude login does not carry the `user:design:*` scope.

> **Warning:** This uses the same first-party login Claude Code uses.
> Anthropic does not document third-party access and can change it at
> any time. Treat it as experimental.

1. Be logged into Claude Code on the machine (`claude`, then `/login`).
2. Run `CLAUDE_CONFIG_DIR=~/.somora/claude-home claude` and in it
   `/design-login`, once. It writes a `designOauth` entry beside the
   ordinary `claudeAiOauth` into
   `~/.somora/claude-home/.credentials.json`.
3. Add the server with the preset:

   ```yaml
   mcp:
     servers:
       claude-design:
         preset: claude-design
   ```

4. Restart somora and check `/mcp/status`: `claude-design` should be
   `connected` with its tool count.

What the preset fills in (a field you set yourself wins):

| Field | Value |
|---|---|
| `url` | `https://api.anthropic.com/v1/design/mcp` |
| `auth.credentialKey` | `designOauth`, then `claudeAiOauth`: the first one present in the file is used |
| `auth.tokenEndpoint` | `https://platform.claude.com/v1/oauth/token` |
| `auth.refresh` | `['designOauth']` |
| `headers` | `X-Anthropic-Client: claude-cli-design-tool` |

So somora refreshes `designOauth` itself. Its access token lives only a
few hours and nothing else keeps it alive. somora never refreshes
`claudeAiOauth`: that token belongs to the Claude CLI, and two programs
refreshing one token invalidate each other.

If the server shows `needs-auth`, run `/design-login` again and then
reconnect:

```bash
curl -sk -X POST https://localhost:18737/mcp/servers/claude-design/reconnect
```

Without a reconnect the hub tries again by itself within 5 minutes.
Claude Code refuses `/design-login` while a `designOauth` entry exists.
That is why the hub moves a dead entry aside: you can log in again
without editing the file.

## Connections and recovery

A server is in one of five states:

| State | Meaning |
|---|---|
| `connected` | Tools are available. |
| `pending` | Connecting, or waiting for the next try after a drop. |
| `failed` | The last connect failed. `lastError` says why. |
| `needs-auth` | The server refused the credential (401, 403 or a missing scope). |
| `disabled` | `enabled: false` in the config. |

How the hub behaves:

- **Start.** somora connects to all servers in the background. Startup
  never waits for one.
- **Transport.** Streamable HTTP first, then the older SSE transport.
- **One call at a time.** Many MCP servers mishandle parallel requests,
  so calls to one server run one after another. Set
  `supportsParallelToolCalls: true` for a server that is known to be
  safe.
- **Idle connections** are pinged after 3 minutes without activity.
- **A dropped connection** goes back to `pending` and is retried within
  about a minute.
- **A failed connect** is retried with a growing pause: 1 second,
  doubling up to 1 minute. From the third failure in a row the pause is
  at least 1 minute.
- **An error that will not go away** (refused credential, missing
  environment variable, missing credential file, unknown host) is
  tried again only every 5 minutes.
- **A call that fails** because the server is gone is not repeated. The
  connection is rebuilt for the next call.
- **Changed tools** arrive without a restart. A server that announces
  changes pushes them. For all others the hub reads the tool list again
  every 5 minutes.

A manual reconnect clears all waiting times and connects at once.

## Settings

```yaml
# ~/.somora/config.yaml
mcp:
  servers:
    <name>:                  # lowercase letters, digits, hyphens; max 30
      url: https://...
      headers: {}
      enabled: true
      tools:
        include: []
        exclude: []
      timeoutMs: 60000
      connectTimeoutMs: 15000
      maxResultChars: 100000
      supportsParallelToolCalls: false
      # preset: claude-design
      # auth:
      #   type: oauth-refresh
      #   credentialKey: myServiceOauth
      #   tokenEndpoint: https://example.com/oauth/token
      #   credentialFile: ~/.somora/claude-home/.credentials.json
      #   refresh: true
```

| Setting | Default | Meaning |
|---|---|---|
| `url` | none | The server's HTTP endpoint. Required unless a `preset` supplies it. |
| `transport` | `http` | Only `http` is accepted. |
| `headers` | `{}` | Fixed request headers. Values expand `${VAR}` and `${VAR:-default}` from the server environment at connect time. A missing variable fails the connect, not the start. |
| `enabled` | `true` | `false` keeps the entry but never connects. |
| `tools.include` | `[]` | Import only these tools, by the server's own tool names. Empty means all. |
| `tools.exclude` | `[]` | Never import these. Wins over `include`. |
| `timeoutMs` | `60000` | Time limit for one tool call. |
| `connectTimeoutMs` | `15000` | Time limit for connecting. |
| `maxResultChars` | `100000` | Longest result passed to the model. |
| `supportsParallelToolCalls` | `false` | Allow parallel calls to this server. |
| `preset` | none | `claude-design` fills `url`, `auth` and a header. |
| `auth.type` | none | `oauth-refresh`. Leave `auth` out for servers with a header key or no login. |
| `auth.credentialKey` | none | Top-level key in the credential file, or an ordered list. The first key present in the file is used. |
| `auth.tokenEndpoint` | none | OAuth token endpoint used for the refresh. |
| `auth.credentialFile` | `~/.somora/claude-home/.credentials.json` | The JSON file the login writes. `~` is expanded. |
| `auth.refresh` | `true` | `true`, `false`, or a list of the keys the hub may refresh. |

With `auth` set, the hub sends `Authorization: Bearer <token>`. An
`Authorization` entry under `headers` is ignored for that server.

The settings are read at start. A config reload does not pick up
changes under `mcp`.

## Routes

All three answer `503` when no server is configured.

| Route | What it does |
|---|---|
| `GET /mcp/status` | `{enabled, servers}`. Per server: `state`, `toolCount`, `transport`, `lastError`, `lastConnectedAt`, `consecutiveFailures`. |
| `POST /mcp/servers/<name>/reconnect` | Drops the connection and connects again at once. Answers `{ok, status}`, or `400` for an unknown or disabled server. |
| `POST /mcp/call` | Runs one tool without a model. Body: `{server, tool, args, timeoutMs}`, with `tool` as the server's own tool name. Answers `{isError, text, images}`, or `502` when the call fails. The proxies use this route. It is also handy for debugging. |

```bash
curl -sk https://localhost:18737/mcp/status | jq
curl -sk -X POST https://localhost:18737/mcp/servers/<name>/reconnect
```

The abilities window reads and writes an agent's tool visibility with
`GET` and `PUT /agents/<name>/tools`.

## Files

| Path | Content |
|---|---|
| `~/.somora/config.yaml` | The `mcp.servers` entries. |
| `~/.somora/somora.env` | Secrets referenced as `${VAR}` in `headers`. |
| `~/.somora/mcp/catalog.json` | The current tool list per server, written by the hub and read by the proxies. |
| `~/.somora/audit/mcp-calls.jsonl` | Calls that failed, returned an error or hit a server that was not connected. Holds the first 200 characters of the arguments. Rotates at 5 MB. |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `/mcp/status` answers `503` | No server under `mcp.servers`, or somora was not restarted after adding one. |
| The server is missing from the status | The entry has no `url`. Look for `mcp.hub.config_invalid` in the log. |
| `failed` with `missing env var` | The variable is not in `~/.somora/somora.env`, or is empty. Add it and restart. |
| `failed` with a timeout or a network error | Wrong URL or the server is down. The hub keeps retrying. |
| `needs-auth` on a server with a header key | Wrong or expired API key. |
| `needs-auth` on an OAuth server | The login expired or lacks a scope. Run the login again, then reconnect. |
| `failed` with `credential file not found` or `credential key ... missing` | The interactive login has not been run yet. |
| `connected`, but fewer tools than expected | Check `tools.include` and `tools.exclude`, then the log for `mcp.hub.tool_skipped`. |
| An agent does not see the tools | Its `agent.yaml` hides them, or it is a builder without the tool in `tools.allow`. |
| A tool changed on the server but not for the agent | Wait up to 5 minutes or reconnect. The log shows `mcp.hub.relist_changed` and `mcp.bridge_tool_updated`. |

## See also

- [Tools](tools.md): the built-in tools and the full rules for choosing
  tools per agent
- [Skills](skills.md): the skills half of the abilities window
- [Builder agents](builder.md): the short tool list a builder starts
  from
- [Security](security.md): what each engine is allowed to load
- [API](api.md): every route with request and response
- [Web client](web.md): the dock and its windows
