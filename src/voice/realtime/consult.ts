// The one tool the voice self gets: ask the real agent.
//
// It exists ONLY inside a realtime provider session. It is not in
// somora's ToolRegistry, no agent can call it, and it never shows up in
// the Abilities window — a normal agent has no business phoning its own
// voice.
//
// The target (agent + session) is bound when the call starts and is NOT
// an argument. A model that can name its own target can quietly write
// into a different conversation, which is the one thing a voice channel
// must never do.

import type { RealtimeToolSpec } from './types.ts';

export const CONSULT_TOOL_NAME = 'somora_agent_consult';

export function consultToolSpec(agent: string): RealtimeToolSpec {
  return {
    name: CONSULT_TOOL_NAME,
    description:
      `Look something up or get something done: this reaches your own tools, memory and files, and ` +
      'returns the result. Use it for anything factual AND for every request to act — opening a ' +
      'browser, starting a session, writing a file, sending something. This is the only way you do ' +
      'anything at all, so never decide for yourself that something is impossible. ' +
      'ONE short sentence — what the user actually wants, nothing else. No instructions about how to ' +
      'answer, no "describe briefly", no lists of sub-questions: those make the question longer than ' +
      'the answer and are read by a human in the chat log.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description:
            'The request itself, in ONE sentence, in the language of the conversation. ' +
            'What the user wants — not how it should be answered, not why. Keep it under 200 characters.',
        },
        context: {
          type: 'string',
          description:
            'Optional: one line of what was said before, when the question alone would be ambiguous.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
  };
}

export const STATUS_TOOL_NAME = 'somora_work_status';

/**
 * "How far are you?" without starting anything.
 *
 * A lookup takes the session, and while a long job runs there is
 * nothing to take. Live 2026-09-11: the agent was told to build a small
 * game in a tmux session, its turn stayed open for minutes, and the
 * conversation had nothing to say for that whole time — every further
 * question would have queued behind the build. This reads the state and
 * returns at once, so the voice can answer instead of going silent.
 */
export function statusToolSpec(): RealtimeToolSpec {
  return {
    name: STATUS_TOOL_NAME,
    description:
      'Check whether you are still working on something and for how long. Returns immediately and ' +
      'starts nothing. Use it when asked how far along you are, or when a lookup came back saying ' +
      'you were busy.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };
}

/** Arguments as they arrive from the provider (JSON text). */
export interface ConsultArgs {
  question: string;
  context?: string;
}

/**
 * Parse the arguments of a consult call.
 *
 * Tool arguments stream as text and can arrive cut off — the same fault
 * that killed whole turns on the chat side on 2026-09-10. Here it must
 * not kill the CALL: the voice self gets told to ask again, and the
 * conversation continues.
 */
export function parseConsultArgs(raw: string): { ok: true; args: ConsultArgs } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: `your call arrived incomplete (${raw.length} characters of unparseable JSON) — ask again, shorter`,
    };
  }
  const obj = parsed as Partial<ConsultArgs> | null;
  const question = typeof obj?.question === 'string' ? obj.question.trim() : '';
  if (question.length === 0) {
    return { ok: false, error: 'no question was passed — call it again with the actual question' };
  }
  const context = typeof obj?.context === 'string' && obj.context.trim().length > 0 ? obj.context.trim() : undefined;
  return { ok: true, args: { question, ...(context ? { context } : {}) } };
}

/**
 * How the question reaches the agent.
 *
 * It arrives as a turn with `from_system: 'voice'`, NOT as agent mail:
 * with A2A the agent believes someone is waiting for a reply addressed
 * back to them, and answers accordingly. Here the agent simply answers
 * into its own running chat, and the voice channel reads that answer
 * from the turn result. Rene, 2026-09-11: "er soll sich bewusst sein
 * das ist eine nachricht seines voice-ichs".
 */
export function renderConsultTurnText(args: ConsultArgs, speaker: string): string {
  const lines = [
    `[${speaker} is on a voice call with you. Your voice channel asks — answer into this chat, ` +
      'briefly and in a form that can be read aloud. Do not address anyone else.]',
    '',
    args.question,
  ];
  if (args.context) lines.push('', `(context: ${args.context})`);
  return lines.join('\n');
}
