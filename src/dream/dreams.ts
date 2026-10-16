// The `dreams` switch at run time (private/dream-switch/KONZEPT.md):
// which REM settings an agent that dreams runs with, and keeping the REM
// worker's list in step with the switch. The tools follow the switch in
// src/tools/gating.ts, Deep's participants in src/server/index.ts, the
// vault's write lock in src/tools/file/policy.ts.

import type { Config } from '../config/types.ts';
import { RemConfigSchema, type Persona, type RemConfig } from '../persona/loader.ts';

/** REM settings with the worker model settled. */
export type ResolvedRem = RemConfig & { model: string };

export type RemSettings =
  | { ok: true; rem: ResolvedRem; modelFrom: 'agent' | 'config' }
  | { ok: false; reason: 'does-not-dream' | 'no-model' };

/** What REM runs with for this agent: its own `rem` block, the worker
 *  model from there or else the central `rem.model` in config.yaml. */
export function remSettingsFor(persona: Pick<Persona, 'dreams' | 'rem'>, config: Pick<Config, 'rem'>): RemSettings {
  if (!persona.dreams) return { ok: false, reason: 'does-not-dream' };
  const own = RemConfigSchema.parse(persona.rem ?? {});
  if (own.model) return { ok: true, rem: { ...own, model: own.model }, modelFrom: 'agent' };
  const central = config.rem.model;
  if (!central) return { ok: false, reason: 'no-model' };
  const { fallback: _ownFallback, ...rest } = own;
  return {
    ok: true,
    rem: { ...rest, model: central, ...(config.rem.fallback ? { fallback: config.rem.fallback } : {}) },
    modelFrom: 'config',
  };
}

export interface RemRegistry {
  register(agent: string, rem: ResolvedRem): void;
  unregister(agent: string): void;
}

/** Bring the REM worker in line with one agent's switch: registered with
 *  its current settings when it dreams and has a model, off otherwise. */
export function syncRemRegistration(
  worker: RemRegistry,
  agent: string,
  persona: Pick<Persona, 'dreams' | 'rem'>,
  config: Pick<Config, 'rem'>,
): RemSettings {
  const settings = remSettingsFor(persona, config);
  if (settings.ok) worker.register(agent, settings.rem);
  else worker.unregister(agent);
  return settings;
}
