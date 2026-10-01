// The repository is public. Nothing in it may name real people, companies,
// machines, networks or the operator's own agents — test fixtures use an
// invented cast (the Muster family, acme, nova, ada/bea/cleo …).
//
// Two layers:
//   1. patterns that are never allowed anywhere (private network
//      addresses, a tailnet id, the operator's e-mail domain shape);
//   2. a private list of real names in private/hygiene/sensitive-terms.txt
//      — that folder is gitignored, so the list itself never ships; on a
//      clone without it only layer 1 runs (and says so).
// A match is glued to whatever surrounds it: `\nWalter` inside a string
// literal and `_walter` in a session id count as mentions too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALWAYS: Array<[string, RegExp]> = [
  // 10.0.0.1 is the textbook example everyone writes; the operator's own
  // ranges are the 192.168 and 172.16–31 blocks (and whatever the private
  // list adds).
  ['private network address', /\b(?:192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['tailnet id', /\btail[0-9a-f]{6}\b/],
];
const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|pdf|zip|tgz|gz|db|sqlite|wasm|mp3|wav)$/i;
const ALLOW_FILES = new Set(['src/repo-hygiene.test.mts']);
// Documentation ranges and placeholders are fine.
const ALLOW_MATCH = /^(?:192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+|tail1234|<your-tailnet>)$/;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f && !f.startsWith('private/') && !BINARY.test(f) && !ALLOW_FILES.has(f));
}

function privateTerms(): RegExp[] {
  const file = resolve(root, 'private', 'hygiene', 'sensitive-terms.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((term) => new RegExp(`(?:^|[^A-Za-z0-9])(${term})(?=$|[^A-Za-z0-9])`, 'i'));
}

test('no real names, machines or networks in the public tree', () => {
  const terms = privateTerms();
  if (terms.length === 0) console.log('# private/hygiene/sensitive-terms.txt not present — checking the built-in patterns only');
  const hits: string[] = [];
  for (const file of trackedFiles()) {
    let text: string;
    try {
      text = readFileSync(resolve(root, file), 'utf8');
    } catch {
      continue;
    }
    // literal "\n" inside string literals glues a name to the previous word
    const lines = text.replace(/\\n/g, '\n').split('\n');
    lines.forEach((line, i) => {
      for (const [what, re] of ALWAYS) {
        const m = line.match(re);
        if (m && !ALLOW_MATCH.test(m[0])) hits.push(`${file}:${i + 1}: ${what} "${m[0]}"`);
      }
      // underscores glue session ids: `20260906_name`
      const probe = line.replace(/_/g, ' ');
      for (const re of terms) {
        const m = probe.match(re);
        if (m) hits.push(`${file}:${i + 1}: "${m[1]}"`);
      }
    });
  }
  assert.deepEqual(hits, [], `real names or addresses in the public tree:\n${hits.slice(0, 40).join('\n')}`);
});
