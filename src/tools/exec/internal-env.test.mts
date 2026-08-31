// Regression tests for the curated exec/tmux env (2026-08-26 report:
// `TSX_TSCONFIG_PATH` and `NODE_ENV` leaked from the somora server into
// an agent's `exec` shell and broke a user project's own tsx).
//
// Run: npx tsx src/tools/exec/internal-env.test.mts
//
// Two layers: the pure list/strip helpers, and a REAL spawn through
// localExecSync with the leaky vars seeded on this process — the same
// code path the exec tool dispatches to.

import assert from 'node:assert/strict';
import {
  isSomoraInternalEnv,
  SOMORA_INTERNAL_ENV_NAMES,
  somoraInternalEnvPresent,
  stripSomoraInternalEnv,
} from './internal-env.ts';
import { localExecSync } from './local.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ── pure helpers ────────────────────────────────────────────────────

for (const n of ['TSX_TSCONFIG_PATH', 'NODE_ENV', 'CLAUDE_CONFIG_DIR', 'SOMORA_CLAUDE_BIN', 'CLAUDECODE']) {
  check(`${n} is internal`, isSomoraInternalEnv(n));
}
check('CLAUDE_CODE_MESSAGING_TOKEN is internal (prefix)', isSomoraInternalEnv('CLAUDE_CODE_MESSAGING_TOKEN'));
check('CLAUDE_CODE_MESSAGING_SOCKET is internal (prefix)', isSomoraInternalEnv('CLAUDE_CODE_MESSAGING_SOCKET'));
// Things a user sets on purpose, or that skills rely on, must survive.
for (const n of [
  'SOMORA_AGENT',
  'SOMORA_SESSION',
  'SOMORA_ACTIVE_MODEL',
  'SOMORA_HOST',
  'SOMORA_PORT',
  'SOMORA_HOME',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'NODE_OPTIONS',
  'PATH',
  'HOME',
]) {
  check(`${n} is NOT internal`, !isSomoraInternalEnv(n));
}

{
  const env: NodeJS.ProcessEnv = {
    PATH: '/bin',
    TSX_TSCONFIG_PATH: '/x/tsconfig.json',
    NODE_ENV: 'production',
    CLAUDE_CODE_MESSAGING_TOKEN: 'abc',
    SOMORA_AGENT: 'hans',
  };
  const removed = stripSomoraInternalEnv(env);
  check('strip removes the three leaky vars', removed.sort().join(',') === 'CLAUDE_CODE_MESSAGING_TOKEN,NODE_ENV,TSX_TSCONFIG_PATH', removed.join(','));
  check('strip keeps PATH + SOMORA_AGENT', env.PATH === '/bin' && env.SOMORA_AGENT === 'hans');
  const present = somoraInternalEnvPresent({ NODE_ENV: 'test', FOO: 'bar', CLAUDE_CODE_MESSAGING_SOCKET: '/s' });
  check(
    'present() lists only internal vars with values',
    present.map(([k]) => k).sort().join(',') === 'CLAUDE_CODE_MESSAGING_SOCKET,NODE_ENV',
    JSON.stringify(present),
  );
  check('every listed name round-trips through isSomoraInternalEnv', SOMORA_INTERNAL_ENV_NAMES.every(isSomoraInternalEnv));
}

// ── real spawn through the exec code path ───────────────────────────

async function spawnChecks(): Promise<void> {
  process.env.TSX_TSCONFIG_PATH = '/tmp/somora-internal-env-test/tsconfig.json';
  process.env.NODE_ENV = 'production';
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'leak-me-not';
  process.env.SOMORA_AGENT = 'smokey';

  const probe = 'env | grep -E "^(TSX_TSCONFIG_PATH|NODE_ENV|CLAUDE_CODE_MESSAGING_TOKEN|SOMORA_AGENT)=" | sort';

  const stripped = await localExecSync({ command: probe, stripSomoraInternalEnv: true, timeoutMs: 10_000 });
  check('stripped spawn: exit 0', stripped.exit_code === 0, stripped.stderr);
  check('stripped spawn: TSX_TSCONFIG_PATH gone', !stripped.stdout.includes('TSX_TSCONFIG_PATH='), stripped.stdout);
  check('stripped spawn: NODE_ENV gone', !stripped.stdout.includes('NODE_ENV='), stripped.stdout);
  check('stripped spawn: messaging token gone', !stripped.stdout.includes('CLAUDE_CODE_MESSAGING_TOKEN='), stripped.stdout);
  check('stripped spawn: SOMORA_AGENT kept', stripped.stdout.includes('SOMORA_AGENT=smokey'), stripped.stdout);

  const inherited = await localExecSync({ command: probe, stripSomoraInternalEnv: false, timeoutMs: 10_000 });
  check('inherit spawn: TSX_TSCONFIG_PATH present', inherited.stdout.includes('TSX_TSCONFIG_PATH='), inherited.stdout);
  check('inherit spawn: NODE_ENV present', inherited.stdout.includes('NODE_ENV=production'), inherited.stdout);

  // An explicit `env:` from the agent still wins over the strip.
  const explicit = await localExecSync({
    command: 'echo "NODE_ENV=$NODE_ENV"',
    stripSomoraInternalEnv: true,
    env: { NODE_ENV: 'test' },
    timeoutMs: 10_000,
  });
  check('explicit env wins over strip', explicit.stdout.trim() === 'NODE_ENV=test', explicit.stdout);

  // pty path shares buildSpawnEnv — spot-check the headline var.
  const ptyRun = await localExecSync({
    command: 'sh -c \'echo "T=${TSX_TSCONFIG_PATH:-unset}"\'',
    stripSomoraInternalEnv: true,
    pty: true,
    timeoutMs: 10_000,
  });
  check('pty spawn: TSX_TSCONFIG_PATH unset', ptyRun.stdout.includes('T=unset'), ptyRun.stdout);
}

await spawnChecks();

console.log(`internal-env: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
