// Local-filesystem implementations for file_* tools. These are the
// 'target=local' (default) paths.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { logger } from '../../server/logger.ts';
import {
  checkReadAllowed,
  checkWriteAllowed,
  realpathSafeAncestor,
  resolveLocalPath,
} from './policy.ts';
import type { Config } from '../../config/types.ts';

const READ_HARD_CAP = 200_000; // chars

export interface ReadResult {
  path: string;
  workspace_relative: string | null;
  bytes: number;
  lines: number;
  content: string;
  truncated: boolean;
  truncated_reason?: string;
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

  const buf = await readFile(absolute);
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
    path: absolute,
    workspace_relative: relative(workspace, absolute) || '.',
    bytes: buf.length,
    lines: lines.length,
    content,
    truncated,
    ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
  };
}

export interface WriteResult {
  path: string;
  workspace_relative: string | null;
  mode: 'create' | 'overwrite' | 'append';
  bytes: number;
}

export async function localWrite(args: {
  path: string;
  content: string;
  agent: string;
  config: Config;
  mode: 'create' | 'overwrite' | 'append';
}): Promise<WriteResult> {
  const { absolute, workspace } = await resolveLocalPath(args.path, args.agent, args.config);
  const policy = checkWriteAllowed(absolute, args.agent);
  if (!policy.ok) throw new Error(policy.reason);

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
    const tmp = `${absolute}.somora-tmp-${process.pid}`;
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

  const tmp = `${absolute}.somora-tmp-${process.pid}`;
  await writeFile(tmp, updated, 'utf8');
  await rename(tmp, absolute);

  const finalSize = (await stat(absolute)).size;
  return { path: absolute, replacements: count, bytes: finalSize };
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
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
              };
            };
            if (ev.type === 'match' && ev.data) {
              hits.push({
                path: ev.data.path?.text ?? '',
                line: ev.data.line_number ?? 0,
                text: (ev.data.lines?.text ?? '').replace(/\n$/, ''),
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
        resolve({ count: hits.length, truncated, hits });
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
