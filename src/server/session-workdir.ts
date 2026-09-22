// The working directory of a session.
//
// Until 2026-09-23 relative paths in the file tools resolved against
// the AGENT's workspace (agent.yaml `workspace.path`, else the server
// default) and exec's default cwd was the server process's cwd. A
// session pinned to a project that has a `workdir` (docs/projects.md)
// now works in that folder: file tools, exec, the builder's environment
// block and plan file. Without such a pin nothing changes.
//
// Stored on the session meta as `workdir` by focusProject (src/projects/
// focus.ts); read here by everyone who needs it. The meta file is small
// and read per call — a tool call already costs more than that.

import { isAbsolute } from 'node:path';
import type { Config } from '../config/types.ts';
import type { Persona } from '../persona/loader.ts';
import { sessionMetaStore } from '../storage/sessions.ts';
import { effectiveWorkspace } from './workspace.ts';

/** The pinned project's folder for this session, or null. */
export async function pinnedWorkdir(agent: string, session: string | undefined): Promise<string | null> {
  if (!session) return null;
  try {
    const meta = (await sessionMetaStore.get(agent, session)) as Record<string, unknown>;
    const w = meta.workdir;
    return typeof w === 'string' && isAbsolute(w) ? w : null;
  } catch {
    return null;
  }
}

/** Pinned project folder, else the agent's workspace. */
export async function sessionWorkdir(
  agent: string,
  session: string | undefined,
  persona: Persona,
  config: Config,
): Promise<{ path: string; source: 'project' | 'workspace' }> {
  const pinned = await pinnedWorkdir(agent, session);
  if (pinned) return { path: pinned, source: 'project' };
  return { path: effectiveWorkspace(persona, config), source: 'workspace' };
}

/** Same from session meta already in hand (no extra read). */
export function workdirFromMeta(meta: Record<string, unknown>, persona: Persona, config: Config): { path: string; source: 'project' | 'workspace' } {
  const w = meta.workdir;
  if (typeof w === 'string' && isAbsolute(w)) return { path: w, source: 'project' };
  return { path: effectiveWorkspace(persona, config), source: 'workspace' };
}
