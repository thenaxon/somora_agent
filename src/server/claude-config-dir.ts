// Isolate the claude-agent-sdk's config tree from the user's interactive
// Claude Code state.
//
// Why this exists
//   The claude binary that the SDK spawns reads from `~/.claude/` by
//   default — same dir the user's interactive `claude` CLI uses. That
//   coupling causes two distinct problems:
//
//   1. Auto-update corruption. Anthropic's launcher silently upgrades
//      the user's binary in the background. If a new version migrates
//      `~/.claude/`'s schema, the *somora-side* spawn — which may pin
//      an older binary — can no longer parse the migrated state. We
//      lived through this on 2026-05-16: a 2.1.143 auto-update broke
//      somora's MCP tool registration even after we pinned back to
//      2.1.141. The state, not the binary, was the regression carrier.
//
//   2. Cross-contamination. The user's interactive Claude Code sessions
//      (project history, plugin marketplace state, shell snapshots,
//      etc.) appear inside any somora-spawned subprocess. That's a
//      privacy + predictability problem we never wanted.
//
// What this does
//   Auto-creates `~/.somora/claude-home/` on server boot and sets
//   `process.env.CLAUDE_CONFIG_DIR` so every claude-cli subprocess
//   spawned by the SDK reads/writes its own state there.
//
//   Login sharing with the user's interactive CLI lives in
//   `claude-credential-sync.ts` (content-sync + runtime watcher; the
//   former symlink design could not survive the CLI's rename-based
//   token-refresh writes). It runs config-gated after loadConfig —
//   this bootstrap stays credential-agnostic apart from a visibility
//   warning when no login exists anywhere.
//
// Operator escape hatch
//   If the user sets `CLAUDE_CONFIG_DIR` externally (env or
//   `~/.somora/somora.env`), we honor that and only ensure the dir
//   exists. Advanced setups (shared multi-host config, custom auth
//   provider) can point this anywhere.

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger, SOMORA_HOME_DIR } from './logger.ts';

export function setupClaudeConfigDir(): void {
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.length > 0
      ? process.env.CLAUDE_CONFIG_DIR
      : join(SOMORA_HOME_DIR, 'claude-home');
  mkdirSync(claudeConfigDir, { recursive: true });

  const credSrc = join(homedir(), '.claude', '.credentials.json');
  const credDst = join(claudeConfigDir, '.credentials.json');
  if (!existsSync(credSrc) && !existsSync(credDst)) {
    logger.warn({
      msg: 'claude_config_dir.credentials_missing',
      expected: credSrc,
      hint: 'no claude login found anywhere; claude-cli engine will fail until the user runs `claude login`',
    });
  }

  // Propagate to the spawned children. The claude-agent-sdk reads
  // CLAUDE_CONFIG_DIR from its inherited env, so just setting it on
  // the somora server process is enough — every subprocess inherits.
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  logger.info({
    msg: 'claude_config_dir.ready',
    path: claudeConfigDir,
    hint: 'somora-spawned claude-cli subprocesses are isolated from ~/.claude',
  });
}
