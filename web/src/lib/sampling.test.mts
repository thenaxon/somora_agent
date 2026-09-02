// Unit tests for the /sampling argument parser + formatter.
//
// Run: npx tsx src/lib/sampling.test.mts   (cwd = web/)

import assert from 'node:assert/strict';
import { formatSamplingParams, hasSamplingParams, parseSamplingArgs } from './sampling';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// Happy path: numbers parsed, several pairs merged into one patch.
{
  const r = parseSamplingArgs(['temperature=1', 'top_p=0.95']);
  check('two pairs ok', r.ok);
  if (r.ok) assert.deepEqual(r.params, { temperature: 1, top_p: 0.95 });
}

// Integers.
{
  const r = parseSamplingArgs(['top_k=40', 'seed=42']);
  check('ints ok', r.ok);
  if (r.ok) assert.deepEqual(r.params, { top_k: 40, seed: 42 });
  check('top_k non-int rejected', !parseSamplingArgs(['top_k=1.5']).ok);
  check('top_k zero rejected', !parseSamplingArgs(['top_k=0']).ok);
  check('seed non-int rejected', !parseSamplingArgs(['seed=1.2']).ok);
}

// Ranges.
check('temperature > 2 rejected', !parseSamplingArgs(['temperature=2.5']).ok);
check('temperature < 0 rejected', !parseSamplingArgs(['temperature=-0.1']).ok);
check('top_p > 1 rejected', !parseSamplingArgs(['top_p=1.2']).ok);
check('min_p ok', parseSamplingArgs(['min_p=0.05']).ok);
check('frequency_penalty -2 ok', parseSamplingArgs(['frequency_penalty=-2']).ok);
check('presence_penalty 3 rejected', !parseSamplingArgs(['presence_penalty=3']).ok);
check('repetition_penalty 0 rejected', !parseSamplingArgs(['repetition_penalty=0']).ok);
check('repetition_penalty 1.1 ok', parseSamplingArgs(['repetition_penalty=1.1']).ok);

// Unparsable values + unknown keys + malformed tokens → error, nothing parsed.
check('non-number rejected', !parseSamplingArgs(['temperature=hot']).ok);
check('empty value rejected', !parseSamplingArgs(['temperature=']).ok);
check('unknown key rejected', !parseSamplingArgs(['foo=1']).ok);
check('bare word rejected', !parseSamplingArgs(['temperature']).ok);
check('empty list rejected', !parseSamplingArgs([]).ok);
{
  const r = parseSamplingArgs(['temperature=1', 'bogus=2']);
  check('one bad pair fails whole parse', !r.ok);
  if (!r.ok) check('error names the key', r.error.includes('bogus'), r.error);
}

// null / - removes a key.
{
  const r = parseSamplingArgs(['temperature=null', 'top_p=-']);
  check('null + dash ok', r.ok);
  if (r.ok) assert.deepEqual(r.params, { temperature: null, top_p: null });
}

// stop: single string vs comma list.
{
  const one = parseSamplingArgs(['stop=END']);
  check('stop single', one.ok && one.params.stop === 'END');
  const many = parseSamplingArgs(['stop=END,STOP, ###']);
  check('stop list', many.ok);
  if (many.ok) assert.deepEqual(many.params.stop, ['END', 'STOP', '###']);
  check('stop empty rejected', !parseSamplingArgs(['stop=']).ok);
}

// Key names are case-insensitive, whitespace around tokens ignored.
{
  const r = parseSamplingArgs([' Temperature=0.7 ', '']);
  check('case-insensitive key', r.ok);
  if (r.ok) assert.deepEqual(r.params, { temperature: 0.7 });
}

// Formatter: catalogue order regardless of insertion order, null → `-`.
assert.equal(formatSamplingParams({ top_p: 0.95, temperature: 1 }), 'temperature=1 top_p=0.95');
assert.equal(formatSamplingParams({ stop: ['a', 'b'], seed: 7 }), 'seed=7 stop=a,b');
assert.equal(formatSamplingParams({ temperature: null }), 'temperature=-');
assert.equal(formatSamplingParams(null), '(engine default)');
assert.equal(formatSamplingParams({}), '(engine default)');
check('format order', true);

// hasSamplingParams ignores empty / null-only objects.
check('has: null', !hasSamplingParams(null));
check('has: empty', !hasSamplingParams({}));
check('has: set', hasSamplingParams({ temperature: 0.2 }));

console.log(`sampling: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
