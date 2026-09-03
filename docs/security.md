# Security model

Somora runs on your machine and uses provider authentication you've
already set up (Claude Code subscription, Codex CLI subscription, or an
API key for a local LLM). The interesting security question is: what
prevents an agent running through one of those providers from doing
something it shouldn't — reading files outside its memory scope,
pulling other context from the host's setup, calling unauthorised
tools?

This doc summarises the defenses each engine adapter installs.

## Trust boundary

```
   you ──► CLI/HTTP ──► somora-server ──┬─► claude-cli engine ──► Claude Code binary ──► Anthropic API
                                        ├─► codex-cli engine   ──► Codex CLI binary    ──► OpenAI API
                                        └─► openai-compatible  ──► fetch /v1/chat/...   ──► local LLM or cloud
```

The somora server is the boundary. Inside the somora server we trust
ourselves; outside (the spawned CLI binaries, the LLM endpoints) we
don't. Each engine adapter takes care to keep host-context out of the
prompt and built-in tools out of the model's reach.

## claude-cli adapter

The Anthropic Agent SDK and the underlying Claude Code binary auto-load
a fair amount of host context by default — the Claude.ai account's
connectors (Gmail, Drive, Calendar) as MCP servers, project-scoped
auto-memory under `~/.claude/projects/<cwd>/memory/*`, settings files,
CLAUDE.md walk-up, and so on. None of that should leak into a somora
agent's prompt.

Five-layer defense in [`src/engine/claude-cli.ts`](../src/engine/claude-cli.ts):

1. `settingSources: []` — disables `settings.json` / `CLAUDE.md`
   loading from user / project / local scope.
2. `tools: []` — empty allowlist of built-in tools.
3. `disallowedTools: KNOWN_ACCOUNT_TOOLS` — explicit deny-list of the
   six known Claude.ai connector auth tools (`mcp__claude_ai_Gmail__authenticate`
   et al). They sometimes appear in the SDK's tool list anyway — the
   adapter logs `engine.tools_leaked` if a new one shows up.
4. `canUseTool` gate — a per-call permission callback that allows
   only `mcp__somora__*` tool names (plus `mcp__somora-<name>__*` for
   configured external-server proxies); everything else is denied.
   The server was called `somora-memory` before v2026.09.03.05; a CLI
   session recorded under the old name is restarted once on its next
   turn, with the session history replayed, and shows a
   `session restarted` engine row.
5. `managedSettings: { autoMemoryEnabled: false }` — disables the
   project-memory auto-loader. Without this, `~/.claude/projects/<cwd>/memory/*`
   files leak into the system prompt.
6. `strictMcpConfig: true` — only the MCP servers somora passes exist
   for the session. The claude.ai account connectors (Gmail, Calendar,
   Drive) no longer appear at all; before, they were listed as
   "needs-auth" and mentioned to the model, with only their tools
   denied (SDK 0.3.259 re-audit, 2026-09-03).

What the SDK's init message lists as `skills`, `slash_commands` and
`agents` is SDK-side inventory: with a plain-string `systemPrompt` and
`settingSources: []` none of it reaches the model (verified by asking
the model to list everything it was told about — only the somora tools
and ToolSearch came back).

Diagnostic logs you'll see:

```
engine.init                  with full tool list + mcp_servers (sanity check)
engine.tools_leaked          if any tool slipped past the deny-list
engine.mcp_servers_leaked    if any account-MCP shows up beyond ours
```

## codex-cli adapter

Codex CLI ships with a long list of default-on built-in features —
shell command execution, file editing (`apply_patch`), browser
automation, computer use, image generation, JS REPL, web search, plus
context loaders (config.toml, AGENTS.md walk-up, personality, memories).
None belong inside a somora agent.

Defense in [`src/engine/codex-cli.ts`](../src/engine/codex-cli.ts):

- **Feature disables** via `--disable <feature>` — the list is
  `CODEX_DISABLED_FEATURES` at the top of the adapter and is re-audited
  against `codex features list` after every codex bump: shell and exec
  tools, browser and computer use, image generation, apps, multi-agent,
  personality, hooks/plugins, goals, `view_image` and `skill_search`
  (both feature flags since codex 0.151), and more.
- **Config switches** for the `functions.*` tools the Responses API
  injects: `web_search="disabled"`, `tools.update_plan.enabled=false`,
  `tools.experimental_request_user_input.enabled=false`. Verified with
  `--strict-config` (unknown keys are a hard error there) and by asking
  the model to list every tool it can call.
- **Known residual**: `functions.apply_patch` cannot be switched off —
  the model catalog marks gpt-5.x with `apply_patch_tool_type:
  "freeform"` and codex has no config key for it. `list_mcp_resources`
  and its two siblings only read MCP resources, which somora's server
  does not expose.
- **Sandbox**: somora is the sandbox. The adapter runs codex with
  `--dangerously-bypass-approvals-and-sandbox` so that somora's own
  tools (which enforce the path blacklist and per-resource policy) are
  not blocked by codex's approval flow; codex's built-in file/shell
  tools are disabled above instead.
- **`--ignore-user-config`**: skip `~/.codex/config.toml` (other MCP
  configs, model overrides, project trust list).
- **`--ignore-rules`**: skip user / project execpolicy `.rules`.
- **`-c project_root_markers=[]`**: disable AGENTS.md walk-up. By
  default codex walks from cwd up to the nearest `.git` and concatenates
  every AGENTS.md it finds; we cap that to cwd-only.
- **MCP auto-approve**: `mcp_servers.somora.default_tools_approval_mode = "approve"`
  so the somora tool calls don't require user approval at every
  step (codex exec is non-interactive, default would auto-cancel them).

The list is in `CODEX_DISABLED_FEATURES` at the top of the adapter.
When upgrading the codex binary, re-audit `codex features list` for
new stable-true features that look like context loaders.

`tool_search` and `tool_suggest` stay enabled on purpose — codex routes
MCP tool calls through these meta-tools as the discovery/dispatch layer.
Disabling them silently broke MCP tool calls before we figured out the
distinction.

## openai-compatible adapter

This one's the simplest from a leak standpoint: somora opens a fresh
HTTPS connection to the configured `baseUrl`, sends only the
turn-specific `messages` and `tools`, and gets a response. There's no
host-context auto-loading because there's no CLI subprocess to inherit
from. The only attack surface is the LLM endpoint itself, which is your
choice (local Ollama, vendor API, etc.).

The agent-loop in [`src/engine/openai-compatible.ts`](../src/engine/openai-compatible.ts)
caps tool-call rounds (`agentLoop.maxRounds`, default 8) and per-tool
timeout (`agentLoop.toolCallTimeoutMs`, default 30 s) to prevent runaway
loops.

## Memory tool scope

All `memory_*` write tools are hard-scoped to
`~/.somora/agents/<name>/memory/`:

- Slug regex: `^[a-z0-9][a-z0-9_-]*$`. No path separators, no
  uppercase, no hidden directories.
- Vault writes are NOT exposed to agents. The wiki layer is written
  exclusively by the Deep phase (memory→wiki consolidation) and the
  Lucid phase (cleanup) — both server-side workers, scoped to the
  configured wiki subfolder. Everything else in the vault stays
  read-only from somora's perspective.

Even a buggy or adversarial model output cannot escape an agent's own
memory directory through `memory_write`/`memory_edit`/`memory_delete`.

## What somora does NOT defend against

- **Compromised provider.** If your Anthropic/OpenAI/local-LLM endpoint
  is hostile, somora can't help — it's just passing your prompt to it
  and getting a response.
- **Local filesystem access by tools.** `memory_*` tools read your own
  memory files; that's the design. If you write secrets into a memory
  note and then ask an agent about them, the model sees the secret.
- **Network egress.** somora doesn't sandbox the spawned binaries
  beyond what their own sandbox flags do (`--sandbox read-only` for
  codex, none for claude-cli). If the binary phones home outside your
  knowledge, somora won't catch it.
- **Multi-tenant deployment.** somora binds to `127.0.0.1` and assumes
  you're its only user. Putting it behind a network reverse proxy
  without proper auth would expose your agents to anyone who can reach
  the proxy.

## Reporting issues

For now: open a GitHub issue with the `security` label. Don't include
secrets in the report.
