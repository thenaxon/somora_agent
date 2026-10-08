// Abilities clicks: a click changes exactly what was clicked, nothing else,
// from any starting point — checked over thousands of random click sequences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveToolGating, isToolAllowed, setToolsetLookup, type AgentKind, type ToolGating } from './gating.ts';
import { groupRuleFor, toggleSkills, toggleTools, type CatalogTool } from './gating-edit.ts';
import { isSkillAllowed, type SkillGating } from '../skills/gating.ts';

const CATALOG: CatalogTool[] = [
  { name: 'file_read', toolset: 'file' }, { name: 'file_write', toolset: 'file' }, { name: 'file_patch', toolset: 'file' },
  { name: 'exec', toolset: 'exec' }, { name: 'tmux', toolset: 'exec' },
  { name: 'web_fetch', toolset: 'web' }, { name: 'web_search', toolset: 'web' },
  { name: 'memory_write', toolset: 'memory' }, { name: 'memory_search', toolset: 'memory' },
  { name: 'mcp__alpha__a', toolset: 'mcp', mcpServer: 'alpha' }, { name: 'mcp__alpha__b', toolset: 'mcp', mcpServer: 'alpha' }, { name: 'mcp__alpha__c', toolset: 'mcp', mcpServer: 'alpha' },
  { name: 'mcp__beta__x', toolset: 'mcp', mcpServer: 'beta' }, { name: 'mcp__beta__y', toolset: 'mcp', mcpServer: 'beta' },
  { name: 'todo_write', toolset: 'builder' }, { name: 'plan_write', toolset: 'builder' },
];
/** What the window offers a chat agent: everything but the builder-only family. */
const offered = (kind: AgentKind) => (kind === 'builder' ? CATALOG : CATALOG.filter((t) => t.toolset !== 'builder'));
setToolsetLookup((n) => CATALOG.find((t) => t.name === n)?.toolset);

const vis = (kind: AgentKind, g: ToolGating, t: CatalogTool) => isToolAllowed(t.name, t.toolset, effectiveToolGating(kind, g));
const families = (kind: AgentKind) => {
  const m = new Map<string, CatalogTool[]>();
  for (const t of offered(kind)) { const k = groupRuleFor(t)!; m.set(k, [...(m.get(k) ?? []), t]); }
  return [...m.values()];
};

// A small deterministic random source so a failure can be replayed.
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

const STARTS: [AgentKind, ToolGating][] = [
  ['chat', { deny: [], allow: [] }],
  ['chat', { deny: ['web_search', 'mcp__alpha__a', 'mcp__alpha__b', 'mcp__alpha__c'], allow: [] }],
  ['chat', { deny: ['toolset:exec', 'mcp__beta__*'], allow: ['tmux'] }],
  ['chat', { deny: [], allow: ['file_read', 'web_fetch'] }], // old "only these"
  ['chat', { deny: ['mcp__alpha__*', 'memory_write'], allow: ['mcp__alpha__b'] }],
  ['chat', { deny: ['mcp__*'], allow: [] }], // hand-written wide rule
  ['builder', { deny: [], allow: [] }],
  ['builder', { deny: ['exec'], allow: ['memory_write', 'mcp__alpha__*'] }],
];

test('every click changes exactly the clicked tools, from every starting point', () => {
  const r = rng(42);
  let clicks = 0;
  for (const [kind, start] of STARTS) {
    for (let run = 0; run < 150; run++) {
      let g: ToolGating = { deny: [...start.deny], allow: [...start.allow] };
      for (let step = 0; step < 12; step++) {
        const before = new Map(CATALOG.map((t) => [t.name, vis(kind, g, t)]));
        const group = r() < 0.4;
        const fam = families(kind)[Math.floor(r() * families(kind).length)]!;
        const pool = offered(kind);
        const targets = group ? fam : [pool[Math.floor(r() * pool.length)]!];
        const want = r() < 0.5;
        const next = toggleTools({ kind, own: g, tools: targets, visible: want, group });
        for (const t of CATALOG) {
          const now = vis(kind, next, t);
          const expected = targets.includes(t) ? want : before.get(t.name)!;
          assert.equal(now, expected, `${kind} start=${JSON.stringify(start)} step=${step} ${group ? 'group' : 'single'} ${targets.map((x) => x.name)}→${want}: ${t.name} is ${now}, expected ${expected}; rules ${JSON.stringify(next)}`);
        }
        if (kind === 'chat') for (const t of CATALOG.filter((x) => x.toolset === 'builder')) assert.equal(vis(kind, next, t), false, `builder-only ${t.name} leaked to a chat agent`);
        // No duplicates, ever.
        assert.equal(new Set(next.deny).size, next.deny.length);
        assert.equal(new Set(next.allow).size, next.allow.length);
        g = next;
        clicks++;
      }
    }
  }
  assert.ok(clicks > 10000, String(clicks));
});

test('a family switched off on a chat agent stays off for tools it gains later', () => {
  const alpha = CATALOG.filter((t) => t.mcpServer === 'alpha');
  const off = toggleTools({ kind: 'chat', own: { deny: [], allow: [] }, tools: alpha, visible: false, group: true });
  assert.deepEqual(off, { deny: ['mcp__alpha__*'], allow: [] }, 'one rule, no single lines');
  assert.equal(vis('chat', off, { name: 'mcp__alpha__new_tool', toolset: 'mcp', mcpServer: 'alpha' }), false, 'a new alpha tool is off');
  const exec = CATALOG.filter((t) => t.toolset === 'exec');
  const execOff = toggleTools({ kind: 'chat', own: off, tools: exec, visible: false, group: true });
  assert.equal(vis('chat', execOff, { name: 'exec_new', toolset: 'exec' }), false, 'a new exec tool is off');
  // One tool back on inside the switched-off family: an exception, the rule stays.
  const oneBack = toggleTools({ kind: 'chat', own: execOff, tools: [alpha[1]!], visible: true });
  assert.ok(oneBack.deny.includes('mcp__alpha__*') && oneBack.allow.includes('mcp__alpha__b'));
  assert.equal(vis('chat', oneBack, { name: 'mcp__alpha__new_tool', toolset: 'mcp', mcpServer: 'alpha' }), false, 'new tools still off');
  // The family back on: rule and exception gone, the file is clean again.
  const allBack = toggleTools({ kind: 'chat', own: oneBack, tools: alpha, visible: true, group: true });
  assert.deepEqual(allBack, { deny: ['toolset:exec'], allow: [] });
});

test('builders: the family eye switches each tool; extras go under allow; nothing new turns on', () => {
  const alpha = CATALOG.filter((t) => t.mcpServer === 'alpha');
  const on = toggleTools({ kind: 'builder', own: { deny: [], allow: [] }, tools: alpha, visible: true, group: true });
  assert.deepEqual(on, { deny: [], allow: ['mcp__alpha__a', 'mcp__alpha__b', 'mcp__alpha__c'] });
  assert.equal(vis('builder', on, { name: 'mcp__alpha__new_tool', toolset: 'mcp', mcpServer: 'alpha' }), false);
  const fileOff = toggleTools({ kind: 'builder', own: on, tools: [CATALOG[0]!], visible: false });
  assert.deepEqual(fileOff.deny, ['file_read'], 'a builder-set tool off is a single deny');
});

test('a chat agent never gets a builder-only tool, not even by an allow entry', () => {
  for (const g of [{ deny: [], allow: ['todo_write'] }, { deny: ['*'], allow: ['plan_write', 'toolset:builder'] }, { deny: [], allow: ['*'] }]) {
    for (const t of CATALOG.filter((x) => x.toolset === 'builder')) assert.equal(vis('chat', g, t), false, `${t.name} with ${JSON.stringify(g)}`);
  }
  assert.equal(vis('builder', { deny: [], allow: [] }, CATALOG.find((t) => t.name === 'todo_write')!), true);
});

test('the old "only these" form: switching its last tool off does not open everything', () => {
  const start = { deny: [], allow: ['file_read'] };
  const off = toggleTools({ kind: 'chat', own: start, tools: [CATALOG[0]!], visible: false });
  for (const t of CATALOG) assert.equal(vis('chat', off, t), false, t.name);
});

// ─── skills ─────────────────────────────────────────────────────────

const SKILLS = ['github', 'gog', 'skill-author', 'invoices', 'reminders'];
const svis = (kind: AgentKind, g: SkillGating, n: string) => isSkillAllowed(n, kind === 'builder' ? { ...g, defaultDeny: true } : g);

test('skill clicks change exactly the clicked skills, from every starting point', () => {
  const r = rng(7);
  const starts: [AgentKind, SkillGating][] = [
    ['chat', { deny: [], allow: [] }],
    ['chat', { deny: ['gog'], allow: [] }],
    ['chat', { deny: [], allow: ['github', 'invoices'] }], // old "only these" form
    ['chat', { deny: ['*'], allow: ['reminders'] }],
    ['builder', { deny: [], allow: [] }],
    ['builder', { deny: [], allow: ['github'] }],
  ];
  for (const [kind, start] of starts) {
    for (let run = 0; run < 200; run++) {
      let g: SkillGating = { deny: [...start.deny], allow: [...start.allow] };
      for (let step = 0; step < 10; step++) {
        const before = new Map(SKILLS.map((n) => [n, svis(kind, g, n)]));
        const group = r() < 0.3;
        const names = group ? SKILLS : [SKILLS[Math.floor(r() * SKILLS.length)]!];
        const want = r() < 0.5;
        const next = toggleSkills({ kind, own: g, all: SKILLS, names, visible: want, group });
        for (const n of SKILLS) assert.equal(svis(kind, next, n), names.includes(n) ? want : before.get(n), `${kind} ${JSON.stringify(start)} ${names}→${want}: ${n}; ${JSON.stringify(next)}`);
        g = next;
      }
    }
  }
});

test('all skills off on a chat agent covers skills added later', () => {
  const off = toggleSkills({ kind: 'chat', own: { deny: ['gog'], allow: [] }, all: SKILLS, names: SKILLS, visible: false, group: true });
  assert.deepEqual(off, { deny: ['*'], allow: [] });
  assert.equal(svis('chat', off, 'brand-new-skill'), false);
});
