// The order of the agent tiles in the /mobile client, the same on every
// device: a list of agent names in ~/.somora/mobile/agent-order.json.
// Kept apart from config.yaml so a reorder on the phone never rewrites
// the user's config. Agents not in the list follow in name order;
// names of agents that no longer exist are kept (harmless) until the
// next save from a client that sends only the agents it shows.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
export const MAX_ORDER_NAMES = 500;

export function agentOrderPath(home = process.env.SOMORA_HOME ?? join(homedir(), '.somora')): string {
  return join(home, 'mobile', 'agent-order.json');
}

export async function readAgentOrder(path = agentOrderPath()): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { order?: unknown };
    return Array.isArray(raw.order) ? raw.order.filter((n): n is string => typeof n === 'string' && NAME.test(n)) : [];
  } catch {
    return [];
  }
}

/** Check a list from a client: names only, each once. */
export function parseAgentOrder(body: unknown): { ok: true; order: string[] } | { ok: false; error: string } {
  const order = (body as { order?: unknown } | null)?.order;
  if (!Array.isArray(order)) return { ok: false, error: 'order must be a list of agent names' };
  if (order.length > MAX_ORDER_NAMES) return { ok: false, error: `order has more than ${MAX_ORDER_NAMES} names` };
  const seen = new Set<string>();
  for (const n of order) {
    if (typeof n !== 'string' || !NAME.test(n)) return { ok: false, error: `not an agent name: ${JSON.stringify(n)}` };
    if (seen.has(n)) return { ok: false, error: `${n} is in the list twice` };
    seen.add(n);
  }
  return { ok: true, order: order as string[] };
}

// One save after the other: two devices saving at once each get their
// own temp file and their rename in turn — the later one wins whole,
// never a mix (review 2026-10-26).
let saving: Promise<void> = Promise.resolve();

export function writeAgentOrder(order: readonly string[], path = agentOrderPath()): Promise<void> {
  const run = saving.then(async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(tmp, `${JSON.stringify({ order }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  });
  saving = run.catch(() => {});
  return run;
}
