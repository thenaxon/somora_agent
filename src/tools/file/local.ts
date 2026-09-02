// Local-filesystem implementations for file_* tools. These are the
// 'target=local' (default) paths.

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { logger } from '../../server/logger.ts';
import {
  checkReadAllowed,
  checkWriteAllowed,
  realpathSafeAncestor,
  resolveLocalPath,
} from './policy.ts';
import { applyTextBudget, windowMatchLine, type RgSubmatch } from './search-window.ts';
import type { Config } from '../../config/types.ts';

const READ_HARD_CAP = 200_000; // chars

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
  lines: number;
  content: string;
  truncated: boolean;
  truncated_reason?: string;
  /** When `truncated` is true and the cut was line-based (not byte-cap mid-line),
   *  this is the line offset at which a follow-up read should resume. */
  next_offset?: number;
}

export async function localRead(args: {
  path: string;
  agent: string;
  config: Config;
  offset?: number;
  limit?: number;
}): Promise<ReadResult> {
  const { absolute, workspace } = await resolveLocalPath(args.path, args.agent, args.config);
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
      throw new Error(`file_read: file_not_found at '${absolute}'`);
    }
    if (e.code === 'EISDIR') {
      throw new Error(`file_read: '${absolute}' is a directory (use file_list for directories)`);
    }
    throw err;
  }
  const all = buf.toString('utf8');
  const lines = all.split('\n');
  const offset = Math.max(0, args.offset ?? 0);
  const limit = args.limit ?? lines.length;
  const slice = lines.slice(offset, offset + limit);
  let content = slice.join('\n');
  let truncated = offset + slice.length < lines.length;
  let truncatedReason = truncated ? `more lines available (offset=${offset + slice.length})` : undefined;
  let nextOffset: number | undefined = truncated ? offset + slice.length : undefined;
  if (content.length > READ_HARD_CAP) {
    content = content.slice(0, READ_HARD_CAP) + '\n[…content truncated at 200k chars]';
    truncated = true;
    truncatedReason = `byte cap (${READ_HARD_CAP} chars)`;
    // Byte-cap truncation cuts mid-line, so a line-based next_offset
    // would skip the cut-off content. Drop the hint rather than mislead.
    nextOffset = undefined;
  }
  return {
    path: absolute,
    workspace_relative: relative(workspace, absolute) || '.',
    bytes: buf.length,
    lines: lines.length,
    content,
    truncated,
    ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
    ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
  };
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
  config: Config;
  mode: 'create' | 'overwrite' | 'append';
}): Promise<WriteResult> {
  const { absolute, workspace, warning } = await resolveLocalPath(
    args.path,
    args.agent,
    args.config,
  );
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
}

export async function localPatch(args: {
  path: string;
  agent: string;
  config: Config;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}): Promise<PatchResult> {
  const { absolute } = await resolveLocalPath(args.path, args.agent, args.config);
  const policy = checkWriteAllowed(absolute, args.agent);
  if (!policy.ok) throw new Error(policy.reason);
  const real = await realpathSafeAncestor(absolute);
  const policyReal = checkWriteAllowed(real, args.agent);
  if (!policyReal.ok) throw new Error(policyReal.reason);
  if (!(await fileExists(absolute))) {
    throw new Error(`file_patch: '${args.path}' does not exist`);
  }

  const original = await readFile(absolute, 'utf8');
  if (!original.includes(args.oldString)) {
    throw new Error(`file_patch: 'old_string' not found in '${args.path}' — match must be exact`);
  }
  let count = 0;
  let updated: string;
  if (args.replaceAll) {
    updated = original.split(args.oldString).join(args.newString);
    count = (original.length - updated.length) / (args.oldString.length - args.newString.length || 1);
    count = original.split(args.oldString).length - 1;
  } else {
    const occurrences = original.split(args.oldString).length - 1;
    if (occurrences > 1) {
      throw new Error(
        `file_patch: 'old_string' appears ${occurrences} times in '${args.path}'. ` +
          'Either include enough surrounding context to make it unique, or pass replace_all=true.',
      );
    }
    updated = original.replace(args.oldString, args.newString);
    count = 1;
  }

  const tmp = uniqueTmpPath(absolute);
  await writeFile(tmp, updated, 'utf8');
  await rename(tmp, absolute);

  const finalSize = (await stat(absolute)).size;
  return { path: absolute, replacements: count, bytes: finalSize };
}

export interface SearchHit {
  path: string;
  line: number;
  /** Window around the match (see search-window.ts), not necessarily
   *  the full line. */
  text: string;
  /** 1-based column of the match start in the original line. */
  col?: number;
  /** Only present (true) when `text` was windowed. */
  truncated?: boolean;
}

export interface SearchResult {
  count: number;
  truncated: boolean;
  hits: SearchHit[];
}

/**
 * Content search via ripgrep when available (much faster + richer
 * defaults like .gitignore-respect), falling back to a simple
 * recursive walk + regex match. Output is stable JSON across both
 * paths so the model never sees the difference.
 */
export async function localSearch(args: {
  pattern: string;
  agent: string;
  config: Config;
  path?: string;
  limit?: number;
}): Promise<SearchResult> {
  const limit = args.limit ?? 50;
  const startPath = args.path
    ? (await resolveLocalPath(args.path, args.agent, args.config)).absolute
    : (await resolveLocalPath('.', args.agent, args.config)).absolute;

  // Try ripgrep first.
  const rg = await tryRipgrep(args.pattern, startPath, limit);
  if (rg !== null) return rg;

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
): Promise<SearchResult | null> {
  return new Promise((resolve) => {
    const rg = process.env.RG_BIN ?? 'rg';
    const child = spawn(
      rg,
      [
        '--json',
        '--max-count', String(limit),
        '--no-messages',
        pattern,
        cwd,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
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
        const hits: SearchHit[] = [];
        for (const line of out.split('\n')) {
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
              if (hits.length >= limit) {
                truncated = true;
                break;
              }
            }
          } catch {
            // malformed JSON line — skip
          }
        }
        const budgeted = applyTextBudget(hits);
        resolve({
          count: budgeted.hits.length,
          truncated: truncated || budgeted.truncated,
          hits: budgeted.hits,
        });
      } catch {
        resolve(null);
      }
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
  config: Config;
  recursive?: boolean;
  sortBy?: 'mtime' | 'name' | 'size';
  limit?: number;
  glob?: string;
}): Promise<ListResult> {
  const { absolute, workspace } = await resolveLocalPath(args.path, args.agent, args.config);
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
  await walkDir(absolute, absolute, recursive, collected, matchGlob);

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
function compileGlob(glob: string): CompiledGlob {
  // hasSlash captures the user's intent BEFORE we expand the pattern
  // — walkDir uses it to decide basename vs relative-path matching.
  // Inspecting the compiled regex source for `/` is unreliable because
  // `*` becomes `[^/]*` which always has `/` in it.
  const hasSlash = glob.includes('/');
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*')
    .replace(/\?/g, '[^/]');
  return { re: new RegExp(`^${pattern}$`), hasSlash };
}
