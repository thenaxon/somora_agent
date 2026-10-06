// The thinking level a turn runs with, and where it comes from. One
// resolver for the turn and for the route the clients read, so what a
// client shows is what the model gets.
//
//   session override (/thinking)  >  agent.yaml `thinking:`  >
//   the model's `reasoning.default` in config.yaml  >  none
//
// "none" sends nothing, and the model does what it does by default —
// many reasoning models think. Clients show that as "model decides",
// never as "off".
import type { Model, ThinkingLevel } from '../config/types.ts';

export const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(['off', 'low', 'medium', 'high']);

export type ThinkingSource = 'session-override' | 'persona-default' | 'model-default' | 'engine-default';

export function resolveThinking(
  persona: { thinking?: ThinkingLevel },
  sessionMeta: Record<string, unknown>,
  model?: Pick<Model, 'reasoning'>,
): { level: ThinkingLevel | undefined; source: ThinkingSource } {
  const override = sessionMeta.thinkingOverride;
  if (typeof override === 'string' && VALID_THINKING_LEVELS.has(override as ThinkingLevel)) {
    return { level: override as ThinkingLevel, source: 'session-override' };
  }
  if (persona.thinking) return { level: persona.thinking, source: 'persona-default' };
  const modelDefault = model?.reasoning?.default;
  if (modelDefault) return { level: modelDefault, source: 'model-default' };
  return { level: undefined, source: 'engine-default' };
}
