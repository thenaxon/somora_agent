// Deep only rewrites a wiki page it has fully read, in the state it
// read it; and only deletes the memory note it actually read.
//
// Run: npx tsx src/dream/deep-merge-basis.test.mts
//
// Covered (processCandidate with a fake search + fake dispatcher):
//   1. target loaded in full        → one LLM call, merged
//   2. target loaded SHORTENED      → second call with the FULL page
//   3. target not loaded at all     → second call with the FULL page
//   4. page edited during the call  → refused (transient), both files kept
//   5. target does not exist        → failed, nothing written
//   6. memory note edited meanwhile → wiki merged, note NOT deleted

import { mkdtemp, mkdir, readFile, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SOMORA_HOME = await mkdtemp(join(tmpdir(), 'somora-deep-basis-home-'));
const { processCandidate } = await import('./deep-runner.ts');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}
const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

const TAIL = '## Zeitleiste\n- 2026-01-01 TAIL-MARKER das letzte Drittel der Seite';

async function scenario(opts: { bodyChars: number; searchHits: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'somora-deep-basis-'));
  const wikiAbs = join(root, 'wiki');
  await mkdir(join(wikiAbs, 'personen'), { recursive: true });
  const filler = 'Bestehender Inhalt der Seite. '.repeat(Math.ceil(opts.bodyChars / 30));
  const body = `## Stand\n${filler}\n\n${TAIL}\n`;
  const wikiFile = join(wikiAbs, 'personen', 'anna.md');
  await writeFile(wikiFile, `---\nslug: personen/anna\ntype: person\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n${body}`, 'utf8');
  await writeFile(join(wikiAbs, 'index.md'), '# Index\n- [[personen/anna]]\n', 'utf8');
  const memFile = join(root, 'neue-info.md');
  await writeFile(memFile, '---\nname: neue-info\n---\nAnna mag Tee.\n', 'utf8');
  const candidate = {
    agent: 'testagent',
    slug: 'neue-info',
    path: memFile,
    raw: 'x',
    frontmatter: {},
    body: 'Anna mag Tee.',
    mtimeMs: (await stat(memFile)).mtimeMs,
  };
  const mgr = {
    search: async () => (opts.searchHits ? [{ slug: 'personen/anna', filePath: wikiFile }] : []),
  };
  return { wikiAbs, wikiFile, memFile, candidate, mgr, body };
}

/** Dispatcher that records what it was shown and merges "everything it
 *  saw + the new fact" — so a lost tail shows up in the written page. */
function dispatcher(hook?: (call: number) => Promise<void>) {
  const calls: Array<{ pages: Array<{ slug: string; markdown: string }> }> = [];
  return {
    calls,
    decideMemoryFate: async (a: { relevantPages: Array<{ slug: string; markdown: string }> }) => {
      calls.push({ pages: a.relevantPages });
      if (hook) await hook(calls.length);
      const seen = a.relevantPages.find((p) => p.slug === 'personen/anna');
      const seenBody = seen ? seen.markdown.replace(/^---[\s\S]*?---\n/, '') : '## Stand\n(nur aus dem Index bekannt)';
      return { kind: 'merge' as const, wikiPath: 'personen/anna', body: `${seenBody}\n- Anna mag Tee.`, logSummary: 'anna ergänzt' };
    },
  };
}

async function runCase(s: Awaited<ReturnType<typeof scenario>>, d: ReturnType<typeof dispatcher>) {
  return processCandidate({
    candidate: s.candidate as never,
    ctx: { wikiAbs: s.wikiAbs },
    mgr: s.mgr as never,
    workerModel: {} as never,
    dispatcher: d as never,
    timeoutMs: 1000,
  });
}

// 1
{
  const s = await scenario({ bodyChars: 1500, searchHits: true });
  const d = dispatcher();
  const out = await runCase(s, d);
  check('full page: merged', out.kind === 'merged', JSON.stringify(out));
  check('full page: exactly one LLM call', d.calls.length === 1, `${d.calls.length}`);
  check('full page: tail kept + fact added', /TAIL-MARKER/.test(await readFile(s.wikiFile, 'utf8')) && /Anna mag Tee/.test(await readFile(s.wikiFile, 'utf8')));
  check('full page: note deleted', !(await exists(s.memFile)));
}
// 2
{
  const s = await scenario({ bodyChars: 12_000, searchHits: true });
  const d = dispatcher();
  const out = await runCase(s, d);
  const first = d.calls[0]?.pages[0]?.markdown ?? '';
  check('shortened: first call really saw a shortened page', /…\(truncated\)/.test(first) && !/TAIL-MARKER/.test(first));
  check('shortened: asked again', d.calls.length === 2, `${d.calls.length}`);
  const second = d.calls[1]?.pages[0]?.markdown ?? '';
  check('shortened: second call saw the FULL page', /TAIL-MARKER/.test(second) && !/…\(truncated\)/.test(second));
  check('shortened: merged', out.kind === 'merged', JSON.stringify(out));
  const written = await readFile(s.wikiFile, 'utf8');
  check('shortened: tail survives in the written page', /TAIL-MARKER/.test(written));
  check('shortened: no truncation marker written', !/…\(truncated\)/.test(written));
  check('shortened: new fact written', /Anna mag Tee/.test(written));
}
// 3
{
  const s = await scenario({ bodyChars: 3000, searchHits: false });
  const d = dispatcher();
  const out = await runCase(s, d);
  check('not loaded: first call had no pages', (d.calls[0]?.pages.length ?? -1) === 0);
  check('not loaded: asked again with the page', d.calls.length === 2 && /TAIL-MARKER/.test(d.calls[1]?.pages[0]?.markdown ?? ''));
  check('not loaded: merged, tail kept', out.kind === 'merged' && /TAIL-MARKER/.test(await readFile(s.wikiFile, 'utf8')), JSON.stringify(out));
}
// 4
{
  const s = await scenario({ bodyChars: 1500, searchHits: true });
  const humanEdit = (await readFile(s.wikiFile, 'utf8')) + '\n- HUMAN-EDIT in Obsidian\n';
  const d = dispatcher(async () => {
    await writeFile(s.wikiFile, humanEdit, 'utf8');
    const future = new Date(Date.now() + 5000);
    await utimes(s.wikiFile, future, future);
  });
  const out = await runCase(s, d);
  check('edited during call: not merged', out.kind === 'skipped' && out.transient === true, JSON.stringify(out));
  check('edited during call: human edit intact', (await readFile(s.wikiFile, 'utf8')) === humanEdit);
  check('edited during call: note kept', await exists(s.memFile));
}
// 5
{
  const s = await scenario({ bodyChars: 1500, searchHits: false });
  const d = {
    calls: [] as unknown[],
    decideMemoryFate: async () => ({ kind: 'merge' as const, wikiPath: 'personen/gibtsnicht', body: 'x', logSummary: 'x' }),
  };
  const out = await runCase(s, d as never);
  check('missing target: failed', out.kind === 'failed' && /does not exist/.test(out.error), JSON.stringify(out));
  check('missing target: note kept', await exists(s.memFile));
  check('missing target: nothing created', !(await exists(join(s.wikiAbs, 'personen', 'gibtsnicht.md'))));
}
// 6
{
  const s = await scenario({ bodyChars: 1500, searchHits: true });
  const d = dispatcher(async () => {
    await writeFile(s.memFile, '---\nname: neue-info\n---\nAnna mag KAFFEE, nicht Tee (Korrektur).\n', 'utf8');
    const future = new Date(Date.now() + 5000);
    await utimes(s.memFile, future, future);
  });
  const out = await runCase(s, d);
  check('note edited: wiki still merged', out.kind === 'merged', JSON.stringify(out));
  check('note edited: corrected note NOT deleted', await exists(s.memFile));
  check('note edited: correction readable next run', (await exists(s.memFile)) && /KAFFEE/.test(await readFile(s.memFile, 'utf8')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
