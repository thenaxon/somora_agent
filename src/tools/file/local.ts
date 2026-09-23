// Local-filesystem implementations for file_* tools. These are the
// 'target=local' (default) paths.

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { logger } from '../../server/logger.ts';
import {
  assertReadAllowed,
  checkReadAllowed,
  checkWriteAllowed,
  isSomoraInternalPath,
  realpathSafeAncestor,
  resolveLocalPath,
} from './policy.ts';
import { enforceWriteScope } from './write-scope.ts';
import { applyTextBudget, parseRgJson, type RgHit } from './search-window.ts';
import { formatRead, nearestNames } from './read-format.ts';
import { diffSnippet, replaceInContent, ReplaceError, type Strategy } from './replace.ts';
import type { Config } from '../../config/types.ts';

/** Build a per-call unique temp filename next to the target. The previous
 *  `<path>.somora-tmp-<pid>` was shared by every concurrent writer in the
 *  same process (the MCP-child has one pid), so parallel file_write/
 *  file_patch calls overwrote each other's tmp and the later rename
 *  failed with ENOENT. Audit 2026-05-16. */
function uniqueTmpPath(absolute: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${absolute}.somora-tmp.${process.pid}.${ts}.${rand}`;
}

export interface ReadResult {
  path: string;
  workspace_relative: string | null;
  bytes: number;
  /** Total lines in the file. */
  lines: number;
  /** Numbered lines: `12: text` (see read-format.ts). */
  content: string;
  /** 1-based inclusive line range held in `content`. */
  range: { from: number; to: number };
  truncated: boolean;
  truncated_reason?: string;
  /** When `truncated` is true, the `offset` to continue with. */
  next_offset?: number;
  /** "End of file (N lines)." or "Showing lines a-b of N. Continue with offset=b." */
  summary: string;
}

export async function localRead(args: {
  path: string;
  agent: string;
  session?: string;
  config: Config;
  offset?: number;
  limit?: number;
}): Promise<ReadResult> {
  const { absolute, workspace } = await resolveLocalPath(args.path, args.agent, args.config, args.session);
  const policy = checkReadAllowed(absolute);
  if (!policy.ok) throw new Error(policy.reason);
  const real = await realpathSafeAncestor(absolute);
  const policyReal = checkReadAllowed(real);
  if (!policyReal.ok) throw new Error(policyReal.reason);

  let buf;
  try {
    buf = await readFile(absolute);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(`file_read: file_not_found at '${absolute}'${await didYouMean(absolute)}`);
    }
    if (e.code === 'EISDIR') {
      throw new Error(`file_read: '${absolute}' is a directory (use file_list for directories)`);
    }
    throw err;
  }
  const formatted = formatRead(buf.toString('utf8'), args.offset, args.limit);
  return {
    path: absolute,
    workspace_relative: relative(workspace, absolute) || '.',
    bytes: buf.length,
    ...formatted,
  };
}

/** " Did you mean: a.ts, b.ts?" for a missing file, from its directory's
 *  entries — a model that misremembers a name gets the fix in the error
 *  instead of a second round of file_list. */
async function didYouMean(absolute: string): Promise<string> {
  try {
    const names = await readdir(dirname(absolute));
    const near = nearestNames(basename(absolute), names);
    return near.length > 0 ? `. Did you mean: ${near.join(', ')}?` : '';
  } catch {
    return '';
  }
}

export interface WriteResult {
  path: string;
  workspace_relative: string | null;
  mode: 'create' | 'overwrite' | 'append';
  bytes: number;
  /** Set when the path looked like a home-relative spelling of a
   *  workspace path (leading `<workspace-basename>/`). */
  warning?: string;
}

export async function localWrite(args: {
  path: string;
  content: string;
  agent: string;
  session?: string;
  config: Config;
  mode: 'create' | 'overwrite' | 'append';
}): Promise<WriteResult> {
  // The session decides the root of a relative path (a pinned project's
  // folder) — the same call file_read/file_patch/file_search/file_list
  // make. Missing here until 2026-09-23: a builder's relative file_write
  // landed in the agent workspace while its file_read of the same
  // relative path read the repository.
  const { absolute, workspace, warning } = await resolveLocalPath(args.path, args.agent, args.config, args.session);
  const policy = checkWriteAllowed(absolute, args.agent);
  if (!policy.ok) throw new Error(policy.reason);
  if (warning) {
    logger.warn({ msg: 'tool.file_write.path_prefix_doubled', agent: args.agent, path: absolute });
  }

  await mkdir(dirname(absolute), { recursive: true });

  // Realpath after mkdir so symlinks in the parent chain are resolved.
  const real = await realpathSafeAncestor(absolute);
  const policyReal = checkWriteAllowed(real, args.agent);
  if (!policyReal.ok) throw new Error(policyReal.reason);
  await enforceWriteScope({ absolute: real, agent: args.agent, session: args.session, config: args.config });

  const exists = await fileExists(absolute);
  if (args.mode === 'create' && exists) {
    throw new Error(`file_write: '${args.path}' already exists; use mode='overwrite' or 'append'`);
  }
  if (args.mode === 'append' && exists) {
    const existing = await readFile(absolute, 'utf8');
    const sep = existing.endsWith('\n') ? '' : '\n';
    await writeFile(absolute, existing + sep + args.content, 'utf8');
  } else {
    // Atomic write via tmp + rename — avoids torn writes if the process
    // dies mid-write.
    const tmp = uniqueTmpPath(absolute);
    await writeFile(tmp, args.content, 'utf8');
    await rename(tmp, absolute);
  }

  const finalSize = (await stat(absolute)).size;
  logger.info({
    msg: 'tool.file_write.local',
    agent: args.agent,
    path: absolute,
    mode: args.mode,
    bytes: finalSize,
  });
  return {
    path: absolute,
    workspace_relative: relative(workspace, absolute) || '.',
    mode: args.mode,
    bytes: finalSize,
    ...(warning ? { warning } : {}),
  };
}

export interface PatchResult {
  path: string;
  replacements: number;
  bytes: number;
  /** How old_string was located: `exact`, or a tolerant strategy. */
  strategy: Strategy;
  /** 1-based line range of the (first) replaced span in the original. */
  lines: { from: number; to: number };
  /** `-`/`+` view of the changed region with original line numbers. */
  diff: string;
  /** Present when a tolerant strategy or prefix-stripping was needed. */
  note?: string;
}

/** Shared by the local and the SFTP path: locate, replace, describe. */
export function applyPatch(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  allowFuzzy: boolean,
  label: string,
): { updated: string } & Omit<PatchResult, 'path' | 'bytes'> {
  let outcome;
  try {
    outcome = replaceInContent(original, oldString, newString, { replaceAll, allowFuzzy });
  } catch (err) {
    if (err instanceof ReplaceError) throw new Error(`file_patch: ${err.message} (${label})`);
    throw err;
  }
  const notes: string[] = [];
  if (outcome.lineNumbersStripped) {
    notes.push('old_string carried `N: ` line-number prefixes from file_read; they were stripped before matching.');
  }
  if (outcome.strategy !== 'exact') {
    notes.push(
      `old_string did not match the file text exactly; it was located with tolerance (${outcome.strategy}) — ` +
        'check the diff, and copy lines exactly next time.',
    );
  }
  return {
    updated: outcome.updated,
    replacements: outcome.count,
    strategy: outcome.strategy,
    lines: outcome.firstSpanLines,
    diff: diffSnippet(original, outcome.updated),
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  };
}

export async function localPatch(args: {
  path: string;
  agent: string;
  session?: string;
  config: Config;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}): Promise<PatchResult> {
  const { absolute } = await resolveLocalPath(args.path, args.agent, args.config, args.session);
  const policy = checkWriteAllowed(absolute, args.agent);
  if (!policy.ok) throw new Error(policy.reason);
  const real = await realpathSafeAncestor(absolute);
  const policyReal = checkWriteAllowed(real, args.agent);
  if (!policyReal.ok) throw new Error(policyReal.reason);
  await enforceWriteScope({ absolute: real, agent: args.agent, session: args.session, config: args.config });
  if (!(await fileExists(absolute))) {
    throw new Error(`file_patch: '${args.path}' does not exist`);
  }

  const original = await readFile(absolute, 'utf8');
  // Tolerant matching everywhere except somora's own home: a match one
  // block off in config.yaml or a persona file is the worst-case edit.
  const { updated, ...described } = applyPatch(
    original,
    args.oldString,
    args.newString,
    args.replaceAll,
    !isSomoraInternalPath(real),
    `in '${args.path}'`,
  );

  const tmp = uniqueTmpPath(absolute);
  await writeFile(tmp, updated, 'utf8');
  await rename(tmp, absolute);
  if (described.strategy !== 'exact') {
    logger.info({ msg: 'tool.file_patch.tolerant_match', agent: args.agent, path: absolute, strategy: described.strategy });
  }

  // Length of what we wrote, not a stat() after the rename: on CIFS
  // mounts (cache=strict) the stat right after an atomic rename can
  // report 0 while the file is complete — `bytes: 0` looks like data
  // loss to the caller (2026-09-03 report).
  return { path: absolute, bytes: Buffer.byteLength(updated, 'utf8'), ...described };
}

export type SearchHit = RgHit;

export interface SearchResult {
  count: number;
  truncated: boolean;
  hits: SearchHit[];
  /** Only with `files_only`: the matching file paths (hits is empty). */
  files?: string[];
}

export interface SearchOptions {
  /** ripgrep glob for files to search, e.g. `*.ts` or `src/**` or `*.{ts,tsx}`. */
  include?: string;
  caseInsensitive?: boolean;
  /** Lines of context before and after each hit (0-5). */
  context?: number;
  /** Return only the paths of files with a match. */
  filesOnly?: boolean;
}

/** ripgrep argument list shared by the local spawn and the SSH exec. */
export function rgArgs(pattern: string, limit: number, opts: SearchOptions): string[] {
  const args: string[] = ['--no-messages', '--no-require-git'];
  if (opts.filesOnly) args.push('--files-with-matches');
  else args.push('--json', '--max-count', String(limit));
  if (opts.include) args.push('--glob', opts.include);
  if (opts.caseInsensitive) args.push('--ignore-case');
  const ctx = Math.max(0, Math.min(5, Math.floor(opts.context ?? 0)));
  if (ctx > 0 && !opts.filesOnly) args.push('--context', String(ctx));
  args.push('--regexp', pattern);
  return args;
}

/**
 * Content search via ripgrep (fast, .gitignore-aware). Output is stable
 * JSON for the local and the SSH path so the model never sees the
 * difference.
 */
export async function localSearch(args: {
  pattern: string;
  agent: string;
  session?: string;
  config: Config;
  path?: string;
  limit?: number;
} & SearchOptions): Promise<SearchResult> {
  const limit = args.limit ?? 50;
  const startPath = args.path
    ? (await resolveLocalPath(args.path, args.agent, args.config, args.session)).absolute
    : (await resolveLocalPath('.', args.agent, args.config, args.session)).absolute;
  // Same read policy as file_read/file_list — search returns file
  // content, so a blocked directory must not be searchable either.
  await assertReadAllowed(startPath);

  // Try ripgrep first.
  const rg = await tryRipgrep(args.pattern, startPath, limit, args);
  if (rg !== null) {
    // The start path was allowed; a hit below it may still not be (a
    // search from `/etc` reaching `/etc/ssh`, a symlink into a blocked
    // dir). Drop those hits rather than fail the whole search.
    if (rg.files) {
      const files: string[] = [];
      for (const f of rg.files) {
        try {
          await assertReadAllowed(f);
          files.push(f);
        } catch {
          /* blocked path — not returned */
        }
      }
      return { ...rg, files, count: files.length };
    }
    const hits: SearchHit[] = [];
    for (const h of rg.hits) {
      try {
        await assertReadAllowed(h.path);
        hits.push(h);
      } catch {
        /* blocked path — not returned */
      }
    }
    return { ...rg, hits, count: hits.length };
  }

  // Fallback: tell the user instead of building our own walker. The
  // user's stated direction is "all-own-tools but use what's there
  // for utility" — ripgrep IS a system utility we expect on dev
  // machines. Honest "install rg" is better than a slow JS walker
  // that loses parity with what rg does.
  throw new Error(
    `file_search: ripgrep (rg) not found on PATH. Install via your package manager ` +
      `(brew/apt/dnf/pacman) or set $RG_BIN to a custom location.`,
  );
}

function tryRipgrep(
  pattern: string,
  cwd: string,
  limit: number,
  opts: SearchOptions,
): Promise<SearchResult | null> {
  return new Promise((resolve) => {
    const rg = process.env.RG_BIN ?? 'rg';
    const child = spawn(rg, [...rgArgs(pattern, limit, opts), '--', cwd], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    let truncated = false;
    let bytesSeen = 0;
    const cap = 4 * 1024 * 1024;

    child.stdout.on('data', (d: Buffer) => {
      bytesSeen += d.byteLength;
      if (bytesSeen > cap) {
        truncated = true;
        try {
          child.kill();
        } catch {
          /* best-effort */
        }
        return;
      }
      stdoutChunks.push(d);
    });
    child.on('error', () => resolve(null)); // rg not found / spawn fail
    child.on('close', () => {
      try {
        const out = Buffer.concat(stdoutChunks).toString('utf8');
        if (opts.filesOnly) {
          const all = out.split('\n').filter((l) => l.trim() !== '');
          const files = all.slice(0, limit);
          resolve({ count: files.length, truncated: truncated || all.length > limit, hits: [], files });
          return;
        }
        const parsed = parseRgJson(out, limit);
        const budgeted = applyTextBudget(parsed.hits);
        resolve({
          count: budgeted.hits.length,
          truncated: truncated || parsed.hitLimitReached || budgeted.truncated,
          hits: budgeted.hits,
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/** `rg --files` under `root`: paths of non-ignored, non-hidden files
 *  relative to root, or null when rg is unavailable. Exported for tests. */
export function rgFiles(root: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    const rg = process.env.RG_BIN ?? 'rg';
    const child = spawn(rg, ['--files', '--no-messages', '--no-require-git', '--', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (d: Buffer) => {
      bytes += d.byteLength;
      if (bytes > 8 * 1024 * 1024) {
        try {
          child.kill();
        } catch {
          /* best-effort */
        }
        return;
      }
      chunks.push(d);
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 && code !== 1 && chunks.length === 0) return resolve(null);
      resolve(
        Buffer.concat(chunks)
          .toString('utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((p) => relative(root, p)),
      );
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// file_list (local)
// ─────────────────────────────────────────────────────────────────────

export interface ListEntry {
  path: string;
  workspace_relative: string | null;
  type: 'file' | 'dir' | 'other';
  size: number;
  mtime: number;
  ctime: number;
}

export interface ListResult {
  root: string;
  count: number;
  truncated: boolean;
  entries: ListEntry[];
}

const LIST_HARD_CAP = 5_000;

export async function localList(args: {
  path: string;
  agent: string;
  session?: string;
  config: Config;
  recursive?: boolean;
  sortBy?: 'mtime' | 'name' | 'size';
  limit?: number;
  glob?: string;
  /** Default true: a recursive walk skips what .gitignore/.ignore
   *  exclude (node_modules, build output) — via `rg --files`. */
  respectGitignore?: boolean;
}): Promise<ListResult> {
  const { absolute, workspace } = await resolveLocalPath(args.path, args.agent, args.config, args.session);
  const policy = checkReadAllowed(absolute);
  if (!policy.ok) throw new Error(policy.reason);
  const real = await realpathSafeAncestor(absolute);
  const policyReal = checkReadAllowed(real);
  if (!policyReal.ok) throw new Error(policyReal.reason);

  let rootStat;
  try {
    rootStat = await stat(absolute);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      throw new Error(`file_list: file_not_found at '${absolute}' — directory does not exist`);
    }
    throw err;
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`file_list: '${absolute}' is not a directory (use file_read for single files)`);
  }

  const matchGlob = args.glob ? compileGlob(args.glob) : null;
  const sortBy = args.sortBy ?? 'name';
  const limit = Math.min(args.limit ?? 200, LIST_HARD_CAP);
  const recursive = Boolean(args.recursive);

  const collected: ListEntry[] = [];
  let ignored = false;
  if (recursive && args.respectGitignore !== false) {
    const files = await rgFiles(absolute);
    if (files !== null) {
      ignored = true;
      await collectFromFileList(absolute, files, collected, matchGlob);
    }
  }
  if (!ignored) await walkDir(absolute, absolute, recursive, collected, matchGlob);

  collected.sort((a, b) => {
    if (sortBy === 'mtime') return b.mtime - a.mtime; // newest first
    if (sortBy === 'size') return b.size - a.size; // largest first
    return a.path.localeCompare(b.path);
  });

  const truncated = collected.length > limit;
  const entries = collected.slice(0, limit).map((e) => ({
    ...e,
    workspace_relative: relative(workspace, e.path) || '.',
  }));

  return {
    root: absolute,
    count: entries.length,
    truncated,
    entries,
  };
}

/**
 * Compiled glob — keeps the original-string `hasSlash` flag alongside
 * the RegExp because the regex source itself is unreliable for that
 * check (the compiled `[^/]*` always contains `/`). hasSlash decides
 * whether walkDir matches against the relative path or just basename.
 */
interface CompiledGlob {
  re: RegExp;
  hasSlash: boolean;
}

/**
 * Build entries from an `rg --files` listing (paths relative to root):
 * the files themselves plus every directory on the way to them, so a
 * recursive listing still shows the tree — minus what .gitignore hides.
 * Glob semantics are the walker's: basename without `/`, relative path
 * with `/`; a glob also filters directories.
 */
export async function collectFromFileList(
  root: string,
  files: string[],
  out: ListEntry[],
  glob: { re: RegExp; hasSlash: boolean } | null,
): Promise<void> {
  const dirs = new Set<string>();
  for (const rel of files) {
    let parent = dirname(rel);
    while (parent && parent !== '.' && !dirs.has(parent)) {
      dirs.add(parent);
      parent = dirname(parent);
    }
  }
  const candidates: Array<{ rel: string; type: ListEntry['type'] }> = [
    ...[...dirs].map((rel) => ({ rel, type: 'dir' as const })),
    ...files.map((rel) => ({ rel, type: 'file' as const })),
  ];
  for (const c of candidates) {
    if (glob) {
      const target = glob.hasSlash ? c.rel : basename(c.rel);
      if (!glob.re.test(target)) continue;
    }
    const full = join(root, c.rel);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    out.push({
      path: full,
      workspace_relative: null,
      type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      size: st.size,
      mtime: st.mtimeMs,
      ctime: st.ctimeMs,
    });
    if (out.length >= LIST_HARD_CAP) return;
  }
}

async function walkDir(
  root: string,
  current: string,
  recursive: boolean,
  out: ListEntry[],
  glob: CompiledGlob | null,
): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(current, { withFileTypes: true });
  } catch (err) {
    // Subdirs we can't read get silently skipped — listing should not
    // fail wholesale because of one inaccessible subtree.
    return;
  }
  for (const d of dirents) {
    // Skip dotfiles by default (they pollute listings; vault-like dirs
    // typically have meaningful files at the top level). The user can
    // pass an explicit glob like ".*" if they want them.
    if (d.name.startsWith('.')) {
      if (!glob || !glob.re.test(d.name)) continue;
    }
    const full = join(current, d.name);
    let st;
    try {
      st = await stat(full);
    } catch {
      continue;
    }
    const type: ListEntry['type'] = d.isDirectory()
      ? 'dir'
      : d.isFile()
        ? 'file'
        : 'other';
    if (glob) {
      // Without `/` in the user's pattern → basename match (so `*.md`
      // recursively finds Naxxen.md inside Projekte/novixon/, matching
      // the docstring promise). With `/` → match against the path
      // relative to the listing root (so `notes/*.md` is positional).
      const rel = relative(root, full);
      const target = glob.hasSlash ? rel : d.name;
      if (!glob.re.test(target)) {
        // Glob doesn't match this entry — skip it but still recurse
        // into matching dirs (a glob like "**/*.md" should descend
        // through dir levels even if those dir names don't match).
        if (type === 'dir' && recursive) {
          await walkDir(root, full, recursive, out, glob);
        }
        continue;
      }
    }
    out.push({
      path: full,
      workspace_relative: null, // filled in by localList()
      type,
      size: st.size,
      mtime: st.mtimeMs,
      ctime: st.ctimeMs,
    });
    if (out.length >= LIST_HARD_CAP) return;
    if (type === 'dir' && recursive) {
      await walkDir(root, full, recursive, out, glob);
    }
  }
}

/**
 * Tiny glob → CompiledGlob. Supports `*` (any chars except `/`),
 * `**` (any chars including `/`), and `?` (single char except `/`). All
 * other regex meta-characters are escaped. Match is anchored on both
 * ends. hasSlash records whether the user's pattern had a literal `/`
 * so walkDir can decide between basename matching (no slash) and
 * relative-path matching (with slash) — see CompiledGlob doc for why.
 */
export function compileGlob(glob: string): CompiledGlob {
  // hasSlash captures the user's intent BEFORE we expand the pattern
  // — walkDir uses it to decide basename vs relative-path matching.
  // Inspecting the compiled regex source for `/` is unreliable because
  // `*` becomes `[^/]*` which always has `/` in it.
  const hasSlash = glob.includes('/');
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '[^/]');
  return { re: new RegExp(`^${pattern}$`), hasSlash };
}
