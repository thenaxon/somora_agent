// The tool activity of a turn on the phone (docs/mobile.md "Tool
// activity"). The mobile chat shows text only; a turn that works with
// tools — above all a builder, which writes no text for hours — looked
// dead there. One `activity` row per turn collects its tool calls: open
// while the turn runs (the last calls, how long, how many), one line
// once it ended. Pure (no React, no fetch) so history replay and the
// live stream fold the same way — see activity.test.mts.

export type StepState = 'running' | 'done' | 'error';

export interface ActivityStep {
  /** The engine's call id (history, and live since the `tool` event
   *  carries it); pairs the result with its call. */
  callId?: string;
  tool: string;
  /** One short line: the command, the path, the query. May be empty. */
  label: string;
  ts: number;
  state: StepState;
  error?: string;
}

export interface Activity {
  steps: ActivityStep[];
  /** Calls in this turn as far as this client saw them; `steps` keeps
   *  only the newest MAX_STEPS. */
  total: number;
  startedAt: number;
  /** Set when the turn ended (turn_end in history, agent end live). */
  endedAt?: number;
}

/** Steps kept per turn. A builder makes thousands of calls in a night;
 *  the phone needs the latest ones and the count. */
export const MAX_STEPS = 200;

const LABEL_FIELDS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'task', 'reference', 'slug', 'name', 'question'] as const;
const LABEL_MAX = 120;

/** The line shown for a call: the first telling field of its input. */
export function stepLabel(tool: string, input: unknown): string {
  let obj = input;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return oneLine(obj as string);
    }
  }
  if (!obj || typeof obj !== 'object') return '';
  const rec = obj as Record<string, unknown>;
  if (tool === 'todo_write' && Array.isArray(rec.todos)) return `${rec.todos.length} tasks`;
  if (tool === 'acceptance_write' && Array.isArray(rec.items)) return `${rec.items.length} items`;
  for (const f of LABEL_FIELDS) {
    const v = rec[f];
    if (typeof v === 'string' && v.trim()) return oneLine(v);
  }
  return '';
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX).trimEnd()}…` : t;
}

export function newActivity(ts: number): Activity {
  return { steps: [], total: 0, startedAt: ts };
}

export function addCall(a: Activity, step: Omit<ActivityStep, 'state'>): Activity {
  const steps = [...a.steps, { ...step, state: 'running' as const }];
  return {
    ...a,
    steps: steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps,
    total: a.total + 1,
  };
}

/** A result or failure: the call with that id, else the oldest running
 *  call of that tool (a live event from a server without call ids). */
export function settleCall(a: Activity, r: { callId?: string; tool?: string; error?: string }): Activity {
  let idx = -1;
  if (r.callId) idx = a.steps.findIndex((s) => s.callId === r.callId);
  if (idx < 0 && r.tool) idx = a.steps.findIndex((s) => s.state === 'running' && s.tool === r.tool);
  if (idx < 0) return a;
  const steps = a.steps.slice();
  steps[idx] = { ...steps[idx]!, state: r.error ? 'error' : 'done', ...(r.error ? { error: oneLine(r.error) } : {}) };
  return { ...a, steps };
}

/** The turn ended: nothing runs any more. */
export function closeActivity(a: Activity, ts: number): Activity {
  if (a.endedAt !== undefined) return a;
  return {
    ...a,
    endedAt: ts,
    steps: a.steps.map((s) => (s.state === 'running' ? { ...s, state: 'done' } : s)),
  };
}

/** Two rows of one turn split by a history page boundary: one row. */
export function joinActivities(older: Activity, newer: Activity): Activity {
  const steps = [...older.steps, ...newer.steps];
  return {
    steps: steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps,
    total: older.total + newer.total,
    startedAt: Math.min(older.startedAt, newer.startedAt),
    ...(newer.endedAt !== undefined ? { endedAt: newer.endedAt } : {}),
  };
}

/** "45 s", "12 min", "2:08 h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, '0')} h`;
}
