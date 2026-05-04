// Remote-target implementations for file_* tools — `target=<resource>`
// path. SFTP for read/write/patch (binary-clean, no shell-quoting hell),
// remote-exec'd ripgrep for search.

import { posix } from 'node:path';
import type { Client, SFTPWrapper, Stats } from 'ssh2';
import type { SshResource } from '../../config/types.ts';
import { logger } from '../../server/logger.ts';
import { getConnection, remoteExec } from '../../ssh/index.ts';
import type { ListEntry, ListResult, ReadResult, SearchResult, SearchHit, WriteResult, PatchResult } from './local.ts';

const READ_HARD_CAP = 200_000;

/**
 * Resolve a remote path: relative inputs use `resource.workspace` (or
 * the default home `~`) as the cwd. Posix-only — remote is assumed
 * unix-y. Windows-via-SSH would need separate handling.
 */
function resolveRemotePath(rawPath: string, resource: SshResource): string {
  if (posix.isAbsolute(rawPath)) return posix.normalize(rawPath);
  const root = resource.workspace ?? '~';
  return posix.normalize(posix.join(root, rawPath));
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

function sftpRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
  });
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
  const remotePath = resolveRemotePath(args.path, args.resource);
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
  const remotePath = resolveRemotePath(args.path, args.resource);
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
      // Atomic via tmp+rename.
      const tmp = `${remotePath}.somora-tmp`;
      await sftpWriteFile(sftp, tmp, existing + sep + args.content);
      await sftpRename(sftp, tmp, remotePath);
    } else {
      const tmp = `${remotePath}.somora-tmp`;
      await sftpWriteFile(sftp, tmp, args.content);
      await sftpRename(sftp, tmp, remotePath);
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
  const remotePath = resolveRemotePath(args.path, args.resource);

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
    const tmp = `${remotePath}.somora-tmp`;
    await sftpWriteFile(sftp, tmp, updated);
    await sftpRename(sftp, tmp, remotePath);
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
  const remotePath = args.path ? resolveRemotePath(args.path, args.resource) : (args.resource.workspace ?? '.');
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
          `Install via the remote's package manager.`,
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
        };
      };
      if (ev.type === 'match' && ev.data) {
        hits.push({
          path: ev.data.path?.text ?? '',
          line: ev.data.line_number ?? 0,
          text: (ev.data.lines?.text ?? '').replace(/\n$/, ''),
        });
        if (hits.length >= limit) break;
      }
    } catch {
      // skip malformed
    }
  }
  return { count: hits.length, truncated: result.truncated || hits.length >= limit, hits };
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
  const fullPath = resolveRemotePath(args.path, args.resource);
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

async function walkSftp(
  sftp: SFTPWrapper,
  root: string,
  current: string,
  recursive: boolean,
  out: ListEntry[],
  globRe: RegExp | null,
): Promise<void> {
  const dirents = await new Promise<{ filename: string; attrs: { size: number; mtime: number; atime: number; mode: number } }[]>((resolve) => {
    sftp.readdir(current, (err, list) => (err ? resolve([]) : resolve(list as never)));
  });
  for (const d of dirents) {
    if (d.filename.startsWith('.')) {
      if (!globRe || !globRe.test(d.filename)) continue;
    }
    const full = posix.join(current, d.filename);
    // SFTP returns mode bits; check directory via S_IFDIR (0o040000).
    const isDir = (d.attrs.mode & 0o170000) === 0o040000;
    const isFile = (d.attrs.mode & 0o170000) === 0o100000;
    const type: ListEntry['type'] = isDir ? 'dir' : isFile ? 'file' : 'other';
    if (globRe) {
      const rel = posix.relative(root, full);
      const target = globRe.source.includes('/') ? rel : d.filename;
      if (!globRe.test(target)) {
        if (type === 'dir' && recursive) {
          await walkSftp(sftp, root, full, recursive, out, globRe);
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
      await walkSftp(sftp, root, full, recursive, out, globRe);
    }
  }
}

function compileGlob(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${pattern}$`);
}
