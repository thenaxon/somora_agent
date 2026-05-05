// DREAMRULES.MD loader — per-agent prose rules that shape what the
// dream-worker proposes. Lives at `~/.somora/agents/<name>/DREAMRULES.MD`
// alongside AGENTS.md / SOUL.md / USER.md. Optional: missing file means
// no per-agent rules, current behavior unchanged.
//
// Format: free-form markdown. The contents get injected verbatim into
// the extractor's system prompt as a "Per-agent rules" block, prefixed
// by the agent's name. No schema, no validation — same trust posture
// as the other persona files. The agent itself can edit it via
// file_write when it spots patterns the worker should learn (e.g. user
// dismissed N suggestions of type X — agent appends "Don't propose X").
//
// Live-reload: cached with mtime, re-loaded only when the file changes.
// A dream cycle running RIGHT NOW won't pick up an in-flight edit (the
// rules are read once at start of extractFromSession), but the next
// cycle will.
//
// Why per-agent rather than global: dream behaviour is already per-agent
// (dream.enabled in agent.yaml), and so is vault access. A rule like
// "don't duplicate vault content into memory" only makes sense for
// agents that have a vault. Per-agent keeps the file aligned with the
// rest of the persona surface.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';

const SOMORA_HOME = process.env.SOMORA_HOME ?? join(homedir(), '.somora');

export function dreamRulesPath(agent: string): string {
  return join(SOMORA_HOME, 'agents', agent, 'DREAMRULES.MD');
}

interface CacheEntry {
  mtimeMs: number;
  content: string;
}

const cache = new Map<string, CacheEntry>();

/**
 * Load per-agent dream rules. Returns the file content as a string when
 * present, or null when the file doesn't exist (= no rules).
 *
 * Lazy mtime-cache: stat is cheap, re-read only fires when the file
 * genuinely changed. Stat-failure (permission, EIO, ...) treated as
 * "no rules" — log and continue, never block dreaming on a rules read.
 */
export async function loadDreamRules(agent: string): Promise<string | null> {
  const path = dreamRulesPath(agent);
  let mtimeMs: number;
  try {
    const st = await stat(path);
    mtimeMs = st.mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Drop any cached entry — file was deleted since last load.
      cache.delete(path);
      return null;
    }
    logger.warn({
      msg: 'dream.rules.stat_failed',
      agent,
      path,
      err: (err as Error).message,
    });
    return null;
  }
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.content;
  }
  try {
    const content = await readFile(path, 'utf8');
    cache.set(path, { mtimeMs, content });
    return content;
  } catch (err) {
    logger.warn({
      msg: 'dream.rules.read_failed',
      agent,
      path,
      err: (err as Error).message,
    });
    return null;
  }
}

/**
 * Compose the dream-worker system prompt: base prompt + a per-agent
 * "## Rules" block when DREAMRULES.MD has content. The base prompt
 * stays as the contract; per-agent rules add domain-specific guard-
 * rails the agent or user wants the worker to honor.
 */
export function composeDreamSystemPrompt(
  basePrompt: string,
  rules: string | null,
): string {
  if (!rules) return basePrompt;
  const trimmed = rules.trim();
  if (trimmed.length === 0) return basePrompt;
  return `${basePrompt}\n\n## Per-agent rules\n\n${trimmed}`;
}
