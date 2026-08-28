// The loop that drives video jobs, and the wake-up that closes them.
//
// One interval for all jobs rather than a timer per job: the poll is a
// cheap GET, the state that matters is on disk anyway, and a single
// loop resumes after a restart without anyone having to remember which
// timers were pending.
//
// When a render finishes, the agent that asked for it is woken — one
// wake per video, deliberately. Batching would mean waiting for the
// slowest of four renders before seeing any of them, and the whole
// reason the turn was released is that nobody should be waiting.
//
// The wake itself is injected rather than imported: starting an agent
// turn lives in run-turn, which already reaches into a great deal of
// the server, and importing it here would tie the job loop to it. Same
// arrangement Sentinel and the tmux watcher use.

import type { Config } from '../config/types.ts';
import { logger } from '../server/logger.ts';
import { pollJob } from './generate.ts';
import { isActive, listJobs, updateJob, type VideoJob } from './jobs.ts';

export type VideoNotifier = (job: VideoJob) => Promise<void>;

let notifier: VideoNotifier | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** Injected by the server at boot. Without it, jobs still run and are
 *  collected — only the wake-up is skipped, which is the correct
 *  behaviour in the MCP child, where there is no agent to wake. */
export function configureVideoNotifier(fn: VideoNotifier): void {
  notifier = fn;
}

/** How many notify attempts a job gets before it is left alone. A
 *  session that refuses a turn every time should not be retried
 *  forever; the video is on disk and in the gallery regardless. */
const MAX_NOTIFY_ATTEMPTS = 5;
const notifyAttempts = new Map<string, number>();

async function tick(getConfig: () => Config): Promise<void> {
  if (ticking) return; // a slow poll must not stack up behind itself
  ticking = true;
  try {
    const config = getConfig();
    if (!config.videoGen?.enabled) return;

    const jobTimeoutMs = config.videoGen.jobTimeoutMs;
    const active = await listJobs({ active: true });

    await Promise.all(
      active.map(async (job) => {
        const age = Date.now() - new Date(job.createdAt).getTime();
        if (age > jobTimeoutMs) {
          logger.warn({ msg: 'videogen.job_timeout', job: job.id, ageMs: age });
          await updateJob(job.id, {
            status: 'failed',
            error: `gave up after ${Math.round(age / 60_000)} minutes without a result`,
          });
          return;
        }
        try {
          await pollJob(job, config);
        } catch (err) {
          logger.warn({ msg: 'videogen.poll_unexpected', job: job.id, err: (err as Error).message });
        }
      }),
    );

    // Anything that reached a terminal state and still owes its agent a
    // word. Includes jobs that finished during a restart — that is the
    // whole point of keeping `notifiedAt` on disk.
    if (!notifier) return;
    const finished = (await listJobs()).filter(
      (j) => !isActive(j) && j.agent && !j.notifiedAt,
    );
    for (const job of finished) {
      const tries = (notifyAttempts.get(job.id) ?? 0) + 1;
      notifyAttempts.set(job.id, tries);
      if (tries > MAX_NOTIFY_ATTEMPTS) {
        logger.warn({ msg: 'videogen.notify_given_up', job: job.id, tries });
        await updateJob(job.id, { notifiedAt: new Date().toISOString() });
        continue;
      }
      try {
        await notifier(job);
        await updateJob(job.id, { notifiedAt: new Date().toISOString() });
        notifyAttempts.delete(job.id);
      } catch (err) {
        // Busy session, engine hiccup — try again next tick.
        logger.debug({ msg: 'videogen.notify_deferred', job: job.id, err: (err as Error).message });
      }
    }
  } finally {
    ticking = false;
  }
}

/**
 * Start polling. Safe to call when video is disabled — the tick checks
 * config each time, so turning it on doesn't need a restart.
 */
export function startVideoRunner(getConfig: () => Config): void {
  if (timer) return;
  const intervalMs = getConfig().videoGen?.pollIntervalMs ?? 8000;
  timer = setInterval(() => void tick(getConfig), intervalMs);
  // Don't hold the process open for a poll loop.
  timer.unref?.();
  // One immediate pass so a restart picks up anything that finished
  // while somora was down, without waiting out a full interval.
  void tick(getConfig);
  logger.info({ msg: 'videogen.runner_started', intervalMs });
}

export function stopVideoRunner(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Used by tests and by the boot log — how much is in flight. */
export async function runnerSnapshot(): Promise<{ active: number; total: number }> {
  const all = await listJobs();
  return { active: all.filter(isActive).length, total: all.length };
}
