// Workspace directory resolution + auto-mkdir at server start.
//
// Hierarchy:
//   1. agent.yaml `workspace.path` (per-agent override, expanded ~ on
//      load — surfaced as persona.workspace)
//   2. config.yaml `workspace.default` (server-global fallback)
//
// Both are materialised at startup so the user sees the dirs whether
// or not anyone has chatted yet, and so file_* tools never have to
// race a first-write mkdir.

import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/types.ts';
import type { Persona } from '../persona/loader.ts';
import { logger } from './logger.ts';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Effective workspace path for an agent: per-agent override beats
 * server-global default. Both pre-expanded (no ~ in the return).
 */
export function effectiveWorkspace(persona: Persona, config: Config): string {
  if (persona.workspace) return persona.workspace;
  return expandHome(config.workspace.default);
}

/**
 * Create the global default workspace plus every per-agent override
 * if not already there. Logs once per dir created. Idempotent.
 */
export async function ensureWorkspaceDirs(personas: Persona[], config: Config): Promise<void> {
  const seen = new Set<string>();
  const queue: { path: string; label: string }[] = [];

  const globalPath = expandHome(config.workspace.default);
  queue.push({ path: globalPath, label: 'global default' });
  seen.add(globalPath);

  for (const p of personas) {
    if (!p.workspace) continue;
    if (seen.has(p.workspace)) continue;
    queue.push({ path: p.workspace, label: `agent '${p.name}' override` });
    seen.add(p.workspace);
  }

  for (const { path, label } of queue) {
    try {
      const existed = await pathExists(path);
      await mkdir(path, { recursive: true });
      if (!existed) {
        logger.info({ msg: 'workspace.created', path, source: label });
      } else {
        logger.debug({ msg: 'workspace.ok', path, source: label });
      }
    } catch (err) {
      logger.warn({
        msg: 'workspace.ensure_failed',
        path,
        source: label,
        err: (err as Error).message,
      });
    }
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Self-pointer block prepended to the persona system prompt at chat
 * time. Tells the agent who it is, where its files live, and which
 * resources are configured — so it can self-edit its persona, find
 * its config, and address remote targets without guessing paths.
 *
 * Stable per session (no per-turn data) so engines that cache
 * systemPrompt (claude-cli, codex-cli prefix-cache) keep their cache
 * intact.
 */
export function buildSelfPointer(persona: Persona, config: Config, somoraHome: string): string {
  const ws = effectiveWorkspace(persona, config);
  const agentDir = join(somoraHome, 'agents', persona.name);
  const visibleResources = Object.entries(config.resources)
    .filter(([name]) => !persona.resourceDeny.includes(name))
    .map(([name, r]) => `${name} (${r.type}, ${r.host})`);
  const resourceLine =
    visibleResources.length > 0
      ? visibleResources.join(', ')
      : '(none configured — `resource_list` would return empty)';
  return [
    '# System context',
    `- You are agent \`${persona.name}\` in a somora server.`,
    `- Your persona files: ${agentDir}/{AGENTS,SOUL,USER}.md`,
    `- Your agent config: ${agentDir}/agent.yaml`,
    `- Your default workspace: ${ws}`,
    `- Global server config: ${join(somoraHome, 'config.yaml')}`,
    `- Read somora's own docs via \`somora_docs_list\` and \`somora_docs_read\` to learn how the system works.`,
    `- Configured remote resources: ${resourceLine}`,
  ].join('\n');
}
