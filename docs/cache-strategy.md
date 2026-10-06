# Prompt cache

Model providers remember the beginning of a prompt they have seen before
and do not process it again. somora builds every request so that this
beginning stays the same from turn to turn. This page explains the
order, what breaks it, and which settings matter.

## What you get

- **Cheaper turns.** Cloud providers bill cached input at a fraction of
  the normal price.
- **Faster first word.** A local model skips re-reading the cached part,
  which saves seconds on a long conversation.
- **Nothing to set up.** The order is built in, for every engine.
- **Recall that does not cost the cache.** Recalled notes change on every
  turn and still leave the earlier conversation cached.
- **A number to watch.** The chat header shows how much of the last
  turn's input came from the cache.

## Check it

Send two messages in the same session and look at the input tokens in
the status line, for example `Σ↑ 12k+80k¢`. The part marked `¢` was read
from the cache. From the second turn on it should cover most of the
input.

To see the system prompt exactly as the next turn sends it, open the
agent's window in the web client and choose **Full prompt**, or call:

```bash
curl 'http://127.0.0.1:18737/agents/<your-agent>/prompt-preview?session=main'
```

The preview never changes the session.

## The one rule

A cache matches from the first character up to the first difference.
Everything after a changed character is processed again.

So the order is always the same: what never changes comes first, what
changes rarely comes next, and what changes on every turn comes last.

| Changes | Example | Where it goes |
|---|---|---|
| Never or rarely | persona, team, wiki overview, skills | system prompt |
| Per session | session name, pinned project | end of the system prompt |
| Every turn | recalled notes, the frame of the turn | in front of the user message |

## Order of the system prompt

The system prompt is put together from eight parts, in this order:

| # | Part | Changes when |
|---|---|---|
| 1 | Self-pointer: who the agent is, its paths and resources | resources or paths change in the config |
| 2 | Persona: `SOUL.md`, `AGENTS.md`, `USER.md` | you edit one of the files |
| 3 | Team block | `team.yaml` or the list of agents changes |
| 4 | Tool reminder | never (constant text) |
| 5 | Wiki overview | never within a session |
| 6 | Skills list | a skill is added, removed or its description edited |
| 7 | This session | never within a session |
| 8 | Project | the session's project is switched or the project is updated |

Parts 1 to 6 are the same for all sessions of one agent, so a provider
can reuse them across sessions. The project is last because it is the
part most likely to change in the middle of a session.

A sub-agent turn adds one note to part 1. Empty parts are left out: no
team, no wiki, no pinned project.

Tool definitions are not part of this text. They travel in the tool
channel of the API and stay the same as long as the set of tools does.

### The wiki overview is frozen

The wiki overview is read on the first turn of a session and stored with
the session. Later turns reuse the stored text, even after Deep has
rewritten the wiki index. A fresh map in the middle of a session would
change a block in front of the whole conversation.

Recall is not affected: automatic recall and `memory_search` always use
the live index. A new session, or a reset of the current one, gets a new
overview.

### Builder agents

A builder (`kind: builder`) has a different system prompt with the same
idea: identity and environment, harness rules, compact team, the
builder's own rules, repository instructions, skills, session, project.

The environment block names the model and today's date, so a builder's
prefix changes when either does. A builder gets no automatic recall
block.

## Where the per-turn block goes

Everything that belongs to one turn only is collected in one block and
placed in front of the user's text, never in the system prompt. In
order:

1. the Lucid review block, while a review is open
2. the frame of the turn: the header of a message from another agent, a
   sentinel's evidence, the instructions beside a wake-up
3. the `<memory-context>` block with the recalled notes

How that block reaches the model depends on the engine.

| Engine | Conversation is kept by | System prompt is sent | The user message contains |
|---|---|---|---|
| `claude-cli` | the Claude session, resumed | every turn, unchanged | catch-up, per-turn block, your text |
| `codex-cli` | the Codex thread, resumed | as developer instructions on every thread start and resume | attachment notes, per-turn block, project block on a resumed thread, catch-up, your text |
| `grok-cli` | the Grok session, resumed | once, as the start of the first message | system prompt on a fresh session, per-turn block, project block on a resumed session, attachments, your text |
| `openai-compatible` | somora, rebuilt from the session file on every request | every request, as the one system message | per-turn block, your text |

"Catch-up" is the summary of turns another engine answered, sent when
you switch engines within a session.

The first three engines keep the conversation themselves. somora only
sends the new turn, and the provider's cache covers the rest.

On `codex-cli` and `grok-cli` a resumed conversation also gets the
project block in front of the user message, so the model sees a new pin
at once.

## The openai-compatible engine

This engine has no session on the provider's side. somora sends the
whole conversation on every request, and it must come out identical each
time.

### Recalled notes are stored with the message

The per-turn block is saved in the session file next to the message it
was sent with, in the field `ephemeral` of the `user_message` event:

```jsonc
{"kind":"user_message","ts":...,"text":"what you typed","ephemeral":"<memory-context>...</memory-context>"}
```

When the conversation is rebuilt, each earlier user message gets its own
stored block back in front of its text. The request for turn 6 therefore
starts with exactly what was sent for turn 5. Only the new message is
new.

The price is a larger session file: each user message also stores its
block, typically 500 to 2000 characters.

Two things keep the blocks from piling up. A section that is still in
the conversation is not injected again (`memory.autoInject.skipRepeats`).
And after a pause longer than the provider's
`dropMemoryBlocksAfterIdleMinutes`, the earlier blocks are dropped from
the rebuilt conversation, once. The cache has expired by then, so the
one changed prefix costs nothing extra; from the next turn on the cache
holds again.

### Why not a second system message

Putting the recalled notes in a late system message looks cleaner and
does not work here. On turn 1 the block sits at position 2. On turn 2 it
sits at position 4, and position 2 now holds the first user message. The
cache stops matching right after the system prompt.

Some model servers also accept a system message only at the very start.
For the same reason the compaction summary is appended to the one system
message and is not sent as a second one.

### Tool calls in the history

Earlier turns that used tools are replayed in the native shape: an
assistant message with `tool_calls`, then one `role: tool` message per
result.

```jsonc
{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function",
  "function":{"name":"file_write","arguments":"{\"path\":\"notes.md\"}"}}]}
{"role":"tool","tool_call_id":"c1","content":"{\"ok\":true}"}
{"role":"assistant","content":"Done, the file is written."}
```

Three rules apply:

- Each call is followed directly by its result, in order.
- A call without a recorded result is dropped. A crashed turn leaves
  such calls, and most providers reject them.
- Each replayed result is cut to 800 characters
  (`MAX_REPLAYED_TOOL_RESULT_CHARS`, a fixed value). The model can call
  the tool again when it needs the full output.

The native shape matters for more than the cache. A history in which the
assistant never calls a tool teaches a weaker model not to call tools.

The rebuild is deterministic: the same session file gives the same
request, so the cache holds.

## What breaks the cache

| Event | Effect |
|---|---|
| Editing `SOUL.md`, `AGENTS.md` or `USER.md` | Everything after the self-pointer is processed again, once. |
| Changing `team.yaml`, adding or removing an agent | Once, from the team block on. |
| Adding, removing or editing a skill | Once, from the skills list on. |
| Switching or updating the session's project | Once, from the project block on. The parts before it stay cached. |
| Changing the set of tools an agent sees | Once. Tool definitions sit in front of the conversation. |
| A compaction on `openai-compatible` | Once. The summary joins the system message and the older messages are dropped. |
| Switching the model or provider of a session | The new model starts with an empty cache. |
| `memoryInjectMode: system` | Every turn. The system prompt changes with each recall. |
| A long pause | Providers drop a cache after some idle time. |

All but the last two are one-time costs. Avoid editing persona files or
skills in the middle of a long, expensive session if the cost matters.

## The dream worker

REM reads a long session in chunks, one model call per chunk. Each call
uses the same order: what is the same for the whole run comes first, the
chunk comes last.

```
Agent name: <your-agent>
<existing_memory>...</existing_memory>             same for every chunk
<wiki_index>...</wiki_index>                       same for every chunk
<wiki_relevant_pages>...</wiki_relevant_pages>     same for every chunk
<vault_referenced>...</vault_referenced>           same for every chunk
<transcript>...</transcript>                       differs per chunk
```

From the second chunk on, everything above the transcript can come from
the cache.

## Settings

All settings live in `config.yaml`. The values shown are the defaults.

```yaml
providers:
  local:
    engine: openai-compatible
    baseUrl: ...
    apiKey: ...
    memoryInjectMode: inline-user
    dropMemoryBlocksAfterIdleMinutes: 60
    models: [...]

agentLoop:
  toolUsageReminder: true

wiki:
  search:
    overviewMaxChars: 4000
    overviewTopNSlugs: 30
```

| Setting | Default | Meaning |
|---|---|---|
| `providers.<name>.memoryInjectMode` | `inline-user` | Only for `openai-compatible` providers. `inline-user` puts the per-turn block in front of the user message and keeps the cache. `system` appends it to the system prompt and loses the cache on every turn. |
| `providers.<name>.dropMemoryBlocksAfterIdleMinutes` | `60` | Only for `openai-compatible` providers. After this many minutes without a turn, the earlier memory blocks are dropped from the rebuilt conversation. Match it to the provider's cache lifetime. `0` keeps them. |
| `agentLoop.toolUsageReminder` | `true` | Adds the constant tool reminder to the system prompt when the agent has tools. Switching it changes the prefix once. |
| `wiki.search.overviewMaxChars` | `4000` | Size limit of the wiki overview. A larger value means a larger constant prefix, paid once per session. |
| `wiki.search.overviewTopNSlugs` | `30` | Most sections listed when the overview falls back to section names and counts. |

Set `memoryInjectMode: system` only for a model server that mishandles
a memory block inside user messages. `claude-cli`, `codex-cli` and
`grok-cli` have no such setting: the placement is fixed.

## Where the numbers come from

| Engine | Field read from the provider |
|---|---|
| `claude-cli` | `cache_read_input_tokens` |
| `codex-cli` | `cachedInputTokens` |
| `grok-cli` | `cachedReadTokens` |
| `openai-compatible` | `prompt_tokens_details.cached_tokens` |

somora passes the value on as `tokens_in_cached` in the usage of a turn.
It is a part of `tokens_in`, not an addition to it.

## Troubleshooting

**The cached part is always zero.** Not every provider caches, and not
every provider that caches reports it. Some local servers use their
cache and still report nothing. Check the provider's own dashboard or
compare the time to the first word before you change anything.

**The cached part drops to almost nothing on every turn.** Look for
`memoryInjectMode: system` on the provider. Then check whether something
in the system prompt changes between turns: call the prompt preview
twice and compare the two results.

**The cached part drops once and recovers.** That is one of the one-time
events under [What breaks the cache](#what-breaks-the-cache).

**You changed how prompts are built and want proof.** A cached-token
number from one response is not enough. Run two turns in one session and
compare the two requests message by message. Every position before the
new user message must be identical in role and content.

## See also

- [Memory](memory.md): the recall block and its settings
- [Wiki](wiki.md): the overview block and how it shrinks for a large wiki
- [Projects](projects.md): the project block at the end of the system
  prompt
- [Team](team.md): the team block
- [Skills](skills.md): the skills list
- [Builder](builder.md): the builder's system prompt in detail
- [Compaction](compaction.md): when older messages are replaced by a
  summary
- [Models](models.md): provider fields, including `memoryInjectMode`
- [Display](display.md): the token figures in the status line
- [API](api.md): `GET /agents/:agent/prompt-preview` and the
  `user_message` event
