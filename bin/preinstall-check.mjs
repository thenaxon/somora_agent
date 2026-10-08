// npm `preinstall` gate: runs before npm puts this version in place, on
// the machine it is meant for. On a Linux whose glibc is older than the
// prebuilt native modules need, or on a Node.js below `engines.node`
// (npm only warns about that), it fails, and npm keeps the version that
// was installed before. Without it an older `somora update` (2026.1007.2
// and earlier check Node only) installed a release that cannot start and
// left the service broken until the user went back by hand.
//
// The floors live in package.json (`engines.node`, `somora.glibc`,
// `somora.lastForOlderGlibc`); raising one there is all this needs.
// src/platform-floors.test.mts trips when they change, as a reminder to
// update the texts that name systems and versions. Plain ESM, no deps:
// it must run on the old Node it may reject.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { glibcVersion, satisfiesGlibc, satisfiesNode } from './node-version.mjs';

/** Why this machine cannot take this version, or null when it can. */
export function preinstallProblem({ pkg, node, glibc }) {
  const range = pkg?.engines?.node;
  if (range && !satisfiesNode(range, node)) {
    return [
      `somora ${pkg.version} needs Node.js ${range}; this machine has v${node}.`,
      'Nothing was installed: the version you had stays in place.',
      'Update Node.js first (https://nodejs.org or your package manager), then install again.',
      '',
    ].join('\n');
  }
  const min = pkg?.somora?.glibc;
  if (min && !satisfiesGlibc(min, glibc)) {
    const last = pkg?.somora?.lastForOlderGlibc;
    return [
      `somora ${pkg.version} needs Linux with glibc ${min} or newer; this machine has glibc ${glibc}.`,
      'Nothing was installed: the version you had stays in place.',
      ...(last ? [`The last version that runs here is ${last}:  npm install -g somora@${last}`] : []),
      'Or move to a newer Linux release; your ~/.somora folder carries over unchanged.',
      '',
    ].join('\n');
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const problem = preinstallProblem({ pkg, node: process.versions.node, glibc: glibcVersion() });
    if (problem) {
      process.stderr.write(problem);
      process.exit(1);
    }
  } catch {
    // An unreadable package.json is npm's problem to report, not ours.
  }
}
