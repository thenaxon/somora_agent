// An agent's ask_user call as a row of the conversation. The card that
// asked it goes away once it is answered, and with it the question, the
// details (often the very text that was approved) and the options; the
// answer stayed as the person's message, the question did not
// (2026-11-14 report). The call itself is in the history, so the row is
// built from it: from `input` when the history loaded it, from the live
// event's `details` (the input as JSON) while the turn streams.

export interface AskedQuestion {
  question: string;
  header?: string;
  details?: string;
  options: Array<{ label: string; description?: string }>;
  multiple: boolean;
}

/** `ask_user` as the in-process engine names it, `mcp__somora__ask_user`
 *  as the CLI engines do. */
export function isAskUserTool(name: string): boolean {
  return name === 'ask_user' || name.endsWith('__ask_user');
}

export function askedQuestionFrom(toolCall: { tool: string; input?: unknown; details?: string }): AskedQuestion | null {
  if (!isAskUserTool(toolCall.tool)) return null;
  let input: unknown = toolCall.input;
  if (input === undefined && toolCall.details) {
    try {
      input = JSON.parse(toolCall.details);
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  if (typeof i.question !== 'string' || !i.question.trim()) return null;
  const options = Array.isArray(i.options)
    ? i.options
        .filter((o): o is { label: string; description?: unknown } => !!o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string')
        .map((o) => ({ label: o.label, ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}) }))
    : [];
  return {
    question: i.question,
    ...(typeof i.header === 'string' && i.header ? { header: i.header } : {}),
    ...(typeof i.details === 'string' && i.details.trim() ? { details: i.details } : {}),
    options,
    multiple: i.multiple === true,
  };
}
