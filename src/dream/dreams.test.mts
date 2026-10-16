// The dreams switch at run time: what REM runs with (the agent's model,
// else the central one), the REM worker following the switch, the tools
// that follow it whatever the rules say, the vault read-only for an agent
// that does not dream, and the routes: the switch itself, run-rem, the
// Abilities window and the tool route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { ConfigSchema } from '../config/types.ts';
import { loadPersona } from '../persona/loader.ts';
import { effectiveToolGating, isToolAllowed, setToolsetLookup } from '../tools/gating.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { ToolDefinition, Toolset } from '../tools/types.ts';
import { enforceVaultReadOnly } from '../tools/file/vault-lock.ts';
import { setConfig } from '../server/server-state.ts';
import { registerAbilitiesRoutes } from '../server/routes/abilities.ts';
import { registerAgentRoutes } from '../server/routes/agents.ts';
import { registerDreamRoutes } from '../server/routes/dream.ts';
import { registerModelRoutes } from '../server/routes/models.ts';
import { RemWorker } from './rem-worker.ts';
import { remSettingsFor, syncRemRegistration } from './dreams.ts';

const home = process.env.SOMORA_HOME!;
const vault = join(home, 'vault');
mkdirSync(join(vault, 'somora'), { recursive: true });
function agent(name: string, yaml: string) {
  mkdirSync(join(home, 'agents', name), { recursive: true });
  writeFileSync(join(home, 'agents', name, 'AGENTS.md'), `# ${name}\n`);
  writeFileSync(join(home, 'agents', name, 'agent.yaml'), yaml);
}
agent('dreamer', 'model: x\ndreams: true\ntools:\n  deny: ["toolset:dream"]\n');
agent('sleeper', 'model: x\ndreams: false\ntools:\n  deny: ["toolset:wiki"]\n  allow: [wiki_edit]\n');
agent('own-model', 'model: x\ndreams: true\nrem:\n  model: mine\n  fallback: mine2\n  idleMinutes: 7\n');

const config = ConfigSchema.parse({ providers: {}, obsidian: { vault }, rem: { model: 'central', fallback: ['c2'] } });
setConfig(config);

test('REM settings: the agent\'s own model with its own backup, else the central pair, never for a sleeper', async () => {
  const own = remSettingsFor((await loadPersona('own-model'))!, config);
  assert.ok(own.ok);
  assert.equal(own.rem.model, 'mine');
  assert.equal(own.rem.fallback, 'mine2');
  assert.equal(own.rem.idleMinutes, 7);
  assert.equal(own.modelFrom, 'agent');

  const central = remSettingsFor((await loadPersona('dreamer'))!, config);
  assert.ok(central.ok);
  assert.equal(central.rem.model, 'central');
  assert.deepEqual(central.rem.fallback, ['c2']);
  assert.equal(central.rem.idleMinutes, 30, 'defaults without a rem block');
  assert.equal(central.modelFrom, 'config');

  assert.deepEqual(remSettingsFor((await loadPersona('sleeper'))!, config), { ok: false, reason: 'does-not-dream' });
  const noCentral = ConfigSchema.parse({ providers: {} });
  assert.deepEqual(remSettingsFor((await loadPersona('dreamer'))!, noCentral), { ok: false, reason: 'no-model' });
});

test('the REM worker follows the switch: registered, settings refreshed, unregistered', async () => {
  const worker = new RemWorker({ config, getMemoryManager: (async () => ({})) as never });
  try {
    syncRemRegistration(worker, 'dreamer', (await loadPersona('dreamer'))!, config);
    assert.equal(worker.isRegistered('dreamer'), true);
    syncRemRegistration(worker, 'dreamer', { dreams: true, rem: { model: 'other', idleMinutes: 30, chunkTokens: 1, chunkTimeoutMs: 1 } }, config);
    assert.equal(worker.isRegistered('dreamer'), true);
    syncRemRegistration(worker, 'dreamer', { dreams: false, rem: undefined }, config);
    assert.equal(worker.isRegistered('dreamer'), false);
    syncRemRegistration(worker, 'sleeper', (await loadPersona('sleeper'))!, config);
    assert.equal(worker.isRegistered('sleeper'), false);
  } finally {
    await worker.shutdown();
  }
});

test('dream and wiki-writing tools follow the switch, before any deny or allow', async () => {
  // registerAllTools sets this in the server; an allow inside a family
  // that is off is an exception only when the family of the name is known.
  setToolsetLookup((n) => (n.startsWith('wiki_') ? 'wiki' : n.startsWith('dream_') ? 'dream' : undefined));
  const d = (await loadPersona('dreamer'))!.toolGating;
  const s = (await loadPersona('sleeper'))!.toolGating;
  assert.equal(isToolAllowed('dream_list', 'dream', d), true, 'on although toolset:dream is denied');
  assert.equal(isToolAllowed('wiki_edit', 'wiki', d), true);
  assert.equal(isToolAllowed('dream_list', 'dream', s), false, 'off although no rule names it');
  assert.equal(isToolAllowed('wiki_edit', 'wiki', s), false, 'off although allowed by name');
  assert.equal(isToolAllowed('memory_search', 'memory', s), true, 'reading stays');
  assert.equal(isToolAllowed('memory_write', 'memory', s), true, 'its own notes stay');
  // A sub-agent session's deny list still wins over the switch.
  assert.equal(isToolAllowed('dream_list', 'dream', { ...effectiveToolGating('chat', undefined, true), sessionDeny: ['dream_list'] }), false);
  // Without the switch on the gating (old callers), the rules decide as before.
  assert.equal(isToolAllowed('dream_list', 'dream', { deny: ['toolset:dream'], allow: [] }), false);
});

test('the vault and the wiki are read-only for an agent that does not dream', async () => {
  const inWiki = join(vault, 'somora', 'page.md');
  await assert.rejects(enforceVaultReadOnly({ paths: [inWiki], agent: 'sleeper', config }), /read-only for sleeper/);
  await assert.rejects(enforceVaultReadOnly({ paths: [join(vault, 'note.md')], agent: 'sleeper', config }), /read-only/);
  await enforceVaultReadOnly({ paths: [inWiki], agent: 'dreamer', config });
  await enforceVaultReadOnly({ paths: [join(home, 'work', 'x.md')], agent: 'sleeper', config });
  // A symlink elsewhere that points into the vault: the real path is checked too.
  mkdirSync(join(home, 'work'), { recursive: true });
  symlinkSync(vault, join(home, 'work', 'link'));
  await assert.rejects(enforceVaultReadOnly({ paths: [join(home, 'work', 'link', 'x.md'), join(vault, 'x.md')], agent: 'sleeper', config }), /read-only/);
  // No vault configured: nothing to protect.
  await enforceVaultReadOnly({ paths: [inWiki], agent: 'sleeper', config: ConfigSchema.parse({ providers: {} }) });
});

// ── routes ───────────────────────────────────────────────────────────

const fake = (name: string, toolset: Toolset): ToolDefinition => ({
  name, description: name, toolset,
  inputSchema: z.object({}).passthrough(), jsonSchema: { type: 'object' },
  handler: async () => ({ ran: name }),
});
const tools = new ToolRegistry();
tools.registerMany([fake('dream_list', 'dream'), fake('wiki_edit', 'wiki'), fake('time_now', 'time')]);
const worker = new RemWorker({ config, getMemoryManager: (async () => ({})) as never });
let synced = 0;
const app = new Hono();
registerAgentRoutes(app, { nextTurnPrompt: undefined as never, syncDreamers: async () => { synced++; } });
registerAbilitiesRoutes(app, { tools } as never);
registerDreamRoutes(app, { remWorker: worker, deepWorker: undefined as never, lucidWorker: undefined as never } as never);
registerModelRoutes(app, { tools } as never);
const req = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

test('PUT /agents/:agent/dreams flips the switch, says what REM runs on, resyncs', async () => {
  agent('flip', 'model: x\nrem:\n  enabled: false\n  model: w\n');
  const off = await req('GET', '/agents/flip/dreams');
  assert.equal(off.body.on, false);
  const on = await req('PUT', '/agents/flip/dreams', { on: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.on, true);
  assert.equal(on.body.remModel, 'w');
  assert.equal(on.body.remModelFrom, 'agent');
  assert.equal(synced, 1);
  assert.equal((await loadPersona('flip'))!.dreams, true);
  assert.equal((await req('PUT', '/agents/flip/dreams', { on: 'yes' })).status, 400);
  assert.equal((await req('PUT', '/agents/nobody/dreams', { on: true })).status, 404);
  const persona = await req('GET', '/agents/flip/persona');
  assert.equal((persona.body.dreams as { on: boolean }).on, true, 'the Agent window reads it with the persona');
});

test('run-rem: 409 for an agent that does not dream', async () => {
  const r = await req('POST', '/agents/sleeper/dream/run-rem');
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'does-not-dream');
});

test('Abilities: the following tools carry lockedBy, a click on them is refused', async () => {
  const list = await req('GET', '/agents/sleeper/tools');
  const byName = Object.fromEntries((list.body.tools as Array<{ name: string; visible: boolean; lockedBy?: string }>).map((t) => [t.name, t]));
  assert.equal(byName.dream_list!.lockedBy, 'dreams');
  assert.equal(byName.dream_list!.visible, false);
  assert.equal(byName.time_now!.lockedBy, undefined);
  assert.equal(list.body.dreams, false);
  const click = await req('POST', '/agents/sleeper/tools/toggle', { names: ['dream_list'], visible: true });
  assert.equal(click.status, 409);
  assert.equal(click.body.lockedBy, 'dreams');
});

test('the tool route refuses a dream tool for an agent that does not dream', async () => {
  assert.equal((await req('POST', '/agents/sleeper/tools/dream_list', {})).status, 403);
  assert.equal((await req('POST', '/agents/dreamer/tools/dream_list', {})).status, 200);
  await worker.shutdown();
});
