// External agents as somora knows them (docs/external-agents.md): read
// from config.yaml `external.systems`, never from ~/.somora/agents/. The
// core's agent paths (loadPersona, listAgents) stay unaware of them; the
// few places that serve external agents ask here instead.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config, ExternalAgentConfig, ExternalSystemConfig } from '../config/types.ts';
import { loadPersona } from '../persona/loader.ts';
import { config as liveConfig } from '../server/server-state.ts';

export interface ExternalAgent {
  /** The name in somora (unique, also against somora's own agents). */
  name: string;
  system: string;
  systemConfig: ExternalSystemConfig;
  agent: ExternalAgentConfig;
}

/** A somora agent of this name exists on disk. It always wins: an
 *  external agent can never take a somora agent's place. */
export function nativeAgentExists(name: string): boolean {
  const home = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  return existsSync(join(home, 'agents', name, 'AGENTS.md'));
}

/** Every external agent in the config, except those whose name a somora
 *  agent already has (listed by `externalNameClashes`). */
export function listExternalAgents(config: Config = liveConfig): ExternalAgent[] {
  const out: ExternalAgent[] = [];
  for (const [system, sys] of Object.entries(config?.external?.systems ?? {})) {
    for (const [name, agent] of Object.entries(sys.agents)) {
      if (nativeAgentExists(name)) continue;
      out.push({ name, system, systemConfig: sys, agent });
    }
  }
  return out;
}

/** External agent names that a somora agent already has — ignored. */
export function externalNameClashes(config: Config = liveConfig): Array<{ name: string; system: string }> {
  const out: Array<{ name: string; system: string }> = [];
  for (const [system, sys] of Object.entries(config?.external?.systems ?? {})) {
    for (const name of Object.keys(sys.agents)) if (nativeAgentExists(name)) out.push({ name, system });
  }
  return out;
}

/** The external agent of this name, or null for a somora agent / nothing. */
export function getExternalAgent(name: string, config: Config = liveConfig): ExternalAgent | null {
  for (const [system, sys] of Object.entries(config?.external?.systems ?? {})) {
    const agent = sys.agents[name];
    if (agent) return nativeAgentExists(name) ? null : { name, system, systemConfig: sys, agent };
  }
  return null;
}

export function isExternalAgent(name: string, config: Config = liveConfig): boolean {
  return getExternalAgent(name, config) !== null;
}

/** Model ref shown for an external agent's sessions: `external/<system>`. */
export function externalModelRef(ext: ExternalAgent): { provider: string; model: string } {
  return { provider: 'external', model: `${ext.system}/${ext.name}` };
}

/** A somora agent or an external agent of this name exists — for routes
 *  that only need to know the name is real (history, stream, sessions). */
export async function agentKnown(name: string, config: Config = liveConfig): Promise<boolean> {
  return isExternalAgent(name, config) || (await loadPersona(name)) !== null;
}
