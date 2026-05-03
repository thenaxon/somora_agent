// Pure formatting helpers. No React, no Ink — kept reusable for tests too.

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function summarize(value: unknown, maxLen = 160): string {
  if (value === undefined || value === null) return '';
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '';
  }
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen).trimEnd() + '…';
  return s;
}

export function nextId(): string {
  // Cheap monotonic id for React keys. We never need stability across runs.
  nextId.counter = (nextId.counter ?? 0) + 1;
  return `t${nextId.counter}`;
}
nextId.counter = 0 as number;
