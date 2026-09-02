// Remote-target implementations for file_* tools — `target=<resource>`
// path. SFTP for read/write/patch (binary-clean, no shell-quoting hell),
// remote-exec'd ripgrep for search.

import { posix } from 'node:path';
import type { Client, SFTPWrapper, Stats } from 'ssh2';
import type { SshResource } from '../../config/types.ts';
import { logger } from '../../server/logger.ts';
import { expandRemotePath, getConnection, getResourceHome, remoteExec } from '../../ssh/index.ts';
import type { ListEntry, ListResult, ReadResult, SearchResult, SearchHit, WriteResult, PatchResult } from './local.ts';
import { checkRemoteReadAllowed } from './policy.ts';
import { applyTextBudget, windowMatchLine, type RgSubmatch } from './search-window.ts';

const READ_HARD_CAP = 200_000;

/** Per-call unique remote tmp filename — same reasoning as local.ts'
 *  uniqueTmpPath. Two parallel writes to the same remote path used to
 *  share the fixed `.somora-tmp` and race on rename. */
function uniqueRemoteTmp(remotePath: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${remotePath}.somora-tmp.${process.pid}.${ts}.${rand}`;
}

/**
 * Resolve a remote path to an absolute server path. SFTP does NOT
 * expand `~` (unlike a login shell), so we resolve the SSH user's
 * home via `realpath('.')` once per connection (cached) and join
 * relative inputs onto it. Same goes for `resource.workspace` if it's
 * tilde-prefixed. Posix-only — remote is assumed unix-y.
 *
 * Path resolution order:
 *  1. Absolute (`/foo/bar`) — normalize and return.
 *  2. Tilde-prefixed (`~`, `~/foo`) — expand against SSH user's home.
 *     Tilde overrides workspace; the user explicitly asked for $HOME.
 *  3. Bare relative + workspace set — join onto resolved workspace.
 *  4. Bare relative, no workspace — join onto SSH user's home.
 *
 * Bug history:
 *  - 2026-05-06: returned literal `~/_selftest/foo` for relative paths
 *    when no workspace was set; SFTP treated `~` as a real directory.
 *    Fixed by routing through expandRemotePath.
 *  - 2026-05-09 (Hans Bug 5): when BOTH workspace was set AND user
 *    passed a `~/foo` path, the join produced `<workspace>/~/foo`
 *    (literal `~` dir under workspace) for file_write/file_patch.
 *    Fixed by branching on tilde BEFORE the workspace branch.
 */
async function resolveRemotePath(
  rawPath: string,
  resourceName: string,
  resource: SshResource,
): Promise<string> {
  if (posix.isAbsolute(rawPath)) return posix.normalize(rawPath);
  if (rawPath === '~' || rawPath.startsWith('~/')) {
    return expandRemotePath(resourceName, resource, rawPath);
  }
  if (resource.workspace) {
    const workspaceAbs = await expandRemotePath(resourceName, resource, resource.workspace);
    return posix.normalize(posix.join(workspaceAbs, rawPath));
  }
  return expandRemotePath(resourceName, resource, rawPath);
}

async function withSftp<T>(client: Client, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, s) => (err ? reject(err) : resolve(s)));
  });
  try {
    return await fn(sftp);
  } finally {
    sftp.end();
  }
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, data: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (err) => (err ? reject(err) : resolve()));
  });
}

/** The subset of ssh2's SFTPWrapper that renameOverwrite needs — kept
 *  minimal so a unit test can pass a recording stub. */
export interface SftpRenameOps {
  rename(from: string, to: string, cb: (err?: Error | null) => void): void;
  unlink(path: string, cb: (err?: Error | null) => void): void;
  /** OpenSSH `posix-rename@openssh.com`. Optional: older ssh2 builds
   *  lack the method; ssh2 also throws SYNCHRONOUSLY ("Server does not
   *  support this extended request") when the server did not advertise
   *  the extension. */
  ext_openssh_rename?(from: string, to: string, cb: (err?: Error | null) => void): void;
}

export interface RenameContext {
  /** Tool name for the error message, e.g. 'file_write'. */
  op: string;
  /** Resource name for the error message. */
  resource: string;
}

/** ssh2 maps SSH_FX_FAILURE to the bare message 'Failure' (and code 4).
 *  OpenSSH's sftp-server answers that for SSH_FXP_RENAME when the target
 *  already exists. */
function isSftpFailure(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === 4 || /^Failure\b/.test(String(e?.message ?? err));
}

/** SSH_FX_NO_SUCH_FILE — ssh2 message 'No such file or directory', code 2. */
function isSftpNoSuchFile(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === 2 || /No such file/i.test(String(e?.message ?? err));
}

function isExtensionUnsupported(err: unknown): boolean {
  return /does not support|unsupported|not supported/i.test(String((err as Error)?.message ?? err));
}

function cbToPromise(run: (cb: (err?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      run((err) => (err ? reject(err) : resolve()));
    } catch (err) {
      // ssh2's ext_* methods throw synchronously when unsupported.
      reject(err);
    }
  });
}

/**
 * Rename `from` onto `to`, replacing `to` if it exists.
 *
 * Plain SSH_FXP_RENAME (SFTP v3, what ssh2 speaks) is *not* allowed to
 * overwrite: OpenSSH's sftp-server replies SSH_FX_FAILURE when the
 * target exists, which ssh2 surfaces as a bare `Error: Failure`. That
 * meant every tmp-file → rename write path here could create files on
 * an SSH resource but never modify them (verified live 2026-09-01).
 *
 * Strategy:
 *   1. `posix-rename@openssh.com` (ssh2: `ext_openssh_rename`) — atomic
 *      replace with POSIX semantics. Preferred whenever available.
 *   2. Extension missing / server does not support it / it answers
 *      Failure → `unlink(to)` (ENOENT ignored) then plain `rename`.
 *      Non-atomic for an instant, but correct.
 *   3. Plain rename answering Failure with no extension → same fallback.
 *
 * On final failure the error is rewritten to name the op, resource, both
 * paths and a hint — never a bare 'Failure'. `from` (the tmp file) is
 * removed best-effort, EXCEPT when we already unlinked the target: then
 * the tmp file is the only remaining copy of the content and is kept,
 * and the message says so.
 */
export async function renameOverwrite(
  sftp: SftpRenameOps,
  from: string,
  to: string,
  ctx: RenameContext = { op: 'sftp', resource: 'remote' },
): Promise<void> {
  const plainRename = () => cbToPromise((cb) => sftp.rename(from, to, cb));
  const unlinkTarget = async (): Promise<boolean> => {
    try {
      await cbToPromise((cb) => sftp.unlink(to, cb));
      return true;
    } catch (err) {
      if (isSftpNoSuchFile(err)) return false;
      throw err;
    }
  };

  let lastErr: unknown;
  let hint: string;
  let targetUnlinked = false;

  // Step 1: OpenSSH posix-rename extension.
  if (typeof sftp.ext_openssh_rename === 'function') {
    try {
      await cbToPromise((cb) => sftp.ext_openssh_rename!(from, to, cb));
      return;
    } catch (err) {
      lastErr = err;
      if (!isExtensionUnsupported(err) && !isSftpFailure(err)) {
        // A real error (permission denied, no such directory …) — the
        // fallback would not fare better and might unlink the target
        // for nothing.
        hint = 'posix-rename@openssh.com failed';
        await cleanupTmp(sftp, from);
        throw enrich(ctx, from, to, err, hint);
      }
      logger.debug({
        msg: 'tool.file.sftp_rename.ext_fallback',
        resource: ctx.resource,
        to,
        err: String((err as Error)?.message ?? err),
      });
    }
  } else {
    // Step 3: plain rename first — it works when the target is absent.
    try {
      await plainRename();
      return;
    } catch (err) {
      lastErr = err;
      if (!isSftpFailure(err)) {
        await cleanupTmp(sftp, from);
        throw enrich(ctx, from, to, err, 'rename failed');
      }
    }
  }

  // Step 2: unlink target, then plain rename.
  try {
    targetUnlinked = await unlinkTarget();
    await plainRename();
    return;
  } catch (err) {
    lastErr = err;
  }

  if (targetUnlinked) {
    hint =
      `target was removed but the rename still failed — the new content is left in '${from}' ` +
      `and the server lacks posix-rename@openssh.com`;
    throw enrich(ctx, from, to, lastErr, hint);
  }
  hint = isSftpFailure(lastErr)
    ? 'target may exist and the server lacks posix-rename@openssh.com'
    : 'target could not be replaced and the server lacks posix-rename@openssh.com';
  await cleanupTmp(sftp, from);
  throw enrich(ctx, from, to, lastErr, hint);
}

function enrich(ctx: RenameContext, from: string, to: string, err: unknown, hint: string): Error {
  const reason = String((err as Error)?.message ?? err).trim() || 'unknown error';
  const out = new Error(
    `${ctx.op} on '${ctx.resource}': SFTP rename of '${from}' onto '${to}' refused (${reason}) — ${hint}`,
  );
  (out as Error & { cause?: unknown }).cause = err;
  return out;
}

async function cleanupTmp(sftp: SftpRenameOps, tmp: string): Promise<void> {
  try {
    await cbToPromise((cb) => sftp.unlink(tmp, cb));
  } catch {
    // best-effort — a stray .somora-tmp file is better than masking the real error
  }
}

function sftpRename(
  sftp: SFTPWrapper,
  from: string,
  to: string,
  ctx: RenameContext,
): Promise<void> {
  return renameOverwrite(sftp as unknown as SftpRenameOps, from, to, ctx);
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats | null> {
  return new Promise((resolve) => {
    sftp.stat(path, (err, stats) => (err ? resolve(null) : resolve(stats)));
  });
}

function sftpMkdirP(sftp: SFTPWrapper, path: string): Promise<void> {
  // SFTP doesn't have recursive mkdir built in — walk components.
  return new Promise(async (resolve, reject) => {
    const parts = path.split('/').filter(Boolean);
    let acc = path.startsWith('/') ? '' : '.';
    for (const part of parts) {
      acc = acc === '' ? `/${part}` : posix.join(acc, part);
      const stats = await new Promise<Stats | null>((res) => {
        sftp.stat(acc, (err, s) => (err ? res(null) : res(s)));
      });
      if (stats) continue; // already exists
      await new Promise<void>((res, rej) => {
        sftp.mkdir(acc, (err) => (err ? rej(err) : res()));
      }).catch((err) => {
        // Idempotent: if another caller created it between stat+mkdir, ignore.
        if (!String(err).includes('Failure')) reject(err);
      });
    }
    resolve();
  });
}

export async function remoteRead(args: {
  resourceName: string;
  resource: SshResource;
  path: string;
  offset?: number;
  limit?: number;
}): Promise<ReadResult> {
  const client = await getConnection(args.resourceName, args.resource);
  const remotePath = await resolveRemotePath(args.path, args.resourceName, args.resource);
  // Read-blacklist against the REMOTE home — same protection localRead
  // applies, which the remote path skipped entirely before the
  // Juni-Audit 2026-06 fix (see checkRemoteReadAllowed).
  const remoteHome = await getResourceHome(args.resourceName, args.resource);
  const policy = checkRemoteReadAllowed(remotePath, remoteHome);
  if (!policy.ok) throw new Error(policy.reason);
  const buf = await withSftp(client, (sftp) => sftpReadFile(sftp, remotePath));
  const all = buf.toString('utf8');
  const lines = all.split('\n');
  const offset = Math.max(0, args.offset ?? 0);
  const limit = args.limit ?? lines.length;
  const slice = lines.slice(offset, offset + limit);
  let content = slice.join('\n');
  let truncated = offset + slice.length < lines.length;
  let truncatedReason = truncated ? `more lines available (offset=${offset + slice.length})` : undefined;
  if (content.length > READ_HARD_CAP) {
    content = content.slice(0, READ_HARD_CAP) + '\n[…content truncated at 200k chars]';
    truncated = true;
    truncatedReason = `byte cap (${READ_HARD_CAP} chars)`;
  }
  return {
    path: remotePath,
    workspace_relative: null, // remote workspace not tracked the same way
    bytes: buf.length,
    lines: lines.length,
    content,
    truncated,
    ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
  };
}

export async function remoteWrite(args: {
  resourceName: string;
  resource: SshResource;
  path: string;
  content: string;
  mode: 'create' | 'overwrite' | 'append';
}): Promise<WriteResult> {
  const client = await getConnection(args.resourceName, args.resource);
  const remotePath = await resolveRemotePath(args.path, args.resourceName, args.resource);
  const parent = posix.dirname(remotePath);

  await withSftp(client, async (sftp) => {
    if (parent && parent !== '/' && parent !== '.') {
      await sftpMkdirP(sftp, parent);
    }
    const exists = (await sftpStat(sftp, remotePath)) !== null;
    if (args.mode === 'create' && exists) {
      throw new Error(`file_write: '${args.path}' already exists on '${args.resourceName}'`);
    }
    if (args.mode === 'append' && exists) {
      const existing = (await sftpReadFile(sftp, remotePath)).toString('utf8');
      const sep = existing.endsWith('\n') ? '' : '\n';
      // Atomic via tmp+rename. Per-call unique tmp suffix — parallel
      // writes to the same remote path would otherwise share the fixed
      // `.somora-tmp` and one rename would race the other to ENOENT.
      // Audit 2026-05-16.
      const tmp = uniqueRemoteTmp(remotePath);
      await sftpWriteFile(sftp, tmp, existing + sep + args.content);
      await sftpRename(sftp, tmp, remotePath, { op: 'file_write', resource: args.resourceName });
    } else {
      const tmp = uniqueRemoteTmp(remotePath);
      await sftpWriteFile(sftp, tmp, args.content);
      await sftpRename(sftp, tmp, remotePath, { op: 'file_write', resource: args.resourceName });
    }
  });

  const finalStats = await withSftp(client, (sftp) => sftpStat(sftp, remotePath));
  logger.info({
    msg: 'tool.file_write.remote',
    resource: args.resourceName,
    path: remotePath,
    mode: args.mode,
    bytes: finalStats?.size ?? 0,
  });
  return {
    path: remotePath,
    workspace_relative: null,
    mode: args.mode,
    bytes: finalStats?.size ?? 0,
  };
}

export async function remotePatch(args: {
  resourceName: string;
  resource: SshResource;
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}): Promise<PatchResult> {
  const client = await getConnection(args.resourceName, args.resource);
  const remotePath = await resolveRemotePath(args.path, args.resourceName, args.resource);

  return withSftp(client, async (sftp) => {
    const stats = await sftpStat(sftp, remotePath);
    if (!stats) throw new Error(`file_patch: '${args.path}' does not exist on '${args.resourceName}'`);
    const original = (await sftpReadFile(sftp, remotePath)).toString('utf8');
    if (!original.includes(args.oldString)) {
      throw new Error(`file_patch: 'old_string' not found in '${args.path}' on '${args.resourceName}'`);
    }
    let updated: string;
    let count: number;
    if (args.replaceAll) {
      count = original.split(args.oldString).length - 1;
      updated = original.split(args.oldString).join(args.newString);
    } else {
      const occurrences = original.split(args.oldString).length - 1;
      if (occurrences > 1) {
        throw new Error(
          `file_patch: 'old_string' appears ${occurrences} times in '${args.path}'. ` +
            'Add context for uniqueness or pass replace_all=true.',
        );
      }
      updated = original.replace(args.oldString, args.newString);
      count = 1;
    }
    const tmp = uniqueRemoteTmp(remotePath);
    await sftpWriteFile(sftp, tmp, updated);
    await sftpRename(sftp, tmp, remotePath, { op: 'file_patch', resource: args.resourceName });
    const newStats = await sftpStat(sftp, remotePath);
    return { path: remotePath, replacements: count, bytes: newStats?.size ?? 0 };
  });
}

/**
 * Remote search via SSH-exec'd ripgrep. SFTP has no content-search
 * primitive so we route through exec. JSON output for stable parsing
 * regardless of locale.
 */
export async function remoteSearch(args: {
  resourceName: string;
  resource: SshResource;
  pattern: string;
  path?: string;
  limit?: number;
}): Promise<SearchResult> {
  const client = await getConnection(args.resourceName, args.resource);
  const limit = args.limit ?? 50;
  // file_search routes through ssh-exec'd ripgrep, which runs in a
  // login shell — that one DOES expand `~`. So passing
  // `resource.workspace ?? '.'` literal is fine here even with a
  // tilde, no SFTP-resolution needed. Only relative path-args go
  // through resolveRemotePath for absolute disambiguation.
  const remotePath = args.path
    ? await resolveRemotePath(args.path, args.resourceName, args.resource)
    : (args.resource.workspace ?? '.');
  // Block searching inside remote credential stores — file_search reads
  // and returns file contents (match lines), so it's a read path. Only
  // the model-supplied explicit path is checked; the workspace default
  // is operator-configured. The path is already SFTP-resolved to an
  // absolute when args.path is set. (Juni-Audit 2026-06.)
  if (args.path) {
    const remoteHome = await getResourceHome(args.resourceName, args.resource);
    const policy = checkRemoteReadAllowed(remotePath, remoteHome);
    if (!policy.ok) throw new Error(policy.reason);
  }
  const cmd = `rg --json --max-count ${limit} --no-messages ${shQ(args.pattern)} ${shQ(remotePath)}`;
  const result = await remoteExec(client, cmd, { timeoutMs: 30_000 });
  if (result.code !== 0 && result.stdout === '') {
    // rg returns 1 when no matches — empty hits, not an error.
    if (result.code === 1) {
      return { count: 0, truncated: false, hits: [] };
    }
    // 127 = command not found
    if (result.code === 127 || result.stderr.includes('command not found') || result.stderr.includes('No such file')) {
      throw new Error(
        `file_search on '${args.resourceName}': ripgrep (rg) not installed. ` +
          `Install via the remote's package manager — e.g. ` +
          `'brew install ripgrep' (macOS), ` +
          `'apt install ripgrep' (Debian/Ubuntu), ` +
          `'dnf install ripgrep' (Fedora/RHEL), or ` +
          `'pacman -S ripgrep' (Arch).`,
      );
    }
    throw new Error(`file_search on '${args.resourceName}': rg exited ${result.code}: ${result.stderr.slice(0, 300)}`);
  }
  const hits: SearchHit[] = [];
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as {
        type: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
          submatches?: RgSubmatch[];
        };
      };
      if (ev.type === 'match' && ev.data) {
        const win = windowMatchLine(ev.data.lines?.text ?? '', ev.data.submatches);
        hits.push({
          path: ev.data.path?.text ?? '',
          line: ev.data.line_number ?? 0,
          text: win.text,
          col: win.col,
          ...(win.truncated ? { truncated: true } : {}),
        });
        if (hits.length >= limit) break;
      }
    } catch {
      // skip malformed
    }
  }
  const budgeted = applyTextBudget(hits);
  return {
    count: budgeted.hits.length,
    truncated: result.truncated || hits.length >= limit || budgeted.truncated,
    hits: budgeted.hits,
  };
}

/** Single-quote a value for sh — escape any embedded single quotes. */
function shQ(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ─────────────────────────────────────────────────────────────────────
// remoteList — file_list over SFTP
// ─────────────────────────────────────────────────────────────────────

const REMOTE_LIST_HARD_CAP = 5_000;

export async function remoteList(args: {
  resourceName: string;
  resource: SshResource;
  path: string;
  recursive?: boolean;
  sortBy?: 'mtime' | 'name' | 'size';
  limit?: number;
  glob?: string;
}): Promise<ListResult> {
  const fullPath = await resolveRemotePath(args.path, args.resourceName, args.resource);
  // Block listing inside remote credential stores — directory listings
  // of ~/.ssh etc. leak key filenames; the local list path enforces the
  // same. (Juni-Audit 2026-06.)
  const remoteHome = await getResourceHome(args.resourceName, args.resource);
  const listPolicy = checkRemoteReadAllowed(fullPath, remoteHome);
  if (!listPolicy.ok) throw new Error(listPolicy.reason);
  const conn = await getConnection(args.resourceName, args.resource);
  const recursive = Boolean(args.recursive);
  const matchGlob = args.glob ? compileGlob(args.glob) : null;
  const sortBy = args.sortBy ?? 'name';
  const limit = Math.min(args.limit ?? 200, REMOTE_LIST_HARD_CAP);

  const collected: ListEntry[] = [];
  await withSftp(conn, async (sftp) => {
    // Resolve `~` once on the server so we have an absolute root for
    // workspace-relative output. SFTP's realpath does this server-side.
    const realRoot = await new Promise<string>((res, rej) => {
      sftp.realpath(fullPath, (err, p) => (err ? rej(err) : res(p)));
    });
    await walkSftp(sftp, realRoot, realRoot, recursive, collected, matchGlob);
  });

  collected.sort((a, b) => {
    if (sortBy === 'mtime') return b.mtime - a.mtime;
    if (sortBy === 'size') return b.size - a.size;
    return a.path.localeCompare(b.path);
  });

  const truncated = collected.length > limit;
  const entries = collected.slice(0, limit);

  return {
    root: fullPath,
    count: entries.length,
    truncated,
    entries,
  };
}

/**
 * Compiled glob — keeps the original-string `hasSlash` flag alongside
 * the RegExp because the regex source itself is unreliable for that
 * check (the compiled `[^/]*` always contains `/`). hasSlash decides
 * whether walkSftp matches against the relative path or just basename.
 */
interface CompiledGlob {
  re: RegExp;
  hasSlash: boolean;
}

async function walkSftp(
  sftp: SFTPWrapper,
  root: string,
  current: string,
  recursive: boolean,
  out: ListEntry[],
  glob: CompiledGlob | null,
): Promise<void> {
  const dirents = await new Promise<{ filename: string; attrs: { size: number; mtime: number; atime: number; mode: number } }[]>((resolve) => {
    sftp.readdir(current, (err, list) => (err ? resolve([]) : resolve(list as never)));
  });
  for (const d of dirents) {
    if (d.filename.startsWith('.')) {
      if (!glob || !glob.re.test(d.filename)) continue;
    }
    const full = posix.join(current, d.filename);
    // SFTP returns mode bits; check directory via S_IFDIR (0o040000).
    const isDir = (d.attrs.mode & 0o170000) === 0o040000;
    const isFile = (d.attrs.mode & 0o170000) === 0o100000;
    const type: ListEntry['type'] = isDir ? 'dir' : isFile ? 'file' : 'other';
    if (glob) {
      // Without `/` in the user's pattern → basename match (so `*.md`
      // recursively finds files in subdirs). With `/` → match against
      // path relative to listing root (so `notes/*.md` is positional).
      const rel = posix.relative(root, full);
      const target = glob.hasSlash ? rel : d.filename;
      if (!glob.re.test(target)) {
        if (type === 'dir' && recursive) {
          await walkSftp(sftp, root, full, recursive, out, glob);
        }
        continue;
      }
    }
    out.push({
      path: full,
      workspace_relative: null,
      type,
      size: d.attrs.size,
      // SFTP gives seconds; ms for parity with local.
      mtime: d.attrs.mtime * 1000,
      ctime: d.attrs.mtime * 1000, // SFTP doesn't expose ctime portably
    });
    if (out.length >= REMOTE_LIST_HARD_CAP) return;
    if (type === 'dir' && recursive) {
      await walkSftp(sftp, root, full, recursive, out, glob);
    }
  }
}

function compileGlob(glob: string): CompiledGlob {
  // hasSlash captures the user's intent BEFORE we expand the pattern —
  // walkSftp uses it to decide basename vs relative-path matching.
  // The compiled regex source has `/` from `[^/]*` so it can't tell us.
  const hasSlash = glob.includes('/');
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*')
    .replace(/\?/g, '[^/]');
  return { re: new RegExp(`^${pattern}$`), hasSlash };
}
