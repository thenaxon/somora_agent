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

export const SWITCH_TOOL_NAME = 'somora_switch_agent';

/**
 * Move the call: to another agent, or to another session of the agent
 * already on the line.
 *
 * The target is otherwise fixed for the length of a call, on purpose: a
 * model that can re-point itself can write into a conversation nobody
 * asked it to. This is the one exception, and it is explicit — the
 * human says "put me through to lisa", it is announced in both
 * sessions, and the picker in the window follows.
 *
 * Both dimensions, because an agent is not one conversation. Offering
 * only other agents left "put me into your cerebrocraft session"
 * unanswerable, with no way for the agent to help (Rene, 2026-09-12).
 * The caller's own agent therefore stays in the list.
 *
 * It is a fresh provider session underneath: a voice cannot be changed
 * once a session has produced audio (measured 2026-09-11), and two
 * agents that sound alike would be worse than a second of silence.
 */
export function switchToolSpec(callable: readonly string[], current?: string): RealtimeToolSpec {
  const others = callable.filter((a) => a !== current);
  return {
    name: SWITCH_TOOL_NAME,
    description:
      'Move this conversation when the user asks for it: to another agent, ' +
      'or to a different session of the agent they are already talking to. ' +
      `Agents you can reach: ${callable.join(', ')}.` +
      (current ? ` You are ${current} — pass your own name to stay with the user and change session.` : '') +
      ' Say one short sentence that you are moving them, then call. ' +
      'Never switch on your own initiative, and never to look something up — for that you ask.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description:
            `Who continues the conversation. One of: ${callable.join(', ')}.` +
            (current ? ` Use "${current}" to stay with yourself and only change session.` : '') +
            (others.length > 0 ? ` Use one of ${others.join(', ')} to hand over.` : ''),
        },
        session: {
          type: 'string',
          description:
            'Which session to continue in, by name (e.g. "main", "projektA"). ' +
            'Pass it ONLY when the user named a session out loud in this call, ' +
            'and then exactly as they said it. Never pass the session you are ' +
            'in now just because you are in it — every agent has a main session, ' +
            'not every agent has yours. Omit it and they land in main.',
        },
      },
      required: ['agent'],
      additionalProperties: false,
    },
  };
}

export interface SwitchArgs {
  agent: string;
  session?: string;
}

export function parseSwitchArgs(raw: string): { ok: true; args: SwitchArgs } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'your call arrived incomplete — say the name again' };
  }
  const obj = parsed as Partial<SwitchArgs> | null;
  const agent = typeof obj?.agent === 'string' ? obj.agent.trim() : '';
  if (!agent) return { ok: false, error: 'no agent was named — ask who they want to talk to' };
  const session = typeof obj?.session === 'string' && obj.session.trim().length > 0 ? obj.session.trim() : undefined;
  return { ok: true, args: { agent, ...(session ? { session } : {}) } };
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
export interface ConsultTurn {
  /**
   * Scaffolding for the model: why this turn looks the way it does, and
   * the last few lines of the call.
   *
   * Kept OUT of the message text on purpose. Everything stored as the
   * turn's text is read later as if the human had written it — by the
   * dream phase that learns from a session, by the search that builds a
   * recall query from recent messages, by the compaction that summarises
   * pairs. Half of every voice turn was this same boilerplate (measured
   * across four agents on 2026-09-12: 12,312 characters of frame against
   * 12,390 of content for one of them), which dilutes exactly the two
   * things that are supposed to find the content.
   *
   * It travels in the same field somora already uses for the memory
   * block, which every engine puts in front of the user message and
   * which replays byte-identically — so the model sees no difference at
   * all.
   */
  prefix: string;
  /** What the caller actually wants. This is the record. */
  text: string;
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
export function renderConsultTurn(
  args: ConsultArgs,
  speaker: string,
  /**
   * The last few lines of the call, oldest first.
   *
   * Without them a question arrives stripped of everything around it:
   * "what time is it" says nothing about what the caller is actually
   * doing. OpenClaw hands its consulting agent the same thing.
   */
  transcript: ReadonlyArray<{ role: 'caller' | 'voice'; text: string }> = [],
): ConsultTurn {
  const lines = [
    `[${speaker} is on a voice call with you. Your voice channel asks — answer into this chat, ` +
      'briefly and in a form that can be read aloud. Do not address anyone else.]',
  ];
  if (transcript.length > 0) {
    lines.push('', 'Said so far:');
    for (const entry of transcript) {
      lines.push(`${entry.role === 'caller' ? speaker : 'you, out loud'}: ${entry.text}`);
    }
  }
  const text = args.context ? `${args.question}\n\n(context: ${args.context})` : args.question;
  return { prefix: lines.join('\n'), text };
}
