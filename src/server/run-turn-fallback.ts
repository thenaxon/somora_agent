// Engine-fallback runner. Tries the primary engine first; if it fails
// before producing any assistant content (delta or final message) AND
// before invoking any tool AND the persona has `fallback:` configured,
// transparently re-tries with the next candidate in the chain. On
// partial-success-then-fail, on no-fallback, or on success — behaves
// like a plain engine.runTurn() pass-through.
//
// `fallback:` is one ref or an ordered list (since 2026-09-08). The
// candidates are tried in order, each under the same rule: only a
// candidate that died before producing anything hands over to the
// next. Every hop is announced with a `model_fallback` event that
// carries the whole chain so far in `hops`.
//
// Tool activity counts as content on purpose: a turn that ran a
// side-effectful tool (file write, exec, spawn) and THEN died is not
// safely re-runnable — the next candidate would execute the tools a
// second time. Better a visible error than a silent double-execution.

import { resolveAnyRef, type Config, type ResolvedModel } from '../config/types.ts';
import { engineRegistry } from '../engine/registry.ts';
import type { TurnInput } from '../engine/types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { logger } from './logger.ts';

interface Args {
  primary: ResolvedModel | null;
  /** Ordered fallback refs (alias or provider/modelId). Empty = none. */
  fallbackRefs: readonly string[];
  baseInput: Omit<TurnInput, 'resolvedModel'>;
  config?: Config;
}

const REASON_MAX = 300;

function label(m: ResolvedModel): string {
  return `${m.providerName}/${m.modelId}`;
}

/** One attempt: stream the engine, swallow a pre-content failure. Returns
 *  the failure message when the attempt produced nothing and died, or
 *  null when the attempt produced content (its events were yielded,
 *  including any later error — that is not retried). */
async function* attempt(
  model: ResolvedModel,
  input: TurnInput,
  onFail: (message: string) => void,
): AsyncGenerator<NormalizedEvent> {
  const engine = engineRegistry[model.provider.engine];
  if (!engine) {
    onFail(`engine '${model.provider.engine}' not registered`);
    return;
  }
  // Two different reasons not to switch models, and they are not the
  // same reason.
  //
  // A tool ran: the turn had side effects. Re-running it on another
  // model would do them again, so the failure stands whatever caused it.
  //
  // Text arrived: normally that means the model was answering, and a
  // late failure should not buy a second full answer. But a provider
  // that streams "you are out of quota" as ordinary assistant text and
  // only then reports the error produced no answer at all — that text
  // used to set this guard and silently disable a correctly configured
  // fallback chain (2026-09-09 report). So text yields to an error the
  // ENGINE marked as a provider failure. Never to a text match: the
  // engine adapter is the only place that knows how its provider dresses
  // a refusal.
  let sawToolCall = false;
  let sawText = false;
  let failure: string | null = null;
  const mayRetry = (providerError: boolean): boolean => {
    if (sawToolCall || input.signal?.aborted) return false;
    return !sawText || providerError;
  };
  try {
    for await (const ev of engine.runTurn(input)) {
      if (ev.kind === 'tool_call') sawToolCall = true;
      if (ev.kind === 'assistant_delta' || ev.kind === 'assistant_message') sawText = true;
      if (ev.kind === 'error' && mayRetry(ev.providerError === true)) {
        failure = ev.message;
        continue;
      }
      if (ev.kind === 'turn_end' && failure) continue;
      yield ev;
    }
  } catch (err) {
    // A throw never reaches the client as text, so it is a transport or
    // provider failure by definition — the engines catch their own
    // recoverable cases and yield an error event instead.
    if (!mayRetry(true)) throw err;
    failure = (err as Error).message;
  }
  if (failure) onFail(failure);
}

export async function* runTurnWithFallback(args: Args): AsyncGenerator<NormalizedEvent> {
  const { primary, fallbackRefs, baseInput, config } = args;
  if (!primary) return;

  /** Every model tried so far that died before producing anything. */
  const hops: Array<{ model: string; reason: string }> = [];
  let current: ResolvedModel = primary;
  // Holder rather than a plain `let`: the failure is written from the
  // attempt() callback, which TypeScript's narrowing cannot see.
  const failed: { message: string | null } = { message: null };
  const onFail = (m: string): void => {
    failed.message = m;
  };

  for await (const ev of attempt(current, { ...baseInput, resolvedModel: current }, onFail)) {
    yield ev;
  }
  if (failed.message === null) return;
  hops.push({ model: label(primary), reason: failed.message.slice(0, REASON_MAX) });

  const fail = (message: string, engine: string, withTurnEnd: boolean): NormalizedEvent[] => {
    const out: NormalizedEvent[] = [{ kind: 'error', ts: Date.now(), engine, message }];
    if (withTurnEnd) out.push({ kind: 'turn_end', ts: Date.now(), engine, turnId: `t-${Date.now()}` });
    return out;
  };

  if (fallbackRefs.length === 0) {
    yield* fail(failed.message, primary.provider.engine, true);
    return;
  }
  if (!config) {
    yield* fail(failed.message, primary.provider.engine, false);
    return;
  }

  // Refs that don't resolve (typo, model removed from config.yaml) or
  // that point at the model that just failed are skipped with a log
  // line — a chain with one bad entry must not lose the good ones.
  const tried = new Set<string>([label(primary)]);
  for (let hop = 0; hop < fallbackRefs.length; hop++) {
    const ref = fallbackRefs[hop]!;
    const candidate = resolveAnyRef(config, ref);
    if (!candidate) {
      logger.warn({ msg: 'engine.fallback_unresolved', hop: hop + 1, ref, after: label(current) });
      hops.push({ model: ref, reason: `fallback '${ref}' could not be resolved` });
      continue;
    }
    if (tried.has(label(candidate))) {
      logger.warn({ msg: 'engine.fallback_duplicate', hop: hop + 1, ref, model: label(candidate) });
      continue;
    }
    tried.add(label(candidate));
    if (!engineRegistry[candidate.provider.engine]) {
      logger.warn({ msg: 'engine.fallback_engine_missing', hop: hop + 1, ref, engine: candidate.provider.engine });
      hops.push({ model: label(candidate), reason: `engine '${candidate.provider.engine}' not registered` });
      continue;
    }

    const previousError = failed.message ?? '';
    logger.info({
      msg: 'engine.fallback_to',
      hop: hop + 1,
      previous: label(current),
      previous_error: previousError.slice(0, REASON_MAX),
      fallback_provider: candidate.providerName,
      fallback_model: candidate.modelId,
    });
    // Make the switch visible: persisted (history marks the turn) and
    // broadcast (live clients show a chip + notice). `requested` stays
    // the persona's primary across every hop so the chip always reads
    // "primary → who actually answered"; `hops` carries the full chain.
    yield {
      kind: 'model_fallback',
      ts: Date.now(),
      engine: 'somora',
      requested: label(primary),
      actual: label(candidate),
      reason: previousError.slice(0, REASON_MAX),
      hops: [...hops],
    };

    // Recompute the watchdog timeout for the candidate's engine — the
    // previous value would otherwise stick (e.g. claude-cli 300s used
    // against a 20-min openai-compatible fallback would false-positive
    // long local-model runs).
    const input: TurnInput = {
      ...baseInput,
      resolvedModel: candidate,
      idleTimeoutMs: pickIdleTimeoutForEngine(config.engineWatchdog, candidate.provider.engine),
    };
    current = candidate;
    failed.message = null;
    for await (const ev of attempt(current, input, onFail)) {
      yield ev;
    }
    // Read through a call: after the `= null` above TypeScript keeps
    // the property narrowed to null and cannot see the callback write.
    const hopFailure = readFailure(failed);
    if (hopFailure === null) return;
    hops.push({ model: label(candidate), reason: hopFailure.slice(0, REASON_MAX) });
    logger.error({
      msg: 'engine.fallback_failed_too',
      hop: hop + 1,
      model: label(candidate),
      error: hopFailure.slice(0, REASON_MAX),
      chain: hops,
    });
  }

  // Every candidate died before producing anything. The one `error`
  // row the user sees must name ALL failures — a raw last-hop error
  // with no hint why that model was asked at all looks like "the agent
  // does not answer" (2026-09-06 Astra report).
  const summary =
    hops.length === 1
      ? hops[0]!.reason
      : `All ${hops.length} models failed. ` + hops.map((h) => `${h.model}: ${h.reason}`).join(' — ');
  yield* fail(summary, current.provider.engine, true);
}

function readFailure(holder: { message: string | null }): string | null {
  return holder.message;
}

function pickIdleTimeoutForEngine(
  cfg: import('../config/types.ts').EngineWatchdogConfig,
  engine: import('../config/types.ts').EngineName,
): number {
  switch (engine) {
    case 'claude-cli':
      return cfg.claudeCliIdleMs;
    case 'codex-cli':
      return cfg.codexCliIdleMs;
    case 'grok-cli':
      return cfg.grokCliIdleMs;
    case 'openai-compatible':
      return cfg.openaiCompatibleIdleMs;
  }
}
