// What the model is told about a turn, beside the turn.
//
// Two things reach the model for every turn: the text — what a person
// said, what an agent asked, what a trigger's prompt says — and a frame
// around it: who wrote it, why it arrives now, what to do with it. The
// text is the record: the dream phase learns from it, the recall search
// is built from it, a reader sees it. The frame is scaffolding for this
// one turn and belongs in `turnPrefix`, which every engine puts in
// front of the user message and which replays byte-identically
// (run-turn.ts).
//
// Until 2026-09-13 the frame lived in three different places: the A2A
// header was prepended by each of four engine adapters, the sentinel
// evidence block, the tmux/browser/video instructions and the wake
// texts were written INTO the stored text, and only the voice consult
// used the prefix. Since Phase 3 of the turn-dispatch refactor
// (private/turn-dispatch-phase2-design.md §5, Phase 3) every frame
// travels in the prefix; the stored text of a wake is one line saying
// what happened.
//
// The rule per origin:
//   agent      — the header `[Message from agent X, session Y]`, built HERE
//                (startTurn composes it; engines add nothing);
//   sentinel   — the evidence block (dispatcher.ts buildFireFrame);
//   tmux / browser / video / wakes — the instructions, built by the
//                caller that knows the domain, passed as `turnPrefix`;
//   voice      — the call framing (consult.ts renderConsultTurn);
//   human, subagent — none.
//
// Turns recorded before this carry the A2A header in no field at all
// (the engine added it live), so the openai-compatible history rebuild
// still adds it for a turn without `origin`. Everything else stays as
// it was recorded.

import { sessionSlugOf } from '../engine/a2a.ts';
import type { TurnOrigin } from '../types/turn-origin.ts';

const HEADER_PREFIX = '[Message from agent ';

/** The provenance line a turn written by another agent carries. */
export function a2aHeaderFor(origin: TurnOrigin): string | undefined {
  if (origin.kind !== 'agent') return undefined;
  const session = origin.from.session ? `, session ${sessionSlugOf(origin.from.session)}` : '';
  return `${HEADER_PREFIX}${origin.from.agent}${session}]`;
}

/** Everything the model sees beside the text, in order: provenance,
 *  then whatever the caller framed. */
export function composeTurnPrefix(origin: TurnOrigin, callerPrefix?: string): string | undefined {
  const parts = [a2aHeaderFor(origin), callerPrefix?.trim()].filter((p): p is string => Boolean(p && p.length > 0));
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
