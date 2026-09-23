// One builder per working directory at a time.
//
// Two builders editing the same working copy overwrite each other's
// files; nothing in git or the file tools would notice until the tests
// fail. So a builder's running turn claims its working directory here,
// and a hand-over (builder_dispatch) or a Go into a folder that is
// claimed is refused with the claimant named — the orderer waits for
// that report or picks another project. Nested folders count as the
// same folder: a claim on /repo covers /repo/packages/a and vice versa.
//
// In-memory, per server process: claims are released when the turn
// ends (start-turn's finally) and vanish with a restart, which is right —
// a restart ends every turn.

import { normalize } from 'node:path';

export interface WorkdirClaim {
  agent: string;
  session: string;
  turnId: string;
  workdir: string;
  since: number;
  /** Live progress of the claiming turn — the task panel shows it. */
  toolCalls: number;
  lastTool?: string;
  lastToolAt?: number;
}

const claims = new Map<string, WorkdirClaim>(); // by turnId

function norm(p: string): string {
  return normalize(p).replace(/\/+$/, '') || '/';
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith(b + '/') || b.startsWith(a + '/');
}

/** The claim that covers `workdir` (same folder, a parent, or a child), or null. */
export function workdirClaimedBy(workdir: string, opts: { exceptTurnId?: string } = {}): WorkdirClaim | null {
  const w = norm(workdir);
  for (const c of claims.values()) {
    if (opts.exceptTurnId && c.turnId === opts.exceptTurnId) continue;
    if (overlaps(w, c.workdir)) return c;
  }
  return null;
}

/** Register a builder turn as working in `workdir`. Never refuses: the
 *  checks happen before the turn is started (dispatch, Go); a turn that
 *  reached this point runs. */
export function claimWorkdir(entry: Pick<WorkdirClaim, 'agent' | 'session' | 'turnId'> & { workdir: string }): WorkdirClaim {
  const claim: WorkdirClaim = { ...entry, workdir: norm(entry.workdir), since: Date.now(), toolCalls: 0 };
  claims.set(entry.turnId, claim);
  return claim;
}

/** Count a tool call on the claiming turn (no-op for a chat turn). */
export function noteToolCall(turnId: string, tool: string): void {
  const c = claims.get(turnId);
  if (!c) return;
  c.toolCalls += 1;
  c.lastTool = tool;
  c.lastToolAt = Date.now();
}

/** The running builder turn of a session, or null. */
export function claimOfSession(agent: string, session: string): WorkdirClaim | null {
  for (const c of claims.values()) if (c.agent === agent && c.session === session) return c;
  return null;
}

export function releaseWorkdir(turnId: string): void {
  claims.delete(turnId);
}

export function listWorkdirClaims(): WorkdirClaim[] {
  return [...claims.values()];
}

/** The sentence a refused caller reads. */
export function describeClaim(c: WorkdirClaim): string {
  const mins = Math.max(1, Math.round((Date.now() - c.since) / 60_000));
  return `${c.agent} is working in ${c.workdir} (session ${c.session}, for ${mins} min) — wait for its report or use another project folder`;
}
