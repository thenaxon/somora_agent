// Tests for review-window.ts — REM must skip the session range covered
// by a dream_review start..end loop (2026-08-24 report: every Lucid loop
// produced an echo dream re-extracting facts already written to the
// wiki inside that loop).
//
// Run: npx tsx src/dream/rem-review-window.test.mts

import assert from 'node:assert/strict';
import type { NormalizedEvent } from '../types/events.ts';
import { excludeReviewWindows, findReviewWindows } from './review-window.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const user = (ts: number, text: string): NormalizedEvent =>
  ({ kind: 'user_message', ts, engine: 'claude-cli', text }) as NormalizedEvent;
const agent = (ts: number, text: string): NormalizedEvent =>
  ({ kind: 'assistant_message', ts, engine: 'claude-cli', text }) as NormalizedEvent;
const call = (ts: number, tool: string, input: unknown): NormalizedEvent =>
  ({ kind: 'tool_call', ts, engine: 'claude-cli', callId: `c${ts}`, tool, input }) as NormalizedEvent;

// ── a complete loop (CLI engine, mcp-prefixed name) ──────────────────
{
  const events = [
    user(10, 'Polizze 788/0327487 gehört zu Walter'),
    agent(11, 'notiert'),
    call(20, 'mcp__somora-memory__dream_review', { dream_id: 'x_auto_lucid', action: 'start' }),
    user(21, '#3 ja es ist rm52 geworden'),
    call(22, 'mcp__somora-memory__wiki_edit', { wikiPath: 'projekte/ai-server', newBody: '… RM52 …' }),
    agent(23, 'eingetragen'),
    call(30, 'mcp__somora-memory__dream_review', { dream_id: 'x_auto_lucid', action: 'end', summary: '…' }),
    user(40, 'was gibts sonst neues'),
    agent(41, 'nichts'),
  ];
  const w = findReviewWindows(events);
  check('one window', w.length === 1 && w[0]?.fromTs === 20 && w[0]?.throughTs === 30, JSON.stringify(w));
  const r = excludeReviewWindows(events);
  const kept = r.events.map((e) => e.ts);
  check('events before the loop survive', kept.includes(10) && kept.includes(11));
  check('events after the loop survive', kept.includes(40) && kept.includes(41));
  check('loop contents dropped (user clarification + wiki_edit + reply)', !kept.some((t) => t >= 20 && t <= 30));
  check('dropped count', r.dropped === 5, String(r.dropped));
}

// ── bare tool name (openai-compatible engine) ────────────────────────
{
  const events = [
    call(5, 'dream_review', { dream_id: 'y', action: 'start' }),
    user(6, 'fact'),
    call(7, 'dream_review', { dream_id: 'y', action: 'end' }),
    user(8, 'after'),
  ];
  const r = excludeReviewWindows(events);
  check('bare name matched', r.events.map((e) => e.ts).join(',') === '8');
}

// ── unterminated loop: everything after start is skipped ─────────────
{
  const events = [user(1, 'a'), call(2, 'dream_review', { action: 'start' }), user(3, 'b'), user(4, 'c')];
  const r = excludeReviewWindows(events);
  check('open window runs to the end', r.events.map((e) => e.ts).join(',') === '1', JSON.stringify(r.windows));
  check('open window reported as infinite', r.windows[0]?.throughTs === Number.POSITIVE_INFINITY);
}

// ── no loop → untouched ──────────────────────────────────────────────
{
  const events = [user(1, 'a'), agent(2, 'b'), call(3, 'mcp__somora-memory__memory_write', { slug: 'x' })];
  const r = excludeReviewWindows(events);
  check('no windows → identity', r.dropped === 0 && r.events.length === 3 && r.windows.length === 0);
}

// ── end without start, and malformed input, are ignored ──────────────
{
  const events = [
    call(1, 'dream_review', { action: 'end' }),
    call(2, 'dream_review', { _raw: 'garbage' }),
    user(3, 'x'),
  ];
  const r = excludeReviewWindows(events);
  check('stray end / unparsable input ignored', r.dropped === 0 && r.events.length === 3);
}

// ── two loops in one range ───────────────────────────────────────────
{
  const events = [
    call(1, 'dream_review', { action: 'start' }), user(2, 'in1'), call(3, 'dream_review', { action: 'end' }),
    user(4, 'between'),
    call(5, 'dream_review', { action: 'start' }), user(6, 'in2'), call(7, 'dream_review', { action: 'end' }),
  ];
  const r = excludeReviewWindows(events);
  check('two windows', r.windows.length === 2);
  check('only the between-event survives', r.events.map((e) => e.ts).join(',') === '4');
}

console.log(`\n${pass} passed, ${fail} failed`);
assert.equal(fail, 0);
