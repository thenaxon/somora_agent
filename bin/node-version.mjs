// Node.js version gate shared by bin/somora.mjs (every command, before
// tsx even loads) and `somora update` (checks the TARGET release's
// requirement before building it). Plain ESM on purpose: it must run
// on the old Node we are about to reject, so no TypeScript, no deps.
//
// Why a hard gate: `engines.node` in package.json is only a warning
// for npm, so a user on Node 20 would install fine and then hit
// obscure failures deep inside a dependency (pdf-to-img 7, 2026-09-03).
// Failing at the door with the exact fix is kinder.

/** Parse the minimum version out of an engines range like ">=22.22.2". */
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

// glibc gate. Native modules ship prebuilt for one glibc floor
// (better-sqlite3 13: glibc 2.34 — Debian 12, Ubuntu 22.04, RHEL 9) and
// have no compile fallback, so an older Linux would fail with a dlopen
// error deep inside the memory index. package.json `somora.glibc` is
// the floor; `somora.lastForOlderGlibc` the last release that still
// runs below it. musl and non-Linux report no glibc and pass.

/** Runtime glibc version on Linux ("2.36"), else null. */
export function glibcVersion() {
  if (process.platform !== 'linux') return null;
  try {
    const v = process.report?.getReport?.()?.header?.glibcVersionRuntime;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** true when `current` glibc is at least `min`; unknown either way → true. */
export function satisfiesGlibc(min, current) {
  if (!min || !current) return true;
  return satisfiesNode(String(min), String(current));
}

/** Human message with the way out, for stderr. */
export function glibcUpgradeHint(min, current, fallbackVersion) {
  return [
    `somora: this version needs Linux with glibc ${min} or newer (Debian 12, Ubuntu 22.04, RHEL 9 or later); this machine has glibc ${current}.`,
    '',
    ...(fallbackVersion
      ? [
          '  Go back to the last version that runs here, then restart:',
          `    npm install -g somora@${fallbackVersion} && somora server restart`,
          '',
        ]
      : []),
    '  Or move to a newer Linux release; your ~/.somora folder carries over unchanged.',
    '',
  ].join('\n');
}
