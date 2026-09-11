// What codex's token report actually means (2026-09-11).
//
// Run: npx tsx src/engine/codex-usage.test.mts
//
// A long codex chat showed a context percentage that kept climbing past
// 100 % and stayed red, however often the CLI compacted. Rene: "so hat
// man irgendwann 300% in rot dort stehen und weiss nicht was das
// heissen soll". Measured against the app-server: `cachedInputTokens`
// is a SUBSET of `inputTokens`, and somora added the two. Anthropic
// counts the other way round — there `input_tokens` EXCLUDES the cached
// part — so the two engines must not share an arithmetic.
import assert from 'node:assert/strict';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};

/** The codex arithmetic, as the engine now does it. */
function codexOccupancy(last: { inputTokens: number; cachedInputTokens: number }): number {
  return last.inputTokens;
}
/** The claude-cli arithmetic, unchanged. */
function claudeOccupancy(u: {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

// ── the payload the app-server really sent, verbatim ─────────────────
{
  // thread/tokenUsage/updated, gpt-6-astra, 2026-09-11:
  const last = { totalTokens: 16240, inputTokens: 16235, cachedInputTokens: 12160, outputTokens: 5 };
  check(
    'totalTokens proves cached is inside inputTokens',
    last.totalTokens === last.inputTokens + last.outputTokens,
    `${last.totalTokens} vs ${last.inputTokens + last.outputTokens}`,
  );
  check('occupancy is the prompt, once', codexOccupancy(last) === 16235, String(codexOccupancy(last)));
  check(
    'the old sum double-counted the cached part',
    last.inputTokens + last.cachedInputTokens === 28395,
    String(last.inputTokens + last.cachedInputTokens),
  );
}

// ── the live symptom: over the window on a chat that never was ───────
{
  // A late request of the long session, reconstructed from the logged
  // figure: 425,581 shown against a 272,000 configured window while the
  // real window is 258,400.
  const last = { inputTokens: 258_000, cachedInputTokens: 167_581 };
  check('the old sum went past the window', last.inputTokens + last.cachedInputTokens > 272_000);
  check('the fixed number fits its real window', codexOccupancy(last) <= 258_400, String(codexOccupancy(last)));
}

// ── Anthropic counts the other way: summing is right there ───────────
{
  // claude-opus-5, from the same day's log: a 4-token new message on a
  // 231,855-token prompt served almost entirely from cache.
  const u = { input_tokens: 4, cache_read_input_tokens: 227_320, cache_creation_input_tokens: 4_531 };
  check('claude occupancy is the sum', claudeOccupancy(u) === 231_855, String(claudeOccupancy(u)));
  check('taking only input_tokens would read as empty', u.input_tokens < 10);
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
