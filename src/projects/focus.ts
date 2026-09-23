// Session-focus helper. Single backend function shared by:
//   - the project_focus Tool surface (agent-initiated focus changes)
//   - the /projekt slash-command frontends (user-initiated focus changes
//     in TUI and Web)
//
// Both call here so the side-effects (sessionMeta mutation + JSONL
// forensic event) happen identically regardless of who triggered the
// switch. The `via` argument is the only difference and survives in
// the JSONL event for later "who did this" forensics.
//
// Validation responsibility: this helper checks that the project file
// exists when slug != null. It does NOT cross-check the project's
// archived state — focusing an archived project is allowed (the
// session may legitimately want to revisit one); archive only affects
// project_list visibility.

import { appendEvent } from '../storage/sessions.ts';
import type { SessionMetaStore } from '../engine/types.ts';
import { logger } from '../server/logger.ts';
import { projectExists, readProject } from './store.ts';
import { loadPersona } from '../persona/loader.ts';
import { loopbackFetch } from '../server/loopback-fetch.ts';

/** Is a turn running on the session? Asked over loopback so the answer is
 *  the same in the server and in the MCP child. Unreachable = not busy. */
async function sessionBusy(agent: string, session: string): Promise<boolean> {
  const host = process.env.SOMORA_HOST || '127.0.0.1';
  const port = process.env.SOMORA_PORT || '18737';
  const scheme = process.env.SOMORA_TLS === '1' ? 'https' : 'http';
  try {
    const res = await loopbackFetch(`${scheme}://${host}:${port}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(session)}/work`);
    if (!res.ok) return false;
    const d = (await res.json()) as { busy?: boolean };
    return d.busy === true;
  } catch {
    return false;
  }
}
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';

/** The project's working directory, expanded, or null when it has none
 *  or the value is not an absolute path after expansion. */
export async function projectWorkdir(slug: string): Promise<string | null> {
  const project = await readProject(slug);
  const raw = project?.workdir;
  if (!raw) return null;
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) {
    logger.warn({ msg: 'project.workdir_not_absolute', slug, workdir: raw });
    return null;
  }
  return normalize(expanded);
}

/** Create the project's working directory when it is missing (mkdir -p). */
export async function ensureWorkdirExists(workdir: string, slug: string): Promise<void> {
  try {
    const st = await stat(workdir);
    if (!st.isDirectory()) logger.warn({ msg: 'project.workdir_not_a_directory', slug, workdir });
    return;
  } catch {
    /* missing — create */
  }
  try {
    await mkdir(workdir, { recursive: true });
    logger.info({ msg: 'project.workdir_created', slug, workdir });
  } catch (err) {
    logger.warn({ msg: 'project.workdir_create_failed', slug, workdir, err: err instanceof Error ? err.message : String(err) });
  }
}

export interface FocusArgs {
  agent: string;
  session: string;
  /** New project slug to pin, or null to clear focus. */
  slug: string | null;
  /** Provenance — `'tool'` when agent called project_focus, `'slash_command'`
   *  when user typed `/projekt`. Persisted in the JSONL event. */
  via: 'tool' | 'slash_command';
  metaStore: SessionMetaStore;
}

export interface FocusResult {
  /** Slug that was active BEFORE this call (null if none). */
  previousSlug: string | null;
  /** Slug that is active AFTER this call (null if cleared). */
  currentSlug: string | null;
}

export async function focusProject(args: FocusArgs): Promise<FocusResult> {
  const { agent, session, slug, via, metaStore } = args;

  // Project must exist (unless we're clearing). Catches typos before
  // we mutate session state.
  if (slug !== null) {
    const exists = await projectExists(slug);
    if (!exists) {
      throw new Error(`project '${slug}' does not exist`);
    }
  }

  const meta = await metaStore.get(agent, session);
  const previousSlug = typeof meta.projectSlug === 'string' ? meta.projectSlug : null;

  // A builder's write scope and working directory follow the pin. Taking
  // the pin away or switching it while its turn runs moved the next write
  // into the agent workspace (hardening test 2026-09-23) — so a running
  // builder turn keeps the pin it has; a first pin is still allowed.
  if (previousSlug !== null && slug !== previousSlug) {
    const persona = await loadPersona(agent);
    if (persona?.kind === 'builder' && (await sessionBusy(agent, session))) {
      throw new Error(`the builder is working in project '${previousSlug}' right now — stop the turn before unpinning or switching the project`);
    }
  }

  // Noop short-circuit: same slug requested as already active.
  // Skip both the write AND the JSONL event so spam-clicking the same
  // project doesn't pollute the session log.
  if (previousSlug === slug) {
    return { previousSlug, currentSlug: slug };
  }

  const ts = Date.now();
  // Atomic read-merge-write: project_focus runs mid-turn (it's a tool),
  // so it can race the /sessions stats-cache writer or an activity mark.
  // A plain set() of the turn-start snapshot would revert their fields —
  // and projectSlug itself was the field lost in the 2026-05-13 incident.
  // update() re-reads fresh under the per-session lock (Juni-Audit 2026-06).
  // A project with a `workdir` makes that folder the session's working
  // directory (file tools, exec default cwd, builder environment);
  // clearing the pin or pinning a project without one drops it.
  const workdir = slug === null ? null : await projectWorkdir(slug);
  // A project declared with a folder that is not there yet (a new
  // repository the builder is about to start) gets the folder created
  // now: every tool of the session runs there from this moment, and an
  // exec whose cwd does not exist fails on every call.
  if (workdir) await ensureWorkdirExists(workdir, slug!);
  await metaStore.update(agent, session, (current) => {
    const next = { ...current } as Record<string, unknown>;
    if (slug === null) {
      delete next.projectSlug;
      delete next.projectLinkedAt;
      delete next.workdir;
    } else {
      next.projectSlug = slug;
      next.projectLinkedAt = new Date(ts).toISOString();
      if (workdir) next.workdir = workdir;
      else delete next.workdir;
    }
    return next as typeof current;
  });

  // Forensic marker. The engine field is `'somora'` as a sentinel —
  // not engine-emitted. See NormalizedEvent.project_switched.
  await appendEvent(agent, session, {
    kind: 'project_switched',
    ts,
    engine: 'somora',
    from: previousSlug,
    to: slug,
    via,
  });

  logger.info({
    msg: 'project.focus_changed',
    agent,
    session,
    from: previousSlug,
    to: slug,
    via,
  });

  return { previousSlug, currentSlug: slug };
}
