# Compaction

A session grows with every turn. Before it stops fitting into the
model's context window, somora folds the older part of the conversation
into a summary and sends only the recent exchanges word for word. This
is called compaction.

## What you get

- **Sessions that never run full.** A long conversation keeps going
  instead of ending in a "prompt too long" error.
- **Nothing is lost on disk.** Compaction only changes what is sent to
  the model. The session file stays the full record.
- **A summary that remembers the work.** It keeps goals, decisions, open
  questions and which tools already ran on which files.
- **You choose who summarises.** Name the models that may write
  summaries, in the order they are tried.
- **A backup when a model is down.** If one summariser refuses, the next
  one is asked.

## Set it up

Compaction works without any setting. Two things are worth doing:

1. Give every model the right `contextWindow`. See
   [What contextWindow controls per engine](#what-contextwindow-controls-per-engine).
2. Name the models that may summarise. Without this list somora may pick
   a subscription model, and the summary then counts against that
   subscription.

```yaml
compaction:
  workers: [<small-local-alias>, <hosted-alias>]
```

## Two kinds of compaction

Who compacts depends on the engine of the model that answers.

| Engine | Who compacts | When | What you see |
|---|---|---|---|
| `openai-compatible` | somora | Before a turn, when the prompt reaches `triggerRatio` times the input budget | Usually nothing. A `context compacted` row when a compaction ran inside or in reaction to a turn |
| `claude-cli`, `codex-cli`, `grok-cli` | The CLI itself, inside its own session | At the CLI's own threshold | Nothing from somora |

The session file `sessions/<id>.jsonl` is never shortened by either
kind. REM reads it independently.

The rest of this page, up to [Which model summarises](#which-model-summarises),
describes the `openai-compatible` path.

## Before a turn

### Measuring the session

somora uses two numbers and takes the larger one:

- **The provider's count.** What the provider reported as prompt size
  for the session's last request. It is dropped when the session
  switches to another model, because tokenizers differ.
- **An estimate.** System prompt, latest summary, every message after
  it, and the tool traffic, at 4 characters per token. Tool arguments
  count in full, tool results up to 800 characters each, the same cap
  the replay uses.

The estimate is corrected by what the last request really cost. Prose
runs near 4 characters per token, code and JSON near 2.5, so somora
keeps the factor "measured divided by estimated" per session and applies
it, limited to between 0.5 and 3.

### The trigger

A compaction runs when the size reaches `triggerRatio` times the input
budget. The input budget is `contextWindow` minus `maxTokens` of the
model that answers this turn. The answer needs room in the same window,
so measuring against the full window would let a session run into a
provider error while every check says it fits.

Switching a long session from a model with a large window to one with a
small window triggers a compaction on the next turn.

### What gets summarised

Everything after the previous summary, up to but not including the last
`safetyCushionPairs` exchanges (default 4). The newest message, the one
being answered, is never part of it. An older message that never got an
answer is included and marked as unanswered.

The previous summary is handed to the summariser, which carries its
points over. The result is one rolling summary, not a chain.

When the last exchanges cover the whole session there is nothing to
summarise. somora then tries once more and keeps only the last exchange.

### What a summary keeps

The summary has seven fixed sections: Goal, Constraints, Decisions,
Recent Context, Open Questions, Work State and Relevant Files. It is
written in the language of the conversation and prefers direct quotes.

Tool calls are not flattened into prose. Each summarised exchange
carries its tool trail: the tool, its key argument such as a path or a
command, and whether it succeeded. A model that continues after the
compaction knows which file it already wrote and which command already
ran.

### Where the summary is stored

The summary is saved in the session's meta data together with the time
it covers. Later turns send the summary plus the exchanges after that
time.

`claude-cli` and `codex-cli` use the same record when they have to
rebuild a session, for example after a Codex thread is gone. That replay
is limited to the 40 most recent exchanges and 60,000 characters.

### When compaction fails

A failed compaction does not stop the turn. The turn runs on the
uncompacted history and the checks described below take over. After a
successful compaction the next real count is compared with the trigger.
If it is still above, a warning is logged.

## When the backend refuses the prompt

The estimate can be wrong, or the backend can have a smaller limit than
configured. When a backend rejects the prompt as too long, somora reacts:

| Situation | What happens |
|---|---|
| Nothing has streamed and no tool has run | somora compacts down to the last exchange, retries the turn once and leaves a `context compacted` row |
| The retry is refused too, or nothing could be compacted | The turn ends with a plain message: switch model with `/model` or start over with `/reset` |
| Tools have already run in this turn | The turn ends with an explanation. The work stays in the session and the next message compacts first |

A turn is not retried after tools have run, because that would run them
a second time.

The refusal is also read. Backends state the window they enforce and the
tokens they counted. The count corrects the session's estimate. A
reported window smaller than the configured one is logged with the value
to put into `config.yaml`.

## Inside a running turn

A turn with tools grows while it runs: every tool result, every image
and the tool definitions travel with each request. So before every
request of a turn, somora measures what it is about to send. Images
count as images, about 1,300 tokens each, not by their encoded length.

The limit is the window minus the model's `maxTokens` (4,096 if unset)
minus a 5% margin. The margin is 15% for a provider that never reports
token counts. If the request does not fit:

1. **The oldest tool results are shortened** to a one-line notice saying
   the call already ran and must not be repeated. The four newest
   results stay.
2. **More recent results follow**, except the newest. That is the one
   the model is working with right now.
3. **The newest result is cut** as a last resort. Its beginning is kept
   and the cut is labelled.
4. **The turn stops** only when nothing is left to shorten, with a
   message that names the numbers. Tool results already produced stay in
   the session.

No message is ever dropped, only shortened, so the model keeps its own
record of what it did. A trimmed turn leaves a `context trimmed` row.

### Builder turns

A [builder](builder.md#long-turns) turn takes one step before trimming.
When the next request no longer fits, the earlier rounds of the turn are
summarised into a work-state block: what was done, what is in progress,
what is blocked, the next move and the relevant files. The task list is
appended. The last six rounds stay word for word.

This leaves a `context compacted` row. It uses `workers` and
`preferSessionModel`, asks at most three models, and falls back to
trimming when none delivers.

## Which model summarises

A summary is a separate, single model call without tools. Three engines
can do it: `openai-compatible`, `claude-cli` and `codex-cli`. A
`grok-cli` model is never a summariser.

### With a workers list

`compaction.workers` is an ordered list. The first entry is asked first,
and a model that is not on the list never summarises. An entry is an
alias, a model id or `provider/modelId`.

Entries are used as written, without a window check: naming a model
means you meant it. An entry that matches no configured model is skipped
with a `compaction.workers_unresolved` warning. If no entry matches at
all, the compaction fails.

### Without a list

somora picks from every configured model on the three engines above:
each model whose `contextWindow` is at least 1.3 times the estimated
size of the summary request, smallest window first.

Three things follow from this:

- **A subscription model may be picked.** If the smallest fitting window
  belongs to a Claude or Codex model, the summary runs through that CLI
  and counts against that subscription. Nothing in the UI says so. Set
  `workers` to keep summaries on local models.
- **A wrong `contextWindow` misleads the pick.** Too high makes a model
  eligible for histories it cannot hold. Too low removes it from the
  candidates.
- **A small model is often enough.** The summariser gets only the range
  to summarise, not the whole session. A 32k local model works well for
  a session that has been compacting all along.

### Session model first

`compaction.preferSessionModel: true` puts the model that is answering
the session in front of the list, session override included. It is used
only when its engine can summarise and its window is at least 1.3 times
the request. The list stays the order behind it.

It is off by default, because a session on a hosted subscription model
would start paying for its own summaries. Switch it on when sessions run
on models that are loaded and answering while the listed workers may not
be, for example on a GPU host that swaps models.

### Pinning one model

`compaction.modelOverride` names one model by alias or model id. It goes
to the front of whatever order is in play, ahead of the session model
and the list. A name that matches nothing is logged as
`compaction.override_unresolved` and the rest of the order is used.

### When a summariser fails

At most three models are asked per compaction. A refusal costs one
attempt, not the compaction: the next model is asked. Only when all of
them refuse does the compaction fail.

A model can fail for reasons that have nothing to do with the summary: a
busy host, a route being reloaded, a rate limit. A model that could not
be reached is remembered as unavailable for
`fallback.retryUnavailableMinutes` (default 60). A model that only
rejected the request is not.

Chat fallback, REM and compaction share this memory. Models marked
unavailable are left out before the three attempts are chosen, unless
that would leave nothing to try. A model that answers is cleared at
once. The memory is not kept across a restart.

## What contextWindow controls per engine

The same per-model field does three jobs:

| Job | `openai-compatible` | `claude-cli`, `codex-cli`, `grok-cli` |
|---|---|---|
| Compaction trigger and in-turn limit | yes | no, the CLI compacts on its own threshold |
| Choice of summariser | yes | yes, except `grok-cli` |
| Usage display in the header | yes | yes |

On a CLI engine the value never prevents an overflow. It decides whether
the model is picked as a summariser for other sessions and whether the
percentage in the header is true. Set it to the limit the engine really
enforces:

| Engine | Set `contextWindow` to | Why |
|---|---|---|
| `codex-cli` | 258400 | Codex runs every session against its own window, which is smaller than the model's API window. |
| `claude-cli` | the model's real window | Claude Code sessions run against it: 1M for the Claude 5 family, 200k for Haiku 4.5. |
| `openai-compatible` | the server's limit | Use vLLM `--max-model-len`, SGLang `--context-length` or oMLX's configured length, not the number on the model card. |

> **Warning:** A value that is too high on `openai-compatible` means
> somora compacts too late. With 1000000 configured against a backend
> that takes 700k, compaction starts at about 800k and the backend
> refuses first.

Codex reports its window per thread as `modelContextWindow`. somora uses
that number for the header from the first turn on, so the configured
value matters before the first turn and for the choice of summariser. A
value copied from the model card makes the header show free space while
Codex is already compacting.

## Reading the numbers

The chat header shows two different things:

| Symbol | Meaning |
|---|---|
| `▣` | How full the window is: the prompt size of the turn's last request against the window. |
| `Σ↑` | How much was sent: the sum over every request the turn made. |

A turn with 21 tool rounds on a 524k window can read `▣ 62%` and
`Σ↑ 6.0M`. Both are correct, because the context travels with every
request. Only the first says how full the window is.

The percentage is counted the same way on every engine: the whole
prompt, cached part included. Codex reports `cachedInputTokens` as part
of its prompt size, so somora does not add it. Claude reports
`input_tokens` without the cached part, so somora adds the cache
numbers.

## Settings

All settings live in `config.yaml` and are optional.

```yaml
compaction:
  triggerRatio: 0.8
  safetyCushionPairs: 4
  # workers: [<small-local-alias>, <hosted-alias>]
  # preferSessionModel: false
  # modelOverride: <alias>
fallback:
  retryUnavailableMinutes: 60
```

| Setting | Default | Meaning |
|---|---|---|
| `compaction.triggerRatio` | 0.8 | Share of the input budget at which a compaction runs. Above 0, at most 1. `openai-compatible` only. |
| `compaction.safetyCushionPairs` | 4 | The most recent exchanges that are never summarised. |
| `compaction.workers` | unset | Models that may summarise, in the order they are tried. Unset means automatic choice. |
| `compaction.preferSessionModel` | false | Ask the session's own model before the workers. |
| `compaction.modelOverride` | unset | One model that is always asked first. |
| `fallback.retryUnavailableMinutes` | 60 | How long an unreachable model is skipped by chat, REM and compaction. 1 to 1440. |

Environment variables override the file:

| Variable | Overrides |
|---|---|
| `SOMORA_COMPACTION_TRIGGER_RATIO` | `compaction.triggerRatio` |
| `SOMORA_COMPACTION_SAFETY_PAIRS` | `compaction.safetyCushionPairs` |
| `SOMORA_COMPACTION_WORKERS` | `compaction.workers`, comma separated |
| `SOMORA_COMPACTION_MODEL` | `compaction.modelOverride` |

## Troubleshooting

| Symptom | Look for | What to do |
|---|---|---|
| The backend still answers "prompt too long" | `engine.context_overflow` in the log, with a hint naming the window the backend enforces | Lower the model's `contextWindow` to that value. |
| Compaction runs every turn | `engine.compaction_ineffective` | The recent exchanges alone are too big. Lower `safetyCushionPairs` or use a model with a larger window. |
| Summaries cost subscription usage | `compaction.worker_chosen` shows a CLI model | Set `compaction.workers`. |
| Compaction fails | `compaction.worker_failed`, `compaction.all_workers_failed`, `compaction.no_model_fits`, `engine.compaction_fail` | Check that the workers are reachable and that one has a large enough window. |
| A listed worker is never asked | `compaction.workers_unresolved` or `model.unavailable` | Fix the name, or wait until the model is tried again. |

## See also

- [Models](models.md): recommended `contextWindow` per model
- [Setup](setup.md#settings): server-level settings in one place
- [Builder](builder.md#long-turns): how long builder turns stay inside
  the window
- [Cache strategy](cache-strategy.md): what is sent in which order and
  why
- [Thinking](thinking.md): reasoning levels per engine
