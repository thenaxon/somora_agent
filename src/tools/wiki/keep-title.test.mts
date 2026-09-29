// Run: npx tsx src/tools/wiki/keep-title.test.mts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-keep-title-'));
const { keepTitle } = await import('./tools.ts');
let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) pass++;
  else {
    fail++;
    console.error(`FAIL: ${n} ${d}`);
  }
};
check('title kept when the new body has none', keepTitle('\n# Skill peekaboo\n\n## Stand\nalt\n', '## Stand\nneu\n') === '\n# Skill peekaboo\n\n## Stand\nneu\n');
check('a new H1 in the body wins', keepTitle('\n# Alt\n\n## Stand\n', '# Neu\n\n## Stand\n') === '\n# Neu\n\n## Stand\n');
check('no title before, none added', keepTitle('\n## Stand\nalt\n', '## Stand\nneu') === '\n## Stand\nneu');
check('leading newline normalised', keepTitle('\n# T\n', '\n## S\n') === '\n# T\n\n## S\n');
console.log(`keep title: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
