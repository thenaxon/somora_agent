// Settings that name a model or provider configured elsewhere
// (catalog SETTING_REFS): the names the settings window offers for them,
// and the check that keeps Apply from leaving a name pointing nowhere —
// a model removed while an agent, a dream phase or a fallback chain still
// uses it would only show up later as a failed turn.

import { resolveAnyRef, type Config } from '../types.ts';
import { SETTING_REFS, type RefKind } from './catalog/index.ts';

/** Every name a reference of each kind can take in this configuration. */
export function refOptions(config: Config): Record<RefKind, string[]> {
  const models: string[] = [];
  for (const [providerName, provider] of Object.entries(config.providers)) {
    for (const m of provider.models) {
      if (m.alias) models.push(m.alias);
      models.push(`${providerName}/${m.id}`);
    }
  }
  return {
    model: models,
    provider: Object.keys(config.providers),
    'image-model': (config.imageGen?.models ?? []).map((m) => m.name),
    'video-model': (config.videoGen?.models ?? []).map((m) => m.name),
    'decision-model': (config.decisions?.models ?? []).map((m) => m.name),
  };
}

function resolves(config: Config, kind: RefKind, name: string): boolean {
  if (kind === 'model') return resolveAnyRef(config, name) !== null;
  return refOptions(config)[kind].includes(name);
}

/** The values at a field path (`imageGen.models.*.provider`), with the
 *  concrete path of each. */
function valuesAt(data: unknown, path: string[], at: string[] = []): Array<[string, unknown]> {
  if (path.length === 0) return [[at.join('.'), data]];
  if (data === null || typeof data !== 'object') return [];
  const [head, ...rest] = path;
  if (head === '*') {
    const entries = Array.isArray(data) ? data.map((v, i) => [String(i), v] as const) : Object.entries(data);
    return entries.flatMap(([k, v]) => valuesAt(v, rest, [...at, k]));
  }
  return valuesAt((data as Record<string, unknown>)[head!], rest, [...at, head!]);
}

const names = (v: unknown): string[] => (typeof v === 'string' && v !== '' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

export interface AgentModels {
  agent: string;
  model?: string;
  fallback?: string[];
}

/** Names that resolved before the change and no longer do, with who uses
 *  them. Names that were already broken are left alone: the change did
 *  not break them. */
export function brokenRefs(before: Config, after: Config, agents: AgentModels[]): Array<{ path: string; message: string }> {
  const out: Array<{ path: string; message: string }> = [];
  for (const [field, kind] of Object.entries(SETTING_REFS)) {
    for (const [path, value] of valuesAt(after, field.split('.'))) {
      for (const name of names(value)) {
        if (resolves(before, kind, name) && !resolves(after, kind, name)) {
          out.push({ path, message: `${path} still names '${name}', which this change removes` });
        }
      }
    }
  }
  for (const a of agents) {
    for (const name of [...names(a.model), ...(a.fallback ?? [])]) {
      if (resolves(before, 'model', name) && !resolves(after, 'model', name)) {
        out.push({ path: 'providers', message: `agent ${a.agent} uses model '${name}', which this change removes; give the agent another model first` });
      }
    }
  }
  return out;
}
