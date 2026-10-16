// The inbox: notices for the person running somora (docs/web.md,
// private/inbox/KONZEPT.md) — a new version, the note somora.ai sends
// with the daily update check, and things somora cannot fix by itself
// (a broken config, an expired login, a certificate, failing dream
// runs, a tool server or model gone for a day).
//
// Rules against noise:
//   - one entry per THING (a stable key), never one per event — a new
//     event on an open entry only bumps its counter and "last seen";
//   - a condition becomes an entry only once it persists (`observe`);
//   - an entry resolves itself when the condition is gone, and drops
//     out a day later;
//   - muted entries stay quiet (until resolved once, or forever).
//
// Text only. Nothing in here ever goes to an agent.

import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export type InboxKind = 'update' | 'news' | 'config' | 'login' | 'tls' | 'dream' | 'mcp' | 'model' | 'sentinel' | 'a2a';
export type InboxLevel = 'info' | 'warning' | 'important';
export type InboxMute = 'until-resolved' | 'forever';

export interface InboxEntry {
  key: string;
  kind: InboxKind;
  level: InboxLevel;
  title: string;
  text: string;
  url?: string;
  firstSeen: number;
  lastSeen: number;
  count: number;
  readAt?: number;
  resolvedAt?: number;
  muted?: InboxMute;
}

export interface InboxNotice {
  kind: InboxKind;
  level: InboxLevel;
  title: string;
  text: string;
  url?: string;
}

interface Observation {
  firstSeen: number;
  lastSeen: number;
  count: number;
}

interface InboxFile {
  entries: InboxEntry[];
  observations: Record<string, Observation>;
}

const RESOLVED_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 50;
const TITLE_MAX = 160;
const TEXT_MAX = 1500;

export function inboxFilePath(home = process.env.SOMORA_HOME ?? join(homedir(), '.somora')): string {
  return join(home, 'inbox.json');
}

export class Inbox {
  private entries = new Map<string, InboxEntry>();
  private observations = new Map<string, Observation>();
  private saveTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();
  private readonly path: string;
  private readonly now: () => number;

  constructor(path = inboxFilePath(), now: () => number = Date.now) {
    this.path = path;
    this.now = now;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<InboxFile>;
      for (const e of raw.entries ?? []) if (e && typeof e.key === 'string') this.entries.set(e.key, e);
      for (const [k, o] of Object.entries(raw.observations ?? {})) this.observations.set(k, o);
    } catch {
      /* first start, or an unreadable file: start empty */
    }
  }

  /** Called after every change (the web client is told to re-read). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The condition behind `key` is present. Opens the entry, or bumps
   *  the open one; reopens a resolved one as new. */
  raise(key: string, notice: InboxNotice, opts: { count?: boolean } = {}): void {
    const now = this.now();
    const title = notice.title.slice(0, TITLE_MAX);
    const text = notice.text.slice(0, TEXT_MAX);
    const cur = this.entries.get(key);
    if (cur && cur.resolvedAt === undefined) {
      const changed = cur.title !== title || cur.text !== text || cur.level !== notice.level;
      cur.lastSeen = now;
      // A state checked every few minutes is one condition, not many
      // events: only events count.
      if (opts.count !== false) cur.count += 1;
      cur.title = title;
      cur.text = text;
      cur.level = notice.level;
      if (notice.url) cur.url = notice.url;
      else delete cur.url;
      this.changed(changed);
      return;
    }
    const entry: InboxEntry = {
      key,
      kind: notice.kind,
      level: notice.level,
      title,
      text,
      ...(notice.url ? { url: notice.url } : {}),
      firstSeen: now,
      lastSeen: now,
      count: 1,
      // Muted until it resolved once: it did, so it speaks again.
      ...(cur?.muted === 'forever' ? { muted: 'forever' as const } : {}),
    };
    this.entries.set(key, entry);
    this.prune();
    this.changed(true);
  }

  /** The condition behind `key` is gone. */
  resolve(key: string): void {
    const cur = this.entries.get(key);
    this.observations.delete(key);
    if (!cur || cur.resolvedAt !== undefined) return;
    cur.resolvedAt = this.now();
    if (cur.muted === 'until-resolved') delete cur.muted;
    this.changed(true);
  }

  /** Resolve every open entry whose key starts with `prefix`, except `keep`. */
  resolvePrefix(prefix: string, keep?: string): void {
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix) && k !== keep) this.resolve(k);
  }

  /** A condition that only counts once it persists: returns how long it
   *  has been seen (ms) and how often. `resolve(key)` clears it. */
  observe(key: string): Observation {
    const now = this.now();
    const o = this.observations.get(key) ?? { firstSeen: now, lastSeen: now, count: 0 };
    o.lastSeen = now;
    o.count += 1;
    this.observations.set(key, o);
    this.scheduleSave();
    return { ...o };
  }

  forget(key: string): void {
    if (this.observations.delete(key)) this.scheduleSave();
  }

  observation(key: string): Observation | undefined {
    const o = this.observations.get(key);
    return o ? { ...o } : undefined;
  }

  /** What the inbox shows: unmuted, open or resolved within a day. */
  list(): InboxEntry[] {
    this.prune();
    return [...this.entries.values()]
      .filter((e) => !e.muted)
      .sort((a, b) => Number(a.resolvedAt !== undefined) - Number(b.resolvedAt !== undefined) || b.lastSeen - a.lastSeen)
      .map((e) => ({ ...e }));
  }

  unread(): number {
    return this.list().filter((e) => e.resolvedAt === undefined && e.readAt === undefined).length;
  }

  markRead(keys?: string[]): void {
    const now = this.now();
    let n = 0;
    for (const e of this.entries.values()) {
      if (e.readAt !== undefined) continue;
      if (keys && !keys.includes(e.key)) continue;
      e.readAt = now;
      n++;
    }
    if (n > 0) this.changed(true);
  }

  mute(key: string, mode: InboxMute): boolean {
    const e = this.entries.get(key);
    if (!e) return false;
    e.muted = mode;
    this.changed(true);
    return true;
  }

  unmute(key: string): boolean {
    const e = this.entries.get(key);
    if (!e || !e.muted) return false;
    delete e.muted;
    this.changed(true);
    return true;
  }

  /** Muted entries, for the "muted" list where they can be switched back on. */
  muted(): InboxEntry[] {
    return [...this.entries.values()].filter((e) => e.muted).map((e) => ({ ...e }));
  }

  private prune(): void {
    const now = this.now();
    for (const [k, e] of this.entries) {
      if (e.resolvedAt !== undefined && now - e.resolvedAt > RESOLVED_KEEP_MS && e.muted !== 'forever') this.entries.delete(k);
    }
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = [...this.entries.values()].sort(
        (a, b) => Number(b.resolvedAt !== undefined) - Number(a.resolvedAt !== undefined) || a.lastSeen - b.lastSeen,
      );
      for (const e of oldest.slice(0, this.entries.size - MAX_ENTRIES)) this.entries.delete(e.key);
    }
  }

  private changed(notify: boolean): void {
    this.scheduleSave();
    if (notify) for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* listeners never break the inbox */
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 1000);
    this.saveTimer.unref?.();
  }

  saveNow(): void {
    const data: InboxFile = { entries: [...this.entries.values()], observations: Object.fromEntries(this.observations) };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch {
      /* the inbox is a convenience; a failed write is retried on the next change */
    }
  }
}
