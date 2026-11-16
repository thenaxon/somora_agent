// prompt and start against a scripted pane: recorded Pi screens
// (__fixtures__/pi) behind a fake tmux, a fake clock. What is refused
// sends nothing; a prompt counts as taken only on activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newConversation, promptAgent, startAgent, type DriveClock } from './drive.ts';
import type { RunResult, Runner } from './observe.ts';

const fx = (c: string) => readFileSync(new URL(`./__fixtures__/pi/${c}.txt`, import.meta.url), 'utf8');
const IDLE = fx('startup-idle');
const WORKING = fx('working-tool');
const DONE = fx('done-after-task');
const SEP = '\u001fSOMORA-OBSERVE\u001f';

interface Pane {
  screen: string;
  /** The foreground process (args); null = a bare shell. */
  proc: string | null;
  title?: string;
  /** A host whose ps lists nothing for a terminal. */
  noPs?: boolean;
  /** The foreground program when it is no agent and no shell (vim, python). */
  other?: string;
}

/** A pane whose look changes on the commands the driver sends. */
function fakeTmux(initial: Pane, on: { paste?: (p: Pane) => Pane; enter?: (p: Pane) => Pane[]; typeCmd?: (p: Pane) => Pane[] }) {
  let pane = initial;
  let queue: Pane[] = [];
  const sent: string[] = [];
  const run: Runner = async (cmd): Promise<RunResult> => {
    const ok = (stdout = ''): RunResult => ({ ok: true, exit_code: 0, stdout, stderr: '' });
    if (cmd.startsWith('tmux display-message')) {
      // Each look advances one scripted step after an action.
      if (queue.length > 0) pane = queue.shift()!;
      const fg = pane.proc ?? pane.other;
      const ps = pane.noPs ? '' : fg ? ` 100  100  200 -bash\n 200  200  200 ${fg}\n` : ' 100  100  100 -bash\n';
      return ok([`40 120 ${pane.proc ?? 'bash'}\n`, `${pane.title ?? ''}\n`, ps, `${pane.screen}\n`, `${pane.screen}\n`, pane.screen].join(`${SEP}\n`));
    }
    sent.push(cmd);
    if (cmd.includes('paste-buffer') && on.paste) pane = on.paste(pane);
    else if (/send-keys -t '=[^']+' Enter$/.test(cmd) && on.enter) queue = on.enter(pane);
    else if (cmd.includes('send-keys') && cmd.includes(' -l -- ') && on.typeCmd) queue = on.typeCmd(pane);
    return ok();
  };
  return { run, sent };
}

function fakeClock(): DriveClock {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

const pi = (screen: string): Pane => ({ screen, proc: 'pi', title: 'π - demo' });
const withText = (p: Pane): Pane => ({ ...p, screen: `${p.screen}\n typed prompt text` });

test('prompt: idle → taken → working → done, waited for', async () => {
  const t = fakeTmux(pi(IDLE), { paste: withText, enter: () => [pi(WORKING), pi(WORKING), pi(DONE)] });
  const r = await promptAgent(t.run, 'p', { text: 'do it', wait: true, timeoutMs: 60_000, lines: 20, clock: fakeClock() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.submitted, true);
  assert.equal(r.settled, true);
  assert.equal(r.agent?.state, 'idle');
  assert.ok(t.sent.some((c) => c.includes('paste-buffer -p')), 'pasted as bracketed paste');
});

test('prompt: an answer faster than a look still counts (the screen moved on)', async () => {
  const t = fakeTmux(pi(IDLE), { paste: withText, enter: () => [pi(DONE)] });
  let submittedAt = 0;
  const r = await promptAgent(t.run, 'p', { text: 'quick', wait: false, timeoutMs: 60_000, lines: 20, clock: fakeClock(), onSubmitted: (at) => (submittedAt = at) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.submitted, true);
  assert.ok(submittedAt > 0, 'the start is reported when Enter went out');
});

test('prompt: no sign of activity → agent_prompt_stalled, not sent twice', async () => {
  const t = fakeTmux(pi(IDLE), { paste: withText, enter: (p) => [p] });
  const r = await promptAgent(t.run, 'p', { text: 'lost', wait: true, timeoutMs: 60_000, lines: 20, clock: fakeClock() });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'agent_prompt_stalled');
  assert.equal(t.sent.filter((c) => c.includes('paste-buffer')).length, 1);
});

test('prompt: a working, blocked, unknown agent or a shell gets nothing typed', async () => {
  const blocked: Pane = { screen: fx('startup-idle'), proc: 'codex', title: '[ ! ] Action Required | demo' };
  const unknown: Pane = { screen: '  showing detailed transcript\n ctrl+o to toggle', proc: 'claude' };
  for (const [pane, error] of [
    [pi(WORKING), 'agent_busy'],
    [blocked, 'agent_blocked'],
    [unknown, 'agent_state_unknown'],
    [{ screen: 'user@host:~$ ', proc: null }, 'no_agent'],
  ] as Array<[Pane, string]>) {
    const t = fakeTmux(pane, {});
    let submitted = false;
    const r = await promptAgent(t.run, 'p', { text: 'x', wait: true, timeoutMs: 60_000, lines: 20, clock: fakeClock(), onSubmitted: () => (submitted = true) });
    assert.equal(r.error, error, JSON.stringify(r));
    assert.deepEqual(t.sent, [], `${error}: nothing sent`);
    assert.equal(submitted, false, `${error}: no task start`);
    assert.ok(r.hint && r.hint.length > 20, 'a hint for the model');
  }
});

test('prompt with wait: a dialog ends the wait as blocked', async () => {
  const dialog: Pane = { screen: fx('startup-idle'), proc: 'codex', title: '[ ! ] Action Required | demo' };
  const t = fakeTmux({ screen: fx('startup-idle'), proc: 'codex', title: 'demo' }, {
    paste: withText,
    enter: () => [{ ...dialog, title: '⠧ working | demo' }, dialog, dialog, dialog],
  });
  const r = await promptAgent(t.run, 'p', { text: 'needs approval', wait: true, timeoutMs: 60_000, lines: 20, clock: fakeClock() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.settled, true);
  assert.equal(r.agent?.state, 'blocked');
});

test('prompt with wait: timeout says so and keeps the state', async () => {
  const t = fakeTmux(pi(IDLE), { paste: withText, enter: () => Array.from({ length: 2000 }, () => pi(WORKING)) });
  const r = await promptAgent(t.run, 'p', { text: 'long', wait: true, timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timeout');
  assert.equal(r.submitted, true);
  assert.equal(r.agent?.state, 'working');
});

test('start: the command is typed into the shell; ready once idle holds', async () => {
  const t = fakeTmux({ screen: 'user@host:~$ ', proc: null }, { typeCmd: () => Array.from({ length: 50 }, () => pi(IDLE)) });
  const r = await startAgent(t.run, 'p', { command: 'pi --model x', timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent?.name, 'pi');
  assert.ok(t.sent.some((c) => c.includes("'pi --model x'")));
});

test('start: a dialog at startup is agent_not_ready with state blocked; an agent already there is refused', async () => {
  const dialog: Pane = { screen: 'Trust this folder?', proc: 'codex', title: '[ ! ] Action Required | demo' };
  const t = fakeTmux({ screen: 'user@host:~$ ', proc: null }, { typeCmd: () => [dialog, dialog] });
  const r = await startAgent(t.run, 'p', { command: 'codex', timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(r.error, 'agent_not_ready');
  assert.equal(r.agent?.state, 'blocked');
  const busy = fakeTmux(pi(IDLE), {});
  const b = await startAgent(busy.run, 'p', { command: 'pi', timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(b.ok, false);
  assert.deepEqual(busy.sent, []);
});

test('start: an editor or REPL in the pane gets nothing typed (not_a_shell)', async () => {
  for (const other of ['vim notes.md', 'python3']) {
    const t = fakeTmux({ screen: '~\n~\n-- INSERT --', proc: null, other }, {});
    const r = await startAgent(t.run, 'p', { command: 'codex', timeoutMs: 30_000, lines: 20, clock: fakeClock() });
    assert.equal(r.error, 'not_a_shell', other);
    assert.deepEqual(t.sent, [], `${other}: nothing typed`);
  }
});

test('start on a host without ps: the declared kind recognises the agent once it runs', async () => {
  const t = fakeTmux({ screen: 'user@host:~$ ', proc: null, noPs: true }, {
    typeCmd: () => Array.from({ length: 50 }, () => ({ ...pi(IDLE), proc: null, noPs: true })),
  });
  const r = await startAgent(t.run, 'p', { command: 'pi', kind: 'pi', timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent?.identified_by, 'kind');
});

test('prompt: a moment of working (Codex after /new) passes before agent_busy', async () => {
  const t = fakeTmux(pi(WORKING), { paste: withText, enter: () => [pi(WORKING), pi(DONE)] });
  // The first looks show working, then the pane settles to idle by itself.
  let looks = 0;
  const run: typeof t.run = async (cmd) => {
    if (cmd.startsWith('tmux display-message') && looks++ === 2) {
      // third look: idle
      return t.run(cmd).then((r) => ({ ...r, stdout: r.stdout.replaceAll(WORKING, IDLE) }));
    }
    return t.run(cmd);
  };
  const r = await promptAgent(run, 'p', { text: 'go', wait: false, timeoutMs: 60_000, lines: 20, clock: fakeClock() });
  assert.notEqual(r.error, 'agent_busy', JSON.stringify(r));
});

const CODEX_IDLE = { screen: '› Ask Codex to do anything', proc: 'codex', title: 'demo' };
const worktreeDialog = (preselected: boolean): Pane => ({
  screen: [
    '  Where should the new conversation run?',
    '',
    `${preselected ? '›' : ' '} 1. Use current Git worktree`,
    `${preselected ? ' ' : '›'} 2. Create new Git worktree`,
    '',
    '  enter select · esc back',
  ].join('\n'),
  proc: 'codex',
  title: 'demo',
});

test('new_conversation: the agent\'s own command, back when idle', async () => {
  const t = fakeTmux(pi(DONE), { paste: withText, enter: () => [pi(IDLE), pi(IDLE), pi(IDLE), pi(IDLE)] });
  const r = await newConversation(t.run, 'p', { timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.command, '/new');
  assert.ok(t.sent.some((c) => c.includes("printf '%s' '/new'")));
});

test('new_conversation: Codex\'s worktree question is answered with the current worktree', async () => {
  let enters = 0;
  const t = fakeTmux(CODEX_IDLE, {
    paste: withText,
    enter: () => (++enters === 1 ? [worktreeDialog(true), worktreeDialog(true), worktreeDialog(true), worktreeDialog(true)] : [CODEX_IDLE, CODEX_IDLE, CODEX_IDLE, CODEX_IDLE]),
  });
  const r = await newConversation(t.run, 'cx', { timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent?.state, 'idle');
  assert.equal(t.sent.filter((c) => /send-keys -t '=cx:' Enter$/.test(c)).length, 2, 'Enter for /new, Enter for the dialog');
  assert.equal(r.dialog_answered, 'codex_worktree: use current');
});

test('new_conversation: another choice preselected is handed back as blocked; an unknown agent is not_supported', async () => {
  const t = fakeTmux(CODEX_IDLE, { paste: withText, enter: () => [worktreeDialog(false), worktreeDialog(false), worktreeDialog(false), worktreeDialog(false)] });
  const r = await newConversation(t.run, 'cx', { timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(r.error, 'agent_blocked', JSON.stringify(r));
  assert.equal(t.sent.filter((c) => /send-keys -t '=cx:' Enter$/.test(c)).length, 1, 'the dialog is not answered');
  const g = fakeTmux({ screen: 'grok ready', proc: 'grok', title: '' }, {});
  const u = await newConversation(g.run, 'g', { timeoutMs: 30_000, lines: 20, clock: fakeClock() });
  assert.equal(u.error, 'not_supported');
  assert.deepEqual(g.sent, []);
});
