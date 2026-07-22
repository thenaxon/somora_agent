// Regression tests for the openai-compatible history rebuild
// (2026-07-22). Run: npx tsx src/engine/openai-history.test.mts
//
// What these protect:
//
// 1. Tool turns are replayed in the NATIVE tool_calls shape. Flattening
//    them to prose measured 0/20 tool calls on deepseek-chat against a
//    real session history; the native shape lifted it to 14/20. A
//    transcript in which the assistant never calls tools teaches the
//    model that here, one does not call tools.
//
// 2. The pairing invariants that keep providers from 400-ing: every
//    assistant `tool_calls` entry must be followed by a `role:'tool'`
//    message with a matching id, and unpaired calls must be dropped.
//
// 3. `<somora-tool-log>` — a July-2026 approach that briefly lived in
//    the assistant role and taught models to fabricate tool work — is
//    scrubbed out of replayed assistant text so poisoned sessions heal.
//
// Full investigation: private/toolcall-investigation.md.

import { buildMessages, MAX_REPLAYED_TOOL_RESULT_CHARS } from './openai-compatible.ts';
import { computeReplayDelta, renderReplayPrefix } from './replay.ts';
import { sanitizeAssistantText } from '../server/sanitize-assistant-text.ts';
import type { NormalizedEvent } from '../types/events.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else { fail++; console.error(`FAIL: ${name} ${detail}`); }
}

let clock = 1000;
const ts = (): number => ++clock;
const userMsg = (text: string): NormalizedEvent =>
  ({ kind: 'user_message', ts: ts(), text }) as NormalizedEvent;
const asstMsg = (text: string): NormalizedEvent =>
  ({ kind: 'assistant_message', ts: ts(), engine: 'openai-compatible', text }) as NormalizedEvent;
const call = (id: string, tool: string, input: unknown): NormalizedEvent =>
  ({ kind: 'tool_call', ts: ts(), engine: 'openai-compatible', callId: id, tool, input }) as NormalizedEvent;
const result = (id: string, output: unknown, error?: string): NormalizedEvent =>
  ({
    kind: 'tool_result', ts: ts(), engine: 'openai-compatible', callId: id, output,
    ...(error ? { error } : {}),
  }) as NormalizedEvent;

type Msg = { role: string; content: unknown; tool_calls?: Array<{ id: string }>; tool_call_id?: string };

/** The invariant every openai-compatible backend enforces. */
function pairingIsValid(msgs: Msg[]): string | null {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]!;
    if (m.role === 'assistant' && m.tool_calls) {
      const ids = m.tool_calls.map((c) => c.id);
      const following = msgs.slice(i + 1, i + 1 + ids.length);
      if (following.length !== ids.length) return `truncated tool block at ${i}`;
      for (let k = 0; k < ids.length; k++) {
        const t = following[k]!;
        if (t.role !== 'tool') return `expected tool message at ${i + 1 + k}, got ${t.role}`;
        if (t.tool_call_id !== ids[k]) return `id mismatch at ${i + 1 + k}`;
      }
    }
    if (m.role === 'tool') {
      const prev = msgs.slice(0, i).reverse().find((x) => x.role === 'assistant' && x.tool_calls);
      if (!prev) return `orphan tool message at ${i}`;
    }
  }
  return null;
}

async function run(): Promise<void> {
  // ── 1. A tool turn replays natively ──────────────────────────────
  {
    const history: NormalizedEvent[] = [
      userMsg('Baue mir ein Tetris.'),
      call('c1', 'file_write', { path: 'tetris.js' }),
      result('c1', { ok: true }),
      call('c2', 'exec', { command: 'npm install' }),
      result('c2', { stdout: 'added 3 packages' }),
      asstMsg('Fertig, läuft auf Port 3020.'),
      userMsg('und jetzt?'),
    ];
    const msgs = (await buildMessages('SYS', history, undefined, 'native')) as unknown as Msg[];

    const withCalls = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
    check('assistant message carries tool_calls', withCalls !== undefined);
    check('both calls present', withCalls?.tool_calls?.length === 2, JSON.stringify(withCalls));
    check('tool result messages emitted', msgs.filter((m) => m.role === 'tool').length === 2);
    check('pairing valid', pairingIsValid(msgs) === null, pairingIsValid(msgs) ?? '');

    // The tool block must precede the assistant's closing text.
    const idxCalls = msgs.findIndex((m) => m.role === 'assistant' && m.tool_calls);
    const idxText = msgs.findIndex(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('Port 3020'),
    );
    check('tool block precedes the closing text', idxCalls < idxText, `${idxCalls} vs ${idxText}`);

    // The abandoned prose approach must be gone for good.
    const joined = msgs.map((m) => (typeof m.content === 'string' ? m.content : '')).join('|');
    check('no <somora-tool-log> anywhere', !joined.includes('somora-tool-log'), joined.slice(0, 200));

    // Arguments survive as JSON the provider can parse back.
    const args = (withCalls as unknown as { tool_calls: Array<{ function: { name: string; arguments: string } }> })
      .tool_calls;
    check('tool name preserved', args[0]?.function.name === 'file_write');
    check('arguments are valid JSON', (() => {
      try { return JSON.parse(args[0]!.function.arguments).path === 'tetris.js'; } catch { return false; }
    })());
  }

  // ── 2. Unpaired calls are dropped (crashed turn → would 400) ─────
  {
    const history: NormalizedEvent[] = [
      userMsg('mach was'),
      call('x1', 'exec', { command: 'sleep 100' }), // no result: turn died
      userMsg('und jetzt?'),
      asstMsg('Neuer Versuch.'),
    ];
    const msgs = (await buildMessages('SYS', history, undefined, 'native')) as unknown as Msg[];
    check('unpaired call dropped', !msgs.some((m) => m.role === 'assistant' && m.tool_calls));
    check('no orphan tool message', !msgs.some((m) => m.role === 'tool'));
    check('pairing valid after drop', pairingIsValid(msgs) === null, pairingIsValid(msgs) ?? '');
  }

  // ── 3. Partially paired turn keeps only the paired half ──────────
  {
    const history: NormalizedEvent[] = [
      userMsg('mach zwei sachen'),
      call('p1', 'file_read', { path: '/a' }),
      result('p1', { text: 'a' }),
      call('p2', 'exec', { command: 'boom' }), // died before its result
      asstMsg('Eins hat geklappt.'),
      userMsg('ok'),
    ];
    const msgs = (await buildMessages('SYS', history, undefined, 'native')) as unknown as Msg[];
    const withCalls = msgs.find((m) => m.role === 'assistant' && m.tool_calls);
    check('only the paired call survives', withCalls?.tool_calls?.length === 1, JSON.stringify(withCalls));
    check('pairing valid with partial', pairingIsValid(msgs) === null, pairingIsValid(msgs) ?? '');
  }

  // ── 4. Errors replay as results, not as dropped calls ────────────
  {
    const history: NormalizedEvent[] = [
      userMsg('lies das'),
      call('e1', 'file_read', { path: '/nope' }),
      result('e1', null, 'ENOENT: no such file'),
      asstMsg('Datei fehlt.'),
      userMsg('ok'),
    ];
    const msgs = (await buildMessages('SYS', history, undefined, 'native')) as unknown as Msg[];
    const toolMsg = msgs.find((m) => m.role === 'tool');
    check('failed call still replayed', toolMsg !== undefined);
    check('error text carried', String(toolMsg?.content).includes('ENOENT'), String(toolMsg?.content));
    check('pairing valid with error', pairingIsValid(msgs) === null, pairingIsValid(msgs) ?? '');
  }

  // ── 5. Huge results are capped ───────────────────────────────────
  {
    const history: NormalizedEvent[] = [
      userMsg('lies das grosse log'),
      call('b1', 'file_read', { path: '/big.log' }),
      result('b1', { text: 'x'.repeat(50_000) }),
      asstMsg('gelesen'),
      userMsg('ok'),
    ];
    const msgs = (await buildMessages('SYS', history, undefined, 'native')) as unknown as Msg[];
    const toolMsg = msgs.find((m) => m.role === 'tool')!;
    const len = String(toolMsg.content).length;
    check('result truncated', len <= MAX_REPLAYED_TOOL_RESULT_CHARS + 32, `${len} chars`);
    check('truncation disclosed', String(toolMsg.content).includes('truncated'));
  }

  // ── 6. Tool-less history is untouched ────────────────────────────
  {
    const history: NormalizedEvent[] = [userMsg('hi'), asstMsg('hallo')];
    const msgs = (await buildMessages('SYS', history, undefined, 'native')) as unknown as Msg[];
    check('plain history has 3 messages', msgs.length === 3, String(msgs.length));
    check('no tool_calls invented', !msgs.some((m) => m.tool_calls));
  }

  // ── 7. Poisoned history heals on rebuild ─────────────────────────
  {
    const history: NormalizedEvent[] = [
      userMsg('starte den server'),
      asstMsg('<somora-tool-log>\n5 calls:\n- exec ×3 → ok\n</somora-tool-log>\n\nPort 3020 ist frei.'),
      userMsg('und jetzt?'),
    ];
    const msgs = (await buildMessages('SYS', history, undefined, 'native')) as unknown as Msg[];
    const asst = msgs.find((m) => m.role === 'assistant')!;
    check('fabricated block scrubbed', !String(asst.content).includes('<somora-tool-log>'), String(asst.content));
    check('surrounding prose kept', String(asst.content).includes('Port 3020 ist frei'));
  }

  // ── 8. Cross-engine replay carries no tool markup ────────────────
  {
    const delta = computeReplayDelta(
      [userMsg('bau was'), call('r1', 'exec', { command: 'ls' }), result('r1', {}), asstMsg('gebaut')],
      0, undefined,
    );
    const rendered = renderReplayPrefix(delta);
    check('replay has the pair', rendered.includes('gebaut'), rendered);
    check('replay carries no tool-log marker', !rendered.includes('somora-tool-log'), rendered);
  }

  // ── 9. Sanitizer still guards the assistant channel ──────────────
  {
    const closed = sanitizeAssistantText('A\n<somora-tool-log>\n1 call:\n- exec → ok\n</somora-tool-log>\nB');
    check('closed fabrication stripped', !closed.text.includes('<somora-tool-log>'), closed.text);
    check('closed fabrication counted', closed.matches === 1);
    check('text around it kept', closed.text.includes('A') && closed.text.includes('B'));

    const open = sanitizeAssistantText('Ich schaue nach.\n<somora-tool-log>\n3 calls:');
    check('unterminated fabrication stripped', !open.text.includes('<somora-tool-log>'), open.text);

    const legacy = sanitizeAssistantText('<tool_call>{"name":"exec"}</tool_call>');
    check('legacy tool_call path intact', legacy.matches === 1 && legacy.text.includes('exec'));

    const clean = sanitizeAssistantText('Normale Antwort.');
    check('clean text untouched', clean.text === 'Normale Antwort.' && clean.matches === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

await run();
