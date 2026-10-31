// What a builder still owes when it wants to end its turn (docs/builder.md
// "When the builder wants to stop"): open items on the task list it
// worked this turn, open items on the acceptance list, or no acceptance
// list although the session requires one. One check for every engine:
//
//   openai-compatible  runs the tool loop itself and asks inside the
//                      running turn (src/engine/openai-compatible.ts).
//   claude-cli,        run their own loop; somora sees the turn only when
//   codex-cli,         it has ended. start-turn.ts then starts a short
//   grok-cli           follow-up turn with the same notice, at most twice,
//                      before the asker gets the result.
//
// A turn that changed nothing (no file_write, file_patch or todo_write)
// is left alone: an orderer's "is the service still up?" is answered,
// not held to a list.

import { openAcceptance, readAcceptance, type AcceptanceItem } from './builder-acceptance.ts';

// At most this often per turn (or, for the CLI engines, follow-up turns
// per order). Hermes and DeepSeek-TUI hold a coding agent to its work at
// turn end too; night builds 2026-10-27/28 ended with work open.
export const MAX_OPEN_TASK_NUDGES = 2;

/** Tools whose use makes a turn one that worked on the order. */
const WORK_TOOLS = new Set(['file_write', 'file_patch', 'todo_write']);

export function turnWorked(toolsUsed: Iterable<string>): boolean {
  for (const t of toolsUsed) if (WORK_TOOLS.has(t)) return true;
  return false;
}

export interface TurnEndFacts {
  /** The session meta as it is now. */
  meta: Record<string, unknown>;
  /** The turn used file_write, file_patch or todo_write. */
  worked: boolean;
  todoWritten: boolean;
  acceptanceWritten: boolean;
  /** acceptance_write is among the turn's tools (build phase). */
  acceptanceTool: boolean;
}

export interface TurnEndCheck {
  open: Array<{ content?: string; status?: string }>;
  accOpen: AcceptanceItem[];
  accMissing: boolean;
}

export function checkBuilderTurnEnd(f: TurnEndFacts): TurnEndCheck | null {
  const todos = f.meta.todos as Array<{ content?: string; status?: string }> | undefined;
  // The task list counts when this turn worked it.
  const open = f.todoWritten && Array.isArray(todos) ? todos.filter((t) => t.status === 'pending' || t.status === 'in_progress') : [];
  // The acceptance list when this turn wrote it, or when the session
  // requires one and this turn worked on the order.
  const acc = readAcceptance(f.meta);
  const accCounts = f.acceptanceWritten || (acc.required && f.worked);
  const accOpen = accCounts ? openAcceptance(acc.items) : [];
  const accMissing = accCounts && acc.required && acc.items.length === 0 && f.acceptanceTool;
  if (open.length === 0 && accOpen.length === 0 && !accMissing) return null;
  return { open, accOpen, accMissing };
}

/** "3 open item(s) on its task list and no acceptance list …" — the
 *  system row's wording. */
export function describeTurnEnd(c: TurnEndCheck): string {
  return [
    ...(c.open.length > 0 ? [`${c.open.length} open item(s) on its task list`] : []),
    ...(c.accOpen.length > 0 ? [`${c.accOpen.length} open acceptance item(s)`] : []),
    ...(c.accMissing ? ['no acceptance list although the session requires one'] : []),
  ].join(' and ');
}

/** What the builder is told, without the closing sentence (which differs
 *  between a running turn and a follow-up turn). */
export function turnEndNoticeParts(c: TurnEndCheck): string[] {
  const parts: string[] = [];
  if (c.open.length > 0) {
    const names = c.open.slice(0, 5).map((t) => `"${String(t.content ?? '').slice(0, 80)}"`).join(', ');
    parts.push(
      `Your task list still has ${c.open.length} open item(s): ${names}${c.open.length > 5 ? ', …' : ''}. ` +
        'If an item is in fact done and verified, mark it completed with todo_write. Otherwise continue with it.',
    );
  }
  if (c.accOpen.length > 0) {
    const ids = c.accOpen.slice(0, 8).map((i) => i.id).join(', ');
    parts.push(
      `Your acceptance list still has ${c.accOpen.length} open item(s): ${ids}${c.accOpen.length > 8 ? ', …' : ''}. ` +
        'Check each against the order itself and set passed or failed with the evidence, or not_run with the reason.',
    );
  }
  if (c.accMissing) {
    parts.push(
      'This session requires an acceptance list and there is none. Write it with acceptance_write: one item per requirement of the order, each with its status and evidence.',
    );
  }
  return parts;
}

/** The text of a follow-up turn (CLI engines). */
export function followUpNotice(c: TurnEndCheck): string {
  return (
    `[somora] You ended your turn with ${describeTurnEnd(c)}. ${turnEndNoticeParts(c).join(' ')} ` +
    'Do not shrink the task to what is done. If something truly blocks you, name the blocker and what you tried. ' +
    'Then end with your complete report again — whoever gave the order reads only this last answer.'
  );
}
