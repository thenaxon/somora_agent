// Tests for systemd-unit build + custom-env preservation (2026-07-23).
//
// Run: npx tsx src/cli/systemd-unit.test.mts
//
// Regression (Lucy report): `somora update` rebakes the systemd unit from
// a static template and silently dropped operator-added `Environment=` /
// `EnvironmentFile=` lines — most damagingly `SOMORA_HOST=0.0.0.0`, which
// left the server bound to the loopback default and locked out
// LAN/Tailscale clients. extractCustomEnvLines + buildSystemdUnit carry
// those lines across the rebake.

import assert from 'node:assert/strict';

import { buildSystemdUnit, extractCustomEnvLines } from './systemd-unit.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const BIN = '/home/u/.npm-global/lib/node_modules/somora/bin/somora.mjs';

// ── a fresh template has no custom env ────────────────────────────────
{
  const fresh = buildSystemdUnit(BIN);
  check('template has NODE_ENV', fresh.includes('Environment=NODE_ENV=production'));
  check('template ExecStart uses bin path', fresh.includes(`ExecStart=${BIN} server start --foreground`));
  check('fresh template yields no custom env', extractCustomEnvLines(fresh).length === 0);
}

// ── the regression: SOMORA_HOST survives a rebake ─────────────────────
{
  // Simulate an operator-edited unit (host + creds env-file).
  const edited = [
    '[Unit]',
    'Description=somora — Local-first AI agent gateway',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=/old/path/somora.mjs server start --foreground`,
    'Restart=on-failure',
    'RestartSec=5',
    'Environment=NODE_ENV=production',
    'Environment=SOMORA_HOST=0.0.0.0',
    'EnvironmentFile=-/home/u/.config/systemd/user/somora.env',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');

  const custom = extractCustomEnvLines(edited);
  check('extracts SOMORA_HOST line', custom.includes('Environment=SOMORA_HOST=0.0.0.0'));
  check('extracts EnvironmentFile line', custom.includes('EnvironmentFile=-/home/u/.config/systemd/user/somora.env'));
  check('excludes template NODE_ENV', !custom.some((l) => l.includes('NODE_ENV')));
  check('exactly 2 custom lines', custom.length === 2, `${custom.length}`);

  // Rebake with a NEW bin path but preserved env.
  const rebaked = buildSystemdUnit(BIN, custom);
  check('rebake keeps SOMORA_HOST', rebaked.includes('Environment=SOMORA_HOST=0.0.0.0'));
  check('rebake keeps EnvironmentFile', rebaked.includes('EnvironmentFile=-/home/u/.config/systemd/user/somora.env'));
  check('rebake updates the bin path', rebaked.includes(`ExecStart=${BIN} `) && !rebaked.includes('/old/path/'));
  check('custom env sits after NODE_ENV, before [Install]', /NODE_ENV=production\nEnvironment=SOMORA_HOST=0\.0\.0\.0\nEnvironmentFile=[^\n]*\n\n\[Install\]/.test(rebaked));
}

// ── idempotent: rebake→extract→rebake is stable ───────────────────────
{
  const custom = ['Environment=SOMORA_HOST=0.0.0.0'];
  const once = buildSystemdUnit(BIN, custom);
  const twice = buildSystemdUnit(BIN, extractCustomEnvLines(once));
  check('rebake is idempotent', once === twice);
}

// ── ignores unrelated lines + whitespace ──────────────────────────────
{
  const messy = '[Service]\n  Environment=FOO=bar \nExecStart=/x\n#Environment=COMMENT=1\nRestart=on-failure';
  const custom = extractCustomEnvLines(messy);
  check('trims + keeps real Environment', custom.includes('Environment=FOO=bar'));
  check('ignores commented + non-env lines', custom.length === 1, JSON.stringify(custom));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
