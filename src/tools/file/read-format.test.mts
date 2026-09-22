// file_read presentation: numbered lines, paging, end marker.
// Run: npx tsx src/tools/file/read-format.test.mts
import assert from 'node:assert/strict';
import { DEFAULT_READ_LINES, MAX_LINE_CHARS, formatRead, nearestNames, READ_HARD_CAP } from './read-format.ts';

// small file, trailing newline: numbered, ends with End of file
{
  const r = formatRead('foo\nbar\n');
  assert.equal(r.content, '1: foo\n2: bar');
  assert.equal(r.lines, 2);
  assert.deepEqual(r.range, { from: 1, to: 2 });
  assert.equal(r.truncated, false);
  assert.equal(r.summary, 'End of file (2 lines).');
  assert.equal(r.next_offset, undefined);
}
// no trailing newline counts the same
assert.equal(formatRead('foo\nbar').lines, 2);
// empty file
{
  const r = formatRead('');
  assert.equal(r.content, '');
  assert.equal(r.lines, 0);
  assert.equal(r.summary, 'Empty file (0 lines).');
}
// default limit pages at 2000 with next_offset; offset numbers absolute
{
  const all = Array.from({ length: 5000 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
  const r = formatRead(all);
  assert.equal(r.range.from, 1);
  assert.equal(r.range.to, DEFAULT_READ_LINES);
  assert.equal(r.truncated, true);
  assert.equal(r.next_offset, 2000);
  assert.equal(r.summary, 'Showing lines 1-2000 of 5000. Continue with offset=2000.');
  assert.ok(r.content.endsWith('2000: L2000'));
  const r2 = formatRead(all, 2000, 10);
  assert.equal(r2.content.split('\n')[0], '2001: L2001');
  assert.equal(r2.summary, 'Showing lines 2001-2010 of 5000. Continue with offset=2010.');
  const last = formatRead(all, 4990);
  assert.equal(last.summary, 'End of file (5000 lines).');
  assert.deepEqual(last.range, { from: 4991, to: 5000 });
}
// offset past the end
{
  const r = formatRead('a\nb\n', 10);
  assert.equal(r.content, '');
  assert.match(r.summary, /past the end/);
}
// long line cut with marker
{
  const r = formatRead('x'.repeat(5000) + '\nshort\n');
  const first = r.content.split('\n')[0]!;
  assert.ok(first.length < MAX_LINE_CHARS + 60, `${first.length}`);
  assert.match(first, /\[line cut at 2000 chars\]$/);
  assert.equal(r.content.split('\n')[1], '2: short');
}
// result cap: many long lines → stops with a cap summary and a next_offset
{
  const all = Array.from({ length: 500 }, () => 'y'.repeat(1500)).join('\n') + '\n';
  const r = formatRead(all);
  assert.ok(r.content.length <= READ_HARD_CAP);
  assert.equal(r.truncated, true);
  assert.match(r.summary, /result cap reached/);
  assert.ok((r.next_offset ?? 0) > 0 && (r.next_offset ?? 0) < 500);
}
// nearest names
{
  const names = ['tools.ts', 'local.ts', 'remote.ts', 'policy.ts', 'README.md'];
  assert.deepEqual(nearestNames('tool.ts', names), ['tools.ts']);
  assert.deepEqual(nearestNames('locl.ts', names).slice(0, 1), ['local.ts']);
  assert.deepEqual(nearestNames('zzzzzzzz', names), []);
}
console.log('read-format.test: ok');
