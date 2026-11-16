// The recorded coding-agent screens (src/tmux/__fixtures__, README there)
// against the state detector (detection/, herdr's rules): the corpus is
// complete and well formed, and every screen is read right. The marker
// detector it replaced got 26 of these 42 (2026-11-16): no dialog was
// blocked, Pi was not known.
//
// Table of every case: SOMORA_CORPUS_TABLE=1 node scripts/run-tests.mjs src/tmux/corpus.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectAgentState } from './detection/manifests.ts';
import { detectionScreen } from './detection/engine.ts';

const root = new URL('./__fixtures__/', import.meta.url).pathname;
const STATES = new Set(['idle', 'working', 'blocked']);
interface Case { agent: string; case: string; expected: string; note: string; title: string; width: number; height: number }
const cases: Array<Case & { text: string }> = [];
for (const agent of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  for (const f of readdirSync(join(root, agent)).filter((x) => x.endsWith('.json')).sort()) {
    const meta = JSON.parse(readFileSync(join(root, agent, f), 'utf8')) as Case;
    cases.push({ ...meta, text: readFileSync(join(root, agent, f.replace(/\.json$/, '.txt')), 'utf8') });
  }
}

test('the corpus is complete: four agents, every case with text, ANSI and a known expected state', () => {
  assert.deepEqual([...new Set(cases.map((c) => c.agent))], ['claude', 'codex', 'opencode', 'pi']);
  for (const c of cases) {
    assert.ok(STATES.has(c.expected), `${c.agent}/${c.case}: expected "${c.expected}"`);
    assert.ok(existsSync(join(root, c.agent, `${c.case}.ansi`)), `${c.agent}/${c.case}.ansi missing`);
    assert.ok(c.text.trim().length > 0, `${c.agent}/${c.case}.txt is empty`);
  }
  // Every agent with a permission or question UI has at least one blocked case.
  for (const a of ['claude', 'codex', 'opencode']) {
    assert.ok(cases.some((c) => c.agent === a && c.expected === 'blocked'), `${a}: no blocked case`);
  }
});

test('the herdr-rule detector reads every recorded screen right', () => {
  const wrong: string[] = [];
  for (const c of cases) {
    const d = detectAgentState(c.agent, { screen: detectionScreen(c.text, c.height), title: c.title });
    if (process.env.SOMORA_CORPUS_TABLE) console.log(`${d?.state === c.expected ? 'ok  ' : 'MISS'} ${`${c.agent}/${c.case}`.padEnd(34)} expected ${c.expected.padEnd(8)} got ${String(d?.state).padEnd(8)} ${d?.rule?.id ?? d?.fallback ?? ''}`);
    if (d?.state !== c.expected) wrong.push(`${c.agent}/${c.case}: expected ${c.expected}, got ${d?.state} (${d?.rule?.id ?? d?.fallback})`);
  }
  assert.deepEqual(wrong, []);
});

test('Codex working in a narrow window: the title decides first, the screen agrees on its own', () => {
  const c = cases.find((x) => x.agent === 'codex' && x.case === 'narrow-working')!;
  const screen = detectionScreen(c.text, c.height);
  const withTitle = detectAgentState('codex', { screen, title: c.title })!;
  assert.equal(withTitle.state, 'working');
  assert.equal(withTitle.rule?.id, 'osc_title_working');
  const screenOnly = detectAgentState('codex', { screen, title: '' })!;
  assert.equal(screenOnly.state, 'working');
  assert.notEqual(screenOnly.rule?.region, 'osc_title');
});
