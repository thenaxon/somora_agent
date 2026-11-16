// Tmux session origin tracking — `~/.somora/tmux-origins.json`.
//
// Every time the `tmux` tool's `action: 'create'` lands a fresh local
// session, we record { agent, session, createdAt } keyed by the tmux
// session name. The web client's tmux-list view joins live `tmux ls`
// output with these records to surface "↳ from <agent> · <session>"
// alongside each row. Sessions tmux knows about but we don't (user
// fired `tmux new` from a host shell) render as "orphan".
//
// File format is a flat JSON object so concurrent writes from
// different agents don't merge-conflict — the writer reads, mutates,
// writes back. A small lockfile would be cleaner but the call rate
// is low (a few writes per workday) and last-writer-wins on a single-
// host setup is acceptable.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { SOMORA_HOME_DIR } from '../server/logger.ts';

const STORE_PATH = join(SOMORA_HOME_DIR, 'tmux-origins.json');

export type TmuxSessionKind = 'shell' | 'claude-code' | 'codex' | 'opencode';

export interface TmuxOrigin {
  /** Tmux session name (the key, redundant here for ergonomics). */
  name: string;
  /** somora agent that ran the `tmux create` action. */
  agent: string;
  /** somora session-id of the chat from which the create was issued.
   *  Optional because MCP children don't always carry SOMORA_SESSION. */
  session?: string;
  /** A coding agent declared at create (claude, codex, opencode, pi, …;
   *  older records say claude-code). Only a fallback: the agent in a
   *  pane is recognised by its process (detection/identify.ts). */
  kind?: string;
  /** The SSH resource the session lives on; absent = local. */
  target?: string;
  /** Per-create opt-out for the attention watcher (create with
   *  `attention: false`). Missing = attention enabled (the default). */
  attention?: boolean;
  /** ISO timestamp of when the origin was recorded. */
  createdAt: string;
}

type Store = Record<string, TmuxOrigin>;

function ensureDir(): void {
  const d = dirname(STORE_PATH);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function read(): Store {
  if (!existsSync(STORE_PATH)) return {};
  try {
    const raw = readFileSync(STORE_PATH, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw) as Store;
  } catch {
    // Corrupt file — start fresh, don't crash the tool. Operator can
    // diagnose via the file mtime if it ever happens.
    return {};
  }
}

function write(s: Store): void {
  ensureDir();
  writeFileSync(STORE_PATH, JSON.stringify(s, null, 2), 'utf8');
}

/** The store key: the session name for a local session (as always),
 *  `@<target>/<name>` for one on an SSH resource — a name is only
 *  unique per host. */
export function originKey(target: string | undefined, name: string): string {
  return !target || target === 'local' ? name : `@${target}/${name}`;
}

export function recordTmuxOrigin(args: {
  name: string;
  target?: string;
  agent: string;
  session?: string;
  kind?: string;
  attention?: boolean;
}): void {
  const store = read();
  const remote = args.target && args.target !== 'local' ? args.target : undefined;
  store[originKey(remote, args.name)] = {
    name: args.name,
    ...(remote ? { target: remote } : {}),
    agent: args.agent,
    ...(args.session ? { session: args.session } : {}),
    ...(args.kind ? { kind: args.kind } : {}),
    ...(args.attention === false ? { attention: false } : {}),
    createdAt: new Date().toISOString(),
  };
  write(store);
}

export function removeTmuxOrigin(name: string, target?: string): void {
  const store = read();
  const key = originKey(target, name);
  if (store[key]) {
    delete store[key];
    write(store);
  }
}

export function getTmuxOrigin(name: string, target?: string): TmuxOrigin | undefined {
  return read()[originKey(target, name)];
}

/** Every origin; `local` only the sessions on the somora host (the web
 *  tmux list), `remote` only those on SSH resources. */
export function listTmuxOrigins(where: 'all' | 'local' | 'remote' = 'all'): TmuxOrigin[] {
  return Object.values(read()).filter((o) => where === 'all' || (where === 'local' ? !o.target : !!o.target));
}
