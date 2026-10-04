// The worker of a dream phase with its backups (deep-llm.ts).

import { resolveAnyRef, workerChain, type Config, type ResolvedModel } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { setOneShotFallbacks } from './deep-llm.ts';

export type DreamPhase = 'deep' | 'lucid';

/** Resolve `wiki.<phase>.model` and attach `wiki.<phase>.fallback` to
 *  it. A backup that does not resolve is skipped with an error line —
 *  the boot check refuses such a config, this is the safety net for a
 *  config reloaded later. */
export function resolveDreamWorker(config: Config, phase: DreamPhase): { ref: string | undefined; model: ResolvedModel | null; fallbacks: ResolvedModel[] } {
  const section = config.wiki[phase];
  const ref = section.model;
  const model = ref ? resolveAnyRef(config, ref) : null;
  const fallbacks: ResolvedModel[] = [];
  if (model) {
    for (const fb of workerChain(section.fallback)) {
      const m = resolveAnyRef(config, fb);
      if (!m) {
        logger.error({ msg: `dream.${phase}.fallback_unresolved`, ref: fb });
        continue;
      }
      if (m.providerName === model.providerName && m.modelId === model.modelId) continue;
      fallbacks.push(m);
    }
    setOneShotFallbacks(model, fallbacks);
  }
  return { ref, model, fallbacks };
}
