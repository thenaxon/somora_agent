# Models

A list of models known to run with somora, grouped by engine, with the
`config.yaml` values that work. The same model behaves differently
behind each engine, so every entry is "this model behind this engine".
Copy the block you need and adjust the host and key.

## What you get

- **Blocks you can copy.** Each engine section has a ready `providers:`
  block with ids, context windows and capabilities.
- **The right context window.** The usable window depends on the engine
  and the server, not on the model card. The values here are the ones
  that work.
- **Thinking levels that fit the model.** Models disagree on the words
  for reasoning effort. The mappings here translate somora's levels.
- **Vendor sampling defaults**, set per model, so an agent does not
  need its own.
- **Known pitfalls per engine**, with the symptom and the fix.

## Add a model

1. Copy the block for your engine from this page into `providers:` in
   `config.yaml`. Aliases are suggestions: pick your own, each must be
   unique across the whole config.
2. Reload the config: `/reload` in the TUI, the gear in the web
   taskbar, or `POST /config/reload`. A change under `providers:` needs
   no restart.
3. Point an agent at it in its `agent.yaml`:

   ```yaml
   model: fable          # alias or provider/modelId
   fallback: deep4flash  # optional, one ref or a list
   ```

4. Send a message and check the model name in the chat header. For a
   reasoning model, compare `/thinking high` with `/thinking low` and
   watch the 🧠 count.

## How to read the tables

Each engine section has a table with a **checked** column.

| Value | Meaning |
|---|---|
| full check | The model went through somora's engine check on a live install. |
| partial | Only the parts named in the row were checked in somora. |
| backend only | The server was probed directly. The check inside somora is pending. |

The full check covers: basic tools (`time_now`, `exec`, `file_read`,
`tmux`, `memory_search`, a deferred tool), tools on an SSH resource
(`exec`, `file_write`, `file_read`, `file_list`, `tmux` on another
host), `web_fetch`, `agent_ask` to another agent, `spawn_subagent`, an
image attachment where the model has vision, `/thinking high`, an abort
in the middle of a turn, and session memory across turns.

The page is maintained by hand. Corrections and new rows are welcome as
pull requests.

## Claude Code subscription

Engine `claude-cli`. It runs through the Claude Agent SDK on your
`claude login`. There is no API key and no sampling: the CLI does not
expose sampling parameters.

```yaml
providers:
  anthropic:
    engine: claude-cli
    models:
      - id: claude-fable-5-1
        alias: fable
        contextWindow: 1000000
        capabilities: [text, image, pdf, reasoning]
      - id: claude-opus-5-5
        alias: opus
        contextWindow: 1000000
        capabilities: [text, image, pdf, reasoning]
      - id: claude-sonnet-5
        alias: sonnet
        contextWindow: 1000000
        capabilities: [text, image, pdf, reasoning]
      - id: claude-haiku-4-5
        alias: haiku
        contextWindow: 200000
        capabilities: [text, image, pdf, reasoning]
```

| Model | contextWindow | Notes | Checked |
|---|---|---|---|
| `claude-fable-5-1` | 1000000 | Frontier model, adaptive thinking always on. The SDK discloses no thinking text for it, so somora shows a placeholder row that the model thought. No separate reasoning token count: it is part of `tokens_out`. | full check |
| `claude-opus-5-5` | 1000000 | Anthropic's recommendation for most workloads. It replaces `claude-opus-5`: keep your alias, change the `id`. Thinking text is a placeholder, as above. | full check |
| `claude-sonnet-5` | 1000000 | Same surface as Opus, cheaper on the subscription budget. | full check |
| `claude-haiku-4-5` | 200000 | Supports extended thinking. Keep `reasoning` in `capabilities`. | full check |

What is special about this engine:

- **The window is the model's real one.** Claude Code runs the session
  against it and compacts by itself. `contextWindow` only decides
  whether the model is picked as a compaction worker and what the
  header percentage shows.
- **Tools are found on demand.** somora's tools reach the model through
  `ToolSearch`, so the first tool call in a session is preceded by a
  `ToolSearch` row. That is normal.
- **Thinking levels map to the SDK's `effort`.** `low`, `medium` and
  `high` go through as they are, `off` disables thinking. A
  `reasoning.levels` block has no effect on this engine.
- **No claude.ai connectors.** Gmail, Calendar and Drive never exist
  inside a somora session.

## ChatGPT subscription through Codex

Engine `codex-cli`. somora runs the bundled Codex (`@openai/codex`, the
exact version is pinned in somora's `package.json`) as an app-server
for each turn, on your `codex login`. A global `codex` on the host is
not used. `somora codex login` signs in with the bundled one, and an
existing `codex login` is picked up automatically.

```yaml
providers:
  openai:
    engine: codex-cli
    models:
      - id: gpt-6-astra
        alias: astra
        contextWindow: 258400          # what codex reports as modelContextWindow
        capabilities: [text, image, pdf, reasoning]
        reasoning:
          levels: { "off": low, high: xhigh }   # Astra has no `minimal`: map `off` explicitly; `max` deliberately not a default
      - id: gpt-5.6-sol
        alias: gpt56
        contextWindow: 258400          # the codex session window, NOT the 1.05M API window
        capabilities: [text, image, pdf, reasoning]
        reasoning:
          levels: { high: xhigh }      # optional: /thinking high → codex xhigh
      - id: gpt-5.6-terra
        alias: terra
        contextWindow: 258400
        capabilities: [text, image, pdf, reasoning]
      - id: gpt-5.6-luna
        alias: luna
        contextWindow: 258400
        capabilities: [text, image, pdf, reasoning]
      - id: gpt-5.5
        alias: gpt55
        contextWindow: 258400
        capabilities: [text, image, pdf, reasoning]
```

| Model | contextWindow | Notes | Checked |
|---|---|---|---|
| `gpt-6-astra` | 258400 | For the hardest problems. Runs in Code Mode only, like the 5.6 family. Effort words are `low`, `medium`, `high`, `xhigh`, `max`. There is no `minimal`, so map `off` as in the block above. | full check |
| `gpt-5.6-sol` | 258400 | Flagship: complex coding, research, deepest reasoning. | full check |
| `gpt-5.6-terra` | 258400 | Workhorse. OpenAI positions it as GPT-5.5 class at lower cost. | full check |
| `gpt-5.6-luna` | 258400 | Fast and cheap: extraction, classification, volume. | full check |
| `gpt-5.5` | 258400 | Still listed by Codex. The one model here that does not run in Code Mode only. Terra is the equivalent at lower cost. | full check |
| `gpt-5.4-mini`, `gpt-5.3-codex` | none | Retired for ChatGPT accounts. Codex answers with an error, which shows as a failed turn or a crashed compaction worker. Remove them. | retired |

### The Codex context window

Codex runs a session against a window it sets itself and reports on
every turn as `modelContextWindow`: 258,400 for every model it offers,
while the API window of the same models is 1.05M. Configure
`contextWindow: 258400`, not the number from the model card.

somora shows the reported number once the first turn has run. Until
then the header uses the configured value. The configured value also
decides whether the model is picked as a compaction worker, so keep it
right. A higher value such as 272000 makes a long thread read as over
full.

Codex compacts the thread itself. `compaction.triggerRatio` does not
apply to this engine.

### Thinking levels on Codex

The GPT-5.6 family knows `minimal`, `low`, `medium`, `high`, `xhigh`
and `max`. somora sends its level under the same word, and `off` as
`minimal`, unless you map it with `reasoning.levels`.

| You want | Mapping |
|---|---|
| `/thinking high` to use `xhigh` | `levels: { high: xhigh }` |
| `off` on a model without `minimal` | `levels: { "off": low }` |
| No effort sent for a level | `levels: { medium: null }` |

When Codex rejects an effort word, somora retries the turn once with
the nearest word Codex lists and says so in the chat. For Astra with
`off` unmapped that is `low`.

> **Tip:** `max` is meant for the hardest problems, with cost and
> latency to match. Map it for a session when you need it, not as a
> default.

Codex sends reasoning summaries for each thinking phase. somora streams
them as the thinking block.

### Tools on Codex

somora hands its tools to Codex as dynamic tools, so every Codex model
reaches the same tools as on the other engines.

| Namespace | What is in it |
|---|---|
| `somora` | somora's own tools |
| `somora_direct` | tools whose results can carry images |
| `somora_mcp_<server>` | tools of an external MCP server |

The tools named in `codexCli.directTools` sit in the model's direct
list on every turn. The rest is deferred and found through Codex tool
search. The developer instructions list their names.

**Code Mode.** The GPT-5.6 family and GPT-6 are `code_mode_only`. The
model writes a JavaScript cell that calls `tools.somora.<tool>(...)`
and finds deferred tools through `ALL_TOOLS`. Codex runs the cell,
somora runs the tools. The cell has no `require`, `process`, `fetch` or
filesystem. `gpt-5.5` calls the same tools directly.
`somora codex debug models` shows the `tool_mode` of each model.

## Grok subscription

Engine `grok-cli`, for a SuperGrok or Premium subscription. somora
drives the Grok CLI over ACP. The adapter is community maintained. It
takes text attachments only and has no one-shot path, so a Grok model
cannot be a dream or compaction worker.

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

| Model | contextWindow | Notes | Checked |
|---|---|---|---|
| `grok-4.5` | 500000 | Thinking levels are passed as `--reasoning-effort`. `off` is sent as `low`, because the model always reasons. `reasoning.levels` is applied. | partial: the thinking text path is unchecked |

## Self hosted models

Engine `openai-compatible`, for vLLM, SGLang, oMLX, Ollama, LM Studio
and similar servers. This is the engine somora runs end to end: its own
agent loop, sampling parameters, a reasoning vocabulary per model and
its own compaction. The sampling values below are the vendors'
recommended defaults for each model family.

```yaml
providers:
  local:
    engine: openai-compatible
    baseUrl: http://<your-host>:8000/v1
    apiKey: "<key or anything for a local server>"
    # sendUserTag: true                   # default: `user: "<agent>/<session>"` on every request so a
                                          # gateway can attribute spend per agent; false to withhold
    models:
      - id: deepseek-v4-flash             # SGLang; behind LiteLLM use the route name (e.g. deepseek-v4-flash-0731)
        alias: deep4flash
        contextWindow: 700000             # = the server's --context-length, not the model's 1M
        capabilities: [text, reasoning]
        sampling: { temperature: 1.0, top_p: 0.95 }
        reasoning:
          levels: { medium: high, high: max }
      - id: deepseek-v4.1-flash           # SGLang TP=4 (community SM120 runtime), Engram NVMe offload
        alias: deep41flash
        contextWindow: 700000             # = --context-length
        capabilities: [text, image, reasoning]
        sampling: { temperature: 1.0, top_p: 0.95 }
        maxTokens: 16384                  # operational output budget INCLUDING reasoning, not the model's max
        reasoning:
          levels: { "off": none, low: low, medium: high, high: max }
      - id: glm-5.3-flash                 # vLLM TP=4, native FP8; behind LiteLLM use the route name
        alias: glm
        contextWindow: 700000             # = --max-model-len (model-native 1M; 262k in the reference recipe)
        capabilities: [text, image, reasoning]
        sampling: { temperature: 1.0, top_p: 0.95 }   # = the model's generation_config.json (vLLM applies it when nothing is sent)
        maxTokens: 16384
        reasoning:
          levels: { "off": low, low: low, medium: high, high: max }   # vocabulary is ONLY low/high/max; anything else = max
      - id: deepseek-v4-flash-vision-exp  # SGLang TP=2, same backbone as deepseek-v4-flash + ViT; experimental
        alias: deep4vision
        contextWindow: 700000             # = --context-length (KV pool 859k tokens at mem-fraction 0.90)
        capabilities: [text, image, reasoning]
        sampling: { temperature: 1.0, top_p: 0.95 }   # as deepseek-v4-flash
        reasoning:
          levels: { medium: high, high: max }         # as deepseek-v4-flash
      - id: qwen3.8-flash-next            # vLLM, FP8
        alias: qwen38next
        contextWindow: 524288             # = --max-model-len (YaRN)
        capabilities: [text, image, reasoning]
        sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 }
        maxTokens: 16384
        reasoning:
          levels: { "off": low, high: xhigh }
      - id: qwen3.5-397b-a17b-awq         # vLLM, AWQ INT4
        alias: qwen35big
        contextWindow: 262144
        capabilities: [text, image, reasoning]
        sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 }
        reasoning:
          levels: { "off": low, high: xhigh }
      - id: qwen3.8-27b-fp8               # vLLM, dense
        alias: qwen38small
        contextWindow: 262144
        capabilities: [text, image, reasoning]
        sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 }
        reasoning:
          levels: { "off": low, high: xhigh }
      - id: gemma-4-31b-it-8bit           # oMLX (Apple Silicon)
        alias: gemma4big
        contextWindow: 131072
        capabilities: [text, image]
        sampling: { temperature: 1.0, top_p: 0.95, top_k: 64 }
      - id: gemma-4-26b-a4b-it-4bit       # oMLX
        alias: gemma4small
        contextWindow: 131072
        capabilities: [text, image]
        sampling: { temperature: 1.0, top_p: 0.95, top_k: 64 }
```

### Server, window and sampling

Sampling is given as temperature / top_p / top_k.

| Model family | Server | contextWindow | Sampling | Checked |
|---|---|---|---|---|
| **DeepSeek V4 Flash** (284B MoE, 13B active) | SGLang, TP=4 | the server's `--context-length`: 700000 on a two GPU profile, 1M only with the whole box | 1.0 / 0.95 (DeepSeek's recommendation for agents and coding) | full check, image attachment refused as intended |
| **DeepSeek V4.1 Flash** | SGLang, TP=4, community SM120 runtime, Engram NVMe offload | `--context-length` 700000 | 1.0 / 0.95 (model card; `top_k` and penalties unset) | partial: thinking levels, native image, tools, several turns |
| **GLM-5.3-Flash** (321B MoE, 18B active) | vLLM, TP=4, native FP8, MTP-4, fp8 KV | `--max-model-len` 700000 (KV pool 1.16M tokens with `--kv-cache-memory` 7.5 GiB) | 1.0 / 0.95 (the model's `generation_config.json`) | backend only |
| **DeepSeek-V4-Flash-Vision-Exp** (284B MoE, 13B active, 0.5B ViT) | SGLang, TP=2, preview image with sm_120 patches | `--context-length` 700000 (pool 859k at mem-fraction 0.90; 0.85 gives only 203k) | 1.0 / 0.95 | backend only |
| **Qwen3.8-Flash-Next** FP8 (176B, 6B active) | vLLM, TP=4 | `--max-model-len`, 524288 with YaRN 2.0 | 0.6 / 0.95 / 20, `min_p` 0 (Qwen's thinking mode defaults) | full check |
| **Qwen3.5-397B-A17B** AWQ INT4 | vLLM, TP=4 | 262144 (`max_model_len`) | as Qwen3.8-Flash-Next | full check |
| **Qwen3.8-27B** FP8, dense | vLLM, 1 GPU | 262144 | as Qwen3.8-Flash-Next | full check |
| **Gemma 4** 31B and 26B-A4B | oMLX | 131072 | 1.0 / 0.95 / 64 (Gemma team recommendation) | full check |

### Reasoning levels per family

| Model family | Words the model accepts | An unknown word | Map |
|---|---|---|---|
| DeepSeek V4 Flash, Vision-Exp | `low`, `high`, `max` | is ignored | `medium: high`, `high: max`. No mapping for `off`: leaving the parameter out gives no reasoning, and so does `none`. |
| DeepSeek V4.1 Flash | `none`, `low`, `high`, `max` | is ignored | `off: none`, `medium: high`, `high: max` |
| GLM-5.3-Flash | `low`, `high`, `max` only | silently becomes `max`, also `none` and `medium` | `off: low`, `medium: high`, `high: max` |
| Qwen 3.x | `none`, `low`, `medium`, `xhigh` | answers 400, so `high` fails unless mapped | `high: xhigh` and `off: low` or `off: none`, see below |
| Gemma 4 | none, no `reasoning` capability | not sent | nothing |

Details that matter when you pick a mapping:

- **Qwen thinks when nothing is sent.** Without a mapping, `off` sends
  no parameter and the model reasons at its default. `none` gives zero
  reasoning tokens on Qwen3.8-Flash-Next. On the two other Qwen models
  `none` is unchecked: keep `off: low` there.
- **Qwen `off: low` or `off: none`.** Use `off: low` for an agent that
  talks to people, `off: none` for a worker whose output is parsed. The
  [thinking guide](thinking.md) explains why.
- **GLM `max` is expensive.** The model writes whole solutions inside
  its reasoning and runs into the output cap. Use `high: max` only on
  purpose. With GLM, top-level `reasoning_effort` and
  `chat_template_kwargs.reasoning_effort` are equivalent.
- **DeepSeek V4.1 reasoning length varies.** It does not rise steadily
  with the level.
- **DeepSeek V4 Flash can reason inline.** On longer prompts without
  the parameter, reasoning can arrive in the text, ending in
  `</think>`. somora moves it to the thinking channel.

> **Warning:** Always map `off` to the family's lowest level and test
> with a one line prompt: the reasoning must be empty. The `none` that
> switches Qwen off means full reasoning on GLM.

### Notes per family

| Model family | Vision | Tool calls and other notes |
|---|---|---|
| DeepSeek V4 Flash | no | Streams `reasoning_content`, full thinking text in the chat. Tool calls are parsed by the server. |
| DeepSeek V4.1 Flash | native, no `analyze_file` worker needed | `maxTokens: 16384` is an operational budget that includes reasoning. |
| GLM-5.3-Flash | native | Tool calls through the `glm47` parser, reasoning through `glm45`. All four GPUs: an exclusive profile. vLLM applies the sampling values on the server when the request has none (`--generation-config auto`). |
| DeepSeek-V4-Flash-Vision-Exp | yes; small text OCR is shaky, screenshots and charts are fine | Tool calls through the `deepseekv4` parser. Text and agent quality as V4 Flash. Experimental according to DeepSeek. |
| Qwen3.8-Flash-Next | yes | `maxTokens: 16384`, because reasoning otherwise eats short answers. Parsers `qwen3` and `qwen3_xml`. |
| Qwen3.5-397B-A17B | yes | `hermes` tool parser. |
| Qwen3.8-27B | yes | `qwen3_coder` tool parser. |
| Gemma 4 | yes | A prefill memory guard answers 400 on long prompts. somora's reactive compaction handles it. |

### What is special about this engine

- **`contextWindow` is the compaction wall.** somora compacts at
  `compaction.triggerRatio` (default 0.8) of the window, less
  `maxTokens` when set. Use the server's limit, not the model card's.
  With 1000000 configured against a 700k server, the server answers
  `400 ContextWindowExceededError` before somora compacts.
- **A router in front changes the rules.** LiteLLM drops
  `reasoning_effort` unless the model's `allowed_openai_params` lists
  it. Every level then answers 200 with the same amount of reasoning.
  Fix it in the router, then compare `/thinking high` with
  `/thinking low` and the 🧠 count.
- **A self hosted build can be a community runtime.** The DeepSeek V4.1
  row was measured on a community SM120 image with NVMe offload, not on
  stock SGLang. Treat its numbers as that setup's behaviour.
- **vLLM applies the model's `generation_config.json`** when a request
  sends no sampling (`--generation-config auto`, its default). The
  `sampling:` block in somora then documents the value. SGLang does not
  do this.
- **A rejected sampling key is dropped once.** When the server answers
  400 to a sampling parameter, somora retries the request without
  sampling and says so in the chat.
- **Estimated reasoning count.** A server that streams reasoning but
  reports no `reasoning_tokens` gets an estimated 🧠 count with a tilde.

### Which engines can be workers

| Worker | Engines |
|---|---|
| Vision worker for `analyze_file` | `openai-compatible` only |
| REM | `openai-compatible` only |
| Deep, Lucid, compaction | `openai-compatible`, `claude-cli`, `codex-cli` |

`grok-cli` cannot be a worker of any kind.

## Hosted models through OpenRouter

The same `openai-compatible` engine with three differences: reasoning
goes as a nested `reasoning: { effort }` object (set
`reasoning.param: reasoning`), PDFs can go natively (`pdfMode: native`)
and images travel as data URLs.

```yaml
providers:
  openrouter:
    engine: openai-compatible
    baseUrl: https://openrouter.ai/api/v1
    apiKey: "<your key>"
    pdfMode: native
    models:
      - id: anthropic/claude-haiku-4.5
        alias: orhaiku
        contextWindow: 200000
        capabilities: [text, image, pdf]
      - id: minimax/minimax-m3
        alias: minimax3
        contextWindow: 1048576
        capabilities: [text, image, reasoning]
        sampling: { temperature: 1.0, top_p: 0.95, top_k: 40 }
        reasoning: { param: reasoning }
      - id: moonshotai/kimi-k3
        alias: kimi3
        contextWindow: 1048576
        capabilities: [text, image, reasoning]
        reasoning: { param: reasoning }
      - id: deepseek/deepseek-v4-pro-0813
        alias: deep4pro
        contextWindow: 1048576
        capabilities: [text, reasoning]
        sampling: { temperature: 1.0, top_p: 0.95 }
        reasoning: { param: reasoning }
```

| Model | contextWindow | Sampling | Notes | Checked |
|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 200000 | none | Useful as the last, always reachable vision worker in a `vision.worker` chain. The subscription Haiku cannot be one, because CLI engines are not vision workers. Costs API money. | full check |
| `minimax/minimax-m3` | 1048576 | 1.0 / 0.95 / 40 (model card) | Image and video input. Reasoning words `low`, `medium`, `high` match somora's, no `levels` needed. | full check |
| `moonshotai/kimi-k3` | 1048576 | none, on purpose | Moonshot fixes temperature 1.0 and top_p 0.95 on the server and documents "leave the parameters out". Reasoning words `low`, `medium`, `high`. | full check |
| `deepseek/deepseek-v4-pro-0813` | 1048576 | 1.0 / 0.95 | No vision. The hosted big sibling of a local V4 Flash: a good fallback when the local box is off. | full check |

> **Warning:** Watch the fallback. When a hosted key expires, the
> agent's `fallback` model answers the turn. The chat header shows that
> model and the turn carries a fallback chip. Check the header, not
> just the reply.

## Settings

A model entry with every field. Only `id` and `contextWindow` are
required.

```yaml
providers:
  <name>:
    engine: openai-compatible   # claude-cli | codex-cli | grok-cli | openai-compatible
    baseUrl: http://<your-host>:8000/v1
    apiKey: "<key>"
    pdfMode: rasterize
    memoryInjectMode: inline-user
    sendUserTag: true
    models:
      - id: <model-id>
        alias: <alias>
        contextWindow: 262144
        capabilities: [text]
        maxTokens: 16384
        parallelToolCalls: false
        sampling: { temperature: 0.6, top_p: 0.95 }
        reasoning:
          param: reasoning_effort
          levels: { "off": low, high: xhigh }
```

### Model fields

| Field | Default | openai-compatible | claude-cli | codex-cli | grok-cli |
|---|---|---|---|---|---|
| `contextWindow` | required | compaction trigger, worker choice, display. Use the server's limit. | worker choice, display. The native window is right. | worker choice, display. Use the Codex session window, 258400. | worker choice, display |
| `capabilities` | `[text]` | `image` and `pdf` gate attachments, `reasoning` decides whether a thinking level is sent | same | same | same |
| `alias` | none | short name for `model:` in `agent.yaml`, letters, digits, `-` and `_` | same | same | same |
| `reasoning.levels` | unset | somora level to the word the model gets, for `off`, `low`, `medium`, `high`. `null` leaves the parameter out. | not used | applied, for example `xhigh` and `max` | applied |
| `reasoning.param` | `reasoning_effort` | where the word goes: `reasoning_effort`, nested `reasoning` for OpenRouter, or `chat_template_kwargs` | not used | not used | not used |
| `sampling` | unset | sent on every call, dropped once when the server rejects a key | not used | not used | not used |
| `maxTokens` | unset, nothing sent | output cap on every call, dream and compaction workers included | not used | not used | not used |
| `parallelToolCalls` | unset | unset or `false`: one tool call per round. `true` lets a model you trust call several tools at once. | not used | not used | not used |

Keys allowed in `sampling`: `temperature`, `top_p`, `top_k`, `min_p`,
`frequency_penalty`, `presence_penalty`, `repetition_penalty`, `seed`,
`stop`. The [sampling guide](sampling.md) has the details.

### Provider fields

These exist only on an `openai-compatible` provider. The three CLI
engines take `engine` and `models` and nothing else.

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Address of the server's OpenAI style API. |
| `apiKey` | required | The key. Any text for a local server that checks none. |
| `pdfMode` | `rasterize` | `rasterize` sends PDF pages as images and works with every vision model. `native` sends the PDF itself: only for a backend that accepts it. |
| `memoryInjectMode` | `inline-user` | Where recalled notes go: `inline-user` puts them in the user message and keeps the prefix cache, `system` appends them to the system prompt. |
| `sendUserTag` | `true` | Sends `user` on every request so a gateway can group cost per agent and session. `false` withholds it. |

The `user` value that `sendUserTag` sends:

| Request | Value |
|---|---|
| Chat turn | `<agent>/<session>` |
| REM | `<agent>/rem` |
| Deep | `<agent>/deep` |
| Lucid | `lucid/<pass>` |
| Compaction | `<agent>/compaction` |
| Vision worker | `<agent>/analyze_file` |

LiteLLM stores this value in the `end_user` column of its spend logs,
not in `user`.

### Related settings

| Setting | Default | Where | Meaning |
|---|---|---|---|
| `fallback` | unset | `agent.yaml` | One model or an ordered list. Used on every engine when the model fails before it wrote text or ran a tool. |
| `fallback.retryUnavailableMinutes` | 60 | `config.yaml` | A model that was unreachable is skipped for this many minutes. |
| `compaction.triggerRatio` | 0.8 | `config.yaml` | Share of the window at which somora compacts. `openai-compatible` only. |
| `codexCli.directTools` | the everyday core tools | `config.yaml` | somora tools in the Codex model's direct list. Needs a restart. |

## Minimum versions

- Node.js 22.13 or newer. Every `somora` command refuses an older Node.
- A current Claude Code for `claude-cli`.
- Codex needs no separate install. somora bundles the exact version
  pinned in its `package.json`.

A CLI engine's tools and lock-down are checked again after every CLI
update.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `400 ContextWindowExceededError` before somora compacts | `contextWindow` is above the server's limit. Set it to the server's `--context-length` or `--max-model-len`. |
| The header says the context is over full on a Codex model | `contextWindow` is not 258400. |
| A Codex turn fails at once, or a compaction worker crashes | The model id is retired. Remove `gpt-5.4-mini` and `gpt-5.3-codex`. |
| A chat row says the model rejected the reasoning effort | The model does not know the word. Map the level in `reasoning.levels`. The log line is `engine.reasoning_effort_rejected`. |
| Every thinking level gives the same amount of reasoning | A router drops `reasoning_effort`. Allow the parameter in the router. |
| `/thinking off` still reasons | `off` is unmapped and the model thinks by default, or the model treats `none` as full reasoning. Map `off` for that family. |
| A chat row says the sampling parameters were rejected | Remove the key the server names from the model, agent or session sampling. The log line is `engine.sampling_rejected`. |
| Another model answered | The agent's `fallback` took over. The `engine.fail` line in the server log has the reason, for example `401 API key expired`. |

## See also

- [Setup](setup.md): logging in to Claude Code, Codex and Grok, and
  connecting a local server
- [Thinking](thinking.md): thinking levels, vocabularies per model,
  which engines show thinking text
- [Sampling](sampling.md): the sampling keys and where they can be set
- [Compaction](compaction.md): what `contextWindow` controls and which
  model summarises
- [Agents](agents.md): `model` and `fallback` in `agent.yaml`
- [Security](security.md): what a CLI engine can reach inside a somora
  session
