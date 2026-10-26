// The order of the agent tiles: the saved list first (names that still
// exist), then every other agent by name. The list is the same on every
// device (GET/PUT /mobile-agent-order).

export function applyAgentOrder<T extends { name: string }>(agents: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((n, i) => [n, i]));
  return [...agents].sort((a, b) => {
    const ra = rank.get(a.name);
    const rb = rank.get(b.name);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** The list with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item as T);
  return out;
}
