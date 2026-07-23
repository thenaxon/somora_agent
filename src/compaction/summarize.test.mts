// Tests for compaction range extraction (2026-07-23).
//
// Run: npx tsx src/compaction/summarize.test.mts
//
// Regression (Juni-Audit): a user_message with no following
// assistant_message (an error-ended turn) was silently dropped — the next
// user_message overwrote `pendingUser` before it was ever pushed, so its
// content vanished from the compacted context once throughTs passed.

import assert from 'node:assert/strict';

import { extractCompactionRange } from './summarize.ts';
import type { CompactionConfig } from './types.ts';
import type { NormalizedEvent } from '../types/events.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${name} ${detail}`);
  }
}

const u = (ts: number, text: string): NormalizedEvent =>
  ({ kind: 'user_message', ts, text } as NormalizedEvent);
const a = (ts: number, text: string): NormalizedEvent =>
  ({ kind: 'assistant_message', ts, text } as NormalizedEvent);

const cfg = (cushion: number): CompactionConfig =>
  ({ safetyCushionPairs: cushion } as CompactionConfig);

const ORPHAN = '[kein Assistant-Reply — Turn ohne Antwort beendet]';

// ── the live bug: an error-ended turn in the MIDDLE is preserved ──────
{
  // U1 got no reply (turn errored), then U2/A2, then U3/A3.
  const history = [u(1, 'U1-lost'), u(2, 'U2'), a(3, 'A2'), u(4, 'U3'), a(5, 'A3')];
  const range = extractCompactionRange(history, cfg(0), undefined);
  check('range not null', range !== null);
  const pairs = range?.pairs ?? [];
  check('3 pairs (orphan + 2 answered)', pairs.length === 3, `${pairs.length}`);
  check('orphan user content preserved', pairs[0]?.user === 'U1-lost', pairs[0]?.user);
  check('orphan has placeholder assistant', pairs[0]?.assistant === ORPHAN, pairs[0]?.assistant);
  check('answered pairs intact', pairs[1]?.user === 'U2' && pairs[1]?.assistant === 'A2');
  check('chronological order kept', pairs[2]?.user === 'U3' && pairs[2]?.assistant === 'A3');
}

// ── normal conversation: no orphan markers introduced ─────────────────
{
  const history = [u(1, 'U1'), a(2, 'A1'), u(3, 'U2'), a(4, 'A2')];
  const range = extractCompactionRange(history, cfg(0), undefined);
  const pairs = range?.pairs ?? [];
  check('2 clean pairs', pairs.length === 2, `${pairs.length}`);
  check('no orphan placeholder in clean history', !pairs.some((p) => p.assistant === ORPHAN));
}

// ── trailing pending user (newest turn) is NOT flushed into compaction ─
{
  // U2 is the in-flight / just-arrived turn with no reply yet.
  const history = [u(1, 'U1'), a(2, 'A1'), u(3, 'U2-live')];
  const range = extractCompactionRange(history, cfg(0), undefined);
  const pairs = range?.pairs ?? [];
  check('trailing pending user not compacted', pairs.length === 1, `${pairs.length}`);
  check('trailing user content absent from compaction', !pairs.some((p) => p.user === 'U2-live'));
  check('throughTs stops at last answered pair', range?.throughTs === 2, `${range?.throughTs}`);
}

// ── two consecutive orphans both survive ──────────────────────────────
{
  const history = [u(1, 'orphanA'), u(2, 'orphanB'), u(3, 'U3'), a(4, 'A3')];
  const range = extractCompactionRange(history, cfg(0), undefined);
  const pairs = range?.pairs ?? [];
  check('both orphans + answered pair = 3', pairs.length === 3, `${pairs.length}`);
  check('orphanA preserved', pairs[0]?.user === 'orphanA');
  check('orphanB preserved', pairs[1]?.user === 'orphanB');
}

// ── cushion still protects the newest answered pairs ──────────────────
{
  const history = [u(1, 'U1'), a(2, 'A1'), u(3, 'U2'), a(4, 'A2'), u(5, 'U3'), a(6, 'A3')];
  const range = extractCompactionRange(history, cfg(2), undefined);
  const pairs = range?.pairs ?? [];
  check('cushion=2 leaves only the oldest pair to compact', pairs.length === 1, `${pairs.length}`);
  check('compacted pair is the oldest', pairs[0]?.user === 'U1');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
assert.ok(true);
