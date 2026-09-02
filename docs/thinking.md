# Thinking / Reasoning Control

somora exposes a **single cross-engine knob** for controlling how much
the model thinks before responding. The knob is the same regardless of
which underlying engine (`claude-cli`, `codex-cli`, `openai-compatible`)
runs the turn — somora translates per engine.

## The user surface

For **chat turns**, three places to set it (later sources beat earlier ones):

1. **`agent.yaml` per persona** — global default for that agent

   ```yaml
   model: opus
   thinking: medium     # off | low | medium | high
   ```

2. **`/thinking <level>` slash command** — per-session override (works
   in TUI and Web)

   ```
   /thinking high           # crank it up for this session
   /thinking off            # disable thinking entirely
   /thinking default        # clear override, back to persona default
   /thinking                # show current state + source + dormant warning
   ```

3. **Engine default** — when nothing is set, each engine uses whatever
   the model's own default is (typically `medium` for adaptive thinking,
   `medium` for codex reasoning models)

For the **three dream-system phases** (REM, Deep, Lucid — background
memory consolidation, see [dream-phases.md](dream-phases.md)), the
worker LLMs have their own per-phase thinking knobs:

| Phase | Where | Field |
|---|---|---|
| REM | `agent.yaml` per persona | `rem.thinking` |
| Deep | `config.yaml` server-global | `wiki.deep.thinking` |
| Lucid | `config.yaml` server-global | `wiki.lucid.thinking` |

All three are optional; unset = engine default (no reasoning_effort
sent — on a model that cannot stop reasoning, such as Qwen, that is the
model's own default, i.e. its maximum). Dream phases share the same
engine adapters + per-engine mapping table below, so the values follow
identical semantics: the per-model `reasoning.levels` block, the retry
on a rejected value and the model's `maxTokens` output cap all apply to
REM, Deep and Lucid calls exactly as to chat turns. High thinking is a
reasonable choice for these background workers — nobody waits on the
latency — at the cost of longer chunks and more tokens per run. REM
is per-agent because session-extraction styles vary by persona;
Deep/Lucid are server-global because they operate on the shared
wiki across all agents.

The TUI header surfaces the effective state (chat turns only — dream
runs are background workers and don't render in the TUI):

- `🧠 medium` (cyan) — active and being applied
- `🧠 high→xhigh` (cyan, grey arrow) — active, and the model receives a
  different word for this level than somora's own (see *Per-model
  vocabulary* below)
- `🧠 thinking…` (cyan, during streaming, before first content token) —
  visual cue that the model is in its reasoning pass
- `thinking=medium (dormant)` (yellow) — setting is stored but the active
  model has no `reasoning` capability, so it has no effect

The Web client renders the same three states in its chat-window
header next to the model name. Parity between TUI and Web is
intentional — both clients hit the same `/agents/<a>/sessions/<s>/thinking`
endpoint and consume the same SSE events.

The output-token segment additionally shows the reasoning tokens spent
when the engine reports them: `↓ 412 (1.2k 🧠)`. Backends that stream
their thinking as `reasoning_content` deltas but report no
`reasoning_tokens` in `usage` get an estimate from the streamed text
(4 chars per token), marked with a tilde: `(~1.2k 🧠)`.

## The `reasoning` capability

A model only honors the thinking knob if its `capabilities` array in
`config.yaml` includes `reasoning`:

```yaml
- id: claude-opus-4-7
  alias: opus
  contextWindow: 1000000
  capabilities: [text, image, reasoning]
```

Without `reasoning` in the list, the engine adapter silently skips the
per-turn thinking parameter — the value is sent to the model unchanged
from whatever the model defaults to. The TUI marks this state as
**dormant** (yellow, with `(dormant)` suffix) instead of pretending the
setting works.

This matters for cloud-vs-local: cloud reasoning models (opus, gpt-5,
o3) all support it; vanilla local models (Gemma, Llama plain, Mistral
plain) do **not**. Local reasoning models that DO support it (GPT-OSS,
Qwen3-Thinking served via vLLM/SGLang) should be marked with
`reasoning` — then the same knob works there too.

## Per-engine translation

Each engine adapter receives the resolved `ThinkingLevel` plus the
active model's capability list. If the model lacks `'reasoning'`, the
adapter does nothing engine-specific. Otherwise it maps:

| somora level | claude-cli                                 | codex-cli                              | openai-compatible             |
|--------------|--------------------------------------------|----------------------------------------|-------------------------------|
| `off`        | `thinking: { type: 'disabled' }`           | `-c model_reasoning_effort=minimal` †  | param omitted entirely        |
| `low`        | `effort: 'low'`                            | `-c model_reasoning_effort=low`        | `reasoning_effort: 'low'`     |
| `medium`     | `effort: 'medium'`                         | `-c model_reasoning_effort=medium`     | `reasoning_effort: 'medium'`  |
| `high`       | `effort: 'high'`                           | `-c model_reasoning_effort=high`       | `reasoning_effort: 'high'`    |

† codex-cli has no real "off" state for reasoning-capable models — `off`
maps to `minimal` (its lowest setting). The semantic difference vs
`off` on claude is documented but unavoidable.

### Why three different surfaces

The mapping is intentionally lossy because the underlying APIs disagree:

- **Anthropic / claude-agent-sdk** uses adaptive thinking (`{ type:
  'adaptive' }`) plus an `effort` enum guiding depth, OR explicit
  `{ type: 'enabled', budgetTokens: N }` for fixed budgets, OR
  `{ type: 'disabled' }`. Adaptive is the default for Opus 4.6+.

- **Codex CLI** wraps OpenAI's reasoning models. The TOML override
  `model_reasoning_effort` on `-c` accepts `minimal | low | medium |
  high`. Set per-invocation; not persistent in the codex thread.

- **OpenAI-compatible chat.completions** accepts the body field
  `reasoning_effort`. OpenAI's own vocabulary is `none | minimal | low |
  medium | high | xhigh` — but every model family has its own words,
  and some backends reject a word they don't know with HTTP 400 instead
  of ignoring it. That is what the per-model block below is for.

Adopting one engine's vocabulary as somora's would have leaked detail.
The neutral `off | low | medium | high` enum maps cleanly to all three
and is the smallest set users actually distinguish in practice.

## Per-model vocabulary (`openai-compatible`)

Three models, three vocabularies:

| Model family | Accepted values | Unknown value → |
|---|---|---|
| OpenAI o-series / gpt-5 | `none minimal low medium high xhigh` | 400 |
| Qwen 3.x reasoning (vLLM chat template) | `low medium xhigh` — no `high`, no `none` | **400** — the template raises |
| DeepSeek V4 | `low high max` | ignored |

somora's neutral `off | low | medium | high` fits none of them fully.
Two things keep a thinking knob from killing a turn:

**1. Per-model mapping in `config.yaml`.** Each model on an
`openai-compatible` provider may carry a `reasoning:` block that says
which word somora sends for each level, and where in the request body
it goes:

```yaml
providers:
  local:
    engine: openai-compatible
    models:
      - id: some-qwen-reasoning-model
        alias: qwen
        contextWindow: 262144
        capabilities: [text, reasoning]
        maxTokens: 16384              # output cap; see setup.md
        reasoning:
          param: reasoning_effort     # reasoning_effort (default) | reasoning | chat_template_kwargs
          levels:                     # somora level → model value
            off: null                 # null = omit the param (model default)
            low: low
            medium: medium
            high: xhigh               # this model's real maximum
      - id: some-deepseek-model
        capabilities: [text, reasoning]
        reasoning:
          levels: { medium: high, high: max }
```

- A string is sent verbatim; `null` omits the parameter for that level.
- Levels you leave out keep the default mapping (`off` omits, the rest
  go through unchanged), so a block with a single line is fine.
- `param` picks the body shape: `reasoning_effort` top-level (OpenAI,
  vLLM, LiteLLM), `reasoning` for OpenRouter's nested
  `{ "reasoning": { "effort": … } }`, or `chat_template_kwargs` for
  vLLM templates that only read `{ "chat_template_kwargs": {
  "reasoning_effort": … } }`.
- `off` means "somora does not ask for a depth". On a model that cannot
  stop reasoning that is the model's default — which for Qwen is its
  *maximum*. If you want `off` to mean "as little as possible" on such a
  model, map it: `off: low`. somora does not guess this for you.

**2. Retry on rejection.** With or without a block, when the backend
answers a request with an error about the effort value, somora reads the
backend's own list of accepted values out of the message ("Supported:
xhigh, medium, low"), picks the nearest weaker one (then the nearest
stronger; never `none`), and sends the request again once. If the
message names no values, the retry goes out without the parameter. The
adjusted value stays for the rest of that turn. The turn gets an
`engine_meta` line ("reasoning effort adjusted") saying what was sent,
and the server log carries `engine.reasoning_effort_rejected` with the
backend's text — the cue to add the mapping to the model's block so it
stops costing a round-trip.

**Behind a router or proxy the retry never fires.** The retry needs the
backend's 400 to reach somora. A parameter-normalising gateway in
between — LiteLLM with `drop_params: true`, most OpenAI-compatible
routers — typically swallows it: measured 2026-09-02 against a Qwen
route through LiteLLM, every value (`low`, `high`, `xhigh`, `none`,
unset) returned 200 with a completion, and the reasoning volume did not
move with the value either — the router had dropped the parameter
before the backend saw it. Two consequences for router-fronted models:

- Neither the retry nor the `levels` mapping can help when the router
  drops the parameter; the model runs at its own default depth whatever
  somora sends, and the badge shows a word that never arrives. The fix
  is on the router (LiteLLM: let `reasoning_effort` through for that
  route, e.g. via `allowed_openai_params`), not in somora. Verify with
  a direct probe: send two efforts with a prompt that needs thinking
  and compare `usage.completion_tokens_details.reasoning_tokens`.
- Once the router passes the parameter through, the 400 for an unknown
  word may still be masked. Map the model explicitly in `levels` and do
  not rely on the retry; there is no `engine.reasoning_effort_rejected`
  cue on that path.

YAML note: somora parses config with a YAML 1.2 reader, so an unquoted
`off:` key is the string `off`. Quoting it (`"off": low`) is equally
fine and safer for tooling that reads the file with a YAML 1.1 parser.

One more vendor quirk worth knowing: DeepSeek V4 served by SGLang
reasons **only when the request carries a `reasoning_effort`** — with
the parameter omitted it answers without a thinking phase at all
(measured 2026-09-02: `reasoning_tokens: 0`, the "thinking" lands in
the visible text instead). On that model `off` really is off, and any
level switches thinking on.

The badge shows the mapped word whenever it differs from the level:
`🧠 high→xhigh`, or `🧠 high→off` when the level maps to "omit".

Sampling parameters (`temperature`, `top_p`, …) follow the same
three-layer pattern and are described in [sampling.md](sampling.md).

## Reasoning-token visibility

When the engine reports reasoning tokens in the turn's usage, somora
forwards them as `tokens_out_reasoning` on the `agent-end` SSE event.
Both the TUI and the Web client render the count next to total output
tokens with a 🧠 glyph (`↓ 412 (1.2k 🧠)`).

Per-engine support, today:

| Engine | Reasoning-token count surfaced? | How |
|---|---|---|
| `codex-cli` | ✓ | parsed from `reasoning_output_tokens` in codex's turn-completed JSON |
| `openai-compatible` | ✓ | parsed from `completion_tokens_details.reasoning_tokens` in the chat.completions usage chunk |
| `claude-cli` | ✗ | Anthropic's `usage` object reports `input_tokens` / `output_tokens` / `cache_*` — thinking-tokens are rolled into `output_tokens`, no separate counter |

If Anthropic later exposes thinking-tokens as a distinct field in the
SDK usage block, somora will pick it up the same way — until then
claude-cli turns show only the combined output count.

Per-token streaming of *thinking content* (the actual reasoning text)
is **not** wired up — see "What's not built" below.

## Wire format

The `agent` SSE event carries the resolved thinking state on both
`start` and `end` phases so clients can show the badge from the very
first token of a turn:

```jsonc
event: agent
data: {
  "phase": "start",
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "thinking": { "level": "high", "active": true }
}
```

```jsonc
event: agent
data: {
  "phase": "end",
  "usage": {
    "tokens_in": 12450,
    "tokens_out": 387,
    "tokens_in_cached": 11800,
    "tokens_out_reasoning": 1240
  },
  "contextWindow": 1000000,
  "provider": "anthropic",
  "model": "claude-opus-4-7",
  "thinking": { "level": "high", "active": true, "wire": "xhigh" }
}
```

`thinking.active = false` means a level is set but the active model
lacks the `reasoning` capability — the knob is dormant. `thinking.wire`
is present only when the value the engine sends differs from `level`
(per-model vocabulary); `"off"` there means the parameter is omitted.

## HTTP API for clients

Clients (TUI, future Orbit/web) drive the per-session override via:

| Method | Path                                                | Purpose                              |
|--------|-----------------------------------------------------|--------------------------------------|
| GET    | `/agents/:agent/sessions/:session/thinking`         | current effective level + source     |
| PUT    | `/agents/:agent/sessions/:session/thinking`         | body: `{ "level": "high" }` — sets override |
| DELETE | `/agents/:agent/sessions/:session/thinking`         | clears override → falls back to persona/engine default |

GET response example:

```json
{
  "agent": "<your-agent>",
  "session": "main",
  "effective": "high",
  "override": "high",
  "personaDefault": "medium",
  "source": "session-override",
  "modelSupportsReasoning": true,
  "wire": "xhigh"
}
```

`source` is one of `session-override | persona-default | engine-default`.
`wire` is the word the engine sends for `effective` when it differs
(`null` otherwise; `"off"` = parameter omitted).

## Thinking content — seeing what the model thought

Since v2026.09.03.01 the reasoning text itself is available, not only
the badge and the token count. It travels as its own event, separate
from the reply, and is never sent back to a model or into memory.

**Web:** every assistant bubble that carries thinking gets a collapsed
`🧠 thinking` block above the reply text. While the model is still
thinking and has not written a word yet, the block is open and shows
the tail of the reasoning live; the moment the reply starts it folds
away, and a click opens it again. **TUI:** off by default — `/verbose
thinking on` shows the text dimmed and indented above the reply,
capped at 40 lines (`… (+N lines)`), and the live tail while the model
thinks. See [display.md](display.md).

### Engine matrix

| Engine | Thinking content | What you get | Status |
|---|---|---|---|
| `openai-compatible` | yes, when the backend streams `reasoning_content` (or `reasoning`) deltas | the full reasoning text as the model wrote it | verified on DeepSeek V4 (SGLang) and Qwen 3.x (vLLM) through a LiteLLM router, 2026-09-03 |
| `openai-compatible`, inline `<think>` models (DeepSeek-R1, QwQ) | no | the reasoning stays inside the reply text as the model emits it | not supported — needs tag detection and its own capability, see below |
| `claude-cli` | yes | Anthropic's thinking blocks; on adaptive-thinking models (Opus 4.6+, Sonnet 4.6+, Fable) the provider may return a **summary** instead of the raw trace, and some blocks arrive **redacted** — shown as one placeholder line | verified on the Claude models in this setup, 2026-09-03 |
| `codex-cli` | yes, summaries | codex never streams the raw chain of thought; it emits one `reasoning` item per reasoning phase carrying the provider's summary | verified on gpt-5.5, 2026-09-03 |
| `grok-cli` | wired, unverified | ACP `agent_thought_chunk` frames, cumulative like message chunks | nobody here has a Grok account — the mapping follows the ACP schema only |

The token counter and the badge are unchanged and work on every engine
that reports reasoning at all; the content layer sits on top and is
simply absent where an engine has nothing to show.

### Configuration

```yaml
# config.yaml — server-global
thinkingContent:
  capture: true        # false = no SSE event, no JSONL row, nothing in any client
  maxChars: 65536      # per-turn cap on what is persisted; longer text is cut and marked
```

`capture` is the one switch: turning it off drops the content at the
server before it reaches any client. The cap keeps a Qwen turn at
`xhigh` from writing tens of thousands of tokens into the session file
per turn; the clients show "(truncated by the server)" on a cut block.

### Wire and storage

- SSE: `event: thinking` with `{ state: 'delta' | 'final', text,
  truncated? }`, deltas cumulative like `chat`. The `final` arrives
  before the `chat` final of the same turn.
- JSONL / `/chat/history`: one `thinking_message` row per turn, placed
  before the turn's `assistant_message`. Deltas are not persisted.
- Never replayed: history rebuilds for the model, compaction summaries
  and REM extraction read user, assistant and tool rows only.

### Not built: inline `<think>` models

Models that print their reasoning as `<think>…</think>` inside the
normal text stream (DeepSeek-R1, QwQ) ignore `reasoning_effort` and
would need stream-side tag detection plus a `reasoning-inline`
capability so the badge does not claim a depth knob that does nothing.
Nobody here runs one; it stays out until someone does. Until then, do
not give such a model the `reasoning` capability.
