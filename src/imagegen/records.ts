// Metadata for generated images — one JSON file per image under
// ~/.somora/images/.
//
// Separate from the image files themselves on purpose: the canonical
// image directory is a place a human browses, drags into other apps and
// occasionally cleans out. Sidecar .json files next to the images would
// be noise there, and a deleted image would silently take its
// provenance with it.
//
// Write is tmp-then-rename (same as src/tools/exec/job-store.ts) so a
// crash mid-write can't leave a half-parsed record behind.

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { logger, SOMORA_HOME_DIR } from '../server/logger.ts';
import type { ImageRecord } from './types.ts';

const RECORDS_DIR = join(SOMORA_HOME_DIR, 'images');

/** Short, URL-safe, collision-resistant enough for a personal archive. */
export function newImageId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function ensureDir(): Promise<void> {
  await mkdir(RECORDS_DIR, { recursive: true });
}

function recordPath(id: string): string {
  return join(RECORDS_DIR, `${id}.json`);
}

export async function writeRecord(record: ImageRecord): Promise<void> {
  await ensureDir();
  const target = recordPath(record.id);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
  await rename(tmp, target);
}

export async function readRecord(id: string): Promise<ImageRecord | null> {
  // Ids come from HTTP paths and tool arguments — refuse anything that
  // could climb out of the records dir before it reaches join().
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  try {
    const raw = await readFile(recordPath(id), 'utf8');
    return JSON.parse(raw) as ImageRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ msg: 'imagegen.record_read_failed', id, err: (err as Error).message });
    }
    return null;
  }
}

export async function deleteRecord(id: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false;
  try {
    await unlink(recordPath(id));
    return true;
  } catch {
    return false;
  }
}

export interface ListFilter {
  /** Case-insensitive substring over the prompt. */
  query?: string;
  /** Config handle, e.g. `grok-imagine`. */
  model?: string;
  agent?: string;
  session?: string;
  /** ISO date (YYYY-MM-DD) — inclusive bounds on createdAt. */
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface ListResult {
  total: number;
  images: ImageRecord[];
}

/**
 * Newest first. Reads every record — fine for a personal archive in the
 * thousands, and it keeps the store a plain directory of JSON files
 * that stays readable and repairable by hand. If this ever gets slow,
 * the fix is an index, not a database.
 */
export async function listRecords(filter: ListFilter = {}): Promise<ListResult> {
  await ensureDir();
  let files: string[];
  try {
    files = await readdir(RECORDS_DIR);
  } catch {
    return { total: 0, images: [] };
  }

  const records: ImageRecord[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(RECORDS_DIR, file), 'utf8');
      records.push(JSON.parse(raw) as ImageRecord);
    } catch (err) {
      logger.warn({ msg: 'imagegen.record_skipped', file, err: (err as Error).message });
    }
  }

  const q = filter.query?.toLowerCase();
  const matched = records.filter((r) => {
    if (q && !r.prompt.toLowerCase().includes(q)) return false;
    if (filter.model && r.modelName !== filter.model) return false;
    if (filter.agent && r.agent !== filter.agent) return false;
    if (filter.session && r.session !== filter.session) return false;
    if (filter.since && r.createdAt < filter.since) return false;
    // `until` is a date; compare against the day's end so an inclusive
    // bound doesn't exclude everything generated that afternoon.
    if (filter.until && r.createdAt > `${filter.until}T23:59:59.999Z`) return false;
    return true;
  });

  matched.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 100;
  return { total: matched.length, images: matched.slice(offset, offset + limit) };
}

/** Total bytes across all records — shown in the gallery so the
 *  archive's growth is visible without a shell. */
export async function totalBytes(): Promise<number> {
  const { images } = await listRecords({ limit: Number.MAX_SAFE_INTEGER });
  return images.reduce((sum, r) => sum + (r.bytes || 0), 0);
}
