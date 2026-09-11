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
  /**
   * Hand-written character for the voice self, from
   * `~/.somora/agents/<name>/VOICE.md`. Replaces the part derived from
   * the persona — never the rules below it.
   *
   * The split is deliberate. OpenClaw writes the whole thing by hand
   * (their realtime call takes a configured `instructions` string, read
   * from their bundle 2026-09-11), which is full control and a file per
   * agent to maintain. somora derives it, which is nothing to maintain
   * for eight agents and no second place to drift. With this override
   * you get both: you own the character where you care, somora owns the
   * contract that keeps it honest — delegate, do not invent, do not
   * refuse work on your own authority.
   */
  override?: string;
  /** Effective policy: the agent's, else the instance default. */
  consultPolicy: 'auto' | 'substantive' | 'always';
  language: string;
  /** Name of the tool the voice self uses to reach the real agent. */
  consultToolName: string;
  /** Which session this call is bound to — the voice self may say
   *  where it is, and it must never imply it can switch. */
  sessionSlug: string;
  /** Agents this call may be handed over to. Empty = no switching, and
   *  the instruction says so instead of teasing an ability. */
  switchTo?: readonly string[];
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
  const override = input.override?.trim();
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
  // Three rules that kept fighting each other in the first live calls,
  // now one line each.
  //
  //  - It refused work on its own authority ("den Browser hab ich
  //    nicht") because the prompt told it that it knew what it could do.
  //  - Told to announce a lookup and then make it, it announced and
  //    stopped — both models, so the filler comes from somora instead.
  //  - And it narrated the lookup as asking a third party, which breaks
  //    the one thing this whole design is about: it IS the agent.
  const consultLine =
    consultPolicy === 'always'
      ? `Everything factual and every request to act goes through ${consultToolName}: work, projects, files, status, memory, opening a browser, starting, writing or sending something. Greeting, small talk, clarifying questions and who you are need no call.`
      : consultPolicy === 'substantive'
        ? `Anything about your work, memory, files or projects, and every request to act, goes through ${consultToolName}. Small talk, clarifying questions and who you are need no call.`
        : `Call ${consultToolName} whenever the answer needs your files, tools or memory.`;

  const parts = [
    `You are ${persona.name}, speaking out loud — not an assistant for ${persona.name}, not a voice channel. Say "I", never talk about ${persona.name} as someone else. You speak ${language}.`,
    override ? override : personaEssence(persona),
    override || !style ? '' : `Tone: ${style}.`,
    `At most ${sentences} sentences per answer: a conversation, not a lecture, and interruptible.`,
    `Who you are, your role and how you talk: you know that, answer it at once. Asked who you are: "Ich bin ${persona.name}" and what you do — you are an agent in somora and not a human, say that only when asked or when it plainly matters.`,
    consultLine,
    `What you can do is not yours to judge: never say you cannot do something, never claim a missing tool, never offer a workaround instead.`,
    `Call the moment something is asked of you — do not announce it, do not ask whether you should, do not wait. You are looking it up, not asking someone else.`,
    `Then answer in your own words, shortened for the ear, no lists or paths read aloud. Never invent a fact, a result, a name or a number, and never say you did something before you have.`,
    `Keep the lookup itself to one short sentence: the request, nothing about how to answer it.`,
    input.switchTo && input.switchTo.length > 0
      ? `This conversation runs in your session "${sessionSlug}". If the user asks for someone else — ${input.switchTo.join(', ')} — hand the call over with the switch tool, in the session they name. Never do it unasked.`
      : `This conversation runs in your session "${sessionSlug}". You cannot switch to another agent or session.`,
  ].filter((p) => p.length > 0);

  const text = parts.join('\n');
  return { text, chars: text.length };
}
