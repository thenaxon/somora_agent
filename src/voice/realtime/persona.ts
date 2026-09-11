// The voice self: who the agent is when it speaks.
//
// Derived from the agent's own persona rather than written a second
// time, because two personas drift and the one nobody reads is the one
// that lies. What lives in `agent.yaml voice:` is only what is specific
// to SPEAKING: voice, language, tone, brevity.
//
// Length is a latency budget, not thrift. Everything in these
// instructions sits in the realtime model's context and is re-read
// before every answer, so the target is under ~1500 characters and the
// builder reports what it produced.

import type { Persona } from '../../persona/loader.ts';

export interface VoiceInstructionsInput {
  persona: Persona;
  /** Effective policy: the agent's, else the instance default. */
  consultPolicy: 'auto' | 'substantive' | 'always';
  language: string;
  /** Name of the tool the voice self uses to reach the real agent. */
  consultToolName: string;
  /** Which session this call is bound to — the voice self may say
   *  where it is, and it must never imply it can switch. */
  sessionSlug: string;
}

/** First paragraph of the persona's own description, trimmed. The
 *  system prompt starts with the self-pointer and the persona files;
 *  the first substantial lines carry the character. */
function personaEssence(persona: Persona, limit = 420): string {
  const text = (persona.description || '').trim();
  if (text.length > 0) return text.slice(0, limit);
  const firstPara = persona.systemPrompt
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p.length > 40 && !p.startsWith('#'));
  return (firstPara ?? '').slice(0, limit);
}

export interface BuiltVoiceInstructions {
  text: string;
  chars: number;
}

export function buildVoiceInstructions(input: VoiceInstructionsInput): BuiltVoiceInstructions {
  const { persona, consultPolicy, language, consultToolName, sessionSlug } = input;
  const style = persona.voice?.style?.trim();
  const sentences = persona.voice?.maxSpokenSentences ?? 4;

  const consultLine =
    consultPolicy === 'always'
      ? `Before ANY answer with content in it, call ${consultToolName}. Greeting, acknowledging and asking a clarifying question are the only things you may say on your own.`
      : consultPolicy === 'substantive'
        ? `Call ${consultToolName} for anything about ${persona.name}'s work, memory, files, projects or the world. Small talk and clarifying questions need no call.`
        : `Call ${consultToolName} whenever the answer needs ${persona.name}'s knowledge, tools or memory.`;

  const parts = [
    `You are the voice of ${persona.name}. You speak ${language}.`,
    personaEssence(persona),
    style ? `Tone: ${style}.` : '',
    `Speak in at most ${sentences} sentences. This is a conversation, not a lecture — the other side can interrupt you and should want to.`,
    consultLine,
    `You do NOT know anything about ${persona.name}'s work yourself. You have no memory, no files, no tools beyond the ones listed. Never invent a fact, a result, a name or a number, and never claim you did something, looked something up, or started something. If you have not asked yet, say you are about to.`,
    `While you wait for an answer, one short sentence is enough ("I'll check"). Do not fill the silence with chatter.`,
    `When the answer comes back, say it in your own words, shortened for the ear. Do not read lists or paths aloud unless asked.`,
    `You are talking in ${persona.name}'s session "${sessionSlug}". You cannot change agent or session.`,
  ].filter((p) => p.length > 0);

  const text = parts.join('\n');
  return { text, chars: text.length };
}
