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

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
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
  //
  // Migration:
  //   Pre-2026-05-16 installs (and a few suspected claude-cli atomic-write
  //   replacements) left a real *file* at credDst instead of a symlink.
  //   Those silently drift away from `~/.claude/.credentials.json` after
  //   the user does `/login`, so somora keeps using the old account
  //   without surfacing it. We migrate-on-boot using a safety ladder:
  //
  //     symlink           → no-op (honors operator-configured target)
  //     real file, same   → back up & convert to symlink (zero-risk fix)
  //     real file, diff   → warn loudly with the manual fix command;
  //                         don't touch (could be intentional isolation)
  //     no dst, has src   → symlink (fresh-install bootstrap)
  //     no dst, no src    → warn (user never ran `claude login`)
  const credSrc = join(homedir(), '.claude', '.credentials.json');
  const credDst = join(claudeConfigDir, '.credentials.json');
  let credentialsLinked = false;
  let credentialsMigrated = false;
  let credentialsDiverged = false;

  let dstStat: ReturnType<typeof lstatSync> | null = null;
  try {
    dstStat = lstatSync(credDst);
  } catch {
    dstStat = null;
  }
  const srcExists = existsSync(credSrc);

  if (dstStat?.isSymbolicLink()) {
    credentialsLinked = true;
  } else if (dstStat?.isFile()) {
    if (!srcExists) {
      // Standalone install: no user-level `~/.claude/.credentials.json`
      // to link to. Honor the local file as the single source of truth.
      credentialsLinked = true;
      logger.info({
        msg: 'claude_config_dir.credentials_standalone',
        path: credDst,
        hint: 'no ~/.claude/.credentials.json present; somora running on local credentials',
      });
    } else {
      let identical = false;
      try {
        identical = readFileSync(credDst, 'utf8') === readFileSync(credSrc, 'utf8');
      } catch (err) {
        logger.warn({
          msg: 'claude_config_dir.credentials_compare_fail',
          err: String(err),
        });
      }
      if (identical) {
        const backup = `${credDst}.somora-backup-${Date.now()}`;
        try {
          renameSync(credDst, backup);
          symlinkSync(credSrc, credDst);
          credentialsLinked = true;
          credentialsMigrated = true;
          logger.info({
            msg: 'claude_config_dir.credentials_relinked',
            backup,
            symlinkTo: credSrc,
            hint: 'replaced legacy real-file credentials with a symlink to ~/.claude/.credentials.json (content identical). future /login refreshes now propagate. backup preserved.',
          });
        } catch (err) {
          credentialsLinked = true;
          logger.warn({
            msg: 'claude_config_dir.credentials_relink_fail',
            err: String(err),
            hint: 'tried to convert real-file credentials to symlink but rename/symlink failed; somora keeps using the existing file',
          });
        }
      } else {
        credentialsLinked = true;
        credentialsDiverged = true;
        logger.warn({
          msg: 'claude_config_dir.credentials_diverged',
          somoraFile: credDst,
          userFile: credSrc,
          hint:
            'somora-home credentials differ from ~/.claude/.credentials.json. ' +
            'Most common cause: you ran `/login` in the regular claude CLI but somora is still on the previous account (silent failure mode). ' +
            `To make user-level /login propagate to somora, run: mv ${credDst} ${credDst}.backup-$(date +%s) && ln -sf ${credSrc} ${credDst} && (restart somora). ` +
            'If the divergence is intentional (somora deliberately on a separate claude account), ignore this warning.',
        });
      }
    }
  } else if (srcExists) {
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
    credentialsMigrated,
    credentialsDiverged,
    hint: 'somora-spawned claude-cli subprocesses are isolated from ~/.claude',
  });
}
