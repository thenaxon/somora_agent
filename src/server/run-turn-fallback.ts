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
  for await (const ev of fallbackEngine.runTurn(fallbackInput)) {
    yield ev;
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
