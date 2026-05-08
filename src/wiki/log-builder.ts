// Append entries to the wiki's monthly log (`logs/YYYY-MM.md`).
//
// Format:
//   # Wiki-Log Mai 2026
//
//   ## 2026-05-08
//
//   ### Promoted
//   - [[personen/luca]] aus hans/luca (initial)
//
//   ### Updated
//   - [[personen/luca]] (Alter 8 → 9, source: hans-session)
//
// One file per calendar month (UTC). Append-only inside the file —
// callers pass an array of entries from a single Dream-B run; the
// builder collates by date heading and section.
//
// See `private/wiki-design.md` § "log.md-Format".

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '../server/logger.ts';
import type { CandidateOutcome } from './types.ts';

export interface LogEntry {
  /** Wiki path (relative to wiki root, no .md). */
  wikiPath: string;
  /**
   * "promoted" → "Promoted" section.
   * "updated"  → "Updated" section.
   * "queued"   → "Queued for merge" section (Phase 4 / Weg 2).
   */
  kind: 'promoted' | 'updated' | 'queued';
  /** Short German one-liner. */
  summary: string;
  /** ISO timestamp of when the action ran. */
  ts: number;
}

/** Convert a CandidateOutcome into a log entry, or null if the
 *  outcome shouldn't appear in the log (skipped/failed). */
export function outcomeToLogEntry(o: CandidateOutcome, ts: number): LogEntry | null {
  switch (o.kind) {
    case 'promoted':
      return { wikiPath: o.wikiPath, kind: 'promoted', summary: o.logSummary, ts };
    case 'merged':
      return { wikiPath: o.wikiPath, kind: 'updated', summary: o.logSummary, ts };
    case 'queued_merge':
      return { wikiPath: o.wikiPath, kind: 'queued', summary: o.logSummary, ts };
    default:
      return null;
  }
}

export async function appendLogEntries(args: {
  wikiAbs: string;
  entries: LogEntry[];
}): Promise<void> {
  if (args.entries.length === 0) return;

  // Bucket entries by UTC date.
  const byDate = new Map<
    string,
    { promoted: LogEntry[]; updated: LogEntry[]; queued: LogEntry[] }
  >();
  for (const e of args.entries) {
    const date = utcDate(e.ts);
    if (!byDate.has(date)) {
      byDate.set(date, { promoted: [], updated: [], queued: [] });
    }
    byDate.get(date)![e.kind].push(e);
  }

  // Group by month — usually all entries fall in the same month from
  // a single Dream-B run, but we don't assume.
  const byMonth = new Map<
    string,
    Map<string, { promoted: LogEntry[]; updated: LogEntry[]; queued: LogEntry[] }>
  >();
  for (const [date, sections] of byDate) {
    const month = date.slice(0, 7); // YYYY-MM
    if (!byMonth.has(month)) byMonth.set(month, new Map());
    byMonth.get(month)!.set(date, sections);
  }

  const logsDir = join(args.wikiAbs, 'logs');
  await mkdir(logsDir, { recursive: true });

  for (const [month, dates] of byMonth) {
    const logFile = join(logsDir, `${month}.md`);
    let existing = '';
    try {
      existing = await readFile(logFile, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (!existing) {
      const monthName = monthLabel(month);
      existing = `# Wiki-Log ${monthName}\n\n`;
    }
    let appended = existing.endsWith('\n') ? existing : existing + '\n';
    // Sort dates descending — newest first inside the month file.
    const sortedDates = [...dates.keys()].sort().reverse();
    for (const date of sortedDates) {
      const sections = dates.get(date)!;
      // If the existing log already has this date heading, we still
      // append a new run-block under it; readers can interpret the
      // ordering as chronological per Dream-B run.
      appended += `## ${date}\n\n`;
      if (sections.promoted.length > 0) {
        appended += `### Promoted\n`;
        for (const e of sections.promoted) {
          appended += `- [[${e.wikiPath}]] — ${e.summary}\n`;
        }
        appended += '\n';
      }
      if (sections.updated.length > 0) {
        appended += `### Updated\n`;
        for (const e of sections.updated) {
          appended += `- [[${e.wikiPath}]] — ${e.summary}\n`;
        }
        appended += '\n';
      }
      if (sections.queued.length > 0) {
        appended += `### Queued for merge (next-run will integrate)\n`;
        for (const e of sections.queued) {
          appended += `- [[${e.wikiPath}]] — ${e.summary}\n`;
        }
        appended += '\n';
      }
    }
    await writeFile(logFile, appended, 'utf8');
    logger.info({
      msg: 'wiki.log.appended',
      month,
      file: logFile,
      datesInThisRun: sortedDates.length,
      totalEntries: args.entries.length,
    });
  }
}

function utcDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function monthLabel(yyyymm: string): string {
  const [y, m] = yyyymm.split('-');
  const monthNames = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
  ];
  const idx = Number(m) - 1;
  return `${monthNames[idx] ?? m} ${y}`;
}
