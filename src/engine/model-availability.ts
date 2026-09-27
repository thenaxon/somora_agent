// Which models are known to be unreachable right now — one note for
// every cascade in the house (chat fallback chain, REM worker chain,
// compaction workers).
//
// Why (naxon's report 2026-09-27, Rene): when a GPU profile swaps
// models, a model stays away for hours. Every cascade found that out
// again on every turn — two dead hops of ~30 s before the third model
// answered, on every message in the session, and the same in REM and
// compaction. Now the first cascade that hits the outage writes it
// down here, and every later cascade starts past the models marked
// unavailable. The mark lasts `fallback.retryUnavailableMinutes`
// (default 60), then the model is tried again; a success clears the
// mark early. In memory only: a restart is a fresh start.
//
// Rene's rule: the fallback chip on the turn stays — the person sees
// that the turn ran on a backup — but the primary is not knocked on
// every turn.

import { logger } from '../server/logger.ts';

export interface UnavailableEntry {
  /** `provider/modelId` */
  ref: string;
  since: number;
  until: number;
  reason: string;
}

let ttlMs = 60 * 60_000;
const marks = new Map<string, UnavailableEntry>();

/** Called at boot and on config reload with `fallback.retryUnavailableMinutes`. */
export function configureModelAvailability(retryUnavailableMinutes: number): void {
  ttlMs = Math.max(1, retryUnavailableMinutes) * 60_000;
}

export function modelAvailabilityTtlMs(): number {
  return ttlMs;
}

export function markModelUnavailable(ref: string, reason: string, now = Date.now()): UnavailableEntry {
  const existing = marks.get(ref);
  const entry: UnavailableEntry = {
    ref,
    since: existing && existing.until > now ? existing.since : now,
    until: now + ttlMs,
    reason: reason.slice(0, 300),
  };
  marks.set(ref, entry);
  logger.warn({
    msg: 'model.unavailable',
    model: ref,
    retryInMinutes: Math.round(ttlMs / 60_000),
    reason: entry.reason,
    ...(existing ? { renewed: true } : {}),
  });
  return entry;
}

/** The current mark, or null when there is none or it has expired (an
 *  expired mark is dropped: the next cascade tries the model again). */
export function modelUnavailable(ref: string, now = Date.now()): UnavailableEntry | null {
  const e = marks.get(ref);
  if (!e) return null;
  if (e.until <= now) {
    marks.delete(ref);
    logger.info({ msg: 'model.retry_due', model: ref, unavailableForMinutes: Math.round((now - e.since) / 60_000) });
    return null;
  }
  return e;
}

/** A model answered: drop its mark, if any. Returns true when one was dropped. */
export function markModelAvailable(ref: string): boolean {
  const e = marks.get(ref);
  if (!e) return false;
  marks.delete(ref);
  logger.info({ msg: 'model.available_again', model: ref, unavailableForMinutes: Math.round((Date.now() - e.since) / 60_000) });
  return true;
}

export function listUnavailableModels(now = Date.now()): UnavailableEntry[] {
  const out: UnavailableEntry[] = [];
  for (const ref of [...marks.keys()]) {
    const e = modelUnavailable(ref, now);
    if (e) out.push(e);
  }
  return out.sort((a, b) => a.since - b.since);
}

/** Forget every mark (config reload, POST /models/availability/reset). */
export function resetModelAvailability(): number {
  const n = marks.size;
  marks.clear();
  if (n > 0) logger.info({ msg: 'model.availability_reset', cleared: n });
  return n;
}

export const modelRef = (m: { providerName: string; modelId: string }): string => `${m.providerName}/${m.modelId}`;

/** Human line for a fallback reason: "not tried — unavailable since 08:39 (…)". */
export function unavailableReason(e: UnavailableEntry): string {
  const hhmm = new Date(e.since).toTimeString().slice(0, 5);
  return `not tried — marked unavailable since ${hhmm}: ${e.reason}`;
}
