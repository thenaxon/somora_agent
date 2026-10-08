// The platform floors (Node.js, glibc) and the guard that enforces them at
// install time. Two jobs: the npm `preinstall` gate must stay wired up, and
// raising a floor must not leave texts behind that name the old systems.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain ESM without types
import { preinstallProblem } from '../bin/preinstall-check.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const minNode = String(pkg.engines.node).replace(/^>=/, '');

test('the preinstall gate is wired up and shipped', () => {
  assert.equal(pkg.scripts.preinstall, 'node bin/preinstall-check.mjs');
  assert.ok(pkg.files.includes('bin'), 'bin/ must be in the published files');
  assert.match(pkg.engines.node, /^>=\d+\.\d+\.\d+$/);
  assert.match(pkg.somora.glibc, /^\d+\.\d+$/);
  assert.match(pkg.somora.lastForOlderGlibc, /^\d{4}\.\d+\.\d+$/);
});

test('the gate refuses an old glibc or Node and names the way out; it passes macOS and good systems', () => {
  const glibc = preinstallProblem({ pkg, node: minNode, glibc: '2.31' });
  assert.match(glibc, /Nothing was installed/);
  assert.match(glibc, new RegExp(`npm install -g somora@${pkg.somora.lastForOlderGlibc.replace(/\./g, '\\.')}`));
  const node = preinstallProblem({ pkg, node: '20.11.0', glibc: '2.39' });
  assert.match(node, /needs Node\.js/);
  assert.match(node, /Nothing was installed/);
  assert.equal(preinstallProblem({ pkg, node: minNode, glibc: null }), null, 'macOS and musl report no glibc');
  assert.equal(preinstallProblem({ pkg, node: '26.10.0', glibc: pkg.somora.glibc }), null);
});

test('README, setup guide and installer name the current floors', () => {
  for (const f of ['README.md', 'docs/setup.md', 'install.sh']) {
    const text = readFileSync(f, 'utf8');
    assert.ok(text.includes(minNode), `${f} does not name Node ${minNode}`);
  }
  for (const f of ['README.md', 'docs/setup.md']) {
    assert.ok(readFileSync(f, 'utf8').includes(pkg.somora.glibc), `${f} does not name glibc ${pkg.somora.glibc}`);
  }
});

test('a changed floor is a conscious step (update every text that names systems)', () => {
  // When this fails you raised a floor in package.json. Before changing the
  // values below, update: the systems named in bin/node-version.mjs
  // (glibcUpgradeHint) and bin/somora.mjs, README "Requirements", the
  // setup guide (supported systems, requirements, update steps,
  // troubleshooting), install.sh, docs/models.md, and the release notes'
  // "Before you update" block. Set somora.lastForOlderGlibc to the last
  // release that still runs below a new glibc floor.
  assert.deepEqual(
    { node: pkg.engines.node, glibc: pkg.somora.glibc, lastForOlderGlibc: pkg.somora.lastForOlderGlibc },
    { node: '>=22.22.2', glibc: '2.34', lastForOlderGlibc: '2026.1007.2' },
  );
});
