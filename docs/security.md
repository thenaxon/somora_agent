# Security model

somora runs on your machine, under your user account, with the model
logins you already have. This page says who can reach it, what an agent
can do on the host, what each engine is kept away from, and where
credentials live. In short: the network is the access boundary, and
agents are trusted helpers with guard rails, not sandboxed programs.

## What you get

- **Private by default.** The server listens on `127.0.0.1` only.
  Opening it to your network is one explicit setting.
- **Only somora's tools.** The Claude and Codex engines run with their
  own built-in tools and your personal CLI setup switched off.
- **Separate engine homes.** Your interactive Claude Code and Codex
  state never reaches an agent. Only the login is shared.
- **Guard rails against accidents.** Destructive shell commands and
  reads of private keys are refused.
- **One documented request home.** A daily version check with no
  identifier, and three ways to turn it off.

## Check your setup

Three things tell you where you stand.

```bash
# Where does the server listen? No output means the default, 127.0.0.1
grep -A3 '^ *server:' ~/.somora/config.yaml

# What the daily update check sends, and whether it is on
somora telemetry show

# Which tools an agent may use: look for a tools: block
cat ~/.somora/agents/<name>/agent.yaml
```

## Trust boundary

```
   you ──► CLI/HTTP ──► somora-server ──┬─► claude-cli engine ──► Claude Code binary ──► Anthropic API
                                        ├─► codex-cli engine   ──► bundled Codex       ──► OpenAI API
                                        ├─► grok-cli engine    ──► Grok Build CLI (ACP) ──► xAI API
                                        └─► openai-compatible  ──► fetch /v1/chat/...   ──► local LLM or cloud
```

The somora server is the boundary. Everything an agent does on the host
goes through somora's tools, which run on the server under the same
rules on every engine. The spawned CLI binaries and the model endpoints
are outside. Each engine adapter keeps host context out of the prompt
and, where the CLI allows it, built-in tools out of the model's reach.

## Who can reach the server

The API has no login, no token and no user accounts. Whoever can connect
to the port can use every route. That includes chatting with agents,
reading the server log and opening a shell (`WS /terminal/attach`).

| Setup | Who can connect |
|---|---|
| Default, `server.host: 127.0.0.1` | Programs on the same machine. |
| `server.host: 0.0.0.0` | Every device that can reach the machine on port 18737. |

The environment variable `SOMORA_HOST` overrides `server.host`.

> **Warning:** Set `0.0.0.0` only on a network you trust end to end,
> such as a Tailscale network. Never expose the port to the internet,
> and do not put it behind a reverse proxy without authentication.

### HTTPS

With `server.tls` set, the server speaks HTTPS (HTTP/2, with HTTP/1.1 as
a fallback). Without it, it speaks plain HTTP. TLS encrypts the
connection. It does not add a login.

### The server log

`GET /logs` serves the tail of somora's own log so the web client can
show it. The log holds event names, tool names, file paths, shell
commands, agent and session names. The route takes a day, never a path,
so it cannot read other files. Treat the log as readable by everyone
who can reach the port.

## What an agent can do on the host

Agents are not sandboxed. The `exec` tool runs shell commands as the
user somora runs as, and the file tools read and write wherever that
user can. A new agent sees every tool until you restrict it.

The rules below stop accidents and keep secrets out of the model by
mistake. They are not a boundary against a model that works against
you: a command the patterns do not recognise runs.

### Shell commands

`exec` refuses a command that matches one of these patterns, on the
local machine and on SSH resources alike:

| Blocked | Examples |
|---|---|
| Destroying disks | `rm -rf` on `/` or a system folder, `dd if=`, `mkfs`, `shred` |
| Becoming another user | `sudo`, `doas`, `su` |
| Stopping the machine | `shutdown`, `reboot`, `poweroff`, `halt` |
| Fork bomb | the classic `:(){ :|:& };:` |
| Opening system folders | `chmod 777`, `666` or `a+w` on `/etc`, `/usr`, `/bin` and similar |
| Reading a private SSH key | `cat ~/.ssh/id_ed25519` |
| Running a download | `curl ... | sh`, `wget -O- ... | sh` |

An SSH resource can allow chosen blocked commands with
`resources.<name>.allowBlocked`. Each such run is written to
`~/.somora/audit/exec-privileged.jsonl`. The local machine has no such
override.

The shell inherits the server's environment, including what
`~/.somora/somora.env` loaded. somora's internal variables, such as
`CLAUDE_CONFIG_DIR` and `NODE_ENV`, are removed unless the agent passes
`inherit_agent_env: true`.

### Files

| Rule | Paths |
|---|---|
| Never read or written | `~/.ssh`, `~/.gnupg`, `~/.aws/credentials`, `~/.kube/config`, `/etc/shadow`, `/etc/sudoers`, `/etc/ssh`, `/boot`, `/sys`, `/proc` |
| Readable, never written | `/etc`, `/usr`, `/dev` |
| Never written | `~/.somora/known_hosts.json`, every agent's `sessions/` folder |

Symbolic links are resolved before the check. On an SSH resource the
first row applies, relative to the remote user's home.

Everything else is open on purpose. An agent can edit `config.yaml`, its
own persona files and those of other agents. Before a persona file is
overwritten, somora copies it to `<file>.bak-<timestamp>` and keeps the
last five.

A builder agent pinned to a project folder writes only in that folder
and in its own temp folder. Outside of it the write is refused, or asked
about in the task panel when you are attending. This covers the file
tools only. The builder's shell can still write anywhere.

### Web and browser

`web_fetch` refuses private and reserved addresses: loopback, private
ranges, link-local and cloud metadata addresses. It checks again after a
redirect. The browser tools are off by default (`browser.enabled`).
When on, they block private networks unless a host or range is listed
in `browser.allowPrivate`.

### Memory tools

`memory_write`, `memory_edit` and `memory_delete` only touch
`~/.somora/agents/<name>/memory/`. A note name must match
`^[a-z0-9][a-z0-9_-]*$`: no path separators, no uppercase, no leading
dot. Even a faulty model output cannot leave the agent's memory folder
through these three tools.

The memory tools cannot write to the wiki or the vault. The wiki is
written by the Deep and Lucid phases, which run on the server. An agent
with file tools can still write there like anywhere else.

### Limiting an agent

To take tools away, add a `tools` block to the agent's `agent.yaml`:

```yaml
tools:
  deny: ['toolset:exec', 'file_write', 'file_patch']
```

A denied tool is removed from the model's tool list on every engine.

## What each engine is kept from

### Claude

Claude Code loads a lot of host context by default: your claude.ai
connectors (Gmail, Drive, Calendar), its own project memory under
`~/.claude/projects/<cwd>/memory/`, settings files and `CLAUDE.md`
files. None of it should reach a somora agent. Seven things keep it out:

| Layer | Effect |
|---|---|
| Own config folder | Claude Code runs with `CLAUDE_CONFIG_DIR=~/.somora/claude-home`, not `~/.claude`. |
| `settingSources: []` | No `settings.json` and no `CLAUDE.md` from user, project or local scope. |
| `tools: ['ToolSearch']` | No built-in tools such as Bash, Edit or Read. `ToolSearch` stays because Claude Code needs it to show somora's tools to the model. |
| `disallowedTools` | Denies the six known claude.ai connector login tools by name, such as `mcp__claude_ai_Gmail__authenticate`. |
| `canUseTool` gate | Checked on every call. Allows only `mcp__somora__*` and `mcp__somora-<name>__*` (your external MCP servers, passed through somora). Everything else is denied. |
| `managedSettings: { autoMemoryEnabled: false }` | Claude Code's own project memory is not loaded into the prompt. |
| `strictMcpConfig: true` | Only the MCP servers somora passes exist in the session. Your claude.ai connectors do not appear at all. |

A session recorded under an earlier name of somora's MCP server is
restarted once on its next turn. The history is carried over and the
chat shows a `session restarted` row.

The SDK's start message also lists `skills`, `slash_commands` and
`agents`. That is the SDK's own inventory. With a plain system prompt
and `settingSources: []`, none of it is sent to the model.

### Codex

Codex ships with many built-in features that are on by default. somora
turns them off for every thread.

| Measure | Effect |
|---|---|
| **Pinned binary** | Codex is a bundled dependency with an exact version. A Codex release cannot change the tool surface underneath somora. `somora codex features list` shows the feature flags of the bundled version. |
| **Features off** | Shell and exec tools, browser and computer use, image generation, apps, multi-agent (`multi_agent`, `multi_agent_v2`, `agents.enabled`), personality, mentions, hooks and plugins, goals, fast mode, `view_image`, `skill_search`. |
| **Settings** | `web_search="disabled"`, `tools.update_plan.enabled=false`, `tools.experimental_request_user_input.enabled=false`, bundled skills off, `project_doc_max_bytes=0` and `project_root_markers=[]` (no `AGENTS.md` lookup), `notify=[]`, `mcp_servers={}`. |
| **Own Codex home** | Codex runs with `CODEX_HOME=~/.somora/codex-home`. Only `auth.json` is copied from `~/.codex`. Your `config.toml`, MCP servers, hooks, plugins, skills and thread store never reach an agent. |
| **Approvals** | Threads start with `approvalPolicy: never` and `sandbox: danger-full-access`. An approval request that arrives anyway is declined. |

Codex's own sandbox is off on purpose. Codex's built-in shell and file
tools are switched off, and somora's tools must not be blocked by a
second approval flow. somora's tool rules are the only guard.

**Code Mode.** On models that Codex runs in Code Mode, the model writes
JavaScript that calls `tools.somora.<tool>(...)`. That script has no
`require`, `process`, `fetch` or filesystem. It can only call the tools
somora exposes, and those run on the somora server under the same rules
as on every other engine.

**What stays on.** Codex's `tool_search` stays enabled: the model finds
the somora tools that are not in its direct list through it.
`apply_patch` cannot be switched off, because Codex has no setting for
it. The three `list_mcp_resource*` helpers only read MCP resources, and
no MCP server is configured.

### Grok

The Grok engine is not locked down like the other two. somora starts
`grok agent --always-approve` and adds its own tools as an MCP server.
It passes no option that disables Grok's built-in file and shell tools,
and it runs Grok with your normal `~/.grok` home. Those built-in tools
work in the agent's workspace folder and do not pass through somora's
rules.

### OpenAI compatible

There is no CLI in between, so nothing is loaded from the host. somora
sends the turn's `messages` and `tools` to the configured `baseUrl` and
reads the answer. What that endpoint does with the text is the
provider's business, and the provider is your choice.

One more field goes along by default: the standard `user` string. A
gateway in between can use it to attribute spend per agent. It holds
agent names and session ids, nothing else:

| Call | `user` value |
|---|---|
| Chat turn | `<agent>/<session id>` |
| Background workers | `<agent>/rem`, `<agent>/deep`, `lucid/<pass>`, `<agent>/compaction`, `<agent>/analyze_file` |

Set `sendUserTag: false` on a provider that must not see it.

To stop runaway loops, a turn is capped at `agentLoop.maxRounds` rounds
of tool calls (default 8) and `agentLoop.maxToolCallsPerTurn` calls in
total (default 30). A fast tool call times out after
`agentLoop.toolCallTimeoutMs` (default 30 s).

## Where credentials live

All of these are plain files that the somora user can read. somora has
no encrypted store.

| Credential | File |
|---|---|
| Claude login | `~/.somora/claude-home/.credentials.json`, kept identical to `~/.claude/.credentials.json` |
| Codex login | `~/.somora/codex-home/auth.json`, copied from `~/.codex/auth.json` when that one is newer |
| Grok login | `~/.grok/auth.json`, written by `grok login` |
| API keys of providers | `apiKey` under `providers` in `~/.somora/config.yaml` |
| Secrets for skills and tools | `~/.somora/somora.env`, loaded into the server's environment at start |
| SSH keys for resources | the file named by `resources.<name>.keyPath`. Pinned host keys are in `~/.somora/known_hosts.json`. |
| TLS certificate and key | the files named by `server.tls.cert` and `server.tls.key` |

The Claude login is synced in both directions, so a new login in either
place reaches the other. Set `claudeCli.sharedUserCredentials: false`
when somora uses a separate Claude account. somora then touches neither
file.

At start somora warns when `somora.env` is readable by other users.
Run `chmod 600` on it.

> **Note:** Only `~/.ssh`, `~/.gnupg`, `~/.aws/credentials` and
> `~/.kube/config` are closed to the file tools. An agent with file or
> shell tools can read the other files in this table.

Clients hold no model logins. The web client, the phone app and the TUI
only talk to the somora API.

## The daily update check

Once a day the server asks somora.ai whether a newer version exists.
The answer appears as an update notice in the clients and in
`GET /version`.

```http
GET https://somora.ai/api/latest-version
User-Agent: somora/<version> (linux; node/<version>; x64; server)
```

That is the whole request. It has no body and no identifier. The
`User-Agent` line names the somora version, the operating system, the
Node.js version and the CPU type. Like any web server, somora.ai sees
the IP address the request comes from.

Any one of these stops the request:

- `updateCheck.enabled: false` in `config.yaml`
- `DO_NOT_TRACK=1` in the server's environment
- a `CI` variable in the environment

The first check runs one to six minutes after the server starts. A
failed check is retried after an hour. The request times out after 3
seconds and does not follow redirects. The last answer is stored in
`~/.somora/update-check.json`.

## What somora does not defend against

- **A hostile provider.** somora passes your prompt to the endpoint you
  configured and uses the answer.
- **A model that works against you.** The shell and file rules catch
  accidents. A command that avoids the patterns runs with your user's
  rights.
- **Secrets in notes.** If you write a secret into a memory note and
  ask an agent about it, the model sees the secret.
- **What the CLI binaries do themselves.** somora does not sandbox the
  spawned binaries or their network traffic. Codex runs with
  `sandbox: danger-full-access`, and the Claude and Grok binaries get no
  sandbox option.
- **Several users.** somora assumes you are its only user. There are no
  accounts and no permissions between people.
- **An open port.** Anyone who can reach the port has the same access
  as you, including a shell.

## Settings

All settings live in `config.yaml`. The values shown are the defaults.
`server.tls` has no default: without it the server speaks plain HTTP.

```yaml
server:
  host: 127.0.0.1
  port: 18737
  # tls:
  #   cert: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.crt
  #   key: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.key
  #   publicHost: <your-host>.<your-tailnet>.ts.net
  #   renew: tailscale
updateCheck:
  enabled: true
  endpoint: https://somora.ai/api/latest-version
claudeCli:
  sharedUserCredentials: true
agentLoop:
  maxRounds: 8
  maxToolCallsPerTurn: 30
  toolCallTimeoutMs: 30000
browser:
  enabled: false
  allowPrivate: []
```

| Setting | Default | Meaning |
|---|---|---|
| `server.host` | `127.0.0.1` | Address the server listens on. `0.0.0.0` accepts other devices. `SOMORA_HOST` overrides it. |
| `server.port` | `18737` | Port. `SOMORA_PORT` overrides it. |
| `server.tls.cert` | none | Certificate file (PEM). Together with `key` it switches the server to HTTPS. |
| `server.tls.key` | none | Private key file (PEM). |
| `server.tls.publicHost` | none | Host name clients use. Must match the certificate. |
| `server.tls.renew` | none | `tailscale`: somora asks Tailscale for a fresh certificate before the old one runs out. |
| `updateCheck.enabled` | `true` | The daily update check. |
| `updateCheck.endpoint` | `https://somora.ai/api/latest-version` | Where to ask. Point it at a mirror of your own. |
| `claudeCli.sharedUserCredentials` | `true` | Keep the Claude login in sync with `~/.claude`. |
| `agentLoop.maxRounds` | `8` | Most rounds of tool calls per turn, OpenAI compatible engine. |
| `agentLoop.maxToolCallsPerTurn` | `30` | Most tool calls per turn in total, OpenAI compatible engine. |
| `agentLoop.toolCallTimeoutMs` | `30000` | Time limit of a fast tool call. |
| `browser.enabled` | `false` | The browser tools. |
| `browser.allowPrivate` | `[]` | Private hosts or ranges the browser may open. |
| `resources.<name>.allowBlocked` | `[]` | Blocked shell commands this SSH resource may run anyway. |
| `sendUserTag` (per provider) | `true` | Send the `user` string to an OpenAI compatible provider. |

Per agent, in `agent.yaml`:

| Setting | Default | Meaning |
|---|---|---|
| `tools.deny` | none | Tools the agent does not get. Exact name, `toolset:<tag>`, or a name ending in `*`. Deny beats allow. |
| `tools.allow` | none | When set, the agent gets only these. |

## Commands and routes

| Command or route | What it does |
|---|---|
| `somora telemetry show` | Prints the update check request, why it is on or off, and when it last ran. `--json` for machines. |
| `somora codex features list` | Lists the feature flags of the bundled Codex. |
| `GET /version` | Running version and, once known, the latest published one. |
| `GET /logs` | Tail of the server log. Parameters: `day`, `agent`, `q`, `minLevel`, `limit`. |

## Troubleshooting

Log lines that concern this page:

| Log line | Meaning |
|---|---|
| `engine.init` | Start of a Claude session, with the full tool list and `mcp_servers`. Use it to check what the model was given. |
| `engine.tools_leaked` | A tool that is not somora's reached a Claude session. Logged once per server run. Calls to it are still denied by the gate. |
| `engine.mcp_servers_leaked` | An MCP server that is not somora's showed up in a Claude session. Logged once per server run. |
| `engine.codex_unexpected_approval` | Codex asked for an approval. somora declined it. |
| `server.bind_loopback_with_public_host` | `server.tls.publicHost` is set but the server listens on `127.0.0.1`, so other devices cannot connect. Set `server.host: 0.0.0.0`. |
| `update.check_disabled` | The update check is off. The line names the reason. |
| `update.check_failed` | The update check could not reach the endpoint. It is retried after an hour. |

**Other devices cannot connect.** The server listens on `127.0.0.1`.
Set `server.host: 0.0.0.0` and restart.

**A command is refused as blocked.** The result names the pattern that
matched. On an SSH resource you can allow it with `allowBlocked`.

## Reporting issues

Open a GitHub issue with the `security` label. Do not include secrets
in the report.

## See also

- [Setup](setup.md): HTTPS via Tailscale, and what somora.ai does with
  the update check request
- [Agents](agents.md): `agent.yaml`, tool limits per agent, persona
  backups
- [Tools](tools.md): every tool an agent can have
- [Resources](resources.md): SSH targets, host keys, `allowBlocked` and
  its audit file
- [Models](models.md): providers, API keys and `sendUserTag`
- [Builder](builder.md): where a builder may write
- [Browser](browser.md): which sites the browser tools may open
- [API](api.md): `GET /logs`, `GET /version`, `WS /terminal/attach`
