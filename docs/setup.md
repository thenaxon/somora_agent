# Setup

This page takes you from an empty machine to a somora server that runs
in the background and answers in the browser, on the phone and in the
terminal. The short way is one installer command followed by a guided
assistant. Everything the two do can also be done by hand, and the
reference at the end lists every command, file and server setting.

## What you get

- **One command to install.** The installer brings Node.js, the system
  packages, somora and the background service.
- **A guided assistant.** `somora setup` connects your models, creates
  the first agent, turns on memory and sets up HTTPS. It is safe to run
  again at any time.
- **A service that stays up.** somora starts at boot on Linux and at
  login on macOS, and comes back after a crash.
- **Your subscriptions or your own server.** A Claude or ChatGPT
  subscription, a local model server or an API key. No model ships with
  somora.
- **Updates in one command.** `somora update` installs the new version
  and restarts the service.

## Install it

```bash
curl -fsSL https://somora.ai/install.sh | bash
```

Run it as the user who will own somora, not as root. The agents get
that user's rights. The installer shows the somora lettering and then
works through these steps. A step that is already in place is skipped.

| Step | What happens | Admin rights |
|---|---|---|
| System packages | tmux, ripgrep and git. On Linux also a C and C++ compiler, make and python3. Installed with apt, dnf, pacman, zypper or Homebrew. | Asked first. Without them only the missing build tools stop the install. |
| Node.js | Kept when it is 22.22 or newer. Otherwise Node 24 system wide (NodeSource or Homebrew), or the official build into `~/.local/share/somora/node`, checked against its checksum. | Only for the system wide variant. |
| npm folder | When npm's global folder is not writable for you, it moves to `~/.npm-global` and is added to your `PATH`. | No. |
| somora | `npm install -g somora`, about 1.6 GB on Linux, 1.4 GB on macOS, with the bundled engines. | No. |
| Service | Linux: systemd user unit, enabled at boot, lingering on so it survives logout. macOS: LaunchAgent that starts at every login. | Lingering may ask. |
| Assistant | Starts `somora setup` when a terminal is attached. | No. |

Supported systems:

| System | Support |
|---|---|
| Linux, x86_64 or arm64, with glibc | Yes. |
| macOS, Intel or Apple Silicon | Yes. Apple's command line tools must be installed first: `xcode-select --install`. |
| Windows | Inside WSL2 only. |
| Alpine Linux | No. The native modules need glibc. |

Options go after `bash -s --`, or are set as environment variables:

```bash
curl -fsSL https://somora.ai/install.sh | bash -s -- --no-setup
curl -fsSL https://somora.ai/install.sh | bash -s -- --version 2026.930.1
curl -fsSL https://somora.ai/install.sh | bash -s -- --yes --no-sudo
```

| Option | Variable | Meaning |
|---|---|---|
| `--version <v>` | `SOMORA_VERSION` | Install this version instead of the latest. |
| `--yes`, `-y` | `SOMORA_YES=1` | No questions, take the defaults. The assistant is not started. |
| `--no-setup` | `SOMORA_NO_SETUP=1` | Stop before the assistant. |
| `--no-service` | `SOMORA_NO_SERVICE=1` | Write the service definition, but do not enable or start it. |
| `--no-sudo` | `SOMORA_NO_SUDO=1` | Never ask for admin rights. |
| none | `SOMORA_ALLOW_ROOT=1` | Allow a run as root, for containers. |

Without a terminal, for example in a pipeline, the installer takes the
defaults, starts the service and tells you to run `somora setup`.

`https://somora.ai/install.sh` always serves the script of the latest
release. The same file is attached to every GitHub release as
`install.sh`.

## The setup assistant

```bash
somora setup            # all steps, in order
somora setup access     # one step only
```

| Step | What it does |
|---|---|
| `models` | Connects a Claude subscription (runs the login of the Claude Code bundled with somora), a ChatGPT subscription (the bundled Codex login, in the browser or with a device code), or your own server. For a server it asks the address and key, lists the models and asks each one's context window. |
| `search` | Asks for a Brave Search API key, checks it with one real search and stores it as `web.brave.apiKey`. That gives the agents the `web_search` tool. |
| `agent` | Creates an agent: name, what it calls you, answer language, model and backup model. On an existing install it lists the agents and offers to repair one whose model is gone. |
| `memory` | Turns on REM per agent with a model and a backup model, offers the duplicate check for new notes, and sets up the shared wiki with Deep and Lucid, their model and a backup model. The wiki goes into a new folder or your Obsidian vault. |
| `team` | With two or more agents and no team file yet: writes `team.yaml`. |
| `access` | This machine only, the local network, or Tailscale HTTPS. For Tailscale it installs and connects it if needed, walks you through the one switch in the Tailscale admin page, fetches the certificate and turns on automatic renewal. |
| `start` | Starts the service, or restarts it after asking. Waits until it answers, sends an agent a real test message and says which model replied. |

Good to know:

- A single step runs alone. When it changed something, the `start` step
  follows to apply it.
- REM, Deep and Lucid accept any connected model, a Claude or ChatGPT
  subscription included.
- The assistant never rewrites a file wholesale. Comments and your own
  settings in `config.yaml` and `agent.yaml` stay.
- The previous version of a changed file is kept next to it as
  `<name>.bak-setup-<date>-<time>`.
- A result the server could not load is not written at all.

## Install by hand

The installer does nothing you cannot do yourself. You need:

| Tool | Why |
|---|---|
| Node.js 22.22 or newer | The runtime. Every `somora` command refuses an older Node and prints the upgrade steps. |
| macOS, or Linux with glibc 2.34 or newer | Debian 12, Ubuntu 22.04, RHEL 9, Fedora 35 or later. The memory database ships prebuilt for these, with no build step. On an older Linux every `somora` command stops and names the last version that runs there. |
| tmux | The `tmux` tool and the terminal windows of the web client. |
| ripgrep (`rg`) | The `file_search` tool. |
| git | Used by skills and by builder agents. |
| C and C++ compiler, make, python3 | Linux only. One native module, `node-pty`, is compiled during the install. On macOS Apple's command line tools do this. |

```bash
sudo apt install tmux ripgrep git build-essential python3   # Debian, Ubuntu
sudo dnf install tmux ripgrep git gcc-c++ make python3      # Fedora
brew install tmux ripgrep git                               # macOS
```

Then install and start:

```bash
ONNXRUNTIME_NODE_INSTALL=skip npm install -g somora
somora init            # data folder and service definition
somora server start    # start the service and enable it at boot
somora setup           # models, first agent, memory, HTTPS
somora tui             # chat in the terminal
```

`ONNXRUNTIME_NODE_INSTALL=skip` leaves out a 300 MB CUDA library that
somora never uses. Embeddings run on the CPU. The installer and
`somora update` set it for you.

If npm answers `EACCES`, its global folder belongs to root. Give npm a
folder of your own instead of reaching for `sudo`:

```bash
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.profile && source ~/.profile
```

Without the assistant, the first server start writes a `config.yaml`
with one Claude provider and, when no agent exists, a starter agent
named `default`. Edit both, or create your own agent as the agents
guide describes.

## Run as a service

`somora init` writes the service definition with the path of the
installed `somora` baked in. It is safe to run again. The same commands
work on Linux and macOS.

| Command | What it does |
|---|---|
| `somora server start` | Starts the service and enables it for the next boot or login. |
| `somora server stop` | Stops it. Without a service it sends a stop signal to the running server. |
| `somora server restart` | Restarts the service. |
| `somora server status` | Shows process, port, host, start time and version, a waiting update, and the state of the service. |
| `somora server start --foreground` | Runs the server in this terminal, without a service. Ctrl-C stops it. Use it in a container or while debugging. `-f` is the short form. |

### Linux

The service is a systemd user unit at
`~/.config/systemd/user/somora.service`. It is restarted five seconds
after a failure. Read its output with `journalctl --user -u somora -f`.

A user service stops when you log out unless lingering is on. The
installer turns it on. By hand:

```bash
sudo loginctl enable-linger $USER
```

`somora init` rewrites the unit on every update. Your own
`Environment=` and `EnvironmentFile=` lines are carried over, and the
command prints what it preserved. A drop-in file under
`~/.config/systemd/user/somora.service.d/` is never touched.

### macOS

The service is a LaunchAgent at
`~/Library/LaunchAgents/ai.somora.server.plist`. macOS starts it at
every login and brings it back after a crash. `somora server stop`
unloads it until the next login or the next `somora server start`. Its
output goes to `~/.somora/logs/launchd.log`.

> **Note:** A LaunchAgent never runs before its user has logged in. On
> a Mac used as a server, turn on automatic login under System
> Settings, Users & Groups.

## Connect models

somora needs at least one model. `somora setup models` writes these
blocks for you. By hand, edit `providers` in `~/.somora/config.yaml`.

| Kind | Engine | Login |
|---|---|---|
| Claude subscription | `claude-cli` | `somora auth login`. Claude Code is bundled with somora. A Claude Code you installed yourself, and its login, is used instead when present. No API key. |
| ChatGPT subscription | `codex-cli` | `somora codex login`. Codex is bundled with somora. A login made with a global Codex is picked up too. |
| Grok subscription | `grok-cli` | `somora grok login`, or `somora grok login --device-auth` on a machine without a browser. The Grok CLI is bundled with somora. A login made with a global Grok is picked up too. |
| Own server or API key | `openai-compatible` | Ollama, LM Studio, vLLM, oMLX, OpenRouter or any other server with a `/v1/chat/completions` endpoint. |

```yaml
providers:
  anthropic:
    engine: claude-cli
    models:
      - id: claude-opus-5-5
        alias: opus
        contextWindow: 1000000
        capabilities: [text, image, pdf, reasoning]
  local:
    engine: openai-compatible
    baseUrl: http://localhost:11434/v1
    apiKey: none                 # most local servers ignore it
    models:
      - id: llama3.3:70b
        alias: llama
        contextWindow: 131072    # the SERVER's limit, not the model card's
        capabilities: [text]
```

Provider names are free. Several servers can sit side by side under
different names. Aliases must be unique across the whole file.

Connect two providers when you can. An agent's `fallback` model then
answers when the first one is down.

A Grok subscription signs in the Grok CLI, not the xAI API. An
`openai-compatible` provider pointed at `https://api.x.ai/v1` is billed
separately, per token. Grok calls somora's tools through its own
`use_tool` step. somora records them under their usual names, such as
`mcp__somora__memory_list`.

somora unpacks the bundled Grok CLI once into `~/.somora/grok-home/bin`
and runs Grok with that folder as its home, so your own `~/.grok`
stays untouched. A login you make with your own Grok is picked up, and
somora's refreshed login is copied back to it. See the
[security guide](security.md#grok).

The models guide has a tested block for every model family, the Codex
and Grok details and all model fields.

## HTTPS via Tailscale

Over plain HTTP the web client works in one window on the machine
itself. For daily use from other devices you want HTTPS:

- A browser allows six connections per address over plain HTTP. Every
  chat window and terminal holds one, so new windows stop sending.
  HTTPS uses HTTP/2, which has no such limit.
- The microphone, the clipboard and installing the phone app need a
  secure address.

Tailscale is the supported way. It is a private network between your
own devices and issues a publicly trusted certificate for your
machine's name at no cost. `somora setup access` does all of the
following for you.

1. Install Tailscale on the somora host and connect it:
   `sudo tailscale up`.
2. In the [Tailscale admin DNS page](https://login.tailscale.com/admin/dns),
   turn on **MagicDNS** and **HTTPS Certificates**. Once per account.
3. Allow your user to fetch certificates, so somora can renew them:
   `sudo tailscale set --operator=$USER`.
4. Fetch the certificate. `tailscale status` shows your host name.

   ```bash
   mkdir -p ~/.somora/certs && cd ~/.somora/certs
   tailscale cert <your-host>.<your-tailnet>.ts.net
   ```

5. Point `~/.somora/config.yaml` at the two files:

   ```yaml
   server:
     host: 0.0.0.0        # accept other devices; the default 127.0.0.1 is this machine only
     port: 18737
     tls:
       cert: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.crt
       key:  ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.key
       publicHost: <your-host>.<your-tailnet>.ts.net
       renew: tailscale
   ```

6. Restart somora and open
   `https://<your-host>.<your-tailnet>.ts.net:18737/web/`. The port is
   part of the address.

`publicHost` must match the name in the certificate. somora's own
internal calls go through the same HTTPS listener and verify it.

> **Warning:** somora has no login of its own. With `host: 0.0.0.0`
> everyone who can reach the port can talk to your agents. Tailscale is
> the access boundary. Do not open the port to the internet.

### Certificate renewal

A Tailscale certificate is valid for about 90 days. With
`renew: tailscale` the server asks Tailscale twice a day for a
certificate that is good for at least 30 more days
(`tailscale cert --min-validity 720h`) and loads the new pair without a
restart. Running turns are not interrupted.

Without `renew`, the server still watches the two files. Renew them any
way you like and the new certificate is served at the next check.

### Without Tailscale

Any certificate and key in PEM format work. The config does not care
who issued them. For a local network, [mkcert](https://github.com/FiloSottile/mkcert)
is the simplest: `mkcert -install` once per device, then
`mkcert <host>.local 192.0.2.10`. A self signed certificate without an
installed CA works, but every browser warns.

### Plain HTTP

Leave out the `server.tls` block and somora speaks plain HTTP. That is
fine for one window on the machine itself. The TUI is not affected.

## Update

```bash
somora update                # the current release
somora update --edge         # the newest build on npm, pre-releases included
somora update 2026.930.1     # one specific version
```

`somora update` does this, in order:

1. Asks npm which version is meant. When you already run it, nothing
   happens.
2. Checks that your Node.js is new enough for that version, before
   anything is installed.
3. Installs it with `npm install -g somora@<version>`.
4. Runs `somora init` from the new install, so the service points at
   it.
5. Restarts the service. When somora runs in the foreground, restart it
   yourself.

| Option | Meaning |
|---|---|
| `--release` | The current release. This is the default. |
| `--edge` | Whichever is newer on npm: the release or the latest pre-release. Cannot be combined with a version. |
| `<version>` | Exactly this version. A leading `v` is accepted. |
| `--force` | Reinstall even when that version is already running. |
| `--no-reinit` | Skip `somora init` after the install. Use it when you edited the service definition by hand. |
| `--help`, `-h` | Print the usage. |

A version number is a date and a counter: `2026.930.1` is the first
build of 30 September 2026.

After an update, reload the web client with Ctrl+Shift+R, or
Cmd+Shift+R on a Mac, so the browser drops the old script.

## The daily update check

Once a day the server asks somora.ai whether a newer version exists.
It is the only request somora makes on its own. The answer shows up as
a notice in the web client's taskbar, in `somora server status` and in
the server log as `update.available`. `somora update` itself asks npm.

The request is a plain `GET https://somora.ai/api/latest-version`. It
has no body and no identifier. Its `User-Agent` names the somora
version, the operating system, the Node.js version and the CPU type.
The answer is `{"version": "…", "note": "…"}`. The note is an optional
sentence to all installs, 500 characters at most.

Like any web server, somora.ai logs the request with its IP address and
the rough location derived from it, and counts installations per day,
version and system from those logs. Raw logs are deleted after 90 days.
Nothing is published or passed on.

Any one of these stops the request:

- `DO_NOT_TRACK=1` in the service's environment
- `updateCheck.enabled: false` in `config.yaml`
- a `CI` variable in the environment

`somora telemetry show` prints the request as it would be sent, why the
check is on or off, and when it last ran. `updateCheck.endpoint` points
the check at a mirror of your own. The security guide has the timing
details.

## Restart and reload

A restart ends every turn that is running. Many config changes do not
need one.

### Reload the config

| Where | How |
|---|---|
| Web client | Gear menu in the taskbar, then "Reload config". |
| TUI | `/reload` |
| API | `POST /config/reload` |

The server reads `config.yaml` again and checks it. A file with a
mistake is rejected with the reason, and the running config stays as it
was. A reload also forgets which models were marked unreachable.

The answer lists the sections that changed, and which of them only
apply after a restart. These sections are read once at start:

`server`, `memory`, `obsidian`, `wiki`, `mcp`, `claudeCli`, `codexCli`,
`stt`, `tts`, `sentinel`, `updateCheck`, `tmux`, `web`, `mobile`

Everything else, such as `providers`, `compaction`, `agentLoop` or
`fallback`, applies with the reload.

### A broken config file

somora also picks up an edited `config.yaml` by itself on the next
turn. When the edited file has a mistake, somora keeps running on the
last valid version. No turn fails because of it. Your edit is simply
not in effect until the file is fixed.

| Where | What you see |
|---|---|
| Web client | The gear in the taskbar turns red, and its menu lists the problems. |
| Mobile app | A red banner at the top. |
| TUI | One error line with the problems. |
| Agent | One note in its next turn, so the agent that made the edit can fix it. |
| Agent writing the file | `file_write` and `file_patch` report the problems in their result as `config_invalid`. |
| Server log | `config.invalid_kept_last_good`, and `config.valid_again` once it is fixed. |

Check a file before you rely on it:

```bash
somora config check                  # ~/.somora/config.yaml
somora config check ./draft.yaml     # any file
```

The exit code is 0 for a valid file, 1 for an invalid one and 2 when
the file cannot be read. The check is the same the server runs.

> **Note:** At server start there is no last valid version yet. A
> broken file then stops the start, with the problems printed.

### Restart

| Where | How |
|---|---|
| Shell | `somora server restart` |
| Web client | Gear menu in the taskbar, then "Restart somora". Available when somora runs as a background service. |
| TUI | `/restart YES` |
| API | `POST /server/restart` |

The API route answers `409` when somora runs in the foreground: nothing
would bring it back.

### A restart asked for by an agent

An agent that needs a restart, after a config change or for an update,
runs `somora server restart` or `somora update` in its shell. From
there the restart does not cut the agent off:

1. The server notes the request and waits until the agent's turn has
   ended, ten minutes at most.
2. Turns running in other sessions get 30 more seconds to finish.
3. The service restarts.
4. The agent is woken in the same session and told the old and the new
   version, so it can check the result and carry on.

A turn that was cut because the agent restarted the service directly,
for example with `systemctl`, is woken as well and told not to repeat
the command. Turns of other sessions that the restart cut are marked as
interrupted. Whoever waited for them is told.

| `server.resumeAfterRestart` | Who is woken after a restart |
|---|---|
| `requested` (default) | The session that asked for the restart, or caused it from its own turn. |
| `all` | Also every other turn the restart cut, unless another agent waits for it. |
| `off` | Nobody. Cut turns are only marked. |

A session is woken at most twice in ten minutes, so an agent cannot
restart in a loop.

## Optional features

Each of these is off until you configure it and has its own page.

| Feature | Minimal config | Page |
|---|---|---|
| Web search | `web.brave.apiKey`, or `somora setup search` | [Tools](tools.md) |
| Dictation and spoken replies | `stt` and `tts` blocks naming a provider and a model | [Voice](voice.md) |
| Talking to an agent in a call | `realtimeVoice.enabled: true` with a provider and a key file | [Realtime voice](realtime-voice.md) |
| Shared wiki, Deep and Lucid | `obsidian.vault` and `wiki.enabled: true`, or `somora setup memory` | [Wiki](wiki.md), [Dream phases](dream-phases.md) |
| Team chart in every prompt | `~/.somora/team.yaml`, or `somora team init --principal "<your name>"` | [Team](team.md) |
| Image and video generation | `imageGen.enabled`, `videoGen.enabled`, each with `models` | [Image generation](imagegen.md), [Video generation](videogen.md) |
| Shared browser | `browser.enabled: true` and Chromium or Chrome on the host | [Browser](browser.md) |
| External MCP servers | `mcp.servers` | [MCP](mcp.md) |
| Projects | `projects.enabled: true` with a list of `entities` | [Projects](projects.md) |
| Scheduled triggers | none, the agents create them | [Sentinel](sentinel.md) |
| Remote machines over SSH | `resources` | [Resources](resources.md) |
| Language servers for builders | `somora lsp install` | [Language servers](lsp.md) |
| Phone app | HTTPS, then open `/mobile/` on the phone | [Mobile app](mobile.md) |

Spoken replies in a smaller audio format need `ffmpeg` on the host.

## Isolated Claude config dir

somora runs Claude Code with its own config folder,
`~/.somora/claude-home/`, not your `~/.claude/`. Your own Claude Code
sessions, plugins and settings never reach an agent, and an update of
your Claude Code cannot break somora's state. The folder is created at
the first server start.

Only the login is shared. somora keeps the credentials file in both
folders identical, so one `claude auth login` covers both:

- A change on either side is copied to the other within seconds while
  the server runs. A check every 60 seconds, at server start and before
  every Claude turn catches the rest.
- When the two differ, the side whose login expires later wins. The
  replaced file is kept once as `.credentials.json.somora-prev`.
- When a turn still fails on the login, somora syncs again and tells
  you whether sending the message again is enough or a new login is
  needed.

```bash
somora auth status   # both stores: age, expiry, in sync or diverged
somora auth sync     # reconcile now
```

`GET /health` reports the same state under `claudeAuth`, without any
token.

| You want | Do this |
|---|---|
| A separate Claude account for somora | Set `claudeCli.sharedUserCredentials: false`, then run `CLAUDE_CONFIG_DIR=~/.somora/claude-home claude auth login`. somora then touches neither file. |
| Another config folder | Set `CLAUDE_CONFIG_DIR` in `~/.somora/somora.env` or in the service's environment. |
| No login yet | Run `claude auth login` in any terminal. The running server picks it up, no restart needed. |

A `claude` or `codex` that an agent starts in a terminal or shell sees
your normal login, not somora's folder. The tmux guide explains
`inherit_agent_env`, which changes that.

## Engine rows in the chat

Engines report things that are neither text nor a tool call. Codex, for
example, keeps a plan and reports it as an item of type `todo_list`
whenever a task is added or done. somora stores each such report in the
session as an `engine_meta` record.

| Where | What you see |
|---|---|
| Web client and TUI | A dimmer row such as `◌ codex · plan`, shown when tool rows are shown. Expand it for the task list. |
| Phone app | Nothing. |
| Session export as Markdown | Plans appear as task lists. |
| REM | Reads them with the rest of the session. |

Other engines use the same record: a forced compaction, a dropped
sampling key or an adjusted reasoning effort on `openai-compatible`, an
attachment `grok-cli` could not pass on, a restarted session on a CLI
engine. An item type somora has no label for is shown under its raw
name. There is nothing to configure.

## Settings

Server settings live in `~/.somora/config.yaml`. The values shown are
the defaults. `server.tls` has no default.

```yaml
server:
  host: 127.0.0.1
  port: 18737
  resumeAfterRestart: requested
  # tls:
  #   cert: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.crt
  #   key: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.key
  #   publicHost: <your-host>.<your-tailnet>.ts.net
  #   renew: tailscale

updateCheck:
  enabled: true
  endpoint: https://somora.ai/api/latest-version

fallback:
  retryUnavailableMinutes: 60

agentLoop:
  maxRounds: 8
  maxToolCallsPerTurn: 30
  # maxTurnMs: 3600000
  toolCallTimeoutMs: 30000
  longTaskDefaultTimeoutMs: 300000
  longTaskMaxTimeoutMs: 1800000
  wakeGraceMs: 3000
  execMaxConcurrentPerAgent: 8
  execMaxConcurrentGlobal: 32
  toolUsageReminder: true

engineWatchdog:
  claudeCliIdleMs: 300000
  codexCliIdleMs: 300000
  grokCliIdleMs: 300000
  openaiCompatibleIdleMs: 1200000

sse:
  publishTimeoutMs: 10000
  publishParallel: true
  heartbeatMs: 20000
  deadAfterMs: 60000
  h2PingIntervalMs: 30000
  h2PingTimeoutMs: 30000
  keepAliveDelayMs: 30000

claudeCli:
  mcpToolTimeoutMs: 1800000
  mcpConnectTimeoutMs: 60000
  sharedUserCredentials: true

codexCli:
  toolTimeoutSec: 1800
  shellEnvironmentPolicy: inherit-all
  # directTools: [...]
```

### Server and updates

| Setting | Default | Meaning |
|---|---|---|
| `server.host` | `127.0.0.1` | Address the server listens on. `0.0.0.0` accepts other devices. Set it here, not as `SOMORA_HOST` in the service. |
| `server.port` | `18737` | Port. |
| `server.resumeAfterRestart` | `requested` | Who is woken after a restart: `requested`, `all` or `off`. |
| `server.tls.cert` | none | Certificate file in PEM format. With `key` it switches the server to HTTPS and HTTP/2. `~` is your home folder. |
| `server.tls.key` | none | Private key file in PEM format. |
| `server.tls.publicHost` | none | Host name clients use. Must match the certificate. |
| `server.tls.renew` | none | `tailscale`: renew the certificate automatically. |
| `updateCheck.enabled` | `true` | The daily update check. |
| `updateCheck.endpoint` | `https://somora.ai/api/latest-version` | Where the check asks. |
| `fallback.retryUnavailableMinutes` | `60` | A model that was unreachable is skipped this long by chat, REM and compaction. A success, a config reload or `POST /models/availability/reset` clears the mark. 1 to 1440. |

### The tool loop

`maxRounds`, `maxToolCallsPerTurn` and `maxTurnMs` apply to the
`openai-compatible` engine. The CLI engines run their own loop.

| Setting | Default | Meaning |
|---|---|---|
| `agentLoop.maxRounds` | `8` | Most rounds of tool calls per turn. Then the model must answer. |
| `agentLoop.maxToolCallsPerTurn` | `30` | Most tool calls per turn in total. Stops a model that repeats one call without end. |
| `agentLoop.maxTurnMs` | unset | Time limit of one turn. Unset means none. |
| `agentLoop.toolCallTimeoutMs` | `30000` | Time limit of a fast tool call: memory, web, files, time. |
| `agentLoop.longTaskDefaultTimeoutMs` | `300000` | How long `agent_ask` and `subagent_result` wait when the caller gives no `timeout_ms`. |
| `agentLoop.longTaskMaxTimeoutMs` | `1800000` | Longest such wait. After it the tool answers `pending` and the work keeps running. Keep `claudeCli.mcpToolTimeoutMs` and `codexCli.toolTimeoutSec` at least this high. |
| `agentLoop.wakeGraceMs` | `3000` | When work an agent started and left finishes, the agent is woken unless it fetched the result within this time. 0 to 60000. |
| `agentLoop.execMaxConcurrentPerAgent` | `8` | Background shell jobs one agent may hold. |
| `agentLoop.execMaxConcurrentGlobal` | `32` | The same across all agents. |
| `agentLoop.toolUsageReminder` | `true` | Adds a short "call tools, do not describe them" block to the prompt of an agent that has tools. Helps smaller local models. |

At 75 % of the round or call limit the model gets one notice to wrap
up. At the limit it is asked for a final answer without tools.

### Stuck engines and stuck clients

| Setting | Default | Meaning |
|---|---|---|
| `engineWatchdog.claudeCliIdleMs` | `300000` | A turn is ended with a clear error when the engine sends nothing for this long. |
| `engineWatchdog.codexCliIdleMs` | `300000` | The same for Codex. |
| `engineWatchdog.grokCliIdleMs` | `300000` | The same for Grok. |
| `engineWatchdog.openaiCompatibleIdleMs` | `1200000` | The same for your own servers. Raise it when your server is silent for longer inside a turn. |
| `sse.publishTimeoutMs` | `10000` | Time one event may take to reach one client. A client over it is dropped, so it cannot block a session. |
| `sse.publishParallel` | `true` | Send to all clients at once. `false` sends one after the other. |
| `sse.heartbeatMs` | `20000` | Heartbeat on every live stream. |
| `sse.deadAfterMs` | `60000` | A client whose heartbeat could not be written for this long is dropped. |
| `sse.h2PingIntervalMs` | `30000` | HTTP/2 ping per client. HTTPS only. |
| `sse.h2PingTimeoutMs` | `30000` | A client that does not answer the ping in time is dropped. |
| `sse.keepAliveDelayMs` | `30000` | TCP keepalive on every connection. |

While a tool call runs, the watchdog waits as long as the engine's tool
timeout instead, so a long `agent_ask` is not cut. Deep and Lucid are
not watched: they run outside the chat.

### Claude and Codex engines

| Setting | Default | Meaning |
|---|---|---|
| `claudeCli.mcpToolTimeoutMs` | `1800000` | Longest tool call on the Claude engine. Passed on as `MCP_TOOL_TIMEOUT`. |
| `claudeCli.mcpConnectTimeoutMs` | `60000` | Time the Claude engine waits for somora's tools to connect. Passed on as `MCP_TIMEOUT`. |
| `claudeCli.sharedUserCredentials` | `true` | Keep the Claude login in sync with `~/.claude`. |
| `codexCli.toolTimeoutSec` | `1800` | Longest tool call on the Codex engine, in seconds. |
| `codexCli.shellEnvironmentPolicy` | `inherit-all` | What Codex's own shell inherits from the server's environment. `core-only` passes only the basics. |
| `codexCli.directTools` | the everyday core tools | somora tools kept in the Codex model's direct list on every turn. The rest is found through tool search. |

### Sections with their own page

| Section | Page |
|---|---|
| `providers`, per model fields | [Models](models.md) |
| `compaction` | [Compaction](compaction.md) |
| `memory`, `obsidian` | [Memory](memory.md) |
| `rem`, `wiki` | [Dream phases](dream-phases.md), [Wiki](wiki.md) |
| `promptBudgets` | [Team](team.md), [Agents](agents.md) |
| `thinkingContent` | [Thinking](thinking.md) |
| `tui` | [TUI display](display.md) |
| `mobile` | [Mobile app](mobile.md) |
| `web.brave`, `vision` | [Tools](tools.md) |
| `workspace`, `attachments` | [Files](files.md) |
| `stt`, `tts` | [Voice](voice.md) |
| `realtimeVoice` | [Realtime voice](realtime-voice.md) |
| `imageGen`, `videoGen` | [Image generation](imagegen.md), [Video generation](videogen.md) |
| `browser` | [Browser](browser.md) |
| `mcp` | [MCP](mcp.md) |
| `projects` | [Projects](projects.md) |
| `sentinel` | [Sentinel](sentinel.md) |
| `resources` | [Resources](resources.md) |
| `skills` | [Skills](skills.md) |
| `lsp` | [Language servers](lsp.md) |
| `tmux` | [tmux](tmux.md) |

Per agent settings live in each agent's `agent.yaml` and are described
in the agents guide.

## Commands

| Command | What it does |
|---|---|
| `somora setup [step]` | The guided assistant. Steps: `models`, `search`, `agent`, `memory`, `team`, `access`, `start`. |
| `somora init` | Creates the data folder and writes the service definition. Safe to run again. |
| `somora server start [--foreground]` | Starts the server, as a service or in this terminal. |
| `somora server stop` | Stops the server. |
| `somora server restart` | Restarts the service. |
| `somora server status` | Shows the running server, a waiting update and the service state. |
| `somora tui` | Opens the terminal client against the running server. |
| `somora update [<version>] [--edge] [--force] [--no-reinit]` | Installs a version from npm, refreshes the service and restarts it. |
| `somora config check [file]` | Validates `config.yaml` (or another file) exactly as the server does. Exit code 0 valid, 1 invalid, 2 unreadable. |
| `somora config path` | Prints the path of the config file. |
| `somora telemetry show [--json]` | Shows what the daily update check sends and when it last ran. |
| `somora auth login` | Logs in with a Claude subscription, through the bundled Claude Code or your own. |
| `somora auth status` | Shows both Claude credential stores. |
| `somora auth sync` | Reconciles the two stores now. |
| `somora codex <args>` | Runs the bundled Codex: `login`, `logout`, `debug models`, `features list`, `--version`. |
| `somora skill list`, `check`, `add`, `update`, `remove` | Manages skills. Run `somora skill` for the details. |
| `somora team init [--principal <name>]` | Writes `team.yaml` from the agents on disk. Never overwrites. |
| `somora team check` | Validates `team.yaml`. |
| `somora team show <agent>` | Prints the team block that agent sees. |
| `somora lsp status` | Lists the language servers and which are installed. |
| `somora lsp install [id…]` | Installs language servers into `~/.somora/lsp`. |
| `somora wiki migrate [step] [id]` | Moves a grown wiki onto the folder template. Guided, or one of `plan`, `judge`, `status`, `approve`, `dry-run`, `run`, `undo`, `relink`. |
| `somora --version`, `-v` | Prints the version. |
| `somora --help`, `-h` | Prints the usage. `setup`, `update` and `codex` have their own `--help`. |

Useful routes for a quick check:

| Route | Answer |
|---|---|
| `GET /healthz` | `ok` |
| `GET /health` | State of the server, including `claudeAuth`. |
| `GET /version` | Running version and, once known, the latest one. |
| `GET /env` | The environment overrides in effect, each with an `isDefault` flag. Logged at start as `somora.env`. |
| `GET /config/status` | When the config was loaded, whether the file changed since, and the sections that need a restart. |

## Files and folders

Everything somora keeps lives under `~/.somora/`, or under
`SOMORA_HOME` when that is set.

| Path | What it is |
|---|---|
| `config.yaml` | The server config. |
| `somora.env` | Secrets for skills and tools, one `KEY=value` per line. Loaded into the server's environment at start. A variable that is already set wins. Keep it at `chmod 600`. |
| `team.yaml` | The team chart. |
| `agents/<name>/` | One folder per agent: `AGENTS.md`, `SOUL.md`, `USER.md`, `agent.yaml`, its memory and its sessions. |
| `index/shared.db` | The search index over vault and wiki. Derived. It is rebuilt when deleted. |
| `logs/server.YYYY-MM-DD.1.log` | The server log, one file per day. The log tile in the web client reads it without a shell. |
| `logs/launchd.log` | Output of the service on macOS. |
| `locks/server.lock` | Process, port and version of the running server. |
| `certs/` | TLS certificate and key. |
| `claude-home/`, `codex-home/` | somora's own config folders for Claude Code and Codex, with a copy of each login. |
| `dream-state/deep.json`, `lucid.json` | When Deep and Lucid last ran. |
| `update-check.json` | The last answer of the update check. |
| `restart-intent.json`, `restart-resume.json` | A restart an agent asked for, and who was woken after one. |
| `skills/`, `mcp/`, `lsp/`, `sentinel/`, `projects/`, `browser/` | Data of the feature of that name. |
| `attachments/`, `images/`, `media/`, `video-jobs/`, `tts-cache/` | Uploaded files, generated pictures, video and audio. |
| `models/` | The downloaded embedding model. |
| `audit/` | Logs of privileged shell commands and MCP calls. |
| `known_hosts.json` | Pinned host keys of SSH resources. |
| `wiki-lucid/`, `wiki-migration/` | State of Lucid reviews, and plans and backups of a wiki migration. |
| `tmux-*.json`, `tui-state.json` | State of the terminal watcher and of the TUI. |

Deep and Lucid plan their next run from the time of the last completed
one in `dream-state/`. To make the next run come sooner, set
`lastCompletedAt` in the file to an older time. To pause the schedule
without switching the phase off, set it to a time in the future.

Outside that folder:

| Path | What it is |
|---|---|
| `~/.config/systemd/user/somora.service` | The service on Linux. |
| `~/Library/LaunchAgents/ai.somora.server.plist` | The service on macOS. |
| `~/.local/share/somora/node` | Node.js, when the installer put it into your home folder. |
| `~/.npm-global` | npm's global folder, when the installer moved it. |
| `~/somoraworkspace` | The default working folder of the file tools. |

## Environment variables

Settings belong in `config.yaml`. These variables override it or cover
what the config cannot. Set them in `~/.somora/somora.env` or in the
service's environment.

| Variable | Default | Purpose |
|---|---|---|
| `SOMORA_HOME` | `~/.somora` | The data folder. |
| `SOMORA_PORT` | `server.port` | Overrides the port. |
| `SOMORA_HOST` | `server.host` | Overrides the listen address. Prefer the config. With HTTPS on, the server sets it to `server.tls.publicHost` for its own child processes. |
| `SOMORA_TLS` | unset | Set to `1` by the server when it serves HTTPS, for its child processes. Do not set it yourself. |
| `SOMORA_LOG_LEVEL` | `info` | Log level. |
| `SOMORA_ENV_FILE` | `~/.somora/somora.env` | Another env file to load at start. |
| `DO_NOT_TRACK` | unset | `1` turns the daily update check off. A set `CI` does the same. |
| `SOMORA_CLAUDE_BIN` | `~/.local/bin/claude`, else the bundled one | Path of the Claude Code binary. |
| `CLAUDE_CONFIG_DIR` | `~/.somora/claude-home` | Config folder of the Claude engine. |
| `SOMORA_CODEX_BIN` | unset | Uses another Codex binary instead of the bundled one. For debugging. |
| `SOMORA_GROK_BIN` | unset | Uses another Grok binary instead of the bundled one. Read on every turn. Without a bundled build for the platform, `~/.local/bin/grok` and then `grok` on `PATH` are used. |
| `SOMORA_COMPACTION_TRIGGER_RATIO` | from config | Overrides `compaction.triggerRatio`. |
| `SOMORA_COMPACTION_SAFETY_PAIRS` | from config | Overrides `compaction.safetyCushionPairs`. |
| `SOMORA_COMPACTION_MODEL` | from config | Overrides `compaction.modelOverride`. |
| `SOMORA_COMPACTION_WORKERS` | from config | Overrides `compaction.workers`, comma separated. |
| `MCP_TOOL_TIMEOUT`, `MCP_TIMEOUT` | from config | Override `claudeCli.mcpToolTimeoutMs` and `claudeCli.mcpConnectTimeoutMs`. |
| `SOMORA_CODEX_TOOL_TIMEOUT_SEC` | from config | Overrides `codexCli.toolTimeoutSec`. |
| `SOMORA_CODEX_SHELL_ENV_POLICY` | from config | Overrides `codexCli.shellEnvironmentPolicy`. |
| `SOMORA_MAX_SUBAGENT_DEPTH` | `3` | How deep sub-agents may start sub-agents. |
| `SOMORA_URL` | from config | Server address for `somora wiki migrate`. |
| `ONNXRUNTIME_NODE_INSTALL` | unset | `skip` during `npm install` leaves out the unused CUDA library. |

Inside an agent's shell, somora sets `SOMORA_AGENT` and
`SOMORA_SESSION`. That is how `somora server restart` knows it was
called from a turn.

## Troubleshooting

**`somora: command not found` after the install.** Open a new terminal,
or run `source ~/.profile`. The installer added npm's folder to your
`PATH`.

**A command says Node.js is too old.** Install Node 22.22 or newer, or
run the installer again. `somora update` checks this before it installs
anything.

**A command says the Linux is too old (glibc).** This somora needs glibc
2.34 or newer. The message names the last version that still runs on
your system: install that one with `npm install -g somora@<version>`,
then `somora server restart`. `somora update` checks this before it
installs anything; versions up to 2026.1007.2 did not, so an update
from one of those can land on a release your Linux cannot run.

**`npm install -g` fails with `EACCES`.** npm's global folder belongs
to root. Run the installer again, or move the folder as shown under
"Install by hand".

**The service does not start on Linux.** Look at
`journalctl --user -u somora -n 50`. Status `203/EXEC` means the unit
cannot find `node`. Run `somora init` again from a shell where `node`
works. It writes the right `PATH` into the unit.

**somora stops when you log out, or is not there after a reboot.** On
Linux lingering is off: `sudo loginctl enable-linger $USER`. On macOS
nobody has logged in yet: turn on automatic login.

**The assistant says somora does not answer.** Read the log:
`journalctl --user -u somora -n 50` on Linux,
`tail -n 50 ~/.somora/logs/launchd.log` on macOS. A `config.yaml` the
server cannot load is the usual cause.

**An update shows no effect.** The service may point at another copy of
somora, for example a source checkout. Check and repair:

```bash
systemctl --user cat somora.service | grep ExecStart
# good: …/lib/node_modules/somora/bin/somora.mjs server start --foreground
"$(npm root -g)"/somora/bin/somora.mjs init
systemctl --user daemon-reload
systemctl --user restart somora.service
curl -ks https://<your-host>:18737/version
```

Then reload the browser with Ctrl+Shift+R.

**Other devices cannot connect.** `server.host` is still `127.0.0.1`.
Set it to `0.0.0.0` in `config.yaml` and restart.

**New chat windows do not send, agents seem dead.** The web client runs
over plain HTTP and hit the browser's limit of six connections. Set up
HTTPS.

**The browser warns about the certificate.** The address does not match
`server.tls.publicHost`, or the certificate ran out. The server log
shows `server.tls.expires_soon` from 14 days before the end,
`server.tls.renew_failed` with the reason when a renewal did not work,
and `server.tls.reloaded` when a new certificate was loaded. A failed
renewal is most often the missing `sudo tailscale set --operator=$USER`.

**A Claude turn fails with `OAuth session expired and could not be
refreshed`.** Run `somora auth status`.
When the stores diverged, `somora auth sync`. When both are expired,
`claude auth login`.

**The test message was answered by the backup model.** The first model
did not respond. Check its login with `somora setup models`.

**All agents seem dead after one client hung.** The log shows
`sse.publish_evict_dead` when a stuck client was dropped. Nothing to
do. A turn that ends with an idle error was stopped by
`engineWatchdog`.

## Develop from a checkout

To work on somora itself:

```bash
git clone https://github.com/thenaxon/somora_agent.git somora
cd somora
npm install
npm run dev:server             # terminal A: the server, restarts on changes
npm run dev:cli                # terminal B: the TUI against it
```

The dev server uses the same `~/.somora/` as an installed somora. To
keep them apart, point it at a scratch folder:

```bash
SOMORA_HOME=/tmp/somora-dev npm run dev:server
```

| Command | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` for the server. |
| `npm test` | Every `*.test.mts` under `src/`, `web/src` and `web-mobile/src`, each against a throwaway `SOMORA_HOME`. |
| `npm test src/browser` | One subtree, with the same isolation. |
| `npm run verify:fast` | Typecheck plus the tests. |
| `npm run build:all` | Builds both web apps (`build:web`, `build:mobile`). `npm pack` runs it first. |
| `cd web && npm run dev` | Vite dev server for the web client. It proxies the API to port 18737. |
| `cd web && npm run build` | Rebuilds `web/dist/`, which the server serves at `/web/`. |

Run tests through `npm test`, not with `tsx --test`. The logger opens
its file as soon as it is imported, so a test started without its own
`SOMORA_HOME` writes into the log of the running install. The launcher
sets a temporary home first and removes it afterwards.
`SOMORA_TEST_HOME=/some/dir` keeps it for reading.

`somora init` from a checkout points the service at the checkout and
warns about it. That is what you want while developing, and the reason
for the "update shows no effect" entry above.

## See also

- [Models](models.md): a tested block per model family, all model fields
- [Agents](agents.md): creating agents, `agent.yaml`, personas
- [Security](security.md): who can reach the server, what an agent may
  do, the update check in detail
- [Web client](web.md): the desktop, the gear menu, the log tile
- [Mobile app](mobile.md): installing the phone app
- [TUI display](display.md): the terminal client
- [Memory](memory.md) and [Dream phases](dream-phases.md): notes, REM,
  Deep and Lucid
- [Voice](voice.md): dictation and spoken replies
- [Compaction](compaction.md): `contextWindow` and the compaction
  settings
- [API](api.md): every route, including
  [a restart requested from inside a turn](api.md#a-restart-requested-from-inside-a-turn)
