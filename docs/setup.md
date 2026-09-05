# Setup

> End-to-end install for somora as a long-running service on your
> machine. The flow below is what a normal user follows: prereqs →
> install via npm → systemd user service → chat. A short dev-from-
> checkout section sits at the bottom for contributors.

## 1. System prereqs

Hard requirements:

| Tool | Why | Install |
|---|---|---|
| **Node ≥22.13** | runtime + native `node:sqlite`; every `somora` command refuses to start on an older Node and prints the upgrade steps, `somora update` checks the target release before building | [nodejs.org](https://nodejs.org/) or `nvm install 22` |
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

**ChatGPT** — the Codex engine uses your ChatGPT subscription. Codex is
bundled with somora (no separate install):

```bash
somora codex login   # ChatGPT Plus/Pro/Business; an existing `codex login` is picked up too
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

somora is installed **from source** — there is no npm registry release.
Clone the repo, pack a tarball, install the tarball globally:

```bash
git clone https://github.com/thenaxon/somora_agent.git somora
cd somora
npm install -g "$(npm pack | tail -1)"
# apply the package overrides inside the installed copy (npm honours
# `overrides` only for a root project, not for a globally installed one)
(cd "$(npm root -g)/somora" && npm install --omit=dev --no-audit --no-fund)
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
# or, for a config.yaml edit that touches models, providers, caps, tools:
# the gear menu in the web taskbar → Reload config, or /reload in the TUI
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
      - id: claude-opus-5
        alias: opus
        contextWindow: 1000000
        capabilities: [text, image, pdf, reasoning]
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
      - id: gpt-5.6-terra
        alias: terra
        contextWindow: 272000        # Codex session cap, not the 1.05M API window
        capabilities: [text, image, pdf, reasoning]
```

`contextWindow: 272000` is deliberate: Codex caps a GPT-5.6 session at
272k tokens (server-delivered default since Codex 0.144.6), and on a
CLI engine the value does not trigger somora's compaction anyway — it
only decides whether the model is picked as a compaction worker and
what the header percentage claims. See
[compaction.md](compaction.md#what-contextwindow-really-controls--per-engine)
and [models.md](models.md).

<a id="codex"></a>
Codex is **bundled** — `@openai/codex` is an exact-version dependency of
somora and runs as an app-server per turn; a global `codex` on the host
is ignored (`SOMORA_CODEX_BIN` remains as a debugging override). Auth:
`somora codex login` (ChatGPT Plus/Pro/Business). somora keeps its own
Codex home at `~/.somora/codex-home` and mirrors `auth.json` from
`~/.codex` on every turn, so a login done with a global Codex CLI works
as well. `somora codex debug models` shows the model catalog the bundled
version sees.

somora's tools reach Codex as dynamic tools. `codexCli.directTools`
(config.yaml) names the tools kept in the model's direct tool list every
turn; everything else is deferred and found via Codex tool search (or
`ALL_TOOLS` inside Code Mode on the GPT-5.6/GPT-6 models). The default
is the everyday core: memory_*, file_*, exec, tmux, web_*, time_now,
agent_ask, spawn_subagent, subagent_result, somora_docs_*.

### xAI via Grok Build CLI subscription (no API key)

```yaml
providers:
  xai:
    engine: grok-cli
    models:
      - id: grok-4.5
        alias: grok
        contextWindow: 500000
        capabilities: [text, reasoning]
```

Requires the Grok Build CLI (`grok`) on PATH — installed via
`curl -fsSL https://x.ai/cli/install.sh | bash`, which drops the binary
at `~/.local/bin/grok`. Override with `SOMORA_GROK_BIN` if it lives
elsewhere.

Auth is handled by the binary: run `grok login` once, which writes a
session to `~/.grok/auth.json`. somora's adapter connects over ACP
(Agent Client Protocol — JSON-RPC on stdio, `grok agent stdio`) and the
handshake picks up that session as the `cached_token` auth method
automatically. **A SuperGrok / Premium subscription authenticates the
CLI, not the xAI API** — so this path uses your subscription, while
pointing an `openai-compatible` provider at `https://api.x.ai/v1`
would bill a separate pay-per-token API account instead.

`grok-4.5` reports three reasoning efforts (low / medium / high,
default high), so somora's `/thinking` knob maps straight through. Give
the model the `reasoning` capability to activate it. Note there's no
"disabled" state — `/thinking off` maps to `low`.

**Tools.** somora's full MCP surface (memory, file_*, exec, wiki,
subagents — 47 tools as of 2026-08) is handed to the ACP session via
`session/new`'s `mcpServers` parameter, scoped to the current
agent+session exactly like claude-cli and codex-cli. On top of that
Grok Build brings its own file/shell tools, scoped to the working
directory (`$HOME`).

Grok reaches MCP tools through a `search_tool` / `use_tool`
indirection rather than listing all of them up front, which keeps a
large surface cheap context-wise. The adapter unwraps that: a
`use_tool{tool_name:'somora__memory_list'}` call is recorded as
`mcp__somora__memory_list`, so session logs and tool rows match
what the other engines emit. The `search_tool` probes themselves
surface as-is.

Budget note: the tool catalogue is not free. A trivial two-tool turn
measured ~76k input tokens on a fresh session, ~108k on the follow-up,
with most of it served from cache (`tokens_in_cached`). Against
grok-4.5's 500k window that's comfortable, and on a subscription it
costs nothing extra — but it's worth knowing before pointing an
API-billed provider at the same setup.

Sessions resume across turns via `session/load` against the
`grokSessionId` stashed in session-meta.

**Attachments.** Grok Build exposes no attachment channel over ACP —
the handshake reports `promptCapabilities.image: false`. Images and
PDFs therefore never reach the engine: the capability gate in
`run-turn.ts` refuses them first, since `grok-4.5` declares neither
`image` nor `pdf`, and the user gets "does not support image inputs"
before a process is spawned. Text attachments pass the gate and are
inlined into the prompt, the same way codex-cli handles its non-image
attachments. Anything else that somehow arrives is named to the model
as undeliverable and recorded as an `engine_meta` item of type
`attachments_unsupported` — never dropped silently.

**API failures surface as errors.** xAI reports a spent balance or a
blocked subscription on the proprietary `_x.ai/*` channel — a
`retry_state{type:'failed'}` frame plus `turn_completed` with
`stop_reason: 'error'` — not through the ACP error channel. The
adapter reads both and emits a somora `error` event carrying the
message (e.g. *"API error (status 402 Payment Required): Grok Build
usage balance exhausted"*), so a configured `fallback:` model takes
over. Replayed frames from `session/load` are ignored via
`_meta.isReplay`, so a failure from an earlier turn cannot abort a
resumed one.

### Local OpenAI-compatible LLM (Ollama, LM Studio, vLLM, oMLX, ...)

For this engine `contextWindow` is the compaction wall — set it to the
**server's** limit (`--max-model-len`, `--context-length`), not the
model card's. Recommended blocks per model family, with sampling and
reasoning vocabularies, are in [models.md](models.md).

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

#### Reliability with smaller / local models

Smaller models (deepseek, kimi, and many local ones) drive the
OpenAI-compatible tool loop less reliably than the big hosted models.
Two well-documented failure modes show up: they re-issue the **same tool
call over and over** without registering the result, and they sometimes
**echo the provider's internal tool-result template** ("Use the results
below to formulate an answer…") as their reply instead of answering.
somora hardens this path so a weaker model degrades gracefully instead of
flooding you:

- **Duplicate tool calls in one round are collapsed** to a single
  execution — the model still gets a result for every *distinct* call.
- **A per-turn tool-call budget** (`agentLoop.maxToolCallsPerTurn`,
  default 30) stops a runaway that the round cap can't see, and forces a
  clean final answer.
- **Output guards** detect a leaked template or a repeated-text loop in
  the stream, cut it before it floods the window, and force one clean
  no-tools answer.

None of this touches the `claude-cli` / `codex-cli` engines — they run
their own loop. It also stays out of the way of capable models, which
never trip these guards.

```yaml
providers:
  local:
    engine: openai-compatible
    models:
      - id: some-strong-local-model
        alias: big
        contextWindow: 131072
        capabilities: [text]
        # Opt a trusted model back into parallel tool calls. Default is
        # sequential (one call per round) because weak models fan out
        # into large duplicate batches; a strong model doing independent
        # reads can safely parallelise.
        parallelToolCalls: true
      - id: some-local-reasoning-model
        alias: thinker
        contextWindow: 262144
        capabilities: [text, reasoning]
        # Output cap sent as `max_tokens`. Unset = not sent, and vLLM then
        # allows the whole remaining context — on a reasoning model, where
        # thinking and answer share that budget, nothing else stops a
        # runaway thinking phase. (Not the memory block's
        # `memory.autoInject.maxTokens`, which caps injected input.)
        maxTokens: 16384
        # Which words this model accepts for somora's thinking levels and
        # where they go in the request — see docs/thinking.md.
        reasoning:
          levels: { high: xhigh }
        # Vendor-recommended sampling for this model; agent.yaml and the
        # session override win per key — see docs/sampling.md.
        sampling:
          temperature: 1.0
          top_p: 0.95

agentLoop:
  maxToolCallsPerTurn: 30   # hard ceiling on tool calls per turn (openai-compatible)

thinkingContent:            # the model's reasoning text in the clients — docs/thinking.md
  capture: true             # false drops it at the server (no SSE, no JSONL)
  maxChars: 65536           # per-turn cap on what is persisted
```

## 7. Voice — STT + TTS (optional)

Voice is two independent toggles:

- **STT** (speech-to-text) — turns the mic button on for the web and
  mobile-PWA chat. Tap, talk, tap again → transcript drops into the
  draft.
- **TTS** (text-to-speech) — when you submit via mic and the per-chat
  auto-play toggle is on, somora generates spoken audio for the
  assistant reply and plays it. A Play-button on the bubble lets you
  replay.

Both proxy through OpenAI-compatible endpoints on a provider you've
already configured. See [voice.md](voice.md) for the full picture
including the `/voice/turn` audio-in/audio-out endpoint for
integrations.

### Speech-to-Text

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

### Text-to-Speech

Mirror config for spoken replies. Same posture — proxies through an
OpenAI-compatible TTS endpoint (`POST /v1/audio/speech`) on a provider
you already have.

```yaml
tts:
  enabled: true
  provider: omlx                              # ← references providers.omlx
  model: fish-audio-s2-pro-8bit               # whatever your upstream calls it
  language: de
  cache:
    retentionDays: 7                          # 0 disables GC
    maxSizeMB: 500
  reencode:
    enabled: true                             # needs ffmpeg on $PATH
    opusBitrateKbps: 24
  clients:
    web:
      autoPlayVoiceReplies: false             # initial toggle state for new sessions
      allowUserOverride: true
    mobile:
      autoPlayVoiceReplies: false
      allowUserOverride: true
```

Auto-TTS for the normal chat fires **only** when all four hold:
`tts.enabled` is true, the user submitted via mic (`input_modality=voice`),
the per-session 🔊 toggle is on, and the assistant text is speakable
(no heavy code blocks / large tables). Otherwise the chat stays
text-only. The `🔊`/`🔇` toggle in the chat header is sticky per
session (`localStorage`).

Two flows are wired:

- **Normal chat auto-TTS** — voice input → spoken reply on web + mobile.
- **`POST /voice/turn`** — independent audio-in/audio-out endpoint
  for panel/satellite/bridge integrations; always generates audio
  regardless of toggles. See [voice.md](voice.md#voiceturn-endpoint).

System dependency: `ffmpeg` on `$PATH` if you want `tts.reencode.enabled`
(opus/m4a output). Without ffmpeg, set `reencode.enabled: false` and
clients receive plain WAV (larger, but works).

## Tunables

These all live in `config.yaml` with conservative defaults; uncomment to
override. Full schema in [`src/config/types.ts`](../src/config/types.ts).

```yaml
compaction:
  triggerRatio: 0.8           # fraction of context window
  safetyCushionPairs: 4       # most-recent turns kept uncompacted
  # modelOverride: opus       # force a specific compaction worker model
  # The trigger works off somora's own token ESTIMATE. When the backend
  # nevertheless rejects a prompt as too long (400 "Prompt too long",
  # "maximum context length", oMLX's prefill memory guard — typical after
  # switching a long session from a 1M-window model to a 131k one), the
  # openai-compatible engine forces a compaction down to the last
  # exchange and retries the turn once; a second refusal surfaces as a
  # plain-language error (switch model or /reset) instead of the raw 400.
  # Compaction workers are picked from models whose engine has a one-shot
  # path (claude-cli, codex-cli, openai-compatible): the smallest
  # contextWindow that fits the range × 1.3 — which can be a
  # subscription-backed CLI model. Mechanics, and what contextWindow
  # means on each engine, in docs/compaction.md.

agentLoop:
  maxRounds: 8                # tool-call rounds per turn (openai-compatible)
  toolCallTimeoutMs: 30000    # per-tool-call timeout
  toolUsageReminder: true     # short "call tools, don't narrate" block in the
                              # system prompt whenever the agent has tools.
                              # Tools reach the model through a separate API
                              # field, never through prompt text; smaller local
                              # models benefit from being told so explicitly.
                              # Constant text — one cache invalidation on
                              # rollout, none afterwards.

# Per-engine idle-event watchdog. If an engine produces no events
# (assistant_delta, tool_call, …) for this duration mid-turn, the
# turn is aborted so the per-session lock releases and the user
# sees a clean error instead of all agents looking dead. Dream
# workers (Deep/Lucid) bypass this — they run on their own path.
#
# While a tool call is in flight the threshold is automatically
# relaxed to the MCP tool timeout (claudeCli.mcpToolTimeoutMs /
# codexCli.toolTimeoutSec, 30 min by default), so a legitimately
# long-blocking tool (agent_ask, subagent_result wait_until_done)
# isn't cut off by the much shorter idle window — a genuinely dead
# child is still caught at the tool-timeout horizon.
engineWatchdog:
  claudeCliIdleMs: 300000        # 5 min — subscription, fast first event
  codexCliIdleMs: 300000         # 5 min — subscription, fast first event
  openaiCompatibleIdleMs: 1200000 # 20 min — local LLMs can stream slowly;
                                  # raise if your backend regularly silences
                                  # for longer than 20 min mid-turn

# Per-subscriber write budget for SSE broadcasts. A healthy writeSSE
# finishes in microseconds; a wedged subscriber (mobile browser
# backgrounded, TCP receive window stuck at 0, dead-but-not-closed
# stream) can otherwise stall every following turn on that session
# until server restart. This is NOT a per-turn timeout — long-running
# tool calls and slow local LLMs are unaffected, because each
# individual event-write is still microseconds.
sse:
  publishTimeoutMs: 10000         # 10 sec per single event-write; evict the
                                  # subscriber on overrun and continue. Healthy
                                  # writes never hit this; 2 orders of magnitude
                                  # more than a normal write ever takes.
  publishParallel: true           # broadcast in parallel — one slow client
                                  # never blocks the others. Flip to false only
                                  # if you need strict serial delivery order.
  heartbeatMs: 20000              # comment-frame heartbeat on every stream;
                                  # clients treat > ~2 missed as a lost link.
  deadAfterMs: 60000              # a subscriber whose heartbeat write has not
                                  # completed for this long is dead: evicted
                                  # (`sse.publish_evict_dead` in the log), socket
                                  # destroyed. Catches vanished tabs / stuck
                                  # TCP windows that never send FIN.

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

# Projects (opt-in, off by default) — pointer-file manifests binding
# a chat session to a real-world thing (Obsidian notes, code dirs,
# URLs, remote-resource paths). When enabled, agents see six tools
# (entity_list, project_list, project_get, project_create,
# project_update, project_focus), the chat-header gets a project chip,
# and slash commands /projekt + /projects activate. See
# docs/projects.md for the full model.
#
# `entities` is a CURATED VOCABULARY — projects belong to one entity
# (e.g. "privat", "enovom"), and the agent must pick from this list
# at create time. Prevents STT mishearings from inventing phantom
# entities and gives you a free filter axis ("list all private
# projects"). Agents cannot extend this list via tools.
# projects:
#   enabled: true
#   entities:
#     - slug: privat
#       label: Privat
#     - slug: enovom
#       label: enovom GmbH
#     # add as many as you need — these are YOURS to curate
```

### Engine-meta — codex todo_list

`codex-cli` (GPT-5.x and codex models) tracks an internal
plan/checklist while it works. Codex emits `item.completed` events with
`itemType: "todo_list"` every time the model marks a task done or adds
a new one. somora persists these to the session JSONL as `engine_meta`
records — they're available to:

- The chat UI when **show.tools** is enabled (web + TUI). Renders as
  a dimmer block with a `◌ codex · plan` prefix to visually
  differentiate from real tool calls. Expand to see the task list with
  ✓ / → / ○ glyphs per status.
- The REM dream-worker, which scans session history to extract
  memories. Codex plans appear in that history, so the agent can
  retain "what was on my list yesterday" implicitly.
- The session export (`?format=markdown`), where plans render as
  GitHub-style task lists.

Mobile PWA hides engine_meta entirely (mobile is intentionally a
text-only minimalist surface). Other engines (claude-cli, openai-
compatible) don't currently emit engine_meta items; the mechanism is
ready when they do.

Friendly labels live in
[`src/engine/engine-meta-labels.ts`](../src/engine/engine-meta-labels.ts)
— a tiny `engine → itemType → label` map. Unknown itemTypes fall back
to the raw string so future codex/SDK additions appear immediately,
just with a less-pretty label. No configuration needed.

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
    maxCallsPerTurn: 3         # cap on wiki_* tool invocations during
                               # an active Lucid review-loop, per user
                               # turn. Forces per-page user confirmation
                               # for bigger plans. Raise (e.g. 5-10) if
                               # you regularly OK multi-page batches
                               # and the default 3 cuts off legitimate
                               # work. Resets on every user message.

  search:
    boostWiki: 1.4             # wiki hits rank above memory in retrieval
    boostMemory: 0.85
    boostVault: 0.65
    overviewMaxChars: 4000     # wiki-overview block in the system prompt;
                               # snapshotted once per session, so this is
                               # paid once inside the cached prefix
    overviewTopNSlugs: 30      # max sections listed when even the bare
                               # page list exceeds the budget
```

Per-agent REM (session→memory extraction) is configured in each
`agent.yaml`, not here — see [agents.md](agents.md).

**Scheduler state files** — Deep and Lucid persist their cadence
to `~/.somora/dream-state/{deep,lucid}.json` so server restarts
don't reset the timer. Each file holds the last started / completed /
failed timestamps; the worker reads these at boot and schedules the
next run at `lastCompletedAt + interval`, with a 60 s startup grace
when the run is already overdue. Fresh installs get an `lastCompletedAt
= now` anchor on first boot so restart-storms before the first auto-
fire don't starve out the schedule.

You normally never touch these files. If you want to **force the
next auto-Deep/Lucid to fire sooner** without manually triggering
it, edit `lastCompletedAt` to an older timestamp (or delete the
file — the bootstrap anchor is rewritten on the next start). If
you want to **pause auto-firing** without disabling the worker,
set `lastCompletedAt` to a future timestamp.

### Sentinel — proactive triggers (optional)

The trigger runtime that wakes agents on a schedule (see
[sentinel.md](sentinel.md)). One configuration knob:

```yaml
sentinel:
  completedRetentionDays: 7   # default; 0 disables auto-cleanup
```

`completedRetentionDays` controls how long one-shot `at`-triggers
stay in the registry after they've fired. The scheduler sweeps at
boot and on each daily re-arm tick; older `completed` entries get
auto-deleted along with their history file. Set to 0 to disable
auto-cleanup entirely (manual `sentinel delete` only). Recurring
triggers don't auto-GC — they end up in `paused` or `error` and you
choose when to remove them.

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
     host: 0.0.0.0        # REQUIRED for remote clients (default 127.0.0.1 = loopback only)
     port: 18737
     tls:
       cert: ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.crt
       key:  ~/.somora/certs/<your-host>.<your-tailnet>.ts.net.key
       publicHost: <your-host>.<your-tailnet>.ts.net
   ```

   `host: 0.0.0.0` is what makes the server reachable from other machines
   (LAN / Tailscale); the default `127.0.0.1` binds loopback-only. Keep
   this in `config.yaml` (not as a `SOMORA_HOST` env in the systemd unit) —
   config survives `somora update`, unit env does not (the update rebakes
   the unit from a template). If you *do* need custom systemd env, put it in
   a drop-in (`~/.config/systemd/user/somora.service.d/*.conf`) — drop-ins
   survive the rebake; `somora init` also now carries forward existing
   `Environment=`/`EnvironmentFile=` lines and prints what it preserved.

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

## Mobile PWA — `/mobile`

somora ships a second web client at `/mobile` aimed at phones. It's a
PWA — installable to your home screen on iOS / Android, runs in
standalone-app mode with no browser chrome. Minimal-scope by design:
chat only, no tmux / no file viewer / no multi-window layout. See
[mobile.md](mobile.md) for the full feature scope, install flow per
platform, and configuration knobs.

Installing:

1. On the phone, with Tailscale connected, visit
   `https://<your-host>.<your-tailnet>.ts.net:18737/mobile/` in Safari
   (iOS) or Chrome (Android).
2. **iOS:** share menu → "Add to Home Screen".
3. **Android:** Chrome's install banner, or menu → "Install app".

Build pipeline: `build:mobile` script alongside `build:web`, both run
by `build:all` and triggered by the `prepack` hook on `npm pack`. The
`somora update` flow picks this up automatically — no manual step. The
release tarball always contains both `web/dist` and `web-mobile/dist`.

## Isolated Claude config dir

somora-spawned claude-cli subprocesses run with their own config tree
under `~/.somora/claude-home/`, not the user's `~/.claude/`. On first
server start the dir is auto-created and the user's
`~/.claude/.credentials.json` is copied into it; a continuous sync
(see below) keeps both credential stores on the same OAuth session so
one `claude login` covers somora and the user's own Claude Code.

Everything else (project history, sessions, plugin marketplace state,
shell snapshots, MCP-needs-auth cache, …) lives separately. somora's
agents never see the user's interactive-CLI state, and vice versa.

**Why it matters**

- **Auto-update insulation.** Anthropic's launcher silently rolls
  forward the user's claude binary. If a release migrates the state
  schema, somora's spawn — which may run a different binary version —
  no longer reads the migrated tree cleanly. The 2026-05-16 incident
  (`2.1.143` regressed MCP tool registration for everything sharing
  state with it) exposed this; the isolated dir makes somora resilient
  against the next time it happens.
- **Privacy + predictability.** The user's project conversations,
  installed plugins, and per-project skill caches never leak into
  agent context.
- **Reproducible deploys.** A fresh somora install on a new machine
  starts from the same blank slate regardless of how the user's
  personal Claude Code is set up.

**Scope**

The isolation applies to the internal engine adapter that somora uses
to talk to Claude. Tools the agent invokes for the user — `tmux create`,
`exec`, the `process` family — strip somora-internal vars from the
spawned shell by default (`CLAUDE_CONFIG_DIR`, `SOMORA_CLAUDE_BIN`, the
other engine-binary overrides, `TSX_TSCONFIG_PATH`, `NODE_ENV`, and
Claude Code's MCP-child markers), so a `claude` or `codex` you start
inside a tmux pane sees your normal `~/.claude` login state, and a
project's own `tsx`/`next`/dotenv see the project's config rather than
somora's. The `inherit_agent_env: true` flag opts back into inheritance
when you specifically want it (see `docs/tmux.md`).

**Overriding**

Set `CLAUDE_CONFIG_DIR` in `~/.somora/somora.env` (or shell env) to
point at any directory you prefer — useful for shared multi-host
setups, or when you want somora to read a hand-curated config tree.
The auto-create + credential sync still runs on whichever path
you supply.

**If the user hasn't run `claude login`**

The credentials file at `~/.claude/.credentials.json` won't exist
yet, and the bootstrap logs a warning instead of failing. Run
`claude login` once interactively (any session) — the running
server's credential watcher picks it up within seconds, no restart
needed.

**Shared-login credential sync**

Sharing one login between two config trees has a structural enemy:
the claude CLI refreshes OAuth tokens with an atomic write (tmp file +
rename). An earlier somora design symlinked the somora-side file to
`~/.claude/.credentials.json`, but rename replaces the *symlink
itself* — after the first token refresh the link silently materializes
into a real file. From then on both trees rotate the same OAuth
session independently, and whichever side refreshes later invalidates
the other; the losing side eventually fails with `OAuth session
expired and could not be refreshed` (in practice: forced re-logins
almost daily).

somora therefore maintains the sharing as a *continuously reconciled
content sync* (default `claudeCli.sharedUserCredentials: true` in
`config.yaml`) instead of a symlink:

- **Filesystem watcher** on both parent directories plus a 60 s
  fallback poll — a token refresh (or fresh `claude login`) on either
  side propagates to the other within seconds, while the server runs.
- **Boot reconcile** covers drift that happened while the server was
  down.
- **Pre-turn reconcile** in the claude-cli engine guarantees every
  turn starts on the newest OAuth chain.
- **Auth-failure reconcile** — if a turn still fails auth, somora
  reconciles inline and tells you whether re-sending the message is
  enough or a fresh `claude login` is needed.

On divergence the side with the *later OAuth expiry* wins (its refresh
happened last, so its refresh-token chain is the live one) and is
copied over the other — atomic write, mode `0600`, previous content
kept once at `.credentials.json.somora-prev`. A corrupt/unparseable
file always loses to a healthy one.

Inspect or fix the state manually any time:

```
somora auth status   # both stores: mtime, OAuth expiry, in sync / diverged
somora auth sync     # one-shot reconcile (what the watcher does continuously)
```

`GET /health` also reports the sync state under `claudeAuth`
(existence, expiry, divergence — never token material).

**Running somora on a separate Claude account**

Set `claudeCli.sharedUserCredentials: false` in `config.yaml` — somora
then never touches either credentials file, and you manage
`~/.somora/claude-home/.credentials.json` yourself (e.g. via
`CLAUDE_CONFIG_DIR=~/.somora/claude-home claude login`).

## Environment overrides

| Var                              | Default                      | Purpose                                  |
| -------------------------------- | ---------------------------- | ---------------------------------------- |
| `SOMORA_HOME`                    | `~/.somora`                  | data root for config / agents / sessions |
| `SOMORA_PORT`                    | `config.yaml:server.port`    | server bind port (override)              |
| `SOMORA_HOST`                    | `config.yaml:server.host` (`127.0.0.1`) | server bind host override. Prefer `server.host` in config.yaml — it survives `somora update`; a `SOMORA_HOST` env in the systemd unit is dropped by the update rebake. Auto-set to `tls.publicHost` for MCP-child callers when TLS is on. |
| `SOMORA_TLS`                     | `0`                          | set to `1` by parent when serving HTTPS — MCP-child callers use it to switch to https:// |
| `SOMORA_LOG_LEVEL`               | `info`                       | Pino log level                           |
| `SOMORA_CLAUDE_BIN`              | `~/.local/bin/claude`        | Claude Code binary path                  |
| `CLAUDE_CONFIG_DIR`              | `~/.somora/claude-home`      | Isolated state dir for claude-cli subprocesses (auto-created on boot, see "Isolated Claude config dir") |
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
