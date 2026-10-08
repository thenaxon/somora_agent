// `somora grok [args...]` — run the Grok CLI that ships with somora.
//
// The Grok CLI is a pinned optional dependency (see engine/grok-bin.ts),
// so there need not be a `grok` on the host. It runs with somora's own
// Grok home: `somora grok login` signs in there, and the login is kept in
// step with ~/.grok when you use Grok yourself too (engine/grok-home.ts).

import { spawnSync } from 'node:child_process';
import { resolveGrokLaunch } from '../engine/grok-bin.ts';
import { grokAuthExpiry, grokChildEnv, somoraGrokHome, syncGrokHome, userGrokHome } from '../engine/grok-home.ts';
import { join } from 'node:path';

export async function runGrokCli(args: string[]): Promise<number> {
  syncGrokHome();
  const launch = await resolveGrokLaunch();
  const label =
    launch.source === 'bundled'
      ? `bundled @xai-official/grok ${launch.version ?? '?'}`
      : launch.source === 'override'
        ? `override ${launch.bin}`
        : `${launch.bin} (no bundled binary for ${process.platform}-${process.arch})`;
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    const expiry = grokAuthExpiry(join(somoraGrokHome(), 'auth.json'));
    process.stdout.write(
      [
        `somora grok — Grok Build CLI (${label})`,
        '',
        'Usage: somora grok <grok args...>',
        '  somora grok login                 sign in with your Grok subscription (opens a browser)',
        '  somora grok login --device-auth   sign in with a code, for a machine without a browser',
        '  somora grok logout',
        '  somora grok models                models your subscription offers',
        '  somora grok --version',
        '',
        `Grok home (somora): ${somoraGrokHome()}`,
        `Grok home (yours):  ${userGrokHome()}  (login kept in step when you use Grok yourself)`,
        `Login:              ${expiry > 0 ? `valid until ${new Date(expiry).toISOString().replace('T', ' ').slice(0, 16)} UTC (renewed by Grok)` : 'none — run `somora grok login`'}`,
        '',
      ].join('\n'),
    );
    return 0;
  }
  const result = spawnSync(launch.bin, args, { stdio: 'inherit', env: grokChildEnv() });
  if (result.error) {
    process.stderr.write(`somora grok: ${result.error.message}\n`);
    return 1;
  }
  const sync = syncGrokHome();
  if (args[0] === 'login' && sync.action === 'pushed') {
    process.stdout.write(`somora: the new Grok login was also copied to ${sync.userAuthPath}\n`);
  }
  return result.status ?? 1;
}
