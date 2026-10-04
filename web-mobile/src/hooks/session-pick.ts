// What the session sheet needs to decide, kept free of React and the
// DOM so it can be tested: which session an agent opens with, the
// order of the session list, which model row is the active one and
// which is the persona's default.

import type { ModelOption, SessionModelInfo } from '../../../web/src/lib/api';

export interface OpenSession {
  id: string;
  slug: string;
}

export const MAIN_SESSION: OpenSession = { id: 'main', slug: 'main' };

const STORAGE_PREFIX = 'somora.mobile.lastSession.';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The session an agent was last open in on this phone; main when
 *  nothing (or nothing readable) is stored. */
export function readLastSession(store: Store | null, agent: string): OpenSession {
  if (!store) return MAIN_SESSION;
  try {
    const raw = store.getItem(STORAGE_PREFIX + agent);
    if (!raw) return MAIN_SESSION;
    const v = JSON.parse(raw) as Partial<OpenSession> | null;
    if (v && typeof v.id === 'string' && v.id && typeof v.slug === 'string' && v.slug) {
      return { id: v.id, slug: v.slug };
    }
  } catch {
    /* unreadable entry or storage disabled — main */
  }
  return MAIN_SESSION;
}

export function writeLastSession(store: Store | null, agent: string, session: OpenSession): void {
  if (!store) return;
  try {
    if (session.id === 'main') store.removeItem(STORAGE_PREFIX + agent);
    else store.setItem(STORAGE_PREFIX + agent, JSON.stringify({ id: session.id, slug: session.slug }));
  } catch {
    /* quota / disabled — the pick just is not remembered */
  }
}

/** main first, then the most recently used; a session nobody wrote in
 *  yet counts from when it was created. */
export function orderSessions<T extends { id: string; isMain: boolean; lastActivity: string | null; createdAt?: string | null }>(sessions: readonly T[]): T[] {
  const at = (s: T) => s.lastActivity ?? s.createdAt ?? '';
  return [...sessions].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    const ta = at(a);
    const tb = at(b);
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
}

/** The rows shown before "show all": the first `limit`, and the open
 *  session even when it sits further down. */
export function visibleSessions<T extends { id: string }>(ordered: readonly T[], openId: string, limit: number, showAll: boolean): T[] {
  if (showAll || ordered.length <= limit) return [...ordered];
  const head = ordered.slice(0, limit);
  if (head.some((s) => s.id === openId)) return head;
  const open = ordered.find((s) => s.id === openId);
  return open ? [...head.slice(0, limit - 1), open] : head;
}

export function isActiveModel(info: SessionModelInfo | null, m: Pick<ModelOption, 'provider' | 'id'>): boolean {
  return Boolean(info && info.provider === m.provider && info.modelId === m.id);
}

/** Is this the model the agent uses when the session has no choice of
 *  its own? The persona names it by alias or by provider/id. */
export function isPersonaDefault(info: SessionModelInfo | null, m: Pick<ModelOption, 'provider' | 'id' | 'alias' | 'ref'>): boolean {
  const pd = info?.personaDefault;
  if (!pd) return false;
  return pd === m.ref || pd === m.alias || pd === `${m.provider}/${m.id}`;
}

/** Short name for the header: the alias, else the bare model id. */
export function modelLabel(info: Pick<SessionModelInfo, 'alias' | 'modelId'> | null): string {
  if (!info) return '';
  return info.alias ?? info.modelId;
}

/** `provider/id` → the alias from the model list when there is one,
 *  else the id without its provider. For the fallback marker. */
export function labelForRef(ref: string, models: readonly Pick<ModelOption, 'provider' | 'id' | 'alias'>[]): string {
  const hit = models.find((m) => `${m.provider}/${m.id}` === ref || m.alias === ref);
  if (hit) return hit.alias ?? hit.id;
  const slash = ref.indexOf('/');
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

/** "just now", "5 min", "3 h", "2 d", then the date. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d`;
  return new Date(t).toISOString().slice(0, 10);
}
