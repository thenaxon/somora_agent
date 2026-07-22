// Regression tests for tool-execution evidence in rebuilt history
// (2026-07-22). Run: npx tsx src/engine/tool-trace.test.mts
//
// The bug these protect against: history rebuilds kept only prose and
// dropped every tool_call/tool_result, so a model reading its own
// transcript found zero examples of tool use and stopped calling tools.
// Full incident write-up in ./tool-trace.ts.

import { buildMessages } from './openai-compatible.ts';
import { computeReplayDelta, renderReplayPrefix } from './replay.ts';
import { createToolTraceCollector, renderToolTrace, toolArgDigest } from './tool-trace.ts';
import type { NormalizedEvent } from '../types/events.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

let clock = 1000;
const ts = (): number => ++clock;

function userMsg(text: string): NormalizedEvent {
  return { kind: 'user_message', ts: ts(), text } as NormalizedEvent;
}
function asstMsg(text: string): NormalizedEvent {
  return { kind: 'assistant_message', ts: ts(), engine: 'openai-compatible', text } as NormalizedEvent;
}
function call(id: string, tool: string, input: unknown): NormalizedEvent {
  return { kind: 'tool_call', ts: ts(), engine: 'openai-compatible', callId: id, tool, input } as NormalizedEvent;
}
function result(id: string, error?: string): NormalizedEvent {
  return {
    kind: 'tool_result',
    ts: ts(),
    engine: 'openai-compatible',
    callId: id,
    output: null,
    ...(error ? { error } : {}),
  } as NormalizedEvent;
}
function turnStart(): NormalizedEvent {
  return { kind: 'turn_start', ts: ts(), engine: 'openai-compatible', turnId: `t${clock}` } as NormalizedEvent;
}

// ─── toolArgDigest ──────────────────────────────────────────────────
check('digest picks path', toolArgDigest({ path: '/tmp/tetris.js' }) === '/tmp/tetris.js');
check('digest picks command', toolArgDigest({ command: 'npm install' }) === 'npm install');
check(
  'digest prefers path over later keys',
  toolArgDigest({ name: 'x', path: '/a/b' }) === '/a/b',
);
check(
  'digest truncates long values',
  (toolArgDigest({ command: 'x'.repeat(200) }) ?? '').length <= 48,
);
check('digest collapses whitespace', toolArgDigest({ command: 'a\n\n  b' }) === 'a b');
check('digest of empty object is undefined', toolArgDigest({}) === undefined);
check('digest of null is undefined', toolArgDigest(null) === undefined);
check('digest falls back to first scalar', toolArgDigest({ weird: 'value' }) === 'value');

// ─── renderToolTrace ────────────────────────────────────────────────
check('empty trace renders empty string', renderToolTrace([]) === '');
{
  const out = renderToolTrace([
    { tool: 'file_write', arg: 'tetris.js' },
    { tool: 'file_write', arg: 'index.html' },
    { tool: 'exec', arg: 'npm install' },
    { tool: 'file_read', arg: 'missing.txt', failed: true },
  ]);
  check('groups repeats with a count', out.includes('file_write ×2'), out);
  check('single call has no count suffix', out.includes('exec → ok'), out);
  check('failures render as Fehler', out.includes('file_read → Fehler'), out);
  check('shows example args', out.includes('tetris.js, index.html'), out);
  check('header carries the total', out.includes('4 Aufrufe'), out);
  check('block is tagged as a system record', out.startsWith('<somora-tool-log>') && out.endsWith('</somora-tool-log>'), out);
}
{
  // The load-bearing property: 183 calls must not blow up the prompt.
  const many: Array<{ tool: string; arg: string }> = [];
  for (let i = 0; i < 183; i++) {
    many.push({ tool: ['file_write', 'exec', 'file_read'][i % 3]!, arg: `arg-${i}` });
  }
  const out = renderToolTrace(many);
  const lines = out.split('\n').length;
  check('183 calls collapse to a handful of lines', lines <= 6, `${lines} lines`);
  check('183 calls stay under 400 chars', out.length < 400, `${out.length} chars`);
  check('total still visible', out.includes('183 Aufrufe'), out);
}
{
  // Line cap for a pathological spread of distinct tool names.
  const spread = Array.from({ length: 120 }, (_, i) => ({ tool: `tool_${i}` }));
  const out = renderToolTrace(spread, { maxLines: 10 });
  // maxLines caps the ENTRY lines; the wrapper (open tag, count line,
  // omitted-note, close tag) sits outside that budget.
  const entryLines = out.split('\n').filter((l) => l.startsWith('- ') && !l.includes('weitere'));
  check('maxLines caps entry lines', entryLines.length <= 10, String(entryLines.length));
  check('omitted calls are disclosed', out.includes('weitere Aufrufe'), out);
}

// ─── collector pairing ──────────────────────────────────────────────
{
  const c = createToolTraceCollector();
  c.call('a', 'exec', { command: 'ls' });
  c.result('a');
  c.call('b', 'file_read', { path: '/x' });
  c.result('b', 'ENOENT');
  check('collector counts pending', c.pending === 2);
  const taken = c.take();
  check('take resets', c.pending === 0);
  check('error marks entry failed', taken[1]?.failed === true);
  check('success leaves failed unset', taken[0]?.failed === undefined);
  // Orphan call (turn crashed before the result) is still evidence.
  c.call('z', 'exec', { command: 'sleep 100' });
  check('orphan call retained', c.take().length === 1);
  // Orphan result with no call must not throw or invent an entry.
  c.result('never-seen');
  check('orphan result ignored', c.take().length === 0);
}

// ─── buildMessages: the actual regression ───────────────────────────
async function historyTests(): Promise<void> {
  // Mirrors the reported session: a heavy tool turn, then a text turn.
  const history: NormalizedEvent[] = [
    turnStart(),
    userMsg('Baue mir ein Tetris.'),
    call('c1', 'file_write', { path: 'tetris.js' }),
    result('c1'),
    call('c2', 'file_write', { path: 'index.html' }),
    result('c2'),
    call('c3', 'exec', { command: 'npm install' }),
    result('c3'),
    asstMsg('Fertig, das Spiel läuft auf Port 3020.'),
    turnStart(),
    userMsg('irgendwas läuft nicht'),
    asstMsg('Ich schaue mir das an.'),
  ];

  const msgs = await buildMessages('SYS', history, undefined, 'native');
  const joined = msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n---\n');

  check('tool evidence present in rebuilt history', joined.includes('file_write ×2'), joined);
  check('exec evidence present', joined.includes('exec'), joined);
  check('example paths present', joined.includes('tetris.js'), joined);
  check('user text preserved', joined.includes('Baue mir ein Tetris.'));
  check('assistant text preserved', joined.includes('Port 3020'));

  // Order matters: the evidence must precede the assistant text it
  // belongs to, otherwise it reads as a claim about the future.
  const assistantWithTools = msgs.find(
    (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('file_write'),
  );
  check('evidence lands on an assistant message', assistantWithTools !== undefined);
  if (assistantWithTools && typeof assistantWithTools.content === 'string') {
    const c = assistantWithTools.content;
    check('evidence sits before the prose', c.indexOf('file_write') < c.indexOf('Port 3020'), c);
  }

  // A history with no tools at all must be byte-identical to before —
  // no stray headers, no empty blocks.
  const plain: NormalizedEvent[] = [turnStart(), userMsg('hi'), asstMsg('hallo')];
  const plainMsgs = await buildMessages('SYS', plain, undefined, 'native');
  const plainJoined = plainMsgs.map((m) => m.content).join('|');
  check('tool-less history unchanged', !plainJoined.includes('Werkzeug'), plainJoined);
  check('tool-less history shape', plainMsgs.length === 3, String(plainMsgs.length));

  // Tools in a turn that never produced an assistant_message (crash /
  // abort) must not bleed into the following turn's message.
  const crashed: NormalizedEvent[] = [
    turnStart(),
    userMsg('mach was'),
    call('x1', 'exec', { command: 'boom' }),
    result('x1', 'killed'),
    turnStart(),
    userMsg('und jetzt?'),
    asstMsg('Neuer Versuch.'),
  ];
  const crashedMsgs = await buildMessages('SYS', crashed, undefined, 'native');
  const lastAsst = [...crashedMsgs].reverse().find((m) => m.role === 'assistant');
  check(
    'orphan tools do not attach to the next turn',
    typeof lastAsst?.content === 'string' && !lastAsst.content.includes('exec'),
    JSON.stringify(lastAsst?.content),
  );
  const anyHasExec = crashedMsgs.some(
    (m) => typeof m.content === 'string' && m.content.includes('exec → Fehler'),
  );
  check('orphan tools still surface somewhere', anyHasExec);
}

// ─── replay delta (engine switch) ───────────────────────────────────
function replayTests(): void {
  const history: NormalizedEvent[] = [
    userMsg('Baue mir ein Tetris.'),
    call('r1', 'file_write', { path: 'tetris.js' }),
    result('r1'),
    call('r2', 'exec', { command: 'npm test' }),
    result('r2', 'failed'),
    asstMsg('Erster Wurf steht.'),
  ];
  const delta = computeReplayDelta(history, 0, undefined);
  check('replay pair carries tool trace', delta.pairs[0]?.toolTrace !== undefined);
  const rendered = renderReplayPrefix(delta);
  check('rendered replay shows tools', rendered.includes('file_write'), rendered);
  check('rendered replay shows failure', rendered.includes('exec → Fehler'), rendered);
  check(
    'tools rendered before the assistant line',
    rendered.indexOf('file_write') < rendered.indexOf('Assistant:'),
    rendered,
  );

  // No tools → no trace key, and the block is unchanged from before.
  const plain = computeReplayDelta([userMsg('hi'), asstMsg('hallo')], 0, undefined);
  check('tool-less pair has no trace', plain.pairs[0]?.toolTrace === undefined);
  check('tool-less replay has no header', !renderReplayPrefix(plain).includes('Werkzeug'));
}

await historyTests();
replayTests();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
