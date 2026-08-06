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

### The Tools window

The web client has a **tools** tile in the app dock that opens the same
control as a point-and-click matrix: pick an agent on the left, toggle
any tool's visibility in the middle (built-ins grouped by toolset,
external tools grouped by MCP server), and watch external server health
on the right — state, tool count, transport, last error, and a
reconnect button per server.

Toggles manage exact-name deny entries and are written server-side into
the agent's `agent.yaml` (comments and the rest of the file stay
untouched). If an agent's `agent.yaml` carries hand-written pattern
rules (globs, `toolset:`, allow-lists), the matrix shows them and goes
read-only — the UI never rewrites operator policy it can't represent.

## Server options

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
curl -s localhost:18737/mcp/status | jq          # per-server state + tool counts
curl -s -X POST localhost:18737/mcp/servers/<name>/reconnect
```

Server states: `connected`, `pending` (connecting/retrying), `failed`,
`needs-auth`, `disabled`. `/mcp/call` exists as a loopback-only
dispatch endpoint for debugging a tool without an LLM in the loop.
