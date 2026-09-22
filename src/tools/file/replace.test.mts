// file_patch tolerance chain — every strategy, the brakes, and the
// error texts a model gets.
// Run: npx tsx src/tools/file/replace.test.mts
import assert from 'node:assert/strict';
import {
  diffSnippet,
  hasLineNumberPrefixes,
  replaceInContent,
  ReplaceError,
  stripLineNumberPrefixes,
} from './replace.ts';

const src = [
  'function greet(name) {',
  '    if (!name) {',
  '        return "hello";',
  '    }',
  '    return `hello ${name}`;',
  '}',
  '',
  'module.exports = { greet };',
  '',
].join('\n');

// exact wins
{
  const r = replaceInContent(src, '        return "hello";', '        return "hi";');
  assert.equal(r.strategy, 'exact');
  assert.equal(r.count, 1);
  assert.match(r.updated, /return "hi";/);
  assert.deepEqual(r.firstSpanLines, { from: 3, to: 3 });
}
// identical old/new → error
assert.throws(() => replaceInContent(src, 'x', 'x'), (e: unknown) => e instanceof ReplaceError && e.kind === 'no_change');
// empty old → error
assert.throws(() => replaceInContent(src, '', 'x'), (e: unknown) => e instanceof ReplaceError && e.kind === 'empty');

// line_trimmed: model dropped the indentation entirely
{
  const r = replaceInContent(src, 'if (!name) {\nreturn "hello";\n}', 'if (!name) return "hello";');
  assert.equal(r.strategy, 'line_trimmed');
  assert.match(r.updated, /if \(!name\) return "hello";/);
  assert.ok(!r.updated.includes('        return "hello"'));
}
// indentation_flexible: model used 2-space indent instead of 4
{
  const r = replaceInContent(src, '  if (!name) {\n      return "hello";\n  }', '  // gone');
  assert.ok(['line_trimmed', 'indentation_flexible'].includes(r.strategy), r.strategy);
  assert.match(r.updated, /\/\/ gone/);
}
// whitespace_normalized single line substring: tabs vs spaces inside the line
{
  const r = replaceInContent(src, 'module.exports   =  { greet };', 'export { greet };');
  assert.equal(r.strategy, 'whitespace_normalized');
  assert.match(r.updated, /export \{ greet \};/);
}
// escape_normalized: model sent \n as two characters
{
  const r = replaceInContent(src, 'function greet(name) {\\n    if (!name) {', 'function greet(name = "x") {\n    if (!name) {');
  assert.equal(r.strategy, 'escape_normalized');
  assert.match(r.updated, /greet\(name = "x"\)/);
}
// trimmed_boundary: stray leading/trailing whitespace around the block
{
  const r = replaceInContent(src, '\n  module.exports = { greet };  \n', 'export default greet;');
  // line_trimmed sees the same block (blank line, the export, blank line)
  // and runs earlier in the chain; trimmed_boundary is the fallback.
  assert.ok(['line_trimmed', 'trimmed_boundary'].includes(r.strategy), r.strategy);
  assert.match(r.updated, /export default greet;/);
}
// block_anchor: middle line slightly wrong, anchors right
{
  const r = replaceInContent(
    src,
    'function greet(name) {\n    if (!name) {\n        return "helo";\n    }\n    return `hello ${name}`;\n}',
    'function greet(name) { return name ? `hello ${name}` : "hello"; }',
  );
  assert.equal(r.strategy, 'block_anchor');
  assert.match(r.updated, /return name \? `hello/);
  assert.ok(!r.updated.includes('if (!name)'));
}
// multiple exact matches without replace_all → error naming it; with replace_all → all
{
  const text = 'a = 1;\nb = 1;\nc = 1;\n';
  assert.throws(
    () => replaceInContent(text, '= 1;', '= 2;'),
    (e: unknown) => e instanceof ReplaceError && e.kind === 'multiple' && /replace_all/.test(e.message),
  );
  const all = replaceInContent(text, '= 1;', '= 2;', { replaceAll: true });
  assert.equal(all.count, 3);
  assert.equal(all.updated, 'a = 2;\nb = 2;\nc = 2;\n');
}
// not found → clear error
assert.throws(
  () => replaceInContent(src, 'nothing like this', 'x'),
  (e: unknown) => e instanceof ReplaceError && e.kind === 'not_found' && /Read the file again/.test(e.message),
);
// line-number prefixes from a numbered read are stripped
{
  assert.equal(hasLineNumberPrefixes('2:     if (!name) {\n3:         return "hello";'), true);
  assert.equal(hasLineNumberPrefixes('if (!name) {'), false);
  assert.equal(stripLineNumberPrefixes('12: foo\n13: bar'), 'foo\nbar');
  const r = replaceInContent(src, '2:     if (!name) {\n3:         return "hello";\n4:     }', '    if (!name) return "";');
  assert.equal(r.lineNumbersStripped, true);
  assert.equal(r.strategy, 'exact');
  assert.match(r.updated, /if \(!name\) return "";/);
  // and a not-found with prefixes says so
  assert.throws(
    () => replaceInContent(src, '9: no such line', 'x'),
    (e: unknown) => e instanceof ReplaceError && /without the line-number prefix/.test(e.message),
  );
}
// disproportion brake: a one-line find must not swallow 30 lines just
// because whitespace normalization lets `\s+` run across newlines
{
  const big = 'a' + '\n'.repeat(30) + 'b';
  assert.throws(
    () => replaceInContent(big, 'a b', 'x'),
    (e: unknown) => e instanceof ReplaceError && e.kind === 'disproportionate',
  );
}
// block anchors with a wrong middle and a far-away closing line: the
// length tolerance already refuses it (not found, not a bad edit)
{
  const big = ['start {', ...Array.from({ length: 18 }, (_, i) => `  line ${i}`), '}'].join('\n');
  assert.throws(
    () => replaceInContent(big, 'start {\n  totally different\n}', 'x'),
    (e: unknown) => e instanceof ReplaceError && e.kind === 'not_found',
  );
}
// allowFuzzy:false → exact only
assert.throws(
  () => replaceInContent(src, 'if (!name) {\nreturn "hello";\n}', 'x', { allowFuzzy: false }),
  (e: unknown) => e instanceof ReplaceError && e.kind === 'not_found',
);
// CRLF preserved
{
  const crlf = 'a\r\nb\r\nc\r\n';
  const r = replaceInContent(crlf, 'b\n', 'B\n');
  assert.equal(r.updated, 'a\r\nB\r\nc\r\n');
  const r2 = replaceInContent(crlf, 'b\r\n', 'B\r\n');
  assert.equal(r2.updated, 'a\r\nB\r\nc\r\n');
}
// overlapping fuzzy candidates are not double-applied
{
  const text = 'x\nx\nx\n';
  const r = replaceInContent(text, ' x ', 'y', { replaceAll: true });
  assert.equal(r.updated, 'y\ny\ny\n');
}
// diff snippet shows the changed region with original line numbers
{
  const d = diffSnippet('a\nb\nc\nd\n', 'a\nB\nC2\nc\nd\n');
  assert.equal(d, '-2: b\n+2: B\n+3: C2');
  const big = diffSnippet('a\n'.repeat(100), 'z\n'.repeat(100), 3);
  assert.match(big, /-… \(97 more lines\)/);
}
console.log('replace.test: ok');
