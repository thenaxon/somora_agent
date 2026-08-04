// Tests for the REM dedup stage-2 improvements (2026-07-29 feedback:
// topic-match was flagged as fact-match, 6/14 false batch-dismiss
// hints; audit-log pages matched as "duplicates"; no way to see WHAT
// matched).
//
// Run: npx tsx src/dream/rem-dedup.test.mts

import { applyRemDedup, hardTokens } from './rem-dedup.ts';
import type { Finding } from './types.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const CONFIG = { enabled: true, similarityThreshold: 0.8 };

interface FakeHit {
  chunkId: number;
  filePath: string;
  source: string;
  slug: string;
  text: string;
  startLine: number;
  endLine: number;
  score: number;
  vecScore: number;
  bm25Score: number;
}

function hit(source: string, slug: string, text: string, score: number): FakeHit {
  return {
    chunkId: 1,
    filePath: `${slug}.md`,
    source,
    slug,
    text,
    startLine: 1,
    endLine: 10,
    score,
    vecScore: score,
    bm25Score: score,
  };
}

function finding(id: number, slug: string, content: string): Finding {
  return {
    id,
    action: 'memory_write',
    slug,
    proposed_content: content,
    reason: 'test',
    status: 'pending',
  } as Finding;
}

function mgrWith(hits: FakeHit[]): { search: () => Promise<FakeHit[]> } {
  return { search: async () => hits };
}

async function run(f: Finding, hits: FakeHit[]) {
  const result = await applyRemDedup({
    agent: 'test',
    dreamId: 'd1',
    findings: [f],
    existingMemorySlugs: [],
    loadedWikiSlugs: [],
    // Only .search is used by stage 2 — a structural mock is fine here.
    mgr: mgrWith(hits) as never,
    config: CONFIG,
  });
  return result.findings[0];
}

// ── hardTokens unit checks ──────────────────────────────────────────
{
  const t = hardTokens('GO für Qwen3-14B am 2026-07-29, Datensatz 1.419 Samples, Start 14:05');
  check('extracts ISO date', t.includes('2026-07-29'), JSON.stringify(t));
  check('extracts dotted count', t.includes('1.419'), JSON.stringify(t));
  check('extracts time', t.includes('14:05'), JSON.stringify(t));
  check('no single digits alone', !t.includes('3'), JSON.stringify(t));
}

// ── matched_excerpt lands on the finding ────────────────────────────
{
  const f = await run(
    finding(1, 'gmp-basics', 'Das Projekt nutzt Qwen als Basismodell.'),
    [hit('wiki', 'projekte/gmp-desk', 'Das Projekt nutzt Qwen als Basismodell für den Bot.', 1.2)],
  );
  check('flagged as likely_duplicate', f?.likely_duplicate === true);
  check(
    'matched_excerpt carries the matched chunk text',
    (f?.matched_excerpt ?? '').includes('Qwen als Basismodell'),
    f?.matched_excerpt ?? '',
  );
  check('verbatim repeat has NO novel_details', f?.novel_details !== true);
}

// ── novelty: new date/count on a topic-matched page ────────────────
{
  const f = await run(
    finding(2, 'gmp-model-decision', 'GO für Qwen3 gefallen am 2026-07-29, finaler Datensatz 1.419 Samples.'),
    [
      hit(
        'wiki',
        'projekte/gmp-desk',
        'Projekt GMP Advisory Desk: warten auf Renes GO für Qwen3. Datensatz in Arbeit.',
        1.4,
      ),
    ],
  );
  check('topic-match still flagged', f?.likely_duplicate === true);
  check(
    'new concrete tokens → novel_details true (the report case)',
    f?.novel_details === true,
    JSON.stringify(f),
  );
}

// ── audit-log pages are excluded from the corpus ────────────────────
{
  const f = await run(
    finding(3, 'gmp-concept-v2', 'Konzept v2 beschlossen.'),
    [hit('wiki', 'logs/2026-07', 'promoted gmp-concept-v2 from hans', 1.2)],
  );
  check('logs/ match does NOT flag', f?.likely_duplicate !== true, JSON.stringify(f));
}
{
  // logs excluded but a real page also matched → flag with the page.
  const f = await run(
    finding(4, 'gmp-fact', 'Fakt X.'),
    [
      hit('wiki', 'logs/2026-07', 'processed fact X', 1.3),
      hit('wiki', 'projekte/gmp-desk', 'Fakt X steht hier.', 1.1),
    ],
  );
  check('falls through to the non-log hit', f?.duplicate_of?.includes('projekte/gmp-desk') === true, f?.duplicate_of ?? '');
}

// ── no hits → untouched ─────────────────────────────────────────────
{
  const f = await run(finding(5, 'fresh-fact', 'Etwas völlig Neues.'), []);
  check('no hits → no flag', f?.likely_duplicate !== true && f?.matched_excerpt === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
