// Resource visibility — combines the global config.resources record
// with the calling agent's resource_deny list. Single source of truth
// for "what does THIS agent see right now?".

import { loadPersona } from '../../persona/loader.ts';
import type { Config, Resource } from '../../config/types.ts';

export interface VisibleResource {
  name: string;
  resource: Resource;
}

export async function visibleResourcesForAgent(
  agentName: string,
  config: Config,
): Promise<VisibleResource[]> {
  const persona = await loadPersona(agentName);
  const denied = new Set(persona?.resourceDeny ?? []);
  const out: VisibleResource[] = [];
  for (const [name, resource] of Object.entries(config.resources)) {
    if (denied.has(name)) continue;
    out.push({ name, resource });
  }
  return out;
}

export async function resolveVisibleResource(
  agentName: string,
  config: Config,
  name: string,
): Promise<Resource | null> {
  const visible = await visibleResourcesForAgent(agentName, config);
  return visible.find((v) => v.name === name)?.resource ?? null;
}
