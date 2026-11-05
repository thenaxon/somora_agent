// The acceptance list of a builder session (docs/builder.md "Acceptance
// list"): one item per requirement of the order, each with a status and
// the evidence behind it, beside the task list. The task list says what
// the builder is doing; this list says what the order asked for and what
// shows it is met.
//
// Why (report 2026-10-28): night builds ended with 137–199 green tests
// while central requirements of the order were still broken, and "done"
// was read as "every requirement met". A list per requirement with
// evidence makes the gap visible; it does not prove the work.
//
// Who writes what:
//   the builder (acceptance_write)  requirement wording on creation,
//                                    status open | passed | failed | not_run,
//                                    evidence. It cannot remove an item or
//                                    reword one, and it cannot accept.
//   the person (panel, API) or the  a review per item: accepted | rejected,
//   orderer agent (API)              with a note. A builder change to the
//                                    item's status or evidence clears it:
//                                    the review was of the old evidence.
//
// Lives in the session meta (`acceptance`, `acceptanceRequired`), like
// the task list.

export const BUILDER_ACCEPTANCE_STATUSES = ['open', 'passed', 'failed', 'not_run'] as const;
export type AcceptanceStatus = (typeof BUILDER_ACCEPTANCE_STATUSES)[number];
export type AcceptanceVerdict = 'accepted' | 'rejected';

export interface AcceptanceReview {
  verdict: AcceptanceVerdict;
  /** `person` for the panel / API without an agent, else the agent. */
  by: string;
  note?: string;
  at: number;
}

export interface AcceptanceItem {
  id: string;
  requirement: string;
  status: AcceptanceStatus;
  /** What shows the status: command and result, file, test, revision. */
  evidence?: string;
  updatedAt: number;
  review?: AcceptanceReview;
}

export const MAX_ACCEPTANCE_ITEMS = 60;
const MAX_REQUIREMENT_CHARS = 500;
const MAX_EVIDENCE_CHARS = 1_000;
const MAX_NOTE_CHARS = 1_000;

export function readAcceptance(meta: Record<string, unknown>): { items: AcceptanceItem[]; required: boolean } {
  const raw = meta.acceptance;
  const items = Array.isArray(raw) ? (raw.filter((x) => x && typeof x === 'object' && typeof (x as AcceptanceItem).id === 'string') as AcceptanceItem[]) : [];
  return { items, required: meta.acceptanceRequired === true };
}

export interface AcceptanceWriteResult {
  items: AcceptanceItem[];
  /** What the server did not take, said back to the builder. */
  warnings: string[];
}

/**
 * Merge what the builder sent into the stored list. The builder sends the
 * whole list each time (like todo_write), but an item it leaves out stays,
 * a reworded requirement keeps its first wording, and a status outside
 * open | passed | failed | not_run is refused — so the list cannot be
 * narrowed to what happens to be done.
 */
export function mergeBuilderAcceptance(
  stored: AcceptanceItem[],
  sent: unknown[],
  now = Date.now(),
  /** The session requires the list: passed or failed without evidence,
   *  or not_run without a reason, is refused — the item keeps its status.
   *  Without it, only a warning. */
  opts: { strict?: boolean } = {},
): AcceptanceWriteResult {
  const warnings: string[] = [];
  const byId = new Map(stored.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const out: AcceptanceItem[] = [];
  for (const raw of sent) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as { id?: unknown; requirement?: unknown; status?: unknown; evidence?: unknown };
    const id = typeof o.id === 'string' ? o.id.trim().slice(0, 20) : '';
    if (!id) {
      warnings.push('an item without an id was skipped');
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`${id} appears twice; the first one counts`);
      continue;
    }
    seen.add(id);
    const status = typeof o.status === 'string' ? o.status.trim().toLowerCase() : 'open';
    const prev = byId.get(id);
    if (!(BUILDER_ACCEPTANCE_STATUSES as readonly string[]).includes(status)) {
      warnings.push(
        status === 'accepted' || status === 'rejected'
          ? `${id}: "${status}" is a review, set by the person or the orderer, not by you; kept as ${prev?.status ?? 'open'}`
          : `${id}: unknown status "${status}"; use open, passed, failed or not_run`,
      );
    }
    let nextStatus = ((BUILDER_ACCEPTANCE_STATUSES as readonly string[]).includes(status) ? status : prev?.status ?? 'open') as AcceptanceStatus;
    let evidence = typeof o.evidence === 'string' && o.evidence.trim() ? o.evidence.trim().slice(0, MAX_EVIDENCE_CHARS) : undefined;
    // The whole list comes every time: an item sent again with its status
    // and without evidence keeps the evidence it has (and so its review).
    if (!evidence && prev?.evidence && prev.status === nextStatus) evidence = prev.evidence;
    let requirement = typeof o.requirement === 'string' ? o.requirement.trim().slice(0, MAX_REQUIREMENT_CHARS) : '';
    if (prev) {
      if (requirement && requirement !== prev.requirement) {
        warnings.push(`${id}: the requirement keeps its first wording; add a new item for a new requirement`);
      }
      requirement = prev.requirement;
    } else if (!requirement) {
      warnings.push(`${id}: a new item needs its requirement; skipped`);
      continue;
    }
    if (nextStatus !== 'open' && !evidence) {
      const what = nextStatus === 'not_run' ? 'not_run without the reason' : `${nextStatus} without evidence`;
      const how = nextStatus === 'not_run' ? 'say in evidence why it was not checked' : 'name the command and its result, the file or the test';
      if (opts.strict) {
        // Refused: the item stays as it was, and so does its evidence.
        warnings.push(`${id}: refused — ${what}; it stays ${prev?.status ?? 'open'}. Send it again and ${how}`);
        nextStatus = prev?.status ?? 'open';
        evidence = prev?.evidence;
      } else if (nextStatus !== 'not_run') {
        warnings.push(`${id}: ${what} — ${how}`);
      }
    }
    const changed = !prev || prev.status !== nextStatus || (prev.evidence ?? '') !== (evidence ?? '');
    out.push({
      id,
      requirement,
      status: nextStatus,
      ...(evidence ? { evidence } : {}),
      updatedAt: changed ? now : prev!.updatedAt,
      // A review is of the evidence it saw: a change clears it.
      ...(prev?.review && !changed ? { review: prev.review } : {}),
    });
    if (out.length >= MAX_ACCEPTANCE_ITEMS) break;
  }
  for (const prev of stored) {
    if (seen.has(prev.id) || out.length >= MAX_ACCEPTANCE_ITEMS) continue;
    warnings.push(`${prev.id} cannot be removed; it stays as ${prev.status}. Mark it not_run and say why in the evidence`);
    out.push(prev);
  }
  return { items: out, warnings };
}

/** A review of one item by the person or the orderer. */
export function applyReview(
  stored: AcceptanceItem[],
  review: { id: string; verdict: AcceptanceVerdict; by: string; note?: string },
  now = Date.now(),
): AcceptanceItem[] | null {
  const idx = stored.findIndex((i) => i.id === review.id);
  if (idx < 0) return null;
  const next = [...stored];
  next[idx] = {
    ...stored[idx]!,
    review: {
      verdict: review.verdict,
      by: review.by,
      ...(review.note?.trim() ? { note: review.note.trim().slice(0, MAX_NOTE_CHARS) } : {}),
      at: now,
    },
  };
  return next;
}

/** Items the builder still owes something on: still open, or rejected
 *  by the reviewer (until the builder sends the item again with new
 *  evidence, which clears the rejection). */
export function openAcceptance(items: AcceptanceItem[]): AcceptanceItem[] {
  return items.filter((i) => i.status === 'open' || i.review?.verdict === 'rejected');
}

/** The list as a Markdown table, for the report and the compaction block. */
export function renderAcceptanceTable(items: AcceptanceItem[]): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
  const lines = ['| ID | Requirement | Status | Evidence | Review |', '|---|---|---|---|---|'];
  for (const i of items) {
    const review = i.review ? `${i.review.verdict} (${i.review.by})${i.review.note ? `: ${i.review.note}` : ''}` : '';
    lines.push(`| ${cell(i.id)} | ${cell(i.requirement)} | ${i.status} | ${cell(i.evidence ?? '')} | ${cell(review)} |`);
  }
  return lines.join('\n');
}
