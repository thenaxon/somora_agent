// Run: npx tsx src/wiki/index-builder.test.mts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-index-cut-'));
const { cutDescription } = await import('./index-builder.ts');
let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) pass++;
  else {
    fail++;
    console.error(`FAIL: ${n} ${d}`);
  }
};
const long = 'Der Host. Siehe auch die Seite ' + 'x'.repeat(80) + ' und [[infrastruktur/hosts/gpu-box|Gpu-box]] dazu.';
const cut = cutDescription(long, 120);
check('cut lands before a link that would be split', !cut.includes('[[') && cut.endsWith('…') && cut.length <= 121, cut);
check('short text untouched', cutDescription('kurz', 120) === 'kurz');
check('a link that fits stays whole', cutDescription('Siehe [[a/b|B]] und mehr Text hier.', 120) === 'Siehe [[a/b|B]] und mehr Text hier.');
const inside = 'a'.repeat(110) + ' [[personen/mark-beispiel|Mark]] Ende';
check('link starting before the cut is dropped whole', !cutDescription(inside, 120).includes('[['), cutDescription(inside, 120));
console.log(`index cut: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
