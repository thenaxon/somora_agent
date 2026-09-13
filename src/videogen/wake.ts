// Bringing an agent back to a finished render.
//
// Same arrangement as the tmux attention watcher: the server injects
// what it takes to start a turn, and this module uses it when a job
// reaches the end. Importing run-turn directly would tie the job loop
// to half the server; injection keeps the loop able to run in places
// where there is nobody to wake at all.
//
// One wake per finished video, not one per batch. Waiting for the
// slowest of four renders before showing any of them would defeat the
// point of releasing the turn in the first place.

import { logger } from '../server/logger.ts';
import { startTurn } from '../server/start-turn.ts';
import type { ChatTurnResolveDeps } from '../server/run-turn-types.ts';
import { loadPersona } from '../persona/loader.ts';
import type { VideoJob } from './jobs.ts';

type ChatTurnDeps = ChatTurnResolveDeps;
type PublishEvent = (agent: string, session: string, event: unknown) => Promise<void> | void;

let injectedDeps: ChatTurnDeps | null = null;
let injectedPublish: PublishEvent | null = null;

/** Wired at server boot. `publishEvent` is not optional in spirit: a
 *  wake turn that is only written to JSONL leaves every open window
 *  stale until a reload, which has bitten twice before. */
export function configureVideoWake(args: {
  chatTurnDeps: ChatTurnDeps;
  publishEvent?: PublishEvent;
}): void {
  injectedDeps = args.chatTurnDeps;
  // publishEvent is accepted for compatibility; the wake streams through
  // startTurn's boot-wired broadcast since 2026-09-13.
  if (args.publishEvent) injectedPublish = args.publishEvent;
}

function wakePrompt(job: VideoJob): string {
  if (job.status === 'failed') {
    return (
      `[video] The render you started (${job.modelName}, "${job.prompt.slice(0, 120)}") failed: ` +
      `${job.error ?? 'no reason given'}.\n` +
      `Decide whether to retry with different settings or tell the user it did not work. ` +
      `Do not retry the identical request blindly.`
    );
  }
  return (
    `[video] Your render is ready: ${job.path}\n` +
    `Model ${job.modelName}, prompt "${job.prompt.slice(0, 120)}".\n` +
    `The user already sees the video in this conversation — you do not need to send it. ` +
    `Say what it is, and continue whatever you were doing for them. If you want to judge it ` +
    `yourself, analyze_file on the thumbnail beside it reads as an ordinary image.`
  );
}

/**
 * Start the turn that tells an agent about its video.
 *
 * Dispatches and returns: the wake queues behind whatever runs in the
 * session, and the runner's tick must not wait for that (it used to —
 * a busy session held every other job's poll, birdseye L6). Throws
 * only for what a retry on the next tick can fix: the agent is gone.
 * Once dispatched, the job counts as notified; the turn itself, once
 * it starts, records its own outcome into the session like any other.
 */
export async function wakeForJob(job: VideoJob): Promise<void> {
  if (!job.agent) return;
  const deps = injectedDeps;
  if (!deps) {
    logger.debug({ msg: 'videogen.wake_unconfigured', job: job.id });
    return;
  }
  if (!(await loadPersona(job.agent))) {
    throw new Error(`agent '${job.agent}' not found`);
  }
  const agent = job.agent;
  const session = job.session ?? 'main';
  void startTurn({
    agent,
    session,
    text: wakePrompt(job),
    origin: { kind: 'wake', about: 'job', ref: job.id },
    // Without this the video never reaches the chat: the file was
    // stored minutes before this turn began, so the turn's own time
    // window — which is how media normally finds its bubble — does
    // not reach back far enough to see it.
    ...(job.mediaId ? { attachMediaIds: [job.mediaId] } : {}),
    deps,
  })
    .then(() => logger.info({ msg: 'videogen.woke_agent', job: job.id, agent, status: job.status }))
    .catch((err) => logger.warn({ msg: 'videogen.wake_failed', job: job.id, agent, err: (err as Error).message }));
}
