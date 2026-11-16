// The start menu's plain logic: which tiles are left off the desktop
// (per browser, like the tile positions), and the search over agents and
// apps. Kept apart from the component so it can be tested without a DOM.

const HIDDEN_KEY = 'somora-desktop-hidden';

/** Tile ids (`agent:<name>`, `app:<id>`) the person took off the desktop. */
export function readHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    // Missing, blocked (private mode) or corrupt: everything on the desktop.
    return new Set();
  }
}

export function writeHidden(hidden: ReadonlySet<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hidden].sort()));
  } catch {
    // Blocked storage: the choice holds for this page only.
  }
}

export function toggled(hidden: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export interface Searchable {
  id: string;
  /** What the person types: a name, a label. */
  name: string;
  /** Matched too, ranked after the name (an agent's role). */
  extra?: string;
}

/** The entries matching a query, best first: a name that starts with
 *  it, then a name that contains it, then the extra text. Order within
 *  a rank is kept. An empty query keeps everything. */
export function searchEntries<T extends Searchable>(entries: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  const rank = (e: T): number => {
    const n = e.name.toLowerCase();
    if (n.startsWith(q)) return 0;
    if (n.includes(q)) return 1;
    if (e.extra?.toLowerCase().includes(q)) return 2;
    return -1;
  };
  return entries
    .map((e, i) => ({ e, i, r: rank(e) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.e);
}
