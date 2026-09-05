// openai-compatible engine: speaks /v1/chat/completions against any provider
// configured with baseUrl + apiKey. Stateless — we feed full message history
// each turn (no thread management on the server side, by design).
//
// Compaction (DECISIONS #21): before each turn we estimate the prompt
// size and, if it crosses the configured threshold, run a compaction
// pass via the same provider. The result is persisted to
// `meta.compactions[]` (non-destructive — JSONL stays untouched) and
// the next message-build uses the summary in place of compacted events.
//
// Agent-loop (Phase 2-Stufe-C): when TurnInput.tools is present, we run
// chat.completions in a loop. The model can request tool calls; we
// execute them via the registry and feed results back. Loop exits when
// the model returns a final response without tool_calls, or when we hit
// MAX_TOOL_ROUNDS (defensive cap, prevents runaway models). claude-cli
// and codex-cli ignore TurnInput.tools — they configure the somora
// MCP server out-of-process and let their CLI handle dispatch.

import OpenAI from 'openai';
import { createPatientOpenAIClient } from '../server/openai-client.ts';
import {
  pickLatest,
  runCompaction,
  shouldCompact,
  type Compaction,
} from '../compaction/index.ts';
import { logger } from '../server/logger.ts';
import { sanitizeAssistantText } from '../server/sanitize-assistant-text.ts';
import type { ToolDefinition, ToolInvoker } from '../tools/types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import type { ModelCapability } from '../config/types.ts';
import { withFromAgentHeader } from './a2a.ts';
import type { AgentEngine, ResolvedAttachment, TurnInput } from './types.ts';
import { buildOpenAiUserContent } from '../multimodal/user-content.ts';
import { resolveAttachmentByHash } from '../attachments/store.ts';
import { openAiReasoningState, withReasoningRetry } from './reasoning-retry.ts';
import { formatSampling, isSamplingParamError, samplingBody } from './sampling.ts';
import { insideOpenThink, splitInlineThink } from './inline-think.ts';

const ENGINE = 'openai-compatible';

// Hard fallbacks if the server forgot to pass an agent-loop config.
// Should never fire in practice — `config.agentLoop` is non-optional in
// the Zod schema and defaults itself.
const DEFAULT_MAX_TOOL_ROUNDS = 8;
const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 30;
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;
type StreamingToolCall = {
  id: string;
  name: string;
  argsJson: string; // accumulated as fragments arrive
};

interface OpenAiCompatibleMeta {
  engine?: string;
  compactions?: Compaction[];
}

/** Per-result cap when replaying tool output into rebuilt history.
 *  Unbounded results are what bloat the context; the model can re-read
 *  anything it genuinely needs by calling the tool again. */
export const MAX_REPLAYED_TOOL_RESULT_CHARS = 800;

interface ApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Collapse identical tool calls within one round to a single execution.
 *
 * Weak/local models — deepseek via OpenRouter, which ignores
 * `parallel_tool_calls` — fan out the SAME call many times in one round
 * (77 identical `df` calls, then 116, observed 2026-07-23). Two calls are
 * "identical" when name AND arguments match byte-for-byte; the first is
 * kept, later repeats dropped. The model still gets a result for every
 * DISTINCT call it asked for, and since the assistant message we push
 * lists only the kept calls, the assistant/tool pairing the OpenAI API
 * requires stays intact. Order is preserved. Mirrors Hermes
 * `_deduplicate_tool_calls`. Exported for the regression test.
 */
export function dedupeToolCalls(calls: ApiToolCall[]): ApiToolCall[] {
  const seen = new Set<string>();
  const out: ApiToolCall[] = [];
  for (const c of calls) {
    const sig = `${c.function.name} ${c.function.arguments}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  return out;
}

/**
 * Race a tool invocation against (a) a wall-clock timeout and (b) an
 * optional user AbortSignal.
 *
 * - Timeout resolves with `timeoutResult` so the model sees a normal
 *   tool error and can retry with a higher budget.
 * - Abort rejects with AbortError so the engine's outer catch ends the
 *   turn immediately (`[somora] aborted by user`) instead of waiting
 *   for the tool's own timeout (often 30s–minutes for exec/agent_ask).
 *
 * Residual limit: the underlying `invoke` promise is not cancelled —
 * ToolInvoker has no signal today, so long tools may keep running in
 * the background until their internal timeout. The turn itself stops
 * waiting and releases the session lock. Follow-up: plumb AbortSignal
 * into ToolContext + exec kill if orphaned work becomes a problem.
 *
 * Exported for the stop-button regression test.
 */
export function raceToolInvoke<T>(
  invoke: Promise<T>,
  opts: {
    timeoutMs: number;
    signal?: AbortSignal;
    timeoutResult: T;
  },
): Promise<T> {
  const { timeoutMs, signal, timeoutResult } = opts;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => resolve(timeoutResult));
    }, timeoutMs);
    const onAbort = (): void => {
      settle(() => reject(new DOMException('Aborted', 'AbortError')));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    invoke.then(
      (value) => settle(() => resolve(value)),
      (err: unknown) =>
        settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}

/**
 * Provider tool-scaffold templates that weak models echo as their answer
 * instead of following. The canonical one is DeepSeek-V3's tool chat
 * template (shipped by SGLang/vLLM), which writes this sentence into the
 * prompt right before the first tool result — a confused model reproduces
 * it verbatim as its reply (observed live 2026-07-23). The phrasing is so
 * specific that no genuine answer contains it, so a substring match is
 * safe. Case-insensitive; the DeepSeek variant capitalises differently.
 */
const SCAFFOLD_MARKERS = [
  'use the results below to formulate an answer',
  'formulate an answer to the user question unless additional information',
];

/** True when the text carries a provider tool-scaffold template (see above). */
export function containsScaffold(text: string): boolean {
  const lower = text.toLowerCase();
  return SCAFFOLD_MARKERS.some((m) => lower.includes(m));
}

const PARTIAL_DIGEST_MAX_RESULTS = 12;
const PARTIAL_DIGEST_PER_RESULT = 500;
const PARTIAL_DIGEST_MAX_CHARS = 8000;

/**
 * "Half a synthesis beats none": when the loop stopped at a cap AND the
 * forced no-tools summary call failed too, hand the caller a compact
 * digest of what the turn gathered instead of only an error string.
 * Before 2026-09-04 a capped research sub returned nothing but
 * "Inspect the sub-session JSONL" — unusable for a parent agent
 * (other agents' session dirs are read-blacklisted) and a total loss of
 * 20–40 min / 1.5M-token turns (three reports, 2026-09-03/04).
 *
 * Takes the last assistant text (if any) plus the tail of the tool
 * results, each truncated, hard-capped in total. Tool names come from
 * the assistant tool_calls that requested them.
 */
export function buildPartialDigest(messages: readonly ChatMessage[]): string {
  const nameByCallId = new Map<string, string>();
  let lastAssistantText = '';
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const calls = (m as { tool_calls?: Array<{ id?: string; function?: { name?: string } }> })
      .tool_calls;
    for (const c of calls ?? []) {
      if (c.id && c.function?.name) nameByCallId.set(c.id, c.function.name);
    }
    if (typeof m.content === 'string' && m.content.trim()) lastAssistantText = m.content.trim();
  }
  const toolMsgs = messages.filter((m) => m.role === 'tool');
  const tail = toolMsgs.slice(-PARTIAL_DIGEST_MAX_RESULTS);
  const lines: string[] = [];
  if (lastAssistantText) {
    lines.push('Last assistant text before the cap:', lastAssistantText.slice(0, 1500), '');
  }
  lines.push(
    `Last ${tail.length} of ${toolMsgs.length} tool results (each truncated to ${PARTIAL_DIGEST_PER_RESULT} chars):`,
  );
  for (const m of tail) {
    const id = (m as { tool_call_id?: string }).tool_call_id ?? '';
    const name = nameByCallId.get(id) ?? 'tool';
    const raw =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : `[${b.type}]`))
              .join(' ')
          : '';
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    lines.push(
      `- ${name}: ${oneLine.slice(0, PARTIAL_DIGEST_PER_RESULT)}${oneLine.length > PARTIAL_DIGEST_PER_RESULT ? '…' : ''}`,
    );
  }
  const out = lines.join('\n');
  return out.length > PARTIAL_DIGEST_MAX_CHARS ? `${out.slice(0, PARTIAL_DIGEST_MAX_CHARS)}…` : out;
}

/**
 * True when the tail of the text is the same chunk repeated over and over
 * — a degenerate loop, regardless of WHAT is repeating. Catches walls that
 * aren't the known scaffold string (weak models loop on all sorts of
 * phrases). Cheap and bounded: only looks once the text is long enough to
 * be suspicious, and by then the stream is cut so `text` never grows huge.
 */
export function looksRepetitive(text: string): boolean {
  if (text.length < 240) return false;
  // A 60-char probe taken from near the end. If it recurs ≥4×, it's a loop.
  const probe = text.slice(-80, -20);
  if (probe.length < 40) return false;
  let count = 0;
  let idx = text.indexOf(probe);
  while (idx !== -1 && count < 4) {
    count++;
    idx = text.indexOf(probe, idx + probe.length);
  }
  return count >= 4;
}

/**
 * Remove scaffold sentences (and lines dominated by them) from an answer.
 * Last-resort cleanup for when even a no-tools finalisation still leaks
 * the template: strip the offending lines rather than show them.
 */
export function stripScaffold(text: string): string {
  return text
    .split('\n')
    .filter((line) => !containsScaffold(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Exported for the history-rebuild regression tests
// (./tool-trace.test.mts) — the shape of what we hand a stateless
// backend is load-bearing enough to assert on directly.
export async function buildMessages(
  systemPrompt: string,
  history: NormalizedEvent[],
  compactions: Compaction[] | undefined,
  pdfMode: 'native' | 'rasterize',
  /** Capabilities of the model this history is being packed FOR.
   *  Required, not optional: a caller that forgets it would silently
   *  reintroduce the bug this parameter exists to prevent — replaying
   *  image blocks at a model that cannot accept them. */
  caps: readonly ModelCapability[],
): Promise<ChatMessage[]> {
  // The latest compaction summary is appended to the ONE leading system
  // message instead of travelling as a second `system` entry. Strict
  // chat templates (vLLM + Qwen 3.x) accept `role: system` only at
  // index 0 — "System message must be at the beginning" (400) — and the
  // force-summary path already paid for that assumption once
  // (2026-09-04). One system message is valid everywhere; the
  // <conversation-summary> block keeps its own delimiters so the
  // model still sees where the prompt ends and the summary starts.
  const latest = pickLatest(compactions);
  const systemContent = latest
    ? [
        systemPrompt,
        '',
        '<conversation-summary>',
        'Eine vorherige Compaction hat den älteren Verlauf der',
        'Session zusammengefasst. Behandle den folgenden Block als',
        'verlässlichen Kontext für alle nicht weiter unten explizit',
        'wiederholten Fakten:',
        '',
        latest.summary,
        '</conversation-summary>',
      ].join('\n')
    : systemPrompt;
  const messages: ChatMessage[] = [{ role: 'system', content: systemContent }];
  const sinceTs = latest?.throughTs ?? 0;

  let pendingRole: 'user' | 'assistant' | null = null;
  let pendingText = '';

  const flush = () => {
    if (pendingRole && pendingText) {
      messages.push({ role: pendingRole, content: pendingText });
    }
    pendingRole = null;
    pendingText = '';
  };

  // Tool history. Turns that used tools are replayed in the NATIVE
  // OpenAI shape — an assistant message carrying `tool_calls`, followed
  // by one `role:'tool'` message per result — rather than as prose.
  //
  // Why it matters (measured 2026-07-22, N=20 per cell): with tool turns
  // flattened to text, deepseek-chat produced 0/20 tool calls on a real
  // session history and deepseek-r1 1/20. Replaying the native shape
  // lifted them to 14/20 and 10/20. The model has no memory beyond what
  // we hand it, so a transcript in which the assistant never calls tools
  // is a demonstration that here, one does not call tools.
  //
  // An earlier attempt used a prose `<somora-tool-log>` summary instead.
  // It measured as useless (85%→90% on kimi, 0%→0% on deepseek) and,
  // while it briefly sat in the assistant role, actively harmful: models
  // began writing the block themselves with invented commands and
  // outputs. The sanitizer still strips it (src/server/sanitize-assistant-text.ts)
  // because sessions recorded during that window carry fabricated ones.
  //
  // Full investigation: private/toolcall-investigation.md.
  const pendingCalls: Array<{ id: string; name: string; args: string }> = [];
  const pendingResults = new Map<string, string>();

  /** Emit the collected tool activity of one turn, ahead of that turn's
   *  assistant text. Calls without a matching result are dropped: an
   *  assistant `tool_calls` entry whose result never arrives is a hard
   *  400 on most backends, and a crashed turn can leave exactly that. */
  const flushToolTurn = () => {
    if (pendingCalls.length === 0) return;
    const paired = pendingCalls.filter((c) => pendingResults.has(c.id));
    pendingCalls.length = 0;
    if (paired.length === 0) { pendingResults.clear(); return; }
    flush(); // close any open text message first — ordering is load-bearing
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: paired.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    } as unknown as ChatMessage);
    for (const c of paired) {
      messages.push({
        role: 'tool',
        tool_call_id: c.id,
        content: pendingResults.get(c.id)!,
      } as unknown as ChatMessage);
    }
    pendingResults.clear();
  };

  for (const ev of history) {
    if (ev.ts <= sinceTs) continue; // skip events covered by compaction
    if (ev.kind === 'user_message') {
      // A2A attribution: prepend a header when this user-message was
      // written by another agent so the model sees the provenance
      // even after replay across engines.
      // A turn that never produced an assistant_message (crash, abort)
      // still has its tool activity replayed, ahead of the next user turn.
      flushToolTurn();
      const headed = withFromAgentHeader(ev.text, ev.from_agent);
      // Memory-recall block (if any) was persisted on the event when
      // this turn was originally sent; reconstruct it here so the
      // byte sequence matches what the backend already cached. This
      // is what makes prefix-cache hold across turns for stateless
      // openai-compatible backends. Engines with stateful resumed
      // sessions (claude-cli/codex-cli) don't reconstruct full
      // history so they ignore this code path.
      const composed = ev.ephemeral ? `${ev.ephemeral}\n\n${headed}` : headed;
      // Phase Y.B — when this past turn carried attachments, it must
      // become its own array-content message (can't be collapsed with
      // siblings). Resolve refs from disk and build the content parts;
      // missing files degrade to a text marker so a long-deleted
      // attachment doesn't kill the turn replay.
      if (ev.attachments && ev.attachments.length > 0) {
        flush();
        const resolved: ResolvedAttachment[] = [];
        for (const a of ev.attachments) {
          try {
            const r = await resolveAttachmentByHash({ hash: a.hash, expectedMime: a.mime });
            resolved.push({
              hash: a.hash,
              path: r.path,
              name: a.name,
              mime: r.mime,
              size: r.size,
            });
          } catch (err) {
            logger.warn({
              msg: 'engine.replay.attachment_missing',
              hash: a.hash,
              name: a.name,
              err: (err as Error).message,
            });
          }
        }
        if (resolved.length === 0) {
          // All refs were stale — fall back to text-only with a marker
          // so the model sees that something *was* attached at this turn.
          const lostNames = ev.attachments.map((a) => a.name).join(', ');
          messages.push({
            role: 'user',
            content: `[Attachments lost from disk: ${lostNames}]\n\n${composed}`,
          });
        } else {
          const notShown = resolved.filter(
            (r) =>
              (r.mime.kind === 'image' && !caps.includes('image')) ||
              (r.mime.kind === 'pdf' && !caps.includes('pdf') && !caps.includes('image')),
          );
          if (notShown.length > 0) {
            logger.info({
              msg: 'engine.history.attachments_not_shown',
              count: notShown.length,
              kinds: notShown.map((r) => r.mime.kind),
              names: notShown.map((r) => r.name),
              capabilities: [...caps],
              hint: 'active model lacks the capability — replayed as text markers so the turn still packs',
            });
          }
          const content = await buildOpenAiUserContent(composed, resolved, pdfMode, caps);
          messages.push({
            role: 'user',
            content: content as OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'],
          });
        }
        continue;
      }
      if (pendingRole !== 'user') flush();
      pendingRole = 'user';
      pendingText = pendingText ? `${pendingText}\n\n${composed}` : composed;
    } else if (ev.kind === 'assistant_message') {
      // This turn's tool activity happened BEFORE the model's closing
      // text, so it goes out first.
      flushToolTurn();
      // Historical poison: sessions recorded while the prose tool-log
      // block sat in the assistant role contain models' own fabricated
      // <somora-tool-log> blocks. Strip them on the way back in so a
      // poisoned session heals instead of compounding.
      const cleaned = sanitizeAssistantText(ev.text).text;
      if (pendingRole !== 'assistant') flush();
      pendingRole = 'assistant';
      pendingText = pendingText ? `${pendingText}\n\n${cleaned}` : cleaned;
    } else if (ev.kind === 'tool_call') {
      pendingCalls.push({
        id: ev.callId,
        name: ev.tool,
        args: JSON.stringify(ev.input ?? {}),
      });
    } else if (ev.kind === 'tool_result') {
      const payload = ev.error !== undefined ? { error: ev.error } : (ev.output ?? null);
      let text: string;
      try {
        text = JSON.stringify(payload) ?? 'null';
      } catch {
        text = '"[unserializable tool result]"';
      }
      // Cap per result. Full outputs are what blew the context in the
      // first place; the model can re-read anything it actually needs.
      pendingResults.set(
        ev.callId,
        text.length > MAX_REPLAYED_TOOL_RESULT_CHARS
          ? `${text.slice(0, MAX_REPLAYED_TOOL_RESULT_CHARS)}… [truncated]`
          : text,
      );
    }
    // deltas / turn_start / turn_end → ignore for chat.completions
  }
  // Trailing tool activity from a turn still in flight.
  flushToolTurn();
  flush();
  return messages;
}

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
  }
  // Rough heuristic: ~4 chars per token. Good enough for soft warnings.
  return Math.ceil(chars / 4);
}

/**
 * Convert our ToolDefinition[] to OpenAI's `tools` parameter shape.
 * Each tool's `jsonSchema` is already a complete JSON Schema object
 * matching what `parameters:` expects.
 */
function toOpenAiTools(defs: ToolDefinition[]): ChatTool[] {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.jsonSchema as Record<string, unknown>,
    },
  }));
}

/**
 * Backend refused the prompt because it doesn't fit the model. The
 * pre-turn `shouldCompact` check works off somora's own token
 * ESTIMATE, which can sit far below the backend's count (26k estimated
 * vs 251k counted on 2026-08-22 — images, tool payloads, chars/4). So
 * the estimate is a hint; the backend's 400 is the truth. Matches the
 * wordings seen in the wild: LiteLLM/sglang "Prompt too long: N tokens
 * exceeds max context window", OpenAI "maximum context length is N
 * tokens", `context_length_exceeded`, and oMLX's "prefill memory guard
 * rejected this prompt".
 */
export function isContextLengthError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /prompt too long|context[_ ]length|maximum context|max(imum)? context window|context window of|prefill memory guard|too many tokens|reduce the length of the messages|input is too long|exceeds the (model'?s? )?(context|token)/i.test(
    msg,
  );
}

/** Turns that already got one reactive compaction+retry — never loop. */
const CONTEXT_RETRIED = new WeakSet<TurnInput>();

export const openAiCompatibleEngine: AgentEngine = {
  name: ENGINE,

  async *runTurn(input: TurnInput): AsyncIterable<NormalizedEvent> {
    const {
      agent,
      session,
      systemPrompt,
      ephemeralContext,
      history,
      metaStore,
      resolvedModel,
      availableModels,
      thinking,
      sampling,
      signal,
    } = input;
    if (resolvedModel.provider.engine !== ENGINE) {
      throw new Error(`openai-compatible engine called with non-matching provider engine: ${resolvedModel.provider.engine}`);
    }

    const turnId = `t-${Date.now()}`;
    const ts = () => Date.now();

    // Idle watchdog — bridges the upstream user-abort signal with an
    // event-idle timer. If the local LLM stops streaming chunks for the
    // configured window we abort the fetch so the per-session lock
    // releases cleanly instead of a Node process hanging forever.
    // Threshold from config.engineWatchdog.openaiCompatibleIdleMs
    // (default 1200s = 20min). Local-LLM workloads can legitimately
    // take many minutes per turn; the timer resets on every received
    // chunk so a slow-but-streaming model never trips this.
    const IDLE_TIMEOUT_MS = input.idleTimeoutMs ?? 1_200_000;
    const watchdogAbort = new AbortController();
    let watchdogFired = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        watchdogFired = true;
        logger.error({
          msg: 'engine.watchdog_idle_timeout',
          engine: ENGINE,
          agent,
          session,
          idleMs: IDLE_TIMEOUT_MS,
          hint: 'no stream chunks received from openai-compatible backend; aborting',
        });
        watchdogAbort.abort();
      }, IDLE_TIMEOUT_MS);
    };
    const disarmIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    // Forward upstream user-abort to the same controller, so create()
    // sees a single combined signal.
    const onUpstreamAbort = () => watchdogAbort.abort();
    if (signal) {
      if (signal.aborted) watchdogAbort.abort();
      else signal.addEventListener('abort', onUpstreamAbort, { once: true });
    }
    const effectiveSignal = watchdogAbort.signal;

    // Race iter.next() against the abort signal. Mirrors the main
    // streaming loop's inline race (see its rationale ~line 652): some
    // openai-compatible backends hold the connection open without
    // emitting bytes and ignore the fetch-level abort, so a plain
    // for-await wedges on the body reader and neither user-cancel nor the
    // idle watchdog can escape. Used by the force-summary finish below.
    async function nextOrAbort<T>(iter: AsyncIterator<T>): Promise<IteratorResult<T>> {
      return await new Promise<IteratorResult<T>>((resolve, reject) => {
        if (effectiveSignal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'));
          return;
        }
        const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
        effectiveSignal.addEventListener('abort', onAbort, { once: true });
        iter.next().then(
          (r) => {
            effectiveSignal.removeEventListener('abort', onAbort);
            resolve(r);
          },
          (err: unknown) => {
            effectiveSignal.removeEventListener('abort', onAbort);
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    }

    yield { kind: 'turn_start', ts: ts(), engine: ENGINE, turnId };

    let meta = (await metaStore.get(agent, session)) as OpenAiCompatibleMeta;
    let compactions = meta.compactions;

    // Compaction tunables come from the server-resolved config (env > yaml > defaults).
    const compactionConfig = input.compactionConfig;
    const decision = shouldCompact({
      systemPrompt,
      history,
      compactions,
      contextWindow: resolvedModel.model.contextWindow,
      config: compactionConfig,
    });
    if (decision.shouldCompact) {
      logger.info({
        msg: 'engine.compaction_trigger',
        engine: ENGINE,
        agent,
        session,
        estimatedTokens: decision.estimatedTokens,
        triggerTokens: decision.triggerTokens,
        ratio: Math.round(decision.ratio * 100) / 100,
        existingCompactions: compactions?.length ?? 0,
      });
      try {
        const newCompaction = await runCompaction({
          systemPrompt,
          history,
          resolvedModel,
          availableModels,
          compactions,
          config: compactionConfig,
        });
        if (newCompaction) {
          compactions = [...(compactions ?? []), newCompaction];
          await metaStore.set(agent, session, {
            ...meta,
            compactions,
          });
          meta = { ...meta, compactions };
          logger.info({
            msg: 'engine.compaction_done',
            engine: ENGINE,
            agent,
            session,
            throughTs: newCompaction.throughTs,
            tokensBefore: newCompaction.tokensBefore,
            tokensAfter: newCompaction.tokensAfter,
            summaryChars: newCompaction.summary.length,
          });
        } else {
          logger.info({
            msg: 'engine.compaction_skip',
            engine: ENGINE,
            agent,
            session,
            reason: 'extractCompactionRange returned null (cushion covers everything or empty summary)',
          });
        }
      } catch (err) {
        // Don't kill the turn if compaction itself fails — degrade gracefully.
        logger.warn({
          msg: 'engine.compaction_fail',
          engine: ENGINE,
          agent,
          session,
          err: String(err),
        });
      }
    }

    // Memory inject placement controls prefix-cache hit-rate. Default
    // ('inline-user') relies on persistence: ephemeralContext is stored
    // alongside each user_message in JSONL (see run-turn.ts), and
    // buildMessages reconstructs each prior user message with its own
    // memory block included. Result: the byte sequence sent for turn
    // N+1 matches what the backend cached for turn N up to (but not
    // including) the new user message — full prefix cache hit on
    // system + tools + entire prior conversation.
    //
    // 'system' is the legacy concat-onto-system mode. Opt-in via config
    // for backends that mishandle multi-pair user/assistant histories
    // with embedded memory blocks. Cache-destructive (memory landing
    // in the system prefix changes per turn) — only use as a fallback.
    const memoryInjectMode =
      (resolvedModel.provider as { memoryInjectMode?: 'inline-user' | 'system' })
        .memoryInjectMode ?? 'inline-user';
    const useLegacySystemConcat = memoryInjectMode === 'system';
    const effectiveSystemPrompt =
      useLegacySystemConcat && ephemeralContext
        ? `${systemPrompt}\n\n---\n\n${ephemeralContext}`
        : systemPrompt;
    const pdfMode =
      (resolvedModel.provider as { pdfMode?: 'native' | 'rasterize' }).pdfMode ?? 'rasterize';
    const messages = await buildMessages(
      effectiveSystemPrompt,
      history,
      compactions,
      pdfMode,
      resolvedModel.model.capabilities,
    );
    const estTokens = estimateTokens(messages);
    const ctxRatio = estTokens / resolvedModel.model.contextWindow;
    if (ctxRatio > 0.7) {
      logger.warn({
        msg: 'engine.context_warn',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        agent,
        session,
        estimatedTokens: estTokens,
        contextWindow: resolvedModel.model.contextWindow,
        ratio: Math.round(ctxRatio * 100) / 100,
        hint: 'history is approaching the context-window limit even after compaction. Lower triggerRatio for more headroom.',
      });
    }

    const client = createPatientOpenAIClient({
      baseURL: resolvedModel.provider.baseUrl,
      apiKey: resolvedModel.provider.apiKey,
    });

    // Cumulative content across ALL tool-rounds. The model may speak in
    // round 1 ("Let me check..."), call tools, then continue in round 2
    // ("Based on what I found, …"). We concat with a blank line between
    // round-segments so the streamed view to the user keeps growing
    // monotonically — matches how claude-cli's SDK presents
    // tool-using turns to us (one final assistant_message at the end).
    let cumulative = '';
    // Reasoning text across rounds of this turn — see roundThinking.
    let turnThinking = '';
    /** Rounds whose request was sent — the reactive context retry is only
     *  safe before anything happened (round 1, nothing emitted). */
    let roundsStarted = 0;
    let totalUsage:
      | {
          tokens_in: number;
          tokens_out: number;
          tokens_out_reasoning?: number;
          tokens_out_reasoning_estimated?: boolean;
        }
      | undefined;
    let tokensInCached: number | undefined;

    const tools = input.tools;
    const toolList = tools ? tools.list() : [];
    const openAiTools: ChatTool[] | undefined = tools ? toOpenAiTools(toolList) : undefined;
    const toolByName = new Map(toolList.map((t) => [t.name, t]));
    const loopMessages = [...messages]; // mutable copy; tool rounds append
    const maxRounds = input.agentLoopConfig?.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
    const maxToolCallsPerTurn =
      input.agentLoopConfig?.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
    const globalToolTimeoutMs =
      input.agentLoopConfig?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;

    try {
      logger.info({
        msg: 'engine.init',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        baseUrl: resolvedModel.provider.baseUrl,
        estimatedTokens: estTokens,
        compactionsApplied: compactions?.length ?? 0,
        toolsAdvertised: openAiTools?.length ?? 0,
      });

      // Cross-engine thinking knob → OpenAI's `reasoning_effort` body param
      // via shared helper. Helper internally guards on the model's
      // 'reasoning' capability — for opaque local endpoints (Gemma etc.)
      // it returns {} so the request stays clean and the user sees the
      // dormant state in the header.
      const reasoning = openAiReasoningState(thinking, resolvedModel.model);
      type CreateParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
      // One retry when the backend rejects the effort value — see
      // src/engine/reasoning-retry.ts. The adjusted value sticks for the
      // remaining rounds of this turn; `reasoning.adjustment` is yielded
      // once as engine_meta below so the user sees what was sent.
      // Sampling (temperature, top_p, …): model default < agent.yaml <
      // session override, merged by run-turn. A backend that rejects a
      // key answers 400 → retry ONCE without any sampling and say so via
      // engine_meta; the drop sticks for the rest of the turn.
      let samplingParam: Record<string, unknown> = samplingBody(sampling);
      let samplingDropped: { sent: Record<string, unknown>; backend: string } | null = null;
      const logCtx = { engine: ENGINE, provider: resolvedModel.providerName, model: resolvedModel.modelId, agent, session };
      const createChatStream = async (params: CreateParams) => {
        const send = () =>
          withReasoningRetry(
            reasoning,
            (body) =>
              client.chat.completions.create({ ...params, ...samplingParam, ...body } as CreateParams, {
                signal: effectiveSignal,
              }),
            logCtx,
          );
        try {
          return await send();
        } catch (err) {
          if (Object.keys(samplingParam).length === 0 || !isSamplingParamError(err)) throw err;
          const backend = String((err as Error).message ?? err).slice(0, 300);
          logger.warn({ msg: 'engine.sampling_rejected', ...logCtx, sent: samplingParam, backend });
          samplingDropped = { sent: samplingParam, backend };
          samplingParam = {};
          return await send();
        }
      };

      let round = 0;
      // Did the LAST executed round still want tools? Distinguishes
      // "model gave its final answer" (breaks below) from "hit the cap
      // mid-runaway" — only the latter needs the forced no-tools finish.
      let lastRoundHadTools = false;
      // Set when the stream guard aborted a round mid-scaffold. The content
      // is discarded, so the post-loop containsScaffold(cumulative) check
      // wouldn't see it — this flag carries the signal to force a clean finish.
      let sawScaffoldLeak = false;
      // Total tool calls executed this turn, across all rounds. Bounds the
      // within-round fan-out that maxRounds can't (a weak model emitting 77
      // calls in one round). When it trips we force a clean final answer.
      let totalToolCalls = 0;
      let hitToolBudget = false;
      let softWarned = false;
      while (round < maxRounds) {
        round++;
        roundsStarted = round;
        if (effectiveSignal.aborted) throw new DOMException('Aborted', 'AbortError');
        armIdleTimer();
        const stream = await createChatStream({
          model: resolvedModel.modelId,
          messages: loopMessages,
          stream: true,
          stream_options: { include_usage: true },
          ...(openAiTools
              ? {
                  tools: openAiTools,
                  tool_choice: 'auto',
                  // Default to one tool call per round. Weak/local models
                  // (deepseek, kimi) fan out into large parallel batches of
                  // identical calls and lose track of what they've run — the
                  // 123×-`df` runaway. Sequential = one call, one result,
                  // clear state. A model set `parallelToolCalls: true` opts
                  // back into the provider's parallel default.
                  ...(resolvedModel.model.parallelToolCalls === true
                    ? {}
                    : { parallel_tool_calls: false }),
                }
              : {}),
          ...(resolvedModel.model.maxTokens ? { max_tokens: resolvedModel.model.maxTokens } : {}),
        });
        if (samplingDropped) {
          const dropped: { sent: Record<string, unknown>; backend: string } = samplingDropped;
          samplingDropped = null;
          yield {
            kind: 'engine_meta',
            ts: ts(),
            engine: ENGINE,
            itemType: 'sampling_dropped',
            payload: {
              text:
                `${resolvedModel.modelId} rejected the sampling parameters (${formatSampling(dropped.sent as never)}) — ` +
                'sent without them for this turn. Remove the offending key from the model, agent or session sampling to make this permanent.',
              sent: dropped.sent,
              backend: dropped.backend,
            },
          };
        }
        if (reasoning.adjustment) {
          const adj = reasoning.adjustment;
          reasoning.adjustment = null;
          yield {
            kind: 'engine_meta',
            ts: ts(),
            engine: ENGINE,
            itemType: 'reasoning_effort_adjusted',
            payload: {
              text:
                `${resolvedModel.modelId} rejected reasoning effort '${adj.requested}' — ` +
                (adj.sent ? `sent '${adj.sent}' instead` : 'sent without the parameter (model default)') +
                '. Map the level in the model\'s `reasoning.levels` config to make this permanent.',
              requested: adj.requested,
              sent: adj.sent,
              backend: adj.backend,
            },
          };
        }

        // Per-round accumulators
        let roundContent = '';
        // Chars of `reasoning_content` / `reasoning` deltas seen this round.
        // Only used when the backend's usage reports no reasoning_tokens
        // (SGLang/vLLM builds vary) — then the 🧠 counter is estimated
        // from the streamed text at 4 chars/token and flagged as such.
        let roundReasoningChars = 0;
        // Reasoning TEXT of this round (reasoning_content / reasoning
        // deltas). Streamed as cumulative thinking_delta (turn-wide),
        // folded into turnThinking at round end, emitted once as
        // thinking_message before the final assistant_message.
        let roundThinking = '';
        // Inline-think text already surfaced as thinking_delta this round
        // (dedupes the cumulative re-split on every content delta).
        let roundInlineThinkingSeen = '';
        const roundToolCalls = new Map<number, StreamingToolCall>();
        let finishReason: string | null = null;

        // Manual iteration with abort-race instead of plain `for await
        // (const chunk of stream)`. The OpenAI SDK passes our
        // effectiveSignal down to the underlying fetch, and undici is
        // supposed to abort the body-stream read when the signal fires.
        // Some openai-compatible backends (omlx in particular, but also
        // local ollama under load) hold the HTTP connection open without
        // emitting bytes and don't react to the abort — the for-await
        // just hangs on the body reader. Racing iter.next() against the
        // signal guarantees the watchdog can escape regardless.
        const chunkIter = (stream as AsyncIterable<typeof stream extends AsyncIterable<infer C> ? C : never>)[Symbol.asyncIterator]();
        while (true) {
          let next: IteratorResult<typeof stream extends AsyncIterable<infer C> ? C : never>;
          try {
            next = await new Promise<typeof next>((resolve, reject) => {
              if (effectiveSignal.aborted) {
                reject(new DOMException('Aborted', 'AbortError'));
                return;
              }
              const onAbort = (): void => {
                reject(new DOMException('Aborted', 'AbortError'));
              };
              effectiveSignal.addEventListener('abort', onAbort, { once: true });
              chunkIter.next().then(
                (r) => {
                  effectiveSignal.removeEventListener('abort', onAbort);
                  resolve(r);
                },
                (err: unknown) => {
                  effectiveSignal.removeEventListener('abort', onAbort);
                  reject(err instanceof Error ? err : new Error(String(err)));
                },
              );
            });
          } catch (err) {
            // Fire-and-forget cleanup — do NOT await. On a wedged native
            // async generator, return() is queued behind the pending
            // next() and never settles when that next() never settles, so
            // awaiting it re-hangs the turn in exactly the stuck-stream
            // case this race exists to escape (Juni-Audit 2026-06).
            // Detach it and surface the error immediately.
            void Promise.resolve(chunkIter.return?.(undefined)).catch(() => {});
            throw err;
          }
          if (next.done) break;
          const chunk = next.value;
          // Some openai-compatible backends (omlx in particular) close
          // the stream on signal-abort *without* throwing — the iterator
          // just terminates. Detect that here so we don't silently emit
          // a truncated assistant_message as if it were a clean completion.
          if (effectiveSignal.aborted) throw new DOMException('Aborted', 'AbortError');
          armIdleTimer();
          const choice = chunk.choices[0];
          const delta = choice?.delta;
          {
            const r = delta as { reasoning_content?: unknown; reasoning?: unknown } | undefined;
            const rtext =
              typeof r?.reasoning_content === 'string'
                ? r.reasoning_content
                : typeof r?.reasoning === 'string'
                  ? r.reasoning
                  : '';
            if (rtext) {
              roundReasoningChars += rtext.length;
              roundThinking += rtext;
              yield {
                kind: 'thinking_delta',
                ts: ts(),
                engine: ENGINE,
                text: turnThinking ? `${turnThinking}\n\n${roundThinking}` : roundThinking,
              };
            }
          }
          if (delta?.content && typeof delta.content === 'string') {
            roundContent += delta.content;
            // Inline `<think>…</think>` in content (backend without a
            // reasoning parser — DeepSeek V4 on SGLang): route the
            // reasoning part to thinking_delta and stream only the
            // answer part as assistant text. Without an opening tag the
            // block is only recognisable once `</think>` arrives, so the
            // first deltas of such a round may stream as assistant text;
            // the round-end split below and the final assistant_message
            // are always clean.
            const inline = splitInlineThink(roundContent);
            if (inline.thinking && inline.thinking !== roundInlineThinkingSeen) {
              roundInlineThinkingSeen = inline.thinking;
              roundReasoningChars += inline.thinking.length;
              yield {
                kind: 'thinking_delta',
                ts: ts(),
                engine: ENGINE,
                text: turnThinking ? `${turnThinking}\n\n${inline.thinking}` : inline.thinking,
              };
            }
            if (insideOpenThink(roundContent)) continue;
            const visibleRound = inline.content;
            // Scaffold guard AT THE STREAM. A confused model emits the
            // provider's tool-result template ("Use the results below to
            // formulate an answer…") as content and repeats it hundreds of
            // times. Cleaning only the final text (below) is too late — the
            // deltas already streamed the wall into the user's window live.
            // The moment the running content becomes scaffold, stop: discard
            // it, close the upstream stream so the model stops generating,
            // and let the forced no-tools finish (below) produce a clean
            // answer. The user sees at most one partial sentence, not 100.
            if (containsScaffold(visibleRound) || looksRepetitive(visibleRound)) {
              sawScaffoldLeak = true;
              roundContent = '';
              void Promise.resolve(chunkIter.return?.(undefined)).catch(() => {});
              break;
            }
            if (!visibleRound) continue;
            // Stream the running cumulative (existing rounds + this round so far).
            const runningCumulative = cumulative
              ? `${cumulative}\n\n${visibleRound}`
              : visibleRound;
            yield { kind: 'assistant_delta', ts: ts(), engine: ENGINE, text: runningCumulative };
          }
          if (delta?.tool_calls) {
            // tool_calls stream as fragments indexed by `index`. Accumulate
            // name and arguments-JSON across chunks.
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const slot =
                roundToolCalls.get(idx) ?? { id: '', name: '', argsJson: '' };
              if (tc.id && !slot.id) slot.id = tc.id;
              if (tc.function?.name && !slot.name) slot.name = tc.function.name;
              if (tc.function?.arguments) slot.argsJson += tc.function.arguments;
              roundToolCalls.set(idx, slot);
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) {
            const rawUsage = chunk.usage as {
              prompt_tokens_details?: { cached_tokens?: number };
              completion_tokens_details?: { reasoning_tokens?: number };
            };
            // Accumulate across rounds like tokens_in below — plain
            // assignment kept only the LAST round's cached count while
            // tokens_in summed all rounds, so the cached/uncached split
            // shown to the user was inconsistent on multi-round tool
            // turns (Juni-Audit 2026-06).
            const roundCached = rawUsage.prompt_tokens_details?.cached_tokens;
            if (roundCached !== undefined) {
              tokensInCached = (tokensInCached ?? 0) + roundCached;
            }
            // OpenAI returns reasoning_tokens inside completion_tokens_details
            // for reasoning models (gpt-5/o-series). It's already INCLUDED in
            // the top-level completion_tokens, so we surface it as a separate
            // counter for the UI's (N🧠) display without double-counting in
            // tokens_out.
            const reportedReasoning = rawUsage.completion_tokens_details?.reasoning_tokens;
            const reasoningEstimated = reportedReasoning == null && roundReasoningChars > 0;
            const reasoningTokens = reasoningEstimated
              ? Math.ceil(roundReasoningChars / 4)
              : (reportedReasoning ?? undefined);
            const u = {
              tokens_in: chunk.usage.prompt_tokens ?? 0,
              tokens_out: chunk.usage.completion_tokens ?? 0,
              ...(reasoningTokens !== undefined
                ? { tokens_out_reasoning: reasoningTokens }
                : {}),
              ...(reasoningEstimated ? { tokens_out_reasoning_estimated: true } : {}),
            };
            // Accumulate across rounds for the final turn_end usage.
            totalUsage = totalUsage
              ? {
                  tokens_in: totalUsage.tokens_in + u.tokens_in,
                  tokens_out: totalUsage.tokens_out + u.tokens_out,
                  ...(u.tokens_out_reasoning !== undefined ||
                  totalUsage.tokens_out_reasoning !== undefined
                    ? {
                        tokens_out_reasoning:
                          (totalUsage.tokens_out_reasoning ?? 0) +
                          (u.tokens_out_reasoning ?? 0),
                      }
                    : {}),
                  ...(u.tokens_out_reasoning_estimated || totalUsage.tokens_out_reasoning_estimated
                    ? { tokens_out_reasoning_estimated: true }
                    : {}),
                }
              : u;
          }
        }

        // Streaming for this round is done — disarm the idle watchdog so
        // it doesn't count the upcoming tool-execution phase as "dead
        // backend, no chunks" and abort a healthy turn (a single
        // agent_ask / subagent_result wait_until_done can legitimately
        // run past the idle threshold). The next round re-arms at
        // round-top before the next create() call (Juni-Audit 2026-06).
        disarmIdleTimer();

        // Inline think block (see the delta handler): move it out of the
        // content for good so neither the persisted assistant_message nor
        // a subagent `result` carries raw reasoning + a bare `</think>`.
        if (roundContent) {
          const inline = splitInlineThink(roundContent);
          if (inline.thinking) {
            logger.info({
              msg: 'engine.inline_think_split',
              engine: ENGINE,
              agent,
              session,
              thinkingChars: inline.thinking.length,
              contentChars: inline.content.length,
            });
            roundThinking = roundThinking ? `${roundThinking}\n\n${inline.thinking}` : inline.thinking;
            roundContent = inline.content;
          }
        }
        // Leading whitespace is never meaningful in an answer; DeepSeek V4
        // with reasoning off opens every reply with the blank lines of an
        // empty think block ("\n\n\n\n\n391", 2026-09-05).
        roundContent = roundContent.replace(/^\s+/, '');
        // Merge the round's content into the cumulative (separator only when
        // there's previous content AND new content).
        if (roundContent) {
          cumulative = cumulative ? `${cumulative}\n\n${roundContent}` : roundContent;
        }
        if (roundThinking) {
          turnThinking = turnThinking ? `${turnThinking}\n\n${roundThinking}` : roundThinking;
          roundThinking = '';
        }

        // Also catch silent abort-close: if the stream ended without a
        // throw but the upstream signal (or watchdog) fired, treat as
        // user-cancel / wedge.
        if (effectiveSignal.aborted) throw new DOMException('Aborted', 'AbortError');

        lastRoundHadTools = roundToolCalls.size > 0;
        if (roundToolCalls.size === 0) {
          // No tools requested — model gave its final answer this round.
          break;
        }

        // Persist the assistant turn (with tool_calls) to the chat history.
        // The OpenAI API requires the tool_call message before the tool
        // results, so we add both before the next round.
        const rawToolCalls = [...roundToolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, c]) => ({
            id: c.id || `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            type: 'function' as const,
            function: { name: c.name, arguments: c.argsJson || '{}' },
          }));

        // Within-round dedup — see dedupeToolCalls at module top. Collapses
        // the weak-model "same call 77×" fan-out to one execution per
        // distinct call.
        const toolCallsForApi = dedupeToolCalls(rawToolCalls);
        if (toolCallsForApi.length < rawToolCalls.length) {
          logger.warn({
            msg: 'engine.tool_calls_deduped',
            engine: ENGINE,
            agent,
            session,
            round,
            emitted: rawToolCalls.length,
            executed: toolCallsForApi.length,
          });
        }

        loopMessages.push({
          role: 'assistant',
          // OpenAI accepts content=null when only tool_calls are present.
          content: roundContent || null,
          tool_calls: toolCallsForApi,
        } as ChatMessage);

        // Run each tool call, emit normalized events, append a `tool` message
        // per result for the next round.
        if (!tools) {
          // Should never happen — if there are no tools advertised the model
          // shouldn't request them. Bail with a clear error.
          throw new Error('model requested tool_calls but no tool registry was passed to the engine');
        }
        for (const call of toolCallsForApi) {
          let parsedArgs: unknown = {};
          try {
            parsedArgs = JSON.parse(call.function.arguments);
          } catch {
            // leave as raw string fallback so tool sees something
            parsedArgs = { _raw: call.function.arguments };
          }
          yield {
            kind: 'tool_call',
            ts: ts(),
            engine: ENGINE,
            callId: call.id,
            tool: call.function.name,
            input: parsedArgs,
          };
          // Resolve the per-call timeout. Tools that declare themselves
          // long-running (subagent_result with wait_until_done, agent_ask,
          // exec, etc.) override the global cap via timeoutFromInput
          // (dynamic, per-call) or defaultTimeoutMs (static). maxTimeoutMs
          // hard-caps both so a malformed model-supplied timeout_ms can't
          // pin a slot indefinitely. Pattern adapted from OpenClaw's
          // waitForAgentRun — engine itself has no fixed cap, the caller
          // declares the budget.
          const toolDef = toolByName.get(call.function.name);
          const dynamicTimeout = toolDef?.timeoutFromInput?.(parsedArgs as never);
          const staticTimeout = toolDef?.defaultTimeoutMs;
          const hardCap = toolDef?.maxTimeoutMs;
          let toolTimeoutMs = dynamicTimeout ?? staticTimeout ?? globalToolTimeoutMs;
          if (hardCap !== undefined) toolTimeoutMs = Math.min(toolTimeoutMs, hardCap);
          // Race the tool invocation against timeout AND user abort.
          // Timeout → error-shaped result the model can retry against.
          // Abort → AbortError so the turn ends without waiting out the
          // full tool budget (stop-button felt broken during long exec).
          const result = await raceToolInvoke(tools.invoke(call.function.name, parsedArgs), {
            timeoutMs: toolTimeoutMs,
            signal: effectiveSignal,
            timeoutResult: {
              ok: false as const,
              error:
                `tool '${call.function.name}' timed out after ${toolTimeoutMs}ms` +
                (dynamicTimeout !== undefined
                  ? ` — call again with a higher timeout_ms if more time is needed`
                  : ''),
            },
          });
          // Multimodal results (file_read polymorph on image/PDF) carry
          // contentBlocks instead of a JSON-able payload. OpenAI's API
          // accepts a content-array in tool messages with text and
          // image_url entries — local openai-compatible servers (omlx,
          // ollama) may reject this; the failure surfaces as an API
          // error visible to the operator. The model side: gpt-5+,
          // openrouter-claude, gemma-vision all accept it.
          const isMultimodalOk = result.ok && result.contentBlocks !== undefined;
          if (isMultimodalOk) {
            const blocks = result.contentBlocks!;
            const contentArray = blocks.map((b) => {
              if (b.type === 'image') {
                return {
                  type: 'image_url' as const,
                  image_url: {
                    url: `data:${b.source.mediaType};base64,${b.source.data}`,
                  },
                };
              }
              if (b.type === 'text') {
                return { type: 'text' as const, text: b.text };
              }
              return {
                type: 'text' as const,
                text: `[document content block (${b.source.mediaType}) — not delivered as inline content; use analyze_file]`,
              };
            });
            yield {
              kind: 'tool_result',
              ts: ts(),
              engine: ENGINE,
              callId: call.id,
              output: {
                multimodal: true,
                blocks: blocks.length,
                kinds: blocks.map((b) => b.type),
              },
            };
            loopMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              // The OpenAI SDK type accepts string | ContentArray for tool
              // messages; ts narrows tightly here so we cast.
              content: contentArray,
            } as ChatMessage);
          } else {
            const outputText = result.ok
              ? JSON.stringify(result.data)
              : (result.error ?? 'tool failed');
            yield {
              kind: 'tool_result',
              ts: ts(),
              engine: ENGINE,
              callId: call.id,
              output: result.ok ? result.data : null,
              ...(result.ok ? {} : { error: result.error ?? 'tool failed' }),
            };
            loopMessages.push({
              role: 'tool',
              tool_call_id: call.id,
              content: outputText,
            } as ChatMessage);
          }
        }

        // Total-tool-call budget. Bounds within-round fan-out that the
        // round cap can't see: after dedup a runaway still emits many
        // DISTINCT calls per round, and enough rounds of that runs up a
        // three-digit total. Once the budget is spent, stop and force a
        // clean final answer (below) instead of executing more.
        totalToolCalls += toolCallsForApi.length;
        // Soft warning at ~75 % of either budget, once per turn: the
        // model cannot see the caps, so a "read N things and summarise"
        // task ran straight into the hard stop and then into the
        // force-summary path (three reports 2026-09-03/04, 1–2.5M-token
        // turns lost). A plain user-role notice is accepted by every
        // backend (a second `system` entry is not — see below) and
        // models reliably wrap up on it.
        const roundsLeft = maxRounds - round;
        const callsLeft = maxToolCallsPerTurn - totalToolCalls;
        if (
          !softWarned &&
          roundsLeft > 0 &&
          callsLeft > 0 &&
          (round >= Math.ceil(maxRounds * 0.75) ||
            totalToolCalls >= Math.ceil(maxToolCallsPerTurn * 0.75))
        ) {
          softWarned = true;
          logger.info({
            msg: 'engine.budget_soft_warn',
            engine: ENGINE,
            agent,
            session,
            round,
            maxRounds,
            totalToolCalls,
            maxToolCallsPerTurn,
          });
          loopMessages.push({
            role: 'user',
            content:
              `[somora] Budget notice: ${roundsLeft} tool-call round(s) and ${callsLeft} tool call(s) ` +
              'remain in this turn before the loop is stopped. Wrap up now: write your final answer ' +
              'from what you already have. Call a tool only if it is essential for the answer.',
          });
        }
        if (totalToolCalls >= maxToolCallsPerTurn) {
          hitToolBudget = true;
          logger.warn({
            msg: 'engine.tool_budget_cap',
            engine: ENGINE,
            agent,
            session,
            totalToolCalls,
            maxToolCallsPerTurn,
            hint: 'turn exceeded agentLoop.maxToolCallsPerTurn; forcing a final answer to stop a runaway.',
          });
          break;
        }

        // Defensive: if we hit the round cap with tools still pending, log
        // and stop. The loop guard at the top will exit on the next check.
        if (round >= maxRounds) {
          logger.warn({
            msg: 'engine.tool_loop_cap',
            engine: ENGINE,
            agent,
            session,
            rounds: round,
            maxRounds,
            hint: 'model still wanted to call tools at agentLoop.maxRounds; stopping to prevent runaway. Increase via config.yaml agentLoop.maxRounds.',
          });
        }
      }

      // Force a clean final answer whenever the loop exited at the round
      // cap while the model still wanted tools. One last call WITHOUT the
      // `tools` param: a model that is offered no tools cannot keep calling
      // them, and — crucially — cannot echo a provider's tool-scaffold
      // template as its "answer" (DeepSeek's "Use the results below to
      // formulate an answer…" leak, 2026-07-23). Any partial content from
      // the capped round is discarded first: at a runaway cap it is
      // unreliable (scaffold text / half-thoughts), and the model has every
      // tool result in loopMessages to summarise from cleanly.
      // Originally this only fired when cumulative was empty (2026-05-03
      // silent-"" bug); broadened so garbage content at the cap is replaced
      // too, and to also cover the tool-call-budget stop (2026-07-23).
      // Scaffold leak: the model echoed a provider tool-result template
      // (DeepSeek's "Use the results below to formulate an answer…") as its
      // reply instead of answering. Surfaces on a normal (tool-less) final
      // round, so the cap conditions above miss it — detect it on the
      // accumulated text and force the same clean no-tools finish.
      const scaffoldLeak =
        sawScaffoldLeak || containsScaffold(cumulative) || looksRepetitive(cumulative);
      const forcedByCap = (round >= maxRounds && lastRoundHadTools) || hitToolBudget;
      if (forcedByCap || scaffoldLeak) {
        cumulative = '';
        logger.warn({
          msg: 'engine.force_final_answer',
          engine: ENGINE,
          agent,
          session,
          rounds: round,
          reason: scaffoldLeak ? 'scaffold_leak' : hitToolBudget ? 'tool_budget' : 'round_cap',
        });
        // The stop reason, spelled out: the old text always said
        // "maximum number of tool-call rounds (maxRounds)" even when the
        // TOOL-CALL BUDGET fired (2026-09-04: "cap of 50" reported on
        // sessions with 30 calls — a diagnosis detour).
        const capDescription = hitToolBudget
          ? `the tool-call budget of ${maxToolCallsPerTurn} calls for this turn (agentLoop.maxToolCallsPerTurn)`
          : `the agent-loop cap of ${maxRounds} tool-call rounds for this turn (agentLoop.maxRounds)`;
        // USER role, not a trailing `system` entry: strict chat templates
        // (vLLM + Qwen 3.x behind LiteLLM) reject any system message
        // after index 0 with 400 "System message must be at the
        // beginning" — which killed exactly this rescue on every Qwen
        // backend since at least 2026-08-23 (six losses on 2026-09-03
        // alone). A user message is valid on every backend.
        loopMessages.push({
          role: 'user',
          content: scaffoldLeak
            ? '[somora] Your previous draft repeated an internal tool-result instruction ' +
              'instead of answering. Answer the question directly NOW, ' +
              'in your own words, using the tool results already gathered above. ' +
              'Do not call any tools and do not repeat any instruction text.'
            : `[somora] You have reached ${capDescription}. Respond NOW without further ` +
              'tool calls — summarize what you have learned from the tool results so far, ' +
              'even partially. Do not call any tools.',
        } as ChatMessage);
        try {
          // Re-arm the idle watchdog: it was disarmed at the end of the
          // last streaming round (~line 785), and this forced finish is a
          // fresh model call that can wedge like any other. Without the
          // re-arm AND the abort-race below, a backend that holds the
          // connection open without emitting bytes would hang the turn
          // forever — a disarmed timer can't rescue it and some backends
          // ignore the fetch-level abort (Juni-Audit 2026-06).
          armIdleTimer();
          const summaryStream = await createChatStream({
            model: resolvedModel.modelId,
            messages: loopMessages,
            stream: true,
            stream_options: { include_usage: true },
            ...(resolvedModel.model.maxTokens
              ? { max_tokens: resolvedModel.model.maxTokens }
              : {}),
            // No tools, no tool_choice — pure text response.
          });
          const summaryIter = (
            summaryStream as AsyncIterable<
              typeof summaryStream extends AsyncIterable<infer C> ? C : never
            >
          )[Symbol.asyncIterator]();
          while (true) {
            let next: IteratorResult<
              typeof summaryStream extends AsyncIterable<infer C> ? C : never
            >;
            try {
              next = await nextOrAbort(summaryIter);
            } catch (raceErr) {
              // Fire-and-forget cleanup (do NOT await — a wedged native
              // generator never settles return() behind a pending next()).
              void Promise.resolve(summaryIter.return?.(undefined)).catch(() => {});
              throw raceErr;
            }
            if (next.done) break;
            const chunk = next.value;
            if (effectiveSignal.aborted) throw new DOMException('Aborted', 'AbortError');
            armIdleTimer();
            const choice = chunk.choices[0];
            const delta = choice?.delta;
            if (delta?.content && typeof delta.content === 'string') {
              cumulative += delta.content;
              // Same stream guard: a deeply-confused model can leak the
              // scaffold — or loop on any phrase — even when offered no
              // tools. Stop before it repeats; stripScaffold (below) cleans
              // the partial, and if nothing survives the honest fallback
              // message is emitted.
              if (containsScaffold(cumulative) || looksRepetitive(cumulative)) {
                void Promise.resolve(summaryIter.return?.(undefined)).catch(() => {});
                break;
              }
              if (insideOpenThink(cumulative)) continue;
              const visible = splitInlineThink(cumulative).content;
              if (!visible) continue;
              yield {
                kind: 'assistant_delta',
                ts: ts(),
                engine: ENGINE,
                text: visible,
              };
            }
            const usage = chunk.usage;
            if (usage) {
              const reasoningTokens = (
                usage as { completion_tokens_details?: { reasoning_tokens?: number } }
              ).completion_tokens_details?.reasoning_tokens;
              // Keep the cached counter consistent with the main loop's
              // accumulation (Juni-Audit 2026-06).
              const summaryCached = (
                usage as { prompt_tokens_details?: { cached_tokens?: number } }
              ).prompt_tokens_details?.cached_tokens;
              if (summaryCached !== undefined) {
                tokensInCached = (tokensInCached ?? 0) + summaryCached;
              }
              const prevIn = totalUsage?.tokens_in ?? 0;
              const prevOut = totalUsage?.tokens_out ?? 0;
              const prevReasoning = totalUsage?.tokens_out_reasoning;
              totalUsage = {
                tokens_in: prevIn + (usage.prompt_tokens ?? 0),
                tokens_out: prevOut + (usage.completion_tokens ?? 0),
                ...(reasoningTokens !== undefined || prevReasoning !== undefined
                  ? {
                      tokens_out_reasoning:
                        (prevReasoning ?? 0) + (reasoningTokens ?? 0),
                    }
                  : {}),
              };
            }
          }
          disarmIdleTimer();
          {
            const inline = splitInlineThink(cumulative);
            if (inline.thinking) {
              turnThinking = turnThinking ? `${turnThinking}\n\n${inline.thinking}` : inline.thinking;
              cumulative = inline.content;
            }
            cumulative = cumulative.replace(/^\s+/, '');
          }
        } catch (err) {
          disarmIdleTimer();
          // A watchdog timeout or user-cancel during the forced finish
          // must propagate to the turn-level handler (which emits the
          // proper timeout/abort error + turn_end), exactly as an abort
          // in the main loop does — NOT be swallowed into the synthetic
          // "fallback also failed" message below.
          if (
            effectiveSignal.aborted ||
            (err instanceof Error && err.name === 'AbortError')
          ) {
            throw err;
          }
          logger.error({
            msg: 'engine.force_summary_failed',
            engine: ENGINE,
            agent,
            session,
            reason: scaffoldLeak ? 'scaffold_leak' : hitToolBudget ? 'tool_budget' : 'round_cap',
            rounds: round,
            totalToolCalls,
            err: (err as Error).message,
          });
          // Fallback: an honest marker PLUS a digest of what the turn
          // gathered, so the caller (user or parent agent) gets the
          // partial result instead of a pointer to a JSONL it cannot
          // read.
          const errText = (err as Error).message.replace(/\.+$/, '');
          cumulative =
            `[somora] Agent loop stopped at ${capDescription} without a final answer, and the ` +
            `forced summary call also failed: ${errText}. ` +
            `Partial results follow (session ${agent}/${session}).\n\n` +
            buildPartialDigest(loopMessages);
        }
      }

      // Last-resort safety net: if the forced no-tools finish ITSELF still
      // leaked the scaffold template (a deeply-confused model can), strip
      // the offending lines rather than show them. If nothing meaningful
      // survives, fall back to an honest marker instead of empty text.
      if (cumulative && (containsScaffold(cumulative) || looksRepetitive(cumulative))) {
        const cleaned = containsScaffold(cumulative) ? stripScaffold(cumulative) : '';
        logger.warn({
          msg: 'engine.scaffold_stripped',
          engine: ENGINE,
          agent,
          session,
          before: cumulative.length,
          after: cleaned.length,
        });
        cumulative =
          cleaned.length >= 20 && !looksRepetitive(cleaned)
            ? cleaned
            : '[somora] The model could not produce a clean answer for this turn ' +
              '(it looped on repeated text). The tool results are in the session; ' +
              'try rephrasing or a stronger model.';
      }

      if (cumulative) {
        if (turnThinking) {
          yield { kind: 'thinking_message', ts: ts(), engine: ENGINE, text: turnThinking };
          turnThinking = '';
        }
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: cumulative };
      } else if (round >= maxRounds) {
        // Loop ended at the cap and the force-summary path didn't
        // populate cumulative either — synthesize a marker so the
        // caller doesn't get `result: ""` silently.
        cumulative =
          `[somora] Agent loop reached the cap of ${maxRounds} tool-call rounds ` +
          'and produced no final message. Increase agentLoop.maxRounds in config.yaml or ' +
          'pass maxRounds in spawn_subagent input if more rounds are needed.';
        if (turnThinking) {
          yield { kind: 'thinking_message', ts: ts(), engine: ENGINE, text: turnThinking };
          turnThinking = '';
        }
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: cumulative };
      }

      logger.info({
        msg: 'engine.turn',
        engine: ENGINE,
        provider: resolvedModel.providerName,
        model: resolvedModel.modelId,
        agent,
        session,
        tokens_in: totalUsage?.tokens_in,
        tokens_in_cached: tokensInCached,
        tokens_out: totalUsage?.tokens_out,
        toolRounds: round,
      });

      yield {
        kind: 'turn_end',
        ts: ts(),
        engine: ENGINE,
        turnId,
        ...(totalUsage
          ? {
              usage: {
                ...totalUsage,
                ...(tokensInCached !== undefined ? { tokens_in_cached: tokensInCached } : {}),
              },
            }
          : {}),
      };

      // Tag the session with the engine that owns it now (for future routing logic).
      // Re-read in case compaction wrote in-between to avoid clobbering.
      const fresh = (await metaStore.get(agent, session)) as OpenAiCompatibleMeta;
      if (fresh.engine !== ENGINE) {
        await metaStore.set(agent, session, { ...fresh, engine: ENGINE });
      }
    } catch (err) {
      if (watchdogFired) {
        const message = `openai-compatible backend timed out (${IDLE_TIMEOUT_MS / 1000}s idle, no chunks)`;
        logger.error({
          msg: 'engine.fail',
          engine: ENGINE,
          agent,
          session,
          err: 'idle watchdog timeout',
          idleMs: IDLE_TIMEOUT_MS,
        });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      } else if (signal?.aborted) {
        logger.info({ msg: 'engine.aborted', engine: ENGINE, agent, session });
        const partial = cumulative
          ? `${cumulative}\n\n[somora] aborted by user`
          : '[somora] aborted by user';
        yield { kind: 'assistant_message', ts: ts(), engine: ENGINE, text: partial };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      } else if (isContextLengthError(err) && roundsStarted <= 1 && !cumulative) {
        // Reactive compaction: the backend says the prompt doesn't fit,
        // whatever our estimate thought. Force a compaction down to one
        // intact pair and retry the turn ONCE. Only before anything was
        // streamed or any tool ran — a mid-turn retry would replay tool
        // calls. Second failure → clear message instead of a raw 400.
        const backendMessage = (err as Error).message;
        const alreadyRetried = CONTEXT_RETRIED.has(input);
        CONTEXT_RETRIED.add(input);
        logger.warn({
          msg: 'engine.context_overflow',
          engine: ENGINE,
          provider: resolvedModel.providerName,
          model: resolvedModel.modelId,
          agent,
          session,
          contextWindow: resolvedModel.model.contextWindow,
          estimatedTokens: estTokens,
          existingCompactions: compactions?.length ?? 0,
          backend: backendMessage.slice(0, 200),
          action: 'forcing compaction, retrying once',
        });
        let forced: Compaction | null = null;
        let forceErr: string | undefined;
        if (alreadyRetried) {
          forceErr = 'the prompt still does not fit after a forced compaction';
        } else {
          try {
            forced = await runCompaction({
            systemPrompt,
            history,
            resolvedModel,
            availableModels,
            compactions,
            config: {
              ...compactionConfig,
                safetyCushionPairs: Math.min(1, compactionConfig.safetyCushionPairs),
              },
            });
          } catch (cErr) {
            forceErr = String((cErr as Error)?.message ?? cErr);
          }
        }
        if (forced) {
          const freshMeta = (await metaStore.get(agent, session)) as OpenAiCompatibleMeta;
          const nextCompactions = [...(freshMeta.compactions ?? []), forced];
          await metaStore.set(agent, session, { ...freshMeta, compactions: nextCompactions });
          logger.info({
            msg: 'engine.compaction_done',
            engine: ENGINE,
            agent,
            session,
            reason: 'context_overflow',
            throughTs: forced.throughTs,
            tokensBefore: forced.tokensBefore,
            tokensAfter: forced.tokensAfter,
          });
          yield {
            kind: 'engine_meta',
            ts: ts(),
            engine: ENGINE,
            itemType: 'context_compacted',
            payload: {
              text:
                `history compacted for ${resolvedModel.modelId} (${resolvedModel.model.contextWindow.toLocaleString('en-US')}-token window) ` +
                `after the backend rejected the prompt — retrying`,
              reason: 'context_overflow',
              backend: backendMessage.slice(0, 300),
              tokensBefore: forced.tokensBefore,
              tokensAfter: forced.tokensAfter,
            },
          };
          disarmIdleTimer();
          if (signal) signal.removeEventListener('abort', onUpstreamAbort);
          // Re-run the whole turn against the compacted history. The
          // retry re-reads meta (compactions), rebuilds messages and
          // owns its own watchdog; its turn_start is dropped so the
          // consumer sees exactly one turn.
          for await (const ev of openAiCompatibleEngine.runTurn(input)) {
            if (ev.kind === 'turn_start') continue;
            yield ev;
          }
          return;
        }
        const why = alreadyRetried
          ? forceErr
          : forceErr
            ? `compaction failed: ${forceErr}`
            : 'nothing older could be compacted (the conversation is already down to its last exchange)';
        logger.error({
          msg: 'engine.fail',
          engine: ENGINE,
          agent,
          session,
          err: `context overflow, ${why}`,
        });
        yield {
          kind: 'error',
          ts: ts(),
          engine: ENGINE,
          message:
            `The conversation no longer fits ${resolvedModel.modelId}'s context window ` +
            `(${resolvedModel.model.contextWindow.toLocaleString('en-US')} tokens) and ${why}. ` +
            `Switch to a model with a larger window (/model) or start a new session (/reset). ` +
            `Backend: ${backendMessage.slice(0, 200)}`,
        };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      } else {
        logger.error({ msg: 'engine.fail', engine: ENGINE, agent, session, err: String(err) });
        yield { kind: 'error', ts: ts(), engine: ENGINE, message: (err as Error).message };
        yield { kind: 'turn_end', ts: ts(), engine: ENGINE, turnId };
      }
    } finally {
      disarmIdleTimer();
      if (signal) signal.removeEventListener('abort', onUpstreamAbort);
    }
  },
};
