// A session started as a sub-agent never gets the tools in
// subagents.tools.deny (default: agent_ask, agent_ask_result) — in the
// list and at the call, whatever the persona allows; other sessions keep
// them. The report that led here: a sub reported to its parent with
// agent_ask as well, and the parent's "confirmed" came back to the parent
// as a follow-up (2026-10-13).
// Run: npm test src/tools/subagent-deny.test.mts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env.SOMORA_HOME = mkdtempSync(join(tmpdir(), 'somora-subdeny-'));
const {
  DEFAULT_SUBAGENT_TOOL_DENY,
  effectiveToolGating,
  isSubagentSession,
  isToolAllowed,
  sessionToolDeny,
  unknownToolRules,
  withSessionDeny,
} = await import('./gating.ts');
const { ToolRegistry } = await import('./registry.ts');
const { ConfigSchema } = await import('../config/types.ts');
const { Inbox } = await import('../server/inbox.ts');
const { inboxFromState } = await import('../server/inbox-sources.ts');

const subMeta = { spawn: { kind: 'sub', parent_agent: 'nova', parent_session: 's1', task_summary: 't' } };
const selfSubMeta = { spawn: { kind: 'self-sub', parent_agent: 'nova', parent_session: 's1', task_summary: 't' } };

// --- which sessions count -------------------------------------------
assert.equal(isSubagentSession(subMeta), true);
assert.equal(isSubagentSession(selfSubMeta), true, 'a clone of the caller is a sub-agent too');
assert.equal(isSubagentSession({}), false);
assert.equal(isSubagentSession(null), false);
assert.equal(isSubagentSession({ spawn: { kind: 'other' } }), false);

// --- the list a session gets ------------------------------------------
assert.deepEqual(sessionToolDeny(undefined, subMeta), [...DEFAULT_SUBAGENT_TOOL_DENY], 'no config section → the default');
assert.deepEqual(DEFAULT_SUBAGENT_TOOL_DENY, ['agent_ask', 'agent_ask_result', 'agent_ask_cancel', 'builder_review']);
assert.deepEqual(sessionToolDeny({ subagents: { tools: { deny: ['web_fetch'] } } }, subMeta), ['web_fetch']);
assert.deepEqual(sessionToolDeny({ subagents: { tools: { deny: [] } } }, subMeta), [], 'deny: [] gives the tools back');
assert.deepEqual(sessionToolDeny({ subagents: { tools: { deny: ['web_fetch'] } } }, {}), [], 'a normal session gets nothing');

// --- the rule beats everything the agent allows -------------------------
const chat = effectiveToolGating('chat', { deny: [], allow: [] });
const deny = [...DEFAULT_SUBAGENT_TOOL_DENY];
assert.equal(isToolAllowed('agent_ask', 'agents', chat), true, 'a normal session keeps agent_ask');
assert.equal(isToolAllowed('agent_ask', 'agents', withSessionDeny(chat, deny)), false);
assert.equal(isToolAllowed('agent_ask_result', 'agents', withSessionDeny(chat, deny)), false);
assert.equal(isToolAllowed('agent_ask_cancel', 'agents', withSessionDeny(chat, deny)), false);
assert.equal(isToolAllowed('spawn_subagent', 'agents', withSessionDeny(chat, deny)), true, 'starting further subs stays');
assert.equal(isToolAllowed('subagent_result', 'agents', withSessionDeny(chat, deny)), true);
assert.equal(isToolAllowed('file_read', 'file', withSessionDeny(chat, deny)), true);
const allowsAsk = effectiveToolGating('chat', { deny: ['toolset:agents'], allow: ['agent_ask'] });
assert.equal(isToolAllowed('agent_ask', 'agents', allowsAsk), true);
assert.equal(isToolAllowed('agent_ask', 'agents', withSessionDeny(allowsAsk, deny)), false, 'an allow in agent.yaml does not bring it back');
const builder = effectiveToolGating('builder', undefined);
assert.equal(isToolAllowed('agent_ask', 'agents', builder), true, 'a builder has agent_ask by default');
assert.equal(isToolAllowed('agent_ask', 'agents', withSessionDeny(builder, deny)), false, 'not as a sub-agent');
assert.equal(isToolAllowed('file_write', 'file', withSessionDeny(builder, deny)), true);
// the same forms as agent.yaml: family and prefix
assert.equal(isToolAllowed('exec', 'exec', withSessionDeny(chat, ['toolset:exec'])), false);
assert.equal(isToolAllowed('mcp__web__search', 'mcp', withSessionDeny(chat, ['mcp__web__*'])), false);
assert.equal(isToolAllowed('mcp__mail__send', 'mcp', withSessionDeny(chat, ['mcp__web__*'])), true);
// nothing to add → the gating object is the agent's own
assert.equal(withSessionDeny(chat, []), chat);
assert.equal(isToolAllowed('agent_ask', 'agents', withSessionDeny(undefined, deny)), false, 'works without agent rules too');

// --- typos ----------------------------------------------------------------
const names = new Set(['agent_ask', 'agent_ask_result', 'web_fetch']);
const sets = new Set(['agents', 'web']);
assert.deepEqual(unknownToolRules(['agent_ask', 'agent_aks', 'toolset:web', 'toolset:wbe', 'mcp__x__y', 'web_*'], names, sets), ['agent_aks', 'toolset:wbe']);

// --- config: the default, and an empty list that stays empty ---------------
assert.deepEqual(ConfigSchema.parse({ providers: {} }).subagents.tools.deny, ['agent_ask', 'agent_ask_result', 'agent_ask_cancel', 'builder_review']);
assert.deepEqual(ConfigSchema.parse({ providers: {}, subagents: {} }).subagents.tools.deny, ['agent_ask', 'agent_ask_result', 'agent_ask_cancel', 'builder_review']);
assert.deepEqual(ConfigSchema.parse({ providers: {}, subagents: { tools: { deny: [] } } }).subagents.tools.deny, []);
assert.deepEqual(ConfigSchema.parse({ providers: {}, subagents: { tools: { deny: ['exec'] } } }).subagents.tools.deny, ['exec']);

// --- the call is refused too (an engine may still know the tool) -----------
const reg = new ToolRegistry();
let ran = 0;
reg.register({
  name: 'agent_ask',
  toolset: 'agents',
  description: 'x',
  inputSchema: z.object({}).passthrough(),
  jsonSchema: { type: 'object' },
  async handler() {
    ran++;
    return { ok: true };
  },
} as never);
const refused = await reg.invoke('agent_ask', {}, { agent: 'a', config: {}, sessionToolDeny: deny } as never);
assert.equal(refused.ok, false);
assert.match(refused.error ?? '', /not available in a sub-agent session/);
assert.match(refused.error ?? '', /reaches your parent on its own/);
assert.equal(ran, 0, 'the tool never ran');
const normal = await reg.invoke('agent_ask', {}, { agent: 'a', config: {} } as never);
assert.equal(normal.ok, true, 'a normal session calls it');
assert.equal(ran, 1);

// --- the inbox names a typo and drops it once fixed -----------------------
const inbox = new Inbox(join(process.env.SOMORA_HOME, 'inbox.json'));
const state = (unknown: string[]) => ({
  version: '1',
  update: () => ({ updateAvailable: false, latestVersion: null, note: null, enabled: false }),
  configProblem: () => null,
  mcpServers: () => ({}),
  unavailableModels: () => [],
  subagentDenyUnknown: () => unknown,
});
inboxFromState(inbox, state(['agent_aks']));
const open = inbox.list().filter((e) => !e.resolvedAt);
assert.equal(open.length, 1);
assert.equal(open[0]!.key, 'config:subagents-deny');
assert.match(open[0]!.text, /`agent_aks`/);
inboxFromState(inbox, state([]));
assert.equal(inbox.list().filter((e) => !e.resolvedAt).length, 0);

console.log('subagent deny: ok');
