// Per-turn image budget.
//
// `imageGen.maxImagesPerTurn` is a cost brake, not a rate limit: an
// agent set to review its own output can re-prompt in a loop, and each
// round is real money (4-8 cents at grok-imagine rates). The ceiling
// gives it room to iterate a few times and then makes it come back and
// ask.
//
// Scoped by turnId, which run-turn.ts owns. MCP-served calls
// (claude-cli / codex-cli) don't carry one; there the per-call `n` is
// still capped but nothing accumulates. Deriving a pseudo-turn from the
// session id was the alternative and is worse: the counter would never
// reset and the agent would be locked out of image generation for the
// rest of that session.

/** Bounded so a long-running server doesn't accumulate one entry per
 *  turn forever. Turns are short and the counter is only interesting
 *  while one is in flight. */
const MAX_TRACKED_TURNS = 500;

const spent = new Map<string, number>();

export function imagesSpentInTurn(turnId: string | undefined): number {
  if (!turnId) return 0;
  return spent.get(turnId) ?? 0;
}

export function recordImagesInTurn(turnId: string | undefined, count: number): void {
  if (!turnId) return;
  // Re-insert so the key moves to the end — makes the trim below evict
  // the least recently touched turn rather than an active one.
  const next = (spent.get(turnId) ?? 0) + count;
  spent.delete(turnId);
  spent.set(turnId, next);
  if (spent.size > MAX_TRACKED_TURNS) {
    const oldest = spent.keys().next();
    if (!oldest.done) spent.delete(oldest.value);
  }
}

/** Test seam. */
export function resetImageBudget(): void {
  spent.clear();
}

export interface BudgetCheck {
  ok: boolean;
  /** How many more images this turn may generate. Infinity when the
   *  turn isn't tracked. */
  remaining: number;
  reason?: string;
}

export function checkImageBudget(
  turnId: string | undefined,
  requested: number,
  maxPerTurn: number,
): BudgetCheck {
  if (requested > maxPerTurn) {
    return {
      ok: false,
      remaining: maxPerTurn,
      reason:
        `n=${requested} exceeds imageGen.maxImagesPerTurn (${maxPerTurn}). ` +
        `Generate at most ${maxPerTurn} images per turn.`,
    };
  }
  if (!turnId) return { ok: true, remaining: Number.POSITIVE_INFINITY };

  const used = imagesSpentInTurn(turnId);
  const remaining = maxPerTurn - used;
  if (requested > remaining) {
    return {
      ok: false,
      remaining: Math.max(0, remaining),
      reason:
        `this turn has already generated ${used} of ${maxPerTurn} allowed images ` +
        `(imageGen.maxImagesPerTurn). Ask the user before generating more.`,
    };
  }
  return { ok: true, remaining };
}
