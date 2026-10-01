// The structural findings Lucid produces without asking a model — they
// are facts of the file system, not judgements — and the gate that
// keeps structure out of a wiki that was never migrated.
//
// Why (the operator, 2026-09-29): after the migration a wiki has a template
// version in its structure file; a wiki that only took the update has
// none. Structure findings ("this page is in the wrong folder", "this
// page is too big") against a grown wiki would be hundreds of lines of
// noise, so they exist only where the template applies. A wiki without
// it gets exactly one hint per run that the migration is available.

import type { LucidFinding } from './lucid-types.ts';
import type { LucidPage } from './lucid-batches.ts';

export interface StructureContext {
  migrated: boolean;
  templateVersion: number;
  /** Characters above which a page is reported as oversized. */
  oversizedChars: number;
}

/** What is kept when a run has more findings than `maxFindings`: one
 *  of each kind in turn, weightiest kind first, round after round —
 *  so a run with 12 contradictions and 17 duplicates yields a mix,
 *  not twelve contradictions and no duplicate (2026-09-29, the first
 *  capped run did exactly that). Within a kind the order of discovery
 *  stays (earlier folders first). */
const KEEP_ORDER: readonly LucidFinding['kind'][] = ['not_migrated', 'contradiction', 'dead_ref', 'duplicate_page', 'misfiled_page', 'oversized_page', 'wanted_page', 'link_suggestion', 'stale_claim', 'outdated', 'inconsistent_xref'];

export function capFindings(findings: LucidFinding[], max: number): { kept: LucidFinding[]; dropped: Record<string, number>; duplicates: number } {
  // The same pair can come up in two parts of a folder and again in
  // the cross pass (2026-09-29: the heimkino twins were filed three
  // times) — one finding per kind and page set.
  const seen = new Set<string>();
  const unique: LucidFinding[] = [];
  let duplicates = 0;
  for (const f of findings) {
    const key = `${f.kind}|${[...new Set(f.affected_pages.map((p) => p.toLowerCase()))].sort().join(',')}`;
    if (f.affected_pages.length > 0 && seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(f);
  }
  if (unique.length <= max) return { kept: unique, dropped: {}, duplicates };
  const rank = (k: LucidFinding['kind']): number => {
    const i = KEEP_ORDER.indexOf(k);
    return i < 0 ? KEEP_ORDER.length : i;
  };
  const queues = new Map<number, LucidFinding[]>();
  for (const f of [...unique].sort((a, b) => a.id - b.id)) {
    const r = rank(f.kind);
    queues.set(r, [...(queues.get(r) ?? []), f]);
  }
  const order = [...queues.keys()].sort((a, b) => a - b);
  const picked: LucidFinding[] = [];
  while (picked.length < max && order.some((r) => (queues.get(r)?.length ?? 0) > 0)) {
    for (const r of order) {
      const q = queues.get(r)!;
      if (q.length === 0 || picked.length >= max) continue;
      picked.push(q.shift()!);
    }
  }
  const kept = picked.sort((a, b) => a.id - b.id);
  const dropped: Record<string, number> = {};
  for (const r of order) for (const f of queues.get(r)!) dropped[f.kind] = (dropped[f.kind] ?? 0) + 1;
  return { kept, dropped, duplicates };
}

/** Deterministic findings, before any model call. `nextId` is the first id to use. */
export function structuralFindings(pages: LucidPage[], ctx: StructureContext, nextId: number): LucidFinding[] {
  const out: LucidFinding[] = [];
  let id = nextId;
  if (!ctx.migrated) {
    out.push({
      id: id++,
      kind: 'not_migrated',
      status: 'pending',
      affected_pages: [],
      reason:
        'This wiki has not been moved onto the folder template (no template version in the structure file). ' +
        'Lucid checks content only — contradictions, dead links, duplicates — and leaves the folder layout alone. ' +
        '`somora wiki migrate` plans the move, shows every group for approval and takes a full copy first; dismiss this once if you prefer the wiki as it is.',
      fix: { kind: 'no_op', note: 'informational — run `somora wiki migrate` when you want the template' },
    });
    return out;
  }
  const big = pages.filter((p) => p.markdown.length > ctx.oversizedChars).sort((a, b) => b.markdown.length - a.markdown.length);
  for (const p of big) {
    const kb = Math.round(p.markdown.length / 1024);
    out.push({
      id: id++,
      kind: 'oversized_page',
      status: 'pending',
      affected_pages: [p.wikiPath],
      reason: `${p.wikiPath} is ${kb} KB (limit ${Math.round(ctx.oversizedChars / 1024)} KB): a page this size is read in parts by every worker and its timeline drowns its current state. Consider sub-pages per part (e.g. one page per sub-project or per device) with the parent keeping a short current state and links.`,
      fix: { kind: 'no_op', note: 'split into sub-pages during review (wiki_create + wiki_edit + wiki_move)' },
    });
  }
  return out;
}
