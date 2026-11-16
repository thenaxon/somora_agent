// One look at a pane: the observe command's output parsed, the agent
// found by its process, the declared kind only when ps shows nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStateOf, observeCommand, parseObserve } from './observe.ts';

const SEP = '\u001fSOMORA-OBSERVE\u001f';
const out = (ps: string, screen = 'some output\n› Ask Codex to do anything\n', title = 'demo') =>
  [`30 100 codex\n`, `${title}\n`, ps, `${screen}\n\n\n`, screen, 'scrollback\n' + screen].join(`${SEP}\n`);

test('the observe output is parsed; the screen loses its trailing blank rows', () => {
  const look = parseObserve(out(' 1 1 1 codex\n'))!;
  assert.equal(look.height, 30);
  assert.equal(look.width, 100);
  assert.equal(look.title, 'demo');
  assert.equal(look.processes.length, 1);
  assert.equal(look.screen, 'some output\n› Ask Codex to do anything');
  assert.match(look.content, /^scrollback/);
  assert.equal(parseObserve('garbage'), null);
});

test('the agent comes from the process; a declared kind only when ps shows nothing', () => {
  assert.equal(agentStateOf(parseObserve(out(' 1 1 1 codex -m x\n'))!)?.name, 'codex');
  assert.equal(agentStateOf(parseObserve(out(' 1 1 1 codex -m x\n'))!)?.identified_by, 'process');
  // A shell in the foreground: the agent exited — no agent, whatever was declared.
  assert.equal(agentStateOf(parseObserve(out(' 1 1 1 -bash\n'))!, 'codex'), null);
  // ps cannot show the terminal (some remote host): fall back to the kind.
  const byKind = agentStateOf(parseObserve(out(''))!, 'codex');
  assert.equal(byKind?.name, 'codex');
  assert.equal(byKind?.identified_by, 'kind');
  assert.equal(agentStateOf(parseObserve(out(''))!, 'claude-code')?.name, 'claude');
  assert.equal(agentStateOf(parseObserve(out(''))!), null);
});

test('the command quotes the session name and asks for what was wanted', () => {
  const c = observeCommand("it's", { lines: 50, ansi: true, joinWrapped: true });
  assert.ok(c.includes(`'=it'\\''s:'`));
  assert.ok(c.includes('capture-pane -p -e -J'));
  assert.ok(c.includes('-S -50'));
  assert.ok(c.includes('ps -o pid=,pgid=,tpgid=,args='));
});
