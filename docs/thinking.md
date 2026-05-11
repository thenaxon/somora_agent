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
sent). Dream phases share the same engine adapters + per-engine
mapping table below, so the values follow identical semantics. REM
is per-agent because session-extraction styles vary by persona;
Deep/Lucid are server-global because they operate on the shared
wiki across all agents.

The TUI header surfaces the effective state (chat turns only — dream
runs are background workers and don't render in the TUI):

- `🧠 medium` (cyan) — active and being applied
- `🧠 thinking…` (cyan, during streaming, before first content token) —
  visual cue that the model is in its reasoning pass
- `thinking=medium (dormant)` (yellow) — setting is stored but the active
  model has no `reasoning` capability, so it has no effect

The Web client renders the same three states in its chat-window
header next to the model name. Parity between TUI and Web is
intentional — both clients hit the same `/agents/<a>/sessions/<s>/thinking`
endpoint and consume the same SSE events.

The output-token segment additionally shows the reasoning tokens spent
when the engine reports them: `↓ 412 (1.2k 🧠)`.

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
  `reasoning_effort` with values `none | minimal | low | medium | high
  | xhigh`. Models that don't recognize it ignore it.

Adopting one engine's vocabulary as somora's would have leaked detail.
The neutral `off | low | medium | high` enum maps cleanly to all three
and is the smallest set users actually distinguish in practice.

## Reasoning-token visibility

When the engine reports reasoning tokens in the turn's usage, somora
forwards them as `tokens_out_reasoning` on the `agent-end` SSE event.
Both the TUI and the Web client render the count next to total output
tokens with a 🧠 glyph (`↓ 412 (1.2k 🧠)`).

Per-engine support, today:

| Engine | Reasoning-token count surfaced? | How |
|---|---|---|
| `codex-cli` | ✓ | parsed from `reasoning_output_tokens` in codex's turn-completed JSON |
| `openai-compatible` | ✓ | parsed from `completion_tokens_details.reasoning_tokens` in the chat.completions usage chunk (added 2026-05-11) |
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
  "thinking": { "level": "high", "active": true }
}
```

`thinking.active = false` means a level is set but the active model
lacks the `reasoning` capability — the knob is dormant.

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
  "modelSupportsReasoning": true
}
```

`source` is one of `session-override | persona-default | engine-default`.

## What's not built (and why)

**Thinking-block content is not surfaced live.** claude-agent-sdk emits
thinking blocks as separate `thinking_delta` content blocks during the
stream — somora currently flattens everything to plain text. Showing
the *contents* of the model's reasoning (collapsible, dimmed)
would require:

- claude-cli adapter: split thinking blocks from text blocks
- New `NormalizedEvent` kind: `thinking_delta` / `thinking_message`
- New SSE event: `kind: 'thinking'`
- TUI rendering: collapsed-by-default block, expand on hotkey
- openai-compatible: detect inline `<think>...</think>` for DeepSeek-R1
  / QwQ-style models OR consume the `reasoning_content` delta field
  some endpoints emit

This is real adapter work, not a switch — a separate phase. Until then,
the user sees that the model is thinking (badge + token count) but not
*what* it's thinking.

**Local inline-reasoning models (DeepSeek-R1, QwQ).** These models
emit `<think>...</think>` blocks in the regular content stream and
ignore any `reasoning_effort` API parameter — they always reason at
their own internal depth. Marking such a model with `reasoning` in
config would be slightly misleading: the badge would show "active" but
the depth knob doesn't actually move anything (the model decides). A
distinct `reasoning-inline` capability would be the honest way to
support these — out of scope until you actually run one.
