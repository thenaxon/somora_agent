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
import { runChatTurn } from '../server/run-turn.ts';
import { acquireSessionLock } from '../server/session-queue.ts';
import type { VideoJob } from './jobs.ts';

type ChatTurnDeps = Parameters<typeof runChatTurn>[0]['deps'];
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

/** Start the turn that tells an agent about its video. Throws when the
 *  session is busy so the caller can try again on the next tick. */
export async function wakeForJob(job: VideoJob): Promise<void> {
  if (!job.agent) return;
  const deps = injectedDeps;
  if (!deps) {
    logger.debug({ msg: 'videogen.wake_unconfigured', job: job.id });
    return;
  }
  const session = job.session ?? 'main';
  const release = await acquireSessionLock(job.agent, session, { priority: 'agent' });
  try {
    const publish = injectedPublish;
    await runChatTurn({
      agent: job.agent,
      session,
      text: wakePrompt(job),
      fromSystem: 'job',
      // Without this the video never reaches the chat: the file was
      // stored minutes before this turn began, so the turn's own time
      // window — which is how media normally finds its bubble — does
      // not reach back far enough to see it.
      ...(job.mediaId ? { attachMediaIds: [job.mediaId] } : {}),
      deps,
      ...(publish
        ? {
            publishSse: ((event: unknown) =>
              publish(job.agent!, session, event)) as never,
          }
        : {}),
    });
    logger.info({ msg: 'videogen.woke_agent', job: job.id, agent: job.agent, status: job.status });
  } finally {
    release();
  }
}
