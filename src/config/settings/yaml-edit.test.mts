// Changing single settings in config.yaml without rewriting the file
// (yaml-edit.ts): comments, order, quoting and the operator's own
// indentation stay; only the changed text moves.
//
// Run: npm test src/config/settings/yaml-edit.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { YamlEditError, applyYamlEdits } from './yaml-edit.ts';

// Shaped like a real file: root keys indented by two spaces, comments
// above and beside values, a flow list, a block list, blank lines.
const FILE = `  # somora server config
                                                                                       
  server:
    port: 18737   # keep in sync with the firewall
    # where the web UI is reachable
    allowedHosts: [naxon.local, 10.0.0.5]

  memory:
    autoInject:
      maxResults: 5
      # raised after noisy recalls
      minScore: 0.4
    rescanMinutes: 10

  sentinel:
    completedRetentionDays: 7
    checks:
      - a
      - b
`;

/** Lines that differ between two texts, as [before, after] pairs. */
function changedLines(a: string, b: string): string[] {
  const A = a.split('\n');
  const B = b.split('\n');
  return B.filter((l) => !A.includes(l)).concat(A.filter((l) => !B.includes(l)).map((l) => `- ${l}`));
}

test('a scalar is replaced in place: the comment beside it and every other byte stay', () => {
  const out = applyYamlEdits(FILE, [{ path: ['server', 'port'], value: 18800 }]);
  assert.equal(out, FILE.replace('port: 18737', 'port: 18800'));
});

test('a number, a string that needs quotes, and false', () => {
  const out = applyYamlEdits(FILE, [
    { path: ['memory', 'autoInject', 'minScore'], value: 0.35 },
    { path: ['memory', 'autoInject', 'maxResults'], value: 8 },
  ]);
  assert.deepEqual(changedLines(FILE, out).sort(), ['      maxResults: 8', '      minScore: 0.35', '-       maxResults: 5', '-       minScore: 0.4'].sort());
  const quoted = applyYamlEdits(FILE, [{ path: ['server', 'port'], value: 'yes: no' }]);
  assert.equal((parse(quoted) as { server: { port: unknown } }).server.port, 'yes: no');
});

test('a flow list stays a flow list', () => {
  const out = applyYamlEdits(FILE, [{ path: ['server', 'allowedHosts'], value: ['naxon.local'] }]);
  assert.equal(out, FILE.replace('[naxon.local, 10.0.0.5]', '[naxon.local]'));
});

test('a block list is rewritten as its entry, at its indentation', () => {
  const out = applyYamlEdits(FILE, [{ path: ['sentinel', 'checks'], value: ['a', 'c', 'd'] }]);
  assert.match(out, /\n {4}checks:\n {6}- a\n {6}- c\n {6}- d\n/);
  assert.equal((parse(out) as { sentinel: { completedRetentionDays: number } }).sentinel.completedRetentionDays, 7);
});

test('a setting that is not there is added under its parent with its indentation', () => {
  const out = applyYamlEdits(FILE, [{ path: ['memory', 'autoInject', 'skipRepeats'], value: false }]);
  assert.match(out, /\n {6}minScore: 0\.4\n {6}skipRepeats: false\n {4}rescanMinutes: 10\n/);
  assert.deepEqual(changedLines(FILE, out), ['      skipRepeats: false']);
});

test('missing parent blocks are created, at the root indentation of the file', () => {
  const out = applyYamlEdits(FILE, [{ path: ['wiki', 'language'], value: 'en' }]);
  assert.match(out, /\n {2}wiki:\n {4}language: en\n$/);
  const nested = applyYamlEdits(FILE, [{ path: ['memory', 'hybrid', 'bm25Weight'], value: 0.4 }]);
  assert.match(nested, /\n {4}hybrid:\n {6}bm25Weight: 0\.4\n/);
});

test('back to the default removes the entry with its own comment above, nothing else', () => {
  const out = applyYamlEdits(FILE, [{ path: ['memory', 'autoInject', 'minScore'], remove: true }]);
  assert.equal(out, FILE.replace('      # raised after noisy recalls\n      minScore: 0.4\n', ''));
});

test('a block left empty goes too', () => {
  let out = applyYamlEdits(FILE, [{ path: ['memory', 'autoInject', 'minScore'], remove: true }]);
  out = applyYamlEdits(out, [{ path: ['memory', 'autoInject', 'maxResults'], remove: true }]);
  assert.doesNotMatch(out, /autoInject/);
  assert.match(out, /\n {2}memory:\n {4}rescanMinutes: 10\n/);
});

test('removing what is not there changes nothing', () => {
  assert.equal(applyYamlEdits(FILE, [{ path: ['memory', 'chunking', 'targetTokens'], remove: true }]), FILE);
});

test('a key with nothing under it gets its block', () => {
  const f = '  memory:\n  server:\n    port: 1\n';
  const out = applyYamlEdits(f, [{ path: ['memory', 'rescanMinutes'], value: 5 }]);
  assert.deepEqual(parse(out), { memory: { rescanMinutes: 5 }, server: { port: 1 } });
});

test('broken YAML is refused', () => {
  assert.throws(() => applyYamlEdits('a: [1, 2\n', [{ path: ['a'], value: 1 }]), YamlEditError);
});

test('a real-looking file of the operator: several edits, every other line byte for byte', () => {
  const edits = [
    { path: ['server', 'port'], value: 18737 },
    { path: ['memory', 'autoInject', 'maxResults'], value: 6 },
    { path: ['sentinel', 'completedRetentionDays'], value: 3 },
    { path: ['memory', 'chunking', 'targetTokens'], value: 500 },
  ];
  const out = applyYamlEdits(FILE, edits);
  assert.deepEqual(changedLines(FILE, out).sort(), [
    '    chunking:', '      targetTokens: 500', '      maxResults: 6', '    completedRetentionDays: 3', '-       maxResults: 5', '-     completedRetentionDays: 7',
  ].sort());
});

test('a flow map: removing or adding one setting keeps its neighbours', () => {
  const f = '  server: {port: 18737, allowedHosts: [private.local]}\n  memory:\n    rescanMinutes: 10\n';
  const removed = applyYamlEdits(f, [{ path: ['server', 'port'], remove: true }]);
  assert.deepEqual(parse(removed), { server: { allowedHosts: ['private.local'] }, memory: { rescanMinutes: 10 } });
  const added = applyYamlEdits(f, [{ path: ['server', 'auth'], value: 'off' }]);
  assert.deepEqual(parse(added), { server: { port: 18737, allowedHosts: ['private.local'], auth: 'off' }, memory: { rescanMinutes: 10 } });
  const inPlace = applyYamlEdits(f, [{ path: ['server', 'port'], value: 18800 }]);
  assert.equal(inPlace, f.replace('18737', '18800'), 'a plain value is still replaced in place');
});
