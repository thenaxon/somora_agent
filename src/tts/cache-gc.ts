// TTS cache GC sweeper.
//
// Two policies, applied together:
//   - retentionDays: drop files older than N days (mtime).
//   - maxSizeMB: drop oldest files until total size ≤ cap.
//
// Run on boot + once per day via setInterval. Best-effort — any
// failure logs and continues. Never blocks request handling.

import { existsSync, statSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';
import type { Config, TtsConfig } from '../config/types.ts';
import { TTS_CACHE_DIR } from './service.ts';

const TICK_MS = 24 * 60 * 60 * 1000; // 1 day

interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

async function listCacheFiles(): Promise<FileEntry[]> {
  if (!existsSync(TTS_CACHE_DIR)) return [];
  const names = await readdir(TTS_CACHE_DIR);
  const out: FileEntry[] = [];
  for (const name of names) {
    // Skip tmp leftovers + dotfiles.
    if (name.startsWith('.') || name.endsWith('.tmp')) continue;
    const p = join(TTS_CACHE_DIR, name);
    try {
      const s = statSync(p);
      if (!s.isFile()) continue;
      out.push({ path: p, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // ignore (race with concurrent unlink)
    }
  }
  return out;
}

async function sweepOnce(tts: TtsConfig): Promise<void> {
  if (!tts) return;
  const files = await listCacheFiles();
  if (files.length === 0) return;

  const now = Date.now();
  const retentionMs = tts.cache.retentionDays * 24 * 60 * 60 * 1000;
  const maxBytes = tts.cache.maxSizeMB * 1024 * 1024;

  let removedByAge = 0;
  let bytesRemovedByAge = 0;
  // ── 1. Retention pass ──
  if (retentionMs > 0) {
    for (const f of files) {
      if (now - f.mtimeMs > retentionMs) {
        try {
          await unlink(f.path);
          removedByAge += 1;
          bytesRemovedByAge += f.size;
        } catch (err) {
          logger.warn({ msg: 'tts.gc.unlink_failed', path: f.path, err: (err as Error).message });
        }
      }
    }
  }

  // ── 2. Size-cap pass (eldest first) ──
  let removedBySize = 0;
  let bytesRemovedBySize = 0;
  const remaining = (await listCacheFiles()).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let totalSize = remaining.reduce((acc, f) => acc + f.size, 0);
  for (const f of remaining) {
    if (totalSize <= maxBytes) break;
    try {
      await unlink(f.path);
      totalSize -= f.size;
      removedBySize += 1;
      bytesRemovedBySize += f.size;
    } catch (err) {
      logger.warn({ msg: 'tts.gc.unlink_failed', path: f.path, err: (err as Error).message });
    }
  }

  if (removedByAge > 0 || removedBySize > 0) {
    logger.info({
      msg: 'tts.gc.swept',
      removedByAge,
      bytesRemovedByAge,
      removedBySize,
      bytesRemovedBySize,
      remainingFiles: remaining.length - removedBySize,
      remainingBytes: totalSize,
    });
  }
}

let tickHandle: ReturnType<typeof setInterval> | undefined;

/**
 * Install the GC sweeper. Idempotent — calling twice replaces the
 * previous tick. Skipped when tts is disabled.
 */
export function installTtsCacheGc(config: Config): void {
  const tts = config.tts as TtsConfig | undefined;
  if (!tts || !tts.enabled) return;
  if (tts.cache.retentionDays === 0 && tts.cache.maxSizeMB <= 0) return; // disabled

  if (tickHandle) clearInterval(tickHandle);
  // First sweep on boot — surface obviously-bloated caches early.
  void sweepOnce(tts).catch((err) => {
    logger.warn({ msg: 'tts.gc.boot_sweep_failed', err: (err as Error).message });
  });
  tickHandle = setInterval(() => {
    void sweepOnce(tts).catch((err) => {
      logger.warn({ msg: 'tts.gc.tick_failed', err: (err as Error).message });
    });
  }, TICK_MS);
  // Don't keep the process alive just for the sweeper.
  tickHandle.unref?.();
  logger.info({
    msg: 'tts.gc.installed',
    retentionDays: tts.cache.retentionDays,
    maxSizeMB: tts.cache.maxSizeMB,
  });
}
