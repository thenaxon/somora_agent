// Timestamp-cursor pagination for /chat/history (Juni-Audit 2026-06,
// fixed 2026-07-27).
//
// The cursor is `before=<oldestTs of the previous page>` with a strict
// `ts < before` filter. JSONL timestamps have ms resolution and bursts
// (tool_call + tool_result + delta flushes) regularly share one ts —
// when a page boundary landed INSIDE such a group, the events of that
// group that didn't make the page were unreachable on every subsequent
// page (strictly-older filter skips them): a silent hole in the web
// client's lazy-load scrollback.
//
// Fix: a page never splits a same-ts group. The slice is extended
// backwards until the oldest timestamp on the page is fully contained,
// so `ts < oldestTs` on the next call misses nothing. Pages may exceed
// `limit` by the group remainder — bounded and harmless; termination
// is preserved (a group larger than `limit` returns whole, and the
// next call's filter is empty).

interface TsEvent {
  ts: number;
}

export interface HistoryPage<E extends TsEvent> {
  events: E[];
  hasMore: boolean;
  oldestTs: number | null;
}

export function paginateHistory<E extends TsEvent>(
  all: E[],
  limit: number,
  before: number,
): HistoryPage<E> {
  const filtered = all.filter((e) => e.ts < before);
  let start = Math.max(0, filtered.length - limit);
  // Extend backwards over the same-ts group at the boundary.
  while (start > 0 && filtered[start - 1]!.ts === filtered[start]!.ts) {
    start--;
  }
  const events = filtered.slice(start);
  return {
    events,
    hasMore: start > 0,
    oldestTs: events.length > 0 ? events[0]!.ts : null,
  };
}
