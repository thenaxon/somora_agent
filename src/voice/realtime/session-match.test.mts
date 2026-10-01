// Finding the session somebody said out loud (2026-09-12).
//
// Run: npx tsx src/voice/realtime/session-match.test.mts
//
// Every case below is a real one. On the evening of 2026-09-12 four
// attempts to reach two sessions went through a live call, and the
// server logged each name the model passed. Not one matched, because
// matching was literal and case-sensitive: `quantumcraft` and
// `voicecheck` were never reachable by voice at all.
import assert from 'node:assert/strict';

import { matchSpokenSession, normalizeSpokenName } from './session-match.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

// nova's sessions on the day, shortened to the ones that matter.
const nova = ['main', 'quantumcraft', 'phase5-fix-claude', 'main-archive'];
const ada = ['main', 'voicecheck', 'voicetest-2026-09-11', 'codex-smoke'];

const one = (m: ReturnType<typeof matchSpokenSession>): string =>
  m.kind === 'one' ? m.slug : `${m.kind}:${m.kind === 'many' ? m.candidates.join('|') : ''}`;

// ── the four names from the log ─────────────────────────────────────
check('"Quantumkräft" finds quantumcraft', one(matchSpokenSession('Quantumkräft', nova)) === 'quantumcraft', one(matchSpokenSession('Quantumkräft', nova)));
check('"craft" finds quantumcraft', one(matchSpokenSession('craft', nova)) === 'quantumcraft', one(matchSpokenSession('craft', nova)));
check('"Quantumcraft" finds quantumcraft', one(matchSpokenSession('Quantumcraft', nova)) === 'quantumcraft', one(matchSpokenSession('Quantumcraft', nova)));
check('"voice-check" finds voicecheck', one(matchSpokenSession('voice-check', ada)) === 'voicecheck', one(matchSpokenSession('voice-check', ada)));

// ── the shapes speech produces ──────────────────────────────────────
check('spoken as two words', one(matchSpokenSession('Quantum Craft', nova)) === 'quantumcraft');
check('shouted in capitals', one(matchSpokenSession('QUANTUMCRAFT', nova)) === 'quantumcraft');
check('with an umlaut where none belongs', one(matchSpokenSession('quantumcräft', nova)) === 'quantumcraft');
check('main is always reachable', one(matchSpokenSession('Main', [])) === 'main');
check('main is reachable even when it has no file yet', one(matchSpokenSession('main', ['other'])) === 'main');

// ── where it must NOT guess ─────────────────────────────────────────
// Landing in the wrong conversation is worse than one more question.
{
  // Neither is what was said, and both are equally close.
  const twins = ['main', 'projekt-alpha-1', 'projekt-alpha-2'];
  const m = matchSpokenSession('Projekt Alpha', twins);
  check('two sessions that sound alike become a question', m.kind === 'many', JSON.stringify(m));
  if (m.kind === 'many') check('and both are offered', m.candidates.includes('projekt-alpha-1') && m.candidates.includes('projekt-alpha-2'), m.candidates.join(','));
  // Said exactly, it is no longer a question.
  check('an exact name still wins over its neighbour', one(matchSpokenSession('projekt alpha 2', twins)) === 'projekt-alpha-2', one(matchSpokenSession('projekt alpha 2', twins)));
}
check('a name nothing resembles finds nothing', matchSpokenSession('quartalsplanung', nova).kind === 'none', JSON.stringify(matchSpokenSession('quartalsplanung', nova)));
check('a two-letter fragment is not a wish', matchSpokenSession('ce', nova).kind === 'none', JSON.stringify(matchSpokenSession('ce', nova)));
check('empty is nothing', matchSpokenSession('   ', nova).kind === 'none');

// ── the normaliser itself ───────────────────────────────────────────
check('folds case, umlauts and punctuation', normalizeSpokenName('Quantum-Kräft!') === 'quantumkraft', normalizeSpokenName('Quantum-Kräft!'));
check('keeps digits', normalizeSpokenName('voicetest 2026-09-11') === 'voicetest20260911', normalizeSpokenName('voicetest 2026-09-11'));

// ── a real session list does not turn into a lottery ────────────────
// nova has hundreds of sessions, most of them sub-agent scratch. A
// loose matcher would hand out one of those.
{
  const many = ['main', 'quantumcraft', ...Array.from({ length: 200 }, (_, i) => `sub-self-${i}-abcd`)];
  check('a wrong name does not land in a sub-agent session', matchSpokenSession('wochenplanung', many).kind === 'none', JSON.stringify(matchSpokenSession('wochenplanung', many)));
  check('the right one still wins in a crowd', one(matchSpokenSession('Quantum Craft', many)) === 'quantumcraft');
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
