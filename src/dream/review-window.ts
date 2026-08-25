// Lucid review-loop windows in a session transcript.
//
// While an agent runs `dream_review(action:'start')` … `dream_review(
// action:'end')`, it is in wiki-write mode: every fact the user
// clarifies in that window is written straight to the wiki via
// `wiki_edit` (or explicitly deferred/dismissed in the mandatory end
// summary). Letting REM re-extract those same statements produced an
// "echo dream" of pure duplicates after every loop (2026-08-24 report:
// three loops, three echo dreams, 8/8 findings duplicates). So REM
// skips those windows — see rem-runner.ts.

import type { NormalizedEvent } from '../types/events.ts';

const TOOL = 'dream_review';

/** `dream_review` as written by any engine: openai-compatible records
 *  the bare name, the CLI engines the MCP-prefixed one
 *  (`mcp__somora-memory__dream_review`). */
function isDreamReviewCall(ev: NormalizedEvent): ev is Extract<NormalizedEvent, { kind: 'tool_call' }> {
  if (ev.kind !== 'tool_call') return false;
  return ev.tool === TOOL || ev.tool.endsWith(`__${TOOL}`);
}

function reviewAction(ev: Extract<NormalizedEvent, { kind: 'tool_call' }>): 'start' | 'end' | null {
  const input = ev.input;
  if (!input || typeof input !== 'object') return null;
  const action = (input as { action?: unknown }).action;
  return action === 'start' || action === 'end' ? action : null;
}

export interface ReviewWindow {
  fromTs: number;
  /** Infinity when the loop never ended inside the scanned events
   *  (session ended mid-loop) — everything after `fromTs` is skipped. */
  throughTs: number;
}

/** The [start, end] windows of review loops found in `events`, in order. */
export function findReviewWindows(events: readonly NormalizedEvent[]): ReviewWindow[] {
  const out: ReviewWindow[] = [];
  let open: number | null = null;
  for (const ev of events) {
    if (!isDreamReviewCall(ev)) continue;
    const action = reviewAction(ev);
    if (action === 'start') {
      // A second start while one is open just extends the same window.
      if (open === null) open = ev.ts;
    } else if (action === 'end' && open !== null) {
      out.push({ fromTs: open, throughTs: ev.ts });
      open = null;
    }
  }
  if (open !== null) out.push({ fromTs: open, throughTs: Number.POSITIVE_INFINITY });
  return out;
}

/** `events` without everything that falls inside a review-loop window.
 *  The `dream_review` calls themselves go too — they carry nothing REM
 *  should remember. */
export function excludeReviewWindows(
  events: readonly NormalizedEvent[],
): { events: NormalizedEvent[]; windows: ReviewWindow[]; dropped: number } {
  const windows = findReviewWindows(events);
  if (windows.length === 0) return { events: [...events], windows, dropped: 0 };
  const kept: NormalizedEvent[] = [];
  for (const ev of events) {
    const inside = windows.some((w) => ev.ts >= w.fromTs && ev.ts <= w.throughTs);
    if (!inside) kept.push(ev);
  }
  return { events: kept, windows, dropped: events.length - kept.length };
}
