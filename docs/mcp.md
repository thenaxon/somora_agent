# External MCP servers

somora can connect to external [MCP](https://modelcontextprotocol.io)
servers and offer their tools to every agent, on every engine, right
next to the built-in tools. One config entry, and `claude-cli`,
`codex-cli` and `openai-compatible` agents all see the server's tools —
namespaced, schema-sanitized, and individually gateable per agent.

```yaml
# ~/.somora/config.yaml
mcp:
  servers:
    parallel:
      url: https://mcp.parallel.ai/v1beta/search_mcp/
      headers:
        x-api-key: "${PARALLEL_API_KEY}"
```

That's the whole setup for a hosted server. Header values expand
`${VAR}` / `${VAR:-default}` from the server environment, so secrets
stay out of the config file.

## Adding a server, step by step

Works the same whether a human or a somora agent (via its own tools)
does it:

1. **Add the entry** to `mcp.servers` in `~/.somora/config.yaml`
   (agents: `file_patch`). Server name: lowercase letters, digits,
   hyphens — max 30 chars, no underscores.
2. **Put the secret in the environment**, not the config: append
   `MY_KEY=...` to `~/.somora/somora.env` and reference it as
   `${MY_KEY}` in the `headers:` block. The env file is read at server
   start.
3. **Restart somora** — the hub reads `mcp.servers` at boot, config
   edits alone don't connect anything: `systemctl --user restart
   somora`. Agents: be aware this cuts your own running turn; finish
   your reply first or ask the user to restart.
4. **Verify**: `curl -sk https://localhost:18737/mcp/status` should show the
   server `connected` with a tool count, and the new
   `mcp__<server>__*` tools appear in the tool list (web UI: tools
   tile). A `failed`/`needs-auth` state with `lastError` usually means
   a wrong URL or missing/wrong API key.

## How it works

somora runs a single MCP **client hub** in the server process. It holds
one long-lived connection per configured server, discovers the tools
(`tools/list`, pagination included), and executes every call — no
matter which engine asked:

- **openai-compatible** agents get the tools bridged straight into
  somora's tool registry.
- **claude-cli / codex-cli** get a lightweight per-turn proxy that
  serves the discovered tool list and forwards calls to the hub. The
  CLIs never talk to the external server themselves — connections,
  credentials, retries and audit stay in one place.

Tool names are namespaced `mcp__<server>__<tool>` (the CLI engines see
`mcp__somora-<server>__<tool>`), so external tools can never shadow
built-ins or each other.

## Robustness

External servers are treated as untrusted, flaky input:

- **Schema sanitizing** — discovered JSON Schemas are normalized for
  known provider incompatibilities (draft-07 `definitions`, nullable
  unions, dangling `required`, …). A tool with an unusable schema is
  skipped individually and logged; it can never break the request for
  the rest of the tool list.
- **Connection lifecycle** — lazy connect (server boot never blocks on
  an external host), automatic transport fallback (streamable HTTP →
  SSE), jittered backoff with a circuit breaker on transient failures,
  slow re-probing of permanently failed servers, and an app-level
  keepalive ping on idle connections. A dead upstream is detected on
  the failing call and recovers on the next one.
- **Serial by default** — many MCP servers mishandle concurrent
  requests, so somora serializes calls per server. Opt in to
  parallelism per server with `supportsParallelToolCalls: true`.
- **Result caps** — oversized results are truncated with a marker, the
  same way built-in tool results are; notable failures land in an
  audit log under `~/.somora/audit/`.

## Per-agent tool control

Which tools an agent actually sees is decided per agent, uniformly for
built-in and MCP tools, in the agent's `agent.yaml`:

```yaml
# ~/.somora/agents/<name>/agent.yaml
tools:
  deny:
    - mcp__parallel__web_search   # hide one MCP tool
    - toolset:exec                # hide a whole tool family
  allow: []                       # empty = everything not denied
```

Patterns: exact tool name, `toolset:<tag>` for a family, or a trailing
`*` glob (`mcp__parallel__*` hides a whole server). `deny` beats
`allow`; agents without a `tools:` section see everything. This is the
knob for overlapping tools — e.g. give your research agent an
MCP-provided search tool while everyone else keeps the built-in
`web_search`, and no agent ever sees both.

Denying a tool is real context saved, not just tidiness: the full
built-in surface is roughly 13k tokens of schema in **every** turn, and
a denied tool is absent from the model's list on all four engines — the
same matcher runs in-process for `openai-compatible` and inside the MCP
child that serves `claude-cli`, `codex-cli` and `grok-cli`.

Tools whose configuration doesn't exist are never offered at all, on any
engine. A tool that cannot run is worse than one that isn't there: the
model spends a call finding out.

### The Tools window

The web client has a **tools** tile in the app dock that opens the same
control as a point-and-click matrix: pick an agent on the left, toggle
any tool's visibility in the middle (built-ins grouped by toolset,
only tools this agent could actually use — a tool whose config is
missing has nothing to configure, and a switch that changes nothing is
worse than no switch), external tools grouped by MCP server, and watch
external server health
on the right — state, tool count, transport, last error, and a
reconnect button per server.

Toggles manage exact-name deny entries and are written server-side into
the agent's `agent.yaml` (comments and the rest of the file stay
untouched). If an agent's `agent.yaml` carries hand-written pattern
rules (globs, `toolset:`, allow-lists), the matrix shows them and goes
read-only — the UI never rewrites operator policy it can't represent.

## Servers that need an interactive OAuth login

Some MCP servers don't take an API key — they authenticate with an
OAuth login that grants a short-lived token which must be refreshed.
somora supports these when the login is performed by a tool that writes
the credential to a JSON file (today: Claude Code's `/design-login`).
The hub reads the token from that file, refreshes it against the token
endpoint as it nears expiry, and rotates it back — so every engine gets
the tools with no per-engine login.

```yaml
mcp:
  servers:
    my-oauth-server:
      url: https://example.com/mcp
      auth:
        type: oauth-refresh
        credentialKey: myServiceOauth          # top-level key in the credentials file
        tokenEndpoint: https://example.com/oauth/token
        # credentialFile defaults to ~/.somora/claude-home/.credentials.json
      headers:                                 # optional extra static headers
        X-Client: my-client
```

The credential file is **never** in config — it is provisioned by the
interactive login. If the refresh token expires or is revoked, the
server shows `needs-auth` and you re-run the login.

### Claude Design

[Claude Design](https://claude.ai/design) exposes an official MCP server
(`https://api.anthropic.com/v1/design/mcp`) that authenticates against a
claude.ai account — there is no API key. It needs the **separate
`/design-login` credential**: Anthropic put Claude Design behind its own
`user:design:read` / `user:design:write` scope, which the ordinary
Claude login does not carry.

> **Unsupported / may break.** This uses the same first-party login
> Claude Code uses; Anthropic does not document third-party access and
> could change it at any time — it has already changed twice. Treat it
> as experimental.

**Setup:**

1. Be logged into Claude Code on the machine (`claude` → `/login`).
2. Run **`/design-login`** once in a Claude Code session. It writes a
   `designOauth` entry beside the ordinary one in
   `~/.somora/claude-home/.credentials.json`.
3. Add the server with a single preset line:
   ```yaml
   mcp:
     servers:
       claude-design:
         preset: claude-design   # fills url, auth, and the X-Anthropic-Client header
   ```
4. Restart somora and check `curl -sk https://localhost:18737/mcp/status`
   — `claude-design` should be `connected` with its tool count.

**Which credential, and why the preset names two.** The preset asks for
`designOauth` first and falls back to the ordinary `claudeAiOauth`,
taking whichever key is actually in the file. That is not indecision —
this has moved twice in four days:

| | |
|---|---|
| until 2026-08-25 | the separate `/design-login` credential; then that flow broke on recent CLI versions |
| 2026-08-25 | the ordinary login worked, verified against the live endpoint |
| 2026-08-28 | Anthropic split out `user:design:*`; the ordinary token is refused and `/design-login` is required again |

A list survives the next move in either direction without anyone editing
config. The same applies to any server: `credentialKey` accepts an
ordered list.

**If it says `needs-auth`,** run `/design-login` again. A token that
authenticates for everything else but lacks the design scope is refused
by this endpoint alone — the endpoint says so in its response body, and
somora surfaces that rather than parking on a generic failure.

The hub never refreshes these tokens itself — the Claude CLI owns those
rotating chains, and two refreshers on one chain invalidate each other.
That is not hypothetical: it is how a Design credential got revoked on
2026-08-25.

## What works today — and what doesn't (yet)

Before adding a server, classify it. Three questions decide everything:

1. **How does it run?** A hosted **HTTP endpoint** (`https://…`) works.
   A local **stdio package** (`npx @something/mcp-server`, `uvx …` —
   anything you'd start as a command) is **not supported yet**.
   **Never put `command:`/`args:` into `mcp.servers`** — the config
   schema rejects it and somora will refuse to START until the entry
   is removed. If the service offers both a hosted URL and an npm
   package, use the URL.
2. **How does it authenticate?** No auth or a **static API key/token
   header** works (`headers:` + `${VAR}` from `~/.somora/somora.env`).
   An **OAuth login** whose credential is written to a JSON file by an
   interactive login tool works via `auth: {type: oauth-refresh}` (see
   "Servers that need an interactive OAuth login" above; Claude Design
   is the worked example). A **browser OAuth flow with no file-based
   credential** (dynamic client registration against the server itself)
   is **not supported yet**. Check the service's docs for an API-key
   option; many offer both.
3. **What does it offer?** Only **tools** are imported. Servers whose
   value is MCP *resources*, *prompts*, or interactive *elicitation*
   only work for their tools; the rest is ignored. Tool results:
   text, JSON and images come through; audio/binary blobs are
   dropped.

If the answers are "HTTP + API key + tools", add it (see the
step-by-step above) and check `/mcp/status`. Anything else: not yet —
don't try to force it through the config.

```yaml
mcp:
  servers:
    <name>:                # [a-z0-9-], max 30 chars
      url: https://...     # required — remote HTTP endpoint
      headers: {}          # static headers, ${VAR} expansion
      enabled: true
      tools:
        include: []        # import only these upstream tools (empty = all)
        exclude: []
      timeoutMs: 60000     # per tool call
      connectTimeoutMs: 15000
      maxResultChars: 100000
      supportsParallelToolCalls: false
```

## Status & operations

```bash
curl -sk https://localhost:18737/mcp/status | jq          # per-server state + tool counts
curl -sk -X POST https://localhost:18737/mcp/servers/<name>/reconnect
```

Port 18737 speaks **HTTPS** when `server.tls` is configured (the
recommended setup) — plain `http://` gets an empty reply, and a
self-signed cert needs `-k`. Drop both if you run without TLS.

Server states: `connected`, `pending` (connecting/retrying), `failed`,
`needs-auth`, `disabled`. A connection that drops mid-life (keepalive
ping fails, upstream closes the stream, an OAuth token expires) goes
back to `pending` and is retried by the 60 s keepalive sweep — first
after a few seconds, then with exponential backoff up to a minute, and
every 5 min once the error looks permanent (`needs-auth`, missing env
var). Manual `reconnect` resets the backoff and retries immediately. `/mcp/call` exists as a loopback-only
dispatch endpoint for debugging a tool without an LLM in the loop.
