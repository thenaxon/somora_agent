# Models known to run with somora — per engine, with the settings that work

Configuring a model for somora is not "the model", it is "the model
behind this engine": the same GPT-5.6 has a different usable context
through Codex than through an API, Qwen wants `xhigh` where somora says
`high`, Kimi refuses sampling parameters, and a value copied from a
model card can quietly mis-size the compaction worker. This page
collects what has been verified against real somora installs — the
recommended `config.yaml` block per model, and *why* each value is what
it is. It is maintained by hand; the **verified** column says when a
row was last checked. Corrections and new rows are welcome as pull
requests.

Field semantics are explained once, at the end of the page, in
[What each field does, per engine](#what-each-field-does-per-engine).
Read [compaction.md](compaction.md) for the `contextWindow` story in
depth.

Aliases below are suggestions — pick your own.

---

## claude-cli — Claude Code subscription

Runs through the Claude Agent SDK on your `claude login`. No API key,
no sampling knobs (the CLI does not expose them), reasoning via the
SDK's effort levels.

```yaml
providers:
  anthropic:
    engine: claude-cli
    models:
      - id: claude-fable-5-1
        alias: fable
        contextWindow: 1000000
        capabilities: [text, image, pdf, reasoning]
      - id: claude-opus-5
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

| model | contextWindow | notes | verified |
|---|---|---|---|
| `claude-fable-5-1` | 1000000 | Frontier model, adaptive thinking always on. The SDK discloses **no thinking text** for it — somora shows a placeholder row that the model thought ([thinking.md](thinking.md#thinking-content--seeing-what-the-model-thought)). No separate reasoning-token count (rolled into `tokens_out`). | 2026-09-03 |
| `claude-opus-5` | 1000000 | Anthropic's recommendation for most workloads. Thinking text: placeholder, as above. | 2026-09-03 |
| `claude-sonnet-5` | 1000000 | Same surface as Opus, cheaper on the subscription budget. | 2026-09-03 |
| `claude-haiku-4-5` | 200000 | Does support extended thinking — keep `reasoning` in `capabilities`, it is missing from most example configs. | 2026-09-03 |

**Peculiarities of this engine**

- `contextWindow` is the model's real window here: Claude Code sessions
  run against it and compact on their own. The value only feeds the
  compaction-worker choice and the header percentage.
- Tools reach the model through `ToolSearch` (Claude Code 2.1.142+):
  somora's tools are discovered on demand, so the first call in a
  session is preceded by a `ToolSearch` row. Normal.
- `thinking` levels map to the SDK's `effort`; `off` disables thinking.
  `reasoning.levels` is honoured but rarely needed — the vocabulary is
  already `low | medium | high`.
- The claude.ai connectors (Gmail, Calendar, Drive) never exist inside
  a somora session ([security.md](security.md)).

## codex-cli — ChatGPT subscription

Runs the **bundled** Codex (`@openai/codex`, exact version pinned in
somora's package.json) as an app-server per turn, on your `codex login`.
somora hands its tools to Codex as *dynamic tools* — no MCP child, no
deferred-namespace guessing — so every model Codex offers (gpt-5.5,
the GPT-5.6 family, GPT-6) reaches the same tool set the other engines
see. A global `codex` on the host is not used; `somora codex login`
signs in with the bundled one, and an existing `codex login` is picked
up automatically ([setup.md](setup.md#codex)).

```yaml
providers:
  openai:
    engine: codex-cli
    models:
      - id: gpt-5.6-sol
        alias: gpt56
        contextWindow: 272000          # Codex session cap, NOT the 1.05M API window
        capabilities: [text, image, pdf, reasoning]
        reasoning:
          levels: { high: xhigh }      # optional: /thinking high → codex xhigh
      - id: gpt-5.6-terra
        alias: terra
        contextWindow: 272000
        capabilities: [text, image, pdf, reasoning]
      - id: gpt-5.6-luna
        alias: luna
        contextWindow: 272000
        capabilities: [text, image, pdf, reasoning]
```

| model | contextWindow | notes | verified |
|---|---|---|---|
| `gpt-5.6-sol` | 272000 | Flagship — complex coding, research, deepest reasoning. | 2026-09-03 |
| `gpt-5.6-terra` | 272000 | Workhorse; OpenAI positions it as GPT-5.5-class at lower cost. | 2026-09-03 |
| `gpt-5.6-luna` | 272000 | Fast and cheap — extraction, classification, volume. | 2026-09-03 |
| `gpt-5.5` | — | Still listed by Codex; Terra is the equivalent at lower cost. | 2026-09-03 |
| `gpt-5.4-mini`, `gpt-5.3-codex` | — | **Retired** for ChatGPT accounts (Codex answers with an error, seen 2026-08-31 as an `exit 1` compaction-worker crash). Remove them. | 2026-08-31 |

**Peculiarities of this engine**

- **The 272k cap is the important number on this page.** Codex caps a
  GPT-5.6 session at 272k tokens (server-delivered default since Codex
  0.144.6; above that OpenAI's input-premium tier), while the API
  window is 1.05M. The information is not on the model card — it lives
  in Codex GitHub issues and release notes. With 400000 or 1000000
  configured, the header percentage lies and the model becomes
  eligible as a compaction summariser for histories it will refuse.
- Codex compacts the thread itself; somora's `triggerRatio` does not
  apply. `contextWindow` feeds worker choice and display only.
- Reasoning vocabulary is `minimal | low | medium | high | xhigh |
  max` for the GPT-5.6 family. somora's `high` is sent as `high`
  unless you map it (`levels: { high: xhigh }`). `max` is documented
  by OpenAI for the hardest problems with cost and latency to match —
  map it in a session when you need it, not as a default.
- Tools are a **deferred namespace** (`mcp__somora`): the model must
  call `tool_search` before it can use them. It does so reliably for
  concrete tasks; asked "which tools do you have" it cannot enumerate
  them. Since Codex 0.144.6, well before somora's MCP rename.
- Thinking text: Codex emits reasoning *summaries*, and only on the
  first turn of a thread (0.151 sends none on resumed threads).
- **Code Mode (Codex ≥ 0.153).** The GPT-5.6 family and GPT-6 run
  with `tool_mode=code_mode_only`: every tool, MCP tools included, is
  reached through a code-mode `exec` tool that Codex's built-in
  code-mode host executes. somora therefore no longer disables
  `code_mode_host` (it did until 2026-09-05, which left those models
  without a single somora tool — each turn opened with an `error`
  item "Code Mode is unavailable because code-mode host is disabled").
  Older models (gpt-5.5) and older Codex versions are unaffected either
  way: they never route through the host. After a Codex upgrade, check
  one turn per configured Codex model calls `time_now`; the server log
  now flags Codex `error` items as `engine.codex_error_item`.
- `functions.apply_patch` stays visible to the model — the model
  catalog drives it and Codex has no switch ([security.md](security.md)).
- A retired model does not fail loudly: the turn errors out with the
  flattened HTTP error in the chat. Check `codex debug models` when a
  model stops answering after a Codex update.

## grok-cli — SuperGrok / Premium subscription

Driven over ACP. Community-maintained adapter, text attachments only,
no one-shot path (it cannot be a dream or compaction worker).

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

| model | contextWindow | notes | verified |
|---|---|---|---|
| `grok-4.5` | 500000 | Effort levels pass through `--reasoning-effort`; `reasoning.levels` honoured. Thinking-text path unverified (no account on the maintainer's side). | 2026-08-25 |

## openai-compatible — self-hosted (vLLM, SGLang, oMLX, Ollama, LM Studio)

The engine somora owns end to end: its own agent loop, sampling
parameters, per-model reasoning vocabulary, compaction trigger. The
values below are the vendor-recommended defaults for each model family,
applied through somora's `sampling:` block ([sampling.md](sampling.md)).

```yaml
providers:
  local:
    engine: openai-compatible
    baseUrl: http://<your-host>:8000/v1
    apiKey: "<key or anything for a local server>"
    models:
      - id: deepseek-v4-flash             # SGLang
        alias: deep4flash
        contextWindow: 700000             # = the server's --context-length, not the model's 1M
        capabilities: [text, reasoning]
        sampling: { temperature: 1.0, top_p: 0.95 }
        reasoning:
          levels: { medium: high, high: max }
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

| model family | server | contextWindow | sampling | reasoning | notes | verified |
|---|---|---|---|---|---|---|
| **DeepSeek V4 Flash** (284B MoE, 13B active) | SGLang, TP=4 | the server's `--context-length` (700000 on a two-GPU profile; 1M only with the whole box) | 1.0 / 0.95 (DeepSeek's agentic/coding recommendation) | vocabulary `low`, `high`, `max`; unknown values are ignored, not rejected → map `high: max`. `off`: omitting the parameter and sending `none` both give 0 reasoning tokens (measured 2026-09-05), so no `off` mapping is needed; `low` reasons via `reasoning_content` (84 tokens on a one-line prompt). On longer prompts without the parameter the reasoning can land inline in the text (`…</think>`); somora splits that into the thinking channel. | no vision; streams `reasoning_content`, full thinking text in the chat; tool calls parsed server-side | 2026-09-05 |
| **Qwen3.8-Flash-Next** FP8 (176B / 6B active) | vLLM, TP=4 | `--max-model-len`, 524288 with YaRN 2.0 | 0.6 / 0.95 / 20 / min_p 0 (Qwen thinking-mode defaults) | knows no `high` → **400** unless mapped; `none low medium xhigh` accepted; **unset = model default = thinks** (61 reasoning tokens on a one-line prompt, `low` 55, `xhigh` 60, `none` 0, measured 2026-09-05) → map `off: none`, `high: xhigh` | vision verified; `maxTokens: 16384` because reasoning otherwise eats short answers; parsers `qwen3` + `qwen3_xml` | 2026-09-05 |
| **Qwen3.5-397B-A17B** AWQ INT4 | vLLM, TP=4 | 262144 (`max_model_len`) | same as above | as above, but `none` **unverified** on this backend — keep `off: low` until probed | vision verified; hermes tool parser | 2026-09-03 |
| **Qwen3.8-27B** FP8, dense | vLLM, 1 GPU | 262144 | same as above | as above, `none` **unverified** — keep `off: low` until probed | vision; `qwen3_coder` tool parser verified | 2026-09-03 |
| **Gemma 4** 31B / 26B-A4B | oMLX | 131072 | 1.0 / 0.95 / 64 (Gemma team recommendation) | none — no `reasoning` capability | vision; prefill memory guard answers 400 on long prompts → somora's reactive compaction handles it | 2026-09-03 |

**Peculiarities of this engine**

- `contextWindow` **is** the compaction wall here (`triggerRatio`,
  default 0.8). Use the *server's* limit, not the model card's: a 1M
  value against a 700k backend meant `400 ContextWindowExceededError`
  before somora ever compacted.
- **A router in front changes the rules.** LiteLLM drops
  `reasoning_effort` unless the model's `allowed_openai_params`
  includes it — every level then answers 200 with identical reasoning
  volume and somora's retry-on-400 never fires. Fix it in the router,
  then verify with `/thinking high` vs `/thinking low` and the 🧠
  count ([thinking.md](thinking.md)).
- Backends that stream reasoning but report no `reasoning_tokens` get
  an **estimated** 🧠 count with a tilde.
- `analyze_file` (vision worker) and the dream workers use this engine
  only — a CLI-engine model cannot be a vision worker.

## openai-compatible — hosted via OpenRouter

Same engine, `wire`-specific details: reasoning goes as a nested
`reasoning: { effort }` object (`reasoning.param: reasoning`), PDFs can
go native (`pdfMode: native`), image references travel as data URLs.

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

| model | contextWindow | sampling | notes | verified |
|---|---|---|---|---|
| `anthropic/claude-haiku-4.5` | 200000 | — | Useful as the **last, always-reachable vision worker** in a `vision.worker` chain — the subscription Haiku cannot be one (CLI engines are not vision workers). Costs API money. | 2026-09-03 |
| `minimax/minimax-m3` | 1048576 | 1.0 / 0.95 / 40 (model card) | image and video input; vocabulary `low/medium/high` = somora's default, no `levels` needed | 2026-09-03 |
| `moonshotai/kimi-k3` | 1048576 | **none — on purpose.** Moonshot fixes temperature 1.0 / top_p 0.95 server-side and documents "leave the parameters out". | vocabulary `low/medium/high` | 2026-09-03 |
| `deepseek/deepseek-v4-pro-0813` | 1048576 | 1.0 / 0.95 | no vision; the hosted big sibling of a local V4 Flash — a good fallback when the local box is off | 2026-09-03 |

## What each field does, per engine

| field | openai-compatible | claude-cli | codex-cli | grok-cli |
|---|---|---|---|---|
| `contextWindow` | compaction trigger (`triggerRatio ×`), worker choice, display — use the **server's** limit | worker choice, display — native window is right | worker choice, display — use the **Codex session cap** (272k), not the API window | worker choice, display |
| `capabilities` | gates attachments (`image`, `pdf`) and whether `thinking` is sent (`reasoning`) | same | same | same |
| `reasoning.levels` | somora level → wire value (Qwen `xhigh`, DeepSeek `max`) | honoured (rarely needed) | honoured — `xhigh`/`max` for GPT-5.6 | honoured |
| `reasoning.param` | `reasoning_effort` (default) or nested `reasoning` for OpenRouter | — | — | — |
| `sampling` | sent on every call, dropped once if the backend rejects a key | ignored (not exposed by the CLI) | ignored | ignored |
| `maxTokens` | output cap on every call incl. dream workers | — | — | — |
| `fallback` | availability chain on unreachable / 5xx | same | same | same |

**Minimum versions** (from v2026.09.03.06 / .09): Node.js ≥ 22.13,
Codex CLI ≥ 0.148, a current Claude Code. A CLI engine's tools and
lock-down are re-audited after every CLI update
([security.md](security.md)).
