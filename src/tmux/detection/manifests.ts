// Which rules decide a coding agent's state: herdr's manifests as
// shipped in ./manifests (taken over at release time, SOURCE.json says
// from which herdr commit), somora's own additions in ./somora-rules
// (rules herdr does not have yet, appended to its manifest of that agent;
// herdr's files stay untouched so the next take-over is a plain copy),
// and the person's own in <SOMORA_HOME>/tmux-detection/<agent>.json.
//
// A file of one's own wins over the shipped one for the same agent, and
// can add an agent somora does not ship. A file that does not parse or
// compile is skipped with a warning; the shipped rules stay in force —
// a broken edit must not blind detection.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger, SOMORA_HOME_DIR } from '../../server/logger.ts';
import {
  compileManifest,
  evaluate,
  type AgentManifest,
  type CompiledManifest,
  type Detection,
  type DetectionInput,
  type RuleEvaluation,
} from './engine.ts';

const BUNDLED_DIR = fileURLToPath(new URL('./manifests/', import.meta.url));
const SOMORA_RULES_DIR = fileURLToPath(new URL('./somora-rules/', import.meta.url));

/** herdr's manifest of an agent with somora's additions appended. */
function withSomoraRules(manifest: AgentManifest): AgentManifest {
  const path = join(SOMORA_RULES_DIR, `${manifest.id}.json`);
  if (!existsSync(path)) return manifest;
  const extra = readJson(path);
  return { ...manifest, rules: [...manifest.rules, ...extra.rules] };
}

export function overrideDir(): string {
  return join(SOMORA_HOME_DIR, 'tmux-detection');
}

export interface LoadedManifest {
  compiled: CompiledManifest;
  source: 'bundled' | 'override';
  /** Path of the override file, when it is one. */
  path?: string;
}

interface Registry {
  byId: Map<string, LoadedManifest>;
  /** alias or id → id */
  byName: Map<string, string>;
  warnings: string[];
}

let registry: Registry | null = null;

function readJson(path: string): AgentManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as AgentManifest;
}

function build(): Registry {
  const byId = new Map<string, LoadedManifest>();
  const warnings: string[] = [];
  for (const f of readdirSync(BUNDLED_DIR).filter((x) => x.endsWith('.json') && x !== 'SOURCE.json').sort()) {
    // Shipped rules that do not compile are a bug in this release; say so
    // loudly but keep the other agents.
    try {
      byId.set(f.slice(0, -5), { compiled: compileManifest(withSomoraRules(readJson(join(BUNDLED_DIR, f)))), source: 'bundled' });
    } catch (err) {
      const msg = `bundled ${f}: ${(err as Error).message}`;
      warnings.push(msg);
      logger.error({ msg: 'tmux.detection.bundled_invalid', file: f, err: (err as Error).message });
    }
  }
  const dir = overrideDir();
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const path = join(dir, f);
      try {
        const manifest = readJson(path);
        if (manifest.id !== f.slice(0, -5)) throw new Error(`id "${manifest.id}" does not match the file name`);
        byId.set(manifest.id, { compiled: compileManifest(manifest), source: 'override', path });
      } catch (err) {
        const msg = `${path}: ${(err as Error).message} — the shipped rules stay in force`;
        warnings.push(msg);
        logger.warn({ msg: 'tmux.detection.override_invalid', path, err: (err as Error).message });
      }
    }
  }
  const byName = new Map<string, string>();
  for (const [id, m] of byId) {
    byName.set(id, id);
    for (const alias of m.compiled.manifest.aliases ?? []) if (!byName.has(alias)) byName.set(alias, id);
  }
  return { byId, byName, warnings };
}

function reg(): Registry {
  registry ??= build();
  return registry;
}

/** Read the shipped and own rules again (after editing an override). */
export function reloadManifests(): { agents: string[]; warnings: string[] } {
  registry = build();
  return { agents: [...registry.byId.keys()], warnings: registry.warnings };
}

/** The agent id for an id, alias (`claude-code` → `claude`) or null. */
export function resolveAgent(name: string): string | null {
  return reg().byName.get(name) ?? null;
}

export function loadedManifest(agent: string): LoadedManifest | null {
  const id = resolveAgent(agent);
  return id ? (reg().byId.get(id) ?? null) : null;
}

export function knownAgents(): Array<{ id: string; version?: string; source: 'bundled' | 'override'; rules: number }> {
  return [...reg().byId.entries()].map(([id, m]) => ({
    id,
    ...(m.compiled.manifest.version ? { version: m.compiled.manifest.version } : {}),
    source: m.source,
    rules: m.compiled.rules.length,
  }));
}

export function detectionWarnings(): string[] {
  return reg().warnings;
}

/** State of `agent` on this screen; null for an agent without rules. */
export function detectAgentState(agent: string, input: DetectionInput): Detection | null {
  const m = loadedManifest(agent);
  return m ? evaluate(m.compiled, input) : null;
}

/** Like detectAgentState, with every rule's result and where the rules
 *  came from — the answer to "why this state?". */
export function explainAgentState(
  agent: string,
  input: DetectionInput,
): (Detection & { agent: string; source: 'bundled' | 'override'; version?: string; path?: string; rules: RuleEvaluation[] }) | null {
  const m = loadedManifest(agent);
  if (!m) return null;
  const rules: RuleEvaluation[] = [];
  const d = evaluate(m.compiled, input, rules);
  return {
    ...d,
    agent: m.compiled.manifest.id,
    source: m.source,
    ...(m.compiled.manifest.version ? { version: m.compiled.manifest.version } : {}),
    ...(m.path ? { path: m.path } : {}),
    rules,
  };
}
