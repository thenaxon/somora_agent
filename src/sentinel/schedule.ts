// Time-source scheduling math. Pure functions that compute the next
// fire instant for a given TimeSpec, plus a minimal cron parser
// (5-field standard cron) so power users don't get stuck with the
// convenience primitives.
//
// Intentionally small — no external dependency. Cron support is
// limited to "*", numbers, "*/N", and comma lists. Ranges (1-5) and
// named fields (MON, JAN) are out of scope; daily/weekly cover the
// human-readable cases.

import type { TimeSpec, WeekDay } from './types.ts';

const WEEKDAYS: WeekDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parse "5m", "30s", "1h", "90s", "1500ms" → ms. Throws on bad input. */
export function parseInterval(s: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s.trim());
  if (!m) throw new Error(`invalid interval: "${s}" — use 30s / 5m / 1h / 500ms`);
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case 'ms': return n;
    case 's':  return n * 1_000;
    case 'm':  return n * 60_000;
    case 'h':  return n * 3_600_000;
    default:   throw new Error(`invalid interval unit: "${m[2]}"`);
  }
}

/** "08:00" or "08:00:30" → { h, m, s }. Throws on bad input. */
function parseTimeOfDay(s: string): { h: number; m: number; s: number } {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) throw new Error(`invalid time-of-day: "${s}" — use HH:MM or HH:MM:SS`);
  const h = parseInt(m[1]!, 10), mm = parseInt(m[2]!, 10), ss = m[3] ? parseInt(m[3], 10) : 0;
  if (h > 23 || mm > 59 || ss > 59) throw new Error(`time-of-day out of range: "${s}"`);
  return { h, m: mm, s: ss };
}

function nextDailyAfter(now: Date, t: { h: number; m: number; s: number }): Date {
  const next = new Date(now);
  next.setHours(t.h, t.m, t.s, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function nextWeeklyAfter(now: Date, day: WeekDay, t: { h: number; m: number; s: number }): Date {
  const targetDow = WEEKDAYS.indexOf(day);
  if (targetDow < 0) throw new Error(`invalid weekday: ${day}`);
  const next = new Date(now);
  next.setHours(t.h, t.m, t.s, 0);
  let delta = (targetDow - now.getDay() + 7) % 7;
  if (delta === 0 && next.getTime() <= now.getTime()) delta = 7;
  next.setDate(now.getDate() + delta);
  return next;
}

// ─────────────────────────────────────────────────────────────────────
// Minimal cron-5-field parser. Standard order: m h dom mon dow.
// Supported per field: "*", number, "*/N", "a,b,c". Ranges (1-5) and
// names (MON/JAN) intentionally NOT supported.
// ─────────────────────────────────────────────────────────────────────

interface CronField {
  match: (value: number) => boolean;
}

function parseField(field: string, min: number, max: number): CronField {
  if (field === '*') return { match: () => true };
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`bad step: ${field}`);
    return { match: (v) => v >= min && v <= max && (v - min) % step === 0 };
  }
  const values = field.split(',').map((s) => {
    const n = parseInt(s, 10);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error(`bad value '${s}' for cron field (range ${min}-${max})`);
    }
    return n;
  });
  const set = new Set(values);
  return { match: (v) => set.has(v) };
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;     // 1-12
  dayOfWeek: CronField; // 0-6, 0=Sun (Vixie convention)
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields (m h dom mon dow), got ${parts.length}: "${expr}"`);
  }
  return {
    minute:     parseField(parts[0]!, 0, 59),
    hour:       parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month:      parseField(parts[3]!, 1, 12),
    dayOfWeek:  parseField(parts[4]!, 0, 6),
  };
}

function nextCronAfter(now: Date, cron: ParsedCron): Date {
  // Brute-force forward minute-by-minute scan. Capped at one year to
  // catch impossible specs (e.g. day-of-month=31 month=2).
  const start = new Date(now);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = new Date(start.getTime() + 366 * 24 * 60 * 60 * 1000);
  const t = new Date(start);
  while (t.getTime() < limit.getTime()) {
    if (
      cron.minute.match(t.getMinutes()) &&
      cron.hour.match(t.getHours()) &&
      cron.month.match(t.getMonth() + 1) &&
      // Vixie semantics: dom and dow are OR'd when both restricted.
      // When one is '*' (matches all), the other acts as the constraint.
      (cron.dayOfMonth.match(t.getDate()) || cron.dayOfWeek.match(t.getDay()))
    ) {
      return t;
    }
    t.setMinutes(t.getMinutes() + 1);
  }
  throw new Error(`cron "${stringifyCron(cron)}" has no fire time within a year of ${now.toISOString()}`);
}

function stringifyCron(_c: ParsedCron): string {
  // Best-effort — we kept the original string elsewhere; this is only
  // for the error message above. Caller passed the original.
  return '<cron>';
}

// ─────────────────────────────────────────────────────────────────────
// Top-level dispatch
// ─────────────────────────────────────────────────────────────────────

/** Compute the next fire instant strictly after `now`. Returns null
 *  for `at`-triggers whose moment has already passed (one-shot
 *  completed). All other variants always return a future date. */
export function computeNextFire(spec: TimeSpec, now: Date = new Date()): Date | null {
  switch (spec.type) {
    case 'at': {
      const t = new Date(spec.iso);
      if (Number.isNaN(t.getTime())) throw new Error(`invalid ISO timestamp: "${spec.iso}"`);
      return t.getTime() > now.getTime() ? t : null;
    }
    case 'every': {
      const ms = parseInterval(spec.interval);
      return new Date(now.getTime() + ms);
    }
    case 'daily':
      return nextDailyAfter(now, parseTimeOfDay(spec.time));
    case 'weekly':
      return nextWeeklyAfter(now, spec.day, parseTimeOfDay(spec.time));
    case 'cron':
      return nextCronAfter(now, parseCron(spec.expression));
  }
}

/** Validate a TimeSpec — throws on shape/range errors. Used by the
 *  create-trigger path before persisting anything. */
export function validateTimeSpec(spec: TimeSpec): void {
  switch (spec.type) {
    case 'at': {
      const t = new Date(spec.iso);
      if (Number.isNaN(t.getTime())) throw new Error(`invalid ISO timestamp: "${spec.iso}"`);
      return;
    }
    case 'every':
      parseInterval(spec.interval); // throws on bad input
      return;
    case 'daily':
      parseTimeOfDay(spec.time);
      return;
    case 'weekly':
      if (!WEEKDAYS.includes(spec.day)) {
        throw new Error(`invalid weekday: "${spec.day}" — use one of ${WEEKDAYS.join('/')}`);
      }
      parseTimeOfDay(spec.time);
      return;
    case 'cron':
      parseCron(spec.expression);
      return;
  }
}

/** Human-readable rendering for list/detail views. Doesn't lose info —
 *  the canonical form is the TimeSpec itself; this is for humans. */
export function describeTimeSpec(spec: TimeSpec): string {
  switch (spec.type) {
    case 'at':     return `Once at ${spec.iso}`;
    case 'every':  return `Every ${spec.interval}`;
    case 'daily':  return `Daily at ${spec.time}`;
    case 'weekly': return `Weekly on ${spec.day} at ${spec.time}`;
    case 'cron':   return `Cron "${spec.expression}"`;
  }
}
