// Brakes on handing external agents work (docs/a2a.md):
//   - per external agent, at most N tasks at the same time; more wait in
//     line (first come, first served) until one finishes;
//   - across all external agents, at most M tasks a day. The count lives
//     in ~/.somora/a2a/usage.json, so a restart does not reset it.
// somora cannot see what a task costs over there — the other side
// reports no tokens — so it brakes by count and time.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

interface Slot {
  running: number;
  waiting: Array<() => void>;
}

const slots = new Map<string, Slot>();

/** Wait for a free slot for `agent`; resolves to the release function.
 *  `onWait` fires once when the task has to wait. Aborting the signal
 *  while waiting rejects with the signal's reason. */
export async function acquireSlot(agent: string, max: number, signal?: AbortSignal, onWait?: (ahead: number) => void): Promise<() => void> {
  let s = slots.get(agent);
  if (!s) {
    s = { running: 0, waiting: [] };
    slots.set(agent, s);
  }
  const slot = s;
  if (slot.running >= max) {
    // A finishing task hands its slot straight on (release below), so the
    // count stays right even when a new caller arrives in between.
    onWait?.(slot.waiting.length + 1);
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const i = slot.waiting.indexOf(go);
        if (i >= 0) slot.waiting.splice(i, 1);
        reject(new Error('stopped while waiting for a free slot'));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      slot.waiting.push(go);
    });
  } else {
    slot.running += 1;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Hand the slot on while there is room (the limit may have been
    // lowered meanwhile); else free it.
    if (slot.running <= max && slot.waiting.length > 0) slot.waiting.shift()!();
    else slot.running -= 1;
  };
}

/** Tasks running / waiting per external agent, for status views. */
export function slotState(agent: string): { running: number; waiting: number } {
  const s = slots.get(agent);
  return { running: s?.running ?? 0, waiting: s?.waiting.length ?? 0 };
}

export function resetSlots(): void {
  slots.clear();
}

function usagePath(): string {
  return join(process.env.SOMORA_HOME ?? join(homedir(), '.somora'), 'a2a', 'usage.json');
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readUsage(): { day: string; count: number } {
  try {
    const u = JSON.parse(readFileSync(usagePath(), 'utf8')) as { day?: unknown; count?: unknown };
    if (u.day === today() && typeof u.count === 'number') return { day: u.day, count: u.count };
  } catch {
    /* first use, or a garbled file: start counting from zero */
  }
  return { day: today(), count: 0 };
}

/** Count one task against today's limit. False when the limit is reached
 *  (nothing is counted then). */
export function takeDailyCall(max: number): { ok: boolean; count: number } {
  const u = readUsage();
  if (u.count >= max) return { ok: false, count: u.count };
  const next = { day: u.day, count: u.count + 1 };
  const p = usagePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next) + '\n');
  renameSync(tmp, p);
  return { ok: true, count: next.count };
}

export function dailyCalls(): number {
  return readUsage().count;
}
