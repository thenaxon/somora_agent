// A broken config.yaml must not stop every turn: the per-turn reload
// keeps the last valid config, remembers the problem, and recovers as
// soon as the file validates again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = join(tmpdir(), `somora-last-good-${process.pid}`);
mkdirSync(home, { recursive: true });
process.env.SOMORA_HOME = home;
const file = join(home, 'config.yaml');
const { currentConfigProblem, getFreshConfig, primeFreshConfig, validateConfigText, loadConfig } = await import('./loader.ts');

const valid = (port: number) => `server:\n  port: ${port}\nproviders: {}\n`;
let tick = 0;
/** Write and move the mtime forward, so every write counts as a change. */
const write = (text: string) => {
  writeFileSync(file, text);
  tick += 10;
  const t = new Date(Date.now() + tick * 1000);
  utimesSync(file, t, t);
};

test('validateConfigText names every problem and never throws', () => {
  assert.equal(validateConfigText(valid(1234)).ok, true);
  const bad = validateConfigText('server:\n  port: "abc"\nproviders: {}\n');
  assert.equal(bad.ok, false);
  assert.ok(!bad.ok && bad.issues.some((i) => i.path === 'server.port'));
  const yaml = validateConfigText('server: [unclosed');
  assert.ok(!yaml.ok && yaml.issues[0]!.path === '(yaml)');
});

test('a broken edit keeps the last valid config; fixing it recovers', async () => {
  write(valid(1111));
  const boot = await loadConfig();
  primeFreshConfig(boot, 0);
  write(valid(2222));
  assert.equal((await getFreshConfig()).server.port, 2222);
  assert.equal(currentConfigProblem(), null);

  write('server:\n  port: "not a number"\nproviders: {}\n');
  const kept = await getFreshConfig();
  assert.equal(kept.server.port, 2222, 'last valid config stays in use');
  const p1 = currentConfigProblem();
  assert.ok(p1 && /server\.port/.test(p1.message));
  // Asking again without a change: same problem, same since.
  await getFreshConfig();
  assert.equal(currentConfigProblem()!.since, p1!.since);

  write('server: [broken yaml');
  assert.equal((await getFreshConfig()).server.port, 2222);
  assert.notEqual(currentConfigProblem()!.mtimeMs, p1!.mtimeMs, 'a new broken version is a new problem');

  write(valid(3333));
  assert.equal((await getFreshConfig()).server.port, 3333);
  assert.equal(currentConfigProblem(), null);
});
