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
//   Auto-creates `~/.somora/claude-home/` on server boot, symlinks the
//   user's `.credentials.json` into it (so OAuth token refreshes stay
//   in sync — one source of truth for auth), and sets
//   `process.env.CLAUDE_CONFIG_DIR` so every claude-cli subprocess
//   spawned by the SDK reads/writes its own state there.
//
//   Idempotent: re-runs on every boot are no-ops once the tree exists.
//
// Operator escape hatch
//   If the user sets `CLAUDE_CONFIG_DIR` externally (env or
//   `~/.somora/somora.env`), we honor that and only ensure the dir
//   exists. Advanced setups (shared multi-host config, custom auth
//   provider) can point this anywhere.

import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger, SOMORA_HOME_DIR } from './logger.ts';

export function setupClaudeConfigDir(): void {
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_CONFIG_DIR.length > 0
      ? process.env.CLAUDE_CONFIG_DIR
      : join(SOMORA_HOME_DIR, 'claude-home');
  mkdirSync(claudeConfigDir, { recursive: true });
  // Share auth credentials with the user's interactive Claude Code so
  // login state is one source of truth. Symlink — not copy — so token
  // refresh writes by either side propagate to the other automatically.
  // If the user has never run `claude login`, the source file doesn't
  // exist yet; log a hint and continue. The first claude-cli engine
  // call will then fail with a clear auth error rather than this
  // bootstrap blowing up.
  const credSrc = join(homedir(), '.claude', '.credentials.json');
  const credDst = join(claudeConfigDir, '.credentials.json');
  let credentialsLinked = false;
  if (existsSync(credDst)) {
    // Already linked (or replaced by operator with a real file). Don't
    // touch — operator may have intentionally diverged.
    credentialsLinked = true;
  } else if (existsSync(credSrc)) {
    try {
      symlinkSync(credSrc, credDst);
      credentialsLinked = true;
    } catch (err) {
      logger.warn({
        msg: 'claude_config_dir.credentials_symlink_fail',
        src: credSrc,
        dst: credDst,
        err: String(err),
        hint: 'claude-cli engine will likely fail with auth errors; run `claude login` and restart somora',
      });
    }
  } else {
    logger.warn({
      msg: 'claude_config_dir.credentials_missing',
      expected: credSrc,
      hint: 'user has never run `claude login`; claude-cli engine will fail until they do',
    });
  }
  // Propagate to the spawned children. The claude-agent-sdk reads
  // CLAUDE_CONFIG_DIR from its inherited env, so just setting it on
  // the somora server process is enough — every subprocess inherits.
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  logger.info({
    msg: 'claude_config_dir.ready',
    path: claudeConfigDir,
    credentialsLinked,
    hint: 'somora-spawned claude-cli subprocesses are isolated from ~/.claude',
  });
}
