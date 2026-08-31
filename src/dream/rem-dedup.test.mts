// Tests for the REM dedup stage-2 decision.
//
//   2026-07-29 feedback: topic-match was flagged as fact-match, 6/14
//   false batch-dismiss hints; audit-log pages matched as "duplicates";
//   no way to see WHAT matched.
//   2026-08-26 feedback: ~70 % of findings flagged because the fused
//   hybrid score is a RANK (top hit = 1.0 × source boost = 0.98 / 0.85
//   for any query), not a similarity. Decision now uses the embedding
//   cosine behind `vecScore`.
//
// Run: npx tsx src/dream/rem-dedup.test.mts

import { applyRemDedup, hardTokens } from './rem-dedup.ts';
import { cosineFromVecScore, vecScoreFromCosine } from '../memory/retrieval.ts';
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

const CONFIG = { enabled: true, similarityThreshold: 0.85 };

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

/** A hit at a given embedding cosine similarity. `fused` is what the
 *  ranker would have reported — deliberately independent of `cos`, so
 *  the tests can pin down which one the decision reads. */
function hit(source: string, slug: string, text: string, cos: number, fused = 0.98): FakeHit {
  return {
    chunkId: 1,
    filePath: `${slug}.md`,
    source,
    slug,
    text,
    startLine: 1,
    endLine: 10,
    score: fused,
    vecScore: vecScoreFromCosine(cos),
    bm25Score: 0.5,
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

// ── cosine ↔ vecScore round trip ────────────────────────────────────
{
  for (const c of [1, 0.95, 0.85, 0.6, 0.2, 0, -0.5]) {
    const back = cosineFromVecScore(vecScoreFromCosine(c));
    check(`round-trip cos ${c}`, Math.abs(back - c) < 1e-9, String(back));
  }
  check('identical text → vecScore 1 → cos 1', cosineFromVecScore(1) === 1);
  check('orthogonal → d=√2 → cos ≈ 0', Math.abs(cosineFromVecScore(1 / (1 + Math.SQRT2))) < 1e-9);
  check('no vector (0) → cos 0', cosineFromVecScore(0) === 0);
}

// ── hardTokens unit checks ──────────────────────────────────────────
{
  const t = hardTokens('GO für Qwen3-14B am 2026-07-29, Datensatz 1.419 Samples, Start 14:05');
  check('extracts ISO date', t.includes('2026-07-29'), JSON.stringify(t));
  check('extracts dotted count', t.includes('1.419'), JSON.stringify(t));
  check('extracts time', t.includes('14:05'), JSON.stringify(t));
  check('no single digits alone', !t.includes('3'), JSON.stringify(t));
}

// ── THE 2026-08-26 case: top-ranked but unrelated → NOT flagged ─────
{
  const f = await run(
    finding(10, 'star-wars-tetris', 'Testprojekt: Star-Wars-Tetris in TypeScript, Sprite-Sheet liegt unter assets/.'),
    // Fused 0.98 = wiki top hit (1.0 × 1.4 boost … capped in the mock);
    // the embedding says 0.55 — same corpus, different topic.
    [hit('wiki', 'projekte/urlaubsplaner-conny', 'Urlaubsplaner für Conny: Kalenderansicht, iCal-Export.', 0.55, 0.98)],
  );
  check('rank 0.98 with cosine 0.55 → not flagged', f?.likely_duplicate !== true, JSON.stringify(f));
  check('… no duplicate_of', f?.duplicate_of === undefined);
}
{
  // Memory top hit used to be a constant 0.85 (1.0 × 0.85 boost) —
  // exactly the old threshold. Real duplicate at cosine 0.92 → flagged,
  // with the COSINE in duplicate_of, not the rank.
  const f = await run(
    finding(11, 'vision-root-pw', 'Root-Passwort auf vision wurde geändert.'),
    [hit('memory', 'vision-root-passwort', 'Root-Passwort auf vision geändert (2026-08-20).', 0.92, 0.85)],
  );
  check('memory duplicate at cosine 0.92 → flagged', f?.likely_duplicate === true, JSON.stringify(f));
  check('duplicate_of carries the cosine, not the rank', f?.duplicate_of === 'memory:vision-root-passwort@0.92', f?.duplicate_of ?? '');
}
{
  // Best-by-cosine wins, not best-by-rank: the ranker put an unrelated
  // wiki page first (0.98) and the real duplicate second (0.85).
  const f = await run(
    finding(12, 'swarmui-docker', 'SwarmUI läuft als Docker-Container auf cerebro.'),
    [
      hit('wiki', 'bugs/docker-api-unauth-2375', 'Docker API auf 2375 ohne Auth erreichbar.', 0.62, 0.98),
      hit('memory', 'swarmui-cerebro', 'SwarmUI als Docker-Container auf cerebro.', 0.94, 0.85),
    ],
  );
  check('picks the closest embedding, not the top rank', f?.duplicate_of?.startsWith('memory:swarmui-cerebro@') === true, f?.duplicate_of ?? '');
}
{
  // BM25-only hits (no embedding) can't be judged → never flagged.
  const bm25Only = { ...hit('wiki', 'wissen/wan-2-2', 'Wan 2.2 Modell-Diät.', 0, 1.4), vecScore: 0 };
  const f = await run(finding(13, 'h3-diaet', 'H3-Modell-Diät für die Studio-GPU.'), [bm25Only]);
  check('bm25-only hit → not flagged', f?.likely_duplicate !== true, JSON.stringify(f));
}
{
  // Threshold is inclusive and reads config.
  const f = await run(finding(14, 'edge', 'Genau an der Schwelle.'), [hit('memory', 'edge-note', 'Genau an der Schwelle.', 0.85)]);
  check('cosine == threshold → flagged', f?.likely_duplicate === true);
  const g = await run(finding(15, 'edge2', 'Knapp darunter.'), [hit('memory', 'edge-note', 'Knapp darunter.', 0.849)]);
  check('cosine just below threshold → not flagged', g?.likely_duplicate !== true);
}

// ── matched_excerpt lands on the finding ────────────────────────────
{
  const f = await run(
    finding(1, 'gmp-basics', 'Das Projekt nutzt Qwen als Basismodell.'),
    [hit('wiki', 'projekte/gmp-desk', 'Das Projekt nutzt Qwen als Basismodell für den Bot.', 0.95)],
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
        0.9,
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
    [hit('wiki', 'logs/2026-07', 'promoted gmp-concept-v2 from hans', 0.95)],
  );
  check('logs/ match does NOT flag', f?.likely_duplicate !== true, JSON.stringify(f));
}
{
  // logs excluded but a real page also matched → flag with the page.
  const f = await run(
    finding(4, 'gmp-fact', 'Fakt X.'),
    [
      hit('wiki', 'logs/2026-07', 'processed fact X', 0.97),
      hit('wiki', 'projekte/gmp-desk', 'Fakt X steht hier.', 0.9),
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
