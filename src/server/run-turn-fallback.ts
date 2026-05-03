// Engine-fallback runner. Tries the primary engine first; if it fails
// before producing any assistant content (delta or final message) AND
// the persona has `fallback:` configured, transparently re-tries with
// the fallback model. On partial-success-then-fail, on no-fallback,
// or on success — behaves like a plain engine.runTurn() pass-through.

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
      if (ev.kind === 'assistant_delta' || ev.kind === 'assistant_message') hasContent = true;
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
      message: `${primaryError}; fallback '${fallbackRef}' nicht aufgelöst`,
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

  for await (const ev of fallbackEngine.runTurn({ ...baseInput, resolvedModel: fallbackResolved })) {
    yield ev;
  }
}
