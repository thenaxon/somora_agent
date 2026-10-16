// A SOMORA_HOME of this test file's own. The test runner hands every file
// the same temporary home, and files run in parallel: a file that writes
// config.yaml, team.yaml or other shared files there must not be seen by
// the others. (isolated-home.mts keeps a test away from the real
// installation but trusts the runner's shared home; this one never shares.)
// Import it FIRST — ES modules run their imports in order, so everything
// imported after it sees the new home.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'somora-test-own-'));
process.env.SOMORA_HOME = home;
process.env.CLAUDE_CONFIG_DIR = join(home, 'claude-home');

export const OWN_HOME = home;
