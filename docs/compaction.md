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
| `openai-compatible` | **somora** | before a turn, when the estimated prompt reaches `triggerRatio × contextWindow` (default 0.8) | a `context compacted` row when the reactive path ran; otherwise nothing — the summary is invisible, the recent pairs are verbatim |
| `claude-cli`, `codex-cli`, `grok-cli` | **the CLI itself**, inside its own session/thread | at the CLI's own threshold (codex: its server-delivered session cap) | nothing from somora; the engine's own compaction is opaque to it |

somora's history file (`sessions/<id>.jsonl`) is never shortened by
either. Compaction only changes what is *sent*; the JSONL stays the
full record, and REM reads it independently.

## The openai-compatible path in detail

1. **Estimate.** Before each turn somora estimates the prompt size:
   system prompt + (latest summary, if any) + every user/assistant
   pair after that summary, at the heuristic **4 characters per
   token**. No tokenizer is involved — the estimate is deliberately
   conservative and only has to answer "are we near the wall".
2. **Trigger.** `estimatedTokens >= triggerRatio × contextWindow` of
   the **model that will answer this turn**. Switching a long session
   from a 1M-window model to a 131k one therefore triggers a
   compaction on the next turn.
3. **Range.** Everything after the previous summary up to, but not
   including, the last `safetyCushionPairs` exchanges (default 4) is
   summarised. Unanswered user messages are never folded in. The
   previous summary is passed to the worker as *prior summary*, so the
   result is a rolling summary, not a chain of summaries.
4. **Worker.** See below — a separate model call, one-shot, no tools.
5. **Persist.** The summary is stored with the timestamp it covers
   (`throughTs`) in the session's meta; later turns replay
   `[summary] + pairs after throughTs`. CLI engines use the same
   record when they rebuild a session (a codex model switch, the MCP
   server rename) — the replay is bounded to the most recent 40
   exchanges either way.

**Reactive path.** The estimate can be wrong (tool payloads, images, a
backend with a smaller real limit than configured). When a backend
rejects the prompt as too long — `400 "Prompt too long"`, `"maximum
context length"`, oMLX's prefill guard — the engine forces a compaction
down to the last exchange, retries the turn once, and leaves a
`context compacted` engine row. A second refusal surfaces as a
plain-language error (switch model, or `/reset`) instead of the raw
400.

## Which model summarises

`compaction.modelOverride` names a model and wins unconditionally.
Otherwise somora picks, **from every configured model on every engine
that has a one-shot path** (claude-cli, codex-cli, openai-compatible):

> the model with the **smallest `contextWindow`** that still satisfies
> `contextWindow >= estimatedTokens × 1.3`

Three consequences worth knowing:

- The worker may be a **subscription-backed CLI model**. If the
  smallest fitting window belongs to a Claude or Codex model, the
  summary is produced through that CLI and counts against that
  subscription. Nothing in the UI says so today. Set `modelOverride`
  if you want the summariser pinned to a local model.
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

- **codex-cli**: Codex caps a GPT-5.6 session at **272k tokens**
  (server-delivered default since Codex 0.144.6; above that OpenAI's
  input-premium tier applies), although the model's API window is
  1.05M. Configure `contextWindow: 272000`. A value of 400000 or
  1000000 — the obvious thing to copy from the model card — makes the
  header claim "68 % free" while codex is already compacting
  internally, and lets the model be picked as a summariser for
  histories it will refuse.
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
  triggerRatio: 0.8           # fraction of contextWindow (openai-compatible only)
  safetyCushionPairs: 4       # most-recent exchanges never summarised
  # modelOverride: gemma4big  # pin the summariser (any engine with a one-shot path)
```

Environment overrides `SOMORA_COMPACTION_*` are listed in
[setup.md → Environment overrides](setup.md#environment-overrides).
