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
sent — the backend decides; a Qwen 3.x thinking model under vLLM then
*thinks*, see the vocabulary table below). Dream phases share the same
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
| `off`        | `thinking: { type: 'disabled' }`           | `turn/start.effort: minimal` †         | param omitted entirely ‡      |
| `low`        | `effort: 'low'`                            | `turn/start.effort: low`               | `reasoning_effort: 'low'`     |
| `medium`     | `effort: 'medium'`                         | `turn/start.effort: medium`            | `reasoning_effort: 'medium'`  |
| `high`       | `effort: 'high'`                           | `turn/start.effort: high`              | `reasoning_effort: 'high'`    |

† codex-cli has no real "off" state for reasoning-capable models — `off`
maps to `minimal` (its lowest setting). The semantic difference vs
`off` on claude is documented but unavoidable.

The per-model `reasoning.levels` block (see the vocabulary section
below) applies to **codex-cli and grok-cli as well**, not only to the
OpenAI-compatible engine: codex accepts `xhigh` and `max` for the
GPT-5.6 family, so `reasoning: { levels: { high: xhigh } }` on such a
model sends `effort: xhigh` for `/thinking high`.
Without a mapping the level goes through verbatim as in the table.
`max` is deliberately not a suggested default — OpenAI documents it for
the hardest problems, with the latency and cost to match; map it in a
session when you need it.

### Why three different surfaces

The mapping is intentionally lossy because the underlying APIs disagree:

- **Anthropic / claude-agent-sdk** uses adaptive thinking (`{ type:
  'adaptive' }`) plus an `effort` enum guiding depth, OR explicit
  `{ type: 'enabled', budgetTokens: N }` for fixed budgets, OR
  `{ type: 'disabled' }`. Adaptive is the default for Opus 4.6+.

- **Codex** wraps OpenAI's reasoning models. The app-server's
  `turn/start.effort` accepts `minimal | low | medium | high | xhigh |
  max` (per model, see `somora codex debug models`). Set per turn; the
  thread keeps the last value.

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
| Qwen 3.x reasoning (vLLM chat template) | `none low medium xhigh` — no `high`; `none` = 0 reasoning tokens (verified 2026-09-05 on Qwen3.8-Flash-Next; unverified on 3.5-397B and 3.8-27B) | **400** — the template raises |
| DeepSeek V4 | `low high max`; `none` and unset both = no reasoning (2026-09-05) | ignored |

‡ "Omitted" means the backend's own default. For a Qwen 3.x thinking
model that default is *thinking on* — measured 2026-09-04: unset 60
reasoning tokens on a one-line arithmetic prompt, `low` 31, `none` 0.
So `off` without a `levels` mapping does **not** switch Qwen off; map
it (`off: none`, below) and give Qwen-based personas an explicit
`thinking:` in `agent.yaml`, otherwise "nothing set" is silently the
most expensive behaviour.

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
- `off` means "somora does not ask for a depth" — the model's own
  default, which for Qwen 3.x under vLLM is *thinking on*. To make
  `off` really switch reasoning off, map it: `off: none` (verified on
  Qwen3.8-Flash-Next, 0 reasoning tokens; `chat_template_kwargs:
  { enable_thinking: false }` is the template-level equivalent). On a
  backend without `none` in its vocabulary, `off: low` is the floor.
  somora does not guess this for you.

**2. Retry on rejection.** With or without a block, when the backend
answers a request with an error about the effort value, somora reads the
backend's own list of accepted values out of the message ("Supported:
xhigh, medium, low"), picks the nearest weaker one (then the nearest
stronger; never `none`), and sends the request again once. A rejected
`none` is the exception: it is retried with the parameter *omitted*,
never with a level that thinks. If the message names no values, the
retry goes out without the parameter. The
adjusted value stays for the rest of that turn. The turn gets an
`engine_meta` line ("reasoning effort adjusted") saying what was sent,
and the server log carries `engine.reasoning_effort_rejected` with the
backend's text — the cue to add the mapping to the model's block so it
stops costing a round-trip.

**Behind a router or proxy the retry may never fire.** The retry needs
the backend's 400 to reach somora. A parameter-normalising gateway in
between — LiteLLM with `drop_params: true`, most OpenAI-compatible
routers — typically swallows it. Measured 2026-09-02 against a Qwen
route through LiteLLM *before* the route allowed the parameter through:
every value (`low`, `high`, `xhigh`, `none`, unset) returned 200 with a
completion, and the reasoning volume did not move with the value
either — the router had dropped the parameter before the backend saw
it. (After `allowed_openai_params: ["reasoning_effort"]` on that route
the volume moves as expected: unset 60 / low 31 / none 0 reasoning
tokens, 2026-09-04.) Two consequences for router-fronted models:

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

Some OpenAI-compatible backends stream the reasoning text but report
no `reasoning_tokens` in usage (SGLang, some router setups). For those
somora estimates the count from the streamed `reasoning_content`
(about four characters per token) and flags it with
`tokens_out_reasoning_estimated: true`; the TUI and web client show
the badge with a tilde (`~1.2k 🧠`). An exact count from usage always
wins over the estimate.

The reasoning *text* itself is a separate feature — see
"Thinking content" below.

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
    "tokens_out_reasoning": 1240,
    "tokens_out_reasoning_estimated": false
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
away, and a click opens it again. Not everyone wants the block: the
`•••` session menu has a **Show thinking in replies** checkbox, and
`/verbose thinking on|off` does the same from the composer. Both are
display-only and remembered per session in the browser — the text is
still captured, persisted and exported. **TUI:** off by default —
`/verbose thinking on` shows the text dimmed and indented above the
reply, capped at 40 lines (`… (+N lines)`), and the live tail while the
model thinks. See [display.md](display.md).

### Engine matrix

| Engine | Thinking content | What you get | Status |
|---|---|---|---|
| `openai-compatible` | yes, when the backend streams `reasoning_content` (or `reasoning`) deltas | the full reasoning text as the model wrote it | verified end to end (SSE + history row) on DeepSeek V4 (SGLang, 893 chars) and Qwen 3.8 (vLLM, 440 chars) through a LiteLLM router, 2026-09-03 |
| `openai-compatible`, inline `<think>` models (DeepSeek V4 on SGLang without a reasoning parser, R1, QwQ) | yes | somora splits an inline `<think>…</think>` block off the reply — also the DeepSeek shape where only the closing tag arrives because the template prefilled the opening one — and routes it to the thinking block; the visible reply and subagent results stay clean | verified on deepseek-v4-flash, 2026-09-05 |
| `claude-cli` | placeholder only with the current SDK | The Claude Agent SDK carries thinking as its own blocks, but what those blocks contain depends on the SDK version, not on somora: with `@anthropic-ai/claude-agent-sdk` 0.3.258 every model measured (Fable, Opus 4.7, Sonnet 4.6) runs the thinking phase and delivers an **empty** block — somora shows one placeholder line. With SDK 0.3.215 Sonnet 4.6 streamed the text (280 chars on a short problem) while Fable and Opus 4.7 stayed empty. Explicitly redacted blocks get their own placeholder. | measured 2026-09-03 on both SDK versions |
| `codex-cli` | summaries per thinking phase | Codex never streams the raw chain of thought; with `summary: auto` on `turn/start` (somora sets it while `thinkingContent.capture` is on) the app-server streams `item/reasoning/summaryTextDelta` per thinking phase — heading-like sentences, shown as the thinking block. | verified on gpt-5.6-terra, 2026-09-05 (app-server engine) |
| `grok-cli` | wired, unverified | ACP `agent_thought_chunk` frames, cumulative like message chunks | nobody here has a Grok account — the mapping follows the ACP schema only |

The token counter and the badge are unchanged and work on every engine
that reports reasoning at all; the content layer sits on top and is
simply absent where an engine has nothing to show. In practice this
means: the full text comes from the local and routed models on
`openai-compatible`; Claude and Codex give a placeholder or a one-line
summary, because their providers do not disclose the trace.

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

### Inline `<think>` models

Models that print their reasoning as `<think>…</think>` inside the
normal text stream (DeepSeek V4 on a server without a reasoning parser,
R1, QwQ) get the block split off by the openai-compatible engine: the
reasoning goes to the thinking block, the reply and any subagent
`result` stay clean. Both shapes are handled — the full block, and the
DeepSeek-on-SGLang shape where the chat template prefilled `<think>` in
the prompt so only the closing tag arrives (measured 2026-09-03: a
subagent result opened with 2.5k characters of reasoning and a bare
`</think>`). Until the closing tag arrives the deltas may stream as
reply text; the final message is always clean. A `reasoning_effort`
knob still only works where the backend honours it — for DeepSeek V4
see [models.md](models.md).
