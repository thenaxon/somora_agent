# Setup

> Covers dev-setup (running from a checkout) and first-run config. For
> a production install: `npm install -g .` followed by `somora server
> start` registers a systemd user service — see the README for the
> minimal end-to-end flow.

## Install (dev)

```bash
git clone https://github.com/<your-account>/somora_agent.git somora
cd somora
npm install
```

`npm install` builds two native modules: `better-sqlite3` (SQLite client) and
`@huggingface/transformers`'s ONNX runtime backend (for local embeddings).
Both ship prebuilt binaries for common platforms; if your build fails you'll
need a working C/C++ toolchain.

## First run

```bash
npm run dev:server   # terminal A — starts the HTTP+SSE server on 127.0.0.1:18737
npm run dev:cli      # terminal B — readline CLI client
```

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

## Configuring providers

Edit `~/.somora/config.yaml`. The shipped default has just one provider
(Anthropic via Claude Code subscription) and is enough to chat with Claude
Opus. Add more providers as needed.

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
agent setup (and tmux session attaches in Phase 1.5) hits that ceiling
fast — symptom: new chat tabs silently fail to send, agents seem
unresponsive.

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
       cert: ~/.somora/certs/naxon.tailf6ec51.ts.net.crt
       key:  ~/.somora/certs/naxon.tailf6ec51.ts.net.key
       publicHost: naxon.tailf6ec51.ts.net
   ```

   `publicHost` MUST match the cert subject — strict TLS verification is
   on. Internal MCP-child callers (subagent fallback in
   `src/tools/agents/spawn.ts`) read this hostname from env at server
   startup and use it for their own HTTPS callbacks; loopback bypasses
   are gone now that everything goes through one secure listener.
5. Restart somora. Connect with the full URL:
   `https://naxon.tailf6ec51.ts.net:18737/web/`. The `:port` part is
   required because somora doesn't run on 443.

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

## Production-style run

For a long-running deployment, point `SOMORA_HOME` at a persistent volume
and run the server under your favorite supervisor (systemd, launchd,
docker compose, etc.). The server is a regular Node process; nothing
unusual.

```bash
SOMORA_HOME=/var/somora npm run start:server
```

There's no built-in auth on the HTTP API — somora binds to `127.0.0.1` by
default and assumes you're its only user. If you need to expose it across
a network, put it behind a reverse proxy with proper auth.
