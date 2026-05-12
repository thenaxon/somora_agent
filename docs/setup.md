# Setup

> End-to-end install for somora as a long-running service on your
> machine. The flow below is what a normal user follows: prereqs →
> install via npm → systemd user service → chat. A short dev-from-
> checkout section sits at the bottom for contributors.

## 1. System prereqs

Hard requirements:

| Tool | Why | Install |
|---|---|---|
| **Node ≥20** | runtime + native `node:sqlite` | [nodejs.org](https://nodejs.org/) or `nvm install 22` |
| **tmux** | the `tmux` tool + the web tmux app | `sudo apt install tmux` (Debian/Ubuntu) · `brew install tmux` (macOS) · `sudo dnf install tmux` (Fedora) |
| **ripgrep** (`rg`) | needed by `file_search` | `sudo apt install ripgrep` · `brew install ripgrep` · `sudo dnf install ripgrep` |
| **git** | clone the repo | usually pre-installed; otherwise package-manage |

C/C++ toolchain — `npm install` builds two native modules
(`better-sqlite3` for SQLite, `@huggingface/transformers`'s ONNX runtime
for local embeddings). Both ship prebuilt binaries for the common
platforms; if your build falls through to source you'll need
`build-essential` / Xcode CLT / equivalent.

## 2. At least one LLM backend

Pick one or more. somora doesn't care which you use, but at least one
must be installed and authenticated before the first chat.

**Claude (recommended)** — Anthropic's Claude Code CLI uses your Claude
subscription, no API key needed:

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

**ChatGPT** — OpenAI's Codex CLI uses your ChatGPT subscription:

```bash
npm install -g @openai/codex
codex login        # ChatGPT Plus/Pro/Business
# or set OPENAI_API_KEY in env if you prefer pay-per-token
```

**Local models** — Ollama, LM Studio, vLLM, or oMLX. Install separately
per their docs and have a `/v1/chat/completions` endpoint reachable on
some `http://host:port`. somora talks to them via the `openai-compatible`
engine — see [§6 Configuring providers](#6-configuring-providers) for
the config block.

## 3. Optional but recommended

| Tool | Unlocks | Install |
|---|---|---|
| **Obsidian** | the wiki layer + read-only vault recall | [obsidian.md](https://obsidian.md/) |
| **Tailscale** | HTTPS for the web client (lifts the 6-connection browser limit, unlocks mic/screenshot APIs) | [tailscale.com](https://tailscale.com/) |

Without Obsidian: somora still works (memory inbox per agent, sessions,
all tools), you just lose the long-term shared wiki layer.

Without Tailscale: the web client falls back to plain HTTP/1.1 and is
single-window-only; the TUI is unaffected.

## 4. Install somora

```bash
git clone https://github.com/thenaxon/somora_agent.git somora
cd somora
npm install -g "$(npm pack | tail -1)"
```

`npm pack` fires the `prepack` lifecycle hook, which builds the web
bundle (`cd web && npm ci && npm run build`) and emits a tarball with
everything baked in. The `npm install -g <tarball>` step then does a
real global install — the bin lands on your `PATH`, runtime deps land
under `lib/node_modules/somora/`, and `web/dist` is shipped along.

A bare `npm install -g .` from the clone may *look* like it works on
some setups, but npm often treats a local-folder install as
`npm link` and just symlinks the global path back to your checkout —
no deps, no built web bundle, broken binary. Going via `npm pack` is
the reliable path. (Subsequent upgrades use `somora update`, which
does the same clone→pack→install under the hood — see [Updating
somora](#updating-somora) below.)

## 5. Start the server + chat

```bash
somora init            # creates ~/.somora/ + writes the systemd user-service unit
somora server start    # starts the unit (auto-starts on login)
somora tui             # opens the TUI against the running server
```

`somora init` is idempotent and one-time: it creates `~/.somora/`
(config + lockfile + logs land here) and writes the systemd unit at
`~/.config/systemd/user/somora.service` with `ExecStart` baked to your
freshly installed global binary. From then on, `somora server start`
just brings the unit up; the server runs in the background and
survives logout / reboot. To stop / restart / inspect:

```bash
somora server stop
somora server restart
somora server status
journalctl --user -u somora -f      # tail logs
```

If you don't want systemd (e.g. on macOS, in a container, or while
debugging):

```bash
somora server start --foreground    # blocks the terminal; Ctrl-C to stop
```

### Updating somora

```bash
somora update                # latest GitHub release (curated)
somora update --edge         # latest git tag (incl. interim versions)
somora update 2026.05.12.7   # specific version
```

`somora update` clones the target ref, builds the web bundle, installs
globally, re-runs `somora init` so the systemd unit's `ExecStart`
points at the freshly installed binary, then restarts the service.
Pass `--no-reinit` to skip the unit rebake if you've hand-edited
`somora.service`.

The default `--release` channel only installs versions that have been
explicitly published as **GitHub Releases** — the curated path for
external installers. `--edge` follows the latest git tag instead,
including interim status markers that don't get a release.

#### Recovering an upgrade that didn't take effect

The systemd unit's `ExecStart` is baked in by whichever copy of somora
ran `somora init`. If you initially ran `init` from a git checkout
(common for early adopters), the unit pins to that checkout path:

```
ExecStart=/home/<you>/somora/bin/somora.mjs server start --foreground
```

A subsequent `npm install -g <tarball>` then has no effect on the
running service — systemd keeps launching the checkout binary, which
serves its old `web/dist`. Symptom: new features missing in the web UI
even after install + restart.

To spot it:

```bash
systemctl --user cat somora.service | grep ExecStart
# good:  ExecStart=/home/<you>/.npm-global/lib/node_modules/somora/bin/somora.mjs ...
# bad:   ExecStart=/home/<you>/somora/bin/somora.mjs ...   (← checkout, not global)
```

`somora update` re-bakes the unit automatically. If you're stuck on a
pre-`2026.05.12.8` install that doesn't have it, run the manual fix
once:

```bash
"$(npm root -g)"/somora/bin/somora.mjs init
systemctl --user daemon-reload
systemctl --user restart somora.service
curl -ks https://<host>:18737/version
```

Hard-reload the browser (Ctrl+Shift+R / Cmd+Shift+R) after so it
doesn't serve a cached JS bundle from before the upgrade.

On first start somora creates `~/.somora/`:

```
~/.somora/
├── config.yaml                ← server config (created with sane defaults)
├── agents/
│   └── default/               ← seed agent created on first run; rename / customize
│       ├── AGENTS.md
│       ├── SOUL.md
│       ├── USER.md
│       └── agent.yaml
└── logs/
    └── server-YYYY-MM-DD.log
```

## 6. Configuring providers

Edit `~/.somora/config.yaml`. The shipped default has just one provider
(Anthropic via Claude Code subscription) and is enough to chat with
Claude. Add more providers as needed.

### Anthropic via Claude Code subscription (no API key)

```yaml
providers:
  anthropic:
    engine: claude-cli
    models:
      - id: claude-opus-4-7
        alias: opus
        contextWindow: 1000000
        capabilities: [text, image]
```

Requires the Claude Code CLI binary at `~/.local/bin/claude` (or set
`SOMORA_CLAUDE_BIN` env to its path). Auth is handled by the binary —
`claude login` once and somora rides on the resulting session.

### OpenAI via Codex CLI subscription (no API key)

```yaml
providers:
  openai:
    engine: codex-cli
    models:
      - id: gpt-5.5
        alias: gpt55
        contextWindow: 400000
        capabilities: [text, image]
```

Requires the Codex CLI binary on PATH (or `SOMORA_CODEX_BIN` env to its
path). Auth via `codex login` (ChatGPT Plus/Pro/Business preferred,
or `OPENAI_API_KEY` env).

### Local OpenAI-compatible LLM (Ollama, LM Studio, vLLM, oMLX, ...)

```yaml
providers:
  local:
    engine: openai-compatible
    baseUrl: http://localhost:11434/v1   # adjust to your local server
    apiKey: dummy                         # most local servers ignore this
    models:
      - id: llama3.3:70b
        alias: llama
        contextWindow: 131072
        capabilities: [text]
      - id: gemma-3-27b-it
        alias: gemma
        contextWindow: 131072
        capabilities: [text, image]
```

Multiple OpenAI-compatible providers can coexist — give each one a unique
name (`local`, `lmstudio`, `office`, …).

## 7. Speech-to-Text (optional)

When enabled, the web chat input grows a mic button next to send. Click
→ record, click again → transcribe → text lands in the textarea ready to
send. Audio is forwarded to an OpenAI-compatible STT endpoint
(`POST /v1/audio/transcriptions`) and the result lands locally — never
travels via a cloud API unless you configure one.

Supported upstreams: **oMLX** (mlx-audio, Apple Silicon — full audio API
including TTS), **faster-whisper-server**, **OpenAI Whisper API**, and
anything else exposing the OpenAI audio shape. Configure once, switch
backends by editing one block.

```yaml
stt:
  enabled: true
  provider: omlx                              # ← name of an entry in `providers`
  model: mlx-community/whisper-large-v3-turbo
  language: de                                # optional default hint (ISO 639-1)
```

`stt.provider` must reference an existing `openai-compatible` provider
in your `providers` block — the STT call reuses its `baseUrl` and
`apiKey`. The STT model is **not** listed in `providers.<x>.models`;
keeping it separate keeps it out of chat-model pickers, agent-config
validation, and `/v1/models`.

The web mic button **auto-hides** when:
- the server reports `stt.enabled: false` (or the block is omitted)
- the browser lacks `MediaRecorder` / `navigator.mediaDevices.getUserMedia`
- the page wasn't loaded over a secure context (HTTPS — required by the
  mic-permission API in most browsers; via Tailscale, that's already
  satisfied)

### Recommended model

`mlx-community/whisper-large-v3-turbo` is the practical sweet spot on
Apple Silicon: ~800M params, near-real-time on M-series chips,
multilingual incl. German, marginal quality difference vs. the full
large-v3. If oMLX flags the model as missing the HuggingFace
preprocessor/tokenizer files (MLX-converted repos sometimes ship
weights only), drop the upstream config JSONs in alongside the weights:

```bash
cd ~/.omlx/models/whisper-large-v3-turbo
for f in preprocessor_config.json tokenizer.json special_tokens_map.json \
         tokenizer_config.json generation_config.json; do
  curl -L -O "https://huggingface.co/openai/whisper-large-v3-turbo/resolve/main/$f"
done
```

## Tunables

These all live in `config.yaml` with conservative defaults; uncomment to
override. Full schema in [`src/config/types.ts`](../src/config/types.ts).

```yaml
compaction:
  triggerRatio: 0.8           # fraction of context window
  safetyCushionPairs: 4       # most-recent turns kept uncompacted
  # modelOverride: opus       # force a specific compaction worker model

agentLoop:
  maxRounds: 8                # tool-call rounds per turn (openai-compatible)
  toolCallTimeoutMs: 30000    # per-tool-call timeout

memory:
  embedding:
    provider: local           # 'local' uses @huggingface/transformers (ONNX)
    model: all-MiniLM-L6-v2   # alias or full HF repo path
  chunking:
    targetTokens: 400
    overlapTokens: 80
  autoInject:
    queryTurns: 3             # last-N turns used as the recall query
    maxResults: 5             # top-N hits injected per turn
    minScore: 0.35            # discard hits below this score (0..1)
    maxTokens: 1500           # hard cap on the injected memory block
  hybrid:
    vectorWeight: 0.7
    bm25Weight: 0.3
```

### Wiki + dream-system (optional but recommended)

The wiki layer enables long-term shared knowledge across all agents.
Requires an Obsidian vault. See [wiki.md](wiki.md) for the full
mental model.

```yaml
obsidian:
  vault: ~/Documents/Vault     # required for the wiki to work

wiki:
  enabled: true
  vaultSubfolder: somora       # → <vault>/somora/ becomes the wiki

  deep:                        # Memory→Wiki consolidation
    enabled: true
    intervalHours: 12
    model: opus                # via claude-cli, subscription

  lucid:                       # Wiki cleanup
    enabled: true
    intervalDays: 7
    model: opus
    requireApproval: true

  search:
    boostWiki: 1.4             # wiki hits rank above memory in retrieval
    boostMemory: 0.85
    boostVault: 0.65
    overviewMaxChars: 1500     # auto-inject wiki-overview block size cap
    overviewTopNSlugs: 30
```

Per-agent REM (session→memory extraction) is configured in each
`agent.yaml`, not here — see [agents.md](agents.md).

## HTTPS (Tailscale) — required for the web client at scale

The web client opens **one persistent SSE connection per chat window**.
Browsers cap HTTP/1.1 at 6 concurrent connections per origin, so a multi-
agent setup (plus tmux session attaches) hits that ceiling fast —
symptom: new chat tabs silently fail to send, agents seem unresponsive.

Solution: serve somora over **HTTP/2-over-TLS**. HTTP/2 multiplexes
every stream over a single TCP connection, lifting the limit entirely.
The same upgrade also unlocks secure-context-only browser APIs that the
roadmap depends on (mic / screenshare / clipboard write / push
notifications / service workers).

**somora's blessed path is Tailscale.** Tailscale issues
publicly-trusted Let's Encrypt certs for your tailnet's `*.ts.net`
hostnames, free, with a single command — Node + every browser accept
them with no warnings, no CA installs, and no manual cert pinning. If
you're not on Tailscale you'll need to wire up your own cert (mkcert
for LAN-only, or a real DNS-validated LE cert) — same config block,
different acquisition.

### Set up TLS via Tailscale

1. Install Tailscale on the somora host (`sudo tailscale up`).
2. In the [Tailscale admin DNS panel](https://login.tailscale.com/admin/dns),
   enable **MagicDNS** and **HTTPS Certificates** (one-time tailnet setting).
3. Generate certs into `~/.somora/certs/`:

   ```bash
   mkdir -p ~/.somora/certs
   cd ~/.somora/certs
   tailscale cert <your-host>.<your-tailnet>.ts.net
   ```

   `tailscale status` shows your hostname; the FQDN is
   `<host>.<tailnet>.ts.net`. The command writes
   `<fqdn>.crt` (cert) and `<fqdn>.key` (private key, mode 0600).
4. Reference them in `~/.somora/config.yaml`:

   ```yaml
   server:
     port: 18737
     tls:
       cert: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.crt
       key:  ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.key
       publicHost: <your-host>.<your-tailnet>.ts.net
   ```

   `publicHost` MUST match the cert subject — strict TLS verification is
   on. Internal MCP-child callers (subagent fallback in
   `src/tools/agents/spawn.ts`) read this hostname from env at server
   startup and use it for their own HTTPS callbacks; loopback bypasses
   are gone now that everything goes through one secure listener.
5. Restart somora. Connect with the full URL:
   `https://<your-host>.<your-tailnet>.ts.net:18737/web/`. The `:port`
   part is required because somora doesn't run on 443.

### Cert renewal

Tailscale certs are valid for ~90 days. Re-run
`tailscale cert <fqdn>` to refresh. somora doesn't auto-reload —
restart it after each renewal, or set up a systemd timer that
re-issues + sends `SIGHUP` (current build doesn't handle `SIGHUP`
yet, so the timer should `systemctl --user restart somora`).

### Without Tailscale

Drop in any cert + key — the config doesn't care about the issuer, only
that the file paths point at valid PEM. For local LAN dev,
[mkcert](https://github.com/FiloSottile/mkcert) is the cleanest
non-Tailscale option (`mkcert -install` once per device, then
`mkcert <host>.local 192.168.x.y`). Self-signed (without an installed
CA) will work but every browser will scream — only acceptable for
single-developer scratch use.

### Falling back to plain HTTP

Omit the `server.tls` block entirely. somora reverts to HTTP/1.1 plain.
You'll keep the 6-connection limit and lose secure-context features.
Fine for single-window dev, no good for multi-agent daily use.

## Environment overrides

| Var                              | Default                      | Purpose                                  |
| -------------------------------- | ---------------------------- | ---------------------------------------- |
| `SOMORA_HOME`                    | `~/.somora`                  | data root for config / agents / sessions |
| `SOMORA_PORT`                    | `config.yaml:server.port`    | server bind port (override)              |
| `SOMORA_HOST`                    | `127.0.0.1`                  | CLI connect host (auto-set to `tls.publicHost` when TLS is on) |
| `SOMORA_TLS`                     | `0`                          | set to `1` by parent when serving HTTPS — MCP-child callers use it to switch to https:// |
| `SOMORA_LOG_LEVEL`               | `info`                       | Pino log level                           |
| `SOMORA_CLAUDE_BIN`              | `~/.local/bin/claude`        | Claude Code binary path                  |
| `SOMORA_CODEX_BIN`               | `~/.npm-global/bin/codex`    | Codex CLI binary path                    |
| `SOMORA_COMPACTION_TRIGGER_RATIO`| from config                  | override compaction trigger              |
| `SOMORA_COMPACTION_SAFETY_PAIRS` | from config                  | override compaction cushion              |
| `SOMORA_COMPACTION_MODEL`        | from config                  | override compaction worker               |

The live values are queryable: `GET /env` returns the resolved set with
`isDefault` flags, and the same data is logged at server startup as
`somora.env`.

## Develop from a checkout (contributors)

If you want to hack on somora itself rather than just run it:

```bash
git clone https://github.com/thenaxon/somora_agent.git somora
cd somora
npm install                    # local install instead of -g
npm run dev:server             # terminal A — starts via tsx watch
npm run dev:cli                # terminal B — TUI against the dev server
```

The dev server reads/writes the same `~/.somora/` as the production
binary, so anything you configure (providers, agents, persona files)
shows up in both. To isolate, point `SOMORA_HOME` at a scratch dir:

```bash
SOMORA_HOME=/tmp/somora-dev npm run dev:server
```

Other useful scripts:

| Command | What |
|---|---|
| `npm run typecheck` | server-side `tsc --noEmit` |
| `cd web && npm run dev` | Vite dev server for the web client (proxies API to `:18737`) |
| `cd web && npm run build` | rebuild `web/dist/` (the bundle the production server serves at `/web/`) |

There's no built-in auth on the HTTP API — somora binds to `127.0.0.1`
by default and assumes you're its only user. To expose it across a
network, use Tailscale (see HTTPS section above) or put it behind a
reverse proxy with proper auth.
