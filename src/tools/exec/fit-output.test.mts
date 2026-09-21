// exec result fitting — honest about what is missing, still a result.
// Run: npx tsx src/tools/exec/fit-output.test.mts
import assert from 'node:assert/strict';
import { fitExecOutput, EXEC_RESULT_TEXT_BUDGET } from './fit-output.ts';

// small output: untouched
{
  const r = fitExecOutput('hello\n', 'warn\n');
  assert.deepEqual(r, { stdout: 'hello\n', stderr: 'warn\n', shortened: false });
}
// the incident shape: a big HTML page on stdout
{
  const page = '<html>START' + 'x'.repeat(150_000) + 'END</html>';
  const r = fitExecOutput(page, '');
  assert.equal(r.shortened, true);
  assert.ok(r.stdout.startsWith('<html>START'), 'head kept');
  assert.ok(r.stdout.endsWith('END</html>'), 'tail kept — the end of the output is not lost');
  assert.match(r.stdout, /chars of stdout omitted here — output shortened by somora, NOT the end/);
  assert.ok(r.stdout.length < EXEC_RESULT_TEXT_BUDGET + 300, `${r.stdout.length}`);
  assert.match(r.hint ?? '', /Do not guess what was omitted/);
  assert.match(r.hint ?? '', /150021 chars/);
  // and the whole thing stays under the registry cap, so the envelope survives
  const envelope = JSON.stringify({ ok: true, exit_code: 0, stdout: r.stdout, stderr: r.stderr, truncated: true, hint: r.hint });
  assert.ok(envelope.length < 100_000, `${envelope.length}`);
}
// failing build: huge stdout, the error is at the end of stderr
{
  const r = fitExecOutput('log line\n'.repeat(30_000), 'noise\n'.repeat(5_000) + 'FATAL: the real reason\n');
  assert.ok(r.stderr.endsWith('FATAL: the real reason\n'), 'stderr tail kept');
  assert.ok(r.stdout.length + r.stderr.length < EXEC_RESULT_TEXT_BUDGET + 600);
}
// small stderr is never cut just because stdout is big
{
  const r = fitExecOutput('y'.repeat(200_000), 'one line of stderr\n');
  assert.equal(r.stderr, 'one line of stderr\n');
}
// text that escapes 6x in JSON must still fit the registry cap
{
  const nasty = String.fromCharCode(1).repeat(80_000);
  const r = fitExecOutput(nasty, '');
  const envelope = JSON.stringify({ stdout: r.stdout, stderr: r.stderr });
  assert.ok(envelope.length < 100_000, `json ${envelope.length}`);
  assert.equal(r.shortened, true);
}
// 55k newlines: under the char budget, but 110k in JSON
{
  const r = fitExecOutput('\n'.repeat(55_000), '');
  assert.ok(JSON.stringify(r.stdout).length < 95_000, `${JSON.stringify(r.stdout).length}`);
  assert.equal(r.shortened, true, 'flag is true whenever anything was dropped');
}
console.log('fit-output: all passed');
