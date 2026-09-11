// An answer nobody is waiting for still has to arrive (2026-09-12).
//
// Run: npx tsx src/server/ask-attention.test.mts
//
// What happened: hans asked lisa for research with the minimum timeout,
// got `pending` after 1.005 seconds and ended his turn four seconds
// later. Lisa worked for 208 seconds and wrote a complete answer — into
// her own session. The result sat in the registry, correct and
// complete, and nobody ever learned it existed. A spawned sub-agent has
// woken its parent since July; an agent_ask never did.
import assert from 'node:assert/strict';

import {
  completeAskCall,
  configureAskAttention,
  failAskCall,
  getAskCall,
  markAskCallPending,
  registerAskCall,
} from './ask-calls.ts';
import type { ChatTurnResult } from './run-turn-types.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log('  ok  ', name); }
  else { fail++; console.error('  FAIL', name, detail); }
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const wakes: Array<{ agent: string; session: string; text: string }> = [];
configureAskAttention({
  graceMs: 10,
  dispatchWakeTurn: async (args) => { wakes.push(args); },
});

const result = (text: string): ChatTurnResult =>
  ({ finalText: text, outcome: 'completed', tool_calls: 0, contextWindow: 1, provider: 'p', model: 'm', thinkingActive: false, ms: 1 }) as ChatTurnResult;

let n = 0;
const register = (opts: { pending: boolean }): string => {
  const call_id = `call-${++n}`;
  registerAskCall({
    call_id,
    from_agent: 'hans',
    from_session: '20260912-000000_main',
    target_agent: 'lisa',
    target_session: 'main',
  });
  if (opts.pending) markAskCallPending(call_id);
  return call_id;
};

// ── the case from the log ────────────────────────────────────────────
{
  wakes.length = 0;
  const id = register({ pending: true });
  completeAskCall(id, result('# iPhone Duo — Österreich-Recherche\nDatum: 2026-09-11 …'));
  await delay(40);
  check('the asker is woken', wakes.length === 1, String(wakes.length));
  check('in the session it asked from', wakes[0]?.session === '20260912-000000_main');
  check('and it is hans, not lisa', wakes[0]?.agent === 'hans');
  check('the wake carries the beginning of the answer', wakes[0]?.text.includes('iPhone Duo') === true, wakes[0]?.text);
  check('and says how to read the rest', wakes[0]?.text.includes(`agent_ask_result({ call_id: "${id}"`) === true);
}

// ── someone still on the line needs no wake ─────────────────────────
{
  wakes.length = 0;
  const id = register({ pending: false });
  completeAskCall(id, result('sofort beantwortet'));
  await delay(40);
  check('a caller that waited is not woken twice', wakes.length === 0, String(wakes.length));
}

// ── an asker that polls first is left alone ─────────────────────────
{
  wakes.length = 0;
  const id = register({ pending: true });
  completeAskCall(id, result('fertig'));
  getAskCall(id); // agent_ask_result
  await delay(40);
  check('a fetched result raises no wake', wakes.length === 0, String(wakes.length));
}

// ── a failure is news too ───────────────────────────────────────────
{
  wakes.length = 0;
  const id = register({ pending: true });
  failAskCall(id, 'target model refused');
  await delay(40);
  check('a failed call wakes as well', wakes.length === 1, String(wakes.length));
  check('and names the failure', wakes[0]?.text.includes('target model refused') === true, wakes[0]?.text);
}

// ── an asker without a session cannot be woken ──────────────────────
{
  wakes.length = 0;
  const call_id = 'call-nosession';
  registerAskCall({ call_id, from_agent: 'hans', target_agent: 'lisa', target_session: 'main' });
  markAskCallPending(call_id);
  completeAskCall(call_id, result('x'));
  await delay(40);
  check('no session, no wake, no crash', wakes.length === 0, String(wakes.length));
}

console.log(`\n${pass} ok, ${fail} failed`);
assert.equal(fail, 0);
