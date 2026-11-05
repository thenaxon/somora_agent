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
    allowedHosts: [box.local, 10.0.0.5]

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
  const out = applyYamlEdits(FILE, [{ path: ['server', 'allowedHosts'], value: ['box.local'] }]);
  assert.equal(out, FILE.replace('[box.local, 10.0.0.5]', '[box.local]'));
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

// Lists of entries (imageGen.models): one field of one entry, an entry
// added at the end, entries removed — the rest of the list as it was.
const LIST = `  imageGen:
    enabled: true
    models:
      # the fast one
      - name: quick   # default
        provider: local
        model: q1
      - name: fine
        provider: local
        model: f1
        label: Fine
      # kept for comparison
      - name: old
        provider: local
        model: o1
`;

test('a field of one list entry changes in place', () => {
  const out = applyYamlEdits(LIST, [{ path: ['imageGen', 'models', '1', 'model'], value: 'f2' }]);
  assert.equal(out, LIST.replace('model: f1', 'model: f2'));
  const added = applyYamlEdits(LIST, [{ path: ['imageGen', 'models', '0', 'label'], value: 'Quick' }]);
  assert.equal(added, LIST.replace('        model: q1\n', '        model: q1\n        label: Quick\n'));
  const gone = applyYamlEdits(LIST, [{ path: ['imageGen', 'models', '1', 'label'], remove: true }]);
  assert.equal(gone, LIST.replace('        label: Fine\n', ''));
});

test('an entry is added at the end of its list, with the list\'s indentation', () => {
  const out = applyYamlEdits(LIST, [{ path: ['imageGen', 'models', '3'], value: { name: 'new', provider: 'local', model: 'n1' } }]);
  assert.equal(out, `${LIST}      - name: new\n        provider: local\n        model: n1\n`);
});

test('entries are removed with their own comment; edits in the same apply mean the file as it was', () => {
  const out = applyYamlEdits(LIST, [
    { path: ['imageGen', 'models', '0'], remove: true },
    { path: ['imageGen', 'models', '2', 'model'], value: 'o2' },
    { path: ['imageGen', 'models', '2'], remove: true },
    { path: ['imageGen', 'models', '1', 'label'], value: 'Fine 2' },
  ]);
  assert.equal(out, `  imageGen:
    enabled: true
    models:
      - name: fine
        provider: local
        model: f1
        label: Fine 2
`);
});

test('an index past the end, or into a missing list, is refused', () => {
  assert.throws(() => applyYamlEdits(LIST, [{ path: ['imageGen', 'models', '7', 'model'], value: 'x' }]), YamlEditError);
  assert.throws(() => applyYamlEdits(LIST, [{ path: ['videoGen', 'models', '0', 'model'], value: 'x' }]), YamlEditError);
});

test('the first entry of a list that is empty or not there, and the last one removed', () => {
  const empty = `  projects:\n    entities: []   # none yet\n  sentinel:\n    completedRetentionDays: 7\n`;
  const first = applyYamlEdits(empty, [{ path: ['projects', 'entities', '0'], value: { slug: 'a', label: 'A' } }]);
  assert.deepEqual((parse(first) as { projects: { entities: unknown } }).projects.entities, [{ slug: 'a', label: 'A' }]);
  assert.ok(first.endsWith('  sentinel:\n    completedRetentionDays: 7\n'));
  const missing = applyYamlEdits(FILE, [{ path: ['projects', 'entities', '0'], value: { slug: 'a', label: 'A' } }]);
  assert.deepEqual((parse(missing) as { projects: { entities: unknown } }).projects.entities, [{ slug: 'a', label: 'A' }]);
  const gone = applyYamlEdits(first, [{ path: ['projects', 'entities', '0'], remove: true }]);
  assert.deepEqual((parse(gone) as { projects: { entities: unknown } }).projects.entities, []);
  const both = applyYamlEdits(LIST, [0, 1, 2].map((i) => ({ path: ['imageGen', 'models', String(i)], remove: true as const })));
  assert.deepEqual((parse(both) as { imageGen: { models: unknown } }).imageGen.models, []);
});

test('removing the first setting of a list entry keeps its dash', () => {
  const out = applyYamlEdits(LIST, [{ path: ['imageGen', 'models', '1', 'name'], remove: true }]);
  assert.equal(out, LIST.replace('      - name: fine\n        provider: local\n', '      - provider: local\n'));
  const one = `  projects:\n    entities:\n      - slug: a\n      - slug: b\n        label: B\n`;
  assert.deepEqual((parse(applyYamlEdits(one, [{ path: ['projects', 'entities', '0', 'slug'], remove: true }])) as { projects: { entities: unknown } }).projects.entities, [{}, { slug: 'b', label: 'B' }]);
});

test('a change that damages anything else is refused', () => {
  // Removing a server and editing it in the same apply: the result is
  // the removal, which reads back as expected.
  const out = applyYamlEdits(LIST, [{ path: ['imageGen', 'models', '0', 'model'], value: 'q2' }, { path: ['imageGen', 'enabled'], remove: true }]);
  assert.deepEqual(Object.keys((parse(out) as { imageGen: object }).imageGen), ['models']);
});

test('a one-line list of entries is changed on its line, the other entries kept', () => {
  const flow = `  imageGen:\n    models: [{name: quick, provider: local, model: q1}, {name: fine, provider: local, model: f1}]   # two\n`;
  const out = applyYamlEdits(flow, [{ path: ['imageGen', 'models', '0', 'model'], value: 'q2' }]);
  assert.equal(out, `  imageGen:\n    models: [ { name: quick, provider: local, model: q2 }, { name: fine, provider: local, model: f1 } ]   # two\n`);
  const gone = applyYamlEdits(flow, [{ path: ['imageGen', 'models', '0'], remove: true }]);
  assert.deepEqual((parse(gone) as { imageGen: { models: unknown } }).imageGen.models, [{ name: 'fine', provider: 'local', model: 'f1' }]);
});

test('a path through __proto__ is refused and changes nothing', () => {
  assert.throws(() => applyYamlEdits(LIST, [{ path: ['imageGen', '__proto__', 'polluted'], value: 'x' }]), YamlEditError);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('replacing the first setting of a list entry as a block keeps its dash', () => {
  const lit = `  projects:\n    entities:\n      - label: |\n          Site\n        slug: site\n`;
  const out = applyYamlEdits(lit, [{ path: ['projects', 'entities', '0', 'label'], value: 'Site\nand more\n' }]);
  assert.deepEqual((parse(out) as { projects: { entities: unknown } }).projects.entities, [{ label: 'Site\nand more\n', slug: 'site' }]);
  const block = applyYamlEdits(LIST.replace('      - name: quick   # default\n', '      - name: [a, b]\n'), [{ path: ['imageGen', 'models', '0', 'name'], value: { first: 'x' } }]);
  assert.match(block, / {6}- name:\n {10}first: x\n/);
});
