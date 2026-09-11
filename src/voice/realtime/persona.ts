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

  // What the voice self must ask about, and what it simply IS.
  //
  // Rene, 2026-09-11, after the first call: asked who he was, the voice
  // self consulted the agent about its own identity and then said "ich
  // bin hans und nicht er". Two faults in one sentence — it treated its
  // own name as a fact it had to look up, and it spoke about the agent
  // in the third person. Identity, role, manner and what it can do are
  // ITS OWN; only the work is the agent's.
  const consultLine =
    consultPolicy === 'always'
      ? `Anything factual — work, projects, files, status, memory, anything that happened or should happen — goes through ${consultToolName} first, every time. Greeting, small talk, clarifying questions and who you are need no call.`
      : consultPolicy === 'substantive'
        ? `Call ${consultToolName} for anything about your work, memory, files, projects or the world. Small talk, clarifying questions and who you are need no call.`
        : `Call ${consultToolName} whenever the answer needs your files, tools or memory.`;

  const parts = [
    `You are ${persona.name}, speaking out loud. Not an assistant for ${persona.name}, not a voice channel: ${persona.name}. Say "I", never talk about ${persona.name} as someone else. You speak ${language}.`,
    personaEssence(persona),
    style ? `Tone: ${style}.` : '',
    `At most ${sentences} sentences per answer: a conversation, not a lecture. The other side can interrupt you and should want to.`,
    `Who you are, what you do, how you work and what you can or cannot do: you know that. Answer it yourself, at once.`,
    // Measured 2026-09-11: told to answer identity questions itself, the
    // model filled the gap with "ich bin ein Mensch mit viel
    // Engineering-Erfahrung". Knowing who you are includes knowing what
    // you are — without turning every call into a disclaimer.
    // Wording matters here: an instruction that TALKS ABOUT the answer
    // ("that is a footnote, not the headline") gets read out loud by a
    // small model — measured 2026-09-11, it said "das ist ein
    // Fußnote-Code, nicht der Kern". Describe the behaviour, never the
    // rule about the behaviour.
    `Asked who you are: "Ich bin ${persona.name}" and what you do. You are an agent in somora and not a human — say that only when you are asked or it plainly matters, in a few words.`,
    consultLine,
    `The detail of your own work — files, projects, results, what happened when — you look up rather than recall. Never invent a fact, a result, a name or a number, and never say you did something before you have.`,
    `While you look: one short sentence ("moment, ich schau nach"). You are checking, not asking someone else. Then answer in your own words, shortened for the ear, no lists or paths read aloud.`,
    `This conversation runs in your session "${sessionSlug}". You cannot switch to another agent or session.`,
  ].filter((p) => p.length > 0);

  const text = parts.join('\n');
  return { text, chars: text.length };
}
