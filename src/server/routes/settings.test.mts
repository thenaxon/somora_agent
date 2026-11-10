// The settings window's routes (routes/settings.ts): what the window
// reads, how a change reaches config.yaml, conflicts, refusals,
// secrets, backups and restore.
//
// Run: npm test src/server/routes/settings.test.mts
import { OWN_HOME as ISOLATED_HOME } from '../../testing/own-home.mts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

const { registerSettingsRoutes, KEEP_BACKUPS } = await import('./settings.ts');

const FILE = join(ISOLATED_HOME, 'config.yaml');
const START = `  # my settings
  providers:
    local:
      engine: openai-compatible
      baseUrl: http://127.0.0.1:9/v1
      apiKey: "sk-secret-123"   # do not share
      models:
        - id: m
          alias: m
          contextWindow: 8000
  memory:
    autoInject:
      maxResults: 5   # tuned
`;

let reloads = 0;
const app = new Hono();
registerSettingsRoutes(app, { reload: async () => { reloads++; return { ok: true, changed: ['memory'], restartRequired: ['memory'] }; }, currentConfig: () => { throw new Error('not used'); } });
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const backups = () => readdirSync(join(ISOLATED_HOME, 'config-backups')).filter((f) => f.startsWith('config.yaml.'));

test('GET /settings: fields with their texts, values without the key, what the file sets', async () => {
  writeFileSync(FILE, START);
  const { status, body } = await call('GET', '/settings');
  assert.equal(status, 200);
  assert.equal(body.valid, true);
  const f = body.fields.find((x: { path: string }) => x.path === 'memory.autoInject.maxResults');
  assert.equal(f.kind, 'integer');
  assert.equal(f.default, 5);
  assert.equal(f.info.label, 'Results per message');
  assert.deepEqual(body.values.providers.local.apiKey, { secret: true, set: true });
  assert.doesNotMatch(JSON.stringify(body), /sk-secret-123/);
  assert.ok(body.inFile.includes('memory.autoInject.maxResults'));
  assert.ok(!body.inFile.includes('memory.autoInject.minScore'));
  assert.ok(body.restartSections.includes('memory'));
});

test('GET /settings/yaml: the file as it is, the key blanked, comments kept', async () => {
  writeFileSync(FILE, START);
  const { body } = await call('GET', '/settings/yaml');
  assert.doesNotMatch(body.text, /sk-secret-123/);
  assert.match(body.text, /apiKey: •••• \(set\)\s+# do not share/);
  assert.match(body.text, /# my settings/);
});

test('apply: only the changed lines, a backup, a reload', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  const before = reloads;
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.autoInject.maxResults', value: 8 }, { path: 'memory.autoInject.minScore', value: 0.4 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(readFileSync(FILE, 'utf8'), START.replace('maxResults: 5   # tuned', 'maxResults: 8   # tuned\n      minScore: 0.4'));
  assert.equal(reloads, before + 1);
  assert.deepEqual(r.body.reload.restartRequired, ['memory']);
  assert.equal(readFileSync(join(ISOLATED_HOME, 'config-backups', r.body.backup), 'utf8'), START);
});

test('back to the default removes the line', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.autoInject.maxResults', reset: true }] });
  assert.equal(r.status, 200);
  assert.doesNotMatch(readFileSync(FILE, 'utf8'), /maxResults|autoInject/);
});

test('a file changed since the window read it is not overwritten (409)', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  writeFileSync(FILE, `${START}  # edited by hand\n`);
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.autoInject.maxResults', value: 9 }] });
  assert.equal(r.status, 409);
  assert.match(readFileSync(FILE, 'utf8'), /edited by hand/);
  assert.match(readFileSync(FILE, 'utf8'), /maxResults: 5/);
});

test('an invalid value is refused and nothing is written', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.autoInject.minScore', value: 7 }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.issues[0].path, 'memory.autoInject.minScore');
  assert.equal(readFileSync(FILE, 'utf8'), START);
});

test('an unknown path is refused', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.nope', value: 1 }] });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.issues.map((i: { message: string }) => i.message), ['no such setting']);
  assert.equal(readFileSync(FILE, 'utf8'), START);
});

test('a locked setting is refused; a retired one can only be removed', async () => {
  const withVoice = `${START}  realtimeVoice:
    model: rt
    transport: websocket
`;
  writeFileSync(FILE, withVoice);
  const { body: view } = await call('GET', '/settings');
  const r = await call('POST', '/settings/apply', {
    hash: view.hash,
    changes: [
      { path: 'memory.embedding.model', value: 'other-model' },
      { path: 'realtimeVoice.transport', value: 'webrtc' },
    ],
  });
  assert.equal(r.status, 400);
  assert.match(r.body.issues[0].message, /index anew/);
  assert.match(r.body.issues[1].message, /can only be removed/);
  assert.equal(readFileSync(FILE, 'utf8'), withVoice);
  // Not around the lock by sending its block whole.
  const whole = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.embedding', value: { provider: 'local', model: 'other-model' } }] });
  assert.equal(whole.status, 400, JSON.stringify(whole.body));
  assert.match(whole.body.issues[0].message, /index anew/);
  assert.equal(readFileSync(FILE, 'utf8'), withVoice);
  const removed = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'realtimeVoice.transport', reset: true }] });
  assert.equal(removed.status, 200);
  assert.equal(readFileSync(FILE, 'utf8'), `${START}  realtimeVoice:\n    model: rt\n`);
});

test('entries: one field, a header key, a new entry and a removed one — each its own path', async () => {
  const withMcp = `${START}  mcp:
    servers:
      # the docs search
      docs:
        url: https://docs.example/mcp
        headers:
          X-Api-Key: "hdr-secret-1"   # rotated monthly
      old:
        url: https://old.example/mcp
`;
  writeFileSync(FILE, withMcp);
  const { body: view } = await call('GET', '/settings');
  assert.deepEqual(view.values.mcp.servers.docs.headers['X-Api-Key'], { secret: true, set: true });
  const yaml = await call('GET', '/settings/yaml');
  assert.ok(!yaml.body.text.includes('hdr-secret-1'), 'a header value is blanked in the YAML view');
  const r = await call('POST', '/settings/apply', {
    hash: view.hash,
    changes: [
      { path: 'mcp.servers.docs.timeoutMs', value: 5000 },
      { path: 'mcp.servers.docs.headers.X-Api-Key', secret: 'hdr-secret-2' },
      { path: 'mcp.servers.fresh', value: { url: 'https://fresh.example/mcp' } },
      { path: 'mcp.servers.old', reset: true },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(readFileSync(FILE, 'utf8'), `${START}  mcp:
    servers:
      # the docs search
      docs:
        url: https://docs.example/mcp
        headers:
          X-Api-Key: "hdr-secret-2"   # rotated monthly
        timeoutMs: 5000
      fresh:
        url: https://fresh.example/mcp
`);
});

test('a new entry arrives whole: its key and a required list inside it', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  const r = await call('POST', '/settings/apply', {
    hash: view.hash,
    changes: [
      { path: 'a2a.peers.partner', value: { token: 'peer-token-0123456789abcdef', agents: ['helper'] } },
      { path: 'projects.entities.0', value: { slug: 'site', label: 'Site' } },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = readFileSync(FILE, 'utf8');
  assert.ok(after.startsWith(START));
  assert.match(after, /partner:\n {8}token: peer-token-0123456789abcdef\n {8}agents:\n {10}- helper/);
  assert.match(after, /entities:\n {6}- slug: site\n {8}label: Site/);
});

test('an entry whose name has a dot is reached with %2E', async () => {
  const dotted = `${START}  toolCatalog:
    models:
      gpt-5.5:
        mode: catalog
`;
  writeFileSync(FILE, dotted);
  const { body: view } = await call('GET', '/settings');
  assert.equal(view.valid, true, JSON.stringify(view.issues));
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'toolCatalog.models.gpt-5%2E5.add', value: ['exec'] }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(readFileSync(FILE, 'utf8'), dotted + '        add:\n          - exec\n');
});

test('a map entry named with digits is a name, not a list position', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'lsp.servers.123', value: { command: 'ls-123' } }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(readFileSync(FILE, 'utf8'), /lsp:\n {4}servers:\n {6}"?123"?:\n {8}command: ls-123\n$/);
});

test('a model still in use by an agent or a setting is not removed', async () => {
  const two = START.replace('          contextWindow: 8000\n', '          contextWindow: 8000\n        - id: nid\n          alias: n\n          contextWindow: 8000\n');
  writeFileSync(FILE, `${two}  rem:\n    model: n\n`);
  const agentDir = join(ISOLATED_HOME, 'agents', 'ada');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'AGENTS.md'), '---\ndescription: test\n---\nhi\n');
  writeFileSync(join(agentDir, 'agent.yaml'), 'model: m\n');
  const boDir = join(ISOLATED_HOME, 'agents', 'bo');
  mkdirSync(boDir, { recursive: true });
  writeFileSync(join(boDir, 'AGENTS.md'), '---\ndescription: test\n---\nhi\n');
  writeFileSync(join(boDir, 'agent.yaml'), 'model: local/m\nrem:\n  model: n\n');
  try {
    const { body: view } = await call('GET', '/settings');
    assert.ok(view.refOptions.model.includes('m') && view.refOptions.model.includes('local/nid'));
    const before = readFileSync(FILE, 'utf8');
    const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'providers.local.models.0', reset: true }, { path: 'providers.local.models.1.alias', value: 'n2' }] });
    assert.equal(r.status, 400);
    const messages = r.body.issues.map((i: { message: string }) => i.message).join('\n');
    assert.match(messages, /rem\.model still names 'n'/);
    assert.match(messages, /agent ada uses model 'm'/);
    assert.match(messages, /agent bo uses model 'n'/);
    assert.equal(readFileSync(FILE, 'utf8'), before);
  } finally {
    rmSync(join(ISOLATED_HOME, 'agents'), { recursive: true, force: true });
  }
});

test('a blanked key sent back inside an entry is refused', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'mcp.servers.x', value: { url: 'https://x.example/mcp', headers: { Authorization: { secret: true, set: true } } } }] });
  assert.equal(r.status, 400);
  assert.match(r.body.issues[0].message, /blanked/);
  assert.equal(readFileSync(FILE, 'utf8'), START);
});

test('a secret is replaced without ever being read back', async () => {
  writeFileSync(FILE, `${START}  web:\n    brave:\n      apiKey: "old"\n`);
  const { body: view } = await call('GET', '/settings');
  assert.deepEqual(view.values.web.brave.apiKey, { secret: true, set: true });
  const r = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'web.brave.apiKey', secret: 'new-key' }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(readFileSync(FILE, 'utf8'), /apiKey: "new-key"/);
  assert.doesNotMatch(JSON.stringify(r.body), /new-key/);
});

test('restore: an earlier version comes back, the current one is kept too; only the last few stay', async () => {
  writeFileSync(FILE, START);
  let { body: view } = await call('GET', '/settings');
  const first = await call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.autoInject.maxResults', value: 11 }] });
  const restored = await call('POST', '/settings/restore', { name: first.body.backup, hash: first.body.hash });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(readFileSync(FILE, 'utf8'), START);
  ({ body: view } = await call('GET', '/settings'));
  let hash = view.hash as string;
  for (let i = 0; i < KEEP_BACKUPS + 3; i++) {
    const r = await call('POST', '/settings/apply', { hash, changes: [{ path: 'memory.autoInject.maxResults', value: 20 + i }] });
    hash = r.body.hash;
  }
  assert.equal(backups().length, KEEP_BACKUPS);
  const list = await call('GET', '/settings/backups');
  assert.equal(list.body.backups.length, KEEP_BACKUPS);
  assert.equal((await call('POST', '/settings/restore', { name: '../config.yaml', hash })).status, 400, 'a path outside the backups is refused');
  assert.equal((await call('POST', '/settings/restore', { name: 'config.yaml.nope', hash })).status, 404);
  // hash is required, as for apply (Fable review 2026-11-10 Nr. 19)
  assert.equal((await call('POST', '/settings/restore', { name: list.body.backups[0].name })).status, 400, 'no hash, no restore');
});

test('redaction: a secret under a key with no value of its own, and one written in a comment', async () => {
  const { redactYamlText } = await import('./settings.ts');
  const text = '  mcp:\n    peers:\n      first:\n        token: aaaaaaaaaaaaaaaa\n      second:\n        token: bbbbbbbbbbbbbbbb\n  # set up today. Token: cccccccccccc\n';
  const out = redactYamlText(text);
  assert.doesNotMatch(out, /aaaa|bbbb|cccc/);
  assert.match(out, /second:\n {8}token: •••• \(set\)/);
  assert.match(out, /# set up today\. Token: ••••/);
});

test('redaction covers a key over several lines and one inside a flow map', async () => {
  const { redactYamlText } = await import('./settings.ts');
  const text = '  web:\n    brave: {apiKey: flow-secret-value, x: 1}\n  other:\n    apiKey: |\n      line-one-secret\n      line-two-secret\n    after: 2\n';
  const out = redactYamlText(text);
  assert.doesNotMatch(out, /flow-secret|line-one|line-two/);
  assert.match(out, /after: 2/);
  assert.match(out, /x: 1/);
});

test('two applies at the same moment: one wins, the other is told the file changed', async () => {
  writeFileSync(FILE, START);
  const { body: view } = await call('GET', '/settings');
  const [a, b] = await Promise.all([
    call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.autoInject.maxResults', value: 6 }] }),
    call('POST', '/settings/apply', { hash: view.hash, changes: [{ path: 'memory.autoInject.minScore', value: 0.5 }] }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});
