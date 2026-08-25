// Shared-login credential sync between the user's interactive Claude
// Code (`~/.claude/.credentials.json`) and somora's isolated config
// tree (`$CLAUDE_CONFIG_DIR/.credentials.json`).
//
// Why content-sync and not a symlink
//   The original design symlinked the somora-side file to the user
//   file, so both CLIs would share one credential store. But the
//   claude CLI persists token refreshes with an ATOMIC WRITE (tmp file
//   + rename), and rename replaces the directory entry — the symlink
//   itself is destroyed and materializes into a real file on the first
//   refresh. From then on both sides rotate the same OAuth session
//   independently and whichever chain refreshes later invalidates the
//   other (2026-07-24/25 feedback reports: daily re-logins). A symlink
//   is structurally impossible to keep alive against rename-based
//   writers, so the invariant moved from "one file" to "same content,
//   continuously reconciled":
//
//     - watcher on BOTH parent directories (rename swaps the inode, so
//       watching the file itself goes blind after the first refresh)
//     - fallback poll every 60s
//     - pre-turn reconcile in the claude-cli engine adapter
//     - reconcile on auth-failure (existing since v2026.07.21.01)
//
//   On divergence the file with the LATER OAuth `expiresAt` wins (its
//   refresh happened last, so its refresh-token chain is the live one)
//   and is copied over the loser — atomic write, mode 0600, previous
//   content kept once at `<path>.somora-prev`. mtime is only the
//   tie-breaker when a side doesn't parse.
//
// This module is logger-free by design: the somora server injects pino
// via configureClaudeCredentialSync(); the `somora auth` CLI uses it
// without booting the logging stack.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type CredentialSyncResult =
  | 'noop' // identical content, standalone install, or feature disabled
  | 'pulled' // user file (~/.claude) won — copied onto the somora side
  | 'pushed' // somora file won — copied back into ~/.claude
  | 'unavailable'; // reconcile attempted but failed (see log)

type LogFn = (data: Record<string, unknown>) => void;
type LogSink = { info: LogFn; warn: LogFn };

let enabled = false;
let log: LogSink = { info: () => {}, warn: () => {} };
let lastResult: CredentialSyncResult | null = null;
let lastAt: number | null = null;

/** Called once at server boot (or CLI entry) with
 *  `config.claudeCli.sharedUserCredentials` and a log sink. */
export function configureClaudeCredentialSync(opts: {
  enabled: boolean;
  log?: LogSink;
}): void {
  enabled = opts.enabled;
  if (opts.log) log = opts.log;
}

export function userCredentialPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

export function somoraCredentialPath(): string {
  const dir =
    process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.length > 0
      ? process.env.CLAUDE_CONFIG_DIR
      : join(process.env.SOMORA_HOME ?? join(homedir(), '.somora'), 'claude-home');
  return join(dir, '.credentials.json');
}

/** OAuth expiry (ms epoch) parsed from a credentials file, or null when
 *  the file is missing/unparseable (e.g. the nulled-file corruption seen
 *  in the Lucy incident 2026-07-23). */
function parseExpiresAt(content: string | null): number | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as {
      claudeAiOauth?: { expiresAt?: unknown };
    };
    const v = parsed.claudeAiOauth?.expiresAt;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Atomic overwrite mirroring the CLI's own update pattern (tmp +
 *  rename in the same dir), preserving the previous content once at
 *  `<path>.somora-prev` — a single rotating backup instead of the
 *  timestamped-file accumulation the old reconciler produced. */
function overwriteWithBackup(path: string, content: string): void {
  if (existsSync(path)) {
    renameSync(path, `${path}.somora-prev`);
  }
  const tmp = `${path}.somora-tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

export interface CredentialPairStatus {
  enabled: boolean;
  userPath: string;
  somoraPath: string;
  userExists: boolean;
  somoraExists: boolean;
  somoraIsSymlink: boolean;
  identical: boolean;
  userExpiresAt: number | null;
  somoraExpiresAt: number | null;
  userMtimeMs: number | null;
  somoraMtimeMs: number | null;
  lastSyncResult: CredentialSyncResult | null;
  lastSyncAt: number | null;
}

/** Read-only snapshot for /health and `somora auth status`. Never
 *  exposes token material — only existence, expiry, and divergence. */
export function credentialSyncStatus(): CredentialPairStatus {
  const userPath = userCredentialPath();
  const somoraPath = somoraCredentialPath();
  const userContent = readIfExists(userPath);
  const somoraContent = readIfExists(somoraPath);
  let somoraIsSymlink = false;
  try {
    somoraIsSymlink = lstatSync(somoraPath).isSymbolicLink();
  } catch {
    /* missing */
  }
  const mtime = (p: string): number | null => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  };
  return {
    enabled,
    userPath,
    somoraPath,
    userExists: userContent !== null,
    somoraExists: somoraContent !== null,
    somoraIsSymlink,
    identical: userContent !== null && userContent === somoraContent,
    userExpiresAt: parseExpiresAt(userContent),
    somoraExpiresAt: parseExpiresAt(somoraContent),
    userMtimeMs: mtime(userPath),
    somoraMtimeMs: mtime(somoraPath),
    lastSyncResult: lastResult,
    lastSyncAt: lastAt,
  };
}

/** Expiry (ms epoch) of a specific top-level credential key, or null. */
function keyExpiresAt(obj: Record<string, unknown>, key: string): number | null {
  const entry = obj[key];
  if (entry === null || typeof entry !== 'object') return null;
  const v = (entry as { expiresAt?: unknown }).expiresAt;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Merge two credential files preserving foreign top-level keys (anything
 * other than `claudeAiOauth` — e.g. `designOauth`). Returns the merged
 * JSON string, or NULL when neither side carries a foreign key (the
 * common case → caller keeps the original whole-file-overwrite path with
 * its tested behavior). Base is the claudeAiOauth winner; each foreign
 * key resolves to the copy with the later `expiresAt` (present-side wins
 * when only one has it, later-expiry wins when both do).
 */
/**
 * Returns the content each side should hold, or null when there are no
 * foreign keys (classic overwrite path applies).
 *
 * - `somora`: the winning claudeAiOauth + EVERY foreign key, newest
 *   expiry per key — somora's file is the superset.
 * - `user`: the winning claudeAiOauth + only the foreign keys ~/.claude
 *   ALREADY had (refreshed to the newest copy). Foreign keys are never
 *   ADDED to the user's file: the Claude CLI's own `/login` runs a
 *   logout first that revokes every refresh token it finds there —
 *   including a `designOauth` that somora had leaked in (2026-08-25,
 *   killed the Design grant 4 min after the user's `/login`).
 */
export function mergeForeignCredentialKeys(
  userContent: string,
  somoraContent: string,
  userWins: boolean,
): { somora: string; user: string } | null {
  let user: Record<string, unknown>;
  let somora: Record<string, unknown>;
  try {
    user = JSON.parse(userContent) as Record<string, unknown>;
    somora = JSON.parse(somoraContent) as Record<string, unknown>;
  } catch {
    // A side doesn't parse → no safe merge; fall back to overwrite path.
    return null;
  }
  const foreignKeys = new Set<string>();
  for (const k of [...Object.keys(user), ...Object.keys(somora)]) {
    if (k !== 'claudeAiOauth') foreignKeys.add(k);
  }
  if (foreignKeys.size === 0) return null;

  const winner = userWins ? user : somora;
  const merged: Record<string, unknown> = { ...winner };
  for (const key of foreignKeys) {
    const inUser = key in user;
    const inSomora = key in somora;
    if (inUser && inSomora) {
      const ue = keyExpiresAt(user, key);
      const se = keyExpiresAt(somora, key);
      // Later expiry wins; if equal/unknown, keep the claudeAiOauth
      // winner's copy (already in `merged` when winner has the key).
      if (ue !== null && se !== null) {
        merged[key] = ue >= se ? user[key] : somora[key];
      } else if (se !== null && ue === null) {
        merged[key] = somora[key];
      } else if (ue !== null && se === null) {
        merged[key] = user[key];
      } else {
        merged[key] = winner[key] ?? user[key] ?? somora[key];
      }
    } else if (inUser) {
      merged[key] = user[key];
    } else {
      merged[key] = somora[key];
    }
  }
  const userSide: Record<string, unknown> = { claudeAiOauth: merged.claudeAiOauth };
  for (const key of foreignKeys) {
    if (key in user) userSide[key] = merged[key];
  }
  return {
    somora: `${JSON.stringify(merged, null, 2)}\n`,
    user: `${JSON.stringify(userSide, null, 2)}\n`,
  };
}

/** Core reconcile with explicit paths — pure enough for unit tests.
 *  `user` is the interactive CLI's file (~/.claude), `somora` is the
 *  isolated-config-dir file. Returns what happened. */
export function reconcileCredentialPair(userPath: string, somoraPath: string): CredentialSyncResult {
  const userContent = readIfExists(userPath);
  const somoraContent = readIfExists(somoraPath);

  if (userContent === null && somoraContent === null) return 'noop';
  if (userContent === null) {
    // Standalone install: the user never ran `claude login` at the
    // user level. The somora-side file is the single source of truth —
    // don't invent files in ~/.claude.
    return 'noop';
  }
  if (somoraContent === null) {
    // Fresh somora install (or somora side deleted): bootstrap from
    // the user's login.
    mkdirSync(dirname(somoraPath), { recursive: true });
    overwriteWithBackup(somoraPath, userContent);
    log.info({ msg: 'claude_credentials.sync_pulled', reason: 'somora_side_missing' });
    return 'pulled';
  }
  if (userContent === somoraContent) return 'noop';

  // Diverged. The side whose OAuth session was refreshed LAST holds the
  // live refresh-token chain — its `expiresAt` is later. A side that
  // doesn't parse (corrupt/nulled file) always loses. mtime is the
  // final tie-breaker.
  const userExp = parseExpiresAt(userContent);
  const somoraExp = parseExpiresAt(somoraContent);
  let userWins: boolean;
  if (userExp !== null && somoraExp !== null) {
    if (userExp === somoraExp) {
      userWins = statSync(userPath).mtimeMs >= statSync(somoraPath).mtimeMs;
    } else {
      userWins = userExp > somoraExp;
    }
  } else if (userExp !== null) {
    userWins = true;
  } else if (somoraExp !== null) {
    userWins = false;
  } else {
    userWins = statSync(userPath).mtimeMs >= statSync(somoraPath).mtimeMs;
  }

  // Foreign top-level keys — anything other than the primary
  // `claudeAiOauth` login, e.g. the `designOauth` credential written by
  // `/design-login`, or `mcpOAuth` from per-server MCP auth. The
  // whole-file overwrite below would silently drop a foreign key that
  // exists on only ONE side (the classic case: user runs /design-login
  // on the somora side, then a routine claudeAiOauth refresh on the
  // ~/.claude side "wins" and clobbers designOauth). Merge them across
  // both sides — newest-expiry-wins per key — and write the SAME merged
  // content to both files so they converge and the next tick is a noop.
  const merged = mergeForeignCredentialKeys(userContent, somoraContent, userWins);
  if (merged !== null) {
    // Each side gets its own target; write only what actually changed so
    // the pair converges and the next tick is a noop even though the two
    // files legitimately differ (somora carries keys ~/.claude must not).
    const wroteSomora = merged.somora !== somoraContent;
    const wroteUser = merged.user !== userContent;
    if (wroteSomora) overwriteWithBackup(somoraPath, merged.somora);
    if (wroteUser) overwriteWithBackup(userPath, merged.user);
    if (!wroteSomora && !wroteUser) return 'noop';
    log.info({
      msg: 'claude_credentials.sync_merged',
      reason: 'foreign_keys_preserved',
      userExpiresAt: userExp,
      somoraExpiresAt: somoraExp,
      wroteSomora,
      wroteUser,
      hint: 'designOauth / other non-primary credentials kept on the somora side; never added to ~/.claude',
    });
    return userWins ? 'pulled' : 'pushed';
  }

  if (userWins) {
    overwriteWithBackup(somoraPath, userContent);
    log.info({
      msg: 'claude_credentials.sync_pulled',
      reason: 'user_side_newer',
      userExpiresAt: userExp,
      somoraExpiresAt: somoraExp,
    });
    return 'pulled';
  }
  overwriteWithBackup(userPath, somoraContent);
  log.info({
    msg: 'claude_credentials.sync_pushed',
    reason: 'somora_side_newer',
    userExpiresAt: userExp,
    somoraExpiresAt: somoraExp,
    hint: 'somora-side token refresh propagated back to ~/.claude so the interactive CLI stays logged in',
  });
  return 'pushed';
}

/** Config-gated reconcile on the canonical pair. Called at boot, from
 *  the watcher/poll, pre-turn in the claude-cli adapter, and on auth
 *  failures. Cheap when healthy: two reads + compare on ~500-byte
 *  files. */
export function reconcileClaudeCredentials(): CredentialSyncResult {
  if (!enabled) return 'noop';
  try {
    const result = reconcileCredentialPair(userCredentialPath(), somoraCredentialPath());
    lastResult = result;
    lastAt = Date.now();
    return result;
  } catch (err) {
    log.warn({
      msg: 'claude_credentials.sync_failed',
      err: String(err),
      hint: 'credential drift could not be auto-healed; check file permissions on ~/.claude and $CLAUDE_CONFIG_DIR, or run `somora auth status`',
    });
    lastResult = 'unavailable';
    lastAt = Date.now();
    return 'unavailable';
  }
}

// ---------------------------------------------------------------------------
// Runtime watcher — the piece the boot-only reconciler was missing.
// fs.watch on both PARENT DIRECTORIES (the file inode is replaced on
// every refresh, so a file watch goes stale immediately), debounced
// into a single reconcile pass. A 60s fallback poll covers editors/
// filesystems where rename events get lost, and picks up a ~/.claude
// that didn't exist at boot. Self-triggering is safe: our own sync
// writes fire the watcher again, the follow-up reconcile sees
// identical content and no-ops — convergence, not a loop.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 750;
const POLL_INTERVAL_MS = 60_000;

let watchers: FSWatcher[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function startClaudeCredentialSyncWatcher(): void {
  if (!enabled) return;
  stopClaudeCredentialSyncWatcher();

  const schedule = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reconcileClaudeCredentials();
    }, DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  for (const dir of [dirname(userCredentialPath()), dirname(somoraCredentialPath())]) {
    try {
      const w = watch(dir, { persistent: false }, (_event, filename) => {
        // filename can be null on some platforms — reconcile anyway,
        // it's cheap and idempotent.
        if (filename && !String(filename).startsWith('.credentials.json')) return;
        schedule();
      });
      w.on('error', () => {
        /* dir vanished — poll still covers us */
      });
      watchers.push(w);
    } catch {
      // Directory missing (e.g. user never ran `claude login`). The
      // poll below picks it up once it exists.
    }
  }

  pollTimer = setInterval(() => reconcileClaudeCredentials(), POLL_INTERVAL_MS);
  pollTimer.unref?.();
  log.info({
    msg: 'claude_credentials.watcher_started',
    dirs: [dirname(userCredentialPath()), dirname(somoraCredentialPath())],
    pollMs: POLL_INTERVAL_MS,
  });
}

export function stopClaudeCredentialSyncWatcher(): void {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      /* already closed */
    }
  }
  watchers = [];
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}
