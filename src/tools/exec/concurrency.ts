// Process-wide concurrency tracker for `exec({background:true})` jobs.
// Counts both local AND remote background jobs — the cap protects
// host resources regardless of which machine the work lands on.
//
// Server-process-scoped: counter resets on restart. Disk-tracked
// jobs from before the restart are already marked failed by
// recoverOrphanedJobs at boot, so they don't contribute to the
// post-restart count.

import { logger } from '../../server/logger.ts';

interface CapsConfig {
  perAgent: number;
  global: number;
}

let capsConfig: CapsConfig = { perAgent: 8, global: 32 };

const activeByAgent = new Map<string, number>();
let activeGlobal = 0;

/**
 * Called once at server boot (and at MCP-child boot) with the
 * resolved config. Subsequent acquire/release reads from this cache.
 * Match the existing configureLongTaskTimeouts pattern.
 */
export function configureExecConcurrencyCaps(perAgent: number, global: number): void {
  capsConfig = { perAgent, global };
}

export interface AcquireOk {
  ok: true;
  release: () => void;
}

export interface AcquireDenied {
  ok: false;
  reason: string;
  perAgentCap: number;
  globalCap: number;
  perAgentNow: number;
  globalNow: number;
}

/**
 * Try to claim a slot for a new background job. On success, returns
 * a `release()` to call when the job ends (success, failure, or
 * kill — all paths). On denial, returns the cap-hit reason for the
 * tool to surface back to the model.
 */
export function tryAcquireExecSlot(agent: string): AcquireOk | AcquireDenied {
  const perAgentNow = activeByAgent.get(agent) ?? 0;
  if (perAgentNow >= capsConfig.perAgent) {
    return {
      ok: false,
      reason:
        `per-agent exec-background cap reached (${capsConfig.perAgent} concurrent jobs). ` +
        `Wait for an existing job to finish (process({action:"poll", job_id})), kill one ` +
        `(process({action:"kill"})), or run synchronously instead of background.`,
      perAgentCap: capsConfig.perAgent,
      globalCap: capsConfig.global,
      perAgentNow,
      globalNow: activeGlobal,
    };
  }
  if (activeGlobal >= capsConfig.global) {
    return {
      ok: false,
      reason:
        `server-wide exec-background cap reached (${capsConfig.global} concurrent jobs across all agents). ` +
        `Wait for someone to finish, or raise agentLoop.execMaxConcurrentGlobal in config.yaml.`,
      perAgentCap: capsConfig.perAgent,
      globalCap: capsConfig.global,
      perAgentNow,
      globalNow: activeGlobal,
    };
  }
  activeByAgent.set(agent, perAgentNow + 1);
  activeGlobal++;
  let released = false;
  return {
    ok: true,
    release: () => {
      // Idempotent — multiple paths (close + error + kill) might
      // each try to release; only the first call counts.
      if (released) return;
      released = true;
      const cur = activeByAgent.get(agent) ?? 0;
      activeByAgent.set(agent, Math.max(0, cur - 1));
      activeGlobal = Math.max(0, activeGlobal - 1);
    },
  };
}

/**
 * Map of in-flight remote-background job_id → releaseSlot. Used by
 * the process tool's poll/kill handlers to free the slot when a
 * remote job completes or is killed (remote jobs lack the
 * child.on('close') hook that local jobs use). On server-restart
 * the map resets but recoverOrphanedJobs marks all running jobs as
 * failed, so the cap counter starts fresh and consistent.
 */
const remoteReleasers = new Map<string, () => void>();

export function registerRemoteSlotRelease(jobId: string, release: () => void): void {
  remoteReleasers.set(jobId, release);
}

export function releaseRemoteSlot(jobId: string): void {
  const r = remoteReleasers.get(jobId);
  if (r) {
    r();
    remoteReleasers.delete(jobId);
  }
}

/**
 * Snapshot for diagnostics — surface via /env or a future
 * exec_status tool. Read-only.
 */
export function execConcurrencyStatus(): {
  perAgentCap: number;
  globalCap: number;
  globalActive: number;
  perAgent: Record<string, number>;
} {
  return {
    perAgentCap: capsConfig.perAgent,
    globalCap: capsConfig.global,
    globalActive: activeGlobal,
    perAgent: Object.fromEntries(activeByAgent),
  };
}

// Surface the boot-time configuration once so it's visible in logs.
export function logExecCaps(): void {
  logger.info({
    msg: 'exec.concurrency_caps',
    per_agent: capsConfig.perAgent,
    global: capsConfig.global,
  });
}
