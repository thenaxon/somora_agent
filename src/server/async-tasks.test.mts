// Tests for subagent task cancel + attention-wake bookkeeping
// (2026-07-28 feedback: no cancel, no cap fairness, results rotting
// unfetched).
//
// Run: npx tsx src/server/async-tasks.test.mts

import {
  cancelTaskCascade,
  completeTask,
  configureSubagentAttention,
  failTask,
  getTask,
  listChildTasks,
  markResultFetched,
  registerTask,
} from './async-tasks.ts';
import { registerChatAbort } from './chat-aborts.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const RESULT = { finalText: 'ok', model: 'test', ms: 1, usage: {}, thinkingActive: false } as never;

function mkTask(id: string, parent: [string, string], target: [string, string], attention?: boolean) {
  registerTask({
    task_id: id,
    parent_agent: parent[0],
    parent_session: parent[1],
    target_agent: target[0],
    target_session: target[1],
    started_at: Date.now(),
    ...(attention !== undefined ? { attention } : {}),
  });
}

// ── cascade: orchestrator + 2 children + 1 grandchild ───────────────
{
  mkTask('t_root', ['hans', 'main'], ['hans', 'sub-self-1']);
  mkTask('t_c1', ['hans', 'sub-self-1'], ['hans', 'sub-self-2']);
  mkTask('t_c2', ['hans', 'sub-self-1'], ['hans', 'sub-self-3']);
  mkTask('t_gc', ['hans', 'sub-self-2'], ['hans', 'sub-self-4']);
  // One child already finished — must be skipped, not flipped.
  completeTask('t_c2', RESULT);

  // Live abort controller on the root's session — cancel must fire it.
  const abort = registerChatAbort('hans', 'sub-self-1');
  let signalFired = false;
  abort.signal.addEventListener('abort', () => {
    signalFired = true;
  });

  const outcome = cancelTaskCascade('t_root', 'cancelled by hans: switching models');
  check('cascade cancelled root + running descendants',
    JSON.stringify(outcome?.cancelled.sort()) === JSON.stringify(['t_c1', 't_gc', 't_root']),
    JSON.stringify(outcome));
  check('finished child skipped with its state',
    outcome?.skipped.some((s) => s.task_id === 't_c2' && s.state === 'done') === true,
    JSON.stringify(outcome?.skipped));
  check('root state is cancelled', getTask('t_root')?.state === 'cancelled');
  check('grandchild state is cancelled', getTask('t_gc')?.state === 'cancelled');
  check('abort signal fired for the root session', signalFired);
  check('cancel reason recorded',
    (getTask('t_root')?.error ?? '').includes('switching models'),
    getTask('t_root')?.error ?? '');
  abort.release();

  // Terminal guard: the settling runChatTurn promise must not flip a
  // cancelled task back to done/failed.
  completeTask('t_root', RESULT);
  failTask('t_c1', 'late failure');
  check('completeTask cannot overwrite cancelled', getTask('t_root')?.state === 'cancelled');
  check('failTask cannot overwrite cancelled', getTask('t_c1')?.state === 'cancelled');
}

// ── listChildTasks scoping ──────────────────────────────────────────
{
  check('children scoped to (agent, session)',
    listChildTasks('hans', 'sub-self-1').map((t) => t.task_id).sort().join(',') === 't_c1,t_c2');
  check('unknown session has no children', listChildTasks('hans', 'nope').length === 0);
}

// ── cancel of unknown task ──────────────────────────────────────────
check('unknown task → null', cancelTaskCascade('t_missing', 'x') === null);

// ── attention wake: fires when unfetched, suppressed when fetched ───
{
  const wakes: string[] = [];
  configureSubagentAttention({
    graceMs: 50,
    dispatchWakeTurn: async ({ session }) => {
      wakes.push(session);
    },
  });

  mkTask('t_wake', ['hans', 'main'], ['hans', 'sub-self-9']);
  completeTask('t_wake', RESULT);

  mkTask('t_fetched', ['hans', 'main2'], ['hans', 'sub-self-10']);
  completeTask('t_fetched', RESULT);
  markResultFetched('t_fetched'); // parent got the result before grace

  mkTask('t_optout', ['hans', 'main3'], ['hans', 'sub-self-11'], false);
  completeTask('t_optout', RESULT);

  mkTask('t_noparent', ['hans', '?'], ['hans', 'sub-self-12']);
  completeTask('t_noparent', RESULT);

  await delay(150);
  check('wake fired for unfetched task', wakes.includes('main'), JSON.stringify(wakes));
  check('no wake when result was fetched in grace window', !wakes.includes('main2'));
  check('no wake with attention:false', !wakes.includes('main3'));
  check('no wake without parent session', !wakes.includes('?'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
