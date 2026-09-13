# Prompt-Cache Strategy

> How somora keeps prefix-cache hit rates high across the three engine
> adapters and the dream worker. Why it matters, how it works, where
> the bodies are buried.

## The problem

Every modern LLM provider implements some form of **prefix cache**:
the inference engine remembers the KV-cache state for the longest
exact-token prefix it has seen recently and reuses it on the next
request. For long-running conversations that share a stable prefix
(system prompt, tools list, accumulated history), the cache turns
re-encoding cost from O(N) to O(new tokens only).

The win is huge:

- **Anthropic** charges 10% of fresh-input price for cached tokens.
  A 20k-token system+history that hits cache costs ~$0.30 instead
  of ~$3.00 per turn on Opus.
- **Local models (mlx-omx, ollama)** save the full pre-encode pass
  on cached tokens. On a local 30B-class model at 30-50 tok/s, a
  20k-token cached prefix means **6-10 seconds less time-to-first-token**.
- **OpenAI** discounts cached input by 50% on supported models.

**The trap:** cache works on **byte-identical prefix matching**. Any
per-turn change in the prompt — even a single character — invalidates
the cache from that point onward. Get the prompt structure wrong and
every turn re-encodes the whole prior conversation.

Memory recall is the most common per-turn variable. Dump it in the
wrong place and cache dies.

## The three-engine landscape

somora has three engine adapters with very different cache mechanics:

| Engine | Backend | Cache scope |
|---|---|---|
| `claude-cli` | Anthropic via SDK, stateful resumed session | SDK manages internal session state; we send only the new user message; Anthropic cache_control on system+tools holds across turns |
| `codex-cli` | OpenAI via the bundled Codex app-server, stateful via `thread/resume <thread_id>` | Codex remembers history internally; we send only new content; Codex's API call to OpenAI gets full prefix cache |
| `openai-compatible` | Anything (mlx-omx, ollama, OpenAI, vLLM, ...), stateless | We reconstruct the full conversation from JSONL on every call; the request must be byte-identical to prior calls for the prefix to match |

The first two are stateful — the underlying CLI/SDK preserves session
state, and we just hand it the next user message. Cache works
naturally because the API call's prefix is whatever the backend
already saw.

`openai-compatible` is the hard case. There's no session resumption.
We rebuild the entire conversation array from JSONL and send it.
Byte-identity across turns is on us.

## What belongs in the prefix vs. the per-turn block

Before asking *where* a block goes, ask whether it changes with the
question:

| | Example | Goes to |
|---|---|---|
| Changes per turn | memory hits for this query | `<memory-context>`, per turn |
| Stable for the session | wiki topology overview, skills registry, persona | system prompt |

Getting this wrong is expensive in a way that hides well. Take the
wiki overview: it is byte-identical on every turn. Carried in the
per-turn memory block it is a duplicate per turn on
`claude-cli`/`codex-cli`, and on `openai-compatible` — where
`buildMessages` replays every past turn — it is re-sent once per turn
*of history*: 900 chars × 27 turns = 24 KB on every single request,
for something that has not changed since turn 1.

The system-prompt version is measurably free after the first turn.
`claude-cli`, fresh session:

```
turn 1   tokens_in 9081   cached  878
turn 2   tokens_in 9696   cached 9079     ← 94% of the prefix
```

The corollary: a block in the prefix must not move. The wiki overview
is snapshotted into `session.meta.json` on the first turn and reused
verbatim afterwards, even after Deep rewrites `index.md`. Freshness
there is worth less than the cache — and recall (`memory_search`,
auto-injection) is live regardless.

## Where memory recall goes per engine

The runtime injects a `<memory-context>...</memory-context>` block per
turn that contains the top-N memory hits for the current query. Each
engine handles it differently:

### claude-cli (stateful)

```ts
// src/engine/claude-cli.ts
const memoryBlock = ephemeralContext ? `${ephemeralContext}\n\n` : '';
const effectiveUserMessage = replayPrefix + memoryBlock + userMessage;

// systemPromptForTurn = systemPrompt unchanged
SDK.query({ systemPrompt, userMessage: effectiveUserMessage });
```

`ephemeralContext` already carries the turn's frame (an A2A header,
a sentinel evidence block) ahead of the recall block, composed by the
server (`src/server/turn-framing.ts`); the adapter adds nothing.
Memory lives at the **start of the new user-message text**. The SDK
sends only the new turn to Anthropic; the persistent system prompt
stays stable across turns; Anthropic's `cache_control` ephemeral
breakpoint on the system block holds. Hits 95-98% cache after the
first turn.

### codex-cli (stateful)

```ts
// src/engine/codex-cli.ts — one app-server process per turn
thread/start | thread/resume { developerInstructions: systemPrompt + tool guidance, dynamicTools, config }
turn/start   { input: [ text: ephemeral + replayPrefix + userMessage, localImage… ], effort }
```

The system prompt travels as Codex *developer instructions* on every
thread start/resume (stable across turns), the tool schemas as dynamic
tools, and only the new turn as user input. Memory lands at the start of
the user text. Codex keeps the thread and sends it to its OpenAI backend
with the right cache shape. Hits ~70–85% cache (128k of 153k input
cached on a six-tool turn).

### openai-compatible (stateless)

This is where it gets interesting. We persist the memory block on
the `user_message` JSONL event — together with the turn's frame (an
A2A header, a sentinel evidence block, the instructions beside a
wake-up; see `user_message` in [api.md](api.md)), which goes in the
same field ahead of the recall block:

```jsonc
{"kind":"user_message","ts":..."text":"the user typed this","ephemeral":"<memory-context>...</memory-context>"}
```

When `buildMessages` rebuilds the conversation for the next API call,
it reads the `ephemeral` field off each historic user_message and
prepends it to the message content:

```ts
// src/engine/openai-compatible.ts:buildMessages()
if (ev.kind === 'user_message') {
  // A row with `origin` carries its A2A header inside `ephemeral`;
  // an older row never stored it, so it is added here as before.
  const headed = ev.origin ? ev.text : withFromAgentHeader(ev.text, ev.from_agent, ev.from_session);
  const composed = ev.ephemeral ? `${ev.ephemeral}\n\n${headed}` : headed;
  // → user message content is byte-identical to what was sent at turn N
}
```

Result: the entire prior conversation reconstructs to the same byte
sequence the backend already cached. Cache match holds across the
full history; only the new user message is fresh.

The trade-off is JSONL size: each user_message stores the recall
block alongside the user-typed text (~500-2000 chars per turn).
Acceptable cost for the cache win.

#### Tool history

Turns that used tools are replayed in the **native** OpenAI shape: an
assistant message carrying `tool_calls`, followed by one `role:'tool'`
message per result.

```jsonc
{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function",
  "function":{"name":"file_write","arguments":"{\"path\":\"tetris.js\"}"}}]}
{"role":"tool","tool_call_id":"c1","content":"{\"ok\":true}"}
{"role":"assistant","content":"Fertig, läuft auf Port 3020."}
```

Flattening those turns to prose is not a neutral simplification. Measured
against a real session history, N=20 per cell: with tool turns
flattened, deepseek-chat produced **0/20** tool calls and deepseek-r1
**1/20**; replaying the native shape lifted them to **14/20** and
**10/20**. A model has no memory beyond what the rebuild hands it, so a
transcript in which the assistant never calls tools is a demonstration
that here, one does not call tools.

Two rules keep providers from rejecting the request:

- every `tool_calls` entry is immediately followed by its matching
  `role:'tool'` message, in order;
- calls with no recorded result are **dropped** — a crashed turn leaves
  exactly that, and an unmatched call is a hard 400 on most backends.

Tool results are capped at `MAX_REPLAYED_TOOL_RESULT_CHARS` (800) each.
Unbounded results are what bloated the context in the first place; the
model can re-read anything it needs by calling the tool again.

This is cache-safe: the reconstruction is deterministic over immutable
JSONL events, so repeated rebuilds of the same history are byte-identical
and the prefix match holds.

### Why a late system message does not work

The obvious alternative — inject memory as a SECOND `role:'system'`
message right before the latest user message, keeping the persistent
system prompt stable — works for stateful engines but **does not work
for stateless openai-compatible**. An instrumented two-turn dump shows
why:

- Turn 1 sent: `[sys persona] [sys eph_v1] [user_eins]`
- Turn 2 sent: `[sys persona] [user_eins] [asst_eins] [sys eph_v2] [user_zwei]`
- Position 1 mismatch (turn 1: sys eph_v1, turn 2: user_eins) → cache stops at position 0

The dynamic memory block "wanders" through the message array as
history grows. Whatever position it sits at now becomes a different
message at that position next turn.

**Lesson:** for stateless prompt-cache, variable content must sit at
the **very end** of the prompt sequence, with no per-turn-changing
content earlier in the byte stream.

JSONL persistence is what makes this hold: by persisting the memory
block on each user_message, the "variable" content for prior turns
becomes effectively stable (frozen at original send-time) on every
subsequent reconstruction.

## Dream-worker cache

The REM extractor (`src/dream/rem-extract.ts`) runs the same problem
in miniature: per-chunk LLM calls send a stable system prompt + a
user message containing transcript + memory + vault. Memory and
vault are computed **once per dream run** and reused across all
chunks. Transcript varies per chunk.

The user message is therefore built stable-first:

```
Agent name: <your-agent>
<existing_memory>... stable ...</existing_memory>     ← cached chunks 2..N
<vault_referenced>... stable ...</vault_referenced>   ← cached chunks 2..N
<transcript>... per-chunk ...</transcript>            ← variable, end of prompt
```

Transcript-first would be the same anti-pattern as above: variable
content shifts the stable blocks to different byte positions across
chunks, and memory + vault (~4-15k tokens combined) are re-encoded
every chunk instead of cached.

For long sessions that chunk into 5+ pieces on local models, this
saves multiple seconds per chunk.

## Configuration

Per-provider on `openai-compatible` providers in `config.yaml`:

```yaml
providers:
  local:
    engine: openai-compatible
    baseUrl: ...
    apiKey: ...
    memoryInjectMode: inline-user      # default — JSONL-persistence + reconstruct
    models: [...]

  some-quirky-backend:
    engine: openai-compatible
    baseUrl: ...
    apiKey: ...
    memoryInjectMode: system           # fallback — concat-onto-system
    models: [...]
```

Two values:

- `inline-user` (default) — memory persisted on each user_message,
  reconstructed byte-identical on every call. Cache-friendly. Works
  for any backend that accepts standard OpenAI Chat Completions
  message arrays.
- `system` — concat-onto-system-prompt. Cache-destructive.
  Only set this if a backend mishandles embedded memory blocks
  inside user-message content (rare).

`claude-cli` and `codex-cli` have no `memoryInjectMode` knob — their
backend is deterministic, the right placement is hardcoded.

## Verifying cache strategy changes

`cached_tokens` reporting in API responses is **unreliable** across
backends:

- mlx-omx returns `cached_tokens: null` even when the cache is
  actively being used (verified via byte-identical direct curl).
  Their dashboard shows hits but the API field stays null.
- OpenAI nests it as `prompt_tokens_details.cached_tokens`.
- Anthropic returns `cache_read_input_tokens` separately.
- Some backends don't report it at all.

**Don't trust cache hit numbers alone.** When changing anything
that affects prompt construction (memory placement, system prompt,
tool list, history reconstruction), instrument the engine adapter
to dump the message array per turn and compare position-by-position
across two consecutive turns. Every position before the new content
should match exactly:

```ts
// temp instrumentation, remove after verification
logger.info({
  msg: 'engine.X.messages_dump',
  messages: messages.map((m, i) => ({
    idx: i,
    role: m.role,
    contentLen: typeof m.content === 'string' ? m.content.length : -1,
    contentHead:
      typeof m.content === 'string' ? m.content.slice(0, 80) : '[non-str]',
  })),
});
```

Run two turns on the same session. Pull both dumps from the server
log. Check that role + length + content-head match at positions
0..N-2; only the last position should differ in turn 2 (the new
user message). If anything earlier diverges, the cache is being
invalidated at that point and the fix isn't right yet.

## Lessons learned

1. **Cache wins are real and worth fighting for** — not just a
   nice-to-have. On Anthropic the cost difference is 10× per cached
   token. On local models the latency difference is the user's
   subjective "this feels fast vs. slow."

2. **Variable content always at the end.** Any per-turn-changing
   block — memory, dynamic context, tool-call updates — must sit at
   the very end of the prompt sequence. If it's earlier, every turn
   invalidates everything after it.

3. **Stateless backends are a different beast** than stateful ones
   (`claude-cli`/`codex-cli`). For stateless, byte-identity across
   reconstructions matters. The cleanest way to guarantee that is
   to **persist what you sent** (in JSONL or equivalent storage)
   and rebuild from that record, not from the source variables.

4. **Don't trust cache-hit numbers from the API alone.** Always
   verify the prompt structure with a position-dump comparison.
   Backends report cache state inconsistently or not at all.

5. **Reference repos don't always have the answer.** OpenClaw and
   Hermes both punt on stateless-openai-compatible cache (Hermes
   relies on Anthropic's cache_control; OpenClaw's bundles are
   minified). Sometimes the right pattern is the one you build
   yourself.

6. **Verify with a two-turn position dump.** A late-system layout
   looks plausible and even passes when judged by `cached_tokens`
   from a single response; only a 2-turn position-dump comparison
   shows the wandering block.

7. **Not every backend has a cache to protect.** Same session, same
   day, three consecutive turns: `claude-cli` reported 94% of the
   prefix cached, while `deepseek-chat` via OpenRouter reported
   `cached_tokens: 0` on every turn. Before trading anything away to
   keep a prefix stable, check that the provider on that path is
   actually caching it.

## Code pointers

| Concern | File |
|---|---|
| `user_message.ephemeral` event field | `src/types/events.ts` |
| Persist ephemeral in JSONL | `src/server/run-turn.ts` (`appendEvent`) |
| Reconstruct from history | `src/engine/openai-compatible.ts` (`buildMessages`) |
| Memory placement claude-cli | `src/engine/claude-cli.ts` (effectiveUserMessage) |
| Memory placement codex-cli | `src/engine/codex-cli.ts` (promptPayload) |
| Turn frame ahead of the recall block | `src/server/turn-framing.ts` (`composeTurnPrefix`) |
| REM worker stable-prefix | `src/dream/rem-extract.ts` (`buildUserMessage`) |
| Wiki-overview snapshot | `src/server/prompt-assembly.ts` (`buildWikiOverviewBlock`) |
| Wiki-overview shortener | `src/memory/manager.ts` (`renderWikiOverview`) |
| `memoryInjectMode` schema | `src/config/types.ts` (`OpenAiCompatibleProviderSchema`) |
