// Pure formatting for the session's work queue (GET …/work): the
// status-line counters and the /queue listing. No React, no HTTP —
// the App fetches, this file only turns the server's view into text.

import { SYSTEM_LABELS } from './turn-views.tsx';
import type { SessionWork, WorkItemInfo, WorkRequesterInfo } from './types.ts';

/** Glyph + label per work kind. System-inbound kinds reuse the glyphs
 *  the scrollback shows for the same turns; `human` and `agent` (a
 *  question another agent asked) have no scrollback label of their own. */
export function workLabel(it: Pick<WorkItemInfo, 'kind' | 'about'>): string {
  switch (it.kind) {
    case 'human':
      return '👤 you';
    case 'agent':
      return '💬 agent ask';
    case 'wake':
      return SYSTEM_LABELS[it.about ?? 'a2a'];
    case 'sentinel':
    case 'subagent':
    case 'browser':
    case 'voice':
    case 'tmux':
      return SYSTEM_LABELS[it.kind];
    default:
      return String(it.kind);
  }
}

/** Who queued the entry, as a short name. */
export function requesterName(r: WorkRequesterInfo | undefined): string {
  if (!r) return '';
  if ('human' in r) return 'you';
  if ('voiceCall' in r) return 'voice call';
  return `${r.agent}:${r.session}`;
}

/** `12s`, `3m 05s`, `2h 14m` — how long since `since`. */
export function formatAge(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export interface WorkCounters {
  waiting: number;
  running: number;
  children: number;
  arriving: number;
}

export function workCounters(work: SessionWork | null): WorkCounters {
  if (!work) return { waiting: 0, running: 0, children: 0, arriving: 0 };
  return {
    waiting: work.queued.length,
    running: work.active || work.busy ? 1 : 0,
    children: work.children.length,
    arriving: work.pendingWakes.length,
  };
}

/** Status-line segment: `⌛3 ▶1 🤖2 ↩1` — waiting, running, started
 *  from here, arriving. Empty string when everything is zero. */
export function formatWorkCounters(work: SessionWork | null): string {
  const c = workCounters(work);
  const parts: string[] = [];
  if (c.waiting > 0) parts.push(`⌛${c.waiting}`);
  if (c.running > 0) parts.push(`▶${c.running}`);
  if (c.children > 0) parts.push(`🤖${c.children}`);
  if (c.arriving > 0) parts.push(`↩${c.arriving}`);
  return parts.join(' ');
}

function preview(it: WorkItemInfo): string {
  const p = it.preview.replace(/\s+/g, ' ').trim();
  return p.length > 0 ? `"${p}"` : '(no preview)';
}

function arrivingLine(it: WorkItemInfo, now: number): string {
  const from = it.target ? `${it.target.agent}:${it.target.session}` : '';
  const ago = it.finishedAt !== undefined ? `, ${formatAge(now - it.finishedAt)} ago` : '';
  const outcome = it.state === 'failed' ? ' (failed)' : '';
  switch (it.about) {
    case 'a2a':
      return `${SYSTEM_LABELS.a2a}  answer from ${from}${outcome}${ago}`;
    case 'subagent':
      return `${SYSTEM_LABELS.subagent}  result from ${from}${outcome}${ago}`;
    case 'job':
      return `${SYSTEM_LABELS.job}  ${preview(it)}${outcome}${ago}`;
    default:
      return `${workLabel(it)}  ${preview(it)}${outcome}${ago}`;
  }
}

/** The /queue listing. `now` is injected so the output is testable. */
export function formatWorkList(work: SessionWork | null, now = Date.now()): string {
  if (!work) return 'queue: the server did not answer (older server without /work?)';
  const lines: string[] = [`Queue for ${work.agent}:${work.session}`];

  lines.push('Running:');
  if (work.active) {
    const it = work.active;
    const since = it.startedAt !== undefined ? `, since ${formatAge(now - it.startedAt)}` : '';
    const by = it.requester ? `, from ${requesterName(it.requester)}` : '';
    lines.push(`  ${workLabel(it)}  ${preview(it)}${by}${since}`);
  } else if (work.busy) {
    lines.push('  a turn the ledger does not know (started before the server restart?)');
  } else {
    lines.push('  nothing');
  }

  lines.push(`Waiting (${work.queued.length}):`);
  if (work.queued.length === 0) lines.push('  nothing');
  work.queued.forEach((it, i) => {
    const n = String(it.position ?? i + 1).padStart(2);
    const by = it.requester ? `, from ${requesterName(it.requester)}` : '';
    const waited = it.enqueuedAt !== undefined ? `, waited ${formatAge(now - it.enqueuedAt)}` : '';
    lines.push(`  ${n}. ${workLabel(it)}  ${preview(it)}${by}${waited}`);
  });

  if (work.pendingWakes.length > 0) {
    lines.push(`Arriving (${work.pendingWakes.length}):`);
    for (const it of work.pendingWakes) lines.push(`  ${arrivingLine(it, now)}`);
  }

  if (work.children.length > 0) {
    lines.push(`From here (${work.children.length}):`);
    // Numbered on from the waiting entries, so /queue rm <n> reaches
    // them too: a queued child is removed, a running one stopped.
    work.children.forEach((it, i) => {
      const n = String(work.queued.length + i + 1).padStart(2);
      const target = it.target ? `${it.target.agent}:${it.target.session}` : '?';
      const label = it.kind === 'agent' ? '💬 agent ask' : workLabel(it);
      const age =
        it.state === 'running' && it.startedAt !== undefined
          ? `, since ${formatAge(now - it.startedAt)}`
          : it.state === 'queued' && it.enqueuedAt !== undefined
            ? `, waited ${formatAge(now - it.enqueuedAt)}`
            : '';
      lines.push(`  ${n}. ${label} → ${target}  ${preview(it)}  [${it.state}${age}]`);
    });
  }

  if (work.queued.length > 0 || work.children.length > 0) {
    lines.push('/queue rm <n> removes a waiting entry; on a running entry under "From here" it stops it.');
  }
  return lines.join('\n');
}

/** What /queue rm <n> points at: a waiting entry first, then the
 *  children in list order. */
export function queueEntryAt(work: SessionWork, n: number): { where: 'waiting' | 'children'; item: SessionWork['queued'][number] } | null {
  const waiting = work.queued.find((it) => it.position === n) ?? (n <= work.queued.length ? work.queued[n - 1] : undefined);
  if (waiting) return { where: 'waiting', item: waiting };
  const child = work.children[n - work.queued.length - 1];
  return child ? { where: 'children', item: child } : null;
}
