// Unit tests for the /queue formatting: status-line counters and the
// listing block, from a GET …/work response shape.
//
// Run: npx tsx src/cli/tui/work-queue.test.mts

import assert from 'node:assert/strict';
import { formatAge, formatWorkCounters, formatWorkList, queueEntryAt, workLabel } from './work-queue.ts';
import type { SessionWork } from './types.ts';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    console.error(`FAIL ${name}: ${(err as Error).message}`);
  }
}

const NOW = 1_800_000_000_000;
const idle: SessionWork = {
  asOf: NOW,
  agent: 'hans',
  session: 'main',
  busy: false,
  active: null,
  queued: [],
  pendingWakes: [],
  children: [],
};

const busyWork: SessionWork = {
  ...idle,
  busy: true,
  active: {
    id: 'call-1',
    kind: 'agent',
    state: 'running',
    preview: 'What did the nightly build say?',
    target: { agent: 'hans', session: 'main' },
    requester: { agent: 'lisa', session: 'main' },
    enqueuedAt: NOW - 20_000,
    startedAt: NOW - 12_000,
    turnId: 't-1',
  },
  queued: [
    {
      id: 't-2',
      kind: 'human',
      state: 'queued',
      preview: 'and then deploy it',
      target: { agent: 'hans', session: 'main' },
      requester: { human: true },
      enqueuedAt: NOW - 65_000,
      position: 1,
    },
    {
      id: 'task-3',
      kind: 'sentinel',
      state: 'queued',
      preview: '',
      target: { agent: 'hans', session: 'main' },
      enqueuedAt: NOW - 5_000,
      position: 2,
    },
  ],
  pendingWakes: [
    {
      id: 'call-9',
      kind: 'wake',
      about: 'a2a',
      state: 'done',
      preview: '',
      target: { agent: 'lisa', session: 'main' },
      requester: { agent: 'hans', session: 'main' },
      finishedAt: NOW - 1_000,
    },
  ],
  children: [
    {
      id: 'task-4',
      kind: 'subagent',
      state: 'running',
      preview: 'summarize the log',
      target: { agent: 'hans', session: 'sub-abc' },
      requester: { agent: 'hans', session: 'main' },
      enqueuedAt: NOW - 30_000,
      startedAt: NOW - 30_000,
    },
    {
      id: 'call-5',
      kind: 'agent',
      state: 'queued',
      preview: 'is the DB up?',
      target: { agent: 'lisa', session: 'main' },
      requester: { agent: 'hans', session: 'main' },
      enqueuedAt: NOW - 3_000,
    },
  ],
};

check('formatAge: seconds, minutes, hours', () => {
  assert.equal(formatAge(12_400), '12s');
  assert.equal(formatAge(185_000), '3m 05s');
  assert.equal(formatAge(2 * 3600_000 + 14 * 60_000), '2h 14m');
  assert.equal(formatAge(-5), '0s');
});

check('counters: empty when idle or unknown', () => {
  assert.equal(formatWorkCounters(null), '');
  assert.equal(formatWorkCounters(idle), '');
});

check('counters: waiting, running, from here, arriving', () => {
  assert.equal(formatWorkCounters(busyWork), '⌛2 ▶1 🤖2 ↩1');
  // A busy lock without a ledger item still counts as one running turn.
  assert.equal(formatWorkCounters({ ...idle, busy: true }), '▶1');
});

check('labels reuse the scrollback glyphs', () => {
  assert.equal(workLabel({ kind: 'human' }), '👤 you');
  assert.equal(workLabel({ kind: 'sentinel' }), '🔔 sentinel');
  assert.equal(workLabel({ kind: 'wake', about: 'job' }), '🎬 video');
  assert.equal(workLabel({ kind: 'wake', about: 'subagent' }), '🤖 subagent');
});

check('list: idle session', () => {
  const text = formatWorkList(idle, NOW);
  assert.equal(
    text,
    ['Queue for hans:main', 'Running:', '  nothing', 'Waiting (0):', '  nothing'].join('\n'),
  );
});

check('list: every section, numbered waiting entries with age', () => {
  const lines = formatWorkList(busyWork, NOW).split('\n');
  assert.equal(lines[0], 'Queue for hans:main');
  assert.equal(lines[1], 'Running:');
  assert.equal(lines[2], '  💬 agent ask  "What did the nightly build say?", from lisa:main, since 12s');
  assert.equal(lines[3], 'Waiting (2):');
  assert.equal(lines[4], '   1. 👤 you  "and then deploy it", from you, waited 1m 05s');
  assert.equal(lines[5], '   2. 🔔 sentinel  (no preview), waited 5s');
  assert.equal(lines[6], 'Arriving (1):');
  assert.equal(lines[7], '  ↩  agent answer  answer from lisa:main, 1s ago');
  assert.equal(lines[8], 'From here (2):');
  // numbered on from the waiting entries (2), so /queue rm 3 / rm 4 reach them
  assert.equal(lines[9], '   3. 🤖 subagent → hans:sub-abc  "summarize the log"  [running, since 30s]');
  assert.equal(lines[10], '   4. 💬 agent ask → lisa:main  "is the DB up?"  [queued, waited 3s]');
  assert.equal(lines[11], '/queue rm <n> removes a waiting entry; on a running entry under "From here" it stops it.');
  assert.equal(lines.length, 12);
});

check('rm <n> resolves waiting entries first, then children in list order', () => {
  const w = busyWork;
  assert.equal(queueEntryAt(w, 1)?.where, 'waiting');
  assert.equal(queueEntryAt(w, 2)?.where, 'waiting');
  assert.equal(queueEntryAt(w, 3)?.where, 'children');
  assert.equal(queueEntryAt(w, 3)?.item.state, 'running');
  assert.equal(queueEntryAt(w, 4)?.item.state, 'queued');
  assert.equal(queueEntryAt(w, 5), null);
});

check('list: no server answer', () => {
  assert.match(formatWorkList(null, NOW), /did not answer/);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
