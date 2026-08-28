// Background video renders: a job store on disk and the loop that
// drives it.
//
// A render takes minutes — five seconds of video is roughly three
// minutes of GPU, fourteen seconds closer to eight — and the backend
// runs one at a time. Holding an agent's turn open for that is not an
// option, so a request here returns as soon as the job exists and the
// agent is woken when its video is ready. That is the same shape the
// tmux watcher and Sentinel already use: the work happens elsewhere,
// and the agent is brought back to it.
//
// State lives in ~/.somora/video-jobs/, one JSON per job, written
// tmp-then-rename. On disk rather than in memory because somora gets
// redeployed several times on a busy day, and a render that finished
// during the restart must not be lost — the provider keeps the file,
// so resuming the poll is all it takes to collect it.
//
// The concurrency cap is GLOBAL, not per agent: a GPU is shared, and a
// per-agent budget would let four agents occupy twelve slots. A caller
// that arrives at a full queue is told so and asked to come back, which
// is kinder than silently waiting an unknown number of minutes.

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger, SOMORA_HOME_DIR } from '../server/logger.ts';
import type { Config } from '../config/types.ts';
import type { VideoJobStatus } from './dialects.ts';

const JOBS_DIR = join(SOMORA_HOME_DIR, 'video-jobs');

export interface VideoJob {
  /** somora's own handle, stable across restarts. */
  id: string;
  /** The provider's handle — an id, or an operation name for Veo. */
  providerJobId: string;
  modelName: string;
  provider: string;
  prompt: string;
  specs: Record<string, unknown>;
  status: VideoJobStatus;
  progress?: number;
  queuePosition?: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /** Set once the finished file has been stored. */
  mediaId?: string;
  path?: string;
  /** Who to wake, and where the request came from. Absent for a job
   *  started from the web UI — nobody to notify there. */
  agent?: string;
  session?: string;
  references?: number;
  /** Anything the provider said it ignored or adjusted. */
  warnings?: string[];
  /** Set when the agent has been told. Kept so a restart can't wake
   *  someone twice for the same video. */
  notifiedAt?: string;
}

export type JobUpdate = Partial<Omit<VideoJob, 'id'>>;

async function ensureDir(): Promise<void> {
  await mkdir(JOBS_DIR, { recursive: true });
}

function jobPath(id: string): string {
  return join(JOBS_DIR, `${id}.json`);
}

export async function writeJob(job: VideoJob): Promise<void> {
  await ensureDir();
  const target = jobPath(job.id);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(job, null, 2), 'utf8');
  await rename(tmp, target);
}

export async function readJob(id: string): Promise<VideoJob | null> {
  try {
    return JSON.parse(await readFile(jobPath(id), 'utf8')) as VideoJob;
  } catch {
    return null;
  }
}

export async function listJobs(filter: { agent?: string; active?: boolean } = {}): Promise<VideoJob[]> {
  await ensureDir();
  let files: string[];
  try {
    files = await readdir(JOBS_DIR);
  } catch {
    return [];
  }
  const jobs: VideoJob[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      jobs.push(JSON.parse(await readFile(join(JOBS_DIR, file), 'utf8')) as VideoJob);
    } catch (err) {
      logger.warn({ msg: 'videogen.job_unreadable', file, err: (err as Error).message });
    }
  }
  return jobs
    .filter((j) => (filter.agent ? j.agent === filter.agent : true))
    .filter((j) => (filter.active ? isActive(j) : true))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function updateJob(id: string, patch: JobUpdate): Promise<VideoJob | null> {
  const job = await readJob(id);
  if (!job) return null;
  const next: VideoJob = { ...job, ...patch, updatedAt: new Date().toISOString() };
  await writeJob(next);
  return next;
}

export async function deleteJob(id: string): Promise<void> {
  try {
    await unlink(jobPath(id));
  } catch {
    /* already gone */
  }
}

/** A job still worth polling. */
export function isActive(job: VideoJob): boolean {
  return job.status === 'queued' || job.status === 'in_progress';
}

/** How many renders are in flight right now, across every agent. */
export async function activeCount(): Promise<number> {
  return (await listJobs({ active: true })).length;
}

export interface SlotCheck {
  ok: boolean;
  active: number;
  limit: number;
  reason?: string;
}

/**
 * Is there room for another render? Refusing beats queueing: the wait
 * is minutes and unbounded, and a caller told "full, try again" can do
 * something else meanwhile. The message names the numbers so "later"
 * isn't a guess.
 */
export async function checkSlot(config: Config): Promise<SlotCheck> {
  const limit = config.videoGen?.maxConcurrent ?? 4;
  const active = await activeCount();
  if (active < limit) return { ok: true, active, limit };
  return {
    ok: false,
    active,
    limit,
    reason:
      `all ${limit} video slots are busy (${active} rendering). Video renders take minutes and ` +
      `the backend works through them one at a time — try again in a few minutes, or check ` +
      `video_status to see what is running.`,
  };
}

/**
 * Jobs left mid-flight by a restart. Called once at boot: the provider
 * kept rendering (or kept the finished file), so picking the poll back
 * up is all that is needed.
 */
export async function resumableJobs(): Promise<VideoJob[]> {
  return listJobs({ active: true });
}

/** Jobs that finished while nobody was listening — the agent still owes
 *  a notification. */
export async function unnotifiedJobs(): Promise<VideoJob[]> {
  const jobs = await listJobs();
  return jobs.filter((j) => !isActive(j) && j.agent && !j.notifiedAt);
}
