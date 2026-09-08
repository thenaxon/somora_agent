// Compact form of Playwright's AI aria snapshot for the model.
//
// The raw `page.ariaSnapshot({ mode: 'ai' })` is a YAML tree where every
// node carries a `[ref=eN]` — including anonymous `generic` containers,
// which on a real page are most of the lines and say nothing. The
// compact mode keeps what an agent acts on or reads: interactive
// elements (they keep their ref), headings, link targets, and text —
// container lines are dropped, their children keep their indentation so
// the structure stays readable. `full` returns the raw tree.
//
// Refs stay valid until the next snapshot of the same tab (Playwright
// re-numbers per snapshot) and until the tab navigates (the service
// bumps the tab's generation, and `act` refuses a ref from an older
// generation).

const CONTAINER_RE = /^(\s*)- generic(?: \[[^\]]+\])*:?\s*$/;
const TEXT_MAX = 160;

export function compactAriaSnapshot(raw: string, maxChars: number): { text: string; truncated: boolean } {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (CONTAINER_RE.test(line)) continue;
    let l = line;
    // `- text: …` and `- paragraph: …` prose lines: cap the length.
    const m = /^(\s*- (?:text|paragraph|\/url):\s*)(.*)$/.exec(l);
    if (m && m[2]!.length > TEXT_MAX) l = `${m[1]}${m[2]!.slice(0, TEXT_MAX).trimEnd()}…`;
    out.push(l);
  }
  const joined = out.join('\n');
  if (joined.length <= maxChars) return { text: joined, truncated: false };
  return { text: `${joined.slice(0, maxChars).trimEnd()}\n…(truncated — pass max_chars or full:false with a narrower page)`, truncated: true };
}

/** All refs mentioned in a snapshot text, for the stale-ref check. */
export function refsIn(snapshot: string): Set<string> {
  const refs = new Set<string>();
  for (const m of snapshot.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)) refs.add(m[1]!);
  return refs;
}
