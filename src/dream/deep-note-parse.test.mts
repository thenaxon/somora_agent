// Run: npx tsx src/dream/deep-note-parse.test.mts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-note-parse-'));
const { parseMemoryNote } = await import('./deep-runner.ts');
let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) pass++;
  else {
    fail++;
    console.error(`FAIL: ${n} ${d}`);
  }
};
const good = "---\nname: x\ncreated: '2026-09-26'\ntags:\n  - a\n---\n\nBody.\n";
const g = parseMemoryNote(good, 'p');
check('valid header parsed strictly', g.data.name === 'x' && Array.isArray(g.data.tags) && g.content.trim() === 'Body.');
// a header the YAML parser rejects: an unquoted value with ": " inside a flow context
const bad = "---\ncreated: '2026-09-26'\ndescription: [unclosed\nupdated: '2026-09-27'\n---\n\n- **Kommunikationsstil:** locker\n\nText.\n";
const b = parseMemoryNote(bad, 'p');
check('broken header → lenient keys and full body', b.data.created === '2026-09-26' && b.data.updated === '2026-09-27' && b.content.includes('Kommunikationsstil') && b.content.includes('Text.'), JSON.stringify(b).slice(0, 200));
const none = parseMemoryNote('no header at all\n', 'p');
check('no header → empty data, whole text', Object.keys(none.data).length === 0 && none.content.startsWith('no header'));
console.log(`deep note parse: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
