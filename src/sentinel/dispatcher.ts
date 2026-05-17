// Sentinel dispatcher — fires an agent-turn for a trigger.
//
// Phase 1: single dispatch primitive. We go through somora's existing
// `/spawn-async` route (after the Phase 0 fix routes unknown sessions
// through createSession). That route handles agent loading, session
// resolution, concurrency caps, lock acquisition, JSONL persistence —
// everything we'd otherwise reimplement. Sentinel just composes the
// prompt and calls it.
//
// The prompt is prefixed with a structured evidence block so the
// woken agent immediately knows:
//   - this is NOT a user message
//   - which trigger fired and why
//   - what the original user intent was (echo from trigger.intent)
//   - which policy was applied (cooldown, dedupe)
// Agents reading this should not respond to "the user" — they should
// produce work that addresses the trigger's intent.

import type { Trigger } from './types.ts';

/** Build the user-message body that the dispatched turn carries. The
 *  agent reads this as a user prompt, but the leading block makes the
 *  sentinel-origin explicit. */
export function buildFirePrompt(trigger: Trigger, firedAt: Date, catchUp: boolean): string {
  const evidence = [
    '[Sentinel trigger fired]',
    `trigger_id: ${trigger.id}`,
    `name: ${trigger.name}`,
    `created_by: ${trigger.ownerAgent}`,
    `source: ${describeSource(trigger)}`,
    `fired_at: ${firedAt.toISOString()}`,
    catchUp ? 'mode: catch-up (server was down at scheduled fire time)' : null,
    trigger.policy?.cooldownMs
      ? `policy: cooldown ${Math.round(trigger.policy.cooldownMs / 1000)}s`
      : null,
    trigger.intent ? `user_intent: ${trigger.intent}` : null,
  ].filter((x): x is string => x !== null);
  return [
    evidence.join('\n'),
    '',
    '---',
    '',
    trigger.dispatch.prompt,
  ].join('\n');
}

function describeSource(trigger: Trigger): string {
  const s = trigger.source;
  if (s.type === 'time') {
    const spec = s.spec;
    switch (spec.type) {
      case 'at':     return `time (once at ${spec.iso})`;
      case 'every':  return `time (every ${spec.interval})`;
      case 'daily':  return `time (daily ${spec.time})`;
      case 'weekly': return `time (weekly ${spec.day} ${spec.time})`;
      case 'cron':   return `time (cron "${spec.expression}")`;
    }
  }
  return s.type;
}

/** Result of a dispatch attempt. */
export interface DispatchResult {
  outcome: 'success' | 'error';
  taskId?: string;
  error?: string;
}

/** Fire the trigger by calling the in-process /spawn-async handler.
 *  We don't go over HTTP — instead the scheduler imports the runChatTurn
 *  + session-resolution helpers directly. Keeps the call cheap and
 *  side-steps the cert/loopback dance.
 *
 *  Implementation lives in src/sentinel/scheduler.ts where it has
 *  access to the same imports the server route uses. This file just
 *  declares the prompt-building utility so it's testable in isolation. */
