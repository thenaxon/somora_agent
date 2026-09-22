// Summary prompt template — 5 sections, OpenCode-pattern.
// The model is asked to extract verbatim quotes where possible
// instead of paraphrasing, to reduce drift on important details.

import type { ReplayPair } from '../engine/replay.ts';

export interface BuildSummaryPromptInput {
  systemPrompt: string;
  /** Pairs to be summarized, in chronological order. */
  pairs: ReplayPair[];
  /** Optional: prior summary that this compaction should subsume. */
  priorSummary?: string;
}

export function buildSummaryPrompt({
  systemPrompt,
  pairs,
  priorSummary,
}: BuildSummaryPromptInput): { system: string; user: string } {
  const system = [
    'You write a structured summary of an ongoing conversation for an',
    'agent harness. The summary replaces part of the history in front of',
    'the model so the context gets shorter. It is fed back on the next',
    'turn as a pseudo system message — stay factual, neutral, compact.',
    'Write it in the language the conversation is held in.',
    '',
    'Format: exactly seven Markdown sections with the headings below.',
    'Prefer verbatim quotes from the history over paraphrase.',
    'Invent nothing that is not in the history.',
    '',
    '## Goal',
    'What is the session about as a whole? One sentence.',
    '',
    '## Constraints',
    'Hard requirements, preferences, exclusions, facts about the user',
    '(favourite number, preferred language, no emojis, etc.). Bullets.',
    '',
    '## Decisions',
    'Architecture / plan / content decisions that were made. Bullets,',
    'with the reason when the history gives one.',
    '',
    '## Recent Context',
    'What happened last in the history — the 2–3 most important recent',
    'points. Short direct quotes are welcome.',
    '',
    '## Open Questions',
    'What was unclear or unanswered at the time of compaction? Bullets;',
    'empty if nothing is open.',
    '',
    '## Work State',
    'Only when the history shows work on files, commands or tasks (the',
    '"tools used" trails): Completed / Active / Blocked as three short',
    'bullet groups — what was changed and verified, what was in progress,',
    'what failed and why. Otherwise "(none)".',
    '',
    '## Relevant Files',
    'Files and commands that matter for continuing, one per bullet with',
    'why (exact paths). "(none)" when the history has no such work.',
  ].join('\n');

  const userParts: string[] = [];
  if (priorSummary) {
    userParts.push(
      '<prior-summary>',
      'Earlier summary that this compaction must subsume (carry every',
      'relevant point over):',
      '',
      priorSummary,
      '</prior-summary>',
      '',
    );
  }
  userParts.push(
    '<original-system-prompt>',
    systemPrompt,
    '</original-system-prompt>',
    '',
    '<conversation-to-summarize>',
  );
  for (const p of pairs) {
    userParts.push(`User: ${p.user}`);
    userParts.push(`Assistant: ${p.assistant}`);
    userParts.push('');
  }
  userParts.push('</conversation-to-summarize>');
  userParts.push('');
  userParts.push('Write the seven sections now.');

  return { system, user: userParts.join('\n') };
}
