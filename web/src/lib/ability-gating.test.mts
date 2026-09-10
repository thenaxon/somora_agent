// The eye in the Abilities window, as list arithmetic on the agent's
// deny-list. The cases worth pinning down are the ones a click test
// would never reach: a half-hidden group, and a deny-list that also
// holds entries this group has no business touching.
//
// Run: npx tsx web/src/lib/ability-gating.test.mts

import assert from 'node:assert/strict';
import { toggleGroupVisibility } from './ability-gating';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const shown = (name: string) => ({ name, visible: true });
const hidden = (name: string) => ({ name, visible: false });

// ── a single row ───────────────────────────────────────────────────
{
  const next = toggleGroupVisibility([], [shown('exec_bash')]);
  check('single: a visible tool gets denied', next.join() === 'exec_bash', next.join());
}
{
  const next = toggleGroupVisibility(['exec_bash'], [hidden('exec_bash')]);
  check('single: a hidden tool is un-denied', next.length === 0, next.join());
}

// ── whole groups ───────────────────────────────────────────────────
{
  const group = [shown('a'), shown('b'), shown('c')];
  const next = toggleGroupVisibility([], group);
  check('group: all visible → all denied in one write', next.join() === 'a,b,c', next.join());
}
{
  const group = [hidden('a'), hidden('b'), hidden('c')];
  const next = toggleGroupVisibility(['a', 'b', 'c'], group);
  check('group: all hidden → all come back', next.length === 0, next.join());
}
{
  // The case that decides the interaction: with a mixed group, one
  // click has to reach a definite state instead of inverting each row.
  const group = [shown('a'), hidden('b'), shown('c')];
  const next = toggleGroupVisibility(['b'], group);
  check('group: mixed → everything hides', next.slice().sort().join() === 'a,b,c', next.join());

  const back = toggleGroupVisibility(next, group.map((r) => hidden(r.name)));
  check('group: and the second click brings all of it back', back.length === 0, back.join());
}
{
  const next = toggleGroupVisibility(['x'], []);
  check('group: an empty group changes nothing', next.join() === 'x', next.join());
}

// ── the rest of the deny-list is operator policy ───────────────────
{
  // Globs and toolset: rules flip the matrix read-only in the UI, but
  // if one ever reaches this function it must survive untouched.
  const deny = ['mcp__design__*', 'toolset:exec', 'other_tool'];
  const next = toggleGroupVisibility(deny, [shown('a'), shown('b')]);
  check(
    'policy: pattern rules and foreign names are kept, in order',
    next.join() === 'mcp__design__*,toolset:exec,other_tool,a,b',
    next.join(),
  );
}
{
  const next = toggleGroupVisibility(['keep_me', 'a'], [hidden('a'), hidden('b')]);
  check('policy: un-hiding only removes this group', next.join() === 'keep_me', next.join());
}
{
  // Re-denying an already-denied name must not double it — the list
  // goes to the server as-is.
  const next = toggleGroupVisibility(['a'], [shown('a'), shown('b')]);
  check('policy: no duplicate entries', next.join() === 'a,b', next.join());
}
{
  const deny = ['a'];
  const next = toggleGroupVisibility(deny, [shown('b')]);
  check('policy: the input list is never mutated', deny.join() === 'a' && next.join() === 'a,b', deny.join());
}

console.log(`ability-gating: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
