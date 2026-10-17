// install.sh shows a spinner while a step runs, only on a terminal. Its
// stop killed the spinner and waited for it: wait reports 143 for a
// killed job, and under `set -e` that ended the installer wherever a
// step ran outside an `if` — choosing "Node into your home folder" in a
// terminal stopped right after "unpacking Node" (release rehearsal
// 2026-10-17). Run on a real pseudo-terminal through script(1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sh = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'install.sh'), 'utf8');
const hasScript = spawnSync('script', ['--version']).status === 0;

/** The installer's helpers from `info()` through `ui_fail_tail`. */
function helpers(): string {
  const lines = sh.split('\n');
  const pick = (re: RegExp) => lines.find((l) => re.test(l)) ?? '';
  const from = lines.findIndex((l) => l.startsWith('SPIN_PID='));
  const to = lines.findIndex((l) => l.startsWith('ui_fail_tail()'));
  return [pick(/^info\(\)/), ...lines.slice(from, to + 1)].join('\n');
}

test('a step on a terminal does not end the installer when its spinner stops', { skip: !hasScript && 'needs script(1)' }, () => {
  const body = `set -euo pipefail\n${helpers()}\nDIM= RST=\nquiet "a step" sleep 0.3\necho survived`;
  const out = execFileSync('script', ['-qec', `bash -c '${body.replace(/'/g, `'\\''`)}'`, '/dev/null'], { encoding: 'utf8' });
  assert.match(out, /survived/);
});
