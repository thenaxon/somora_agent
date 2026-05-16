// mtime-based optimistic-concurrency helper for wiki + memory writes.
//
// Used by Dream-B (memory → wiki) and Dream-C (wiki lint corrections):
// before writing a file the worker has read+reasoned about, re-check
// that the on-disk mtime hasn't shifted in the meantime. If it has, the
// user (or another worker) edited the file during our reasoning window;
// abort and retry next run rather than clobber.
//
// Single-writer-pro-File-Invariante (DECISIONS-Anhang in
// `private/wiki-design.md`) makes this small and sufficient: there's
// no merge logic to write because parallel writes are designed out.
//
// See `private/wiki-design.md` § "Konflikt-Strategie".

import { readFile, stat, writeFile } from 'node:fs/promises';

export interface ReadWithMtimeResult {
  /** File contents as UTF-8 string. */
  text: string;
  /** mtime in ms-since-epoch — pass this back to writeIfMtimeUnchanged. */
  mtimeMs: number;
}

/**
 * Read a file plus its mtime in one shot. Returns null if the file does
 * not exist (caller can interpret that as "fresh write" rather than
 * conflict).
 */
export async function readWithMtime(path: string): Promise<ReadWithMtimeResult | null> {
  try {
    const [buf, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { text: buf, mtimeMs: st.mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export type WriteOutcome =
  | { kind: 'written'; mtimeMs: number }
  | { kind: 'skipped_conflict'; observedMtimeMs: number; expectedMtimeMs: number }
  | { kind: 'skipped_missing'; expectedMtimeMs: number };

/**
 * Write `content` to `path` only if the on-disk mtime still matches
 * `expectedMtimeMs` (the value the caller saw at read time).
 *
 * Behavior:
 *  - mtime matches → write succeeds, returns 'written' with new mtime
 *  - mtime differs → 'skipped_conflict' (user/another worker touched it)
 *  - file vanished → 'skipped_missing' (callers may re-create on retry)
 *
 * `expectedMtimeMs` semantics: pass `null` to enable "create-or-fail-if-
 * exists". Pass a number to require an exact match.
 *
 * NOTE: this is optimistic concurrency, not a lock. Two writers racing
 * the same file in the < 1ms window between stat and write can still
 * collide. For the wiki use case (one Dream-B worker server-side, plus
 * occasional manual user edits), the race window is tiny and we accept
 * it. If we later run multiple writer processes against the same wiki,
 * upgrade to a real flock-based lock.
 */
export async function writeIfMtimeUnchanged(
  path: string,
  content: string,
  expectedMtimeMs: number,
): Promise<WriteOutcome> {
  let observedMtimeMs: number;
  try {
    const st = await stat(path);
    observedMtimeMs = st.mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'skipped_missing', expectedMtimeMs };
    }
    throw err;
  }
  if (observedMtimeMs !== expectedMtimeMs) {
    return { kind: 'skipped_conflict', observedMtimeMs, expectedMtimeMs };
  }
  await writeFile(path, content, 'utf8');
  const finalSt = await stat(path);
  return { kind: 'written', mtimeMs: finalSt.mtimeMs };
}

/**
 * Create a new file iff it doesn't exist yet. Returns 'written' on
 * success, 'skipped_conflict' if the path already exists.
 *
 * Useful for Dream-B initial promotions where we don't have a previous
 * mtime to compare against — the contract is "we expect this slug to
 * be net-new; if someone got there first, defer to them".
 */
export async function writeIfNotExists(
  path: string,
  content: string,
): Promise<WriteOutcome> {
  // Exclusive-create via O_EXCL (`wx` flag). Pre-audit-2026-05-16 this
  // was stat-then-write — a classic TOCTOU window let two parallel
  // wiki_create calls both pass the existence check and the second
  // overwrite the first. EEXIST now maps to skipped_conflict.
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const st = await stat(path);
      return { kind: 'skipped_conflict', observedMtimeMs: st.mtimeMs, expectedMtimeMs: 0 };
    }
    throw err;
  }
  const finalSt = await stat(path);
  return { kind: 'written', mtimeMs: finalSt.mtimeMs };
}
