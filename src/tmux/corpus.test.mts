// The recorded coding-agent screens (src/tmux/__fixtures__, README there)
// against the tmux state detector. Etappe 0 of the herdr-style rework:
// the corpus is complete and well formed, and today's detector keeps what
// it gets right (working / idle of Claude Code, Codex and OpenCode). Its
// known gaps — no `blocked` state, no Pi — are listed exactly, so the
// rework has to shrink this list, never grow it.
//
// Table of every case: SOMORA_CORPUS_TABLE=1 node scripts/run-tests.mjs src/tmux/corpus.test.mts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectTuiState } from './tui-markers.ts';
import type { TmuxSessionKind } from './origin-store.ts';

const root = new URL('./__fixtures__/', import.meta.url).pathname;
const STATES = new Set(['idle', 'working', 'blocked']);
// What the attention watcher reads (CAPTURE_LINES).
const LINES = 50;
const KIND: Record<string, TmuxSessionKind | undefined> = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', pi: undefined };
// Today's states read as the new ones. There is no blocked.
const AS: Record<string, string> = { running: 'working', ready: 'idle', queued: 'working', idle_unknown: 'unknown' };

interface Case { agent: string; case: string; expected: string; note: string; title: string; width: number; height: number }
const cases: Array<Case & { text: string }> = [];
for (const agent of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  for (const f of readdirSync(join(root, agent)).filter((x) => x.endsWith('.json')).sort()) {
    const meta = JSON.parse(readFileSync(join(root, agent, f), 'utf8')) as Case;
    cases.push({ ...meta, text: readFileSync(join(root, agent, f.replace(/\.json$/, '.txt')), 'utf8') });
  }
}

function today(c: Case & { text: string }): string {
  const tail = c.text.replace(/\n+$/, '').split('\n').slice(-LINES).join('\n');
  const r = detectTuiState(tail, KIND[c.agent]);
  return r ? (AS[r.state] ?? r.state) : 'none';
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

test("today's detector: working and idle of Claude Code, Codex and OpenCode stay right; its gaps are exactly the known ones", () => {
  const misses = cases.filter((c) => today(c) !== c.expected).map((c) => `${c.agent}/${c.case}`);
  if (process.env.SOMORA_CORPUS_TABLE) {
    for (const c of cases) console.log(`${today(c) === c.expected ? 'ok  ' : 'MISS'} ${`${c.agent}/${c.case}`.padEnd(34)} expected ${c.expected.padEnd(8)} got ${today(c)}`);
  }
  assert.deepEqual(misses, [
    // No blocked state yet: dialogs read as idle.
    'claude/blocked-permission',
    'claude/blocked-question',
    'claude/blocked-startup-trust',
    'codex/blocked-approval',
    'codex/blocked-startup-daemon',
    'codex/blocked-startup-trust',
    'opencode/blocked-permission',
    'opencode/blocked-question',
    // Pi is not a known kind.
    'pi/after-abort',
    'pi/done-after-task',
    'pi/narrow-done',
    'pi/narrow-working',
    'pi/startup-idle',
    'pi/typed-not-submitted',
    'pi/working-tool',
    'pi/working-with-queued',
  ]);
});
