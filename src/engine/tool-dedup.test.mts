// Tests for within-round tool-call dedup (2026-07-23).
//
// Run: npx tsx src/engine/tool-dedup.test.mts
//
// Context: deepseek via OpenRouter ignores `parallel_tool_calls` and fans
// out the SAME tool call dozens of times in one round — 77 identical `df`
// calls, then 116, measured live. dedupeToolCalls collapses identical
// (name, args) to one execution so the model gets one result per DISTINCT
// call instead of drowning in duplicates. The property that matters and is
// asserted here: the returned list has no duplicate (name, args) pair, and
// order + distinct calls are preserved so the assistant/tool pairing the
// OpenAI API requires stays intact.

import assert from 'node:assert/strict';

import {
  containsScaffold,
  dedupeToolCalls,
  looksRepetitive,
  stripScaffold,
} from './openai-compatible.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const call = (id: string, name: string, args: string) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});

// ── the live failure: 77 identical calls collapse to 1 ────────────────
{
  const df = Array.from({ length: 77 }, (_, i) =>
    call(`c${i}`, 'exec', '{"command":"df -h / | awk \'NR==2 {print $4}\'"}'),
  );
  const out = dedupeToolCalls(df);
  check('77 identical → 1', out.length === 1, `${out.length}`);
  check('keeps the FIRST id', out[0]!.id === 'c0', out[0]!.id);
}

// ── distinct calls all survive ────────────────────────────────────────
{
  const calls = [
    call('a', 'exec', '{"command":"uptime -p"}'),
    call('b', 'exec', '{"command":"cat /proc/uptime"}'),
    call('c', 'exec', '{"command":"last reboot | head -n 1"}'),
  ];
  const out = dedupeToolCalls(calls);
  check('3 distinct → 3', out.length === 3);
  check('order preserved', out.map((c) => c.id).join('') === 'abc', out.map((c) => c.id).join(''));
}

// ── mixed: distinct + duplicates (the turn-5 shape: 77 calls, 6 distinct)
{
  const calls = [
    call('1', 'exec', '{"command":"uptime -p"}'),
    call('2', 'exec', '{"command":"uptime -p"}'), // dup
    call('3', 'exec', '{"command":"cat /proc/uptime"}'),
    call('4', 'exec', '{"command":"uptime -p"}'), // dup
    call('5', 'exec', '{"command":"cat /proc/uptime"}'), // dup
    call('6', 'file_list', '{"path":"/tmp"}'),
  ];
  const out = dedupeToolCalls(calls);
  check('6 calls, 3 distinct → 3', out.length === 3, `${out.length}`);
  check(
    'keeps first of each distinct',
    out.map((c) => c.id).join('') === '136',
    out.map((c) => c.id).join(''),
  );
}

// ── same command, DIFFERENT tool → both kept (name is part of the key) ─
{
  const calls = [
    call('a', 'exec', '{"command":"ls"}'),
    call('b', 'shell', '{"command":"ls"}'),
  ];
  check('same args, different tool → both', dedupeToolCalls(calls).length === 2);
}

// ── same tool, whitespace-different args → both kept (byte-exact) ──────
{
  const calls = [
    call('a', 'exec', '{"command":"ls"}'),
    call('b', 'exec', '{"command":"ls "}'),
  ];
  check('byte-different args → both kept', dedupeToolCalls(calls).length === 2);
}

// ── no result is ever fabricated: output ⊆ input, same objects ─────────
{
  const calls = [call('a', 'x', '{}'), call('b', 'x', '{}'), call('c', 'y', '{}')];
  const out = dedupeToolCalls(calls);
  check('output items are input items', out.every((c) => calls.includes(c)));
  check('every kept sig is unique', new Set(out.map((c) => `${c.function.name} ${c.function.arguments}`)).size === out.length);
}

// ── edge cases ────────────────────────────────────────────────────────
check('empty → empty', dedupeToolCalls([]).length === 0);
{
  const one = [call('a', 'exec', '{}')];
  check('single → single', dedupeToolCalls(one).length === 1);
}

// ── scaffold detection (the DeepSeek tool-template leak) ──────────────
const SCAFFOLD =
  'Use the results below to formulate an answer to the user question unless additional information is needed.';
{
  check('exact scaffold detected', containsScaffold(SCAFFOLD));
  check('case-insensitive', containsScaffold(SCAFFOLD.toUpperCase()));
  check(
    'detected as a prefix of a longer wall of text',
    containsScaffold(`${SCAFFOLD}\n\nThe disk has 150 GB free.`),
  );
  check('real answer is NOT flagged', !containsScaffold('Auf der Root-Partition sind 150 GB frei.'));
  check('empty is not flagged', !containsScaffold(''));
}

// ── stripScaffold keeps the real content, drops the template ──────────
{
  const leaked = `${SCAFFOLD}\n\nAuf der Root-Partition sind 150 GB von 232 GB frei.`;
  const out = stripScaffold(leaked);
  check('scaffold line removed', !containsScaffold(out), out);
  check('real content kept', out.includes('150 GB von 232 GB frei'), out);
}
{
  // Pure scaffold → nothing meaningful survives (engine then uses fallback).
  const out = stripScaffold(`${SCAFFOLD}\n${SCAFFOLD}`);
  check('pure scaffold strips to (near) empty', out.length < 20, `'${out}'`);
}
{
  const clean = 'Der Hostname ist naxon.';
  check('clean text passes through unchanged', stripScaffold(clean) === clean);
}

// ── looksRepetitive: general wall detection, any repeated phrase ───────
{
  const SCAFFOLD =
    'Use the results below to formulate an answer to the user question unless additional information is needed.';
  check('scaffold wall (69×) is repetitive', looksRepetitive(SCAFFOLD.repeat(69)));
  check(
    'a different repeated phrase is caught too',
    looksRepetitive('Der Kernel ist 6.12.69. '.repeat(30)),
  );
  check('short text is never repetitive', !looksRepetitive('Der Kernel ist 6.12.69.'));
  check(
    'a long NORMAL answer is not flagged',
    !looksRepetitive(
      'Hier sind die Top-5 Prozesse nach CPU-Auslastung: node mit 25%, ' +
        'somora-server mit 12%, chrome mit 8%, das Systemd-Journal, und ein ' +
        'Backup-Job der gerade läuft. Insgesamt ist die Last moderat und es ' +
        'gibt keinen Grund zur Sorge; die Maschine hat reichlich Reserven frei.',
    ),
  );
  check('empty is not repetitive', !looksRepetitive(''));
  check(
    'two repeats is not enough (needs a real loop)',
    !looksRepetitive('Der Kernel ist 6.12.69+deb13-amd64 und läuft stabil. '.repeat(2)),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
