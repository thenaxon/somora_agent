// Self-heal for stuck sessions: detect orphan `tool_call` events in the
// JSONL (a tool_use issued by the model that never got a tool_result
// back) and inject synthetic recovery events so the next user turn can
// proceed cleanly.
//
// The classic failure mode this guards against:
//   - engine subprocess (claude-cli child, codex-cli, ...) crashes
//     mid-turn AFTER the model issued a tool_use but BEFORE the
//     tool_result came back through somora's event pipeline
//   - JSONL ends with `tool_call` (no `tool_result`, no `turn_end`)
//   - any subsequent user message hits a session whose history is
//     inconsistent — engines that reconstruct context from JSONL see a
//     dangling tool_use and either reject the turn or get confused;
//     stateful resume (claude-cli/codex-cli) might also corrupt
//
// Recovery strategy:
//   1. Append a synthetic `tool_result` for each orphan call_id with
//      an explanatory error string. Output is `null`.
//   2. Append a synthetic `turn_end` to properly close the dead turn.
//   3. For stateful engines, drop the stored SDK session-id so the
//      next turn starts fresh and rebuilds context from the now-
//      consistent JSONL. We lose prompt-cache for that turn but
//      gain a recoverable session.
//   4. Log loudly so future forensics see the auto-heal in server logs.
//
// Reference incident: jarvis 2026-05-13 — claude-cli subprocess died
// silently 7 seconds after a successful `dream_get` tool invocation.
// No error logged, no turn_end, session hung for 8 hours until user
// noticed. See ~/somoraworkspace/somora_feedback/2026-05-13_claude-cli-engine-silent-crash-orphan-tool-call.md

import { appendEvent } from '../storage/sessions.ts';
import type { SessionMetaStore } from '../engine/types.ts';
import type { NormalizedEvent } from '../types/events.ts';
import { logger } from './logger.ts';

interface HealArgs {
  agent: string;
  session: string;
  history: NormalizedEvent[];
  metaStore: SessionMetaStore;
  /** Engine the *new* turn will use — used as the fallback "deadEngine"
   *  if the orphan events have no engine field. */
  fallbackEngine: string;
}

export interface HealResult {
  healed: number;
}

export async function healOrphanToolCalls(args: HealArgs): Promise<HealResult> {
  const { agent, session, history, metaStore, fallbackEngine } = args;
  // Only the tail past the most-recent turn_end matters. Earlier orphans
  // (if any, from older bugs) were either already healed or are part
  // of frozen ancient history; rewriting them retroactively would just
  // confuse downstream tools that have already replayed them.
  let lastTurnEndIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const ev = history[i];
    if (ev && ev.kind === 'turn_end') {
      lastTurnEndIdx = i;
      break;
    }
  }
  const tail = history.slice(lastTurnEndIdx + 1);
  if (tail.length === 0) return { healed: 0 };

  const resultCallIds = new Set<string>();
  for (const ev of tail) {
    if (ev.kind === 'tool_result') resultCallIds.add(ev.callId);
  }
  const orphans: Array<Extract<NormalizedEvent, { kind: 'tool_call' }>> = [];
  for (const ev of tail) {
    if (ev.kind === 'tool_call' && !resultCallIds.has(ev.callId)) {
      orphans.push(ev);
    }
  }
  if (orphans.length === 0) return { healed: 0 };

  // Identify the engine that owned the dead turn. Tail events all carry
  // an `engine` field; use the first non-empty one. Defaults to the
  // engine the new turn will run on.
  const deadEngine =
    tail.find((e) => 'engine' in e && typeof e.engine === 'string' && e.engine)?.engine
    ?? fallbackEngine;

  const ts = Date.now();
  for (const o of orphans) {
    await appendEvent(agent, session, {
      kind: 'tool_result',
      ts,
      engine: deadEngine,
      callId: o.callId,
      output: null,
      error:
        '[somora] engine crashed or hung after issuing this tool_use; result is unrecoverable. Session was auto-healed at the next user turn so a fresh engine spinup can proceed.',
    });
  }
  await appendEvent(agent, session, {
    kind: 'turn_end',
    ts,
    engine: deadEngine,
    turnId: `t-recovered-${ts}`,
  });

  // For stateful engines (claude-cli, codex-cli) the dead turn's SDK
  // session has its own internal log that likely also contains the
  // orphan tool_use. Resuming from there is gambling on the SDK's
  // resilience. Cheapest safe move: drop the stored session-id so the
  // next turn starts fresh and rebuilds context from the now-
  // consistent JSONL. History reconstruction is authoritative.
  try {
    const meta = await metaStore.get(agent, session);
    const next: Record<string, unknown> = { ...meta };
    let cleared: string | undefined;
    if (deadEngine === 'claude-cli' && 'sdkSessionId' in next) {
      delete next.sdkSessionId;
      cleared = 'sdkSessionId';
    } else if (deadEngine === 'codex-cli' && 'codexSessionId' in next) {
      delete next.codexSessionId;
      cleared = 'codexSessionId';
    }
    if (cleared) {
      await metaStore.set(agent, session, next);
    }
    logger.warn({
      msg: 'session.recovered_orphan_tool_call',
      agent,
      session,
      deadEngine,
      orphanCount: orphans.length,
      orphanCallIds: orphans.map((o) => o.callId),
      orphanTools: orphans.map((o) => o.tool),
      clearedMeta: cleared,
      hint: 'engine subprocess died mid-turn; auto-healed JSONL and cleared SDK session-id so the next turn rebuilds history',
    });
  } catch (err) {
    logger.warn({
      msg: 'session.recovered_orphan_tool_call_partial',
      agent,
      session,
      deadEngine,
      orphanCount: orphans.length,
      err: String(err),
      hint: 'JSONL was healed but meta cleanup failed — next turn may still hit a corrupt SDK resume',
    });
  }
  return { healed: orphans.length };
}
