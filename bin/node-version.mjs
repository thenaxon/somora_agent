// Node.js version gate shared by bin/somora.mjs (every command, before
// tsx even loads) and `somora update` (checks the TARGET release's
// requirement before building it). Plain ESM on purpose: it must run
// on the old Node we are about to reject, so no TypeScript, no deps.
//
// Why a hard gate: `engines.node` in package.json is only a warning
// for npm, so a user on Node 20 would install fine and then hit
// obscure failures deep inside a dependency (pdf-to-img 7, 2026-09-03).
// Failing at the door with the exact fix is kinder.

/** Parse the minimum version out of an engines range like ">=22.13.0". */
export function minimumNodeVersion(range) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(range ?? ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

/** true when `current` (e.g. process.versions.node) satisfies the range's minimum. */
export function satisfiesNode(range, current) {
  const min = minimumNodeVersion(range);
  const cur = minimumNodeVersion(current);
  if (!min || !cur) return true; // unparseable → don't block
  for (let i = 0; i < 3; i++) {
    if (cur[i] > min[i]) return true;
    if (cur[i] < min[i]) return false;
  }
  return true;
}

/** Human message with the fix, for stderr. */
export function nodeUpgradeHint(range, current, execPath) {
  return [
    `somora: Node.js ${range} is required, found v${current} (${execPath})`,
    '',
    '  Update Node.js, then run `somora init` again so the systemd service',
    '  picks up the new binary:',
    '    nvm:            nvm install 22 && nvm alias default 22',
    '    Debian/Ubuntu:  https://github.com/nodesource/distributions (Node 22 LTS)',
    '    macOS (brew):   brew install node@22',
    '',
    '  If the service still fails after upgrading, the unit is running an',
    '  older node from /usr/bin — `somora init` rewrites it.',
    '',
  ].join('\n');
}
