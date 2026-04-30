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
    'Du erstellst eine strukturierte Zusammenfassung eines laufenden',
    'Konversations-Verlaufs für einen Agent-Harness. Die Zusammenfassung',
    'ersetzt einen Teil des Verlaufs vor dem Modell, damit der Context',
    'kürzer wird. Sie wird beim nächsten Turn als pseudo-system-message',
    'eingespielt — bleib daher faktentreu, neutral, kompakt.',
    '',
    'Format: exakt fünf Markdown-Sektionen mit folgenden Headings.',
    'Bevorzuge wörtliche Zitate aus dem Verlauf gegenüber Paraphrase.',
    'Nichts erfinden, das nicht im Verlauf steht.',
    '',
    '## Goal',
    'Worum geht es in der Session insgesamt? Ein Satz.',
    '',
    '## Constraints',
    'Harte Vorgaben, Vorlieben, Ausschlüsse, Fakten über den User',
    '(Lieblingszahl, Bevorzugte Sprache, Keine Emojis, etc.). Bullets.',
    '',
    '## Decisions',
    'Architektur-/Plan-/Inhalts-Entscheidungen die gefällt wurden.',
    'Bullets. Mit Begründung wenn der Verlauf eine nennt.',
    '',
    '## Recent Context',
    'Was zuletzt im Verlauf passiert ist — die letzten 2–3 wichtigsten',
    'Punkte. Erlaubt: kurze direkte Zitate.',
    '',
    '## Open Questions',
    'Was war zum Zeitpunkt der Compaction unklar oder unbeantwortet?',
    'Bullets, leer wenn nichts offen ist.',
  ].join('\n');

  const userParts: string[] = [];
  if (priorSummary) {
    userParts.push(
      '<prior-summary>',
      'Frühere Zusammenfassung, die in dieser neuen Compaction subsumiert',
      'werden soll (alle relevanten Punkte daraus übernehmen):',
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
  userParts.push('Erstelle die fünf Sektionen jetzt.');

  return { system, user: userParts.join('\n') };
}
