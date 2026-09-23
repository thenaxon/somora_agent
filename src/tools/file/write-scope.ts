// Where a builder may write.
//
// A builder session pinned to a project folder writes there and in its
// own temp folder — nowhere else. A chat agent is not affected, and a
// builder without a pinned folder keeps the old rule (the write
// blacklist alone). The check runs after the path blacklist, in the
// same place for file_write and file_patch, in-process and in the MCP
// child (the question goes over loopback HTTP, so both reach the panel).
//
// Outside the scope:
//   unattended — refused, the message names the allowed folders.
//   attended   — a question in the task panel: allow once, allow this
//                folder for the session, deny. The session-wide grants
//                live on the session meta (`builderWriteAllow`).
// The shell can still write anywhere; that is what command approvals
// (stage 3, not built) would gate. Documented as the limit.

import { dirname, isAbsolute, normalize, sep } from 'node:path';
import { homedir } from 'node:os';
import type { Config } from '../../config/types.ts';
import { loadPersona } from '../../persona/loader.ts';
import { readBuilderState } from '../../server/builder-session.ts';
import { classifyFetchError, loopbackFetch } from '../../server/loopback-fetch.ts';
import { logger } from '../../server/logger.ts';
import { pinnedWorkdir } from '../../server/session-workdir.ts';
import { sessionMetaStore } from '../../storage/sessions.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? `${homedir()}/.somora`;
/** How long the panel question waits before the write counts as denied. */
export const WRITE_SCOPE_QUESTION_TIMEOUT_MS = 5 * 60_000;

export function agentTempDir(agent: string): string {
  return normalize(`${SOMORA_HOME}/agents/${agent}/tmp`);
}

function isUnder(path: string, root: string): boolean {
  const r = normalize(root).replace(/[\\/]+$/, '');
  const p = normalize(path);
  return p === r || p.startsWith(r + sep);
}

/** The folders a builder pinned to `workdir` may write in. */
export function writeScopeRoots(agent: string, workdir: string, extra: readonly string[] = []): string[] {
  return [normalize(workdir), agentTempDir(agent), ...extra.map((e) => normalize(e))];
}

export function isWithinRoots(absolute: string, roots: readonly string[]): boolean {
  return roots.some((r) => isUnder(absolute, r));
}

export type WriteScopeVerdict =
  | { kind: 'unscoped' } // chat agent, or builder without a pinned folder
  | { kind: 'inside' }
  | { kind: 'refused'; reason: string }
  | { kind: 'ask'; roots: string[] };

/** Pure decision from what the session says; no I/O. */
export function decideWriteScope(args: {
  absolute: string;
  kind: 'chat' | 'builder';
  workdir: string | null;
  mode: 'attended' | 'unattended' | null;
  agent: string;
  sessionGrants: readonly string[];
}): WriteScopeVerdict {
  if (args.kind !== 'builder' || !args.workdir) return { kind: 'unscoped' };
  const roots = writeScopeRoots(args.agent, args.workdir, args.sessionGrants);
  if (isWithinRoots(args.absolute, roots)) return { kind: 'inside' };
  if (args.mode === 'attended') return { kind: 'ask', roots };
  return {
    kind: 'refused',
    reason:
      `write refused: '${args.absolute}' is outside the project folder. A builder writes only inside ` +
      `${roots[0]} (the pinned project) or ${roots[1]} (its temp folder). Use a path inside the project, ` +
      'or say in your report why the file is needed elsewhere.',
  };
}

function baseUrl(): string {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  return `${scheme}://${host}:${port}`;
}

const OPTION_ONCE = 'Allow once';
const OPTION_SESSION = 'Allow this folder for the session';
const OPTION_DENY = 'Deny';

/** Ask the person in the task panel. Resolves when allowed, throws when
 *  denied or unanswered. */
async function askPerson(agent: string, session: string, absolute: string, roots: string[]): Promise<void> {
  const folder = dirname(absolute);
  let res;
  try {
    res = await loopbackFetch(`${baseUrl()}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        header: 'Write outside the project',
        question:
          `The builder wants to write ${absolute}, which is outside the project folder (${roots[0]}). ` +
          `Allow it?`,
        options: [
          { label: OPTION_ONCE, description: 'This file, this time.' },
          { label: OPTION_SESSION, description: `Any file under ${folder} for the rest of this session.` },
          { label: OPTION_DENY, description: 'The write is refused; the builder is told to stay inside the project.' },
        ],
        multiple: false,
        timeout_ms: WRITE_SCOPE_QUESTION_TIMEOUT_MS,
      }),
    });
  } catch (err) {
    const c = classifyFetchError(err);
    throw new Error(`write refused: '${absolute}' is outside the project folder and the person could not be asked [${c.category}]: ${c.message}`);
  }
  const answer = (await res.json().catch(() => ({}))) as { answered?: boolean; answers?: string[]; text?: string; error?: string };
  if (!res.ok) throw new Error(`write refused: '${absolute}' is outside the project folder and the question failed: ${answer.error ?? res.status}`);
  const chosen = answer.answers?.[0] ?? '';
  if (answer.answered && chosen === OPTION_ONCE) {
    logger.info({ msg: 'builder.write_scope_allowed_once', agent, session, path: absolute });
    return;
  }
  if (answer.answered && chosen === OPTION_SESSION) {
    await sessionMetaStore.update(agent, session, (current) => {
      const prev = Array.isArray((current as Record<string, unknown>).builderWriteAllow)
        ? ((current as Record<string, unknown>).builderWriteAllow as string[])
        : [];
      return { ...current, builderWriteAllow: [...new Set([...prev, folder])] } as typeof current;
    });
    logger.info({ msg: 'builder.write_scope_allowed_session', agent, session, folder });
    return;
  }
  logger.info({ msg: 'builder.write_scope_denied', agent, session, path: absolute, answered: answer.answered, chosen });
  throw new Error(
    answer.answered
      ? `write refused: the person did not allow writing '${absolute}' outside the project folder. Stay inside ${roots[0]}.`
      : `write refused: '${absolute}' is outside the project folder and the person did not answer in time. Stay inside ${roots[0]}.`,
  );
}

/** The gate file_write and file_patch pass through after the blacklist. */
export async function enforceWriteScope(args: { absolute: string; agent: string; session?: string; config: Config }): Promise<void> {
  if (!args.session || !isAbsolute(args.absolute)) return;
  const persona = await loadPersona(args.agent);
  if (!persona || persona.kind !== 'builder') return;
  const workdir = await pinnedWorkdir(args.agent, args.session);
  if (!workdir) return;
  const meta = (await sessionMetaStore.get(args.agent, args.session)) as Record<string, unknown>;
  const state = readBuilderState(meta);
  const grants = Array.isArray(meta.builderWriteAllow) ? (meta.builderWriteAllow as string[]) : [];
  const verdict = decideWriteScope({
    absolute: args.absolute,
    kind: 'builder',
    workdir,
    mode: state?.mode ?? 'unattended',
    agent: args.agent,
    sessionGrants: grants,
  });
  if (verdict.kind === 'unscoped' || verdict.kind === 'inside') return;
  if (verdict.kind === 'refused') {
    logger.info({ msg: 'builder.write_scope_refused', agent: args.agent, session: args.session, path: args.absolute, workdir });
    throw new Error(verdict.reason);
  }
  await askPerson(args.agent, args.session, args.absolute, verdict.roots);
}
