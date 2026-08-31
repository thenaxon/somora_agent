// Regression tests for codex stream-error extraction (2026-08-31).
//
// Run: npx tsx src/engine/codex-events.test.mts
//
// The event lines are verbatim from `codex exec --json` (codex-cli
// 0.144.6) with an unsupported model — the stream that reached the
// compaction summarizer as "exit 1, stderr empty" before this landed.

import assert from 'node:assert/strict';
import { CodexFailureDetail, codexStreamError, flattenCodexErrorMessage } from './codex-events.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const LINES = [
  '{"type":"thread.started","thread_id":"01a05772-c7b5-7023-9e0f-504314c22a4b"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5.3-codex` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}',
  '{"type":"turn.started"}',
  '{"type":"error","message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account.\\"}}"}',
  '{"type":"turn.failed","error":{"message":"{\\"type\\":\\"error\\",\\"status\\":400,\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account.\\"}}"}}',
];
const events = LINES.map((l) => JSON.parse(l) as { type?: string; [k: string]: unknown });

check('thread.started is not an error', codexStreamError(events[0]!) === null);
check('turn.started is not an error', codexStreamError(events[2]!) === null);
check(
  'item error surfaces its message',
  codexStreamError(events[1]!)?.startsWith('Model metadata for `gpt-5.3-codex` not found') === true,
  String(codexStreamError(events[1]!)),
);
const flat = codexStreamError(events[3]!);
check(
  'error event flattens the nested JSON envelope',
  flat === "HTTP 400 invalid_request_error: The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
  String(flat),
);
check('turn.failed yields the same flattened text', codexStreamError(events[4]!) === flat);
check('turn.failed without message still reports', codexStreamError({ type: 'turn.failed' }) === 'turn.failed (no message)');
check('non-JSON message passes through', flattenCodexErrorMessage('plain text') === 'plain text');
check('JSON without message passes through raw', flattenCodexErrorMessage('{"a":1}') === '{"a":1}');

{
  const d = new CodexFailureDetail();
  for (const ev of events) d.observe(ev);
  check('dedupes error + turn.failed into one entry', d.errors.length === 2, JSON.stringify(d.errors));
  const rendered = d.render('');
  check('render with empty stderr carries the stream errors', rendered.includes("HTTP 400") && rendered.includes('Model metadata'), rendered);
  check('render appends stderr when present', d.render('boom').endsWith('[stderr: boom]'), d.render('boom'));
  const cap = new CodexFailureDetail().render('x'.repeat(2000), 500);
  check('render caps stderr at max', cap.length === 500, String(cap.length));
}
{
  const empty = new CodexFailureDetail();
  check(
    'nothing observed + empty stderr → explicit "no error output" line',
    empty.render('').includes('stderr empty, no error event'),
    empty.render(''),
  );
}

console.log(`codex-events: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
