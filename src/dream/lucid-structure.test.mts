// Structure findings only where the template applies; the hint once
// elsewhere; the parser drops misfiled findings from a grown wiki.
// Run: npx tsx src/dream/lucid-structure.test.mts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-lucid-structure-'));
const { structuralFindings } = await import('./lucid-structure.ts');
const { parseLucidFindings } = await import('./lucid-runner.ts');
const { buildLucidSystemPrompt } = await import('./lucid-prompt.ts');
let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
  if (c) pass++;
  else {
    fail++;
    console.error(`FAIL: ${n} ${d}`);
  }
};
const pages = [
  { wikiPath: 'projekte/somora', markdown: 'x'.repeat(100_000) },
  { wikiPath: 'projekte/klein', markdown: 'y'.repeat(2_000) },
  { wikiPath: 'infrastruktur/hosts/cerebro', markdown: 'z'.repeat(70_000) },
];
const grown = structuralFindings(pages, { migrated: false, templateVersion: 0, oversizedChars: 50_000 }, 1);
check('grown wiki: exactly one hint, nothing else', grown.length === 1 && grown[0]!.kind === 'not_migrated' && grown[0]!.fix.kind === 'no_op' && /somora wiki migrate/.test(grown[0]!.reason));
const mig = structuralFindings(pages, { migrated: true, templateVersion: 1, oversizedChars: 50_000 }, 5);
check('template wiki: oversized pages, biggest first, ids continue', mig.length === 2 && mig[0]!.kind === 'oversized_page' && mig[0]!.affected_pages[0] === 'projekte/somora' && mig[0]!.id === 5 && mig[1]!.id === 6 && /98 KB/.test(mig[0]!.reason));
check('template wiki: no hint', !mig.some((f) => f.kind === 'not_migrated'));
const reply = JSON.stringify({ findings: [
  { kind: 'duplicate_page', affected_pages: ['wissen/a', 'wissen/a-release'], reason: 'same release' },
  { kind: 'misfiled_page', affected_pages: ['wissen/rene-regel'], reason: 'a rule → regeln' },
  { kind: 'oversized_page', affected_pages: ['x'], reason: 'model may not file this' },
  { kind: 'contradiction', affected_pages: ['a', 'b'], reason: 'dates differ' },
] });
const m = parseLucidFindings(reply, 'r', { migrated: true })!;
check('template wiki: duplicate + misfiled accepted, oversized from the model dropped', m.map((f) => f.kind).join(',') === 'duplicate_page,misfiled_page,contradiction');
const g = parseLucidFindings(reply, 'r', { migrated: false })!;
check('grown wiki: misfiled dropped, duplicate kept', g.map((f) => f.kind).join(',') === 'duplicate_page,contradiction');
check('default keeps the old behaviour for archived callers', parseLucidFindings(reply, 'r')!.length === 3);
const pm = buildLucidSystemPrompt(undefined, { migrated: true });
const pg = buildLucidSystemPrompt(undefined, { migrated: false });
check('prompt: misfiled only for template wikis, duplicate always', pm.includes('MISFILED_PAGE') && !pg.includes('MISFILED_PAGE') && pg.includes('DUPLICATE_PAGE') && pm.includes('beyond a MISFILED_PAGE finding'));
console.log(`lucid structure: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
{
  const { capFindings } = await import('./lucid-structure.ts');
  const mk = (id: number, kind: string) => ({ id, kind, status: 'pending', affected_pages: [], reason: 'r', fix: { kind: 'no_op', note: '' } }) as never;
  const many = [mk(1, 'link_suggestion'), mk(2, 'contradiction'), mk(3, 'link_suggestion'), mk(4, 'dead_ref'), mk(5, 'duplicate_page'), mk(6, 'link_suggestion'), mk(7, 'wanted_page'), mk(8, 'misfiled_page')];
  const c = capFindings(many, 5);
  check('cap keeps the weighty kinds and renumbers nothing here', c.kept.map((f: { kind: string }) => f.kind).join(',') === 'contradiction,dead_ref,duplicate_page,wanted_page,misfiled_page' && c.dropped.link_suggestion === 3);
  check('under the cap nothing changes', capFindings(many, 8).kept.length === 8 && Object.keys(capFindings(many, 8).dropped).length === 0);
  const mkp = (id: number, kind: string, pages: string[]) => ({ id, kind, status: 'pending', affected_pages: pages, reason: 'r', fix: { kind: 'no_op', note: '' } }) as never;
  const twice = [mkp(1, 'duplicate_page', ['projekte/a', 'projekte/b']), mkp(2, 'duplicate_page', ['Projekte/B', 'projekte/a']), mkp(3, 'contradiction', ['projekte/a', 'projekte/b'])];
  const d = capFindings(twice, 60);
  check('the same pair filed twice is kept once, another kind on the same pages stays', d.kept.length === 2 && d.duplicates === 1);
}
console.log(`lucid structure (cap): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
