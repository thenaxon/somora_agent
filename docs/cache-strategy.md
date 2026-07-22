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
  on cached tokens. On gemma4big at 30-50 tok/s, a 20k-token cached
  prefix means **6-10 seconds less time-to-first-token**.
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
| `codex-cli` | OpenAI via codex binary, stateful via `codex exec resume <thread_id>` | codex remembers history internally; we send only new content; codex's API call to OpenAI gets full prefix cache |
| `openai-compatible` | Anything (mlx-omx, ollama, OpenAI, vLLM, ...), stateless | We reconstruct the full conversation from JSONL on every call; the request must be byte-identical to prior calls for the prefix to match |

The first two are stateful — the underlying CLI/SDK preserves session
state, and we just hand it the next user message. Cache works
naturally because the API call's prefix is whatever the backend
already saw.

`openai-compatible` is the hard case. There's no session resumption.
We rebuild the entire conversation array from JSONL and send it.
Byte-identity across turns is on us.

## Where memory recall goes per engine

The runtime injects a `<memory-context>...</memory-context>` block per
turn that contains the top-N memory hits for the current query. Each
engine handles it differently:

### claude-cli (stateful)

```ts
// src/engine/claude-cli.ts
const memoryBlock = ephemeralContext ? `${ephemeralContext}\n\n` : '';
const effectiveUserMessage =
  replayPrefix + memoryBlock + withFromAgentHeader(userMessage, fromAgent);

// systemPromptForTurn = systemPrompt unchanged
SDK.query({ systemPrompt, userMessage: effectiveUserMessage });
```

Memory lives at the **start of the new user-message text**. The SDK
sends only the new turn to Anthropic; the persistent system prompt
stays stable across turns; Anthropic's `cache_control` ephemeral
breakpoint on the system block holds. Hits 95-98% cache after the
first turn.

### codex-cli (stateful)

```ts
// src/engine/codex-cli.ts
const ephemeralBlock = ephemeralContext ? `${ephemeralContext}\n\n---\n\n` : '';
const promptPayload = resumeId
  ? `${ephemeralBlock}${replayPrefix}${taggedUserMessage}`
  : `${systemPrompt}\n\n---\n\n${ephemeralBlock}${replayPrefix}${taggedUserMessage}`;

codex_exec[--json][resume <id>] < stdin promptPayload
```

codex has no separate `--system` CLI flag — everything goes in via
stdin as the user-message payload. Memory lands at the end of the
payload (before the actual user text). codex remembers prior payloads
internally and sends them to its OpenAI backend with the right cache
shape. Hits ~70% cache.

### openai-compatible (stateless)

This is where it gets interesting. We persist the memory block on
the `user_message` JSONL event:

```jsonc
{"kind":"user_message","ts":..."text":"the user typed this","ephemeral":"<memory-context>...</memory-context>"}
```

When `buildMessages` rebuilds the conversation for the next API call,
it reads the `ephemeral` field off each historic user_message and
prepends it to the message content:

```ts
// src/engine/openai-compatible.ts:buildMessages()
if (ev.kind === 'user_message') {
  const headed = withFromAgentHeader(ev.text, ev.from_agent);
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

#### Tool-execution evidence

The rebuild also emits a compact record of the tool calls each past turn
made, ahead of that turn's assistant text:

```text
<somora-tool-log>
183 Aufrufe:
- file_write ×5 → ok (server.js, index.html, style.css)
- exec ×173 → ok (npm install, curl -I http://localhost:3000, lsof -i :3000)
- web_search → ok (tetris scoring rules)
</somora-tool-log>
```

Without it the rebuilt conversation contains only prose, and a model
reading its own transcript finds no evidence it ever called a tool —
weaker models then stop calling tools entirely, mid-session. Grouping is
per tool, so even extreme turns stay small: a 183-call turn renders as
five lines (~140 tokens, measured).

The block rides in an assistant-role message (a per-turn `system`
message would break the strict user/assistant alternation some local
backends require), so the tag is load-bearing: without it a model reads
the block as its own prose. The first live test of this feature had
claude-haiku apologise for "inventing this notation and not actually
calling a tool". What the tag means is stated once in the system prompt
(`agentLoop.toolUsageReminder`) rather than repeated per block.

This is cache-safe by construction. The record derives deterministically
from immutable JSONL events, in event order, so every rebuild of the
same history produces the identical byte sequence — the prefix match
holds exactly as it did before. The one-time cost is that histories
recorded before this landed rebuild differently than they did on the
previous turn, so the first turn after upgrading misses cache.

The same record is attached to cross-engine replay pairs
(`src/engine/replay.ts`), for the same reason: a catch-up block made of
pure prose teaches the incoming engine that nobody here uses tools.

### Why we tried "late-system" first and reverted

A first-pass fix (commit `49c682a`) injected memory as a SECOND
`role:'system'` message right before the latest user message,
keeping the persistent system prompt stable. That works for stateful
engines but **does not work for stateless openai-compatible** —
verified via instrumented two-turn dump:

- Turn 1 sent: `[sys persona] [sys eph_v1] [user_eins]`
- Turn 2 sent: `[sys persona] [user_eins] [asst_eins] [sys eph_v2] [user_zwei]`
- Position 1 mismatch (turn 1: sys eph_v1, turn 2: user_eins) → cache stops at position 0

The dynamic memory block "wanders" through the message array as
history grows. Whatever position it sits at now becomes a different
message at that position next turn.

**Lesson:** for stateless prompt-cache, variable content must sit at
the **very end** of the prompt sequence, with no per-turn-changing
content earlier in the byte stream.

The JSONL-persistence approach (commit `cb9f429`) was the actual
fix — by persisting the memory block on each user_message, the
"variable" content for prior turns becomes effectively stable
(frozen at original send-time) on every subsequent reconstruction.

## Dream-worker cache

The dream extractor (`src/dream/extract.ts`) runs the same problem
in miniature: per-chunk LLM calls send a stable system prompt + a
user message containing transcript + memory + vault. Memory and
vault are computed **once per dream run** (in `extractFromSession`)
and reused across all chunks. Transcript varies per chunk.

The original ordering was:

```
Agent name: <your-agent>
<transcript>... per-chunk ...</transcript>     ← variable
<existing_memory>... stable ...</existing_memory>
<vault_referenced>... stable ...</vault_referenced>
```

Same anti-pattern: variable content shifts the stable blocks to
different byte positions across chunks. Memory + vault (~4-15k
tokens combined) re-encoded every chunk instead of cached.

Fix (commit `19528a7`): reorder to stable-first.

```
Agent name: <your-agent>
<existing_memory>... stable ...</existing_memory>     ← cached chunks 2..N
<vault_referenced>... stable ...</vault_referenced>   ← cached chunks 2..N
<transcript>... per-chunk ...</transcript>            ← variable, end of prompt
```

For long sessions that chunk into 5+ pieces on local models, this
saves multiple seconds per chunk.

## Configuration

Per-provider on `openai-compatible` providers in `config.yaml`:

```yaml
providers:
  omlx:
    engine: openai-compatible
    baseUrl: ...
    apiKey: ...
    memoryInjectMode: inline-user      # default — JSONL-persistence + reconstruct
    models: [...]

  some-quirky-backend:
    engine: openai-compatible
    baseUrl: ...
    apiKey: ...
    memoryInjectMode: system           # legacy fallback — concat-onto-system
    models: [...]
```

Two values:

- `inline-user` (default) — memory persisted on each user_message,
  reconstructed byte-identical on every call. Cache-friendly. Works
  for any backend that accepts standard OpenAI Chat Completions
  message arrays.
- `system` — legacy concat-onto-system-prompt. Cache-destructive.
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

6. **Two iterations beat one wrong.** The first fix (late-system)
   was structurally wrong but plausible — verified with the wrong
   metric (`cached_tokens` from a single response). A 2-turn
   position-dump comparison caught it on the second iteration.

## Code pointers

| Concern | File |
|---|---|
| `user_message.ephemeral` event field | `src/types/events.ts` |
| Persist ephemeral in JSONL | `src/server/run-turn.ts` (`appendEvent`) |
| Reconstruct from history | `src/engine/openai-compatible.ts` (`buildMessages`) |
| Memory placement claude-cli | `src/engine/claude-cli.ts` (effectiveUserMessage) |
| Memory placement codex-cli | `src/engine/codex-cli.ts` (promptPayload) |
| Dream worker stable-prefix | `src/dream/extract.ts` (`buildUserMessage`) |
| `memoryInjectMode` schema | `src/config/types.ts` (`OpenAiCompatibleProviderSchema`) |
