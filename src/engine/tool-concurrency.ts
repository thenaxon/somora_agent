// Which tool calls of one round may run at the same time, and how many
// at once (private/parallel-tools/KONZEPT.md, 2026-11-09).
//
// Hermes Agent and DeepSeek's harness run a round's calls side by side,
// but only those a tool vouches for; everything unknown runs alone. Same
// here: a tool marks itself `concurrent` (reads, searches, status
// lookups — nothing whose result depends on what ran beside it), and the
// engine groups consecutive such calls. A call that must run alone is a
// barrier: it waits for the group before it, runs, and only then do
// later calls start. Results always go back in the model's order.

import type { ToolDefinition } from '../tools/types.ts';

/** May this call run beside others? Fails closed: an unknown tool, an
 *  unset or non-`true` answer, or a throwing classifier means alone. */
export function runsConcurrently(def: Pick<ToolDefinition, 'concurrent'> | undefined, input: unknown): boolean {
  const c = def?.concurrent;
  if (c === true) return true;
  if (typeof c !== 'function') return false;
  try {
    return (c as (input: unknown) => boolean)(input) === true;
  } catch {
    return false;
  }
}

/** At most `max` tasks running; the rest start in order as slots free. */
export function createLimiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const waiting: Array<() => void> = [];
  const next = (): void => {
    active--;
    waiting.shift()?.();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        active++;
        let p: Promise<T>;
        try {
          p = task();
        } catch (err) {
          next();
          reject(err);
          return;
        }
        p.then(
          (v) => {
            next();
            resolve(v);
          },
          (e: unknown) => {
            next();
            reject(e);
          },
        );
      };
      if (active < limit) start();
      else waiting.push(start);
    });
}
