// The one-time rewrite of agent.yaml files to the `dreams` switch
// (private/dream-switch/KONZEPT.md), run at server start before anything
// reads the switch. Not left to the web client: not everyone uses it, and
// a server start happens on every update path (somora update, the
// installer, npm by hand).
//
// Per file: skipped when `dreams:` is already there; otherwise a backup
// copy, then a text edit that keeps comments and order — `dreams:` added,
// `enabled:` and `participate_in_wiki:` taken out of the `rem:` block, an
// emptied `rem:` block removed. The edit is checked by parsing it again:
// it must mean the same as before plus the switch, or the file stays as
// it was (the loader derives the same value from the old keys, so the
// agent still behaves right).

import { copyFile, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseYaml } from '../config/yaml.ts';
import { logger } from '../server/logger.ts';
import { deriveDreams, type DreamsSource } from './loader.ts';

export interface DreamsMigration {
  agent: string;
  dreams: boolean;
  source: DreamsSource;
  /** Not rewritten: why (the agent still runs with `dreams` derived). */
  error?: string;
}

const isKey = (line: string, indent: number, key: string) =>
  new RegExp(`^ {${indent}}${key}:(\\s|$)`).test(line);
const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlankOrComment = (line: string) => /^\s*(#.*)?$/.test(line);

/** The rewritten text, or null when the file needs nothing. Throws when
 *  the edit would change what the file means. */
export function rewriteForDreams(text: string): { text: string; dreams: boolean; source: DreamsSource } | null {
  const before = (parseYaml(text) ?? {}) as Record<string, unknown>;
  if (typeof before !== 'object' || Array.isArray(before)) throw new Error('agent.yaml is not a mapping');
  if ('dreams' in before) return null;
  const { dreams, source } = deriveDreams(before as Parameters<typeof deriveDreams>[0]);

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const firstKey = lines.find((l) => !isBlankOrComment(l));
  const top = firstKey ? indentOf(firstKey) : 0;

  const remAt = lines.findIndex((l) => isKey(l, top, 'rem') && /^\s*rem:\s*(#.*)?$/.test(l));
  if (remAt >= 0) {
    // The block's lines: everything after `rem:` until the next line at
    // top level that is not blank or a comment.
    let end = remAt + 1;
    while (end < lines.length && (isBlankOrComment(lines[end]!) || indentOf(lines[end]!) > top)) end++;
    // Trailing blank lines/comments belong to what follows, not to the block.
    while (end > remAt + 1 && isBlankOrComment(lines[end - 1]!)) end--;
    const block = lines.slice(remAt + 1, end);
    const child = block.find((l) => !isBlankOrComment(l));
    const childIndent = child ? indentOf(child) : top + 2;
    const kept = block.filter((l) => !(isKey(l, childIndent, 'enabled') || isKey(l, childIndent, 'participate_in_wiki')));
    const stillHasKeys = kept.some((l) => !isBlankOrComment(l));
    const replacement = stillHasKeys ? [lines[remAt]!, ...kept] : [];
    lines.splice(remAt, end - remAt, `${' '.repeat(top)}dreams: ${dreams}`, ...replacement);
  } else {
    // After `kind:` or `model:` when there is one, else at the end.
    const after = ['kind', 'model'].map((k) => lines.findIndex((l) => isKey(l, top, k))).find((i) => i >= 0);
    const at = after === undefined ? lines.length - (lines.at(-1) === '' ? 1 : 0) : after + 1;
    lines.splice(at, 0, `${' '.repeat(top)}dreams: ${dreams}`);
  }
  const out = lines.join(eol);

  // Same meaning plus the switch, or nothing.
  const after = (parseYaml(out) ?? {}) as Record<string, unknown>;
  const expected = structuredClone(before);
  expected.dreams = dreams;
  const rem = expected.rem as Record<string, unknown> | undefined;
  if (rem && typeof rem === 'object') {
    delete rem.enabled;
    delete rem.participate_in_wiki;
    if (Object.keys(rem).length === 0) delete expected.rem;
  }
  if (JSON.stringify(sortKeys(after)) !== JSON.stringify(sortKeys(expected))) {
    throw new Error('the rewrite would change more than the dreams switch (unusual layout) — left as it is');
  }
  return { text: out, dreams, source };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

function stamp(d = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

/** Rewrite every agent.yaml under `<home>/agents/` that has no `dreams:`
 *  yet. Returns what was done, one entry per file touched or tried. */
export async function migrateDreamsSwitch(home = process.env.SOMORA_HOME ?? join(homedir(), '.somora')): Promise<DreamsMigration[]> {
  const agentsDir = join(home, 'agents');
  let names: string[];
  try {
    names = await readdir(agentsDir);
  } catch {
    return [];
  }
  const done: DreamsMigration[] = [];
  for (const agent of names.sort()) {
    const file = join(agentsDir, agent, 'agent.yaml');
    let text: string;
    let mode: number;
    try {
      text = await readFile(file, 'utf8');
      mode = (await stat(file)).mode & 0o777;
    } catch {
      continue; // no agent.yaml: nothing to rewrite, the defaults apply
    }
    let result: ReturnType<typeof rewriteForDreams>;
    try {
      result = rewriteForDreams(text);
    } catch (err) {
      const parsed = (() => { try { return deriveDreams((parseYaml(text) ?? {}) as Parameters<typeof deriveDreams>[0]); } catch { return null; } })();
      const entry: DreamsMigration = { agent, dreams: parsed?.dreams ?? false, source: parsed?.source ?? 'default', error: (err as Error).message };
      logger.warn({ msg: 'agent.dreams_migrate_failed', ...entry });
      done.push(entry);
      continue;
    }
    if (!result) continue;
    try {
      const backup = `${file}.bak-${stamp()}-dreams`;
      await copyFile(file, backup).catch(async (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
      const tmp = `${file}.tmp-dreams-${process.pid}`;
      await writeFile(tmp, result.text, { mode });
      await rename(tmp, file);
      const entry: DreamsMigration = { agent, dreams: result.dreams, source: result.source };
      logger.info({ msg: 'agent.dreams_migrated', ...entry, backup });
      done.push(entry);
    } catch (err) {
      const entry: DreamsMigration = { agent, dreams: result.dreams, source: result.source, error: (err as Error).message };
      logger.warn({ msg: 'agent.dreams_migrate_failed', ...entry });
      done.push(entry);
    }
  }
  return done;
}
