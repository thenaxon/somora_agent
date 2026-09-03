// capReplayDelta: a from-zero replay (engine session rebuilt after a
// codex model switch or the MCP server rename) must never carry the
// whole session. Run: npx tsx src/engine/replay.test.mts
import assert from 'node:assert/strict';
import { capReplayDelta, renderReplayPrefix, type ReplayDelta } from './replay.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const pair = (i: number, size = 10): { user: string; assistant: string } => ({
  user: `q${i} ` + 'u'.repeat(size),
  assistant: `a${i} ` + 'x'.repeat(size),
});
const delta = (n: number, size = 10): ReplayDelta => ({
  pairs: Array.from({ length: n }, (_, i) => pair(i, size)),
});

// under both limits → identical object back
{
  const d = delta(5);
  check('small delta untouched', capReplayDelta(d) === d);
}
// pair cap keeps the most recent
{
  const c = capReplayDelta(delta(100), { maxPairs: 40, maxChars: 1e9 });
  check('pair cap: 40 kept', c.pairs.length === 40, String(c.pairs.length));
  check('pair cap: newest kept', c.pairs[39]!.user.startsWith('q99 ') && c.pairs[0]!.user.startsWith('q60 '));
  check('pair cap: omitted counted', c.omittedPairs === 60, String(c.omittedPairs));
}
// char cap drops from the oldest end
{
  const c = capReplayDelta(delta(10, 100), { maxPairs: 1000, maxChars: 650 });
  // each pair ≈ 2*(4+100) = 208 chars → 3 fit (624), the 4th overflows
  check('char cap: 3 kept', c.pairs.length === 3, String(c.pairs.length));
  check('char cap: omitted 7', c.omittedPairs === 7, String(c.omittedPairs));
}
// a single oversized pair is still kept (never an empty replay)
{
  const c = capReplayDelta(delta(3, 5000), { maxPairs: 40, maxChars: 100 });
  check('oversized single pair kept', c.pairs.length === 1 && c.omittedPairs === 2);
}
// summary survives, note renders
{
  const c = capReplayDelta({ summary: 'S', ...delta(50) }, { maxPairs: 10, maxChars: 1e9 });
  check('summary kept', c.summary === 'S');
  const text = renderReplayPrefix(c);
  check('render notes omitted exchanges', text.includes('(40 earlier exchanges omitted'), text.slice(0, 300));
  check('render still has summary + pairs', text.includes('<earlier-summary>') && text.includes('q49 '));
}
// realistic: 883 pairs of ~2k chars each fits the default cap
{
  const c = capReplayDelta(delta(883, 1000));
  const chars = c.pairs.reduce((n, p) => n + p.user.length + p.assistant.length, 0);
  check('default cap bounds a long session', c.pairs.length <= 40 && chars <= 60_000, `${c.pairs.length} pairs, ${chars} chars`);
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
