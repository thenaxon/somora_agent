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
import { projectExists } from './store.ts';

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
  await metaStore.update(agent, session, (current) => {
    const next = { ...current } as Record<string, unknown>;
    if (slug === null) {
      delete next.projectSlug;
      delete next.projectLinkedAt;
    } else {
      next.projectSlug = slug;
      next.projectLinkedAt = new Date(ts).toISOString();
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
