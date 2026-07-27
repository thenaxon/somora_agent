// `somora auth` — visibility + manual control for the shared claude-cli
// login (see src/server/claude-credential-sync.ts for the mechanism).
//
//   somora auth status   read-only view of both credential stores
//   somora auth sync     one-shot reconcile (what the running server's
//                        watcher does continuously)
//
// Deliberately logger-free and side-effect-free on `status`: the config
// file is read raw (js-yaml, no schema validation, no default-config
// bootstrap) just for the sharedUserCredentials gate.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import {
  configureClaudeCredentialSync,
  credentialSyncStatus,
  reconcileClaudeCredentials,
} from '../server/claude-credential-sync.ts';

function sharedCredentialsEnabled(): boolean {
  const somoraHome = process.env.SOMORA_HOME ?? join(homedir(), '.somora');
  try {
    const raw = readFileSync(join(somoraHome, 'config.yaml'), 'utf8');
    const parsed = parseYaml(raw) as { claudeCli?: { sharedUserCredentials?: unknown } } | null;
    const v = parsed?.claudeCli?.sharedUserCredentials;
    return typeof v === 'boolean' ? v : true; // schema default
  } catch {
    return true;
  }
}

function fmtTs(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function usage(): string {
  return `somora auth — shared claude-cli login utilities

Usage:
  somora auth status   show both credential stores (mtime, OAuth expiry, divergence)
  somora auth sync     reconcile now (newest OAuth chain wins, other side is overwritten)
`;
}

export function runAuthCli(args: string[]): number {
  const cmd = args[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(usage());
    return 0;
  }

  const enabled = sharedCredentialsEnabled();
  configureClaudeCredentialSync({
    enabled,
    log: {
      info: (d) => process.stdout.write(`${JSON.stringify(d)}\n`),
      warn: (d) => process.stderr.write(`${JSON.stringify(d)}\n`),
    },
  });

  if (cmd === 'status') {
    const s = credentialSyncStatus();
    const now = Date.now();
    const side = (label: string, exists: boolean, mtime: number | null, exp: number | null): void => {
      process.stdout.write(`${label}\n`);
      if (!exists) {
        process.stdout.write('    (missing)\n');
        return;
      }
      const expState =
        exp === null ? 'unparseable' : exp > now ? `valid until ${fmtTs(exp)}` : `EXPIRED ${fmtTs(exp)}`;
      process.stdout.write(`    modified  ${fmtTs(mtime)}\n`);
      process.stdout.write(`    oauth     ${expState}\n`);
    };
    side(`  user   ${s.userPath}`, s.userExists, s.userMtimeMs, s.userExpiresAt);
    side(`  somora ${s.somoraPath}${s.somoraIsSymlink ? '  (symlink)' : ''}`, s.somoraExists, s.somoraMtimeMs, s.somoraExpiresAt);
    process.stdout.write(`  sharing   ${enabled ? 'enabled (claudeCli.sharedUserCredentials)' : 'DISABLED via config'}\n`);
    if (s.userExists && s.somoraExists) {
      if (s.identical) {
        process.stdout.write('  state     in sync — both sides share one OAuth chain\n');
      } else {
        const winner =
          (s.userExpiresAt ?? 0) === (s.somoraExpiresAt ?? 0)
            ? 'undecided (mtime tie-break)'
            : (s.userExpiresAt ?? 0) > (s.somoraExpiresAt ?? 0)
              ? 'user side'
              : 'somora side';
        process.stdout.write(`  state     DIVERGED — newest chain: ${winner}. Run \`somora auth sync\` (or let the running server's watcher heal it).\n`);
      }
    }
    return 0;
  }

  if (cmd === 'sync') {
    if (!enabled) {
      process.stderr.write(
        'claudeCli.sharedUserCredentials is disabled in config.yaml — somora runs on separate credentials by choice; refusing to sync.\n',
      );
      return 1;
    }
    const result = reconcileClaudeCredentials();
    const explain: Record<string, string> = {
      noop: 'already in sync (or nothing to sync)',
      pulled: 'user-side login copied onto the somora side',
      pushed: 'somora-side login copied back into ~/.claude',
      unavailable: 'sync failed — see warning above',
    };
    process.stdout.write(`${result}: ${explain[result] ?? result}\n`);
    return result === 'unavailable' ? 1 : 0;
  }

  process.stderr.write(`unknown auth subcommand: ${cmd}\n\n${usage()}`);
  return 1;
}
