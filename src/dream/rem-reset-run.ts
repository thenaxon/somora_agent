// The REM run that /reset starts over the archive it just made.
//
// Lives here, not inline in the route, so the one thing that matters
// can be tested: a SUCCESSFUL run stamps the archive's
// `dreamReadThroughTs`. The inline version never did. That was harmless
// while the idle worker ignored archived sessions; since v2026.09.10.03
// it reads them too, found every reset archive "unread", and dreamed
// each one a second time — 265 archive runs in the live logs by
// 2026-09-21, back to archives from May, with duplicate findings in
// review and old statements re-entering memory as new.

import type { Config } from '../config/types.ts';
import type { MemoryManager } from '../memory/manager.ts';
import type { RemConfig } from '../persona/loader.ts';
import { logger } from '../server/logger.ts';
import { sessionMetaStore } from '../storage/sessions.ts';
import { runDream } from './rem-runner.ts';
import { markSessionDreamed } from './rem-worker.ts';

export interface ResetDreamArgs {
  agent: string;
  archivedId: string;
  rem: RemConfig;
  config: Config;
  mgr: MemoryManager;
  /** Test seam. */
  runDreamImpl?: typeof runDream;
}

export async function dreamArchivedAfterReset(
  args: ResetDreamArgs,
): Promise<{ finalStatus: string; stamped: boolean }> {
  // Only the part idle-REM has not seen yet. The archived meta carries
  // the session's `dreamReadThroughTs` (resetSession moves the meta file
  // along with the JSONL); rangeFromTs: 0 re-dreamed the whole session a
  // second time (duplicate findings), and the recall query built from
  // 900 messages froze the server (see rem-runner.ts).
  const archivedMeta = await sessionMetaStore.get(args.agent, args.archivedId);
  const rangeFromTs =
    typeof archivedMeta.dreamReadThroughTs === 'number' ? archivedMeta.dreamReadThroughTs : 0;
  // Captured BEFORE the run, stamped as-is afterwards — same rule as the
  // idle worker. (An archive gets no new events, but the rule is cheap.)
  const rangeThroughTs = Date.now();
  logger.info({ msg: 'session.reset_dream_range', agent: args.agent, archivedId: args.archivedId, rangeFromTs });
  const result = await (args.runDreamImpl ?? runDream)({
    agent: args.agent,
    sourceSession: args.archivedId,
    trigger: 'manual',
    rangeFromTs,
    rangeThroughTs,
    rem: args.rem,
    config: args.config,
    mgr: args.mgr,
  });
  // Failed or paused: leave the marker alone — the idle worker reads
  // archived sessions and will pick the range up again.
  const ok = result.finalStatus === 'completed' || result.finalStatus === 'processed';
  if (ok) await markSessionDreamed(args.agent, args.archivedId, rangeThroughTs);
  logger.info({
    msg: 'session.reset_dream_done',
    agent: args.agent,
    archivedId: args.archivedId,
    finalStatus: result.finalStatus,
    stamped: ok,
  });
  return { finalStatus: result.finalStatus, stamped: ok };
}
