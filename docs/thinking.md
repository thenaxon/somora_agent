# Thinking

Many models can reason before they answer. somora has one setting for
how much: `off`, `low`, `medium` or `high`. It works the same on every
engine, and somora translates it into the word each model expects.

## What you get

- **One setting for all engines.** The same four levels on Claude,
  Codex, Grok and local models.
- **A default per agent, a choice per session.** Set the level in
  `agent.yaml` and change it for one session with `/thinking`.
- **Words that fit the model.** A mapping per model turns `high` into
  `xhigh` or `max` where the model calls it that.
- **An honest badge.** The header shows the level, the word the model
  receives, and whether the model can reason at all.
- **The reasoning itself.** Where the engine provides it, the thinking
  text appears above the reply, next to a count of reasoning tokens.

## Try it

In the TUI or the web client, type:

```
/thinking high           # more reasoning for this session
/thinking off            # no reasoning
/thinking default        # back to the agent's default
/thinking                # TUI: show the level and where it comes from
```

Ask something that needs thought and watch the `🧠` count next to the
output tokens. Then compare with `/thinking low`.

To set an agent's default, add one line to its `agent.yaml`:

```yaml
model: opus
thinking: medium     # off | low | medium | high
```

## Where the level comes from

The first source that has a value wins.

| Order | Source | Set with |
|---|---|---|
| 1 | The session | `/thinking <level>`, or the THINKING section of the `•••` session menu in the web client |
| 2 | The agent | `thinking:` in `agent.yaml` |
| 3 | The model | `reasoning.default` of the model in `config.yaml` |
| 4 | Nothing set | somora sends no level and the model uses its own default |

In the TUI, `/thinking -` does the same as `/thinking default`: it
removes the session's level, and the next source applies.

"Nothing set" is not "off". Many reasoning models think by default,
Qwen 3.x among them, so an agent without a level runs them
at full depth. Every client shows this state as **model decides**,
never as off. What "nothing set" means per model family, and which
default fits, is listed under
[When no level is set](models.md#when-no-level-is-set). To make "off"
(or any level) the rule for a model, give it a default:

```yaml
providers:
  gpu-box:
    models:
      - id: my-thinking-model
        alias: thinker
        capabilities: [text, reasoning]
        reasoning:
          default: "off"          # sent when session and agent set nothing
          levels: { "off": none, high: high }
```

The default is written in somora's words (`off`, `low`, `medium`,
`high`) and goes through the model's `levels` like any other level. It
applies on every engine. The session menu, `/thinking` and the phone's
model sheet name it as the model's default.

## The reasoning capability

The level only reaches a model that lists `reasoning` in its
`capabilities` in `config.yaml`:

```yaml
- id: claude-opus-4-7
  alias: opus
  contextWindow: 1000000
  capabilities: [text, image, reasoning]
```

Without `reasoning`, somora sends no thinking parameter and the model
behaves as it does by default. The level stays stored and the header
marks it as dormant.

Cloud reasoning models support it. Plain local models (Gemma, plain
Llama or Mistral) do not. Local reasoning models served by vLLM or
SGLang (GPT-OSS, Qwen thinking models, DeepSeek) do: mark them with
`reasoning` and the same setting works there.

## What each engine receives

| somora level | `claude-cli` | `codex-cli` | `grok-cli` | `openai-compatible` |
|---|---|---|---|---|
| `off` | `thinking: { type: 'disabled' }` | `turn/start.effort: minimal` | `--reasoning-effort low` | parameter omitted |
| `low` | `effort: 'low'` | `turn/start.effort: low` | `--reasoning-effort low` | `reasoning_effort: 'low'` |
| `medium` | `effort: 'medium'` | `turn/start.effort: medium` | `--reasoning-effort medium` | `reasoning_effort: 'medium'` |
| `high` | `effort: 'high'` | `turn/start.effort: high` | `--reasoning-effort high` | `reasoning_effort: 'high'` |

What `off` means differs per engine:

- **Claude** really switches thinking off.
- **Codex** has no off. It gets `minimal`, its lowest word.
- **Grok** always reasons. It gets `low`.
- **OpenAI-compatible** models get no parameter, which is the model's
  own default. For Qwen 3.x that default is thinking on. For
  DeepSeek V4 on SGLang it is no reasoning at all.

The table is the default. A `reasoning.levels` block on the model
replaces single cells for `codex-cli`, `grok-cli` and
`openai-compatible`. It has no effect on `claude-cli`.

## Mapping levels per model

Models disagree on the words, and some reject a word they do not know.
Each model in `config.yaml` may carry a `reasoning:` block that says
which word somora sends for each level:

```yaml
providers:
  local:
    engine: openai-compatible
    models:
      - id: some-qwen-reasoning-model
        alias: qwen
        contextWindow: 262144
        capabilities: [text, reasoning]
        maxTokens: 16384              # output cap, reasoning included
        reasoning:
          param: reasoning_effort     # reasoning_effort (default) | reasoning | chat_template_kwargs
          levels:                     # somora level: word the model gets
            off: null                 # null = omit the parameter
            low: low
            medium: medium
            high: xhigh               # this model's real maximum
      - id: some-deepseek-model
        capabilities: [text, reasoning]
        reasoning:
          levels: { medium: high, high: max }
```

| Key | Meaning |
|---|---|
| `levels.<level>` | A string is sent as it is. `null` omits the parameter for that level. A level you leave out keeps the default from the table above. |
| `param` | Where the word goes in the request. Only for `openai-compatible`. |

| `param` | Request body | Used by |
|---|---|---|
| `reasoning_effort` (default) | `{ "reasoning_effort": … }` | OpenAI, vLLM, LiteLLM |
| `reasoning` | `{ "reasoning": { "effort": … } }` | OpenRouter |
| `chat_template_kwargs` | `{ "chat_template_kwargs": { "reasoning_effort": … } }` | vLLM templates that only read kwargs |

On Codex the GPT-5.6 family also accepts `xhigh` and `max`, so
`reasoning: { levels: { high: xhigh } }` sends `effort: xhigh` for
`/thinking high`. `somora codex debug models` lists the words each
Codex model accepts.

> **Tip:** `max` is meant for the hardest problems, with the latency and
> cost to match. Map it when you need it, not as a default.

> **Note:** somora reads the config as YAML 1.2, so an unquoted `off:`
> key is the string `off`. Quoting it (`"off": low`) is equally fine and
> safer for tools that read the file as YAML 1.1.

## What the model families accept

| Model family | Accepted words | An unknown word |
|---|---|---|
| OpenAI o-series, gpt-5 | `none minimal low medium high xhigh` | answers 400 |
| Qwen 3.x reasoning (vLLM chat template) | `none low medium xhigh`, no `high` | answers 400 |
| DeepSeek V4 | `low high max`. `none` and no parameter both mean no reasoning. | is ignored |
| DeepSeek V4.1 | `none low high max`. Map `off: none` and `medium: high`. | is ignored |

The [models guide](models.md) has the recommended mapping for each
tested model, GLM included.

### Switching Qwen off

Without a mapping, `off` sends nothing and Qwen 3.x keeps thinking.
There are two ways to map it:

| Mapping | Result | Use it for |
|---|---|---|
| `off: none` | Zero reasoning tokens. About one reply in eight then opens with planning text ("The user asks … I can answer that directly …"). | Workers whose output is parsed, not read |
| `off: low` | About 110 extra tokens per reply, in the thinking channel where they belong. No planning text in the reply. | Agents that talk to people |

`chat_template_kwargs: { enable_thinking: false }` is the same switch
as `none` at the template level. On a backend without `none`,
`off: low` is the floor anyway. somora does not guess this for you.

### DeepSeek V4 on SGLang

This model reasons only when the request carries a `reasoning_effort`.
With the parameter omitted it answers without a thinking phase, and any
thinking lands in the visible text. So `off` really is off there, and
every other level switches thinking on.

## When a model rejects the word

With or without a mapping, a backend may answer with an error about the
effort value. somora then retries once:

1. It reads the list of accepted words from the error message, for
   example "Supported: xhigh, medium, low".
2. It picks the nearest weaker word, or else the nearest stronger one.
   It never picks `none`.
3. It sends the request again. The adjusted word stays for the rest of
   the turn.

On `openai-compatible`, a rejected `none` is retried with the parameter
omitted, never with a word that thinks. The same happens when the error
names no words. On `codex-cli` the retry only happens when the error
lists the words. A model that knows no `minimal` then gets `low` for
`off`.

The chat shows a "reasoning effort adjusted" line with what was sent.
That is the cue to add the word to the model's `levels`, so it stops
costing a round trip.

## Models behind a router

The retry needs the backend's error to reach somora. A gateway that
normalises parameters, such as LiteLLM with `drop_params: true`, often
drops `reasoning_effort` before the model sees it. Every level then
answers normally with the same amount of reasoning, and the badge shows
a word that never arrives.

- **Fix it on the router.** In LiteLLM, let the parameter through for
  that route, for example with
  `allowed_openai_params: ["reasoning_effort"]`. Neither the retry nor
  `levels` can help while the router drops it.
- **Check with a direct probe.** Send two efforts with a prompt that
  needs thinking and compare
  `usage.completion_tokens_details.reasoning_tokens`.
- **Map the model explicitly.** A router may still hide the error for an
  unknown word, so do not rely on the retry there.

## Dream phases

The background workers for REM, Deep and Lucid have their own optional
level. They use the same engine mapping, the same `reasoning.levels`
and the model's `maxTokens` output cap. On `openai-compatible` workers
the retry applies too.

| Phase | File | Setting |
|---|---|---|
| REM | `agent.yaml` | `rem.thinking` |
| REM judge | `config.yaml` | `rem.dedup.judge.thinking` |
| Deep | `config.yaml` | `wiki.deep.thinking` |
| Lucid | `config.yaml` | `wiki.lucid.thinking` |

Unset means no level is sent and the model decides. A Qwen 3.x worker
then thinks. A high level is a reasonable choice here: nobody waits for
the answer, and the cost is longer runs and more tokens.

REM is set per agent because extraction differs by persona. Deep and
Lucid work on the wiki that all agents share, so they are set once.

## What the header shows

| Badge | Meaning |
|---|---|
| `🧠 medium` | The level is applied. |
| `🧠 high→xhigh` | Applied, and the model receives a different word than the level. `🧠 high→off` means the parameter is omitted. |
| `thinking=medium (dormant)` | A level is stored, but the model has no `reasoning` capability. It has no effect. |
| `🧠 auto` | Web client: nothing is set on a reasoning model, so the model decides. |
| `thinking` with a spinner | TUI only: the turn runs and no reply text has arrived yet. |
| `↓ 412 (1.2k 🧠)` | Reasoning tokens of the turn, next to the output tokens. |
| `(~1.2k 🧠)` | The same as an estimate, see below. |

The TUI and the web client show the same badges. Three differences: the
web client hides the badge when the level is `off`, shows `🧠 auto`
when nothing is set, and the TUI shows the arrow only on
`openai-compatible` models. Dream runs are background
work and have no badge.

## Reasoning tokens

| Engine | Count shown | Source |
|---|---|---|
| `codex-cli` | yes | `reasoningOutputTokens` in the app-server's `thread/tokenUsage/updated` notification |
| `openai-compatible` | yes | `completion_tokens_details.reasoning_tokens` in the usage chunk |
| `grok-cli` | when Grok reports it | the usage of the turn |
| `claude-cli` | no | Anthropic counts thinking inside `output_tokens`. There is no separate number. |

Some OpenAI-compatible backends stream the reasoning text but report no
`reasoning_tokens` (SGLang, some routers). somora then estimates the
count from the streamed text, about four characters per token, and
marks it with a tilde. An exact count from the backend always wins.

## Seeing the thinking text

The reasoning text travels as its own event, separate from the reply.
It is never sent back to a model: history rebuilds, compaction summaries
and REM extraction read user, assistant and tool rows only.

| Client | What you see | Switch |
|---|---|---|
| Web | A collapsed `🧠 thinking` block above the reply. While the model thinks and has not written yet, it is open and shows the last lines live. It folds when the reply starts. Click to open it. | **Show thinking in replies** in the `•••` session menu, or `/verbose thinking on\|off`. On by default, remembered per session in the browser. |
| TUI | The text dimmed and indented above the reply, at most 40 lines (`… (+N lines)`), and the last lines live while the model thinks. | `/verbose thinking on\|off`. Off by default. `tui.verbose.thinking` in `config.yaml` sets the start value. |
| Mobile | One `🧠 thinking` row. Tap it to read all of it. | none |

The client switches only change the display. The text is still
captured, stored and exported.

### What each engine provides

| Engine | You get | Checked |
|---|---|---|
| `openai-compatible` | The full reasoning text, when the backend streams `reasoning_content` or `reasoning` deltas. | end to end on DeepSeek V4 (SGLang) and Qwen 3.8 (vLLM) through a LiteLLM router |
| `openai-compatible`, inline `<think>` models | The full text, split off the reply. | DeepSeek V4 Flash |
| `claude-cli` | Whatever the Claude Agent SDK delivers. With the current SDK the thinking blocks arrive empty, and somora shows one placeholder line saying that the model thought. A redacted block gets its own placeholder. | yes |
| `codex-cli` | A summary per thinking phase: heading-like sentences. Codex never streams the raw reasoning. somora asks for `summary: auto` on `turn/start` while capture is on and reads `item/reasoning/summaryTextDelta`. | yes |
| `grok-cli` | ACP `agent_thought_chunk` frames. | no, it follows the ACP schema only |

In practice the full text comes from local and routed models. Claude
and Codex give a placeholder or a summary, because their providers do
not disclose the trace.

### Models that think inline

Some models print their reasoning as `<think>…</think>` inside the
normal text: DeepSeek V4 on a server without a reasoning parser, R1,
QwQ. somora splits the block off. The reasoning goes to the thinking
block, and the reply and any subagent `result` stay clean.

Both shapes are handled: the full block, and the one where the chat
template already wrote `<think>` into the prompt, so only the closing
tag arrives. Until the closing tag arrives, the text may stream as
reply text. The final message is always clean.

## Settings

Server-wide, in `config.yaml`. The values shown are the defaults.

```yaml
thinkingContent:
  capture: true
  maxChars: 65536
```

| Setting | Default | Meaning |
|---|---|---|
| `thinkingContent.capture` | `true` | `false` drops the thinking text at the server: no SSE event, no JSONL row, nothing in any client. Codex is then asked for no summaries. |
| `thinkingContent.maxChars` | `65536` | Most characters of thinking text stored per turn. Longer text is cut and the clients show "(truncated by the server)". Keeps a long reasoning phase from filling the session file. |
| `tui.verbose.thinking` | `false` | Whether the TUI starts with the thinking text shown. |

Where a level is set:

| Setting | File | Values |
|---|---|---|
| `thinking` | `agent.yaml` | `off`, `low`, `medium`, `high`. Unset: nothing is sent. |
| `rem.thinking` | `agent.yaml` | the same |
| `rem.dedup.judge.thinking`, `wiki.deep.thinking`, `wiki.lucid.thinking` | `config.yaml` | the same |
| `reasoning.default` | per model in `config.yaml` | `off`, `low`, `medium`, `high`. Used when session and agent set nothing. Unset: nothing is sent. |
| `reasoning.param`, `reasoning.levels` | per model in `config.yaml` | see [Mapping levels per model](#mapping-levels-per-model) |

## Commands

| Command | Where | What it does |
|---|---|---|
| `/thinking` | TUI | Shows the level, its source, and a warning when it is dormant. |
| `/thinking off\|low\|medium\|high` | TUI, web | Sets the level for this session. |
| `/thinking default` | TUI, web | Removes the session's level. |
| `/verbose thinking on\|off` | TUI, web | Shows or hides the thinking text. |

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/agents/:agent/sessions/:session/thinking` | The level in effect and its source |
| PUT | `/agents/:agent/sessions/:session/thinking` | Body `{ "level": "high" }`. Sets the session's level. Answers `{ agent, session, level }`, or 400 for an unknown level. |
| DELETE | `/agents/:agent/sessions/:session/thinking` | Removes the session's level. Answers `{ agent, session, cleared: true }`. |

All three answer 404 for an unknown agent or session. A GET response:

```json
{
  "agent": "<your-agent>",
  "session": "main",
  "effective": "high",
  "override": "high",
  "personaDefault": "medium",
  "modelDefault": "off",
  "source": "session-override",
  "modelSupportsReasoning": true,
  "wire": "xhigh"
}
```

| Field | Meaning |
|---|---|
| `effective` | The level in effect, or `null` when nothing is set. |
| `override` | The session's level, or `null`. |
| `personaDefault` | The agent's level, or `null`. |
| `modelDefault` | The active model's `reasoning.default`, or `null`. |
| `source` | `session-override`, `persona-default`, `model-default`, or `engine-default` (nothing set: nothing is sent, the model decides). |
| `modelSupportsReasoning` | `false` means the level is dormant. |
| `wire` | The word the engine sends when it differs from `effective`, else `null`. `"off"` means the parameter is omitted. Reported for `openai-compatible` and `codex-cli`. |

## Events

The `agent` SSE event carries the thinking state at the start and the
end of a turn, so a client can show the badge from the first token:

```jsonc
event: agent
data: {
  "phase": "start",
  "provider": "local",
  "model": "some-qwen-reasoning-model",
  "thinking": { "level": "high", "active": true, "wire": "xhigh" }
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
    "tokens_out_reasoning_estimated": true
  },
  "contextWindow": 262144,
  "provider": "local",
  "model": "some-qwen-reasoning-model",
  "thinking": { "level": "high", "active": true, "wire": "xhigh" }
}
```

| Field | Meaning |
|---|---|
| `thinking` | Present only when a level is set. |
| `thinking.active` | `false`: the model lacks the `reasoning` capability and the level is dormant. |
| `thinking.wire` | The word sent when it differs from `level`. `"off"` means the parameter is omitted. Sent for `openai-compatible` models only. |
| `usage.tokens_out_reasoning` | Reasoning tokens of the turn, when the engine reports or somora estimates them. |
| `usage.tokens_out_reasoning_estimated` | `true` when the count is an estimate. Absent otherwise. |

The thinking text has its own event and its own history row:

| Where | Shape |
|---|---|
| SSE | `event: thinking` with `{ state: 'delta' \| 'final', text, truncated? }`. Deltas are cumulative, like `chat`. The `final` arrives before the `chat` final of the same turn. |
| JSONL and `/chat/history` | One `thinking_message` row per turn, placed before the turn's `assistant_message`. Deltas are not stored. |
| A rejected effort word | An `engine_meta` row of type `reasoning_effort_adjusted`. |

## Troubleshooting

**The badge says dormant.** The model has no `reasoning` in its
`capabilities`. Add it if the model can reason, or switch the model.

**The level changes nothing.** If the model sits behind a router, the
router probably drops the parameter. See
[Models behind a router](#models-behind-a-router).

**`/thinking off` and the model still thinks.** On Qwen 3.x, `off`
sends nothing unless you map it. See
[Switching Qwen off](#switching-qwen-off).

**Replies open with planning text.** The model runs with `none`. Map
`off: low` for that model.

**A "reasoning effort adjusted" line in the chat.** The model rejected
the word. The server log has `engine.reasoning_effort_rejected` with the
backend's text. Add the word it accepts to the model's `levels`.

**No thinking block on Claude, only a placeholder.** That is what the
SDK delivers. The setting still works.

## See also

- [Models](models.md): tested models and the mapping each one needs
- [Sampling](sampling.md): `temperature`, `top_p` and friends, set the
  same way
- [TUI display](display.md): `/verbose` and what the header shows
- [Dream phases](dream-phases.md): REM, Deep and Lucid
- [Setup](setup.md): `maxTokens` and other model settings
- [API](api.md): all routes and SSE events
