// somora's own Grok home (`~/.somora/grok-home`, passed as GROK_HOME).
//
// Without it a somora agent shared ~/.grok with the person's own Grok
// use: their sessions, Grok's cross-session memory, MCP servers and
// plugins from their config, and — with `[cli] use_leader` — their
// running Grok process. The same reasoning as codex-home / claude-home.
//
// The login is the one thing shared: `grok login` writes ~/.grok/auth.json.
// Grok refreshes it every few hours and may rotate the refresh token, so
// a one-way copy would leave whichever side refreshed second with a dead
// token. Both copies are kept in step: the one that expires later wins.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../server/logger.ts';

export function userGrokHome(): string {
  return process.env.GROK_HOME && process.env.GROK_HOME.length > 0 ? process.env.GROK_HOME : join(homedir(), '.grok');
}

export function somoraGrokHome(): string {
  return join(process.env.SOMORA_HOME ?? join(homedir(), '.somora'), 'grok-home');
}

/** The settings somora pins in its Grok home. Rewritten when missing. */
/** xAI account connectors Grok offers through its tool search. A somora
 *  agent has somora's tools only. "tasks" creates automations in the
 *  person's xAI account (schedules, Gmail triggers) that never reach a
 *  somora session — a reminder belongs in Sentinel (2026-10-26: a live
 *  grok-cli turn picked tasks__create over sentinel). "cursor" came with
 *  Grok 1.0.80: 101 tools on the person's X account (posts, scheduled
 *  broadcasts and calls). `disabled_mcp_servers` does not reach gateway
 *  connectors; this key does (measured both times: the search no longer
 *  lists them). A connector a later Grok adds is caught at run time
 *  (grok-cli.ts, engine.grok_foreign_mcp) and added here. */
export const BLOCKED_GATEWAY_CONNECTORS = ['tasks', 'cursor'];
const GATEWAY_KEY = '__managed_gateway_connectors';
const GATEWAY_BLOCK = `# xAI account connectors stay out of somora agents (Sentinel does reminders).
[disabled_mcp_tools]
${GATEWAY_KEY} = ${JSON.stringify(BLOCKED_GATEWAY_CONNECTORS)}
`;

const SOMORA_GROK_CONFIG = `# Written by somora — Grok as an engine for somora agents.
[cli]
# The binary changes only when somora (or you) updates it on purpose.
auto_update = false
# A private Grok process per turn, never the shared leader.
use_leader = false

${GATEWAY_BLOCK}`;

/** A Grok home from before the block gets it added, without touching
 *  the rest of the file (Grok writes its own sections into it). Only
 *  the missing pieces go in: the table, the key under an existing table,
 *  or names missing from the key. Names already there stay; the list
 *  only grows. `extra` adds connectors found at run time. */
export function ensureGatewayBlock(configPath: string, extra: readonly string[] = []): 'added' | 'key-added' | 'present' | 'merged' | 'left' {
  const want = [...new Set([...BLOCKED_GATEWAY_CONNECTORS, ...extra])];
  const text = readFileSync(configPath, 'utf8');
  const lines = text.split('\n');
  const header = lines.findIndex((l) => l.trim() === '[disabled_mcp_tools]');
  if (header === -1) {
    const block = GATEWAY_BLOCK.replace(JSON.stringify(BLOCKED_GATEWAY_CONNECTORS), JSON.stringify(want));
    writeFileSync(configPath, `${text.replace(/\n*$/, '\n')}\n${block}`, { mode: 0o600 });
    logger.info({ msg: 'engine.grok_config_gateway_block', action: 'added', path: configPath });
    return 'added';
  }
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const keyIndex = lines.findIndex((l, i) => i > header && i < end && l.trim().startsWith(GATEWAY_KEY));
  if (keyIndex === -1) {
    lines.splice(header + 1, 0, `${GATEWAY_KEY} = ${JSON.stringify(want)}`);
    writeFileSync(configPath, lines.join('\n'), { mode: 0o600 });
    logger.info({ msg: 'engine.grok_config_gateway_block', action: 'key-added', path: configPath });
    return 'key-added';
  }
  // The value may span lines (Grok or a person may write it that way) and
  // use either TOML string quote. Read up to the closing bracket; when
  // there is none inside this table, leave the file alone rather than
  // break it (an unreadable config.toml stops Grok from starting).
  let last = -1;
  for (let i = keyIndex; i < end; i++) {
    if (lines[i]!.replace(/"[^"]*"|'[^']*'/g, '').includes(']')) {
      last = i;
      break;
    }
  }
  const value = last === -1 ? '' : lines.slice(keyIndex, last + 1).join('\n');
  if (last === -1 || !/=\s*\[/.test(value)) {
    logger.warn({ msg: 'engine.grok_config_gateway_block', action: 'left', path: configPath, hint: `could not read ${GATEWAY_KEY}; add ${JSON.stringify(want)} to it by hand` });
    return 'left';
  }
  const have = [...value.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]!);
  const missing = want.filter((n) => !have.includes(n));
  if (missing.length === 0) return 'present';
  lines.splice(keyIndex, last - keyIndex + 1, `${GATEWAY_KEY} = ${JSON.stringify([...have, ...missing])}`);
  writeFileSync(configPath, lines.join('\n'), { mode: 0o600 });
  logger.info({ msg: 'engine.grok_config_gateway_block', action: 'merged', path: configPath, added: missing });
  return 'merged';
}

/** Latest token expiry in a Grok auth.json, or -1 when unreadable. */
export function grokAuthExpiry(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { expires_at?: unknown }>;
    let latest = -1;
    for (const entry of Object.values(parsed)) {
      const t = typeof entry?.expires_at === 'string' ? Date.parse(entry.expires_at) : NaN;
      if (Number.isFinite(t) && t > latest) latest = t;
    }
    return latest;
  } catch {
    return -1;
  }
}

export interface GrokAuthSync {
  action: 'pulled' | 'pushed' | 'noop' | 'missing';
  userAuthPath: string;
  somoraAuthPath: string;
}

/** Create somora's Grok home with its config and bring both logins in step. */
export function syncGrokHome(): GrokAuthSync {
  const home = somoraGrokHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = join(home, 'config.toml');
  if (!existsSync(configPath)) writeFileSync(configPath, SOMORA_GROK_CONFIG, { mode: 0o600 });
  else ensureGatewayBlock(configPath);

  const userAuthPath = join(userGrokHome(), 'auth.json');
  const somoraAuthPath = join(home, 'auth.json');
  const userExists = existsSync(userAuthPath);
  const somoraExists = existsSync(somoraAuthPath);
  if (!userExists && !somoraExists) return { action: 'missing', userAuthPath, somoraAuthPath };

  const userExp = userExists ? grokAuthExpiry(userAuthPath) : -2;
  const somoraExp = somoraExists ? grokAuthExpiry(somoraAuthPath) : -2;
  // Equal expiry: the newer file wins (a fresh login with the same lifetime).
  const userWins =
    userExp > somoraExp || (userExp === somoraExp && userExists && somoraExists && statSync(userAuthPath).mtimeMs > statSync(somoraAuthPath).mtimeMs);
  const somoraWins = somoraExp > userExp;
  try {
    if (userWins && userExists) {
      copyFileSync(userAuthPath, somoraAuthPath);
      chmodSync(somoraAuthPath, 0o600);
      logger.info({ msg: 'engine.grok_auth_synced', direction: 'pulled' });
      return { action: 'pulled', userAuthPath, somoraAuthPath };
    }
    // Pushed back only to a person who uses Grok themselves: somora never
    // creates a ~/.grok for someone who logged in through somora alone.
    if (somoraWins && somoraExists && userExists) {
      copyFileSync(somoraAuthPath, userAuthPath);
      chmodSync(userAuthPath, 0o600);
      logger.info({ msg: 'engine.grok_auth_synced', direction: 'pushed' });
      return { action: 'pushed', userAuthPath, somoraAuthPath };
    }
  } catch (err) {
    logger.warn({ msg: 'engine.grok_auth_sync_failed', err: String(err) });
  }
  return { action: 'noop', userAuthPath, somoraAuthPath };
}

/** Environment for the Grok child: somora's own home, Grok's own memory off. */
export function grokChildEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GROK_HOME: somoraGrokHome(), GROK_MEMORY: '0' };
}
