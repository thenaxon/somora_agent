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
/** xAI account connectors Grok offers through its tool search. "tasks"
 *  creates automations in the person's xAI account (schedules, Gmail
 *  triggers) that never reach a somora session — a reminder belongs in
 *  Sentinel. 2026-10-26: a live grok-cli turn picked tasks__create over
 *  sentinel. `disabled_mcp_servers` does not reach gateway connectors;
 *  this key does (measured: the search no longer lists them). */
export const BLOCKED_GATEWAY_CONNECTORS = ['tasks'];
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
 *  the missing pieces go in: the table, or the key under an existing
 *  table. A key that is there but lists other names is left alone and
 *  logged — that is someone's edit. Returns what it did. */
export function ensureGatewayBlock(configPath: string): 'added' | 'key-added' | 'present' | 'left' {
  const text = readFileSync(configPath, 'utf8');
  const lines = text.split('\n');
  const header = lines.findIndex((l) => l.trim() === '[disabled_mcp_tools]');
  if (header === -1) {
    writeFileSync(configPath, `${text.replace(/\n*$/, '\n')}\n${GATEWAY_BLOCK}`, { mode: 0o600 });
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
  const keyLine = lines.slice(header + 1, end).find((l) => l.trim().startsWith(GATEWAY_KEY));
  if (!keyLine) {
    lines.splice(header + 1, 0, `${GATEWAY_KEY} = ${JSON.stringify(BLOCKED_GATEWAY_CONNECTORS)}`);
    writeFileSync(configPath, lines.join('\n'), { mode: 0o600 });
    logger.info({ msg: 'engine.grok_config_gateway_block', action: 'key-added', path: configPath });
    return 'key-added';
  }
  if (BLOCKED_GATEWAY_CONNECTORS.every((n) => keyLine.includes(`"${n}"`))) return 'present';
  logger.warn({ msg: 'engine.grok_config_gateway_block', action: 'left', path: configPath, line: keyLine.trim(), hint: `add ${JSON.stringify(BLOCKED_GATEWAY_CONNECTORS)} to it by hand to keep xAI automations out of somora agents` });
  return 'left';
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
