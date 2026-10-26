# Security model

somora runs on your machine, under your user account, with the model
logins you already have. This page says who can reach it, what an agent
can do on the host, what each engine is kept away from, and where
credentials live. In short: a key and the network decide who gets in,
and agents are trusted helpers with guard rails, not sandboxed programs.

## What you get

- **A key on every request.** Programs send it, a browser signs in
  once. `server.auth: off` switches it off.
- **Private by default.** The server listens on `127.0.0.1` only.
  Opening it to your network is one explicit setting.
- **Only somora's tools.** The Claude, Codex and Grok engines run with
  their own built-in tools and your personal CLI setup switched off.
- **Separate engine homes.** Your interactive Claude Code, Codex and
  Grok state never reaches an agent. Only the login is shared.
- **Guard rails against accidents.** Destructive shell commands and
  reads of private keys are refused.
- **One documented request home.** A daily version check with no
  identifier, and three ways to turn it off.

## Check your setup

These commands tell you where you stand.

```bash
# Where does the server listen, and is the key on? No output means the
# defaults: 127.0.0.1, key on
grep -A4 '^ *server:' ~/.somora/config.yaml

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

Two things decide it: the address the server listens on, and its key.

| Setup | Who can connect |
|---|---|
| Default, `server.host: 127.0.0.1` | Programs on the same machine, with the key. Websites open in your browser are turned away (see below). |
| `server.host: 0.0.0.0` | Every device that can reach the machine on port 18737, with the key. |

The environment variable `SOMORA_HOST` overrides `server.host`.

> **Warning:** Set `0.0.0.0` only on a network you trust end to end,
> such as a Tailscale network. Never expose the port to the internet,
> and do not put it behind a reverse proxy without authentication.

### The key

somora makes one key, with `somora init` or on its first start, and
keeps it in `~/.somora/server.key`, readable by your user only. It
looks like `somora_` followed by 43 letters, digits, `-` and `_`. With
`server.auth: on`, the default, every request needs it: from the same
machine, over the network and over Tailscale alike. There are no user
accounts. The key opens every route, including the shell
(`WS /terminal/attach`).

| Who | What it takes |
|---|---|
| Terminal client and `somora` commands on the server | Nothing. They read the key file. |
| Agents, dream runs, triggers, the engines' somora tools | Nothing. somora hands the key to its own processes. |
| A browser or phone | Once: paste the key, or open the link from `somora key link`. The browser keeps a cookie for a year. |
| Scripts, `curl`, other programs | `-H "Authorization: Bearer <key>"`. On the server: `$(somora key)`. |
| The terminal client on another machine | `SOMORA_KEY=<key>` in its environment. |

Commands:

| Command | What it does |
|---|---|
| `somora key` | Prints the key. |
| `somora key link` | Prints a link that signs a browser in and a QR code for the phone. Opens the browser when the machine has a screen; `--no-open` does not. |
| `somora key rotate` | Makes a new key. The running server switches within seconds. Every browser signs in again, and scripts need the new key. |

The key is kept out of an agent's shell environment, so `env` does not
show it. A script an agent writes reads it with `somora key`. The
exception is a command or tmux session started with
`inherit_agent_env: true`, which passes it through.

Ten wrong keys from one address within five minutes block that address
for a minute. The server's own machine is never blocked.

> **Warning:** Anyone with the key, or with a link from
> `somora key link`, can use somora. Treat it like a password. Lost or
> shared it? Run `somora key rotate`.

`server.auth: off` makes the server ask for no key, as before the key
existed. Then only the address it listens on decides who gets in.

### Websites in your browser

Your browser can reach the port too, on behalf of any website you have
open. Without a check, a page could open the terminal over a WebSocket,
send an agent a task, or read answers through a name of its own that
later points at your machine (DNS rebinding).

So the server turns such requests away with `403`. A request from a
browser passes when two things hold:

- It was sent to one of this machine's names: any IP address,
  `localhost`, the host name and `<host>.local`, every `*.ts.net` name,
  `server.tls.publicHost`, and what you list under
  `server.allowedHosts`.
- The page that sent it is somora itself: the same address, an address
  of this machine, `localhost`, the host name, `publicHost` or an
  `allowedHosts` entry. A page on another computer in your network or
  tailnet does not count.

The web client and the mobile app pass, because somora serves them
itself. A link from another website still opens somora. Programs that
are not browsers send no such marks and are never checked: the
terminal client, `curl`, scripts and the agents' own tools.

Reach somora in the browser under a DNS name of your own, for example
`somora.home.lan`? Add it to `server.allowedHosts`.

### HTTPS

With `server.tls` set, the server speaks HTTPS (HTTP/2, with HTTP/1.1 as
a fallback). Without it, it speaks plain HTTP. TLS encrypts the
connection. It does not add a login. Over plain HTTP the key and the
sign-in cookie travel unencrypted, so on a network you do not trust,
use HTTPS.

### The server log

`GET /logs` serves the tail of somora's own log so the web client can
show it. The log holds event names, tool names, file paths, shell
commands, agent and session names. The route takes a day, never a path,
so it cannot read other files.

Treat the log as readable by everyone
who has the key, or with `server.auth: off`, by everyone who can reach
the port. On disk, `~/.somora/logs/` is readable by your
user only; somora tightens an older folder at the next start.

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
`CLAUDE_CONFIG_DIR`, `NODE_ENV` and the key `SOMORA_KEY`, are removed
unless the agent passes `inherit_agent_env: true`. A script that calls
somora's API takes the key from `somora key`.

### Sentinel check scripts

An agent with the `sentinel` tool can leave a script behind that the
server runs on its own, every few seconds to minutes, while nobody
watches. The script runs as the somora user in the agent's workspace,
with the skill secrets of the programs it names.

When the trigger is
created, a shell script is checked against the commands `exec` blocks,
and a script in any language that restarts, stops or updates somora is
refused; nothing is checked while it runs, and Python or JavaScript
scripts are not checked against the `exec` list at all. somora runs a
copy and checks its fingerprint, so a later edit of the file does not
change what runs.

Take the tool away with
`tools.deny: ['sentinel']` where an agent should not leave anything
running ([Sentinel](sentinel.md#check-triggers)).

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
ranges, link-local and cloud metadata addresses, also written as IPv6
(`[::1]`, `[::ffff:7f00:1]`). A name is checked on the addresses it
resolves to, at the moment of connecting, so `127.0.0.1.nip.io` or a
name that changes its answer is refused too.

Redirects are followed one hop at a time, each checked before anything
is sent to it, at most five. To let agents read an internal page, list its host, IP or IPv4 range in
`web.fetchAllowPrivate`. A `*.example.lan` entry covers every name
under that domain.

The browser tools are off by default (`browser.enabled`). When on, they
block private networks unless a host or range is listed in
`browser.allowPrivate`.

### Pictures from other websites

The chat in the web and mobile clients, the wiki window and the file
viewer show a picture from somora itself at once: generated media, a
file by its path, a `data:` image. A picture from another website waits
for a click on **Show**. Loading it tells that website the address, and
an agent talked into it by a page it read could put your data into that
address. **Always show** brings back loading at once, in this browser.

An SVG opened on its own, from any route, runs no scripts.

### Memory tools

`memory_write`, `memory_edit` and `memory_delete` only touch
`~/.somora/agents/<name>/memory/`. A note name must match
`^[a-z0-9][a-z0-9_-]*$`: no path separators, no uppercase, no leading
dot. Even a faulty model output cannot leave the agent's memory folder
through these three tools.

The memory tools cannot write to the wiki or the vault. The wiki is
written by the Deep and Lucid phases, which run on the server. An agent
with file tools can still write there like anywhere else.

### Agents that do not dream

An agent with `dreams: false` keeps its notes in its own memory folder.
The vault and the wiki inside it are read-only for it:
- **No tools:** it has no wiki writing tools and no dream tools.
- **File writes refused:** `file_write` and `file_patch` refuse every
  path in the vault, including one reached through a symlink. Reading
  and searching work.
- **The shell can still write:** with `exec` it can write where your
  user account can. Deny `toolset:exec` too when that has to hold.

See [Who dreams](dream-phases.md#who-dreams).

### Limiting an agent

To take tools away, add a `tools` block to the agent's `agent.yaml`:

```yaml
tools:
  deny: ['toolset:exec', 'file_write', 'file_patch']
```

A denied tool is removed from the model's tool list on every engine.
The route that runs one tool as an agent, `POST
/agents/<name>/tools/<tool>`, checks the same rules and answers `403`
for a denied tool, so another agent or a script cannot use it in this
agent's name.

The rules decide which somora tools an agent can call. They are not a
wall around an agent that keeps a shell: with `exec` it can still do
what its user account can do. Deny `toolset:exec` too when a lock has
to hold.

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
| **Settings** | `web_search="disabled"`, `tools.update_plan.enabled=false`, `tools.experimental_request_user_input.enabled=false` (Codex's other question tool, `request_user_input_async`, stays on: its questions arrive as a [card](tools.md#questions-to-you) and change nothing by themselves), bundled skills off, `project_doc_max_bytes=0` and `project_root_markers=[]` (no `AGENTS.md` lookup), `notify=[]`, `mcp_servers={}`. |
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

somora starts `grok agent --no-leader --always-approve stdio` for
each turn and hands Grok an agent profile with the session:

- **Only somora's tools.** The profile allows two tools, `search_tool`
  and `use_tool`, which reach somora's MCP server. Grok's built-in
  terminal, file, web search, scheduler and subagent tools are off, so
  everything an agent does passes through somora's gating and rules.
  `--always-approve` therefore approves only somora's own tools.
- **somora's system prompt.** It replaces Grok's own prompt, and is
  sent again on every resume.
- **No skills and no `AGENTS.md`** from the working folder.

Grok runs with its own home, `~/.somora/grok-home` (`GROK_HOME`), not
with your `~/.grok`. Your Grok sessions, plugins, MCP servers and
settings stay out of somora. Grok's own cross-session memory is off
(`GROK_MEMORY=0`), its self-update is off, and `--no-leader` keeps
each turn in a private process instead of a shared one.

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
| Grok login | `~/.somora/grok-home/auth.json`, kept in step with `~/.grok/auth.json`: the copy that expires later wins, in both directions |
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
- **What an external agent does on its own machine.** An
  [external agent](external-agents.md) runs with the rights of the SSH
  user somora logs in as. Its own system decides what it does there.
  somora gives it no access to somora's files or terminal.
- **What an external agent gets in a task.** Work your agents hand an
  external agent over [A2A](a2a.md) leaves your machine with the token
  for that system: the text, and any attached images or files, inside
  the message or as download links valid for one hour.
- **Tasks from other systems.** Agents you switch on for A2A take tasks
  from the peers listed in `a2a.peers`, each with its own token. Such a
  task runs with the agent's tools minus `a2a.tools.deny`, so narrow
  that list for an agent that should not run commands for others. The
  Agent Cards under `/a2a/agents/…` are public by the standard and name
  the switched-on agents ([A2A](a2a.md#security)). Download links under
  `/a2a/files/…` open one file for an hour each; `somora key rotate`
  ends them all.
- **A leaked key.** Anyone who has the key and reaches the port has the
  same access as you, including a shell. `somora key rotate` locks them
  out. With `server.auth: off`, reaching the port is enough.

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
  allowedHosts: []
  auth: on
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
web:
  fetchAllowPrivate: []
```

| Setting | Default | Meaning |
|---|---|---|
| `server.host` | `127.0.0.1` | Address the server listens on. `0.0.0.0` accepts other devices. `SOMORA_HOST` overrides it. |
| `server.port` | `18737` | Port. `SOMORA_PORT` overrides it. |
| `server.tls.cert` | none | Certificate file (PEM). Together with `key` it switches the server to HTTPS. |
| `server.tls.key` | none | Private key file (PEM). |
| `server.tls.publicHost` | none | Host name clients use. Must match the certificate. |
| `server.tls.renew` | none | `tailscale`: somora asks Tailscale for a fresh certificate before the old one runs out. |
| `server.auth` | `on` | `on`: every request needs the key in `~/.somora/server.key`. `off`: no key, the network alone decides. |
| `server.allowedHosts` | `[]` | More names a browser may use to reach somora. IP addresses, `localhost`, the host name, `*.ts.net` and `publicHost` always work. |
| `updateCheck.enabled` | `true` | The daily update check. |
| `updateCheck.endpoint` | `https://somora.ai/api/latest-version` | Where to ask. Point it at a mirror of your own. |
| `claudeCli.sharedUserCredentials` | `true` | Keep the Claude login in sync with `~/.claude`. |
| `agentLoop.maxRounds` | `8` | Most rounds of tool calls per turn, OpenAI compatible engine. |
| `agentLoop.maxToolCallsPerTurn` | `30` | Most tool calls per turn in total, OpenAI compatible engine. |
| `agentLoop.toolCallTimeoutMs` | `30000` | Time limit of a fast tool call. |
| `browser.enabled` | `false` | The browser tools. |
| `browser.allowPrivate` | `[]` | Private hosts or ranges the browser may open. |
| `web.fetchAllowPrivate` | `[]` | Private hosts, IPs or IPv4 ranges `web_fetch` may read. `*.example.lan` covers every name under that domain. |
| `resources.<name>.allowBlocked` | `[]` | Blocked shell commands this SSH resource may run anyway. |
| `sendUserTag` (per provider) | `true` | Send the `user` string to an OpenAI compatible provider. |

Per agent, in `agent.yaml`:

| Setting | Default | Meaning |
|---|---|---|
| `tools.deny` | none | Tools the agent does not get. Exact name, `toolset:<tag>`, or a name ending in `*`. A name here beats `allow`; a family rule here does not. |
| `tools.allow` | none | Exceptions: tools switched on inside a family that `deny` switches off. Without such a family rule it keeps the older meaning, only these tools. |

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
| `auth.refused` | A request without the right key, with address, path and whether a key was sent at all (never the key). Once a minute per address and path. |
| `auth.login` / `auth.login_refused` | A browser signed in, or tried with a wrong key. |
| `http.browser_refused` | A browser request was turned away, with the reason, the `origin` and the `host`. |

**Other devices cannot connect.** The server listens on `127.0.0.1`.
Set `server.host: 0.0.0.0` and restart.

**A script or program gets `401 somora needs its key`.** Send
`-H "Authorization: Bearer <key>"`; on the server `somora key` prints
it. To go back to no key at all: `server.auth: off` and restart.

**The browser or phone asks for the key.** Paste what `somora key`
prints, or open the link from `somora key link`. A phone app that stays
on an error screen after an update: close it and open it again.

**The key is lost or was shared.** `somora key rotate` makes a new one.

**`429 too many wrong keys`.** Ten wrong keys came from this address.
Wait a minute and use the right one.

**The web client shows `refused: host '…' is not one of this server's
names`.** You opened somora in the browser under a DNS name of your
own. Add it to `server.allowedHosts` and restart.

**An agent cannot read a page on your network.** `web_fetch` names the
host and the address. List it in `web.fetchAllowPrivate` and restart.

**A command is refused as blocked.** The result names the pattern that
matched. On an SSH resource you can allow it with `allowBlocked`.

## Reporting issues

Report a security problem privately, not as a public issue: open the
**Security** tab of the GitHub repository and choose **Report a
vulnerability**. Only the maintainers see it. Do not include secrets
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
