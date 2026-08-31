// Per-agent skill gating (2026-08-31): same semantics as tool gating,
// legacy allow-list stays valid.
//
// Run: npx tsx src/skills/gating.test.mts

import assert from 'node:assert/strict';
import { assertValidSkillName, isSkillAllowed, normalizeSkillGating } from './gating.ts';
import { filterSkillsForAgent } from './registry.ts';
import type { LoadedSkill } from './load.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

// ── normalize ──────────────────────────────────────────────────────
check('undefined → no gating', normalizeSkillGating(undefined) === undefined);
check('legacy [] → no gating (documented lenient meaning)', normalizeSkillGating([]) === undefined);
check('legacy [a,b] → allow-list', JSON.stringify(normalizeSkillGating(['a', 'b'])) === '{"deny":[],"allow":["a","b"]}');
check('object {} → no gating', normalizeSkillGating({}) === undefined);
check('object deny only', JSON.stringify(normalizeSkillGating({ deny: ['x'] })) === '{"deny":["x"],"allow":[]}');
check('object both', JSON.stringify(normalizeSkillGating({ deny: ['x'], allow: ['a'] })) === '{"deny":["x"],"allow":["a"]}');

// ── isSkillAllowed ─────────────────────────────────────────────────
check('no gating → allowed', isSkillAllowed('github', undefined));
check('deny hides', !isSkillAllowed('github', { deny: ['github'], allow: [] }));
check('deny leaves the rest visible (new skills too)', isSkillAllowed('brand-new', { deny: ['github'], allow: [] }));
check('allow-list: listed → visible', isSkillAllowed('github', { deny: [], allow: ['github'] }));
check('allow-list: unlisted → hidden', !isSkillAllowed('brand-new', { deny: [], allow: ['github'] }));
check('deny beats allow', !isSkillAllowed('github', { deny: ['github'], allow: ['github'] }));

// ── names ──────────────────────────────────────────────────────────
for (const ok of ['github', 'skill-author', 'a1', 'x'.repeat(64)]) {
  let threw = false;
  try {
    assertValidSkillName(ok);
  } catch {
    threw = true;
  }
  check(`valid name accepted: ${ok.slice(0, 12)}`, !threw);
}
for (const bad of ['', 'Foo', 'a_b', 'toolset:x', 'mcp__*', '-lead', 'x'.repeat(65), '../etc']) {
  let threw = false;
  try {
    assertValidSkillName(bad);
  } catch {
    threw = true;
  }
  check(`invalid name rejected: ${JSON.stringify(bad).slice(0, 14)}`, threw);
}

// ── filter over loaded skills ──────────────────────────────────────
const sk = (name: string): LoadedSkill =>
  ({ name, description: name, requiresBins: [], requiresConfig: [], requiresEnvVars: [], tags: [], dir: '/x', body: '', available: true }) as unknown as LoadedSkill;
const all = [sk('github'), sk('gog'), sk('storeganise')];
check('filter: no gating → all', filterSkillsForAgent(all, undefined).length === 3);
check('filter: deny one → two', filterSkillsForAgent(all, { deny: ['gog'], allow: [] }).map((s) => s.name).join(',') === 'github,storeganise');
check('filter: allow one → one', filterSkillsForAgent(all, { deny: [], allow: ['gog'] }).map((s) => s.name).join(',') === 'gog');
check('filter: unknown names tolerated', filterSkillsForAgent(all, { deny: ['nope'], allow: [] }).length === 3);

console.log(`skill-gating: ${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
