# Compaction — how somora keeps a session inside the context window

A session grows with every turn. Somewhere before it stops fitting into
the model's context window, the older part of the conversation is
folded into a summary and only the recent exchanges travel to the model
verbatim. This page describes when that happens, who does it, which
model does the summarising, and — the part people trip over — what the
per-model `contextWindow` value actually controls on each engine.

Related: [setup.md → Tunables](setup.md#tunables) (the knobs),
[models.md](models.md) (recommended `contextWindow` per model),
[thinking.md](thinking.md), [cache-strategy.md](cache-strategy.md).

## Two kinds of compaction

| | who compacts | when | what you see |
|---|---|---|---|
| `openai-compatible` | **somora** | before a turn, when the prompt reaches `triggerRatio × inputBudget` (default 0.8; the budget is the window minus the answer, and the number is the one the provider measured last) | a `context compacted` row when the reactive path ran; otherwise nothing — the summary is invisible, the recent pairs are verbatim |
| `claude-cli`, `codex-cli`, `grok-cli` | **the CLI itself**, inside its own session/thread | at the CLI's own threshold (codex: its server-delivered session cap) | nothing from somora; the engine's own compaction is opaque to it. The `▣` percentage still tells the truth: codex reports its own `modelContextWindow` per thread, and the prompt size it reports is the prompt, cached part included — adding `cachedInputTokens` to `inputTokens` counted that part twice and drove the badge past 100 % on long threads (fixed 2026-09-11). Anthropic counts the other way round, `input_tokens` EXCLUDES the cached part, so claude-cli sums. |

somora's history file (`sessions/<id>.jsonl`) is never shortened by
either. Compaction only changes what is *sent*; the JSONL stays the
full record, and REM reads it independently.

## The openai-compatible path in detail

1. **Measure.** The number that decides is the one the provider
   reported for this session's last request (`usage.prompt_tokens`,
   kept on the session as `contextTokens`). Only when there is none —
   a new session, a model switch, a provider that omits usage — does
   somora fall back to a character estimate: system prompt, latest
   summary, every user/assistant message after it, and the tool traffic
   (arguments in full, results capped the way the replay caps them), at
   **4 characters per token**.

   That estimate is corrected by what the last request actually cost
   (`tokenRatio`, measured ÷ estimated). Prose runs near 4 characters
   per token; code, JSON and markup near 2.5. Measured on 2026-09-10: an
   estimate of 327,051 against a real 507,905.

   Until 2026-09-10 the estimate counted chat text only. A session made
   of tool traffic looked tiny — 25,982 tokens visible out of 615,329
   actually sent — so it never triggered, ran to 97 % and died at the
   wall.
2. **Trigger.** `tokens >= triggerRatio × inputBudget`, where the input
   budget is `contextWindow − maxTokens` of the **model that will answer
   this turn**. The output reservation comes out of the same window, so
   measuring against the full window lets a session walk into a provider
   400 while every check says it fits: the request that died carried
   507,905 input tokens against a 524,288 window — one token over the
   input budget. Switching a long session from a 1M-window model to a
   131k one triggers a compaction on the next turn; the measured number
   is dropped on a model switch because tokenizers differ.
3. **Range.** Everything after the previous summary up to, but not
   including, the last `safetyCushionPairs` exchanges (default 4) is
   summarised. Unanswered user messages are never folded in. The
   previous summary is passed to the worker as *prior summary*, so the
   result is a rolling summary, not a chain of summaries.
4. **Worker.** See below — a separate model call, one-shot, no tools.
   When the cushion covers the whole session there is nothing to
   summarise; somora then retries once keeping only the last exchange,
   because an aggressive summary beats a turn that cannot run. After a
   compaction the next real reading is checked against the trigger, and
   a compaction that did not clear it is logged rather than assumed to
   have worked.
5. **Persist.** The summary is stored with the timestamp it covers
   (`throughTs`) in the session's meta; later turns replay
   `[summary] + pairs after throughTs`. CLI engines use the same
   record when they rebuild a session (a Codex thread that no longer
   exists, an MCP server rename on claude-cli) — the replay is bounded
   to the most recent 40 exchanges either way.

**Reactive path.** The estimate can be wrong (tool payloads, images, a
backend with a smaller real limit than configured). When a backend
rejects the prompt as too long — `400 "Prompt too long"`, `"maximum
context length"`, oMLX's prefill guard — the engine forces a compaction
down to the last exchange, retries the turn once, and leaves a
`context compacted` engine row. A second refusal surfaces as a
plain-language error (switch model, or `/reset`) instead of the raw
400. This path only runs before anything has streamed and before any
tool has run: retrying later would execute those tools a second time.
Mid-turn the same refusal ends the turn with an explanation, because the
work already done cannot be replayed.

**Either way the refusal is read.** It is the one moment a backend states
its own limits — the window it enforces and how many input tokens it
counted — and somora takes both: the count corrects this session's
estimate, and a reported window smaller than the configured one is logged
with the value to put in `config.yaml`.

## Inside a running turn

Steps 1 to 5 size the conversation *before* the turn. A turn with tools
grows while it runs — every result, every image, and the tool schemas
that travel with each request. Sizing it once is how a turn estimated at
58k tokens reached the backend at over 507k against a 524k window, died
on a raw 400, and lost its work (2026-09-10).

So before **every** request of a turn, somora measures what it is about
to send: all messages, images counted as images rather than as their
base64 length, plus the tool schemas. It compares that against the
window minus the model's output reserve minus a 5% margin. If it does
not fit:

1. **The oldest tool results are shortened** to a one-line notice that
   says the call already ran and must not be repeated. Nothing is
   dropped: an assistant message with `tool_calls` and no matching
   reply is rejected by every OpenAI-compatible backend, and the
   model's own record of what it did is what stops it repeating work.
2. If that is not enough, more recent results follow, **except the
   newest**, which is what the model is reasoning about right now.
3. As a last resort the newest result is **cut**, keeping its beginning
   and labelling the cut.
4. Only when there is nothing left to shorten does the turn stop, with
   an explanation naming the numbers instead of a raw backend error.
   The tool results already produced stay in the session, so nothing
   has to be redone.

A trimmed turn leaves a `context trimmed` engine row, so it is visible
that the model saw less than the full results.

**Reading the numbers.** The chat header shows two different things.
`▣` is occupancy: the prompt size of the turn's **last** request against
the window. `Σ↑` is spend, and the Σ is the point — it sums every
request the turn made. A measured example: 21 tool rounds on a 524k
window read `▣ 62%` (322,878 tokens in the last request) and `Σ↑ 6.0M`
(5,974,097 sent in total, because the context travels with every
request). Both are correct; only the first one says how full it is.

## Which model summarises

`compaction.workers` is an **ordered list** of the models allowed to
summarise, and that order is the cascade — the first entry is asked
first, and a model that is not on the list is never a worker:

```yaml
compaction:
  workers: [gemma4small, deep4flash, glm]
```

Listed entries are honoured as written, including their window: naming
a model means you meant it. An entry that matches no configured alias
or `provider/modelId` is skipped with a `compaction.workers_unresolved`
warning.

Without the list, somora picks automatically **from every configured
model on every engine that has a one-shot path** (claude-cli,
codex-cli, openai-compatible), in this order:

> every model whose `contextWindow >= estimatedTokens × 1.3`,
> **smallest window first**

`compaction.modelOverride` still works and simply goes to the front of
whatever cascade is in play.

**A refusal costs one attempt, not the compaction.** At most
**three** workers are asked per compaction; each failure is logged as
`compaction.worker_failed` with the reason and the next candidate, and
only when all of them refuse does the compaction fail. This matters
because a worker can fail for reasons that have nothing to do with the
summary: a memory guard on a busy host, a route being reloaded, a rate
limit. somora cannot see which machine sits behind which route, so it
does not guess — it asks the next model.

Three consequences worth knowing:

- The worker may be a **subscription-backed CLI model**. If the
  smallest fitting window belongs to a Claude or Codex model, the
  summary is produced through that CLI and counts against that
  subscription. Nothing in the UI says so today. Set `workers` if you
  want the summariser kept to local models.
- A `contextWindow` that is **too high** for what the engine can
  really take makes that model eligible for histories it cannot
  hold; the summarise call then fails or is compacted again by the
  CLI. Too **low** just removes it from the candidate list.
- The history handed to the worker is the *range* above, not the
  whole session, so a 32k local model is a perfectly good worker for a
  session that has been compacting all along.

## What `contextWindow` really controls — per engine

The same per-model field does three different jobs:

| meaning | openai-compatible | claude-cli / codex-cli / grok-cli |
|---|---|---|
| **Compaction trigger** (`triggerRatio ×`) | yes — this is the wall somora compacts against | **no** — the CLI compacts on its own threshold |
| **Worker selection** (smallest fitting window, engine-agnostic) | yes | yes |
| **Usage display** (`X / contextWindow` in TUI header and `agent` SSE end event) | yes | yes |

So on a CLI engine the value never prevents an overflow — it decides
whether that model is picked as a summariser for *other* sessions and
whether the percentage in the header tells the truth. Which is exactly
why it must be the **effective session limit of the CLI**, not the
native API window of the model:

- **codex-cli**: Codex runs a session against a window it delivers
  itself and reports per thread as `modelContextWindow` — **258,400**
  for every model it offers here, measured 2026-09-11 on codex 0.153.3
  (`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`), although the model's
  API window is 1.05M. somora uses that reported number for the header
  as soon as the first turn reports it, so the configured value matters
  before the first turn and for the compaction-worker choice: configure
  `contextWindow: 258400`. A value of 400000 or 1000000 — the obvious
  thing to copy from the model card — makes the header claim "68 %
  free" while codex is already compacting internally, and lets the
  model be picked as a summariser for histories it will refuse.
- **claude-cli**: Claude Code sessions run against the model's real
  window (1M for the Claude 5 family, 200k for Haiku 4.5), so the
  native value is correct here.
- **openai-compatible**: use the **server's** limit, not the model
  card's — vLLM `--max-model-len`, SGLang `--context-length`, oMLX's
  configured length. With 1000000 configured against a 700k backend
  somora only compacts at 800k and the backend answers 400 first.

[models.md](models.md) lists the recommended values per model.

## Knobs

```yaml
compaction:
  triggerRatio: 0.8           # fraction of the input budget (openai-compatible only)
  safetyCushionPairs: 4       # most-recent exchanges never summarised
  # workers: [gemma4small, deep4flash, glm]   # who may summarise, in the order they are tried
  # modelOverride: gemma4big  # pin the summariser (any engine with a one-shot path)
```

Environment overrides `SOMORA_COMPACTION_*` are listed in
[setup.md → Environment overrides](setup.md#environment-overrides).
