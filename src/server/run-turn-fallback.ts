// Engine-fallback runner. Tries the primary engine first; if it fails
// before producing any assistant content (delta or final message) AND
// before invoking any tool AND the persona has `fallback:` configured,
// transparently re-tries with the fallback model. On partial-success-
// then-fail, on no-fallback, or on success — behaves like a plain
// engine.runTurn() pass-through.
//
// Tool activity counts as content on purpose: a turn that ran a
// side-effectful tool (file write, exec, spawn) and THEN died is not
// safely re-runnable — the fallback would execute the tools a second
// time. Better a visible error than a silent double-execution.

import { resolveAnyRef, type Config, type ResolvedModel } from '../config/types.ts';
import { engineRegistry } from '../engine/registry.ts';
import type { TurnInput } from '../engine/types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { logger } from './logger.ts';

interface Args {
  primary: ResolvedModel | null;
  fallbackRef: string | undefined;
  baseInput: Omit<TurnInput, 'resolvedModel'>;
  config?: Config;
}

export async function* runTurnWithFallback(args: Args): AsyncGenerator<NormalizedEvent> {
  const { primary, fallbackRef, baseInput, config } = args;
  if (!primary) return;
  const primaryEngine = engineRegistry[primary.provider.engine];
  if (!primaryEngine) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: primary.provider.engine,
      message: `engine '${primary.provider.engine}' not registered`,
    };
    return;
  }

  let hasContent = false;
  let primaryError: string | null = null;

  try {
    for await (const ev of primaryEngine.runTurn({ ...baseInput, resolvedModel: primary })) {
      if (ev.kind === 'assistant_delta' || ev.kind === 'assistant_message' || ev.kind === 'tool_call') {
        hasContent = true;
      }
      if (ev.kind === 'error' && !hasContent) {
        primaryError = ev.message;
        continue;
      }
      if (ev.kind === 'turn_end' && primaryError) continue;
      yield ev;
    }
  } catch (err) {
    if (hasContent) throw err;
    primaryError = (err as Error).message;
  }

  if (!primaryError) return;

  if (!fallbackRef) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: primary.provider.engine,
      message: primaryError,
    };
    yield {
      kind: 'turn_end',
      ts: Date.now(),
      engine: primary.provider.engine,
      turnId: `t-${Date.now()}`,
    };
    return;
  }

  if (!config) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: primary.provider.engine,
      message: primaryError,
    };
    return;
  }

  const fallbackResolved = resolveAnyRef(config, fallbackRef);
  if (!fallbackResolved) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: primary.provider.engine,
      message: `${primaryError}; fallback '${fallbackRef}' could not be resolved`,
    };
    return;
  }
  const fallbackEngine = engineRegistry[fallbackResolved.provider.engine];
  if (!fallbackEngine) {
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: primary.provider.engine,
      message: `${primaryError}; fallback engine '${fallbackResolved.provider.engine}' fehlt`,
    };
    return;
  }

  logger.info({
    msg: 'engine.fallback_to',
    primary_error: primaryError,
    fallback_provider: fallbackResolved.providerName,
    fallback_model: fallbackResolved.modelId,
  });
  // Make the switch visible: persisted (history marks the turn) and
  // broadcast (live clients show a chip + notice). Until 2026-08-25 the
  // only trace was the log line above — the user saw a different
  // model's answer with no indication (2026-08-22 report).
  yield {
    kind: 'model_fallback',
    ts: Date.now(),
    engine: 'somora',
    requested: `${primary.providerName}/${primary.modelId}`,
    actual: `${fallbackResolved.providerName}/${fallbackResolved.modelId}`,
    reason: primaryError.slice(0, 300),
  };

  // Recompute the watchdog timeout for the fallback engine — the
  // primary's value would otherwise stick (e.g. claude-cli 300s used
  // against a 20-min openai-compatible fallback would false-positive
  // long local-model runs).
  const fallbackInput = {
    ...baseInput,
    resolvedModel: fallbackResolved,
    idleTimeoutMs: pickIdleTimeoutForEngine(
      config.engineWatchdog,
      fallbackResolved.provider.engine,
    ),
  };
  // When the fallback dies before producing anything either, the one
  // `error` row the user sees must name BOTH failures — the primary's
  // reason otherwise lives only in engine_meta/model_fallback and the
  // chat shows a raw fallback error with no hint why that model was
  // asked at all (2026-09-06 Astra report: 400 on primary + offline
  // fallback looked like "the agent does not answer").
  const primaryLabel = `${primary.providerName}/${primary.modelId}`;
  const fallbackLabel = `${fallbackResolved.providerName}/${fallbackResolved.modelId}`;
  const bothFailed = (fallbackError: string): string =>
    `Both models failed. Primary ${primaryLabel}: ${primaryError.slice(0, 300)} — ` +
    `fallback ${fallbackLabel}: ${fallbackError.slice(0, 300)}`;
  let fallbackHasContent = false;
  try {
    for await (const ev of fallbackEngine.runTurn(fallbackInput)) {
      if (ev.kind === 'assistant_delta' || ev.kind === 'assistant_message' || ev.kind === 'tool_call') {
        fallbackHasContent = true;
      }
      if (ev.kind === 'error' && !fallbackHasContent) {
        logger.error({
          msg: 'engine.fallback_failed_too',
          primary: primaryLabel,
          primary_error: primaryError.slice(0, 300),
          fallback: fallbackLabel,
          fallback_error: ev.message.slice(0, 300),
        });
        yield { ...ev, message: bothFailed(ev.message) };
        continue;
      }
      yield ev;
    }
  } catch (err) {
    if (fallbackHasContent) throw err;
    const message = (err as Error).message;
    logger.error({
      msg: 'engine.fallback_failed_too',
      primary: primaryLabel,
      primary_error: primaryError.slice(0, 300),
      fallback: fallbackLabel,
      fallback_error: message.slice(0, 300),
    });
    yield {
      kind: 'error',
      ts: Date.now(),
      engine: fallbackResolved.provider.engine,
      message: bothFailed(message),
    };
    yield {
      kind: 'turn_end',
      ts: Date.now(),
      engine: fallbackResolved.provider.engine,
      turnId: `t-${Date.now()}`,
    };
  }
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
