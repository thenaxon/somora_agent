// Resource visibility — combines the global config.resources record
// with the calling agent's resource_deny list. Single source of truth
// for "what does THIS agent see right now?".

import { getFreshConfig } from '../../config/loader.ts';
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

// ─────────────────────────────────────────────────────────────────────
// Fresh-config variants — re-read config.yaml on each call (lazy
// mtime-check, see config/loader.ts:getFreshConfig). Use these from
// resource_list / resource_test / file_*-with-target so that an agent
// (or user) can edit `resources:` in config.yaml and have the new
// entry visible IMMEDIATELY without a server restart. The plain
// (config-param) variants stay around for callers that want to pin
// a specific config snapshot.
// ─────────────────────────────────────────────────────────────────────

export async function visibleResourcesForAgentFresh(
  agentName: string,
): Promise<VisibleResource[]> {
  const config = await getFreshConfig();
  return visibleResourcesForAgent(agentName, config);
}

export async function resolveVisibleResourceFresh(
  agentName: string,
  name: string,
): Promise<Resource | null> {
  const config = await getFreshConfig();
  return resolveVisibleResource(agentName, config, name);
}
