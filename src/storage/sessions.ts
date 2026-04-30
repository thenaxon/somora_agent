// In-memory session storage. Filesystem persistence comes in step 1c.
import type { SessionMeta, SessionMetaStore } from '../engine/types.ts';
import type { NormalizedEvent } from '../types/events.ts';

const histories = new Map<string, NormalizedEvent[]>();
const metas = new Map<string, SessionMeta>();

const k = (agent: string, session: string) => `${agent}::${session}`;

export function getHistory(agent: string, session: string): NormalizedEvent[] {
  return histories.get(k(agent, session)) ?? [];
}

export function appendEvent(agent: string, session: string, ev: NormalizedEvent): void {
  const key = k(agent, session);
  const list = histories.get(key) ?? [];
  list.push(ev);
  histories.set(key, list);
}

export const sessionMetaStore: SessionMetaStore = {
  async get(agent, session) {
    return metas.get(k(agent, session)) ?? {};
  },
  async set(agent, session, meta) {
    metas.set(k(agent, session), meta);
  },
};
