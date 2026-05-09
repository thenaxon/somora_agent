// Single source of truth for the running somora version.
//
// Reads package.json at module load. We resolve the package.json path
// from `import.meta.url` (this file's location) so it works both from
// the dev tree and from the npm-installed location under
// ~/.npm-global/lib/node_modules/somora/.
//
// Version format follows DECISIONS #41 (CalVer YYYY.MM.DD.N).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, '..', 'package.json');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };

export const SOMORA_VERSION: string = pkg.version;
