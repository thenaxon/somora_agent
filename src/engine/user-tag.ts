// The OpenAI `user` request field as somora fills it: "<agent>/<scope>".
//
// `user` is part of the standard chat-completions contract, so every
// openai-compatible backend accepts it and a gateway in between
// (LiteLLM, a vLLM router) can log it. That is the whole point: with
// it, spend and traces group per agent and per session instead of per
// API key. Provider-specific body fields (`metadata`, `litellm_*`)
// are deliberately NOT used — some backends 400 on unknown top-level
// keys, `user` never does.
//
// One helper so every call site sends the same shape and honours the
// same `sendUserTag: false` opt-out.

import type { ResolvedModel } from '../config/types.ts';

/** `{ user }` to spread into a chat-completions body, or `{}` when the
 *  provider opted out. `scope` is the session id for chat turns and a
 *  worker name (`rem`, `deep`, `compaction`, `analyze_file`) for
 *  background calls, so worker traffic stays attributable too. */
export function userTagParam(model: ResolvedModel, agent: string, scope: string): { user?: string } {
  const provider = model.provider as { sendUserTag?: boolean };
  if (provider.sendUserTag === false) return {};
  return { user: `${agent}/${scope}` };
}
